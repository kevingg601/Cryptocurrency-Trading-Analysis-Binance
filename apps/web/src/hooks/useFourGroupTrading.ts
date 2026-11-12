import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_FOUR_GROUP_OLLAMA_URL,
  FourGroupComparisonCoordinator,
  isAutoTradingActive,
  isRemoteOllamaUrl,
  sanitizeOllamaUrl,
  type AutoTradingConfig,
  type ExtendedAIAnalysisInput,
  type FourGroupCoinMode,
  type FourGroupComparisonMetrics,
  type FourGroupTradingBatch,
  type LightgbmRankSnapshot,
  type MarketNotification,
  type MarketType,
  type RollingPipelineStatus,
} from '@fadachi/core';
import {
  collectorClient,
  type FourGroupEngineRuntime,
  type FourGroupLgbmRuntimeState,
  type FourGroupRuntimeStatus,
} from '../api/collectorClient';

export type { FourGroupEngineRuntime };

export interface OllamaConnectionState {
  reachable: boolean;
  baseUrl: string;
  isRemote: boolean;
  models: string[];
  runningModels: Array<{ name: string; model: string; size?: number; sizeVram?: number }>;
  latencyMs: number | null;
  error: string | null;
  checking: boolean;
  checkedAt: number | null;
}

export interface LgbmLatestState {
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

const DEFAULT_ENGINE_RUNTIME: FourGroupEngineRuntime = {
  runningInCollector: true,
  generation: '',
  lastSaveAt: null,
  lastSaveDurationMs: null,
  lastSaveRevision: null,
  lastQueueWaitMs: null,
  lastTxElapsedMs: null,
  unsyncedChanges: false,
  error: null,
};

function createIdleBatchAndMetrics(): { snapshot: FourGroupTradingBatch; metrics: FourGroupComparisonMetrics } {
  const coord = new FourGroupComparisonCoordinator('futures');
  return {
    snapshot: coord.snapshot(),
    metrics: coord.calculateMetrics(),
  };
}

function toLgbmState(lgbm?: FourGroupLgbmRuntimeState | null): LgbmLatestState {
  if (!lgbm) {
    return {
      snapshot: null,
      expectedCutoffTime: null,
      isExpired: true,
      matchesCurrentHour: false,
      latestError: null,
      universeSymbols: [],
      lgbmStatus: null,
      trainingPaused: true,
      pausedReason: '目前暫停 Chronos-2 及其他非 LightGBM 模型訓練，僅執行 LightGBM 每小時獨立更新與排名發布',
    };
  }
  return {
    snapshot: lgbm.snapshot ?? null,
    expectedCutoffTime: lgbm.expectedCutoffTime ?? null,
    isExpired: Boolean(lgbm.isExpired),
    matchesCurrentHour: Boolean(lgbm.matchesCurrentHour),
    latestError: lgbm.latestError ?? null,
    universeSymbols: Array.isArray(lgbm.universeSymbols) ? lgbm.universeSymbols : [],
    lgbmStatus: lgbm.lgbmStatus ?? null,
    lgbmAutoSchedule: lgbm.lgbmAutoSchedule,
    trainingPaused: lgbm.trainingPaused ?? true,
    pausedReason: lgbm.pausedReason ?? null,
  };
}

function buildStatusMessage(params: {
  marketType: MarketType;
  statusLoaded: boolean;
  storageError: string | null;
  rulesReady: boolean;
  rulesError: string | null;
  streamHealthy: boolean;
  batchStatus: FourGroupTradingBatch['status'];
}): string {
  if (params.storageError) return params.storageError;
  if (!params.statusLoaded) return '正在連線 Collector 四組後端引擎...';
  if (params.marketType !== 'futures') {
    return '四組策略比較首版僅支援 USDT 永續合約（futures），請切換至合約模式後啟動';
  }
  if (!params.rulesReady) {
    return params.rulesError || '正在載入四組合約交易對規格...';
  }
  if (!params.streamHealthy) {
    return '等待 Collector 合約逐筆成交串流就緒';
  }
  if (isAutoTradingActive(params.batchStatus)) {
    return 'Collector 後端執行中・關閉或重整瀏覽器分頁不影響模擬進度';
  }
  return 'Collector 後端四組模擬就緒・LightGBM 全市場排名＋Ollama 雙門禁';
}

export function useFourGroupTrading(marketType: MarketType) {
  const initialIdleRef = useRef<{ snapshot: FourGroupTradingBatch; metrics: FourGroupComparisonMetrics } | null>(null);
  if (!initialIdleRef.current) {
    initialIdleRef.current = createIdleBatchAndMetrics();
  }

  const [snapshot, setSnapshot] = useState<FourGroupTradingBatch>(initialIdleRef.current.snapshot);
  const [metrics, setMetrics] = useState<FourGroupComparisonMetrics>(initialIdleRef.current.metrics);
  const [history, setHistory] = useState<FourGroupTradingBatch[]>([]);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [rulesReady, setRulesReady] = useState(false);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [streamHealthy, setStreamHealthy] = useState(false);
  const [engineRuntime, setEngineRuntime] = useState<FourGroupEngineRuntime>(DEFAULT_ENGINE_RUNTIME);

  const [ollamaDraftUrl, setOllamaDraftUrl] = useState(DEFAULT_FOUR_GROUP_OLLAMA_URL);
  const [ollamaConn, setOllamaConn] = useState<OllamaConnectionState>({
    reachable: false,
    baseUrl: DEFAULT_FOUR_GROUP_OLLAMA_URL,
    isRemote: false,
    models: [],
    runningModels: [],
    latencyMs: null,
    error: null,
    checking: false,
    checkedAt: null,
  });
  const [ollamaAnalyses, setOllamaAnalyses] = useState<Record<string, ExtendedAIAnalysisInput>>({});
  const [ollamaSymbolErrors, setOllamaSymbolErrors] = useState<Record<string, string>>({});
  const [analyzingOllama, setAnalyzingOllama] = useState(false);
  const [ollamaProgress, setOllamaProgress] = useState<{
    completed: number;
    total: number;
    currentSymbol: string | null;
  } | null>(null);
  const [ollamaLastError, setOllamaLastError] = useState<string | null>(null);
  const [updatingLgbm, setUpdatingLgbm] = useState(false);
  const [lgbmState, setLgbmState] = useState<LgbmLatestState>(() => toLgbmState(null));

  const mountedRef = useRef(true);
  const lifecycleRef = useRef(0);
  const commandEpochRef = useRef(0);
  const connectionRequestRef = useRef(0);
  const initialOllamaCheckRef = useRef(-1);
  const snapshotRef = useRef<FourGroupTradingBatch>(snapshot);
  const historyLoadedRef = useRef(false);
  const historyInFlightRef = useRef(false);
  const lastTrackedBatchRef = useRef<{ id: string; status: string } | null>(null);
  const notifyRef = useRef<((alert: MarketNotification, body?: string) => void) | null>(null);
  const seenNotifIdsRef = useRef<Set<string>>(new Set());
  const notifsInitializedRef = useRef(false);
  const signalSettingsRef = useRef<Record<string, number> | undefined>(undefined);

  useEffect(() => {
    mountedRef.current = true;
    lifecycleRef.current += 1;
    return () => {
      mountedRef.current = false;
      lifecycleRef.current += 1;
    };
  }, []);

  const refreshHistory = useCallback(async () => {
    if (historyInFlightRef.current) return;
    historyInFlightRef.current = true;
    const epoch = lifecycleRef.current;
    try {
      const rows = await collectorClient.getFourGroupBatches('futures', 50);
      if (!mountedRef.current || epoch !== lifecycleRef.current) return;
      const loaded = rows
        .map(r => r.batch)
        .filter((b): b is FourGroupTradingBatch => Boolean(b))
        .sort((a, b) => b.startedAt - a.startedAt);
      historyLoadedRef.current = true;
      setHistory(loaded);
    } catch {
      // Keep prior history on transient read errors; status polling surfaces connectivity errors.
    } finally {
      historyInFlightRef.current = false;
    }
  }, []);

  const applyRuntimeStatus = useCallback((status: FourGroupRuntimeStatus) => {
    const prevSnap = snapshotRef.current;
    const nextSnap = status.snapshot;
    if (nextSnap.id === prevSnap.id && nextSnap.revision < prevSnap.revision) {
      return;
    }

    snapshotRef.current = nextSnap;
    setSnapshot(nextSnap);
    setMetrics(status.metrics);
    setStatusLoaded(true);
    setRulesReady(Boolean(status.rulesReady));
    setRulesError(status.rulesError ?? null);
    setStreamHealthy(Boolean(status.streamHealthy));
    setLgbmState(toLgbmState(status.lgbmState));
    setOllamaAnalyses(status.ollama?.analyses ?? {});
    setOllamaSymbolErrors(status.ollama?.symbolErrors ?? {});
    setAnalyzingOllama(Boolean(status.ollama?.analyzing));
    setOllamaProgress(status.ollama?.progress ?? null);
    setOllamaLastError(status.ollama?.lastError ?? null);

    const runtime = status.engineRuntime ?? DEFAULT_ENGINE_RUNTIME;
    setEngineRuntime(runtime);
    setStorageError(runtime.error ?? null);

    // Deduplicate backend notifications; seed existing entries on initial attach so fresh tabs don't replay stale toasts.
    const incomingNotifs = status.recentNotifications ?? [];
    if (!notifsInitializedRef.current) {
      for (const note of incomingNotifs) {
        seenNotifIdsRef.current.add(note.id);
      }
      notifsInitializedRef.current = true;
    } else {
      for (const note of incomingNotifs) {
        if (seenNotifIdsRef.current.has(note.id)) continue;
        seenNotifIdsRef.current.add(note.id);
        notifyRef.current?.(note as unknown as MarketNotification, note.message);
      }
      if (seenNotifIdsRef.current.size > 200) {
        const keepIds = new Set(incomingNotifs.map(n => n.id));
        seenNotifIdsRef.current = keepIds;
      }
    }

    if (nextSnap.status !== 'IDLE') {
      setHistory((prev) => {
        const merged = new Map(prev.map(b => [b.id, b]));
        merged.set(nextSnap.id, nextSnap);
        return [...merged.values()].sort((a, b) => b.startedAt - a.startedAt);
      });
    }

    const prevTracked = lastTrackedBatchRef.current;
    const changedBatch = !prevTracked
      || prevTracked.id !== nextSnap.id
      || prevTracked.status !== nextSnap.status;
    lastTrackedBatchRef.current = { id: nextSnap.id, status: nextSnap.status };
    if (changedBatch || !historyLoadedRef.current) {
      void refreshHistory();
    }
  }, [refreshHistory]);

  const refreshStatus = useCallback(async () => {
    const epoch = lifecycleRef.current;
    const reqCmdEpoch = commandEpochRef.current;
    try {
      const status = await collectorClient.getFourGroupStatus();
      if (!mountedRef.current || epoch !== lifecycleRef.current || reqCmdEpoch !== commandEpochRef.current) {
        return null;
      }
      applyRuntimeStatus(status);
      return status;
    } catch (err: any) {
      if (!mountedRef.current || epoch !== lifecycleRef.current || reqCmdEpoch !== commandEpochRef.current) {
        return null;
      }
      const msg = `四組後端狀態無法讀取：${err instanceof Error ? err.message : 'Collector 連線失敗'}`;
      setStorageError(msg);
      return null;
    }
  }, [applyRuntimeStatus]);

  // Initial load on mount
  useEffect(() => {
    void refreshStatus();
    void refreshHistory();
  }, [refreshHistory, refreshStatus]);

  // Adaptive polling (1s when active or analyzing or booting, 4s when idle)
  const pollFast = isAutoTradingActive(snapshot.status) || analyzingOllama || !statusLoaded;
  useEffect(() => {
    const intervalMs = pollFast ? 1_000 : 4_000;
    const timer = setInterval(() => {
      void refreshStatus();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [pollFast, refreshStatus]);

  const testOllamaConnection = useCallback(async (urlOverride?: string, modelOverride?: string) => {
    const epoch = lifecycleRef.current;
    const requestId = ++connectionRequestRef.current;
    const raw = (urlOverride ?? ollamaDraftUrl).trim() || DEFAULT_FOUR_GROUP_OLLAMA_URL;
    let cleanUrl: string;
    let isRemote = false;
    try {
      cleanUrl = sanitizeOllamaUrl(raw);
      isRemote = isRemoteOllamaUrl(cleanUrl);
    } catch (err: any) {
      setOllamaConn(prev => ({
        ...prev,
        reachable: false,
        error: err?.message || 'Ollama URL 格式無效',
        checking: false,
        checkedAt: Date.now(),
      }));
      return null;
    }

    setOllamaConn(prev => ({ ...prev, checking: true, error: null, baseUrl: cleanUrl, isRemote }));
    try {
      const res = await collectorClient.testOllamaConnection(cleanUrl, modelOverride);
      if (!mountedRef.current || epoch !== lifecycleRef.current || requestId !== connectionRequestRef.current) return null;
      setOllamaConn({
        reachable: res.reachable,
        baseUrl: res.baseUrl,
        isRemote: res.isRemote,
        models: res.models ?? [],
        runningModels: res.runningModels ?? [],
        latencyMs: res.latencyMs ?? null,
        error: res.error ?? null,
        checking: false,
        checkedAt: Date.now(),
      });
      return res;
    } catch (err: any) {
      if (!mountedRef.current || epoch !== lifecycleRef.current || requestId !== connectionRequestRef.current) return null;
      setOllamaConn({
        reachable: false,
        baseUrl: cleanUrl,
        isRemote,
        models: [],
        runningModels: [],
        latencyMs: null,
        error: err?.message || 'Ollama 連線測試失敗',
        checking: false,
        checkedAt: Date.now(),
      });
      return null;
    }
  }, [ollamaDraftUrl]);

  // Initial Ollama check on mount
  useEffect(() => {
    if (initialOllamaCheckRef.current === lifecycleRef.current) return;
    initialOllamaCheckRef.current = lifecycleRef.current;
    void testOllamaConnection(DEFAULT_FOUR_GROUP_OLLAMA_URL);
  }, [testOllamaConnection]);

  const registerNotifications = useCallback((fn: ((alert: MarketNotification, body?: string) => void) | null) => {
    notifyRef.current = fn;
  }, []);

  const setSignalSettings = useCallback((settings: Record<string, number>) => {
    signalSettingsRef.current = { ...settings };
  }, []);

  const startFourGroup = useCallback(async (
    config: AutoTradingConfig,
    selectedCoins: string[],
    ollamaUrl: string,
    model: string,
    coinMode: FourGroupCoinMode = 'auto-lgbm',
  ) => {
    if (marketType !== 'futures') {
      throw new Error('四組策略比較首版僅支援 USDT 永續合約（futures）');
    }
    const cmdEpoch = ++commandEpochRef.current;
    const status = await collectorClient.startFourGroupBatch({
      config: { ...config, marketType: 'futures' },
      selectedCoins,
      coinMode,
      ollamaUrl,
      model,
      signalSettings: signalSettingsRef.current,
    });
    if (!mountedRef.current || cmdEpoch !== commandEpochRef.current) return;
    applyRuntimeStatus(status);
    void refreshHistory();
  }, [applyRuntimeStatus, marketType, refreshHistory]);

  const runBatchAction = useCallback(async (action: (id: string) => Promise<FourGroupRuntimeStatus>) => {
    const id = snapshotRef.current.id;
    if (!id || id === 'idle') return;
    const cmdEpoch = ++commandEpochRef.current;
    try {
      const status = await action(id);
      if (!mountedRef.current || cmdEpoch !== commandEpochRef.current) return;
      applyRuntimeStatus(status);
      void refreshHistory();
    } catch (err: any) {
      if (!mountedRef.current) return;
      setStorageError(err instanceof Error ? err.message : '四組策略控制指令執行失敗');
    }
  }, [applyRuntimeStatus, refreshHistory]);

  const pauseFourGroup = useCallback(() => runBatchAction(id => collectorClient.pauseFourGroupBatch(id)), [runBatchAction]);
  const resumeFourGroup = useCallback(() => runBatchAction(id => collectorClient.resumeFourGroupBatch(id)), [runBatchAction]);
  const drainFourGroup = useCallback(() => runBatchAction(id => collectorClient.drainFourGroupBatch(id)), [runBatchAction]);
  const closeAllFourGroup = useCallback(() => runBatchAction(id => collectorClient.closeAllFourGroupBatch(id)), [runBatchAction]);

  const triggerOllamaBatchAnalysis = useCallback(async () => {
    const cur = snapshotRef.current;
    if (!cur.id || cur.id === 'idle' || !isAutoTradingActive(cur.status)) return;
    const cmdEpoch = ++commandEpochRef.current;
    try {
      const status = await collectorClient.refreshFourGroupOllama(cur.id);
      if (!mountedRef.current || cmdEpoch !== commandEpochRef.current) return;
      applyRuntimeStatus(status);
    } catch (err: any) {
      if (!mountedRef.current) return;
      setOllamaLastError(err instanceof Error ? err.message : '觸發 Ollama 分析失敗');
    }
  }, [applyRuntimeStatus]);

  const refreshLgbmLatest = useCallback(async () => {
    await refreshStatus();
  }, [refreshStatus]);

  const triggerManualLgbmUpdate = useCallback(async (force = false) => {
    setUpdatingLgbm(true);
    try {
      const res = await collectorClient.triggerLightgbmHourlyUpdate(force);
      await refreshStatus();
      return res;
    } finally {
      if (mountedRef.current) setUpdatingLgbm(false);
    }
  }, [refreshStatus]);

  const ready = statusLoaded
    && marketType === 'futures'
    && rulesReady
    && streamHealthy
    && !storageError;

  const statusMessage = buildStatusMessage({
    marketType,
    statusLoaded,
    storageError,
    rulesReady,
    rulesError,
    streamHealthy,
    batchStatus: snapshot.status,
  });

  return {
    snapshot,
    metrics,
    history,
    storageError,
    engineRuntime,
    rulesReady,
    streamHealthy,
    ready,
    statusMessage,
    isActive: isAutoTradingActive(snapshot.status),
    ollamaDraftUrl,
    setOllamaDraftUrl,
    ollamaConn,
    ollamaAnalyses,
    ollamaSymbolErrors,
    analyzingOllama,
    ollamaProgress,
    ollamaLastError,
    updatingLgbm,
    lgbmState,
    testOllamaConnection,
    triggerOllamaBatchAnalysis,
    triggerManualLgbmUpdate,
    refreshLgbmLatest,
    refreshStatus,
    startFourGroup,
    pauseFourGroup,
    resumeFourGroup,
    drainFourGroup,
    closeAllFourGroup,
    registerNotifications,
    setSignalSettings,
  };
}
