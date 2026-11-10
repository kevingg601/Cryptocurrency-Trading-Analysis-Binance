import type { MarketType } from '../market/types.ts';

export type KronosModelKey = 'small' | 'base';

export type ResearchRunValidityStatus =
  | 'UNCONFIGURED'
  | 'LOADING'
  | 'EMPTY'
  | 'INSUFFICIENT_DATA'
  | 'MODEL_MISSING'
  | 'FAILED'
  | 'SUCCESS'
  | 'EXPIRED';

export type ResearchJobStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED';

export interface ResearchRankingEntry {
  rank: number;
  symbol: string;
  side: 'LONG' | 'SHORT';
  /** Relative ranking score only — never win probability or expected return. */
  rankingScore: number;
  longScore: number;
  shortScore: number;
  longRank: number;
  shortRank: number;
  /** True when the symbol appears in both Long Top 5 and Short Top 5. */
  conflict: boolean;
  closePrice: number;
  ret1h: number;
  ret4h: number;
  ret24h: number;
  rsi14: number;
  fundingRateLatest?: number;
  fundingRateZScore7d?: number;
  trend4hSma6Dist?: number;
  trend24hSma4Dist?: number;
}

export interface KronosSampleDispersion {
  closeMin: number;
  closeMax: number;
  closeStd: number;
  highMax: number;
  lowMin: number;
  sampleCloses: number[];
  sampleCount: number;
  /** Explicitly labeled as sample dispersion, never a calibrated confidence interval. */
  label: string;
}

export interface KronosCandlePoint {
  openTime: number;
  closeTime: number;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  step?: number;
  sampleDispersion?: KronosSampleDispersion;
}

export interface KronosSymbolForecast {
  symbol: string;
  modelKey: KronosModelKey;
  repoId: string;
  revision: string;
  cutoffTime: number;
  lastOpenTime: number;
  lastClosePrice: number;
  predictedClose4h: number;
  predictedReturn4h: number;
  elapsedMs: number;
  peakVramAllocatedMb: number;
  peakVramReservedMb: number;
  inferenceConfig: {
    lookback: number;
    pred_len: number;
    max_context: number;
    batch_size: number;
    sample_count: number;
    seed: number;
    temperature: number;
    top_k: number;
    top_p: number;
    clip: number;
  };
  historicalCandles: KronosCandlePoint[];
  predictedCandles: KronosCandlePoint[];
  dispersionDisclaimer: string;
}

export interface ResearchInsufficientSymbol {
  symbol: string;
  reason?: string;
  reasons?: string[];
}

export interface ResearchModelSummary {
  lightgbm: {
    family: string;
    device: string;
    longSha256: string;
    shortSha256: string;
    selectedParamsLong: Record<string, unknown>;
    selectedParamsShort: Record<string, unknown>;
    elapsedMs: number;
  };
  kronos: {
    modelKey: KronosModelKey;
    repoId: string;
    revision: string;
    modelSha256?: string | null;
    tokenizerRepoId: string;
    tokenizerRevision: string;
    tokenizerSha256?: string | null;
    inferenceConfig: Record<string, unknown>;
    targetSymbols: string[];
    totalElapsedMs: number;
    peakVramAllocatedMb: number;
    peakVramReservedMb: number;
    gpuEnvironment?: {
      torchVersion?: string;
      cudaAvailable?: boolean;
      cudaVersion?: string | null;
      gpuName?: string | null;
      totalVramMb?: number;
      allocatedVramMb?: number;
      reservedVramMb?: number;
    };
  };
}

export interface ResearchDatasetQuality {
  datasetVersion: string | null;
  klinesSha256?: string | null;
  universeSelectedAt?: number | null;
  universeSymbols: string[];
  eligibleCount: number;
  insufficientSymbols: ResearchInsufficientSymbol[];
}

export interface ResearchOfflineRankingDirectionMetrics {
  ndcgAt5Close4h: number;
  ndcgAt5NetReturn: number;
  spearmanIcNetReturn: number;
  top5MeanCloseReturn4h: number;
  top5MeanNetReturn: number;
  top5PositiveNetRate: number;
}

export interface ResearchOfflineRankingMetrics {
  groupCount: number;
  sampleCount: number;
  spearmanIcClose4h: number;
  long: ResearchOfflineRankingDirectionMetrics;
  short: ResearchOfflineRankingDirectionMetrics;
}

export interface ResearchOfflineComparisonReport {
  generatedAt: number;
  generatedAtIso: string;
  gpuEnvironment?: {
    torchVersion?: string;
    cudaAvailable?: boolean;
    cudaVersion?: string | null;
    gpuName?: string | null;
    totalVramMb?: number;
  };
  singleCoinVerification?: Record<string, any>;
  lightgbmFullTestMetrics?: Record<string, any>;
  lightgbmValidationMetrics?: Record<string, any>;
  kronosForecastComparison?: {
    samplePairCount: number;
    decisionTimestampCount: number;
    symbolCount: number;
    kronosSmall: {
      modelKey: string;
      repoId?: string;
      revision?: string;
      mae4hReturn: number;
      directionalHitRate: number;
      totalElapsedMs: number;
      avgSampleElapsedMs: number;
      peakVramAllocatedMb: number;
      peakVramReservedMb: number;
    };
    kronosBase: {
      modelKey: string;
      repoId?: string;
      revision?: string;
      mae4hReturn: number;
      directionalHitRate: number;
      totalElapsedMs: number;
      avgSampleElapsedMs: number;
      peakVramAllocatedMb: number;
      peakVramReservedMb: number;
    };
    baselineNoChange: {
      modelKey: string;
      mae4hReturn: number;
      directionalHitRate: number;
    };
    baselineMomentum4h: {
      modelKey: string;
      mae4hReturn: number;
      directionalHitRate: number;
    };
  };
  crossModelRankingComparison?: {
    commonTimestampCount: number;
    commonPairCount: number;
    lightgbm: ResearchOfflineRankingMetrics;
    kronosSmall: ResearchOfflineRankingMetrics;
    kronosBase: ResearchOfflineRankingMetrics;
    baselineMomentum4h: ResearchOfflineRankingMetrics;
  };
  disclaimers?: Record<string, string>;
}

export interface ModelResearchRunResult {
  runId: string;
  status: 'SUCCESS' | 'INSUFFICIENT_DATA' | 'FAILED';
  validityStatus?: ResearchRunValidityStatus;
  isExpired?: boolean;
  market: MarketType;
  kronosModel: KronosModelKey;
  decisionOpenTime?: number;
  cutoffTime: number;
  expiresAt: number;
  generatedAt: number;
  generatedAtIso?: string;
  reason?: string;
  models?: ResearchModelSummary;
  dataset?: ResearchDatasetQuality;
  rankings: {
    longTop5: ResearchRankingEntry[];
    shortTop5: ResearchRankingEntry[];
    allRankings: ResearchRankingEntry[];
    conflictSymbols: string[];
  };
  forecasts: Record<string, KronosSymbolForecast>;
  offlineComparison?: ResearchOfflineComparisonReport | null;
  warnings: string[];
}

export interface ModelResearchJobRecord {
  jobId: string;
  runId: string;
  kronosModel: KronosModelKey;
  status: ResearchJobStatus;
  createdAt: number;
  startedAt: number;
  completedAt?: number;
  errorCode?: string;
  errorMessage?: string;
  result?: ModelResearchRunResult;
}

export interface ModelResearchStatusResponse {
  artifactWarnings?: string[];
  configured: boolean;
  pythonAvailable: boolean;
  pythonExecutable?: string;
  pythonVersion?: string;
  gpuEnvironment?: {
    torchVersion?: string;
    cudaAvailable?: boolean;
    cudaVersion?: string | null;
    gpuName?: string | null;
    totalVramMb?: number;
    allocatedVramMb?: number;
    reservedVramMb?: number;
  };
  datasetReady: boolean;
  datasetVersion?: string | null;
  datasetCutoffTime?: number | null;
  universeSymbols: string[];
  insufficientSymbols: ResearchInsufficientSymbol[];
  lightgbmReady: boolean;
  lightgbmMetadata?: Record<string, any> | null;
  kronosModels: {
    small: {
      modelKey: 'small';
      repoId: string;
      tokenizerRepoId: string;
      installed: boolean;
      revision: string;
      tokenizerRevision: string;
    };
    base: {
      modelKey: 'base';
      repoId: string;
      tokenizerRepoId: string;
      installed: boolean;
      revision: string;
      tokenizerRevision: string;
    };
  };
  offlineComparisonReady: boolean;
  offlineComparison?: ResearchOfflineComparisonReport | null;
  isBusy: boolean;
  activeJob?: ModelResearchJobRecord | null;
  lastJob?: ModelResearchJobRecord | null;
  latestRunSummary?: {
    runId: string;
    kronosModel: KronosModelKey;
    cutoffTime: number;
    expiresAt: number;
    generatedAt: number;
    isExpired: boolean;
    validityStatus: ResearchRunValidityStatus;
  } | null;
  statusReason?: string;
}

export type ModelResearchPanelState = ResearchRunValidityStatus;

export interface ModelResearchLatestResponse {
  result: ModelResearchRunResult | null;
  validityStatus: ResearchRunValidityStatus;
  isExpired?: boolean;
  serverTime: number;
}

export interface DeriveResearchPanelStateInput {
  marketType?: MarketType;
  loadingInitial?: boolean;
  statusData: ModelResearchStatusResponse | null | undefined;
  activeJob?: ModelResearchJobRecord | null;
  latestResult?: ModelResearchRunResult | null;
  selectedKronosModel?: KronosModelKey;
  now?: number;
}

export function isResearchRunExpired(result: Pick<ModelResearchRunResult, 'cutoffTime' | 'expiresAt'>, now = Date.now()): boolean {
  const expiry = Number.isFinite(result.expiresAt) ? result.expiresAt : result.cutoffTime + 3_600_000;
  return now > expiry;
}

export function evaluateResearchValidityStatus(
  result: ModelResearchRunResult | null | undefined,
  now = Date.now(),
): ResearchRunValidityStatus {
  if (!result) return 'EMPTY';
  if (result.status === 'FAILED') return 'FAILED';
  if (result.status === 'INSUFFICIENT_DATA') return 'INSUFFICIENT_DATA';
  if (isResearchRunExpired(result, now)) return 'EXPIRED';
  return 'SUCCESS';
}

export function deriveResearchPanelState(input: DeriveResearchPanelStateInput): ResearchRunValidityStatus {
  const {
    marketType = 'futures',
    loadingInitial = false,
    statusData,
    activeJob = null,
    latestResult = null,
    selectedKronosModel = 'small',
    now = Date.now(),
  } = input;

  if (marketType === 'spot') return 'UNCONFIGURED';
  if (loadingInitial && !statusData) return 'LOADING';
  if (activeJob?.status === 'RUNNING' || statusData?.isBusy) return 'LOADING';
  // configured is an aggregate flag; model/data failures must retain their own states.
  if (!statusData || !statusData.pythonAvailable) return 'UNCONFIGURED';
  if (!statusData.datasetReady) return 'EMPTY';

  const selectedModelInstalled =
    selectedKronosModel === 'base'
      ? statusData.kronosModels?.base?.installed
      : statusData.kronosModels?.small?.installed;

  if (!statusData.lightgbmReady || !selectedModelInstalled) {
    return 'MODEL_MISSING';
  }
  if (!statusData.configured) return 'UNCONFIGURED';

  const candidateJob = activeJob ?? statusData.lastJob ?? null;
  const latestGenAt = latestResult?.generatedAt ?? 0;
  const jobTime = candidateJob?.completedAt ?? candidateJob?.createdAt ?? 0;

  if (candidateJob && (activeJob != null || jobTime >= latestGenAt)) {
    if (candidateJob.status === 'FAILED') {
      if (candidateJob.errorCode === 'MODEL_MISSING' || candidateJob.errorCode === 'MODEL_OR_DATA_MISSING') return 'MODEL_MISSING';
      return 'FAILED';
    }
    if (candidateJob.result?.status === 'INSUFFICIENT_DATA') {
      return 'INSUFFICIENT_DATA';
    }
  }

  if (!latestResult) return 'EMPTY';
  return evaluateResearchValidityStatus(latestResult, now);
}

