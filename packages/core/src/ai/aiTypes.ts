import type { MarketType, KlineData } from '../market/types.ts';
import type { AutoTradingConfig, AutoTradingSnapshot } from '../auto/autoTrading.ts';

export type AIDirection = 'LONG' | 'SHORT' | 'NEUTRAL';

export type AIDecisionReason =
  | 'ACCEPTED'
  | 'WAITING'
  | 'FAILED'
  | 'EXPIRED'
  | 'MISMATCH'
  | 'NEUTRAL'
  | 'NO_ANALYSIS'
  | 'NOT_TRACKED'
  | 'DATA_INCOMPLETE';

export interface AIDataSourceHealth {
  status: 'healthy' | 'stale' | 'missing' | 'error';
  lastSuccessAt?: number;
  lastAttemptAt?: number;
  dataAsOf?: number;
  error?: string;
}

export interface AIDataSnapshot {
  schemaVersion: 1;
  id: string; // Includes market, symbol, cutoff and content hash
  symbol: string;
  marketType: MarketType;
  cutoffTime: number; // Cutoff timestamp for snapshot data
  validUntil: number; // cutoffTime + 20 minutes (20 * 60 * 1000)
  createdAt: number;
  hash: string; // SHA-256 hash of canonical snapshot payload
  essentialDataValid: boolean;
  degraded: boolean;
  missingData: string[];
  sourceHealth?: Record<string, AIDataSourceHealth>;
  sources: {
    market: boolean;
    klines: boolean;
    indicators: boolean;
    openInterest: boolean;
    fundingRate: boolean;
    liquidations: boolean;
    news: boolean;
    onChain: boolean;
  };
  market: {
    price: number;
    priceChangePercent: number;
    volume: number;
    quoteVolume: number;
    high: number;
    low: number;
    open: number;
    priceTimestamp?: number;
  };
  klines: KlineData[];
  indicators: {
    sma20?: number;
    ema20?: number;
    rsi14?: number;
    macd?: { macd: number; signal: number; histogram: number };
    bollinger?: { upper: number; middle: number; lower: number };
  };
  derivatives: {
    openInterest: number | null;
    fundingRate: number | null;
    liquidations: Array<{
      price: number;
      quantity: number;
      side: 'buy' | 'sell';
      timestamp: number;
    }>;
  };
  news: Array<{
    id: string;
    title: string;
    summary: string;
    link: string;
    source: string;
    publishedAt: number;
    receivedAt: number;
  }>;
  onChain: {
    asset: string;
    activeAddresses?: number;
    txCount?: number;
    date?: string;
    isDaily: true;
    note: string;
  } | null;
}

export interface AIAnalysisResult {
  schemaVersion: 1;
  id: string; // Includes market, symbol, generation time and unique suffix
  snapshotId: string;
  snapshotHash: string;
  symbol: string;
  marketType: MarketType;
  model: string;
  promptVersion: string;
  ruleVersion: string;
  generatedAt: number;
  expiresAt: number; // Valid for 20 minutes from snapshot cutoffTime
  direction: AIDirection;
  confidence: number; // 0 - 100
  reasoning: string;
  bullishEvidence: string[];
  bearishEvidence: string[];
  risks: string[];
  missingData: string[];
  degraded: boolean;
}

export interface AIEntryDecision {
  id: string;
  batchId: string;
  planId: string;
  symbol: string;
  marketType: MarketType;
  account: 'A' | 'B';
  allowed: boolean;
  analysisAvailable?: boolean;
  reason: AIDecisionReason;
  analysisId?: string;
  snapshotId?: string;
  model?: string;
  expiresAt?: number;
  timestamp: number;
  confirmedSide: 'LONG' | 'SHORT';
  analysisDirection?: AIDirection;
  explanation: string;
}

export interface ABComparisonMetrics {
  durationMs: number;
  accountA: {
    equity: number;
    returnPct: number;
    realizedPnl: number;
    unrealizedPnl: number;
    fees: number;
    funding: number;
    maxDrawdownPct: number;
    completedTrades: number;
    winRate: number | null;
    profitFactor: number | null;
  };
  accountB: {
    equity: number;
    returnPct: number;
    realizedPnl: number;
    unrealizedPnl: number;
    fees: number;
    funding: number;
    maxDrawdownPct: number;
    completedTrades: number;
    winRate: number | null;
    profitFactor: number | null;
  };
  performanceDelta: {
    returnPctDelta: number; // B - A
    equityDelta: number; // B - A
    drawdownReductionPct: number; // A maxDrawdown - B maxDrawdown
    costSavings: number; // (A fees+funding) - (B fees+funding)
    tradeCountDelta: number; // B completedTrades - A completedTrades
  };
  aiCoverage: {
    totalSignals: number;
    allowedSignals: number;
    blockedSignals: number;
    coveragePct: number; // % of signals where AI analysis was available & unexpired
    skipReasons: Record<AIDecisionReason, number>;
  };
  blockedSignalsInA: Array<{
    planId: string;
    symbol: string;
    side: 'LONG' | 'SHORT';
    confirmedAt: number;
    decisionReason: AIDecisionReason;
    tradeNetPnlInA?: number;
    tradeWinInA?: boolean;
    executedInA: boolean;
  }>;
}

export interface ABTradingBatch {
  schemaVersion: 1;
  id: string;
  marketType: MarketType;
  status: 'IDLE' | 'RUNNING' | 'PAUSED' | 'DRAINING' | 'COMPLETED' | 'INTERRUPTED';
  startedAt: number;
  endedAt?: number;
  reason?: string;
  config: AutoTradingConfig;
  selectedCoins: string[]; // Fixed at start, up to 10
  model: string; // Locked during batch
  promptVersion: string;
  ruleVersion: string;
  revision: number;
  accountA: AutoTradingSnapshot;
  accountB: AutoTradingSnapshot;
  decisions: AIEntryDecision[];
  writerToken?: string;
  ownerGeneration?: number;
  leaseExpiresAt?: number;
}
