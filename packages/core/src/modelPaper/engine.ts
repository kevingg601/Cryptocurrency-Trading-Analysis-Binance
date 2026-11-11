import { floorAutoQuantity } from '../auto/autoTrading.ts';
import type { AutoFundingRecord, AutoSymbolRules } from '../auto/autoTradingMarket.ts';
import { sortSignals } from './signals.ts';
import {
  DEFAULT_MODEL_PAPER_CONFIG,
  type ExperimentStatus,
  type FundingCharge,
  type ModelPaperConfig,
  type ModelPaperSide,
  type OrderAction,
  type PaperAccountState,
  type PaperFill,
  type PaperOrder,
  type PaperPosition,
  type Signal,
  type SkippedSignalRecord,
} from './types.ts';

export interface ValuationResult {
  cash: number;
  reserved: number;
  unrealized: number;
  equity: number;
  complete: boolean;
}

export interface ReconcileContext {
  experimentStatus: ExperimentStatus;
  decisionId: string;
  decisionHour: number;
  now: number;
  rules: Record<string, AutoSymbolRules>;
  config?: ModelPaperConfig;
  positions: PaperPosition[];
  pendingOrders: PaperOrder[];
  stoppedThisHour?: Iterable<string>;
  lastPrices: Record<string, number>;
}

export interface ReconcileResult {
  exitOrders: PaperOrder[];
  entryOrders: PaperOrder[];
  orders: PaperOrder[];
  skipped: SkippedSignalRecord[];
  bankrupt: boolean;
}

export interface FillTradeInput {
  symbol: string;
  price: number;
  aggId: number;
  tradeTime: number;
  receivedAt: number;
}

export interface ApplyFillResult {
  rejectedReason?: 'INSUFFICIENT_CASH' | 'POSITION_NOT_FOUND' | 'INVALID_PRICE';
  account: PaperAccountState;
  positions: PaperPosition[];
  fill?: PaperFill;
  newPosition?: PaperPosition;
  closedPosition?: PaperPosition;
  valuation: ValuationResult;
  bankrupt: boolean;
}

export interface ApplyFundingResult {
  account: PaperAccountState;
  charges: FundingCharge[];
}

function isValidRule(rule: AutoSymbolRules | undefined): rule is AutoSymbolRules {
  if (!rule) return false;
  if (!Number.isFinite(rule.stepSize) || rule.stepSize <= 0) return false;
  if (!Number.isFinite(rule.minQty) || rule.minQty < 0) return false;
  if (!Number.isFinite(rule.maxQty) || rule.maxQty <= 0 || rule.maxQty < rule.minQty) return false;
  if (!Number.isFinite(rule.minNotional) || rule.minNotional < 0) return false;
  if (rule.maxNotional !== undefined && (!Number.isFinite(rule.maxNotional) || rule.maxNotional < rule.minNotional)) {
    return false;
  }
  return true;
}

export function valuate(
  account: Pick<PaperAccountState, 'cash' | 'reserved' | 'degraded'>,
  positions: ReadonlyArray<PaperPosition>,
  lastPrices: Record<string, number>,
): ValuationResult {
  let unrealized = 0;
  let complete = !account.degraded;

  for (const pos of positions) {
    if (pos.status !== 'OPEN') continue;
    const rawLast = lastPrices[pos.symbol];
    const hasValidPrice = typeof rawLast === 'number' && Number.isFinite(rawLast) && rawLast > 0;
    const mark = hasValidPrice ? rawLast : pos.entryPrice;
    if (!hasValidPrice) complete = false;
    const dir = pos.side === 'LONG' ? 1 : -1;
    unrealized += dir * (mark - pos.entryPrice) * pos.qty;
  }

  const equity = account.cash + account.reserved + unrealized;
  return {
    cash: account.cash,
    reserved: account.reserved,
    unrealized,
    equity,
    complete,
  };
}

export function checkStop(position: Pick<PaperPosition, 'status' | 'side' | 'stopPrice'>, price: number): boolean {
  if (position.status !== 'OPEN' || !Number.isFinite(price) || price <= 0) return false;
  return position.side === 'LONG' ? price <= position.stopPrice : price >= position.stopPrice;
}

export function computeFillPrice(
  side: ModelPaperSide,
  action: OrderAction,
  rawPrice: number,
  slippageRate: number,
): number {
  const favorableForLongEntry =
    (side === 'LONG' && action === 'ENTRY') || (side === 'SHORT' && action === 'EXIT');
  return favorableForLongEntry ? rawPrice * (1 + slippageRate) : rawPrice * (1 - slippageRate);
}

export function fillSlots(
  account: PaperAccountState,
  signals: Signal[],
  ctx: ReconcileContext,
): { orders: PaperOrder[]; skipped: SkippedSignalRecord[]; bankrupt: boolean } {
  const config = ctx.config ?? DEFAULT_MODEL_PAPER_CONFIG;
  const openPositions = ctx.positions.filter(p => p.status === 'OPEN');
  const pendingEntries = ctx.pendingOrders.filter(o => o.status === 'PENDING' && o.action === 'ENTRY');

  const valuation = valuate(account, openPositions, ctx.lastPrices);
  const bankrupt = account.bankrupt || valuation.equity <= 1e-9;
  const skipped: SkippedSignalRecord[] = [];
  const orders: PaperOrder[] = [];

  const heldOrPendingSymbols = new Set<string>([
    ...openPositions.map(p => p.symbol),
    ...pendingEntries.map(o => o.symbol),
  ]);
  const stoppedSet = new Set<string>([
    ...(account.stoppedThisHour ?? []),
    ...(ctx.stoppedThisHour ?? []),
  ]);

  const sortedSignals = sortSignals(signals);

  if (ctx.experimentStatus !== 'RUNNING') {
    return { orders, skipped, bankrupt };
  }

  if (bankrupt) {
    for (const sig of sortedSignals) {
      if (heldOrPendingSymbols.has(sig.symbol)) continue;
      skipped.push({
        account: account.account,
        symbol: sig.symbol,
        side: sig.side,
        sideRank: sig.sideRank,
        reason: 'BANKRUPT',
        detail: '帳戶淨值小於或等於零，已標記破產並停止新進場',
      });
    }
    return { orders, skipped, bankrupt: true };
  }

  if (account.degraded) {
    for (const sig of sortedSignals) {
      if (heldOrPendingSymbols.has(sig.symbol)) continue;
      skipped.push({
        account: account.account,
        symbol: sig.symbol,
        side: sig.side,
        sideRank: sig.sideRank,
        reason: 'DEGRADED_MARKET',
        detail: '帳戶處於行情過期狀態，暫停產生新入場單',
      });
    }
    return { orders, skipped, bankrupt: false };
  }

  let availableSlots = Math.max(0, config.maxPositions - (openPositions.length + pendingEntries.length));
  const committedCash = pendingEntries.reduce(
    (sum, o) => sum + o.qty * o.refPrice * (1 + config.slippageRate + config.feeRate),
    0,
  );
  let availableCash = account.cash - committedCash;

  for (const sig of sortedSignals) {
    if (heldOrPendingSymbols.has(sig.symbol)) continue;

    if (stoppedSet.has(sig.symbol)) {
      skipped.push({
        account: account.account,
        symbol: sig.symbol,
        side: sig.side,
        sideRank: sig.sideRank,
        reason: 'STOPPED_THIS_HOUR',
        detail: '同一決策小時內已觸發停損，不可於本小時內重複進場',
      });
      continue;
    }

    if (availableSlots <= 0) {
      skipped.push({
        account: account.account,
        symbol: sig.symbol,
        side: sig.side,
        sideRank: sig.sideRank,
        reason: 'NO_SLOT',
        detail: '已達同時持倉上限（含掛單中入場委託）',
      });
      continue;
    }

    const rule = ctx.rules[sig.symbol];
    if (!isValidRule(rule) || !Number.isFinite(sig.refPrice) || sig.refPrice <= 0) {
      skipped.push({
        account: account.account,
        symbol: sig.symbol,
        side: sig.side,
        sideRank: sig.sideRank,
        reason: 'SPEC_LIMIT',
        detail: '缺少有效交易規格或參考價格無效',
      });
      continue;
    }

    const notional = valuation.equity * config.allocation;
    if (!Number.isFinite(notional) || notional <= 0) {
      skipped.push({
        account: account.account,
        symbol: sig.symbol,
        side: sig.side,
        sideRank: sig.sideRank,
        reason: 'INSUFFICIENT_CASH',
        detail: '帳戶淨值不足以配置名目金額',
      });
      continue;
    }

    const qty = floorAutoQuantity(notional / sig.refPrice, rule.stepSize);
    const estNotional = qty * sig.refPrice;

    if (
      !(qty > 0) ||
      qty + 1e-12 < rule.minQty ||
      qty - 1e-12 > rule.maxQty ||
      estNotional + 1e-9 < rule.minNotional ||
      (rule.maxNotional !== undefined && estNotional - 1e-9 > rule.maxNotional)
    ) {
      skipped.push({
        account: account.account,
        symbol: sig.symbol,
        side: sig.side,
        sideRank: sig.sideRank,
        reason: 'SPEC_LIMIT',
        detail: `取整數量 ${qty} 或名目金額 ${estNotional.toFixed(4)} 不符合交易所規格`,
      });
      continue;
    }

    const requiredCash = estNotional * (1 + config.slippageRate + config.feeRate);
    if (requiredCash > availableCash + 1e-9) {
      skipped.push({
        account: account.account,
        symbol: sig.symbol,
        side: sig.side,
        sideRank: sig.sideRank,
        reason: 'INSUFFICIENT_CASH',
        detail: `可用現金不足（需要 ${requiredCash.toFixed(2)}，可用 ${Math.max(0, availableCash).toFixed(2)}）`,
      });
      continue;
    }

    orders.push({
      id: `${ctx.decisionId}:${account.account}:${sig.symbol}:ENTRY`,
      experimentId: account.experimentId,
      account: account.account,
      decisionId: ctx.decisionId,
      symbol: sig.symbol,
      side: sig.side,
      action: 'ENTRY',
      reason: 'SIGNAL',
      qty,
      refPrice: sig.refPrice,
      createdAt: ctx.now,
      status: 'PENDING',
      cancelReason: null,
      positionId: null,
    });

    availableSlots -= 1;
    availableCash -= requiredCash;
    heldOrPendingSymbols.add(sig.symbol);
  }

  return { orders, skipped, bankrupt };
}

export function reconcile(
  account: PaperAccountState,
  signals: Signal[],
  ctx: ReconcileContext,
): ReconcileResult {
  const openPositions = ctx.positions.filter(p => p.status === 'OPEN');
  const pendingExitPosIds = new Set(
    ctx.pendingOrders
      .filter(o => o.status === 'PENDING' && o.action === 'EXIT' && o.positionId)
      .map(o => o.positionId as string),
  );

  const exitOrders: PaperOrder[] = [];
  for (const pos of openPositions) {
    if (pendingExitPosIds.has(pos.id)) continue;
    const matchingSignal = signals.find(s => s.symbol === pos.symbol);
    if (matchingSignal && matchingSignal.side === pos.side) {
      // Hold existing position without scaling in or resetting stop price
      continue;
    }
    const reason = matchingSignal ? 'REVERSED' : 'SIGNAL_GONE';
    const refPrice = matchingSignal?.refPrice ?? ctx.lastPrices[pos.symbol] ?? pos.entryPrice;
    exitOrders.push({
      id: `${ctx.decisionId}:${account.account}:${pos.symbol}:EXIT`,
      experimentId: account.experimentId,
      account: account.account,
      decisionId: ctx.decisionId,
      symbol: pos.symbol,
      side: pos.side,
      action: 'EXIT',
      reason,
      qty: pos.qty,
      refPrice,
      createdAt: ctx.now,
      status: 'PENDING',
      cancelReason: null,
      positionId: pos.id,
    });
  }

  const slotsResult = fillSlots(account, signals, ctx);
  return {
    exitOrders,
    entryOrders: slotsResult.orders,
    orders: [...exitOrders, ...slotsResult.orders],
    skipped: slotsResult.skipped,
    bankrupt: slotsResult.bankrupt,
  };
}

export function applyFill(
  account: PaperAccountState,
  positions: ReadonlyArray<PaperPosition>,
  order: PaperOrder,
  trade: FillTradeInput,
  config: ModelPaperConfig = DEFAULT_MODEL_PAPER_CONFIG,
  decisionHour = 0,
  lastPrices: Record<string, number> = {},
): ApplyFillResult {
  const nextAccount: PaperAccountState = {
    ...account,
    stoppedThisHour: [...account.stoppedThisHour],
    updatedAt: trade.receivedAt,
  };
  const nextPositions = positions.map(p => ({ ...p }));

  if (!Number.isFinite(trade.price) || trade.price <= 0) {
    return {
      rejectedReason: 'INVALID_PRICE',
      account: nextAccount,
      positions: nextPositions,
      valuation: valuate(nextAccount, nextPositions, lastPrices),
      bankrupt: nextAccount.bankrupt,
    };
  }

  const fillPrice = computeFillPrice(order.side, order.action, trade.price, config.slippageRate);
  const fee = order.qty * fillPrice * config.feeRate;
  const slippageCost = Math.abs(fillPrice - trade.price) * order.qty;
  const updatedLastPrices = { ...lastPrices, [order.symbol]: trade.price };

  if (order.action === 'ENTRY') {
    const totalOutflow = order.qty * fillPrice + fee;
    if (totalOutflow > nextAccount.cash + 1e-9) {
      return {
        rejectedReason: 'INSUFFICIENT_CASH',
        account: nextAccount,
        positions: nextPositions,
        valuation: valuate(nextAccount, nextPositions, updatedLastPrices),
        bankrupt: nextAccount.bankrupt,
      };
    }

    const positionId = `${order.experimentId}:${order.account}:${order.decisionId}:${order.symbol}`;
    const stopPrice =
      order.side === 'LONG'
        ? fillPrice * (1 - config.stopPct)
        : fillPrice * (1 + config.stopPct);

    const rawCash = nextAccount.cash - totalOutflow;
    nextAccount.cash = rawCash < 0 && rawCash >= -1e-9 ? 0 : rawCash;
    nextAccount.reserved += order.qty * fillPrice;
    nextAccount.fees += fee;

    const newPosition: PaperPosition = {
      id: positionId,
      experimentId: order.experimentId,
      account: order.account,
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      entryPrice: fillPrice,
      stopPrice,
      openedAt: trade.receivedAt,
      openedDecisionHour: decisionHour,
      closedAt: null,
      exitPrice: null,
      exitReason: null,
      status: 'OPEN',
    };
    nextPositions.push(newPosition);

    const fill: PaperFill = {
      orderId: order.id,
      experimentId: order.experimentId,
      account: order.account,
      symbol: order.symbol,
      action: 'ENTRY',
      aggId: trade.aggId,
      tradeTime: trade.tradeTime,
      receivedAt: trade.receivedAt,
      rawPrice: trade.price,
      fillPrice,
      qty: order.qty,
      fee,
      slippageCost,
      realizedPnl: 0,
      positionId,
    };

    const valuation = valuate(nextAccount, nextPositions, updatedLastPrices);
    const bankrupt = nextAccount.bankrupt || valuation.equity <= 1e-9;
    nextAccount.bankrupt = bankrupt;

    return {
      account: nextAccount,
      positions: nextPositions,
      fill,
      newPosition,
      valuation,
      bankrupt,
    };
  }

  // EXIT fill
  const posIdx = nextPositions.findIndex(p => p.id === order.positionId && p.status === 'OPEN');
  if (posIdx < 0) {
    return {
      rejectedReason: 'POSITION_NOT_FOUND',
      account: nextAccount,
      positions: nextPositions,
      valuation: valuate(nextAccount, nextPositions, updatedLastPrices),
      bankrupt: nextAccount.bankrupt,
    };
  }

  const pos = nextPositions[posIdx];
  const dir = pos.side === 'LONG' ? 1 : -1;
  const pnl = dir * (fillPrice - pos.entryPrice) * pos.qty;
  const entryNotional = pos.qty * pos.entryPrice;

  nextAccount.cash += entryNotional + pnl - fee;
  const remainingOpen = nextPositions.filter((p, i) => i !== posIdx && p.status === 'OPEN');
  const nextReserved = nextAccount.reserved - entryNotional;
  nextAccount.reserved =
    remainingOpen.length === 0 || Math.abs(nextReserved) < 1e-9 ? 0 : Math.max(0, nextReserved);
  nextAccount.realizedPnl += pnl;
  nextAccount.fees += fee;

  pos.status = 'CLOSED';
  pos.closedAt = trade.receivedAt;
  pos.exitPrice = fillPrice;
  pos.exitReason = order.reason;

  const fill: PaperFill = {
    orderId: order.id,
    experimentId: order.experimentId,
    account: order.account,
    symbol: order.symbol,
    action: 'EXIT',
    aggId: trade.aggId,
    tradeTime: trade.tradeTime,
    receivedAt: trade.receivedAt,
    rawPrice: trade.price,
    fillPrice,
    qty: pos.qty,
    fee,
    slippageCost,
    realizedPnl: pnl,
    positionId: pos.id,
  };

  const valuation = valuate(nextAccount, nextPositions, updatedLastPrices);
  const bankrupt = nextAccount.bankrupt || valuation.equity <= 1e-9;
  nextAccount.bankrupt = bankrupt;

  return {
    account: nextAccount,
    positions: nextPositions,
    fill,
    closedPosition: pos,
    valuation,
    bankrupt,
  };
}

export function applyFunding(
  account: PaperAccountState,
  positions: ReadonlyArray<PaperPosition>,
  fills: ReadonlyArray<PaperFill>,
  existingCharges: ReadonlyArray<FundingCharge>,
  records: ReadonlyArray<AutoFundingRecord>,
  gapIntervals: ReadonlyArray<{ startedAt: number; endedAt?: number | null }> = [],
  now = Date.now(),
): ApplyFundingResult {
  const nextAccount: PaperAccountState = {
    ...account,
    stoppedThisHour: [...account.stoppedThisHour],
    updatedAt: Math.max(account.updatedAt, now),
  };
  const newCharges: FundingCharge[] = [];
  const seenSettlementIds = new Set(existingCharges.map(c => c.settlementId));
  const positionById = new Map(positions.map(p => [p.id, p]));
  const isEntryFill = (f: PaperFill) => {
    if (f.action) return f.action === 'ENTRY';
    const pos = positionById.get(f.positionId);
    return Boolean(pos && f.receivedAt === pos.openedAt);
  };
  const isExitFill = (f: PaperFill) => {
    if (f.action) return f.action === 'EXIT';
    const pos = positionById.get(f.positionId);
    return Boolean(pos && pos.closedAt != null && f.receivedAt === pos.closedAt);
  };
  const entryFills = fills.filter(isEntryFill);

  for (const record of records) {
    if (
      !Number.isFinite(record.fundingTime) ||
      !Number.isFinite(record.fundingRate) ||
      !Number.isFinite(record.markPrice) ||
      record.markPrice <= 0
    ) {
      throw new Error('資金費結算資料無效');
    }

    for (const entry of entryFills) {
      if (entry.symbol !== record.symbol || entry.account !== account.account) continue;
      if (!(entry.tradeTime < record.fundingTime)) continue;

      const settlementId = `${entry.positionId}:${record.fundingTime}`;
      if (seenSettlementIds.has(settlementId)) continue;

      const exitedQty = fills
        .filter(f => f.positionId === entry.positionId && isExitFill(f) && f.tradeTime <= record.fundingTime)
        .reduce((sum, f) => sum + f.qty, 0);
      const heldQty = Math.max(0, entry.qty - exitedQty);
      if (heldQty <= 1e-12) continue;

      const pos = positionById.get(entry.positionId);
      if (!pos) continue;

      const dir = pos.side === 'LONG' ? 1 : -1;
      const amount = dir * heldQty * record.markPrice * record.fundingRate;
      const duringGap = gapIntervals.some(
        g => record.fundingTime >= g.startedAt && (g.endedAt == null || record.fundingTime <= g.endedAt),
      );

      seenSettlementIds.add(settlementId);
      nextAccount.cash -= amount;
      nextAccount.funding += amount;

      newCharges.push({
        settlementId,
        experimentId: account.experimentId,
        account: account.account,
        positionId: entry.positionId,
        symbol: record.symbol,
        fundingTime: record.fundingTime,
        rate: record.fundingRate,
        markPrice: record.markPrice,
        qty: heldQty,
        amount,
        duringGap,
      });
    }
  }

  return {
    account: nextAccount,
    charges: newCharges,
  };
}
