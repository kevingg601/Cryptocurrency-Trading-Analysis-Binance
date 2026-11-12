import {
  DEFAULT_FOUR_GROUP_OLLAMA_URL,
  FOUR_GROUP_IDS,
  FollowPlanTracker,
  FourGroupComparisonCoordinator,
  MarketAlertDetector,
  fetchAutoFundingHistory,
  fetchAutoSymbolRules,
  isAutoTradingActive,
  normalizeMarketAlertSettings,
  type AggregateTradeData,
  type AutoFundingRecord,
  type AutoSymbolRules,
  type AutoTradingConfig,
  type AutoTradingNotification,
  type ExtendedAIAnalysisInput,
  type FourGroupCoinMode,
  type FourGroupComparisonMetrics,
  type FourGroupTradingBatch,
  type LightgbmRankSnapshot,
  type MarketAlertSettings,
  type MarketTradeFrame,
  type RollingPipelineStatus,
} from '@fadachi/core';
import type { StreamStatusInfo } from '../binance/streams.ts';
import type { RollingModelPipeline } from '../modelPaper/rollingPipeline.ts';
import type { TradeBus, TradeBusTradeEvent } from '../modelPaper/tradeBus.ts';
import type { DuckDBClient } from '../storage/duckdb.ts';
import { AB_SERVICE_GENERATION } from './abOwnership.ts';
import type { AIDataAggregator } from './aiDataAggregator.ts';
import { FourGroupBatchRepository, FourGroupStorageError } from './fourGroupStorage.ts';
import type { OllamaAnalysisRunner } from './ollamaRunner.ts';

export interface FourGroupServiceOptions {
  client: DuckDBClient;
  repo?: FourGroupBatchRepository;
  tradeBus: TradeBus;
  rollingPipeline: RollingModelPipeline;
  aiAggregator: AIDataAggregator;
  ollamaRunner: OllamaAnalysisRunner;
  fetchSymbolRules?: () => Promise<Record<string, AutoSymbolRules>>;
  fetchFundingHistory?: (symbol: string, startTime: number, endTime: number) => Promise<AutoFundingRecord[]>;
  clock?: () => number;
  heartbeatMs?: number;
  saveThrottleMs?: number;
  ollamaRefreshIntervalMs?: number;
  lgbmPollIntervalMs?: number;
  fundingIntervalMs?: number;
  rulesRetryMs?: number;
  requireConnectedStream?: boolean;
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

export interface FourGroupBackendNotification extends AutoTradingNotification {
  seq: number;
  createdAt: number;
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
  engineRuntime: {
    runningInCollector: boolean;
    generation: string;
    lastSaveAt: number | null;
    lastSaveDurationMs: number | null;
    lastSaveRevision: number | null;
    lastQueueWaitMs: number | null;
    lastTxElapsedMs: number | null;
    unsyncedChanges: boolean;
    error: string | null;
  };
  serverTime: number;
}

interface BatchStructureDigest {
  status: string;
  activeCoinsKey: string;
  decisionsCount: number;
  rotationsCount: number;
  accountDigest: string;
}

function computeStructureDigest(batch: FourGroupTradingBatch): BatchStructureDigest {
  const accountDigest = FOUR_GROUP_IDS.map((id) => {
    const acc = batch.accounts[id];
    return `${id}:${acc.orders.length}:${acc.fills.length}:${acc.positions.length}:${acc.trades.length}:${acc.events.length}:${acc.fundingStatus}:${acc.fundingThrough ?? 0}`;
  }).join('|');
  return {
    status: batch.status,
    activeCoinsKey: (batch.activeCoins ?? []).join(','),
    decisionsCount: batch.decisions.length,
    rotationsCount: batch.coinRotations?.length ?? 0,
    accountDigest,
  };
}

function hasStructuralChange(prev: BatchStructureDigest | null, next: BatchStructureDigest): boolean {
  if (!prev) return true;
  return prev.status !== next.status
    || prev.activeCoinsKey !== next.activeCoinsKey
    || prev.decisionsCount !== next.decisionsCount
    || prev.rotationsCount !== next.rotationsCount
    || prev.accountDigest !== next.accountDigest;
}

/**
 * Collector-resident authoritative service executing the Four-Group Strategy Comparison (A/B/C/D).
 * Removes browser write-lease dependencies and page-unload interruptions completely.
 */
export class FourGroupService {
  readonly repo: FourGroupBatchRepository;
  private readonly tradeBus: TradeBus;
  private readonly rollingPipeline: RollingModelPipeline;
  private readonly aiAggregator: AIDataAggregator;
  private readonly ollamaRunner: OllamaAnalysisRunner;
  private readonly fetchSymbolRules: () => Promise<Record<string, AutoSymbolRules>>;
  private readonly fetchFundingHistory: (symbol: string, startTime: number, endTime: number) => Promise<AutoFundingRecord[]>;
  private readonly clock: () => number;
  private readonly heartbeatMs: number;
  private readonly saveThrottleMs: number;
  private readonly ollamaRefreshIntervalMs: number;
  private readonly lgbmPollIntervalMs: number;
  private readonly fundingIntervalMs: number;
  private readonly rulesRetryMs: number;
  private readonly requireConnectedStream: boolean;

  private readonly coordinator = new FourGroupComparisonCoordinator('futures');
  private detector: MarketAlertDetector | null = null;
  private followTracker: FollowPlanTracker | null = null;

  private started = false;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private rulesReady = false;
  private rulesLoading: Promise<boolean> | null = null;
  private rulesError: string | null = null;
  private streamHealthy = false;
  private interruptedSince?: number;

  private ollamaAnalyses: Record<string, ExtendedAIAnalysisInput> = {};
  private ollamaSymbolErrors: Record<string, string> = {};
  private analyzingOllama = false;
  private ollamaNeedsRefresh = false;
  private ollamaProgress: { completed: number; total: number; currentSymbol: string | null } | null = null;
  private ollamaLastError: string | null = null;
  private ollamaRunSeq = 0;

  private notifSeq = 0;
  private recentNotifications: FourGroupBackendNotification[] = [];

  private persistedRevision = -1;
  private persistedBatchId: string | null = null;
  private lastMutationBatchId: string | null = null;
  private lastMutationRevision = -1;
  private lastSavedDigest: BatchStructureDigest | null = null;
  private inFlightSave: Promise<void> | null = null;
  private pendingSaveBatch: FourGroupTradingBatch | null = null;
  private throttledSaveTimer: NodeJS.Timeout | null = null;
  private fundingBusy = false;

  private saveStats = {
    lastSaveAt: null as number | null,
    lastSaveDurationMs: null as number | null,
    lastSaveRevision: null as number | null,
    lastQueueWaitMs: null as number | null,
    lastTxElapsedMs: null as number | null,
    unsyncedChanges: false,
    error: null as string | null,
  };

  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lgbmTimer: NodeJS.Timeout | null = null;
  private ollamaTimer: NodeJS.Timeout | null = null;
  private fundingTimer: NodeJS.Timeout | null = null;
  private rulesTimer: NodeJS.Timeout | null = null;
  private onTradeBound: ((ev: TradeBusTradeEvent) => void) | null = null;
  private onStatusBound: ((st: StreamStatusInfo) => void) | null = null;

  constructor(options: FourGroupServiceOptions) {
    this.repo = options.repo ?? new FourGroupBatchRepository(options.client, options.clock);
    this.tradeBus = options.tradeBus;
    this.rollingPipeline = options.rollingPipeline;
    this.aiAggregator = options.aiAggregator;
    this.ollamaRunner = options.ollamaRunner;
    this.fetchSymbolRules = options.fetchSymbolRules ?? (() => fetchAutoSymbolRules('futures'));
    this.fetchFundingHistory = options.fetchFundingHistory ?? fetchAutoFundingHistory;
    this.clock = options.clock ?? Date.now;
    this.heartbeatMs = Math.max(50, options.heartbeatMs ?? 250);
    this.saveThrottleMs = Math.max(100, options.saveThrottleMs ?? 2_000);
    this.ollamaRefreshIntervalMs = Math.max(1_000, options.ollamaRefreshIntervalMs ?? 8 * 60_000);
    this.lgbmPollIntervalMs = Math.max(500, options.lgbmPollIntervalMs ?? 15_000);
    this.fundingIntervalMs = Math.max(1_000, options.fundingIntervalMs ?? 30_000);
    this.rulesRetryMs = Math.max(1_000, options.rulesRetryMs ?? 15_000);
    this.requireConnectedStream = options.requireConnectedStream ?? true;
  }

  async start(): Promise<void> {
    if (this.stopPromise) {
      await this.stopPromise;
    }
    if (this.started) return;
    this.started = true;
    this.stopping = false;

    // Startup recovery (Option A): reconcile any active batch left behind by a prior crash/restart
    await this.repo.reconcileOrphanedBatches({ market: 'futures', now: this.clock() });
    if (this.stopping) return;
    await this.reconcilePendingFunding();
    if (this.stopping) return;

    this.onTradeBound = (ev) => this.handleTrade(ev);
    this.onStatusBound = (st) => this.handleStreamStatus(st);
    this.tradeBus.on('trade', this.onTradeBound);
    this.tradeBus.on('status', this.onStatusBound);
    this.handleStreamStatus(this.tradeBus.getStreamStatus());

    this.syncLgbmState();
    await this.tryLoadRules();
    if (this.stopping) return;

    this.heartbeatTimer = setInterval(() => {
      if (this.stopping) return;
      if (isAutoTradingActive(this.coordinator.getBatchMeta().status)) {
        const now = this.clock();
        this.followTracker?.tick(now);
        this.coordinator.tick(now);
        this.afterCoordinatorMutation();
      }
    }, this.heartbeatMs);

    this.lgbmTimer = setInterval(() => {
      if (!this.stopping) this.syncLgbmState();
    }, this.lgbmPollIntervalMs);

    this.ollamaTimer = setInterval(() => {
      if (this.stopping) return;
      const meta = this.coordinator.getBatchMeta();
      if (meta.status === 'RUNNING') {
        void this.refreshOllama(meta.id).catch(() => {});
      }
    }, this.ollamaRefreshIntervalMs);

    this.fundingTimer = setInterval(() => {
      if (!this.stopping) void this.reconcilePendingFunding();
    }, this.fundingIntervalMs);

    if (!this.rulesReady) {
      this.rulesTimer = setInterval(() => {
        if (this.stopping || this.rulesReady) {
          if (this.rulesTimer) {
            clearInterval(this.rulesTimer);
            this.rulesTimer = null;
          }
          return;
        }
        void this.tryLoadRules();
      }, this.rulesRetryMs);
    }
  }

  async stop(reason = 'Collector 程序關閉，四組策略評估已收尾中斷'): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.started && !this.stopping) return;
    this.stopping = true;
    this.ollamaRunSeq += 1;
    this.analyzingOllama = false;
    this.ollamaNeedsRefresh = false;
    this.ollamaProgress = null;

    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.lgbmTimer) { clearInterval(this.lgbmTimer); this.lgbmTimer = null; }
    if (this.ollamaTimer) { clearInterval(this.ollamaTimer); this.ollamaTimer = null; }
    if (this.fundingTimer) { clearInterval(this.fundingTimer); this.fundingTimer = null; }
    if (this.rulesTimer) { clearInterval(this.rulesTimer); this.rulesTimer = null; }
    if (this.throttledSaveTimer) { clearTimeout(this.throttledSaveTimer); this.throttledSaveTimer = null; }

    if (this.onTradeBound) { this.tradeBus.off('trade', this.onTradeBound); this.onTradeBound = null; }
    if (this.onStatusBound) { this.tradeBus.off('status', this.onStatusBound); this.onStatusBound = null; }

    this.stopPromise = (async () => {
      try {
        const meta = this.coordinator.getBatchMeta();
        if (isAutoTradingActive(meta.status)) {
          this.coordinator.interrupt(this.clock(), reason);
          this.drainNotifications();
          const interrupted = this.coordinator.snapshot();
          await this.saveNow(interrupted);
        } else if (meta.status !== 'IDLE' && (meta.id !== this.persistedBatchId || meta.revision > this.persistedRevision)) {
          await this.saveNow(this.coordinator.snapshot());
        } else {
          await this.flushPendingSaves();
        }
        this.started = false;
      } finally {
        this.stopping = false;
        this.stopPromise = null;
      }
    })();
    return this.stopPromise;
  }

  async tryLoadRules(): Promise<boolean> {
    if (this.rulesReady) return true;
    if (this.rulesLoading) return this.rulesLoading;
    this.rulesLoading = (async () => {
      try {
        const rules = await this.fetchSymbolRules();
        if (!rules || !Object.keys(rules).length) {
          throw new Error('合約交易對規格為空');
        }
        this.coordinator.setRules(rules);
        this.rulesReady = true;
        this.rulesError = null;
        if (this.rulesTimer) {
          clearInterval(this.rulesTimer);
          this.rulesTimer = null;
        }
        return true;
      } catch (err: any) {
        this.rulesError = `四組合約規格載入失敗：${err?.message || '網路異常'}`;
        return false;
      } finally {
        this.rulesLoading = null;
      }
    })();
    return this.rulesLoading;
  }

  private handleStreamStatus(status: StreamStatusInfo): void {
    const healthy = status.status === 'connected';
    const now = this.clock();
    if (healthy) {
      this.interruptedSince = undefined;
    } else if (this.streamHealthy && !healthy) {
      this.interruptedSince = now;
    }
    this.streamHealthy = healthy;
    const validAt = status.lastValidAt && status.lastValidAt > 0 ? status.lastValidAt : now;
    this.coordinator.setStreamHealthy(healthy, validAt, healthy ? undefined : this.interruptedSince);
    this.afterCoordinatorMutation();
  }

  private handleTrade(ev: TradeBusTradeEvent): void {
    if (this.stopping) return;
    if (!isAutoTradingActive(this.coordinator.getBatchMeta().status) || !this.detector || !this.followTracker) return;

    const trade: AggregateTradeData = {
      symbol: ev.symbol,
      price: ev.price,
      quantity: ev.qty,
      quoteValue: ev.price * ev.qty,
      side: ev.side ?? 'buy',
      timestamp: ev.tradeTime,
      lastTradeId: ev.lastTradeId,
    };
    const priceAlert = this.detector.processTicker({ symbol: trade.symbol, price: trade.price }, 'futures', trade.timestamp);
    const { events } = this.followTracker.processMarketTrade(trade, 'futures', priceAlert, ev.receivedAt);
    this.detector.processTrade(trade, 'futures');
    const plans = events.some(e => e.type === 'follow-confirmed') ? this.followTracker.getPlans() : [];
    const frame: MarketTradeFrame = {
      trade,
      marketType: 'futures',
      receivedAt: ev.receivedAt,
      alert: priceAlert,
      confirmations: events
        .filter(e => e.type === 'follow-confirmed')
        .flatMap((event) => {
          const confirmedPlan = plans.find(item => item.id === event.planId);
          return confirmedPlan ? [{ event, plan: confirmedPlan }] : [];
        }),
    };
    this.coordinator.processFrame(frame);
    this.afterCoordinatorMutation();
  }

  syncLgbmState(): void {
    const rankingState = this.rollingPipeline.getLatestLightgbmRanking();
    const current = this.coordinator.getLightgbmRanking();
    const incoming = rankingState.snapshot ?? null;
    if (
      current
      && incoming
      && (incoming.cutoffTime < current.cutoffTime
        || (incoming.cutoffTime === current.cutoffTime && incoming.publishedAt < current.publishedAt))
    ) {
      return;
    }

    const beforeMeta = this.coordinator.getBatchMeta();
    if (!isAutoTradingActive(beforeMeta.status)) {
      this.coordinator.updateLightgbmRanking(incoming);
      return;
    }

    const beforeSnap = this.coordinator.snapshot();
    const prevCoins = beforeSnap.activeCoins?.length ? beforeSnap.activeCoins : beforeSnap.locked.selectedCoins;
    this.coordinator.updateLightgbmRanking(incoming);
    const afterSnap = this.coordinator.snapshot();
    const nextCoins = afterSnap.activeCoins?.length ? afterSnap.activeCoins : afterSnap.locked.selectedCoins;
    const rotated = isAutoTradingActive(afterSnap.status)
      && (prevCoins.length !== nextCoins.length || prevCoins.some((c, i) => c !== nextCoins[i]));

    if (rotated || afterSnap.revision !== beforeSnap.revision) {
      this.afterCoordinatorMutation();
      if (rotated && afterSnap.status === 'RUNNING') {
        if (this.analyzingOllama) {
          this.ollamaNeedsRefresh = true;
        } else {
          void this.refreshOllama(afterSnap.id).catch(() => {});
        }
      }
    }
  }

  private drainNotifications(): void {
    const notes = this.coordinator.takeNotifications();
    if (!notes.length) return;
    const now = this.clock();
    for (const note of notes) {
      this.recentNotifications.push({
        ...note,
        seq: ++this.notifSeq,
        createdAt: now,
      });
    }
    if (this.recentNotifications.length > 50) {
      this.recentNotifications = this.recentNotifications.slice(-50);
    }
  }

  private afterCoordinatorMutation(): void {
    this.drainNotifications();
    const meta = this.coordinator.getBatchMeta();
    if (meta.status === 'IDLE') return;
    if (meta.id === this.persistedBatchId && meta.revision === this.persistedRevision) return;
    if (meta.id === this.lastMutationBatchId && meta.revision === this.lastMutationRevision) return;
    this.lastMutationBatchId = meta.id;
    this.lastMutationRevision = meta.revision;

    const snap = this.coordinator.snapshot();
    const digest = computeStructureDigest(snap);
    const urgent = snap.id !== this.persistedBatchId || hasStructuralChange(this.lastSavedDigest, digest);
    if (urgent) {
      if (this.throttledSaveTimer) {
        clearTimeout(this.throttledSaveTimer);
        this.throttledSaveTimer = null;
      }
      this.enqueueSave(snap);
    } else if (!this.throttledSaveTimer) {
      this.saveStats.unsyncedChanges = true;
      this.throttledSaveTimer = setTimeout(() => {
        this.throttledSaveTimer = null;
        if (this.stopping) return;
        const latestMeta = this.coordinator.getBatchMeta();
        if (latestMeta.status !== 'IDLE' && (latestMeta.id !== this.persistedBatchId || latestMeta.revision > this.persistedRevision)) {
          this.enqueueSave(this.coordinator.snapshot());
        }
      }, this.saveThrottleMs);
    }
  }

  private enqueueSave(snap: FourGroupTradingBatch): void {
    this.pendingSaveBatch = snap;
    this.saveStats.unsyncedChanges = true;
    void this.pumpSaves().catch(() => {});
  }

  private pumpSaves(): Promise<void> {
    if (this.inFlightSave) return this.inFlightSave;
    const runner = (async () => {
      try {
        while (this.pendingSaveBatch) {
          const batch = this.pendingSaveBatch;
          this.pendingSaveBatch = null;
          const startedAt = this.clock();
          try {
            const res = await this.repo.saveSystemBatch(batch);
            const doneAt = this.clock();
            this.persistedBatchId = batch.id;
            this.persistedRevision = Math.max(this.persistedRevision, batch.revision);
            this.lastSavedDigest = computeStructureDigest(batch);
            const curMeta = this.coordinator.getBatchMeta();
            this.saveStats = {
              lastSaveAt: doneAt,
              lastSaveDurationMs: Math.max(0, doneAt - startedAt),
              lastSaveRevision: batch.revision,
              lastQueueWaitMs: res.queueWaitMs,
              lastTxElapsedMs: res.txElapsedMs,
              unsyncedChanges: this.pendingSaveBatch !== null
                || (curMeta.id === batch.id && curMeta.revision > batch.revision),
              error: null,
            };
          } catch (err: any) {
            this.saveStats = {
              ...this.saveStats,
              unsyncedChanges: true,
              error: err?.message || '後端寫入四組策略資料失敗',
            };
            throw err;
          }
        }
      } finally {
        if (this.inFlightSave === runner) {
          this.inFlightSave = null;
        }
        if (this.pendingSaveBatch) {
          void this.pumpSaves().catch(() => {});
        }
      }
    })();
    this.inFlightSave = runner;
    return runner;
  }

  private async saveNow(snap: FourGroupTradingBatch): Promise<void> {
    if (this.throttledSaveTimer) {
      clearTimeout(this.throttledSaveTimer);
      this.throttledSaveTimer = null;
    }
    this.pendingSaveBatch = snap;
    this.saveStats.unsyncedChanges = true;
    await this.flushPendingSaves();
  }

  private async flushPendingSaves(): Promise<void> {
    while (this.inFlightSave || this.pendingSaveBatch) {
      let failed = false;
      await this.pumpSaves().catch(() => {
        failed = true;
      });
      if (failed && !this.inFlightSave) {
        // Avoid spinning forever when DuckDB write fails persistently
        break;
      }
    }
    const meta = this.coordinator.getBatchMeta();
    const unpersisted = meta.status !== 'IDLE'
      && (meta.id !== this.persistedBatchId || meta.revision > this.persistedRevision);
    if (this.saveStats.error && unpersisted) {
      throw new FourGroupStorageError(500, this.saveStats.error);
    }
  }

  async startBatch(params: {
    config: AutoTradingConfig;
    selectedCoins?: string[];
    coinMode?: FourGroupCoinMode;
    ollamaUrl?: string;
    model: string;
    signalSettings?: Partial<MarketAlertSettings> | Record<string, number>;
  }): Promise<FourGroupRuntimeStatus> {
    if (this.stopping) {
      throw new FourGroupStorageError(409, 'Collector 正在關閉中，無法啟動四組策略批次');
    }
    if (isAutoTradingActive(this.coordinator.getBatchMeta().status)) {
      throw new FourGroupStorageError(409, '請先結束目前的四組策略評估');
    }
    if (!this.rulesReady) {
      await this.tryLoadRules();
      if (this.stopping) {
        throw new FourGroupStorageError(409, 'Collector 正在關閉中，無法啟動四組策略批次');
      }
      if (isAutoTradingActive(this.coordinator.getBatchMeta().status)) {
        throw new FourGroupStorageError(409, '請先結束目前的四組策略評估');
      }
      if (!this.rulesReady) {
        throw new FourGroupStorageError(409, this.rulesError || '四組合約規格尚未就緒，無法啟動');
      }
    }
    const streamInfo = this.tradeBus.getStreamStatus();
    if (streamInfo.status === 'connected') {
      this.streamHealthy = true;
      this.coordinator.setStreamHealthy(true, streamInfo.lastValidAt || this.clock());
    }
    if (this.requireConnectedStream && !this.streamHealthy) {
      throw new FourGroupStorageError(409, '等待合約逐筆成交串流就緒');
    }

    const pipelineStatus = this.rollingPipeline.getStatus();
    const universe = pipelineStatus.universeSymbols;
    if (!Array.isArray(universe) || universe.length !== 20) {
      throw new FourGroupStorageError(400, '四組批次必須使用伺服器固定的完整 20 檔研究幣池');
    }

    this.syncLgbmState();
    const normalizedSignals = normalizeMarketAlertSettings(params.signalSettings ?? {});
    const coinMode: FourGroupCoinMode = params.coinMode ?? 'auto-lgbm';

    try {
      this.coordinator.start({
        config: { ...params.config, marketType: 'futures' },
        coinMode,
        selectedCoins: params.selectedCoins,
        universeSymbols: universe,
        ollamaUrl: params.ollamaUrl ?? DEFAULT_FOUR_GROUP_OLLAMA_URL,
        model: params.model,
        now: this.clock(),
        signalSettings: { ...normalizedSignals },
      });
    } catch (err: any) {
      if (err instanceof FourGroupStorageError) throw err;
      throw new FourGroupStorageError(400, err?.message || '無法啟動四組策略比較');
    }

    this.detector = new MarketAlertDetector(normalizedSignals);
    this.followTracker = new FollowPlanTracker();
    this.ollamaRunSeq += 1;
    this.analyzingOllama = false;
    this.ollamaNeedsRefresh = false;
    this.ollamaProgress = null;
    this.ollamaLastError = null;
    this.ollamaAnalyses = {};
    this.ollamaSymbolErrors = {};
    this.persistedRevision = -1;
    this.persistedBatchId = null;
    this.lastMutationBatchId = null;
    this.lastMutationRevision = -1;
    this.lastSavedDigest = null;

    const batch = this.coordinator.snapshot();
    try {
      await this.saveNow(batch);
    } catch (err) {
      this.detector = null;
      this.followTracker = null;
      this.coordinator.interrupt(this.clock(), '初始化持久化失敗');
      this.drainNotifications();
      throw err;
    }
    void this.refreshOllama(batch.id).catch(() => {});
    return this.getStatus();
  }

  private assertActiveBatchId(id: string): void {
    const meta = this.coordinator.getBatchMeta();
    if (meta.status === 'IDLE' || meta.id !== id) {
      throw new FourGroupStorageError(404, '找不到目前運作中的四組策略批次');
    }
    if (!isAutoTradingActive(meta.status)) {
      throw new FourGroupStorageError(409, '此四組策略批次已結束，無法執行控制操作');
    }
  }

  async pauseBatch(id: string): Promise<FourGroupRuntimeStatus> {
    this.assertActiveBatchId(id);
    this.coordinator.pause(this.clock());
    this.drainNotifications();
    await this.saveNow(this.coordinator.snapshot());
    return this.getStatus();
  }

  async resumeBatch(id: string): Promise<FourGroupRuntimeStatus> {
    this.assertActiveBatchId(id);
    this.coordinator.resume(this.clock());
    this.drainNotifications();
    await this.saveNow(this.coordinator.snapshot());
    return this.getStatus();
  }

  async drainBatch(id: string): Promise<FourGroupRuntimeStatus> {
    this.assertActiveBatchId(id);
    this.coordinator.drain(this.clock());
    this.drainNotifications();
    await this.saveNow(this.coordinator.snapshot());
    return this.getStatus();
  }

  async closeAllBatch(id: string): Promise<FourGroupRuntimeStatus> {
    this.assertActiveBatchId(id);
    this.ollamaRunSeq += 1;
    this.analyzingOllama = false;
    this.ollamaNeedsRefresh = false;
    this.ollamaProgress = null;
    this.coordinator.closeAll(this.clock());
    this.drainNotifications();
    await this.saveNow(this.coordinator.snapshot());
    await this.reconcilePendingFunding();
    return this.getStatus();
  }

  async refreshOllama(id?: string): Promise<FourGroupRuntimeStatus> {
    const snap = this.coordinator.snapshot();
    if (snap.status === 'IDLE' || !isAutoTradingActive(snap.status)) {
      throw new FourGroupStorageError(409, '目前無運作中的四組策略批次可分析');
    }
    if (id && snap.id !== id) {
      throw new FourGroupStorageError(404, '找不到指定運作中的四組策略批次');
    }
    if (this.analyzingOllama) {
      return this.getStatus();
    }

    const activeSymbols = snap.activeCoins?.length ? snap.activeCoins : snap.locked.selectedCoins;
    if (!activeSymbols.length) {
      return this.getStatus();
    }

    const lgbmSnap = this.coordinator.getLightgbmRanking();
    const targetSet = new Set(activeSymbols);
    const prioritized: string[] = [];
    if (lgbmSnap && lgbmSnap.status === 'SUCCESS') {
      const top3Pairs = [0, 1, 2].flatMap(idx => [
        lgbmSnap.longTop5?.[idx]?.symbol,
        lgbmSnap.shortTop5?.[idx]?.symbol,
      ]);
      for (const rawSym of top3Pairs) {
        const sym = typeof rawSym === 'string' ? rawSym.trim().toUpperCase() : '';
        if (sym && targetSet.has(sym) && !prioritized.includes(sym)) {
          prioritized.push(sym);
        }
      }
    }
    for (const sym of activeSymbols) {
      if (!prioritized.includes(sym)) prioritized.push(sym);
    }

    const runSeq = ++this.ollamaRunSeq;
    const batchId = snap.id;
    this.analyzingOllama = true;
    this.ollamaNeedsRefresh = false;
    this.ollamaLastError = null;
    this.ollamaProgress = { completed: 0, total: prioritized.length, currentSymbol: prioritized[0] ?? null };

    void (async () => {
      try {
        for (let i = 0; i < prioritized.length; i += 1) {
          const sym = prioritized[i];
          const curMeta = this.coordinator.getBatchMeta();
          if (this.stopping || runSeq !== this.ollamaRunSeq || curMeta.id !== batchId || !isAutoTradingActive(curMeta.status)) {
            return;
          }
          const curSnap = this.coordinator.snapshot();
          this.ollamaProgress = { completed: i, total: prioritized.length, currentSymbol: sym };
          try {
            const res = await this.ollamaRunner.analyzeSymbols({
              aggregator: this.aiAggregator,
              symbols: [sym],
              model: curSnap.locked.model,
              baseUrl: curSnap.locked.ollamaUrl,
              market: 'futures',
              promptVersion: curSnap.locked.promptVersion,
              ruleVersion: curSnap.locked.ruleVersion,
              now: this.clock(),
            });
            const latestMeta = this.coordinator.getBatchMeta();
            if (this.stopping || runSeq !== this.ollamaRunSeq || latestMeta.id !== batchId || !isAutoTradingActive(latestMeta.status)) {
              return;
            }
            const now = this.clock();
            for (const item of Object.values(res.results ?? {})) {
              this.coordinator.updateAnalysis(item as ExtendedAIAnalysisInput, now);
            }
            if (res.results && Object.keys(res.results).length > 0) {
              this.ollamaAnalyses = {
                ...this.ollamaAnalyses,
                ...(res.results as Record<string, ExtendedAIAnalysisInput>),
              };
            }
            const symErr = res.errors?.[sym];
            if (symErr) {
              this.ollamaLastError = `${sym}: ${symErr}`;
              this.ollamaSymbolErrors = { ...this.ollamaSymbolErrors, [sym]: symErr };
            } else if (this.ollamaSymbolErrors[sym]) {
              const nextErrs = { ...this.ollamaSymbolErrors };
              delete nextErrs[sym];
              this.ollamaSymbolErrors = nextErrs;
            }
          } catch (err: any) {
            if (this.stopping || runSeq !== this.ollamaRunSeq || this.coordinator.getBatchMeta().id !== batchId) {
              return;
            }
            const msg = err?.message || 'Ollama 推論失敗或逾時';
            this.ollamaLastError = `${sym}: ${msg}`;
            this.ollamaSymbolErrors = { ...this.ollamaSymbolErrors, [sym]: msg };
          }
        }
        if (runSeq === this.ollamaRunSeq && this.coordinator.getBatchMeta().id === batchId) {
          this.ollamaProgress = { completed: prioritized.length, total: prioritized.length, currentSymbol: null };
        }
      } finally {
        if (runSeq === this.ollamaRunSeq) {
          this.analyzingOllama = false;
          const needsRerun = this.ollamaNeedsRefresh;
          this.ollamaNeedsRefresh = false;
          const curMeta = this.coordinator.getBatchMeta();
          if (needsRerun && !this.stopping && curMeta.status === 'RUNNING' && curMeta.id === batchId) {
            void this.refreshOllama(batchId).catch(() => {});
          }
        }
      }
    })();

    return this.getStatus();
  }

  async reconcilePendingFunding(): Promise<void> {
    if (this.fundingBusy) return;
    this.fundingBusy = true;
    try {
      const liveSnap = this.coordinator.snapshot();
      const rows = await this.repo.list('futures', 25);
      const candidates = new Map<string, FourGroupTradingBatch>();
      for (const r of rows) {
        if (r.batch) candidates.set(r.batch.id, r.batch);
      }
      if (liveSnap.status !== 'IDLE') {
        candidates.set(liveSnap.id, liveSnap);
      }

      for (const current of candidates.values()) {
        if (this.stopping) break;
        const allFills = FOUR_GROUP_IDS.flatMap(g => current.accounts[g].fills);
        if (!allFills.length) continue;

        const now = this.clock();
        const latestFillTime = Math.max(...allFills.map(f => f.tradeTimestamp));
        const end = Math.max(current.endedAt ?? now, latestFillTime);
        const through = Math.min(end, now - 60_000);
        const first = Math.min(...allFills.map(f => f.tradeTimestamp));
        if (through < first) continue;

        const allSettled = FOUR_GROUP_IDS.every((g) => {
          const acct = current.accounts[g];
          if (acct.fills.length === 0 && acct.fundingStatus === 'NOT_REQUIRED') return true;
          return acct.fundingStatus === 'SETTLED' && (acct.fundingThrough ?? 0) >= end;
        });
        if (allSettled && !isAutoTradingActive(current.status)) continue;

        const isCurrent = this.coordinator.snapshot().id === current.id;
        const targetCoord = isCurrent ? this.coordinator : new FourGroupComparisonCoordinator('futures');
        if (!isCurrent) {
          targetCoord.restoreInterrupted(current, now);
        }

        try {
          const records: AutoFundingRecord[] = [];
          const cursor = first - 60_000;
          const symbols = new Set(allFills.map(f => f.symbol));
          for (const sym of symbols) {
            records.push(...await this.fetchFundingHistory(sym, cursor, through));
          }
          if (this.stopping) break;
          if (isCurrent && this.coordinator.snapshot().id !== current.id) continue;
          targetCoord.applyFunding(records, through, this.clock());
        } catch {
          if (!this.stopping && (!isCurrent || this.coordinator.snapshot().id === current.id)) {
            targetCoord.fundingFailed(this.clock());
          }
        }

        if (this.stopping) break;
        if (isCurrent) {
          if (this.coordinator.snapshot().id !== current.id) continue;
          this.afterCoordinatorMutation();
        } else {
          await this.repo.saveSystemBatch(targetCoord.snapshot()).catch(() => {});
        }
      }
    } finally {
      this.fundingBusy = false;
    }
  }

  private buildLgbmState(): FourGroupLgbmRuntimeState {
    const pipelineStatus = this.rollingPipeline.getStatus();
    const rankingState = this.rollingPipeline.getLatestLightgbmRanking();
    return {
      snapshot: rankingState.snapshot ?? null,
      expectedCutoffTime: rankingState.expectedCutoffTime ?? null,
      isExpired: Boolean(rankingState.isExpired),
      matchesCurrentHour: Boolean(rankingState.matchesCurrentHour),
      latestError: rankingState.latestError ?? null,
      universeSymbols: Array.isArray(pipelineStatus.universeSymbols) ? pipelineStatus.universeSymbols : [],
      lgbmStatus: pipelineStatus.lgbm ?? null,
      lgbmAutoSchedule: pipelineStatus.lgbmAutoSchedule,
      trainingPaused: pipelineStatus.trainingPaused ?? true,
      pausedReason: pipelineStatus.pausedReason ?? null,
    };
  }

  getStatus(): FourGroupRuntimeStatus {
    const snap = this.coordinator.snapshot();
    return {
      snapshot: snap,
      metrics: this.coordinator.calculateMetrics(),
      streamHealthy: this.streamHealthy,
      rulesReady: this.rulesReady,
      rulesError: this.rulesError,
      lgbmState: this.buildLgbmState(),
      ollama: {
        analyzing: this.analyzingOllama,
        progress: this.ollamaProgress ? { ...this.ollamaProgress } : null,
        lastError: this.ollamaLastError,
        analyses: { ...this.ollamaAnalyses },
        symbolErrors: { ...this.ollamaSymbolErrors },
      },
      recentNotifications: [...this.recentNotifications],
      engineRuntime: {
        runningInCollector: true,
        generation: AB_SERVICE_GENERATION,
        ...this.saveStats,
        unsyncedChanges: this.saveStats.unsyncedChanges
          || (snap.status !== 'IDLE' && (snap.id !== this.persistedBatchId || snap.revision > this.persistedRevision)),
      },
      serverTime: this.clock(),
    };
  }
}
