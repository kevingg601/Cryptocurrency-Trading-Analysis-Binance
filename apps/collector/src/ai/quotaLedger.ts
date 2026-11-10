import type { DuckDBClient } from '../storage/duckdb.ts';
import { abStorageTransaction } from './abStorage.ts';

export const AI_DAILY_LIMIT = 144;
export const AI_EVENT_LIMIT_PER_HOUR = 2;
export const AI_EVENT_COOLDOWN_MS = 5 * 60_000;
const EVENT_WINDOW_MS = 60 * 60_000;

export interface QuotaSnapshot {
  dailyCallsUsed: number;
  dailyCallsLimit: number;
  cooldownRemainingSeconds: number;
  eventTriggersInLastHour: number;
  maxEventTriggersPerHour: number;
}

export function taipeiDateKey(timestamp: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(timestamp);
}

export class AIQuotaLedger {
  private readonly client: DuckDBClient;
  private readonly transaction: ReturnType<typeof abStorageTransaction>;
  private initialized?: Promise<void>;

  constructor(client: DuckDBClient) {
    this.client = client;
    this.transaction = abStorageTransaction(client);
  }

  async initialize(): Promise<void> {
    this.initialized ??= this.client.exec(`
      CREATE TABLE IF NOT EXISTS ai_quota_ledger (
        id VARCHAR PRIMARY KEY,
        called_at BIGINT NOT NULL,
        taipei_day VARCHAR NOT NULL,
        is_event BOOLEAN NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ai_quota_ledger_called_at_idx ON ai_quota_ledger(called_at);
      CREATE INDEX IF NOT EXISTS ai_quota_ledger_day_idx ON ai_quota_ledger(taipei_day);
    `);
    await this.initialized;
  }

  async reserve(isEvent: boolean, now: number): Promise<QuotaSnapshot> {
    await this.initialize();
    return this.transaction(async connection => {
      const day = taipeiDateKey(now);
      const daily = await connection.all<{ calls: number }>(
        'SELECT COUNT(*) AS calls FROM ai_quota_ledger WHERE taipei_day = ?;', day,
      );
      if (Number(daily[0]?.calls ?? 0) >= AI_DAILY_LIMIT) {
        throw new Error(`已達每日呼叫上限（${AI_DAILY_LIMIT} 次）`);
      }

      const recent = await connection.all<{ calls: number; last_event_at: number | null }>(
        `SELECT COUNT(*) FILTER (WHERE is_event) AS calls,
                MAX(CASE WHEN is_event THEN called_at ELSE NULL END) AS last_event_at
         FROM ai_quota_ledger WHERE called_at >= ?;`, now - EVENT_WINDOW_MS,
      );
      const eventCalls = Number(recent[0]?.calls ?? 0);
      const lastEventAt = recent[0]?.last_event_at == null ? null : Number(recent[0].last_event_at);
      const cooldownRemainingSeconds = lastEventAt === null
        ? 0
        : Math.max(0, Math.ceil((AI_EVENT_COOLDOWN_MS - (now - lastEventAt)) / 1000));
      if (isEvent && cooldownRemainingSeconds > 0) {
        throw new Error(`事件觸發冷卻中，請等待 ${cooldownRemainingSeconds} 秒`);
      }
      if (isEvent && eventCalls >= AI_EVENT_LIMIT_PER_HOUR) {
        throw new Error(`已達每小時重大事件觸發上限（${AI_EVENT_LIMIT_PER_HOUR} 次）`);
      }

      await connection.run(
        'INSERT INTO ai_quota_ledger (id, called_at, taipei_day, is_event) VALUES (?, ?, ?, ?);',
        globalThis.crypto.randomUUID(), now, day, isEvent,
      );
      return {
        dailyCallsUsed: Number(daily[0]?.calls ?? 0) + 1,
        dailyCallsLimit: AI_DAILY_LIMIT,
        cooldownRemainingSeconds: isEvent ? Math.ceil(AI_EVENT_COOLDOWN_MS / 1000) : cooldownRemainingSeconds,
        eventTriggersInLastHour: eventCalls + (isEvent ? 1 : 0),
        maxEventTriggersPerHour: AI_EVENT_LIMIT_PER_HOUR,
      };
    });
  }

  async getStatus(now: number): Promise<QuotaSnapshot> {
    await this.initialize();
    const [daily, recent] = await Promise.all([
      this.client.all<{ calls: number }>(
        'SELECT COUNT(*) AS calls FROM ai_quota_ledger WHERE taipei_day = ?;', taipeiDateKey(now),
      ),
      this.client.all<{ calls: number; last_event_at: number | null }>(
        `SELECT COUNT(*) FILTER (WHERE is_event) AS calls,
                MAX(CASE WHEN is_event THEN called_at ELSE NULL END) AS last_event_at
         FROM ai_quota_ledger WHERE called_at >= ?;`, now - EVENT_WINDOW_MS,
      ),
    ]);
    const lastEventAt = recent[0]?.last_event_at == null ? null : Number(recent[0].last_event_at);
    return {
      dailyCallsUsed: Number(daily[0]?.calls ?? 0),
      dailyCallsLimit: AI_DAILY_LIMIT,
      cooldownRemainingSeconds: lastEventAt === null
        ? 0
        : Math.max(0, Math.ceil((AI_EVENT_COOLDOWN_MS - (now - lastEventAt)) / 1000)),
      eventTriggersInLastHour: Number(recent[0]?.calls ?? 0),
      maxEventTriggersPerHour: AI_EVENT_LIMIT_PER_HOUR,
    };
  }
}
