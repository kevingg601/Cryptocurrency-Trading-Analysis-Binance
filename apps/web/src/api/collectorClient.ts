import {
  type AggregateTradeData,
  type KlineData,
  type MarketType,
  type TickerData,
  type CoinMetadata,
  type AutoTradingConfig,
  type AutoTradingNotification,
  type AutoTradingSnapshot,
  type ABTradingBatch,
  type ExtendedAIAnalysisInput,
  type FourGroupCoinMode,
  type FourGroupComparisonMetrics,
  type FourGroupTradingBatch,
  type LightgbmRankSnapshot,
  type AIAnalysisResult,
  type AIDataSnapshot,
  type ReplayResult,
  type ReplayInput,
  type KronosModelKey,
  type ModelPaperAdaptersResponse,
  type ModelPaperExperimentDetail,
  type ModelPaperExperimentListItem,
  type ModelResearchJobRecord,
  type ModelResearchRunResult,
  type ModelResearchStatusResponse,
  type ResearchRunValidityStatus,
  type RollingPipelineStatus,
  parseWithInfinity,
  stringifyWithInfinity,
} from '@fadachi/core';

export interface CollectorConfig {
  apiBase: string;
  token: string;
}

export function resolveCollectorConfig(): CollectorConfig {
  // 1. Electron bridge
  const win = (typeof window === 'undefined' ? {} : window) as any;
  if (win.fadachi?.apiBase) {
    return {
      apiBase: win.fadachi.apiBase,
      token: win.fadachi.token || '',
    };
  }

  // 2. URL search parameters
  const params = new URLSearchParams(win.location?.search ?? '');
  const paramBase = params.get('apiBase');
  const paramToken = params.get('token');
  if (paramBase) {
    return {
      apiBase: paramBase,
      token: paramToken || '',
    };
  }

  // 3. Fallback to default local collector
  return {
    apiBase: 'http://127.0.0.1:4321',
    token: '',
  };
}

export class CollectorApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly batchId?: string;
  readonly serverTime?: number;
  readonly expiresAt?: number | null;
  readonly generation?: string;

  constructor(
    message: string,
    details: {
      status: number;
      code?: string;
      batchId?: string;
      serverTime?: number;
      expiresAt?: number | null;
      generation?: string;
    },
  ) {
    super(message);
    this.name = 'CollectorApiError';
    this.status = details.status;
    this.code = details.code;
    this.batchId = details.batchId;
    this.serverTime = details.serverTime;
    this.expiresAt = details.expiresAt;
    this.generation = details.generation;
  }
}

export interface FourGroupBackendNotification extends AutoTradingNotification {
  seq: number;
  createdAt: number;
}

export interface FourGroupLgbmRuntimeState {
  snapshot: LightgbmRankSnapshot | null;
  expectedCutoffTime: number | null;
  isExpired: boolean;
  matchesCurrentHour: boolean;
  latestError: { cutoffTime?: number; failedAt?: number; error?: string } | null;
  universeSymbols: string[];
  lgbmStatus: RollingPipelineStatus['lgbm'] | null;
  lgbmAutoSchedule?: RollingPipelineStatus['lgbmAutoSchedule'];
  trainingPaused: boolean;
  pausedReason: string | null;
}

export interface FourGroupEngineRuntime {
  runningInCollector: boolean;
  generation: string;
  lastSaveAt: number | null;
  lastSaveDurationMs: number | null;
  lastSaveRevision: number | null;
  lastQueueWaitMs: number | null;
  lastTxElapsedMs: number | null;
  unsyncedChanges: boolean;
  error: string | null;
}

export interface FourGroupRuntimeStatus {
  snapshot: FourGroupTradingBatch;
  metrics: FourGroupComparisonMetrics;
  streamHealthy: boolean;
  rulesReady: boolean;
  rulesError: string | null;
  lgbmState: FourGroupLgbmRuntimeState;
  ollama: {
    analyzing: boolean;
    progress: { completed: number; total: number; currentSymbol: string | null } | null;
    lastError: string | null;
    analyses: Record<string, ExtendedAIAnalysisInput>;
    symbolErrors: Record<string, string>;
  };
  recentNotifications: FourGroupBackendNotification[];
  engineRuntime: FourGroupEngineRuntime;
  serverTime: number;
}

export class CollectorClient {
  private config: CollectorConfig;
  private paperSaves = new Map<MarketType, Promise<any>>();

  constructor(config?: Partial<CollectorConfig>) {
    const base = resolveCollectorConfig();
    this.config = {
      apiBase: config?.apiBase || base.apiBase,
      token: config?.token || base.token,
    };
  }

  private async request<T = any>(endpoint: string, options: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
    const headers = new Headers(options.headers || {});
    if (this.config.token) {
      headers.set('Authorization', `Bearer ${this.config.token}`);
    }

    const url = `${this.config.apiBase}${endpoint}`;
    const res = await fetch(url, {
      ...options,
      headers,
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      let detail = res.statusText;
      let code: string | undefined;
      let batchId: string | undefined;
      let serverTime: number | undefined;
      let expiresAt: number | null | undefined;
      let generation: string | undefined;
      try {
        const payload = await res.clone().json();
        if (typeof payload?.error === 'string') detail = payload.error;
        if (typeof payload?.code === 'string') code = payload.code;
        if (typeof payload?.id === 'string') batchId = payload.id;
        if (typeof payload?.serverTime === 'number') serverTime = payload.serverTime;
        if (typeof payload?.expiresAt === 'number' || payload?.expiresAt === null) expiresAt = payload.expiresAt;
        if (typeof payload?.generation === 'string') generation = payload.generation;
      } catch { /* Non-JSON error responses use the HTTP status text. */ }
      throw new CollectorApiError(`Collector API Error (${res.status}): ${detail}`, {
        status: res.status,
        code,
        batchId,
        serverTime,
        expiresAt,
        generation,
      });
    }

    const text = await res.text();
    try {
      return parseWithInfinity(text);
    } catch {
      return JSON.parse(text);
    }
  }

  async getHealth() {
    return this.request('/api/health');
  }

  async getSymbols(market: MarketType = 'futures'): Promise<{ market: MarketType; symbols: string[]; coins: CoinMetadata[] }> {
    return this.request(`/api/symbols?market=${market}`);
  }

  async getKlines(
    market: MarketType,
    symbol: string,
    interval: string = '1h',
    from?: number,
    to?: number,
    limit: number = 500
  ): Promise<KlineData[]> {
    const params = new URLSearchParams({
      market,
      symbol,
      interval,
      limit: String(limit),
    });
    if (from !== undefined) params.set('from', String(from));
    if (to !== undefined) params.set('to', String(to));

    return this.request(`/api/klines?${params.toString()}`);
  }

  async getTrades(
    market: MarketType,
    symbol: string,
    from?: number,
    to?: number,
    limit: number = 1000
  ): Promise<AggregateTradeData[]> {
    const params = new URLSearchParams({
      market,
      symbol,
      limit: String(limit),
    });
    if (from !== undefined) params.set('from', String(from));
    if (to !== undefined) params.set('to', String(to));

    return this.request(`/api/trades?${params.toString()}`);
  }

  async getCoverage(market: MarketType, symbol?: string) {
    const params = new URLSearchParams({ market });
    if (symbol) params.set('symbol', symbol);
    return this.request(`/api/coverage?${params.toString()}`);
  }

  async getStatsSummary() {
    return this.request('/api/stats/summary');
  }

  async runReplay(params: Partial<ReplayInput> & { symbol: string; from?: number; to?: number }): Promise<ReplayResult> {
    return this.request('/api/replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  }

  async getPaperAccount(market: MarketType) {
    return this.request(`/api/paper/${market}`);
  }

  async savePaperAccount(market: MarketType, data: { balance: number; trades: any[]; history: any[] }) {
    const body = JSON.stringify(data);
    const previous = this.paperSaves.get(market) ?? Promise.resolve();
    const saving = previous.catch(() => {}).then(() => this.request(`/api/paper/${market}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body,
    }));
    this.paperSaves.set(market, saving);
    void saving.finally(() => {
      if (this.paperSaves.get(market) === saving) this.paperSaves.delete(market);
    }).catch(() => {});
    return saving;
  }

  async getAutoBatches(market?: MarketType): Promise<Array<{ id: string; market: MarketType; status: string; snapshot: AutoTradingSnapshot }>> {
    const query = market ? `?market=${market}` : '';
    return this.request(`/api/auto/batches${query}`);
  }

  async saveAutoBatch(batch: { id: string; market: MarketType; status: string; snapshot: AutoTradingSnapshot }) {
    return this.request('/api/auto/batches', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
  }

  async getAIStatus(market: MarketType = 'futures', symbols?: string[], model?: string) {
    const params = new URLSearchParams({ market });
    if (symbols?.length) params.set('symbols', symbols.join(','));
    if (model) params.set('model', model);
    return this.request(`/api/ai/status?${params.toString()}`);
  }

  async setAIScope(scope: { market: MarketType; symbols: string[]; model: string }) {
    return this.request('/api/ai/scope', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope),
    });
  }

  async lockAIScope(owner: string): Promise<{ scope: { market: MarketType; symbols: string[]; model: string } }> {
    return this.request('/api/ai/scope/lock', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner }),
    });
  }

  async unlockAIScope(owner: string) {
    return this.request('/api/ai/scope/unlock', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner }),
    });
  }

  async getAIHistory(symbol?: string, market?: MarketType, limit = 50): Promise<AIAnalysisResult[]> {
    const params = new URLSearchParams();
    if (symbol) params.set('symbol', symbol);
    if (market) params.set('market', market);
    params.set('limit', String(limit));
    return this.request(`/api/ai/history?${params.toString()}`);
  }

  async triggerAIAnalysis(data: { symbol?: string; symbols?: string[]; market?: MarketType; model?: string; isEventTrigger?: boolean }) {
    return this.request('/api/ai/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }, 120_000);
  }

  async getAISnapshot(id: string): Promise<AIDataSnapshot> {
    return this.request(`/api/ai/snapshots/${encodeURIComponent(id)}`);
  }

  async getABBatches(market?: MarketType, limit = 50): Promise<Array<{ id: string; market: MarketType; status: string; revision: number; model: string; batch: ABTradingBatch; ownerActive?: boolean }>> {
    const params = new URLSearchParams();
    if (market) params.set('market', market);
    params.set('limit', String(limit));
    return this.request(`/api/ab/batches?${params.toString()}`);
  }

  async getABBatch(id: string): Promise<{ id: string; market: MarketType; status: string; revision: number; model: string; batch: ABTradingBatch; ownerActive?: boolean }> {
    return this.request(`/api/ab/batches/${encodeURIComponent(id)}`);
  }

  async claimABBatch(id: string) {
    return this.request<{ owner: boolean; ownerToken?: string; generation?: string; expiresAt?: number; batch?: ABTradingBatch }>(
      `/api/ab/batches/${encodeURIComponent(id)}/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
  }

  async renewABLease(id: string, ownerToken: string, generation: string) {
    return this.request(`/api/ab/batches/${encodeURIComponent(id)}/lease`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ownerToken, generation }),
    });
  }

  async saveABBatch(data: { id: string; market?: MarketType; status?: string; revision?: number; model?: string; batch: ABTradingBatch; ownerToken: string; generation: string }) {
    return this.request('/api/ab/batches', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: stringifyWithInfinity(data),
    });
  }

  async exportABBatchCsv(id: string): Promise<string> {
    const headers = new Headers();
    if (this.config.token) {
      headers.set('Authorization', `Bearer ${this.config.token}`);
    }
    const url = `${this.config.apiBase}/api/ab/batches/${encodeURIComponent(id)}/export.csv`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`CSV Export failed (${res.status}): ${res.statusText}`);
    }
    return res.text();
  }

  getABBatchExportUrl(id: string): string {
    const url = new URL(`${this.config.apiBase}/api/ab/batches/${encodeURIComponent(id)}/export.csv`);
    if (this.config.token) {
      url.searchParams.set('token', this.config.token);
    }
    return url.toString();
  }

  async getOllamaStatus(url?: string): Promise<{
    reachable: boolean;
    baseUrl: string;
    isRemote: boolean;
    models: string[];
    runningModels: Array<{ name: string; model: string; size?: number; sizeVram?: number }>;
    latencyMs: number;
    error?: string;
    latestAnalyses: Record<string, AIAnalysisResult>;
  }> {
    const params = new URLSearchParams();
    if (url?.trim()) params.set('url', url.trim());
    const qs = params.toString();
    return this.request(`/api/ollama/status${qs ? `?${qs}` : ''}`);
  }

  async testOllamaConnection(url?: string, model?: string): Promise<{
    reachable: boolean;
    baseUrl: string;
    isRemote: boolean;
    models: string[];
    runningModels: Array<{ name: string; model: string; size?: number; sizeVram?: number }>;
    hasRequestedModel?: boolean;
    latencyMs: number;
    error?: string;
  }> {
    return this.request('/api/ollama/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(url?.trim() ? { url: url.trim() } : {}), ...(model?.trim() ? { model: model.trim() } : {}) }),
    });
  }

  async analyzeWithOllama(data: {
    url?: string;
    model: string;
    symbols: string[];
    market?: MarketType;
    promptVersion?: string;
    ruleVersion?: string;
  }): Promise<{
    baseUrl: string;
    isRemote: boolean;
    model: string;
    results: Record<string, AIAnalysisResult>;
    telemetries: Record<string, any>;
    errors: Record<string, string>;
  }> {
    return this.request('/api/ollama/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }, 210_000);
  }

  async getLatestLightgbmRanking(): Promise<{
    snapshot: LightgbmRankSnapshot | null;
    expectedCutoffTime: number;
    isExpired: boolean;
    matchesCurrentHour: boolean;
    latestError: { cutoffTime?: number; failedAt?: number; error?: string } | null;
    universeSymbols: string[];
    lgbmStatus: RollingPipelineStatus['lgbm'];
    lgbmAutoSchedule?: RollingPipelineStatus['lgbmAutoSchedule'];
    trainingPaused?: boolean;
    pausedReason?: string | null;
    serverTime: number;
  }> {
    return this.request('/api/research/lgbm/latest');
  }

  async triggerLightgbmHourlyUpdate(force = false): Promise<{ ok: boolean; snapshot: LightgbmRankSnapshot }> {
    return this.request('/api/research/lgbm/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
    }, 180_000);
  }

  async getFourGroupBatches(market: MarketType = 'futures', limit = 50): Promise<Array<{
    id: string;
    market: MarketType;
    status: string;
    revision: number;
    model: string;
    batch: FourGroupTradingBatch;
    ownerActive?: boolean;
  }>> {
    const params = new URLSearchParams({ market, limit: String(limit) });
    return this.request(`/api/four-group/batches?${params.toString()}`);
  }

  async getFourGroupBatch(id: string) {
    return this.request(`/api/four-group/batches/${encodeURIComponent(id)}`);
  }

  async getFourGroupStatus(): Promise<FourGroupRuntimeStatus> {
    return this.request('/api/four-group/status');
  }

  async startFourGroupBatch(payload: {
    config: AutoTradingConfig;
    selectedCoins?: string[];
    coinMode?: FourGroupCoinMode;
    ollamaUrl?: string;
    model: string;
    signalSettings?: Record<string, number>;
  }): Promise<FourGroupRuntimeStatus> {
    return this.request('/api/four-group/batches/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  async pauseFourGroupBatch(id: string): Promise<FourGroupRuntimeStatus> {
    return this.request(`/api/four-group/batches/${encodeURIComponent(id)}/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  }

  async resumeFourGroupBatch(id: string): Promise<FourGroupRuntimeStatus> {
    return this.request(`/api/four-group/batches/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  }

  async drainFourGroupBatch(id: string): Promise<FourGroupRuntimeStatus> {
    return this.request(`/api/four-group/batches/${encodeURIComponent(id)}/drain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  }

  async closeAllFourGroupBatch(id: string): Promise<FourGroupRuntimeStatus> {
    return this.request(`/api/four-group/batches/${encodeURIComponent(id)}/close-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  }

  async refreshFourGroupOllama(id: string): Promise<FourGroupRuntimeStatus> {
    return this.request(`/api/four-group/batches/${encodeURIComponent(id)}/ollama-refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  }

  async exportFourGroupBatchCsv(id: string): Promise<string> {
    const headers = new Headers();
    if (this.config.token) {
      headers.set('Authorization', `Bearer ${this.config.token}`);
    }
    const url = `${this.config.apiBase}/api/four-group/batches/${encodeURIComponent(id)}/export.csv`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`Four-group CSV Export failed (${res.status}): ${res.statusText}`);
    }
    return res.text();
  }

  async migrateBrowser(data: { paper?: Record<string, any>; batches?: any[] }) {
    return this.request('/api/migrate/browser', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  }

  async getResearchStatus(): Promise<ModelResearchStatusResponse> {
    return this.request('/api/research/status', {}, 35_000);
  }

  async getResearchLatest(): Promise<{
    status: string;
    validityStatus: ResearchRunValidityStatus;
    isExpired?: boolean;
    result: ModelResearchRunResult | null;
  } & Partial<ModelResearchRunResult>> {
    return this.request('/api/research/latest');
  }

  async runResearchInference(options: {
    kronosModel?: KronosModelKey;
    market?: MarketType;
    cutoffTime?: number;
  } = {}): Promise<{
    jobId: string;
    runId: string;
    status: string;
    kronosModel: KronosModelKey;
    startedAt: number;
  }> {
    return this.request('/api/research/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    });
  }

  async getResearchJob(jobId: string): Promise<ModelResearchJobRecord> {
    return this.request(`/api/research/jobs/${encodeURIComponent(jobId)}`);
  }

  async getResearchPipelineStatus(): Promise<RollingPipelineStatus> {
    return this.request('/api/research/pipeline');
  }

  async triggerChronosRetrain(retrainIntervalHours = 6): Promise<{
    started: boolean;
    isTraining: boolean;
    message: string;
  }> {
    return this.request('/api/research/pipeline/retrain-chronos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ retrainIntervalHours }),
    });
  }

  async getModelPaperAdapters(): Promise<ModelPaperAdaptersResponse> {
    return this.request('/api/model-paper/adapters');
  }

  async createModelPaperExperiment(params: {
    requestId: string;
    adapterRunDir?: string;
    retrainIntervalHours?: number;
  }): Promise<ModelPaperExperimentDetail> {
    return this.request('/api/model-paper/experiments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  }

  async listModelPaperExperiments(): Promise<{ experiments: ModelPaperExperimentListItem[] }> {
    return this.request('/api/model-paper/experiments');
  }

  async getModelPaperExperiment(id: string): Promise<ModelPaperExperimentDetail> {
    return this.request(`/api/model-paper/experiments/${encodeURIComponent(id)}`);
  }

  async pauseModelPaperExperiment(id: string, requestId: string): Promise<ModelPaperExperimentDetail> {
    return this.request(`/api/model-paper/experiments/${encodeURIComponent(id)}/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId }),
    });
  }

  async resumeModelPaperExperiment(id: string, requestId: string): Promise<ModelPaperExperimentDetail> {
    return this.request(`/api/model-paper/experiments/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId }),
    });
  }

  async stopModelPaperExperiment(id: string, requestId: string): Promise<ModelPaperExperimentDetail> {
    return this.request(`/api/model-paper/experiments/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId }),
    });
  }

  async exportModelPaperExperiment(
    id: string,
    kind: 'decisions' | 'fills' | 'equity' | 'config' | 'all',
    format: 'csv' | 'json',
  ): Promise<{ filename: string; contentType: string; content: string }> {
    const headers = new Headers();
    if (this.config.token) {
      headers.set('Authorization', `Bearer ${this.config.token}`);
    }
    const params = new URLSearchParams({ kind, format });
    const url = `${this.config.apiBase}/api/model-paper/experiments/${encodeURIComponent(id)}/export?${params.toString()}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const payload = await res.clone().json();
        if (typeof payload?.error === 'string') detail = payload.error;
      } catch { /* ignore */ }
      throw new Error(`匯出失敗 (${res.status}): ${detail}`);
    }
    const disposition = res.headers.get('content-disposition') ?? '';
    const match = /filename="([^"]+)"/.exec(disposition);
    const filename = match?.[1] || `model-paper-${id}-${kind}.${format}`;
    return {
      filename,
      contentType: res.headers.get('content-type') || (format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8'),
      content: await res.text(),
    };
  }

  connectLive(
    market: MarketType,
    handlers: {
      onTickers?: (tickers: Array<Partial<TickerData> & { symbol: string }>) => void;
      onTrade?: (trade: AggregateTradeData) => void;
      onKline?: (symbol: string, candle: KlineData) => void;
      onStatus?: (status: any) => void;
    }
  ): { close: () => void; subscribeSymbol: (symbol: string) => void } {
    let ws: WebSocket | null = null;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let selectedSymbol: string | undefined;

    const wsUrl = new URL(this.config.apiBase.replace(/^http/, 'ws') + '/live');
    wsUrl.searchParams.set('market', market);
    if (this.config.token) {
      wsUrl.searchParams.set('token', this.config.token);
    }

    const connect = () => {
      if (closed) return;
      try {
        const socket = new WebSocket(wsUrl.toString());
        ws = socket;

        socket.onopen = () => {
          if (closed || ws !== socket) return;
          if (selectedSymbol) socket.send(JSON.stringify({ type: 'subscribe', symbol: selectedSymbol }));
          // A Collector connection alone does not establish exchange-stream health.
          handlers.onStatus?.({ status: 'connecting' });
        };

        socket.onmessage = (event) => {
          if (closed || ws !== socket) return;
          try {
            const payload = JSON.parse(event.data);
            if (payload.type === 'tickers' && Array.isArray(payload.data) && handlers.onTickers) {
              handlers.onTickers(payload.data);
            } else if (payload.type === 'trade' && payload.data && handlers.onTrade) {
              handlers.onTrade(payload.data);
            } else if (payload.type === 'kline' && payload.data && typeof payload.symbol === 'string' && handlers.onKline) {
              handlers.onKline(payload.symbol, payload.data);
            } else if (payload.type === 'status' && payload.data && handlers.onStatus) {
              handlers.onStatus(payload.data);
            }
          } catch {
            /* ignore parse error */
          }
        };

        socket.onclose = () => {
          if (!closed && ws === socket) {
            handlers.onStatus?.({ status: 'disconnected' });
            reconnectTimer = setTimeout(connect, 2000);
          }
        };

        socket.onerror = () => {
          socket.close();
        };
      } catch {
        if (!closed) {
          handlers.onStatus?.({ status: 'disconnected' });
          reconnectTimer = setTimeout(connect, 3000);
        }
      }
    };

    connect();

    return {
      close: () => {
        closed = true;
        clearTimeout(reconnectTimer);
        ws?.close();
      },
      subscribeSymbol: (symbol: string) => {
        selectedSymbol = symbol;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'subscribe', symbol }));
        }
      },
    };
  }
}

export const collectorClient = new CollectorClient();
