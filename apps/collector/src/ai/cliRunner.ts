import type { DuckDBClient } from '../storage/duckdb.ts';
import type { AIDataSnapshot, AIAnalysisResult, MarketType } from '@fadachi/core';
import { validateAIModelOutput } from '@fadachi/core';
import { AIQuotaLedger, AI_DAILY_LIMIT, AI_EVENT_COOLDOWN_MS, AI_EVENT_LIMIT_PER_HOUR } from './quotaLedger.ts';
import { abStorageTransaction } from './abStorage.ts';
import { AntigravityProvider } from './antigravityProvider.ts';

export interface AnalysisProvider {
  verifyIsolation(): Promise<{ verified: boolean; reason?: string }>;
  getModels(): Promise<string[]>;
  analyzeBatch(snapshots: AIDataSnapshot[], model: string, signal: AbortSignal): Promise<unknown>;
}

export interface CLIRunnerOptions {
  client: DuckDBClient;
  provider?: AnalysisProvider;
  /** Deprecated compatibility field. Arbitrary CLI commands are never executed. */
  cliCommand?: string;
  /** Explicit offline test injection; it is never treated as isolation evidence. */
  mockProvider?: (snapshot: AIDataSnapshot, model: string) => Promise<string | object>;
}

export interface QuotaStatus {
  dailyCallsUsed: number;
  dailyCallsLimit: number;
  cooldownRemainingSeconds: number;
  eventTriggersInLastHour: number;
  maxEventTriggersPerHour: number;
  isBusy: boolean;
  hasPending: boolean;
}

export interface ProviderStatus {
  verified: boolean;
  reason?: string;
  models: string[];
}

interface PendingCaller {
  requestedSymbols: Set<string>;
  remainingSymbols: Set<string>;
  resolve: (results: AIAnalysisResult[]) => void;
  reject: (error: unknown) => void;
}

interface PendingBatch {
  snapshots: Map<string, AIDataSnapshot>;
  callers: PendingCaller[];
  model: string;
  isEventTrigger: boolean;
}

const DEFAULT_MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-thinking'];
const snapshotKey = (snapshot: AIDataSnapshot) => `${snapshot.marketType}:${snapshot.symbol.toUpperCase()}`;

export class AICLIRunner {
  private readonly client: DuckDBClient;
  private readonly provider?: AnalysisProvider;
  private readonly mockProvider?: CLIRunnerOptions['mockProvider'];
  private readonly quota: AIQuotaLedger;
  private readonly transaction: ReturnType<typeof abStorageTransaction>;
  private isRunning = false;
  private pendingTask: PendingBatch | null = null;
  private isolationVerified = false;
  private isolationReason = 'No provider configured';
  private providerModels: string[] = [];
  private cooldownUntil = 0;
  private lastQuota = {
    dailyCallsUsed: 0, dailyCallsLimit: AI_DAILY_LIMIT,
    cooldownRemainingSeconds: 0, eventTriggersInLastHour: 0,
    maxEventTriggersPerHour: AI_EVENT_LIMIT_PER_HOUR,
  };

  readonly DAILY_LIMIT = AI_DAILY_LIMIT;
  readonly COOLDOWN_MS = AI_EVENT_COOLDOWN_MS;
  readonly MAX_EVENT_TRIGGERS_PER_HOUR = AI_EVENT_LIMIT_PER_HOUR;
  readonly TASK_TIMEOUT_MS = 120_000;
  readonly promptVersion = 'prompt-v1';
  readonly ruleVersion = 'rule-v1';

  constructor(options: CLIRunnerOptions) {
    this.client = options.client;
    this.provider = options.provider ?? (options.mockProvider ? undefined : new AntigravityProvider());
    this.mockProvider = options.mockProvider;
    this.quota = new AIQuotaLedger(options.client);
    this.transaction = abStorageTransaction(options.client);
    if (this.provider) this.isolationReason = '尚未驗證獨立 CLI 設定';
    void this.quota.getStatus(Date.now()).then(status => {
      this.lastQuota = status;
      this.cooldownUntil = Date.now() + status.cooldownRemainingSeconds * 1000;
    }).catch(() => {});
  }

  getAvailableModels(): string[] {
    return this.isolationVerified ? [...this.providerModels] : [];
  }

  getProviderStatus(): ProviderStatus {
    return { verified: this.isolationVerified, reason: this.isolationReason, models: this.getAvailableModels() };
  }

  isIsolationVerified(): boolean {
    return this.isolationVerified;
  }

  getQuotaStatus(now = Date.now()): QuotaStatus {
    return {
      ...this.lastQuota,
      cooldownRemainingSeconds: Math.max(0, Math.ceil((this.cooldownUntil - now) / 1000)),
      isBusy: this.isRunning,
      hasPending: this.pendingTask !== null,
    };
  }

  async runAnalysis(
    snapshot: AIDataSnapshot,
    model = 'gemini-2.5-flash',
    isEventTrigger = false,
    now = Date.now(),
  ): Promise<AIAnalysisResult | null> {
    const result = await this.runBatchAnalysis([snapshot], model, isEventTrigger, now);
    return result?.[0] ?? null;
  }

  async runBatchAnalysis(
    snapshots: AIDataSnapshot[], model: string, isEventTrigger = false, now = Date.now(),
  ): Promise<AIAnalysisResult[] | null> {
    this.validateBatch(snapshots, model, now);
    if (!this.provider && !this.mockProvider) {
      throw new Error(this.isolationReason || 'AI CLI 隔離環境未通過驗證或不可用，依規範已停用 Provider');
    }
    if (this.provider && !this.isolationVerified) {
      throw new Error(this.isolationReason ? `AI CLI 隔離環境未通過驗證或不可用：${this.isolationReason}` : 'AI CLI 隔離環境未通過驗證或不可用，依規範已停用 Provider');
    }
    if (!(this.providerModels.length ? this.providerModels : this.mockProvider ? DEFAULT_MODELS : []).includes(model)) {
      throw new Error('不支援的 AI 模型');
    }

    if (!this.isRunning) {
      this.isRunning = true;
      return this.executeBatch(snapshots, model, isEventTrigger, now).finally(() => {
        this.isRunning = false;
        this.drainPending();
      });
    }

    if (this.pendingTask && this.pendingTask.model !== model) throw new Error('待處理分析批次已鎖定不同模型');
    if (!this.pendingTask) {
      this.pendingTask = { snapshots: new Map(), callers: [], model, isEventTrigger };
    }
    this.pendingTask.isEventTrigger ||= isEventTrigger;
    const requestedSymbols = new Set(snapshots.map(snapshotKey));

    for (const caller of this.pendingTask.callers) {
      for (const symbol of requestedSymbols) {
        caller.remainingSymbols.delete(symbol);
      }
      if (caller.remainingSymbols.size === 0) {
        caller.resolve([]);
      }
    }
    this.pendingTask.callers = this.pendingTask.callers.filter(caller => caller.remainingSymbols.size > 0);

    for (const snapshot of snapshots) this.pendingTask.snapshots.set(snapshotKey(snapshot), snapshot);
    return new Promise<AIAnalysisResult[]>((resolve, reject) => {
      this.pendingTask!.callers.push({
        requestedSymbols,
        remainingSymbols: new Set(requestedSymbols),
        resolve,
        reject,
      });
    });
  }

  private validateBatch(snapshots: AIDataSnapshot[], model: string, now: number): void {
    if (!Array.isArray(snapshots) || snapshots.length < 1 || snapshots.length > 10) {
      throw new Error('分析批次必須包含 1 至 10 個快照');
    }
    const seen = new Set<string>();
    for (const snapshot of snapshots) {
      const key = snapshotKey(snapshot);
      if (seen.has(key)) throw new Error(`分析批次包含重複標的：${key}`);
      seen.add(key);
      if (!Number.isFinite(snapshot.validUntil) || now >= snapshot.validUntil || now < snapshot.cutoffTime) {
        throw new Error(`資料快照已過期或時間無效：${snapshot.symbol}`);
      }
      if (!snapshot.essentialDataValid) throw new Error(`資料快照必要行情／技術資料不完整：${snapshot.symbol}`);
    }
    if (!model.trim()) throw new Error('AI model is required');
  }

  private drainPending(): void {
    const pending = this.pendingTask;
    if (!pending || this.isRunning) return;
    this.pendingTask = null;
    const callers = pending.callers;
    const snapshots = [...pending.snapshots.values()].filter(snapshot => Date.now() < snapshot.validUntil);
    if (!snapshots.length) {
      for (const caller of callers) caller.resolve([]);
      return;
    }
    this.isRunning = true;
    this.executeBatch(snapshots, pending.model, pending.isEventTrigger, Date.now())
      .then(
        results => {
          for (const caller of callers) {
            caller.resolve(results.filter(result => caller.requestedSymbols.has(`${result.marketType}:${result.symbol.toUpperCase()}`)));
          }
        },
        error => {
          for (const caller of callers) {
            caller.reject(error);
          }
        },
      )
      .finally(() => {
        this.isRunning = false;
        this.drainPending();
      });
  }

  private async executeBatch(
    snapshots: AIDataSnapshot[], model: string, isEventTrigger: boolean, now: number,
  ): Promise<AIAnalysisResult[]> {
    this.validateBatch(snapshots, model, now);
    this.lastQuota = { ...this.lastQuota, ...await this.quota.reserve(isEventTrigger, now) };
    this.cooldownUntil = now + this.lastQuota.cooldownRemainingSeconds * 1000;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const providerCall = this.provider
        ? this.provider.analyzeBatch(snapshots, model, controller.signal)
        : this.mockProvider!(snapshots[0], model);
      const output = await Promise.race([
        providerCall,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error('AI analysis timed out');
            controller.abort(error);
            reject(error);
          }, this.TASK_TIMEOUT_MS);
        }),
      ]);
      if (snapshots.some(snapshot => Date.now() >= snapshot.validUntil)) throw new Error('分析完成時資料快照已過期');
      const outputs = this.parseBatchOutput(output, snapshots);
      const generatedAt = Date.now();
      const validated = snapshots.map(snapshot => validateAIModelOutput(
        outputs.get(snapshotKey(snapshot)), snapshot,
        { model, promptVersion: this.promptVersion, ruleVersion: this.ruleVersion, now: generatedAt },
      ));
      await this.transaction(async connection => {
        for (const analysis of validated) {
          await connection.run(
            `INSERT INTO ai_analysis_results (id, snapshot_id, symbol, market, model, direction, confidence, generated_at, expires_at, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET direction = excluded.direction, confidence = excluded.confidence,
             expires_at = excluded.expires_at, payload = excluded.payload;`,
            analysis.id, analysis.snapshotId, analysis.symbol, analysis.marketType, analysis.model,
            analysis.direction, analysis.confidence, analysis.generatedAt, analysis.expiresAt, JSON.stringify(analysis),
          );
        }
      });
      return validated;
    } catch (err) {
      console.error('[AICLIRunner] Batch analysis failed:', err);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private parseBatchOutput(output: unknown, snapshots: AIDataSnapshot[]): Map<string, unknown> {
    let parsed = output;
    if (typeof parsed === 'string') parsed = JSON.parse(parsed.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const envelope = parsed as Record<string, unknown>;
      const nested = envelope.response ?? envelope.output ?? envelope.text;
      if (typeof nested === 'string') return this.parseBatchOutput(nested, snapshots);
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as any).analyses)) {
      if (snapshots.length === 1 && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return new Map([[snapshotKey(snapshots[0]), parsed]]);
      }
      throw new Error('AI 批次輸出必須包含 analyses 陣列');
    }
    const expected = new Set(snapshots.map(snapshotKey));
    const result = new Map<string, unknown>();
    for (const analysis of (parsed as any).analyses) {
      if (!analysis || typeof analysis !== 'object' || typeof analysis.symbol !== 'string'
          || (analysis.marketType !== 'spot' && analysis.marketType !== 'futures')) {
        throw new Error('AI 批次項目缺少有效 symbol/marketType');
      }
      const key = `${analysis.marketType}:${analysis.symbol.toUpperCase()}`;
      if (!expected.has(key) || result.has(key)) throw new Error(`AI 批次輸出有未知或重複標的：${key}`);
      const { symbol: _symbol, marketType: _marketType, ...fields } = analysis;
      result.set(key, fields);
    }
    if (result.size !== expected.size) throw new Error('AI 批次輸出未涵蓋全部快照標的');
    return result;
  }

  async getLatestAnalysis(symbol: string, market: MarketType): Promise<AIAnalysisResult | null> {
    const rows = await this.client.all('SELECT payload FROM ai_analysis_results WHERE symbol = ? AND market = ? ORDER BY generated_at DESC LIMIT 1;', symbol, market);
    return rows.length ? JSON.parse(rows[0].payload) as AIAnalysisResult : null;
  }

  async getAnalysisHistory(symbol?: string, market?: MarketType, limit = 50): Promise<AIAnalysisResult[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (symbol) { clauses.push('symbol = ?'); params.push(symbol); }
    if (market) { clauses.push('market = ?'); params.push(market); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.client.all(`SELECT payload FROM ai_analysis_results${where} ORDER BY generated_at DESC LIMIT ?;`, ...params, limit);
    return rows.map((row: any) => JSON.parse(row.payload) as AIAnalysisResult);
  }

  async verifyIsolation(): Promise<boolean> {
    this.isolationVerified = false;
    this.providerModels = [];
    if (!this.provider) {
      this.isolationReason = this.mockProvider
        ? 'Mock provider is test-only and does not verify production isolation'
        : 'No production provider configured';
      return false;
    }
    try {
      const result = await this.provider.verifyIsolation();
      this.isolationReason = result.reason ?? (result.verified ? '' : 'Provider isolation was not verified');
      if (!result.verified) return false;
      const models = await this.provider.getModels();
      this.providerModels = [...new Set(models.filter(model => typeof model === 'string' && model.trim()))];
      this.isolationVerified = this.providerModels.length > 0;
      if (!this.isolationVerified) this.isolationReason = 'No models are available in the isolated provider profile';
    } catch (error) {
      this.isolationReason = error instanceof Error ? error.message : String(error);
    }
    return this.isolationVerified;
  }
}
