import type { AIAnalysisResult, AIDecisionReason, AIDirection } from '../ai/aiTypes.ts';
import type { MarketType } from '../market/types.ts';
import type { ResearchInsufficientSymbol, ResearchRankingEntry } from '../research/researchTypes.ts';
import type { AutoTradingConfig, AutoTradingSnapshot, AutoTradingStatus, calculateAutoMetrics } from './autoTrading.ts';

export type FourGroupId = 'A' | 'B' | 'C' | 'D';
export type FourGroupCoinMode = 'auto-lgbm' | 'manual';

export const FOUR_GROUP_IDS: readonly FourGroupId[] = ['A', 'B', 'C', 'D'] as const;

export const MAX_FOUR_GROUP_COINS = 10;
export const LGBM_RANK_TOP_K = 3;
export const FOUR_GROUP_ONE_HOUR_MS = 3_600_000;
export const FOUR_GROUP_D_MIN_AI_CONFIDENCE = 60;
export const FOUR_GROUP_D_STOP_LOSS_PCT = 0.02;
export const FOUR_GROUP_D_TRAILING_ACTIVATE_PCT = 0.02;
export const FOUR_GROUP_D_TRAILING_PULLBACK_PCT = 0.015;
export const FOUR_GROUP_D_BREAKEVEN_BUFFER_PCT = 0.002;
export const FOUR_GROUP_D_RANK_GRACE_MS = 10 * 60_000;
export const DEFAULT_FOUR_GROUP_OLLAMA_URL = 'http://127.0.0.1:11434';
export const DEFAULT_FOUR_GROUP_LGBM_POLICY = 'lgbm-top3-v1';
export const DEFAULT_FOUR_GROUP_PROMPT_VERSION = 'prompt-v1';
export const DEFAULT_FOUR_GROUP_RULE_VERSION = 'rule-v1';

export const FOUR_GROUP_SPEC: Record<FourGroupId, {
  id: FourGroupId;
  label: string;
  description: string;
  requiresLgbm: boolean;
  requiresAi: boolean;
}> = {
  A: {
    id: 'A',
    label: '規則基準',
    description: '純保守跟單規則基準（無 LightGBM、無 AI 過濾）',
    requiresLgbm: false,
    requiresAi: false,
  },
  B: {
    id: 'B',
    label: '規則＋AI',
    description: '保守跟單規則 + Ollama AI 方向過濾',
    requiresLgbm: false,
    requiresAi: true,
  },
  C: {
    id: 'C',
    label: '規則＋LightGBM',
    description: '保守跟單規則 + LightGBM 全市場 Top 3 排名過濾',
    requiresLgbm: true,
    requiresAi: false,
  },
  D: {
    id: 'D',
    label: 'LightGBM＋AI (獨立)',
    description: '獨立模型策略（脫離 5 秒跟進規則）：LightGBM Top 3＋Ollama AI 同向且信心 ≥ 60 直接進場；-2% 止損、+2% 啟動 1.5% 移動止盈、掉出 Top 3 或 AI 轉向平倉',
    requiresLgbm: true,
    requiresAi: true,
  },
};

export type LightgbmGateReason =
  | 'ALLOWED'
  | 'NO_RANKING'
  | 'RANKING_FAILED'
  | 'FUTURE_RANKING'
  | 'STALE_RANKING'
  | 'EXPIRED_RANKING'
  | 'COIN_UNIVERSE_MISMATCH'
  | 'INSUFFICIENT_DATA'
  | 'CONFLICT'
  | 'NOT_IN_TOP3';

export type FourGroupAiGateReason = AIDecisionReason | 'ALLOWED' | 'NO_ANALYSIS' | 'FAILED' | 'LOW_CONFIDENCE';

export interface LightgbmTrainAudit {
  startedAt: number;
  finishedAt: number;
  elapsedMs: number;
  cpuPercent?: number | null;
  rssMb?: number | null;
  peakRssMb?: number | null;
  retrained: boolean;
  dedupedSameCutoff?: boolean;
}

export interface LightgbmRankSnapshot {
  snapshotId: string;
  status: 'SUCCESS' | 'INSUFFICIENT_DATA' | 'FAILED';
  decisionOpenTime: number;
  cutoffTime: number;
  generatedAt: number;
  publishedAt: number;
  expiresAt: number;
  versionId?: string | null;
  longSha256?: string | null;
  shortSha256?: string | null;
  trainedAt?: number | null;
  universeSymbols: string[];
  eligibleCount?: number;
  insufficientSymbols?: ResearchInsufficientSymbol[];
  longTop5: ResearchRankingEntry[];
  shortTop5: ResearchRankingEntry[];
  allRankings?: ResearchRankingEntry[];
  conflictSymbols: string[];
  reason?: string | null;
  trainAudit?: LightgbmTrainAudit | null;
}

export interface FourGroupLgbmGateEvaluation {
  allowed: boolean;
  reason: LightgbmGateReason;
  explanation: string;
  snapshotId: string | null;
  cutoffTime: number | null;
  publishedAt: number | null;
  generatedAt: number | null;
  versionId: string | null;
  longSha256: string | null;
  shortSha256: string | null;
  sideRank: number | null;
  longRank: number | null;
  shortRank: number | null;
  sideScore: number | null;
  conflict: boolean;
}

export interface FourGroupAiGateEvaluation {
  allowed: boolean;
  reason: FourGroupAiGateReason;
  explanation: string;
  analysisId: string | null;
  snapshotId: string | null;
  snapshotHash: string | null;
  snapshotCreatedAt: number | null;
  generatedAt: number | null;
  availableAt: number | null;
  expiresAt: number | null;
  model: string | null;
  promptVersion: string | null;
  ruleVersion: string | null;
  direction: AIDirection | null;
  confidence: number | null;
  degraded: boolean;
  missingData: string[];
}

export interface FourGroupGroupDecision {
  allowed: boolean;
  reason: string;
  explanation: string;
}

export interface FourGroupSignalDecision {
  id: string;
  planId: string;
  signalSource?: 'follow-rule' | 'lgbm-ai-direct';
  symbol: string;
  side: 'LONG' | 'SHORT';
  confirmedAt: number;
  receivedAt: number;
  lgbm: FourGroupLgbmGateEvaluation;
  ai: FourGroupAiGateEvaluation;
  groups: Record<FourGroupId, FourGroupGroupDecision>;
}

export interface FourGroupLockedSettings {
  ollamaUrl: string;
  isRemoteOllama: boolean;
  model: string;
  promptVersion: string;
  ruleVersion: string;
  lgbmPolicyVersion: string;
  topK: number;
  aiTtlMs: number;
  coinMode?: FourGroupCoinMode;
  selectedCoins: string[];
  universeSymbols: string[];
}

export interface FourGroupCoinRotation {
  cutoffTime: number;
  snapshotId: string;
  updatedAt: number;
  coins: string[];
}

export interface FourGroupTradingBatch {
  schemaVersion: 1;
  strategyVersion: 'four-group-futures-v1';
  id: string;
  marketType: 'futures';
  status: AutoTradingStatus;
  revision: number;
  startedAt: number;
  endedAt?: number;
  reason?: string;
  config: AutoTradingConfig;
  locked: FourGroupLockedSettings;
  activeCoins?: string[];
  coinRotations?: FourGroupCoinRotation[];
  accounts: Record<FourGroupId, AutoTradingSnapshot>;
  decisions: FourGroupSignalDecision[];
}

export interface FourGroupStartParams {
  config: AutoTradingConfig;
  coinMode?: FourGroupCoinMode;
  selectedCoins?: string[];
  universeSymbols: string[];
  ollamaUrl?: string;
  model: string;
  promptVersion?: string;
  ruleVersion?: string;
  lgbmPolicyVersion?: string;
  aiTtlMs?: number;
  now?: number;
  signalSettings?: Record<string, number>;
}

export interface FourGroupAccountMetricsSummary {
  id: FourGroupId;
  label: string;
  metrics: ReturnType<typeof calculateAutoMetrics>;
  fundingStatus: AutoTradingSnapshot['fundingStatus'];
  incompletePositions: number;
  openPositionCount: number;
  pendingOrderCount: number;
  closedTradeCount: number;
  allowedSignals: number;
  rejectedSignals: number;
  executedSignals: number;
}

export interface FourGroupBlockedCounterfactual {
  planId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  confirmedAt: number;
  executedInA: boolean;
  blockedInGroups: FourGroupId[];
  tradeNetPnlInA?: number;
  tradeWinInA?: boolean;
  aiDirection?: AIDirection | null;
  aiReason: FourGroupAiGateReason;
  lgbmReason: LightgbmGateReason;
  sideRank?: number | null;
}

export interface FourGroupComparisonMetrics {
  commonCutoff: number | null;
  pairCostStatus: 'SETTLED' | 'PROVISIONAL';
  accounts: Record<FourGroupId, FourGroupAccountMetricsSummary>;
  signalAudit: {
    totalSignals: number;
    aiCoveredSignals: number;
    aiCoveragePct: number;
    aiAllowedSignals: number;
    aiBlockedReasons: Record<string, number>;
    lgbmCoveredSignals: number;
    lgbmCoveragePct: number;
    lgbmAllowedSignals: number;
    lgbmBlockedReasons: Record<string, number>;
  };
  blockedCounterfactuals: FourGroupBlockedCounterfactual[];
}

export type ExtendedAIAnalysisInput = AIAnalysisResult & {
  snapshotCreatedAt?: number;
  status?: 'SUCCESS' | 'FAILED';
  failed?: boolean;
};

export interface FourGroupGateAuditHelpers {
  marketType: MarketType;
}
