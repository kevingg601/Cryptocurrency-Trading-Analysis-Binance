import type { RollingPipelineStatus } from '../research/researchTypes.ts';

export type AccountId = 'A' | 'B';
export type ModelPaperSide = 'LONG' | 'SHORT';
export type ExperimentStatus = 'RUNNING' | 'PAUSED' | 'AWAITING_RESUME' | 'STOPPING' | 'STOPPED';
export type DecisionStatus = 'PENDING' | 'PENDING_RETRY' | 'SUBMITTED' | 'FAILED' | 'SKIPPED';
export type OrderAction = 'ENTRY' | 'EXIT';
export type OrderStatus = 'PENDING' | 'FILLED' | 'CANCELLED';
export type PositionStatus = 'OPEN' | 'CLOSED';
export type OrderReason =
  | 'SIGNAL'
  | 'SIGNAL_GONE'
  | 'REVERSED'
  | 'STOP_LOSS'
  | 'MANUAL_STOP';

export type SkipReason =
  | 'CONFLICT'
  | 'CHRONOS_MISSING'
  | 'DIRECTION_MISMATCH'
  | 'BELOW_THRESHOLD'
  | 'STALE_REFERENCE_PRICE'
  | 'NO_SLOT'
  | 'INSUFFICIENT_CASH'
  | 'SPEC_LIMIT'
  | 'STOPPED_THIS_HOUR'
  | 'BANKRUPT'
  | 'DEGRADED_MARKET';

export interface ModelPaperConfig {
  initialCash: number;
  leverage: number;
  maxPositions: number;
  allocation: number;
  stopPct: number;
  thresholdPct: number;
  feeRate: number;
  slippageRate: number;
  fillDelayMs: number;
  entryTimeoutMs: number;
  staleMs: number;
  retryMs: number;
  deadlineMs: number;
  strategyVersion: 'fwd-v1';
}

export const DEFAULT_MODEL_PAPER_CONFIG: Readonly<ModelPaperConfig> = Object.freeze({
  initialCash: 10_000,
  leverage: 1,
  maxPositions: 3,
  allocation: 0.2,
  stopPct: 0.02,
  thresholdPct: 0.0025,
  feeRate: 0.0005,
  slippageRate: 0.0005,
  fillDelayMs: 250,
  entryTimeoutMs: 60_000,
  staleMs: 5_000,
  retryMs: 30_000,
  deadlineMs: 600_000,
  strategyVersion: 'fwd-v1',
});

export interface HourlyModelVersions {
  lgbmVersionId?: string | null;
  lgbmLongSha256: string;
  lgbmShortSha256: string;
  lgbmTrainedAt?: number | null;
  valNdcg5Long?: number | null;
  valNdcg5Short?: number | null;
  chronosVersionId?: string | null;
  chronosAdapterSha256?: string | null;
  chronosTrainedAt?: number | null;
  valReturnMae?: number | null;
  chronosBaseRevision?: string | null;
}

export interface ModelSource {
  pipelineMode?: 'local-rolling' | 'adapter-run';
  retrainIntervalHours?: number;
  adapterRunId: string;
  adapterRunDir: string;
  attemptDir: string;
  artifactHashes: Record<string, string>;
  adapterSha256Json?: Record<string, string>;
  fingerprint?: string | null;
  baseRepoId: string;
  baseRevision: string;
  baseFiles: Record<string, string>;
  lgbmLongSha256?: string | null;
  lgbmShortSha256?: string | null;
}

export interface AdapterRunSummary {
  runId: string;
  runDir: string;
  attemptDir: string;
  status: string;
  smoke: boolean;
  startedUtc?: string | null;
  finishedUtc?: string | null;
  fingerprint?: string | null;
  baseRepoId: string;
  baseRevision?: string | null;
  artifactHashes: Record<string, string>;
  valid: boolean;
  validationError?: string | null;
  isDefault?: boolean;
}

export interface RankCandidateEntry {
  rank: number;
  symbol: string;
  side: ModelPaperSide;
  closePrice: number;
  rankingScore?: number;
  longScore?: number;
  shortScore?: number;
  longRank?: number;
  shortRank?: number;
  conflict?: boolean;
}

export interface ChronosForecastItem {
  symbol: string;
  lastClose: number;
  predictedClose4h: number;
  predictedPath: number[];
}

export interface ReferencePriceQuote {
  symbol: string;
  price: number;
  tradeTime: number;
  receivedAt: number;
  aggId?: number;
}

export interface CandidatePoolItem {
  symbol: string;
  side: ModelPaperSide;
  sideRank: number;
  closePrice1h: number;
}

export interface DecisionInputSnapshot {
  longTop5: RankCandidateEntry[];
  shortTop5: RankCandidateEntry[];
  conflictSymbols: string[];
  forecasts: Record<string, ChronosForecastItem | undefined>;
  referencePrices: Record<string, ReferencePriceQuote | null | undefined>;
  decisionOpenTime: number;
  targetCutoffTime: number;
  now: number;
  config?: ModelPaperConfig;
}

export interface DecisionSnapshot extends DecisionInputSnapshot {
  decisionId: string;
  experimentId: string;
  modelKey: string;
  submittedAt: number;
  inputMode: 'live';
  snapshotHash?: string;
}

export interface Signal {
  symbol: string;
  side: ModelPaperSide;
  sideRank: number;
  refPrice: number;
  closePrice1h: number;
  predictedClose4h?: number;
  dirRet?: number;
}

export interface SkippedSignalRecord {
  account: AccountId;
  symbol: string;
  side: ModelPaperSide;
  sideRank?: number;
  reason: SkipReason;
  detail?: string;
  dirRet?: number;
  refPrice?: number;
  predictedClose4h?: number;
}

export interface SignalsBuildResult {
  pool: CandidatePoolItem[];
  signalsA: Signal[];
  signalsB: Signal[];
  skippedA: SkippedSignalRecord[];
  skippedB: SkippedSignalRecord[];
}

export interface PaperAccountState {
  experimentId: string;
  account: AccountId;
  cash: number;
  reserved: number;
  realizedPnl: number;
  fees: number;
  funding: number;
  bankrupt: boolean;
  degraded: boolean;
  fundingPending: boolean;
  stoppedThisHour: string[];
  updatedAt: number;
}

export interface PaperOrder {
  id: string;
  experimentId: string;
  account: AccountId;
  decisionId: string;
  symbol: string;
  side: ModelPaperSide;
  action: OrderAction;
  reason: string;
  qty: number;
  refPrice: number;
  createdAt: number;
  status: OrderStatus;
  cancelReason?: string | null;
  positionId?: string | null;
}

export interface PaperFill {
  orderId: string;
  experimentId: string;
  account: AccountId;
  symbol: string;
  action?: OrderAction;
  aggId: number;
  tradeTime: number;
  receivedAt: number;
  rawPrice: number;
  fillPrice: number;
  qty: number;
  fee: number;
  slippageCost: number;
  realizedPnl: number;
  positionId: string;
}

export interface PaperPosition {
  id: string;
  experimentId: string;
  account: AccountId;
  symbol: string;
  side: ModelPaperSide;
  qty: number;
  entryPrice: number;
  stopPrice: number;
  openedAt: number;
  openedDecisionHour: number;
  closedAt?: number | null;
  exitPrice?: number | null;
  exitReason?: string | null;
  status: PositionStatus;
}

export interface FundingCharge {
  settlementId: string;
  experimentId: string;
  account: AccountId;
  positionId: string;
  symbol: string;
  fundingTime: number;
  rate: number;
  markPrice: number;
  qty: number;
  amount: number;
  duringGap: boolean;
}

export interface EquityPoint {
  experimentId: string;
  account: AccountId;
  ts: number;
  equity: number;
  cash: number;
  reserved: number;
  unrealized: number;
  complete: boolean;
}

export interface ModelPaperGap {
  id: string;
  experimentId: string;
  account: AccountId | 'BOTH';
  kind: string;
  startedAt: number;
  endedAt?: number | null;
  detail?: string | null;
}

export interface ModelPaperDecisionRecord {
  id: string;
  experimentId: string;
  modelKey: string;
  decisionHour: number;
  status: DecisionStatus;
  attempts: number;
  reason?: string | null;
  snapshotPath?: string | null;
  snapshotHash?: string | null;
  modelVersions?: HourlyModelVersions | null;
  signals?: {
    pool?: CandidatePoolItem[];
    signalsA: Signal[];
    signalsB: Signal[];
    skippedA: SkippedSignalRecord[];
    skippedB: SkippedSignalRecord[];
    longTop5?: RankCandidateEntry[];
    shortTop5?: RankCandidateEntry[];
    conflictSymbols?: string[];
    forecasts?: Record<string, ChronosForecastItem>;
    modelVersions?: HourlyModelVersions | null;
  } | null;
  createdAt: number;
  submittedAt?: number | null;
}

export interface ModelPaperExperimentRecord {
  id: string;
  createdAt: number;
  status: ExperimentStatus;
  config: ModelPaperConfig;
  modelKey: string;
  modelSource: ModelSource;
  universe: string[];
  startedAt: number;
  stoppedAt?: number | null;
  heartbeatAt: number;
  statusReason?: string | null;
}

export interface AccountMetrics {
  account: AccountId;
  equity: number;
  cash: number;
  reserved: number;
  unrealizedPnl: number;
  realizedPnl: number;
  netRealizedPnl: number;
  netReturn: number;
  netReturnPct: number;
  fees: number;
  slippageCost: number;
  funding: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  completedTrades: number;
  winRatePct: number | null;
  avgNetPnl: number | null;
  profitFactor: number | null;
  avgHoldDurationMs: number | null;
  currentExposurePct: number;
  avgExposurePct: number;
  skipReasonCounts: Partial<Record<SkipReason, number>>;
  executionFailureCount: number;
  effectiveObservationMs: number;
  gapDurationMs: number;
  gapCount: number;
  bankrupt: boolean;
  degraded: boolean;
  fundingPending: boolean;
}

export interface ExperimentComparability {
  comparable: boolean;
  reasons: string[];
}

export interface ModelPaperAccountDetail {
  state: PaperAccountState;
  openPositions: PaperPosition[];
  closedPositions: PaperPosition[];
  pendingOrders: PaperOrder[];
  recentOrders: PaperOrder[];
  fills: PaperFill[];
  fundingCharges: FundingCharge[];
  equityCurve: EquityPoint[];
  metrics: AccountMetrics;
  lastPrices: Record<string, number>;
}

export interface ModelPaperAdaptersResponse {
  pipelineMode?: 'local-rolling' | 'adapter-run';
  runsRoot: string;
  defaultRunDir: string | null;
  adapters: AdapterRunSummary[];
  available?: boolean;
  availabilityReason?: string | null;
  rollingPipeline?: RollingPipelineStatus | null;
}

export interface ModelPaperExperimentListItem {
  experiment: ModelPaperExperimentRecord;
  equityA: number;
  equityB: number;
  returnPctA: number;
  returnPctB: number;
  comparable: boolean;
}

export interface ModelPaperExperimentDetail {
  experiment: ModelPaperExperimentRecord;
  accounts: {
    A: ModelPaperAccountDetail;
    B: ModelPaperAccountDetail;
  };
  decisions: ModelPaperDecisionRecord[];
  gaps: ModelPaperGap[];
  comparability: ExperimentComparability;
  nextScheduleAt: number | null;
  available: boolean;
  availabilityReason?: string | null;
  rollingPipeline?: RollingPipelineStatus | null;
}
