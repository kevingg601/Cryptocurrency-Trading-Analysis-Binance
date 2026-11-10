import type { DuckDBClient } from '../storage/duckdb.ts';
import type { MarketType } from '../binance/streams.ts';

export interface CollectionSession {
  id: string;
  market: MarketType;
  started_at: number;
  ended_at?: number;
  end_reason?: string;
}

export class SessionManager {
  private currentSessionId: string | null = null;

  private client: DuckDBClient;
  private market: MarketType;

  constructor(
    client: DuckDBClient,
    market: MarketType
  ) {
    this.client = client;
    this.market = market;
  }

  async start(): Promise<string> {
    const now = Date.now();

    // Check for prior unclean sessions
    const openSessions = await this.client.all<{ id: string; started_at: number }>(
      'SELECT id, started_at FROM collection_sessions WHERE market = ? AND ended_at IS NULL;',
      this.market
    );

    if (openSessions.length > 0) {
      // Find the latest timestamp of stored trades or klines
      const latestTrades = await this.client.all<{ max_t: number }>(
        'SELECT max(recv_time)::BIGINT as max_t FROM agg_trades WHERE market = ?;',
        this.market
      );
      const lastTime = latestTrades[0]?.max_t ?? now;

      for (const prior of openSessions) {
        await this.client.run(
          'UPDATE collection_sessions SET ended_at = ?, end_reason = ? WHERE id = ?;',
          lastTime,
          'unclean_shutdown',
          prior.id
        );
      }
    }

    const sessionId = `session-${this.market}-${now}-${Math.random().toString(36).slice(2, 8)}`;
    await this.client.run(
      'INSERT INTO collection_sessions (id, market, started_at) VALUES (?, ?, ?);',
      sessionId,
      this.market,
      now
    );

    this.currentSessionId = sessionId;
    return sessionId;
  }

  async stop(reason = 'normal_shutdown'): Promise<void> {
    if (!this.currentSessionId) return;

    const now = Date.now();
    await this.client.run(
      'UPDATE collection_sessions SET ended_at = ?, end_reason = ? WHERE id = ?;',
      now,
      reason,
      this.currentSessionId
    );
    this.currentSessionId = null;
  }

  getSessionId(): string | null {
    return this.currentSessionId;
  }
}
