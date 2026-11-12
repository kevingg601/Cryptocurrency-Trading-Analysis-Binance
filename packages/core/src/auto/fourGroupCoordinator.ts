import type { FollowPlan } from '../follow/followPlans.ts';
import type { MarketTradeFrame } from '../market/marketEvents.ts';
import { SNAPSHOT_VALIDITY_MS } from '../ai/aiSnapshot.ts';
import { cloneWithInfinity } from '../ai/abSerialization.ts';
import type { ResearchRankingEntry } from '../research/researchTypes.ts';
import {
  AutoTradingEngine,
  calculateAutoMetrics,
  isAutoTradingActive,
  type AutoTradingConfig,
  type AutoTradingNotification,
  type AutoTradingStatus,
} from './autoTrading.ts';
import type { AutoFundingRecord, AutoSymbolRules } from './autoTradingMarket.ts';
import {
  DEFAULT_FOUR_GROUP_LGBM_POLICY,
  DEFAULT_FOUR_GROUP_OLLAMA_URL,
  DEFAULT_FOUR_GROUP_PROMPT_VERSION,
  DEFAULT_FOUR_GROUP_RULE_VERSION,
  FOUR_GROUP_D_MIN_AI_CONFIDENCE,
  FOUR_GROUP_D_RANK_GRACE_MS,
  FOUR_GROUP_D_STOP_LOSS_PCT,
  FOUR_GROUP_IDS,
  FOUR_GROUP_ONE_HOUR_MS,
  FOUR_GROUP_SPEC,
  LGBM_RANK_TOP_K,
  MAX_FOUR_GROUP_COINS,
  type ExtendedAIAnalysisInput,
  type FourGroupAccountMetricsSummary,
  type FourGroupAiGateEvaluation,
  type FourGroupBlockedCounterfactual,
  type FourGroupCoinMode,
  type FourGroupCoinRotation,
  type FourGroupComparisonMetrics,
  type FourGroupId,
  type FourGroupLgbmGateEvaluation,
  type FourGroupLockedSettings,
  type FourGroupSignalDecision,
  type FourGroupStartParams,
  type FourGroupTradingBatch,
  type LightgbmRankSnapshot,
} from './fourGroupTypes.ts';

let coordinatorSeq = 0;

function nextBatchId(now: number): string {
  coordinatorSeq += 1;
  return `four-${now}-${coordinatorSeq}`;
}

export function sanitizeOllamaUrl(rawUrl?: string): string {
  const input = (rawUrl ?? DEFAULT_FOUR_GROUP_OLLAMA_URL).trim();
  if (!input) {
    throw new Error('Ollama 連線位址不可為空');
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('Ollama 連線位址格式無效');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Ollama 連線位址僅支援 http 或 https 協定');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Ollama URL 不得包含帳號、密碼或憑證資訊');
  }
  if (parsed.search || parsed.hash) {
    // Strip query string / hash so no token parameter can leak into persisted logs.
    parsed.search = '';
    parsed.hash = '';
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${cleanPath}`;
}

export function isRemoteOllamaUrl(urlInput: string): boolean {
  const parsed = new URL(sanitizeOllamaUrl(urlInput));
  const host = parsed.hostname.toLowerCase();
  return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && host !== '[::1]';
}

export function normalizeCoinSymbols(coins: string[]): string[] {
  if (!Array.isArray(coins)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of coins) {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error('追蹤幣種清單包含空白或無效項目');
    }
    const sym = raw.trim().toUpperCase();
    if (!seen.has(sym)) {
      seen.add(sym);
      out.push(sym);
    }
  }
  return out;
}

export function validateFourGroupCoinSelection(
  selectedCoinsRaw: string[],
  universeSymbolsRaw: string[],
): {
  selectedCoins: string[];
  universeSymbols: string[];
  invalidCoins: string[];
} {
  const selectedCoins = normalizeCoinSymbols(selectedCoinsRaw);
  const universeSymbols = normalizeCoinSymbols(universeSymbolsRaw);
  if (!selectedCoins.length) {
    throw new Error('請至少選擇 1 個追蹤幣種');
  }
  if (selectedCoins.length > MAX_FOUR_GROUP_COINS) {
    throw new Error(`追蹤幣種數量不可超過 ${MAX_FOUR_GROUP_COINS} 檔（目前 ${selectedCoins.length} 檔）`);
  }
  if (universeSymbols.length !== 20) {
    throw new Error('LightGBM 固定研究幣池必須包含完整 20 檔，無法啟動四組策略比較');
  }
  const universeSet = new Set(universeSymbols);
  const invalidCoins = selectedCoins.filter(c => !universeSet.has(c));
  if (invalidCoins.length > 0) {
    throw new Error(
      `以下選定追蹤幣種不在 LightGBM 研究名單內，禁止混用未驗證幣種：${invalidCoins.join(', ')}`,
    );
  }
  return { selectedCoins, universeSymbols, invalidCoins };
}

/**
 * Derive up to `MAX_FOUR_GROUP_COINS` (10) unique symbols from the latest LightGBM
 * ranking snapshot in rank priority order (`L1, S1, L2, S2, ..., L5, S5`),
 * constrained strictly to the validated 20-coin research universe.
 */
export function selectDynamicCoinsFromLgbmSnapshot(
  snapshot: LightgbmRankSnapshot | null,
  universeSymbolsRaw: string[],
  maxCoins = MAX_FOUR_GROUP_COINS,
): string[] {
  if (!snapshot || snapshot.status !== 'SUCCESS') return [];
  const limit = Math.max(1, Math.min(Math.trunc(maxCoins) || MAX_FOUR_GROUP_COINS, MAX_FOUR_GROUP_COINS));
  const universeSet = new Set(normalizeCoinSymbols(universeSymbolsRaw));
  const seen = new Set<string>();
  const out: string[] = [];
  const maxRankLen = Math.max(snapshot.longTop5?.length ?? 0, snapshot.shortTop5?.length ?? 0);

  for (let i = 0; i < maxRankLen && out.length < limit; i++) {
    const candidates = [snapshot.longTop5?.[i]?.symbol, snapshot.shortTop5?.[i]?.symbol];
    for (const rawSym of candidates) {
      if (out.length >= limit) break;
      const sym = typeof rawSym === 'string' ? rawSym.trim().toUpperCase() : '';
      if (!sym || !universeSet.has(sym) || seen.has(sym)) continue;
      seen.add(sym);
      out.push(sym);
    }
  }
  return out;
}

function escapeCsvCell(val: unknown): string {
  if (val === null || val === undefined) return '';
  let str = String(val);
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

interface StoredAnalysisEntry {
  analysis: ExtendedAIAnalysisInput;
  availableAt: number;
}

function findEntryRank(entries: ResearchRankingEntry[], symbol: string): { rank: number | null; entry: ResearchRankingEntry | null } {
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.symbol?.trim().toUpperCase() === symbol) {
      const rank = e.rank === undefined ? i + 1 : e.rank;
      return { rank, entry: e };
    }
  }
  return { rank: null, entry: null };
}

export function evaluateLightgbmGate(params: {
  symbol: string;
  side: 'LONG' | 'SHORT';
  confirmedAt: number;
  snapshot: LightgbmRankSnapshot | null;
  lockedUniverse: string[];
  topK?: number;
}): FourGroupLgbmGateEvaluation {
  const topK = params.topK ?? LGBM_RANK_TOP_K;
  const sym = params.symbol.trim().toUpperCase();
  const snap = params.snapshot;
  const baseAudit = {
    snapshotId: snap?.snapshotId ?? null,
    cutoffTime: snap?.cutoffTime ?? null,
    publishedAt: snap?.publishedAt ?? null,
    generatedAt: snap?.generatedAt ?? null,
    versionId: snap?.versionId ?? null,
    longSha256: snap?.longSha256 ?? null,
    shortSha256: snap?.shortSha256 ?? null,
  };

  if (!snap) {
    return {
      ...baseAudit,
      allowed: false,
      reason: 'NO_RANKING',
      explanation: '尚未發布本小時 LightGBM 排名快照，C/D 組不入場',
      sideRank: null,
      longRank: null,
      shortRank: null,
      sideScore: null,
      conflict: false,
    };
  }

  if (snap.status !== 'SUCCESS') {
    return {
      ...baseAudit,
      allowed: false,
      reason: 'RANKING_FAILED',
      explanation: snap.reason || `LightGBM 排名狀態為 ${snap.status}，C/D 組不入場`,
      sideRank: null,
      longRank: null,
      shortRank: null,
      sideScore: null,
      conflict: false,
    };
  }

  if (
    !Number.isFinite(params.confirmedAt)
    || !Number.isFinite(snap.publishedAt)
    || !Number.isFinite(snap.generatedAt)
    || snap.publishedAt > params.confirmedAt
    || snap.generatedAt > params.confirmedAt
  ) {
    return {
      ...baseAudit,
      allowed: false,
      reason: 'FUTURE_RANKING',
      explanation: 'LightGBM 排名完成或發布時間晚於訊號確認時間，禁止未來引用',
      sideRank: null,
      longRank: null,
      shortRank: null,
      sideScore: null,
      conflict: false,
    };
  }

  if (!Number.isFinite(snap.cutoffTime) || !Number.isFinite(snap.expiresAt) || params.confirmedAt >= snap.expiresAt) {
    return {
      ...baseAudit,
      allowed: false,
      reason: 'EXPIRED_RANKING',
      explanation: 'LightGBM 排名快照已逾期，不可延用舊小時排名',
      sideRank: null,
      longRank: null,
      shortRank: null,
      sideScore: null,
      conflict: false,
    };
  }

  const expectedCutoff = Math.floor(params.confirmedAt / FOUR_GROUP_ONE_HOUR_MS) * FOUR_GROUP_ONE_HOUR_MS;
  if (snap.cutoffTime !== expectedCutoff) {
    return {
      ...baseAudit,
      allowed: false,
      reason: 'STALE_RANKING',
      explanation: `LightGBM 排名截斷小時 (${new Date(snap.cutoffTime).toISOString()}) 與當前最新已收盤小時 (${new Date(expectedCutoff).toISOString()}) 不符`,
      sideRank: null,
      longRank: null,
      shortRank: null,
      sideScore: null,
      conflict: false,
    };
  }

  const lockedSet = new Set(params.lockedUniverse.map(s => s.trim().toUpperCase()));
  const snapUniverseSet = new Set((snap.universeSymbols ?? []).map(s => s.trim().toUpperCase()));
  if (!lockedSet.has(sym) || !snapUniverseSet.has(sym)
    || lockedSet.size !== snapUniverseSet.size
    || [...lockedSet].some(symbol => !snapUniverseSet.has(symbol))) {
    return {
      ...baseAudit,
      allowed: false,
      reason: 'COIN_UNIVERSE_MISMATCH',
      explanation: `${sym} 不在當前 LightGBM 研究固定幣池內`,
      sideRank: null,
      longRank: null,
      shortRank: null,
      sideScore: null,
      conflict: false,
    };
  }

  const longTop5Match = findEntryRank(snap.longTop5 ?? [], sym);
  const shortTop5Match = findEntryRank(snap.shortTop5 ?? [], sym);
  const allEntry = (snap.allRankings ?? []).find(e => e.symbol?.trim().toUpperCase() === sym) ?? null;

  const longRank = longTop5Match.rank ?? (typeof allEntry?.longRank === 'number' ? allEntry.longRank : null);
  const shortRank = shortTop5Match.rank ?? (typeof allEntry?.shortRank === 'number' ? allEntry.shortRank : null);
  const sideRank = params.side === 'LONG' ? longRank : shortRank;
  const sideScore = params.side === 'LONG'
    ? (longTop5Match.entry?.longScore ?? longTop5Match.entry?.rankingScore ?? allEntry?.longScore ?? null)
    : (shortTop5Match.entry?.shortScore ?? shortTop5Match.entry?.rankingScore ?? allEntry?.shortScore ?? null);

  const conflictSet = new Set((snap.conflictSymbols ?? []).map(s => s.trim().toUpperCase()));
  const conflict = conflictSet.has(sym)
    || Boolean(allEntry?.conflict)
    || Boolean(longTop5Match.entry?.conflict)
    || Boolean(shortTop5Match.entry?.conflict)
    || (longTop5Match.rank !== null && shortTop5Match.rank !== null);

  const insufficientSet = new Set((snap.insufficientSymbols ?? []).map(item => item.symbol?.trim().toUpperCase()));
  const missingFromAll = Array.isArray(snap.allRankings) && snap.allRankings.length > 0 && !allEntry && longRank === null && shortRank === null;
  if (insufficientSet.has(sym) || missingFromAll) {
    return {
      ...baseAudit,
      allowed: false,
      reason: 'INSUFFICIENT_DATA',
      explanation: `${sym} 本小時 LightGBM 特徵或 K 線資料不足`,
      sideRank,
      longRank,
      shortRank,
      sideScore,
      conflict,
    };
  }

  if (conflict) {
    return {
      ...baseAudit,
      allowed: false,
      reason: 'CONFLICT',
      explanation: `${sym} 本小時同時進入多空 Top 5 衝突名單（Long #${longRank ?? '-'} / Short #${shortRank ?? '-'}），拒絕入場`,
      sideRank,
      longRank,
      shortRank,
      sideScore,
      conflict: true,
    };
  }

  if (sideRank === null || !Number.isInteger(sideRank) || sideRank < 1 || sideRank > topK) {
    const rankLabel = sideRank !== null ? `#${sideRank}` : '未入榜';
    return {
      ...baseAudit,
      allowed: false,
      reason: 'NOT_IN_TOP3',
      explanation: `${sym} 在 ${params.side} 排名為 ${rankLabel}，未進入前 ${topK} 名`,
      sideRank,
      longRank,
      shortRank,
      sideScore,
      conflict: false,
    };
  }

  return {
    ...baseAudit,
    allowed: true,
    reason: 'ALLOWED',
    explanation: `${sym} 通過 LightGBM ${params.side} Top ${topK}（排名 #${sideRank}）且無衝突`,
    sideRank,
    longRank,
    shortRank,
    sideScore,
    conflict: false,
  };
}

export function evaluateAiGate(params: {
  symbol: string;
  side: 'LONG' | 'SHORT';
  confirmedAt: number;
  entries: StoredAnalysisEntry[];
  locked: Pick<FourGroupLockedSettings, 'model' | 'promptVersion' | 'ruleVersion' | 'aiTtlMs'>;
}): FourGroupAiGateEvaluation {
  const emptyAudit = {
    analysisId: null,
    snapshotId: null,
    snapshotHash: null,
    snapshotCreatedAt: null,
    generatedAt: null,
    availableAt: null,
    expiresAt: null,
    model: null,
    promptVersion: null,
    ruleVersion: null,
    direction: null,
    confidence: null,
    degraded: false,
    missingData: [] as string[],
  };

  if (!params.entries.length) {
    return {
      ...emptyAudit,
      allowed: false,
      reason: 'NO_ANALYSIS',
      explanation: '尚未產生此幣種之 Ollama / AI 分析結果',
    };
  }

  // Strictly select the latest result created AND available at or before confirmedAt (zero lookahead).
  let selected: StoredAnalysisEntry | null = null;
  for (let i = params.entries.length - 1; i >= 0; i--) {
    const item = params.entries[i];
    const snapCreatedAt = item.analysis.snapshotCreatedAt ?? item.analysis.generatedAt;
    if (
      Number.isFinite(params.confirmedAt)
      && Number.isFinite(item.availableAt)
      && Number.isFinite(item.analysis.generatedAt)
      && Number.isFinite(snapCreatedAt)
      && item.availableAt <= params.confirmedAt
      && item.analysis.generatedAt <= params.confirmedAt
      && snapCreatedAt <= params.confirmedAt
    ) {
      selected = item;
      break;
    }
  }

  if (!selected) {
    return {
      ...emptyAudit,
      allowed: false,
      reason: 'WAITING',
      explanation: 'AI 分析尚未於訊號確認前就緒（禁止引用訊號後才產生的未來分析）',
    };
  }

  const a = selected.analysis;
  const snapCreatedAt = a.snapshotCreatedAt ?? a.generatedAt;
  const audit = {
    analysisId: a.id ?? null,
    snapshotId: a.snapshotId ?? null,
    snapshotHash: a.snapshotHash ?? null,
    snapshotCreatedAt: snapCreatedAt ?? null,
    generatedAt: a.generatedAt ?? null,
    availableAt: selected.availableAt,
    expiresAt: Number.isFinite(a.expiresAt) ? a.expiresAt : null,
    model: a.model ?? null,
    promptVersion: a.promptVersion ?? null,
    ruleVersion: a.ruleVersion ?? null,
    direction: a.direction ?? null,
    confidence: Number.isFinite(a.confidence) ? a.confidence : null,
    degraded: Boolean(a.degraded),
    missingData: Array.isArray(a.missingData) ? [...a.missingData] : [],
  };

  if (a.failed === true || a.status === 'FAILED') {
    return {
      ...audit,
      allowed: false,
      reason: 'FAILED',
      explanation: a.reasoning || 'Ollama / AI 推論失敗或逾時',
    };
  }

  if (
    !Number.isFinite(a.expiresAt)
    || params.confirmedAt >= a.expiresAt
    || params.confirmedAt - snapCreatedAt >= Math.min(params.locked.aiTtlMs, SNAPSHOT_VALIDITY_MS)
  ) {
    return {
      ...audit,
      allowed: false,
      reason: 'EXPIRED',
      explanation: 'AI 分析結果已超過 20 分鐘有效期限',
    };
  }

  if (
    !Array.isArray(a.missingData)
    || (a.degraded && a.missingData.length === 0)
    || a.missingData.some(key =>
      key === 'market_price'
      || key === 'klines_sufficient'
      || key === 'indicators_basic'
      || key.startsWith('market_source_')
      || key.startsWith('klines_source_')
      || key.startsWith('indicators_source_'))
  ) {
    return {
      ...audit,
      allowed: false,
      reason: 'DATA_INCOMPLETE',
      explanation: `AI 必要快照資料不完整（${(a.missingData ?? []).join(', ') || 'degraded'}）`,
    };
  }

  if (
    a.symbol !== params.symbol
    || a.marketType !== 'futures'
    || a.model !== params.locked.model
    || a.promptVersion !== params.locked.promptVersion
    || a.ruleVersion !== params.locked.ruleVersion
  ) {
    return {
      ...audit,
      allowed: false,
      reason: 'MISMATCH',
      explanation: `AI 設定版本不符（收到 ${a.model}/${a.promptVersion}/${a.ruleVersion}，鎖定 ${params.locked.model}/${params.locked.promptVersion}/${params.locked.ruleVersion}）`,
    };
  }

  if (a.direction === 'NEUTRAL') {
    return {
      ...audit,
      allowed: false,
      reason: 'NEUTRAL',
      explanation: 'AI 判定為中性觀望（NEUTRAL），不可進場',
    };
  }

  if (a.direction !== params.side) {
    return {
      ...audit,
      allowed: false,
      reason: 'MISMATCH',
      explanation: `AI 方向（${a.direction}）與訊號方向（${params.side}）不一致`,
    };
  }

  return {
    ...audit,
    allowed: true,
    reason: 'ALLOWED',
    explanation: `AI 看法一致（${a.direction}，信心 ${a.confidence}）`,
  };
}

export class FourGroupComparisonCoordinator {
  private readonly marketType = 'futures' as const;
  private batchId = 'idle';
  private status: AutoTradingStatus = 'IDLE';
  private startedAt = 0;
  private endedAt?: number;
  private reason?: string;

  private config: AutoTradingConfig;
  private locked: FourGroupLockedSettings;

  private engines: Record<FourGroupId, AutoTradingEngine>;
  private lgbmSnapshot: LightgbmRankSnapshot | null = null;
  private analysesBySymbol = new Map<string, StoredAnalysisEntry[]>();

  private decisions: FourGroupSignalDecision[] = [];
  private evaluatedPlanIds = new Set<string>();
  private dEvaluatedKeys = new Set<string>();
  private lastTrades = new Map<string, { timestamp: number; id?: number }>();
  private activeCoins: string[] = [];
  private coinRotations: FourGroupCoinRotation[] = [];
  private lastCoinRotationCutoff: number | null = null;
  private lastCoinRotationKey: string | null = null;

  private rules: Record<string, AutoSymbolRules> = {};
  private streamHealthy = false;
  private lastReceivedAt = 0;
  private acceptConfirmationsAfter = 0;
  private sequence = 0;
  revision = 0;

  constructor(marketType: 'futures' = 'futures') {
    if (marketType !== 'futures') {
      throw new Error('四組策略比較首版僅支援 USDT 永續合約（futures）');
    }
    this.config = {
      marketType: 'futures',
      initialCapital: 10_000,
      riskPct: 0.5,
      maxNotionalPct: 20,
      maxPositions: 3,
      feeBps: 5,
      slippageBps: 5,
      latencyMs: 250,
    };
    this.locked = {
      ollamaUrl: DEFAULT_FOUR_GROUP_OLLAMA_URL,
      isRemoteOllama: false,
      model: '',
      promptVersion: DEFAULT_FOUR_GROUP_PROMPT_VERSION,
      ruleVersion: DEFAULT_FOUR_GROUP_RULE_VERSION,
      lgbmPolicyVersion: DEFAULT_FOUR_GROUP_LGBM_POLICY,
      topK: LGBM_RANK_TOP_K,
      aiTtlMs: SNAPSHOT_VALIDITY_MS,
      coinMode: 'auto-lgbm',
      selectedCoins: [],
      universeSymbols: [],
    };
    this.engines = {
      A: new AutoTradingEngine('futures'),
      B: new AutoTradingEngine('futures'),
      C: new AutoTradingEngine('futures'),
      D: new AutoTradingEngine('futures', { executionMode: 'autonomous' }),
    };
  }

  setRules(rules: Record<string, AutoSymbolRules>): void {
    this.rules = structuredClone(rules);
    for (const id of FOUR_GROUP_IDS) {
      this.engines[id].setRules(this.rules);
    }
  }

  setStreamHealthy(healthy: boolean, now: number, interruptedSince?: number): void {
    this.streamHealthy = healthy;
    for (const id of FOUR_GROUP_IDS) {
      this.engines[id].setStreamHealthy(healthy, now, interruptedSince);
    }
    this.checkSyncStatus(now);
  }

  updateLightgbmRanking(snapshot: LightgbmRankSnapshot | null): void {
    this.lgbmSnapshot = snapshot ? structuredClone(snapshot) : null;
    this.rotateCoinsIfAuto();
  }

  private rotateCoinsIfAuto(now?: number): boolean {
    if (!isAutoTradingActive(this.status)) return false;
    if (this.locked.coinMode !== 'auto-lgbm') return false;
    const snap = this.lgbmSnapshot;
    if (!snap || snap.status !== 'SUCCESS') return false;
    if (!Number.isFinite(snap.cutoffTime)) return false;
    if (this.lastCoinRotationCutoff !== null && snap.cutoffTime < this.lastCoinRotationCutoff) {
      return false;
    }
    const rotationKey = `${snap.cutoffTime}:${snap.snapshotId}`;
    if (this.lastCoinRotationKey === rotationKey) return false;

    const derived = selectDynamicCoinsFromLgbmSnapshot(snap, this.locked.universeSymbols);
    const hasRules = Object.keys(this.rules).length > 0;
    const nextCoins = hasRules ? derived.filter(sym => Boolean(this.rules[sym])) : derived;
    if (!nextCoins.length) return false;

    validateFourGroupCoinSelection(nextCoins, this.locked.universeSymbols);
    this.lastCoinRotationCutoff = snap.cutoffTime;
    this.lastCoinRotationKey = rotationKey;

    if (
      nextCoins.length === this.activeCoins.length
      && nextCoins.every((sym, idx) => sym === this.activeCoins[idx])
    ) {
      return false;
    }

    this.activeCoins = nextCoins;
    this.coinRotations.push({
      cutoffTime: snap.cutoffTime,
      snapshotId: snap.snapshotId,
      updatedAt: now ?? snap.generatedAt ?? Date.now(),
      coins: [...nextCoins],
    });
    this.revision += 1;
    return true;
  }

  getLightgbmRanking(): LightgbmRankSnapshot | null {
    return this.lgbmSnapshot ? structuredClone(this.lgbmSnapshot) : null;
  }

  updateAnalysis(result: ExtendedAIAnalysisInput, availableAt = Date.now()): void {
    const rawSym = typeof result?.symbol === 'string' ? result.symbol.trim().toUpperCase() : '';
    if (!rawSym) return;

    const normalized: ExtendedAIAnalysisInput = {
      ...structuredClone(result),
      symbol: rawSym,
      degraded: Boolean(result.degraded) || !Array.isArray(result.missingData),
      missingData: Array.isArray(result.missingData) ? [...result.missingData] : [],
      bullishEvidence: Array.isArray(result.bullishEvidence) ? [...result.bullishEvidence] : [],
      bearishEvidence: Array.isArray(result.bearishEvidence) ? [...result.bearishEvidence] : [],
      risks: Array.isArray(result.risks) ? [...result.risks] : [],
    };

    const existing = this.analysesBySymbol.get(rawSym) ?? [];
    const latest = existing.at(-1);
    // Reject stale regression if older than latest recorded analysis generatedAt
    if (latest && normalized.generatedAt < latest.analysis.generatedAt && availableAt >= latest.availableAt) {
      return;
    }

    const deduped = existing.filter(item => item.analysis.id !== normalized.id);
    deduped.push({ analysis: normalized, availableAt });
    deduped.sort((x, y) => {
      if (x.analysis.generatedAt !== y.analysis.generatedAt) {
        return x.analysis.generatedAt - y.analysis.generatedAt;
      }
      return x.availableAt - y.availableAt;
    });
    if (deduped.length > 24) {
      deduped.splice(0, deduped.length - 24);
    }
    this.analysesBySymbol.set(rawSym, deduped);
  }

  getAnalysis(symbol: string): ExtendedAIAnalysisInput | undefined {
    const sym = symbol.trim().toUpperCase();
    const list = this.analysesBySymbol.get(sym);
    const latest = list?.at(-1);
    return latest ? structuredClone(latest.analysis) : undefined;
  }

  getAllAnalyses(): ExtendedAIAnalysisInput[] {
    const out: ExtendedAIAnalysisInput[] = [];
    for (const list of this.analysesBySymbol.values()) {
      const latest = list.at(-1);
      if (latest) out.push(structuredClone(latest.analysis));
    }
    return out;
  }

  start(params: FourGroupStartParams): void {
    const now = params.now ?? Date.now();
    if (isAutoTradingActive(this.status)) {
      throw new Error('請先結束目前的四組策略評估');
    }
    if (params.config.marketType !== 'futures') {
      throw new Error('四組策略比較首版僅支援 USDT 永續合約（futures）');
    }
    if (!this.streamHealthy) {
      throw new Error('逐筆成交串流尚未就緒');
    }
    if (!Object.keys(this.rules).length) {
      throw new Error('交易規格尚未載入');
    }

    const ollamaUrl = sanitizeOllamaUrl(params.ollamaUrl);
    const model = params.model.trim();
    if (!model) {
      throw new Error('請先指定 Ollama 模型名稱');
    }

    const coinMode: FourGroupCoinMode = params.coinMode
      ?? (params.selectedCoins && params.selectedCoins.length > 0 ? 'manual' : 'auto-lgbm');
    let candidateCoins: string[];
    let seededFromLgbm = false;
    if (coinMode === 'auto-lgbm') {
      const hasRules = Object.keys(this.rules).length > 0;
      const lgbmDerived = selectDynamicCoinsFromLgbmSnapshot(this.lgbmSnapshot, params.universeSymbols);
      const lgbmFiltered = hasRules ? lgbmDerived.filter(sym => Boolean(this.rules[sym])) : lgbmDerived;
      if (lgbmFiltered.length > 0) {
        candidateCoins = lgbmFiltered;
        seededFromLgbm = true;
      } else if (params.selectedCoins && params.selectedCoins.length > 0) {
        candidateCoins = params.selectedCoins;
      } else {
        const normalizedUniverse = normalizeCoinSymbols(params.universeSymbols);
        const ruleMatched = normalizedUniverse.filter(sym => Boolean(this.rules[sym]));
        candidateCoins = (ruleMatched.length > 0 ? ruleMatched : normalizedUniverse).slice(0, MAX_FOUR_GROUP_COINS);
      }
    } else {
      candidateCoins = params.selectedCoins ?? [];
    }

    const { selectedCoins, universeSymbols } = validateFourGroupCoinSelection(
      candidateCoins,
      params.universeSymbols,
    );

    for (const sym of selectedCoins) {
      if (!this.rules[sym]) {
        throw new Error(`選定幣種 ${sym} 缺少合約交易對規格`);
      }
    }

    const nextEngines: Record<FourGroupId, AutoTradingEngine> = {
      A: new AutoTradingEngine('futures'),
      B: new AutoTradingEngine('futures'),
      C: new AutoTradingEngine('futures'),
      D: new AutoTradingEngine('futures', { executionMode: 'autonomous' }),
    };
    for (const id of FOUR_GROUP_IDS) {
      nextEngines[id].setRules(this.rules);
      nextEngines[id].setStreamHealthy(this.streamHealthy, now);
      nextEngines[id].start(params.config, now, params.signalSettings);
    }

    this.engines = nextEngines;
    this.batchId = nextBatchId(now);
    this.status = 'RUNNING';
    this.startedAt = now;
    this.endedAt = undefined;
    this.reason = undefined;
    this.config = structuredClone(params.config);
    this.locked = {
      ollamaUrl,
      isRemoteOllama: isRemoteOllamaUrl(ollamaUrl),
      model,
      promptVersion: (params.promptVersion ?? DEFAULT_FOUR_GROUP_PROMPT_VERSION).trim() || DEFAULT_FOUR_GROUP_PROMPT_VERSION,
      ruleVersion: (params.ruleVersion ?? DEFAULT_FOUR_GROUP_RULE_VERSION).trim() || DEFAULT_FOUR_GROUP_RULE_VERSION,
      lgbmPolicyVersion: (params.lgbmPolicyVersion ?? DEFAULT_FOUR_GROUP_LGBM_POLICY).trim() || DEFAULT_FOUR_GROUP_LGBM_POLICY,
      topK: LGBM_RANK_TOP_K,
      aiTtlMs: Number.isFinite(params.aiTtlMs) && params.aiTtlMs! > 0
        ? Math.min(params.aiTtlMs!, SNAPSHOT_VALIDITY_MS) : SNAPSHOT_VALIDITY_MS,
      coinMode,
      selectedCoins,
      universeSymbols,
    };
    this.activeCoins = [...selectedCoins];
    if (seededFromLgbm && this.lgbmSnapshot) {
      this.lastCoinRotationCutoff = this.lgbmSnapshot.cutoffTime;
      this.lastCoinRotationKey = `${this.lgbmSnapshot.cutoffTime}:${this.lgbmSnapshot.snapshotId}`;
      this.coinRotations = [{
        cutoffTime: this.lgbmSnapshot.cutoffTime,
        snapshotId: this.lgbmSnapshot.snapshotId,
        updatedAt: now,
        coins: [...selectedCoins],
      }];
    } else {
      this.lastCoinRotationCutoff = null;
      this.lastCoinRotationKey = null;
      this.coinRotations = [];
    }
    this.decisions = [];
    this.analysesBySymbol.clear();
    this.evaluatedPlanIds.clear();
    this.dEvaluatedKeys.clear();
    this.lastTrades.clear();
    this.lastReceivedAt = 0;
    this.acceptConfirmationsAfter = now;
    this.sequence = 0;
    this.revision += 1;
  }

  pause(now: number): void {
    if (this.status !== 'RUNNING') return;
    this.status = 'PAUSED';
    for (const id of FOUR_GROUP_IDS) {
      this.engines[id].pause(now);
    }
    this.revision += 1;
  }

  resume(now: number): void {
    if (this.status !== 'PAUSED') return;
    if (!this.streamHealthy || FOUR_GROUP_IDS.some(id => this.engines[id].snapshot().status !== 'PAUSED')) {
      return;
    }
    for (const id of FOUR_GROUP_IDS) {
      this.engines[id].resume(now);
    }
    if (FOUR_GROUP_IDS.some(id => this.engines[id].snapshot().status !== 'RUNNING')) {
      for (const id of FOUR_GROUP_IDS) {
        this.engines[id].pause(now);
      }
      return;
    }
    this.acceptConfirmationsAfter = now;
    this.status = 'RUNNING';
    this.rotateCoinsIfAuto(now);
    this.revision += 1;
  }

  drain(now: number): void {
    if (!isAutoTradingActive(this.status)) return;
    this.status = 'DRAINING';
    for (const id of FOUR_GROUP_IDS) {
      this.engines[id].drain(now);
    }
    this.revision += 1;
    this.checkSyncStatus(now);
  }

  closeAll(now: number): void {
    if (!isAutoTradingActive(this.status)) return;
    this.status = 'DRAINING';
    for (const id of FOUR_GROUP_IDS) {
      this.engines[id].closeAll(now);
    }
    this.revision += 1;
    this.checkSyncStatus(now);
  }

  interrupt(now: number, reason: string): void {
    if (!isAutoTradingActive(this.status)) return;
    this.status = 'INTERRUPTED';
    this.endedAt = now;
    this.reason = reason;
    for (const id of FOUR_GROUP_IDS) {
      this.engines[id].interrupt(now, reason);
    }
    this.revision += 1;
  }

  restoreInterrupted(batch: FourGroupTradingBatch, now: number): void {
    if (batch.marketType !== this.marketType) {
      throw new Error('四組策略比較首版僅支援 USDT 永續合約（futures）');
    }
    this.batchId = batch.id;
    this.status = batch.status;
    this.startedAt = batch.startedAt;
    this.endedAt = batch.endedAt;
    this.reason = batch.reason;
    this.config = structuredClone(batch.config);
    const restoredCoinMode: FourGroupCoinMode = batch.locked.coinMode ?? 'manual';
    this.locked = {
      ...structuredClone(batch.locked),
      coinMode: restoredCoinMode,
      ollamaUrl: sanitizeOllamaUrl(batch.locked.ollamaUrl),
    };
    this.coinRotations = structuredClone(batch.coinRotations ?? []);
    const restoredActive = batch.activeCoins?.length
      ? normalizeCoinSymbols(batch.activeCoins)
      : [...this.locked.selectedCoins];
    this.activeCoins = restoredCoinMode === 'auto-lgbm' ? restoredActive : [...this.locked.selectedCoins];
    if (this.coinRotations.length > 0) {
      const lastRot = this.coinRotations[this.coinRotations.length - 1];
      this.lastCoinRotationCutoff = lastRot.cutoffTime;
      this.lastCoinRotationKey = `${lastRot.cutoffTime}:${lastRot.snapshotId}`;
    } else {
      this.lastCoinRotationCutoff = null;
      this.lastCoinRotationKey = null;
    }
    this.decisions = structuredClone(batch.decisions ?? []);
    this.evaluatedPlanIds = new Set(this.decisions.map(d => d.planId));
    this.dEvaluatedKeys.clear();
    this.sequence = this.decisions.length;
    this.revision = batch.revision;

    for (const id of FOUR_GROUP_IDS) {
      const eng = new AutoTradingEngine('futures', { executionMode: id === 'D' ? 'autonomous' : 'follow' });
      eng.restoreInterrupted(cloneWithInfinity(batch.accounts[id]), now);
      this.engines[id] = eng;
    }

    if (isAutoTradingActive(this.status)) {
      this.interrupt(now, '程式重新啟動，前次四組策略評估已中斷');
    }
  }

  applyFunding(records: AutoFundingRecord[], through: number, now: number): void {
    for (const id of FOUR_GROUP_IDS) {
      this.engines[id].applyFunding(records, through, now);
    }
    this.revision += 1;
  }

  fundingFailed(now: number): void {
    for (const id of FOUR_GROUP_IDS) {
      this.engines[id].fundingFailed(now);
    }
    this.revision += 1;
  }

  tick(now: number): void {
    if (!isAutoTradingActive(this.status)) return;
    const prevRevs = FOUR_GROUP_IDS.map(id => this.engines[id].revision);
    for (const id of FOUR_GROUP_IDS) {
      this.engines[id].tick(now);
    }
    this.checkSyncStatus(now);
    if (FOUR_GROUP_IDS.some((id, idx) => this.engines[id].revision !== prevRevs[idx])) {
      this.revision += 1;
    }
  }

  takeNotifications(): AutoTradingNotification[] {
    const out: AutoTradingNotification[] = [];
    for (const id of FOUR_GROUP_IDS) {
      const notes = this.engines[id].takeNotifications();
      for (const note of notes) {
        out.push({
          ...note,
          title: `[${id}:${FOUR_GROUP_SPEC[id].label}] ${note.title}`,
        });
      }
    }
    return out;
  }

  processFrame(frame: MarketTradeFrame): void {
    if (!isAutoTradingActive(this.status)) return;

    const now = frame.receivedAt;
    const { trade } = frame;
    if (
      frame.marketType !== this.marketType
      || !Number.isFinite(now)
      || now < this.lastReceivedAt
      || !Number.isFinite(trade.price)
      || trade.price <= 0
      || !Number.isFinite(trade.timestamp)
      || Math.abs(now - trade.timestamp) > 5_000
    ) {
      return;
    }

    const last = this.lastTrades.get(trade.symbol);
    if (
      last
      && (trade.timestamp < last.timestamp
        || (trade.lastTradeId !== undefined && last.id !== undefined
          ? trade.lastTradeId <= last.id
          : trade.timestamp === last.timestamp))
    ) {
      return;
    }
    this.lastTrades.set(trade.symbol, { timestamp: trade.timestamp, id: trade.lastTradeId });
    this.lastReceivedAt = now;

    const prevRevs = FOUR_GROUP_IDS.map(id => this.engines[id].revision);
    const allowedConfs: Record<FourGroupId, typeof frame.confirmations> = {
      A: [],
      B: [],
      C: [],
      D: [],
    };

    const activeList = this.activeCoins.length > 0 ? this.activeCoins : this.locked.selectedCoins;
    const selectedSet = new Set(activeList);
    const decisionsAdded = this.decisions.length;

    if (this.status === 'RUNNING') {
      for (const item of frame.confirmations) {
        const { event, plan } = item;
        if (event.type !== 'follow-confirmed' || plan.state !== 'CONFIRMED') continue;
        const sym = plan.symbol.trim().toUpperCase();
        if (!selectedSet.has(sym)) continue;
        if (plan.marketType !== 'futures') continue;
        if (sym !== trade.symbol || plan.stale || !Number.isFinite(plan.confirmedAt)
          || plan.confirmedAt! > now || plan.confirmedAt! < this.acceptConfirmationsAfter || now - plan.confirmedAt! > 5_000) {
          continue;
        }
        if (this.evaluatedPlanIds.has(plan.id)) continue;
        this.evaluatedPlanIds.add(plan.id);

        const decision = this.evaluateSignalDecision(plan, sym, now);
        this.decisions.push(decision);

        for (const id of FOUR_GROUP_IDS) {
          if (decision.groups[id].allowed) {
            allowedConfs[id].push(item);
          }
        }
      }

      this.evaluateAutonomousD(trade.symbol.trim().toUpperCase(), trade.price, now, trade.timestamp, trade.lastTradeId, selectedSet);
    }

    for (const id of FOUR_GROUP_IDS) {
      this.engines[id].processFrame({
        ...frame,
        confirmations: id === 'D' ? [] : allowedConfs[id],
      });
    }

    this.checkSyncStatus(now);
    const anyEngineChanged = FOUR_GROUP_IDS.some((id, idx) => this.engines[id].revision !== prevRevs[idx]);
    if (this.decisions.length > decisionsAdded || anyEngineChanged) {
      this.revision += 1;
    }
  }

  private evaluateAutonomousD(
    sym: string,
    price: number,
    now: number,
    tradeTimestamp: number,
    tradeId: number | undefined,
    activeSet: Set<string>,
  ): void {
    const intNow = Math.trunc(now);
    const openPos = this.engines.D.getPositionForSymbol(sym);

    if (openPos) {
      const lgbm = evaluateLightgbmGate({
        symbol: sym,
        side: openPos.side,
        confirmedAt: intNow,
        snapshot: this.lgbmSnapshot,
        lockedUniverse: this.locked.universeSymbols,
        topK: this.locked.topK,
      });
      const lgbmExpiredPastGrace = lgbm.reason === 'EXPIRED_RANKING'
        && (!this.lgbmSnapshot || intNow - this.lgbmSnapshot.expiresAt >= FOUR_GROUP_D_RANK_GRACE_MS);
      const shouldLgbmExit = lgbm.reason === 'NOT_IN_TOP3'
        || lgbm.reason === 'CONFLICT'
        || lgbm.reason === 'COIN_UNIVERSE_MISMATCH'
        || lgbm.reason === 'INSUFFICIENT_DATA'
        || lgbm.reason === 'RANKING_FAILED'
        || lgbm.reason === 'NO_RANKING'
        || lgbmExpiredPastGrace;

      if (shouldLgbmExit) {
        this.engines.D.queueAutonomousExit(sym, 'LGBM_EXIT', intNow, tradeTimestamp);
        return;
      }

      const ai = evaluateAiGate({
        symbol: sym,
        side: openPos.side,
        confirmedAt: intNow,
        entries: this.analysesBySymbol.get(sym) ?? [],
        locked: this.locked,
      });
      const shouldAiExit = ai.reason === 'MISMATCH'
        || ai.reason === 'NEUTRAL'
        || ai.reason === 'EXPIRED'
        || ai.reason === 'FAILED'
        || ai.reason === 'DATA_INCOMPLETE'
        || (ai.allowed && (ai.confidence ?? 0) < FOUR_GROUP_D_MIN_AI_CONFIDENCE);
      if (shouldAiExit) {
        this.engines.D.queueAutonomousExit(sym, 'AI_EXIT', intNow, tradeTimestamp);
      }
      return;
    }

    if (!activeSet.has(sym)) return;
    if (this.engines.D.hasPendingEntry(sym) || this.engines.D.getActiveEntryCount() >= this.config.maxPositions) {
      return;
    }

    const lgbmLong = evaluateLightgbmGate({
      symbol: sym,
      side: 'LONG',
      confirmedAt: intNow,
      snapshot: this.lgbmSnapshot,
      lockedUniverse: this.locked.universeSymbols,
      topK: this.locked.topK,
    });
    const lgbmShort = lgbmLong.allowed
      ? null
      : evaluateLightgbmGate({
          symbol: sym,
          side: 'SHORT',
          confirmedAt: intNow,
          snapshot: this.lgbmSnapshot,
          lockedUniverse: this.locked.universeSymbols,
          topK: this.locked.topK,
        });

    const candidate = lgbmLong.allowed
      ? { side: 'LONG' as const, lgbm: lgbmLong }
      : lgbmShort?.allowed
        ? { side: 'SHORT' as const, lgbm: lgbmShort }
        : null;
    if (!candidate) return;

    const hourCutoff = Math.floor(intNow / FOUR_GROUP_ONE_HOUR_MS) * FOUR_GROUP_ONE_HOUR_MS;
    if (this.engines.D.hasClosedTradeInHour(hourCutoff, sym, candidate.side)) return;

    const rawAi = evaluateAiGate({
      symbol: sym,
      side: candidate.side,
      confirmedAt: intNow,
      entries: this.analysesBySymbol.get(sym) ?? [],
      locked: this.locked,
    });
    const aiConfOk = rawAi.allowed && (rawAi.confidence ?? 0) >= FOUR_GROUP_D_MIN_AI_CONFIDENCE;
    const aiAudit: FourGroupAiGateEvaluation = rawAi.allowed && !aiConfOk
      ? {
          ...rawAi,
          allowed: false,
          reason: 'LOW_CONFIDENCE',
          explanation: `AI 信心度 ${rawAi.confidence ?? '--'} 未達 D 組最低門檻 ${FOUR_GROUP_D_MIN_AI_CONFIDENCE}`,
        }
      : rawAi;

    const evalKey = `${hourCutoff}:${candidate.lgbm.snapshotId ?? 'none'}:${sym}:${candidate.side}:${aiAudit.analysisId ?? 'none'}:${aiAudit.reason}:${aiAudit.confidence ?? 'na'}:${aiConfOk ? 'GO' : 'BLOCK'}`;
    if (this.dEvaluatedKeys.has(evalKey)) return;
    if (this.dEvaluatedKeys.size > 2_000) this.dEvaluatedKeys.clear();
    this.dEvaluatedKeys.add(evalKey);

    this.sequence += 1;
    const planId = `d-auto-${hourCutoff}-${sym}-${candidate.side}-${this.sequence}`;

    if (aiConfOk) {
      const stopLoss = candidate.side === 'LONG'
        ? price * (1 - FOUR_GROUP_D_STOP_LOSS_PCT)
        : price * (1 + FOUR_GROUP_D_STOP_LOSS_PCT);
      this.engines.D.observeAutonomousEntry({
        planId,
        symbol: sym,
        side: candidate.side,
        referencePrice: price,
        stopLoss,
        now: intNow,
        tradeId,
        timestamp: tradeTimestamp,
      });
    }

    const skippedFollowGroup = {
      allowed: false,
      reason: 'D_AUTONOMOUS_ONLY',
      explanation: 'D 組獨立 LightGBM＋AI 策略訊號，A/B/C 不跟隨此類觸發',
    };
    this.decisions.push({
      id: `${this.batchId}-dec-${this.sequence}`,
      planId,
      signalSource: 'lgbm-ai-direct',
      symbol: sym,
      side: candidate.side,
      confirmedAt: intNow,
      receivedAt: intNow,
      lgbm: candidate.lgbm,
      ai: aiAudit,
      groups: {
        A: { ...skippedFollowGroup },
        B: { ...skippedFollowGroup },
        C: { ...skippedFollowGroup },
        D: aiConfOk
          ? {
              allowed: true,
              reason: 'ALLOWED',
              explanation: `D 組獨立策略：LightGBM #${candidate.lgbm.sideRank}＋AI ${aiAudit.direction} (信心 ${aiAudit.confidence})`,
            }
          : {
              allowed: false,
              reason: `AI:${aiAudit.reason}`,
              explanation: aiAudit.explanation,
            },
      },
    });
  }

  private evaluateSignalDecision(plan: FollowPlan, sym: string, receivedAt: number): FourGroupSignalDecision {
    const confirmedAt = Math.trunc(plan.confirmedAt ?? receivedAt);
    const intReceived = Math.max(confirmedAt, Math.trunc(receivedAt));
    const lgbm = evaluateLightgbmGate({
      symbol: sym,
      side: plan.side,
      confirmedAt,
      snapshot: this.lgbmSnapshot,
      lockedUniverse: this.locked.universeSymbols,
      topK: this.locked.topK,
    });
    const ai = evaluateAiGate({
      symbol: sym,
      side: plan.side,
      confirmedAt,
      entries: this.analysesBySymbol.get(sym) ?? [],
      locked: this.locked,
    });

    this.sequence += 1;
    return {
      id: `${this.batchId}-dec-${this.sequence}`,
      planId: plan.id,
      signalSource: 'follow-rule',
      symbol: sym,
      side: plan.side,
      confirmedAt,
      receivedAt: intReceived,
      lgbm,
      ai,
      groups: {
        A: {
          allowed: true,
          reason: 'RULE_ONLY',
          explanation: '規則基準組執行（不套用 LightGBM / AI 過濾）',
        },
        B: {
          allowed: ai.allowed,
          reason: ai.reason,
          explanation: ai.explanation,
        },
        C: {
          allowed: lgbm.allowed,
          reason: lgbm.reason,
          explanation: lgbm.explanation,
        },
        D: {
          allowed: false,
          reason: 'INDEPENDENT_STRATEGY',
          explanation: 'D 組已脫離 5 秒急漲跌跟進規則，改由 LightGBM＋AI 獨立進出',
        },
      },
    };
  }

  private checkSyncStatus(now: number): void {
    if (!isAutoTradingActive(this.status)) return;
    const statuses = FOUR_GROUP_IDS.map(id => this.engines[id].snapshot().status);

    if (statuses.some(s => s === 'INTERRUPTED')) {
      const broken = FOUR_GROUP_IDS.find(id => this.engines[id].snapshot().status === 'INTERRUPTED');
      const reason = (broken ? this.engines[broken].snapshot().reason : undefined) || '四組策略串流或部位異常中斷';
      this.interrupt(now, reason);
      return;
    }

    if (this.status === 'DRAINING' && statuses.every(s => s === 'COMPLETED')) {
      this.status = 'COMPLETED';
      this.endedAt = now;
      this.revision += 1;
    }
  }

  getBatchMeta(): { id: string; status: AutoTradingStatus; revision: number } {
    return {
      id: this.batchId,
      status: this.status,
      revision: this.revision,
    };
  }

  snapshot(): FourGroupTradingBatch {
    return {
      schemaVersion: 1,
      strategyVersion: 'four-group-futures-v1',
      id: this.batchId,
      marketType: this.marketType,
      status: this.status,
      revision: this.revision,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      reason: this.reason,
      config: structuredClone(this.config),
      locked: structuredClone(this.locked),
      activeCoins: [...(this.activeCoins.length > 0 ? this.activeCoins : this.locked.selectedCoins)],
      coinRotations: structuredClone(this.coinRotations),
      accounts: {
        A: this.engines.A.snapshot(),
        B: this.engines.B.snapshot(),
        C: this.engines.C.snapshot(),
        D: this.engines.D.snapshot(),
      },
      decisions: structuredClone(this.decisions),
    };
  }

  calculateMetrics(): FourGroupComparisonMetrics {
    return FourGroupComparisonCoordinator.calculateMetricsFromBatch(this.snapshot());
  }

  exportCsv(): string {
    return FourGroupComparisonCoordinator.exportCsvFromBatch(this.snapshot());
  }

  static calculateMetricsFromBatch(batch: FourGroupTradingBatch): FourGroupComparisonMetrics {
    const accounts = {} as Record<FourGroupId, FourGroupAccountMetricsSummary>;
    let earliestEquityCutoff: number | null = null;
    let allSettled = true;

    const followDecisions = batch.decisions.filter(d => d.signalSource !== 'lgbm-ai-direct');
    const dDirectDecisions = batch.decisions.filter(d => d.signalSource === 'lgbm-ai-direct');
    const hasIndependentD = dDirectDecisions.length > 0
      || followDecisions.some(d => d.groups.D.reason === 'INDEPENDENT_STRATEGY')
      || batch.accounts.D.events.some(e => e.type === 'START' && e.message.includes('純模型訊號'));

    for (const id of FOUR_GROUP_IDS) {
      const snap = batch.accounts[id];
      const metrics = calculateAutoMetrics(snap);
      const incompletePositions = snap.positions.filter(p => p.incomplete).length;
      if (snap.fundingStatus !== 'SETTLED' && snap.fundingStatus !== 'NOT_REQUIRED') {
        allSettled = false;
      }
      if (incompletePositions > 0) {
        allSettled = false;
      }
      const lastPoint = snap.equity.at(-1)?.timestamp ?? snap.endedAt ?? snap.startedAt ?? null;
      if (lastPoint !== null && lastPoint > 0) {
        earliestEquityCutoff = earliestEquityCutoff === null ? lastPoint : Math.min(earliestEquityCutoff, lastPoint);
      }

      const executedSet = new Set<string>([
        ...snap.trades.map(t => t.planId),
        ...snap.positions.map(p => p.planId),
        ...snap.orders.filter(o => o.kind === 'ENTRY').map(o => o.planId),
      ]);

      const relevantDecisions = hasIndependentD
        ? (id === 'D' ? dDirectDecisions : followDecisions)
        : batch.decisions;
      const allowedSignals = relevantDecisions.filter(d => d.groups[id].allowed).length;
      const rejectedSignals = relevantDecisions.length - allowedSignals;
      const executedSignals = relevantDecisions.filter(d => executedSet.has(d.planId)).length;

      accounts[id] = {
        id,
        label: FOUR_GROUP_SPEC[id].label,
        metrics,
        fundingStatus: snap.fundingStatus,
        incompletePositions,
        openPositionCount: snap.positions.length,
        pendingOrderCount: snap.orders.length,
        closedTradeCount: snap.trades.length,
        allowedSignals,
        rejectedSignals,
        executedSignals,
      };
    }

    const totalSignals = batch.decisions.length;
    const aiBlockedReasons: Record<string, number> = {};
    const lgbmBlockedReasons: Record<string, number> = {};
    let aiCoveredSignals = 0;
    let aiAllowedSignals = 0;
    let lgbmCoveredSignals = 0;
    let lgbmAllowedSignals = 0;

    const snapA = batch.accounts.A;
    const blockedCounterfactuals: FourGroupBlockedCounterfactual[] = [];

    for (const d of batch.decisions) {
      if (
        d.ai.reason === 'ALLOWED'
        || d.ai.reason === 'NEUTRAL'
        || d.ai.reason === 'LOW_CONFIDENCE'
        || (d.ai.reason === 'MISMATCH' && d.ai.direction !== null)
      ) {
        aiCoveredSignals += 1;
      }
      if (d.ai.allowed) aiAllowedSignals += 1;
      else aiBlockedReasons[d.ai.reason] = (aiBlockedReasons[d.ai.reason] ?? 0) + 1;

      if (d.lgbm.reason === 'ALLOWED' || d.lgbm.reason === 'NOT_IN_TOP3' || d.lgbm.reason === 'CONFLICT') {
        lgbmCoveredSignals += 1;
      }
      if (d.lgbm.allowed) lgbmAllowedSignals += 1;
      else lgbmBlockedReasons[d.lgbm.reason] = (lgbmBlockedReasons[d.lgbm.reason] ?? 0) + 1;

      if (d.signalSource === 'lgbm-ai-direct') continue;
      const blockedInGroups = FOUR_GROUP_IDS.filter(
        id => id !== 'A' && !d.groups[id].allowed && d.groups[id].reason !== 'INDEPENDENT_STRATEGY',
      );
      if (blockedInGroups.length > 0) {
        const tradeInA = snapA.trades.find(t => t.planId === d.planId);
        const posInA = snapA.positions.find(p => p.planId === d.planId);
        const orderInA = snapA.orders.find(o => o.kind === 'ENTRY' && o.planId === d.planId);
        const executedInA = Boolean(tradeInA || posInA || orderInA);

        let tradeNetPnlInA: number | undefined;
        let tradeWinInA: boolean | undefined;
        if (tradeInA) {
          tradeNetPnlInA = tradeInA.netPnl;
          tradeWinInA = tradeInA.netPnl > 0;
        } else if (posInA) {
          const dir = posInA.side === 'LONG' ? 1 : -1;
          const unrealized = dir * (posInA.currentPrice - posInA.entryPrice) * posInA.remainingQuantity;
          tradeNetPnlInA = posInA.realizedPnl + unrealized - posInA.entryFee - posInA.exitFees - posInA.funding;
        }

        blockedCounterfactuals.push({
          planId: d.planId,
          symbol: d.symbol,
          side: d.side,
          confirmedAt: d.confirmedAt,
          executedInA,
          blockedInGroups,
          tradeNetPnlInA,
          tradeWinInA,
          aiDirection: d.ai.direction,
          aiReason: d.ai.reason,
          lgbmReason: d.lgbm.reason,
          sideRank: d.lgbm.sideRank,
        });
      }
    }

    return {
      commonCutoff: earliestEquityCutoff,
      pairCostStatus: allSettled ? 'SETTLED' : 'PROVISIONAL',
      accounts,
      signalAudit: {
        totalSignals,
        aiCoveredSignals,
        aiCoveragePct: totalSignals > 0 ? (aiCoveredSignals / totalSignals) * 100 : 0,
        aiAllowedSignals,
        aiBlockedReasons,
        lgbmCoveredSignals,
        lgbmCoveragePct: totalSignals > 0 ? (lgbmCoveredSignals / totalSignals) * 100 : 0,
        lgbmAllowedSignals,
        lgbmBlockedReasons,
      },
      blockedCounterfactuals,
    };
  }

  static exportCsvFromBatch(batch: FourGroupTradingBatch): string {
    const metrics = FourGroupComparisonCoordinator.calculateMetricsFromBatch(batch);
    const header = [
      'batchId',
      'recordType',
      'groupId',
      'timestamp',
      'symbol',
      'side',
      'planId',
      'model',
      'aiSnapshotId',
      'aiDirection',
      'aiReason',
      'lgbmSnapshotId',
      'lgbmCutoff',
      'lgbmSideRank',
      'lgbmReason',
      'groupAllowed',
      'groupReason',
      'netPnlOrJson',
    ];
    const rows: string[][] = [header];
    const commonCutoffIso = metrics.commonCutoff ? new Date(metrics.commonCutoff).toISOString() : '';

    for (const id of FOUR_GROUP_IDS) {
      const acct = metrics.accounts[id];
      const payload = {
        label: acct.label,
        equity: acct.metrics.equity,
        returnPct: acct.metrics.returnPct,
        realizedPnl: acct.metrics.realizedPnl,
        unrealizedPnl: acct.metrics.unrealizedPnl,
        fees: acct.metrics.fees,
        funding: acct.metrics.funding,
        maxDrawdownPct: acct.metrics.maxDrawdownPct,
        winRate: acct.metrics.winRate,
        profitFactor: Number.isFinite(acct.metrics.profitFactor as number) ? acct.metrics.profitFactor : String(acct.metrics.profitFactor),
        completedTrades: acct.closedTradeCount,
        incompletePositions: acct.incompletePositions,
        fundingStatus: acct.fundingStatus,
        pairCostStatus: metrics.pairCostStatus,
        commonCutoff: metrics.commonCutoff,
        ollamaUrl: batch.locked.ollamaUrl,
        model: batch.locked.model,
        promptVersion: batch.locked.promptVersion,
        ruleVersion: batch.locked.ruleVersion,
        lgbmPolicyVersion: batch.locked.lgbmPolicyVersion,
      };
      rows.push([
        batch.id,
        'BATCH_METADATA',
        id,
        commonCutoffIso,
        '',
        '',
        '',
        batch.locked.model,
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        acct.label,
        JSON.stringify(payload),
      ]);
    }

    const counterfactualMap = new Map(metrics.blockedCounterfactuals.map(c => [c.planId, c]));

    for (const d of batch.decisions) {
      const cf = counterfactualMap.get(d.planId);
      const lgbmCutoffIso = d.lgbm.cutoffTime ? new Date(d.lgbm.cutoffTime).toISOString() : '';
      for (const id of FOUR_GROUP_IDS) {
        rows.push([
          batch.id,
          'DECISION',
          id,
          new Date(d.confirmedAt).toISOString(),
          d.symbol,
          d.side,
          d.planId,
          d.ai.model ?? batch.locked.model,
          d.ai.snapshotId ?? '',
          d.ai.direction ?? '',
          d.ai.reason,
          d.lgbm.snapshotId ?? '',
          lgbmCutoffIso,
          d.lgbm.sideRank === null ? '' : String(d.lgbm.sideRank),
          d.lgbm.reason,
          String(d.groups[id].allowed),
          d.groups[id].reason,
          id !== 'A' && !d.groups[id].allowed && cf?.tradeNetPnlInA !== undefined
            ? String(cf.tradeNetPnlInA)
            : d.groups[id].explanation,
        ]);
      }
    }

    for (const id of FOUR_GROUP_IDS) {
      for (const t of batch.accounts[id].trades) {
        rows.push([
          batch.id,
          'TRADE',
          id,
          new Date(t.closedAt).toISOString(),
          t.symbol,
          t.side,
          t.planId,
          batch.locked.model,
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          'true',
          t.reason,
          String(t.netPnl),
        ]);
      }
    }

    return rows.map(r => r.map(escapeCsvCell).join(',')).join('\n');
  }
}
