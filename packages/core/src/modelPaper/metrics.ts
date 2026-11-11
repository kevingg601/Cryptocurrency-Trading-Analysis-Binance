import { valuate } from './engine.ts';
import type {
  AccountId,
  AccountMetrics,
  EquityPoint,
  ExperimentComparability,
  FundingCharge,
  ModelPaperConfig,
  ModelPaperDecisionRecord,
  ModelPaperGap,
  PaperAccountState,
  PaperFill,
  PaperOrder,
  PaperPosition,
  SkipReason,
} from './types.ts';

export function mergeGapDurationMs(
  gaps: ReadonlyArray<Pick<ModelPaperGap, 'startedAt' | 'endedAt'>>,
  windowStart: number,
  windowEnd: number,
): number {
  if (windowEnd <= windowStart || gaps.length === 0) return 0;
  const intervals = gaps
    .map(g => ({
      start: Math.max(windowStart, g.startedAt),
      end: Math.min(windowEnd, g.endedAt ?? windowEnd),
    }))
    .filter(iv => iv.end > iv.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  if (intervals.length === 0) return 0;

  let total = 0;
  let curStart = intervals[0].start;
  let curEnd = intervals[0].end;

  for (let i = 1; i < intervals.length; i++) {
    const iv = intervals[i];
    if (iv.start <= curEnd) {
      curEnd = Math.max(curEnd, iv.end);
    } else {
      total += curEnd - curStart;
      curStart = iv.start;
      curEnd = iv.end;
    }
  }
  total += curEnd - curStart;
  return total;
}

export interface ComputeAccountMetricsInput {
  account: PaperAccountState;
  config: Pick<ModelPaperConfig, 'initialCash'>;
  positions: ReadonlyArray<PaperPosition>;
  orders: ReadonlyArray<PaperOrder>;
  fills: ReadonlyArray<PaperFill>;
  fundingCharges: ReadonlyArray<FundingCharge>;
  equityCurve: ReadonlyArray<EquityPoint>;
  decisions: ReadonlyArray<ModelPaperDecisionRecord>;
  gaps: ReadonlyArray<ModelPaperGap>;
  lastPrices: Record<string, number>;
  startedAt: number;
  now: number;
  endedAt?: number | null;
}

export function computeAccountMetrics(input: ComputeAccountMetricsInput): AccountMetrics {
  const {
    account,
    config,
    positions,
    orders,
    fills,
    fundingCharges,
    equityCurve,
    decisions,
    gaps,
    lastPrices,
    startedAt,
    now,
    endedAt,
  } = input;

  const accountId: AccountId = account.account;
  const initialCash = config.initialCash;
  const openPositions = positions.filter(p => p.status === 'OPEN');
  const closedPositions = positions.filter(p => p.status === 'CLOSED');

  const valuation = valuate(account, openPositions, lastPrices);
  const equity = valuation.equity;
  const unrealizedPnl = valuation.unrealized;
  const realizedPnl = account.realizedPnl;
  const fees = account.fees;
  const funding = account.funding;
  const netRealizedPnl = realizedPnl - fees - funding;
  const netReturn = equity - initialCash;
  const netReturnPct = initialCash > 0 ? (equity / initialCash - 1) * 100 : 0;
  const slippageCost = fills.reduce((sum, f) => sum + f.slippageCost, 0);

  // Max drawdown across recorded equity curve + current live equity
  const sortedEquity = [...equityCurve].sort((a, b) => a.ts - b.ts);
  let peak = initialCash;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  let exposureSum = 0;
  let exposureCount = 0;

  for (const pt of sortedEquity) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = Math.max(0, peak - pt.equity);
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
    if (pt.equity > 0) {
      exposureSum += (pt.reserved / pt.equity) * 100;
      exposureCount += 1;
    }
  }

  if (equity > peak) peak = equity;
  const liveDd = Math.max(0, peak - equity);
  const liveDdPct = peak > 0 ? (liveDd / peak) * 100 : 0;
  if (liveDd > maxDrawdown) maxDrawdown = liveDd;
  if (liveDdPct > maxDrawdownPct) maxDrawdownPct = liveDdPct;

  const currentExposurePct = equity > 0 ? (account.reserved / equity) * 100 : 0;
  const avgExposurePct = exposureCount > 0 ? exposureSum / exposureCount : currentExposurePct;

  // Completed trade stats
  const feesByPosition = new Map<string, number>();
  for (const f of fills) {
    feesByPosition.set(f.positionId, (feesByPosition.get(f.positionId) ?? 0) + f.fee);
  }
  const fundingByPosition = new Map<string, number>();
  for (const c of fundingCharges) {
    fundingByPosition.set(c.positionId, (fundingByPosition.get(c.positionId) ?? 0) + c.amount);
  }

  let wins = 0;
  let totalNetPnl = 0;
  let totalGain = 0;
  let totalLoss = 0;
  let holdDurationSum = 0;
  let holdDurationCount = 0;

  for (const pos of closedPositions) {
    const dir = pos.side === 'LONG' ? 1 : -1;
    const exitPrice = pos.exitPrice ?? pos.entryPrice;
    const grossPnl = dir * (exitPrice - pos.entryPrice) * pos.qty;
    const posFees = feesByPosition.get(pos.id) ?? 0;
    const posFunding = fundingByPosition.get(pos.id) ?? 0;
    const netPnl = grossPnl - posFees - posFunding;

    totalNetPnl += netPnl;
    if (netPnl > 0) {
      wins += 1;
      totalGain += netPnl;
    } else if (netPnl < 0) {
      totalLoss += -netPnl;
    }

    if (typeof pos.closedAt === 'number' && pos.closedAt >= pos.openedAt) {
      holdDurationSum += pos.closedAt - pos.openedAt;
      holdDurationCount += 1;
    }
  }

  const completedTrades = closedPositions.length;
  const winRatePct = completedTrades > 0 ? (wins / completedTrades) * 100 : null;
  const avgNetPnl = completedTrades > 0 ? totalNetPnl / completedTrades : null;
  const profitFactor =
    completedTrades === 0
      ? null
      : totalLoss > 0
        ? totalGain / totalLoss
        : totalGain > 0
          ? Infinity
          : null;
  const avgHoldDurationMs = holdDurationCount > 0 ? holdDurationSum / holdDurationCount : null;

  const skipReasonCounts: Partial<Record<SkipReason, number>> = {};
  for (const d of decisions) {
    const list = accountId === 'A' ? d.signals?.skippedA : d.signals?.skippedB;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      skipReasonCounts[item.reason] = (skipReasonCounts[item.reason] ?? 0) + 1;
    }
  }

  const executionFailureCount = orders.filter(
    o => o.status === 'CANCELLED' && o.cancelReason === 'EXECUTION_FAILED',
  ).length;

  const accountGaps = gaps.filter(g => g.account === accountId || g.account === 'BOTH');
  const windowEnd = Math.max(startedAt, endedAt ?? now);
  const gapDurationMs = mergeGapDurationMs(accountGaps, startedAt, windowEnd);
  const effectiveObservationMs = Math.max(0, windowEnd - startedAt - gapDurationMs);

  return {
    account: accountId,
    equity,
    cash: account.cash,
    reserved: account.reserved,
    unrealizedPnl,
    realizedPnl,
    netRealizedPnl,
    netReturn,
    netReturnPct,
    fees,
    slippageCost,
    funding,
    maxDrawdown,
    maxDrawdownPct,
    completedTrades,
    winRatePct,
    avgNetPnl,
    profitFactor,
    avgHoldDurationMs,
    currentExposurePct,
    avgExposurePct,
    skipReasonCounts,
    executionFailureCount,
    effectiveObservationMs,
    gapDurationMs,
    gapCount: accountGaps.length,
    bankrupt: account.bankrupt,
    degraded: account.degraded,
    fundingPending: account.fundingPending,
  };
}

export function evaluateComparability(
  accountA: Pick<PaperAccountState, 'fundingPending' | 'degraded'>,
  accountB: Pick<PaperAccountState, 'fundingPending' | 'degraded'>,
  gaps: ReadonlyArray<ModelPaperGap>,
  ordersA: ReadonlyArray<PaperOrder>,
  ordersB: ReadonlyArray<PaperOrder>,
): ExperimentComparability {
  const reasons: string[] = [];

  if (accountA.fundingPending || accountB.fundingPending) {
    reasons.push('有帳戶資金費尚未結算完成（funding_pending）');
  }

  const normalizeGaps = (acc: AccountId) =>
    gaps
      .filter(g => g.account === acc || g.account === 'BOTH')
      .map(g => `${g.kind}:${g.startedAt}:${g.endedAt ?? 'OPEN'}`)
      .sort();

  const gapsA = normalizeGaps('A');
  const gapsB = normalizeGaps('B');
  if (gapsA.length !== gapsB.length || gapsA.some((v, idx) => v !== gapsB[idx]) || accountA.degraded !== accountB.degraded) {
    reasons.push('帳戶 A 與帳戶 B 的行情中斷／過期紀錄不一致');
  }

  const normalizeFailures = (orders: ReadonlyArray<PaperOrder>) =>
    orders
      .filter(o => o.status === 'CANCELLED' && o.cancelReason === 'EXECUTION_FAILED')
      .map(o => `${o.decisionId}:${o.symbol}:${o.action}`)
      .sort();

  const failA = normalizeFailures(ordersA);
  const failB = normalizeFailures(ordersB);
  if (failA.length !== failB.length || failA.some((v, idx) => v !== failB[idx])) {
    reasons.push('帳戶 A 與帳戶 B 的委託執行失敗紀錄不一致');
  }

  return {
    comparable: reasons.length === 0,
    reasons,
  };
}
