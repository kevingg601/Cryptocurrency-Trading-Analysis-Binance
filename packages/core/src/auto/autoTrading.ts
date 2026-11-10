import type { MarketType } from './binance';
import type { FollowPlan } from './followPlans';
import type { MarketTradeFrame } from './marketEvents';
import type { AutoFundingRecord, AutoSymbolRules } from './autoTradingMarket';

export type AutoTradingStatus = 'IDLE' | 'RUNNING' | 'PAUSED' | 'DRAINING' | 'COMPLETED' | 'INTERRUPTED';
export interface AutoTradingConfig {
  marketType: MarketType;
  initialCapital: number;
  riskPct: number;
  maxNotionalPct: number;
  maxPositions: number;
  feeBps: number;
  slippageBps: number;
  latencyMs: number;
}
export interface AutoOrder {
  id: string;
  planId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  kind: 'ENTRY' | 'EXIT';
  reason: string;
  createdAt: number;
  eligibleAt: number;
  expiresAt: number;
  quantity?: number;
  positionId?: string;
  plan?: FollowPlan;
  signalTradeId?: number;
  signalTimestamp: number;
}
export interface AutoPosition {
  id: string;
  planId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  quantity: number;
  remainingQuantity: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  openedAt: number;
  currentPrice: number;
  entryFee: number;
  realizedPnl: number;
  tp1Hit: boolean;
  lastReceivedAt: number;
  incomplete?: boolean;
  exitNotional: number;
  exitFees: number;
  funding: number;
}
export interface AutoFill {
  id: string;
  positionId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  action: 'ENTRY' | 'EXIT';
  timestamp: number;
  tradeTimestamp: number;
  tradeId?: number;
  price: number;
  quantity: number;
  fee: number;
  grossPnl: number;
  reason: string;
}
export interface AutoClosedTrade {
  id: string;
  planId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  openedAt: number;
  closedAt: number;
  grossPnl: number;
  fees: number;
  funding: number;
  netPnl: number;
  reason: string;
  incomplete?: boolean;
}
export interface AutoEvent { id: string; timestamp: number; type: string; symbol?: string; message: string }
export interface AutoEquityPoint { timestamp: number; value: number }
export interface AutoFundingCharge { id: string; positionId: string; symbol: string; timestamp: number; amount: number }
export interface AutoTradingSnapshot {
  schemaVersion: 1;
  strategyVersion: 'conservative-follow-v1';
  id: string;
  marketType: MarketType;
  status: AutoTradingStatus;
  config: AutoTradingConfig;
  startedAt: number;
  endedAt?: number;
  cash: number;
  positions: AutoPosition[];
  plans: FollowPlan[];
  orders: AutoOrder[];
  fills: AutoFill[];
  trades: AutoClosedTrade[];
  events: AutoEvent[];
  equity: AutoEquityPoint[];
  fundingCharges: AutoFundingCharge[];
  fundingStatus: 'NOT_REQUIRED' | 'PENDING' | 'SETTLED' | 'ERROR';
  fundingThrough?: number;
  reason?: string;
  lastEquity: number;
  equityPeak: number;
  maxDrawdownPct: number;
  riskExtrema: AutoEquityPoint[];
  peakTimestamp: number;
  signalSettings?: Record<string, number>;
}
export interface AutoTradingNotification {
  id: string;
  type: 'auto-entry' | 'auto-exit' | 'auto-interrupted';
  symbol: string;
  marketType: MarketType;
  title: string;
  message: string;
  price: number;
  timestamp: number;
  planId?: string;
  followPlanId?: string;
}
export function defaultAutoTradingConfig(marketType: MarketType): AutoTradingConfig {
  return { marketType, initialCapital: 10_000, riskPct: 0.5, maxNotionalPct: 20, maxPositions: 3,
    feeBps: marketType === 'spot' ? 10 : 5, slippageBps: 5, latencyMs: 250 };
}
export function idleAutoTradingSnapshot(market: MarketType): AutoTradingSnapshot {
  const config = defaultAutoTradingConfig(market);
  return { schemaVersion: 1, strategyVersion: 'conservative-follow-v1', id: 'idle', marketType: market, status: 'IDLE',
    config, startedAt: 0, cash: config.initialCapital, positions: [], plans: [], orders: [], fills: [], trades: [], events: [], equity: [],
    fundingCharges: [], fundingStatus: 'NOT_REQUIRED', lastEquity: config.initialCapital,
    equityPeak: config.initialCapital, maxDrawdownPct: 0, riskExtrema: [], peakTimestamp: 0 };
}
const positive = (n: number) => Number.isFinite(n) && n > 0;
const direction = (side: AutoPosition['side']) => side === 'LONG' ? 1 : -1;
export const isAutoTradingActive = (status: AutoTradingStatus) => ['RUNNING', 'PAUSED', 'DRAINING'].includes(status);
export function calculateAutoEquity(s: AutoTradingSnapshot): number {
  return s.cash + s.positions.reduce((sum, p) => sum + p.entryPrice * p.remainingQuantity
    + direction(p.side) * (p.currentPrice - p.entryPrice) * p.remainingQuantity, 0);
}
export function floorAutoQuantity(quantity: number, step: number): number {
  if (!positive(quantity) || !positive(step)) return 0;
  return Number((Math.floor(quantity / step + 1e-9) * step).toPrecision(14));
}
export function calculateAutoMetrics(s: AutoTradingSnapshot) {
  const unrealizedPnl = s.positions.reduce((sum, p) => sum + direction(p.side) * (p.currentPrice - p.entryPrice) * p.remainingQuantity, 0);
  const equity = calculateAutoEquity(s);
  const fees = s.fills.reduce((sum, f) => sum + f.fee, 0);
  const funding = s.fundingCharges.reduce((sum, f) => sum + f.amount, 0);
  const realizedPnl = s.fills.reduce((sum, f) => sum + f.grossPnl - f.fee, 0) - funding;
  const complete = s.trades.filter(t => !t.incomplete);
  const wins = complete.filter(t => t.netPnl > 0);
  const loss = complete.reduce((sum, t) => sum + Math.max(0, -t.netPnl), 0);
  const gain = wins.reduce((sum, t) => sum + t.netPnl, 0);
  let peak = s.config.initialCapital, maxDrawdownPct = s.maxDrawdownPct ?? 0;
  for (const point of [...s.equity, { timestamp: 0, value: equity }]) {
    peak = Math.max(peak, point.value);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - point.value) / peak * 100 : 0);
  }
  return { equity, unrealizedPnl, realizedPnl, fees, funding, returnPct: (equity / s.config.initialCapital - 1) * 100,
    maxDrawdownPct, winRate: complete.length ? wins.length / complete.length * 100 : null,
    profitFactor: loss > 0 ? gain / loss : gain > 0 ? Infinity : null,
    completedTrades: complete.length, incompletePositions: s.positions.filter(p => p.incomplete).length };
}

export class AutoTradingEngine {
  private state: AutoTradingSnapshot;
  private rules: Record<string, AutoSymbolRules> = {};
  private sequence = 0;
  private seenPlans = new Set<string>();
  private lastTrades = new Map<string, { timestamp: number; id?: number }>();
  private health = false;
  private unhealthySince: number | undefined;
  private acceptConfirmationsAfter = 0;
  private notifications: AutoTradingNotification[] = [];
  revision = 0;

  constructor(market: MarketType) { this.state = idleAutoTradingSnapshot(market); }
  snapshot(): AutoTradingSnapshot { return structuredClone(this.state); }
  setRules(rules: Record<string, AutoSymbolRules>) { this.rules = structuredClone(rules); }
  takeNotifications() { const result = this.notifications; this.notifications = []; return result; }
  setStreamHealthy(healthy: boolean, now: number, interruptedSince?: number) {
    if (healthy && !this.health && this.unhealthySince !== undefined && now - this.unhealthySince > 5_000) {
      this.interrupt(now, '成交串流中斷超過五秒，恢復後不延續舊批次');
    }
    this.health = healthy;
    if (healthy) this.unhealthySince = undefined;
    else this.unhealthySince = Math.min(this.unhealthySince ?? now, interruptedSince ?? now);
  }
  start(config: AutoTradingConfig, now: number, signalSettings?: Record<string, number>) {
    if (isAutoTradingActive(this.state.status)) throw new Error('請先結束目前評估');
    if (!this.health) throw new Error('逐筆成交串流尚未就緒');
    if (!Object.keys(this.rules).length) throw new Error('交易規格尚未載入');
    if (config.marketType !== this.state.marketType) throw new Error('自動交易市場與行情不一致');
    if (!Number.isFinite(now) || now < 0 || !['spot', 'futures'].includes(config.marketType) || !positive(config.initialCapital) || config.initialCapital < 100 || !positive(config.riskPct) || config.riskPct > 5
      || !positive(config.maxNotionalPct) || config.maxNotionalPct > 20 || !Number.isInteger(config.maxPositions)
      || config.maxPositions < 1 || config.maxPositions > 3 || !Number.isFinite(config.feeBps) || config.feeBps < 0 || config.feeBps > 100
      || !Number.isFinite(config.slippageBps) || config.slippageBps < 0 || config.slippageBps > 100
      || !Number.isInteger(config.latencyMs) || config.latencyMs < 250 || config.latencyMs >= 5_000) throw new Error('自動交易設定無效（延遲須小於五秒入場期限）');
    this.state = { ...idleAutoTradingSnapshot(config.marketType), id: `auto-${now}-${this.nextId()}`, status: 'RUNNING',
      config: { ...config }, cash: config.initialCapital, lastEquity: config.initialCapital, equityPeak: config.initialCapital, startedAt: now,
      signalSettings: signalSettings ? { ...signalSettings } : undefined, equity: [{ timestamp: now, value: config.initialCapital }],
      peakTimestamp: now, riskExtrema: [{ timestamp: now, value: config.initialCapital }] };
    this.seenPlans.clear(); this.lastTrades.clear(); this.notifications = [];
    this.acceptConfirmationsAfter = now;
    this.record('START', now, '即時模擬評估開始，保守回撤確認 v1');
  }
  pause(now: number) {
    if (this.state.status !== 'RUNNING') return;
    this.state.status = 'PAUSED'; this.cancelEntries(now, '暫停新進場'); this.record('PAUSE', now, '暫停新進場，既有持倉繼續退出追蹤');
  }
  resume(now: number) {
    if (this.state.status !== 'PAUSED' || !this.health) return;
    this.acceptConfirmationsAfter = now;
    this.state.status = 'RUNNING'; this.record('RESUME', now, '恢復接收新確認訊號，不補交易暫停期間訊號');
  }
  drain(now: number) {
    if (!isAutoTradingActive(this.state.status)) return;
    this.state.status = 'DRAINING'; this.cancelEntries(now, '結束新進場'); this.record('DRAIN', now, '停止新進場，等待所有持倉退出'); this.finishIfDrained(now);
  }
  closeAll(now: number) {
    this.drain(now);
    for (const p of this.state.positions) this.requestExit(p, 'MANUAL', p.remainingQuantity, now, 0);
  }
  interrupt(now: number, reason: string) {
    if (!isAutoTradingActive(this.state.status)) return;
    this.state.status = 'INTERRUPTED'; this.state.endedAt = now; this.state.reason = reason;
    this.state.positions.forEach(p => { p.incomplete = true; });
    this.state.orders = []; this.record('INTERRUPTED', now, `${reason}；未完成持倉保留最後可靠估值，不補造平倉`);
    this.notify('auto-interrupted', now, this.state.positions[0]?.symbol ?? 'BTCUSDT', 0, reason);
    this.sampleEquity(now);
  }
  restoreInterrupted(snapshot: AutoTradingSnapshot, now: number) {
    this.state = structuredClone(snapshot);
    this.state.riskExtrema ??= structuredClone(this.state.equity);
    this.state.peakTimestamp ??= this.state.equity.reduce((peak, point) => point.value > peak.value ? point : peak,
      { timestamp: this.state.startedAt, value: this.state.config.initialCapital }).timestamp;
    this.sequence = Math.max(this.sequence, ...snapshot.events.map(e => Number(e.id.split('-').at(-1)) || 0),
      ...snapshot.fills.map(f => Number(f.id) || 0));
    if (isAutoTradingActive(this.state.status)) this.interrupt(now, '程式重新啟動，前次評估已中斷');
  }
  tick(now: number) {
    if (!isAutoTradingActive(this.state.status)) return;
    if (!this.health && now - (this.unhealthySince ?? now) > 5_000) { this.interrupt(now, '成交串流異常超過五秒'); return; }
    if (this.state.positions.some(p => now - p.lastReceivedAt > 5_000)) { this.interrupt(now, '持倉幣種超過五秒無新成交'); return; }
    for (const order of [...this.state.orders]) {
      if (order.kind === 'ENTRY' && now >= order.expiresAt) this.cancelOrder(order, now, '入場等待超過五秒');
    }
    for (const p of this.state.positions) {
      if (now - p.openedAt >= 900_000) this.requestExit(p, 'TIMEOUT', p.remainingQuantity, now, 0);
    }
    this.sampleEquity(now); this.finishIfDrained(now);
  }
  processFrame(frame: MarketTradeFrame) {
    const { trade, receivedAt: now, marketType, alert, confirmations } = frame;
    if (!Number.isFinite(now) || !Number.isFinite(trade.timestamp)) return;
    this.tick(now);
    if (!isAutoTradingActive(this.state.status) || marketType !== this.state.marketType || !positive(trade.price)
      || !Number.isFinite(trade.timestamp) || Math.abs(now - trade.timestamp) > 5_000) return;
    const last = this.lastTrades.get(trade.symbol);
    if (last && (trade.timestamp < last.timestamp || (trade.lastTradeId !== undefined && last.id !== undefined
      ? trade.lastTradeId <= last.id : trade.timestamp === last.timestamp))) return;
    this.lastTrades.set(trade.symbol, { timestamp: trade.timestamp, id: trade.lastTradeId });
    const reversal = alert && (alert.type === 'pump' || alert.type === 'dump') ? (alert.type === 'pump' ? 'LONG' : 'SHORT') : null;
    for (const p of this.state.positions.filter(p => p.symbol === trade.symbol)) {
      p.currentPrice = trade.price; p.lastReceivedAt = now;
      const d = direction(p.side);
      if (d * (trade.price - p.stopLoss) <= 0) this.requestExit(p, 'SL', p.remainingQuantity, now, trade.timestamp);
      else if (reversal && reversal !== p.side) this.requestExit(p, 'REVERSAL', p.remainingQuantity, now, trade.timestamp);
      else if (now - p.openedAt >= 900_000) this.requestExit(p, 'TIMEOUT', p.remainingQuantity, now, trade.timestamp);
      else if (d * (trade.price - p.takeProfit2) >= 0) this.requestExit(p, 'TP2', p.remainingQuantity, now, trade.timestamp);
      else if (!p.tp1Hit && d * (trade.price - p.takeProfit1) >= 0) this.requestExit(p, 'TP1', p.quantity / 2, now, trade.timestamp);
    }
    for (const order of [...this.state.orders].filter(o => o.symbol === trade.symbol)) {
      if (order.kind === 'ENTRY') {
        const plan = order.plan!;
        const d = direction(order.side);
        const retracement = d * (plan.triggerPrice - trade.price) / plan.impulse;
        if (reversal && reversal !== order.side) { this.cancelOrder(order, now, '反向急變，取消入場'); continue; }
        if (d * (trade.price - plan.stopLoss) <= 0 || d * (trade.price - plan.takeProfit1) >= 0 || retracement < 0.15 - 1e-10) {
          this.cancelOrder(order, now, '已越過保守入場或保護範圍，不追價'); continue;
        }
        if (now >= order.eligibleAt && this.health && trade.timestamp > order.signalTimestamp) this.fillEntry(order, frame);
      } else if (now >= order.eligibleAt && trade.timestamp > order.signalTimestamp) {
        const p = this.state.positions.find(p => p.id === order.positionId);
        if (p) this.fillExit(order, p, frame);
      }
    }
    for (const { event, plan } of confirmations) {
      if (event.type === 'follow-confirmed' && plan.state === 'CONFIRMED') this.observeConfirmation(plan, now, trade.lastTradeId, trade.timestamp);
    }
    this.sampleEquity(now);
    this.finishIfDrained(now);
  }
  applyFunding(records: AutoFundingRecord[], through: number, now: number) {
    if (this.state.marketType !== 'futures') return;
    for (const record of records) {
      if (!positive(record.markPrice) || !Number.isFinite(record.fundingRate) || !Number.isFinite(record.fundingTime)) throw new Error('資金費結算資料無效');
      for (const entry of this.state.fills.filter(f => f.action === 'ENTRY' && f.symbol === record.symbol && f.tradeTimestamp < record.fundingTime)) {
        const id = `${entry.positionId}:${record.fundingTime}`;
        if (this.state.fundingCharges.some(c => c.id === id)) continue;
        const exited = this.state.fills.filter(f => f.positionId === entry.positionId && f.action === 'EXIT' && f.tradeTimestamp <= record.fundingTime).reduce((sum, f) => sum + f.quantity, 0);
        const quantity = Math.max(0, entry.quantity - exited);
        if (!quantity) continue;
        const p = this.state.positions.find(p => p.id === entry.positionId);
        if (p?.incomplete && record.fundingTime > p.lastReceivedAt) continue;
        const amount = direction(entry.side) * quantity * record.markPrice * record.fundingRate;
        this.state.fundingCharges.push({ id, positionId: entry.positionId, symbol: entry.symbol, timestamp: record.fundingTime, amount });
        this.state.cash -= amount;
        if (p) p.funding += amount;
        const t = this.state.trades.find(t => t.id === entry.positionId);
        if (t) { t.funding += amount; t.netPnl -= amount; }
        for (const point of this.state.equity) if (point.timestamp >= record.fundingTime) point.value -= amount;
        for (const point of this.state.riskExtrema) if (point.timestamp >= record.fundingTime) point.value -= amount;
        this.record('FUNDING', now, `資金費 ${amount.toFixed(4)} USDT（負數為收取）`, entry.symbol);
      }
    }
    this.state.fundingStatus = through >= Math.max(this.state.endedAt ?? 0, ...this.state.fills.map(f => f.tradeTimestamp)) ? 'SETTLED' : 'PENDING';
    this.state.fundingThrough = through; this.revision++;
    let peak = this.state.config.initialCapital, peakTime = this.state.startedAt, drawdown = 0;
    for (const point of [...this.state.equity, ...this.state.riskExtrema].sort((a, b) => a.timestamp - b.timestamp)) {
      if (point.value > peak) { peak = point.value; peakTime = point.timestamp; }
      drawdown = Math.max(drawdown, (peak - point.value) / peak * 100);
    }
    this.state.equityPeak = peak; this.state.peakTimestamp = peakTime; this.state.maxDrawdownPct = drawdown;
    this.sampleEquity(now);
  }
  fundingFailed(now: number) {
    if (this.state.fundingStatus === 'ERROR') return;
    this.state.fundingStatus = 'ERROR'; this.record('FUNDING_ERROR', now, '資金費尚未核對，淨績效成本未完整');
  }
  private observeConfirmation(plan: FollowPlan, now: number, tradeId: number | undefined, timestamp: number) {
    if (this.seenPlans.has(plan.id)) return;
    this.seenPlans.add(plan.id);
    const reject = (why: string) => this.record('SKIP', now, why, plan.symbol);
    if (this.state.status !== 'RUNNING') { reject('目前停止新進場'); return; }
    if (!this.health) { reject('成交串流異常'); return; }
    if (plan.marketType !== this.state.marketType || (plan.side === 'SHORT' && plan.marketType === 'spot')) { reject('市場或方向不支援'); return; }
    if (plan.stale || plan.confirmedAt === undefined || plan.confirmedAt < this.acceptConfirmationsAfter || now - plan.confirmedAt > 5_000) { reject('過期或啟動／恢復前的訊號'); return; }
    const rule = this.rules[plan.symbol];
    if (!rule || !positive(rule.stepSize) || !positive(rule.maxQty) || !Number.isFinite(rule.minQty) || rule.minQty < 0
      || rule.minQty > rule.maxQty || !Number.isFinite(rule.minNotional) || rule.minNotional < 0
      || (rule.maxNotional !== undefined && (!positive(rule.maxNotional) || rule.maxNotional < rule.minNotional))) { reject('缺少有效交易規格'); return; }
    if (this.state.positions.some(p => p.symbol === plan.symbol) || this.state.orders.some(o => o.kind === 'ENTRY' && o.symbol === plan.symbol)) { reject('同幣已有持倉或待成交'); return; }
    if (this.state.positions.length + this.state.orders.filter(o => o.kind === 'ENTRY').length >= this.state.config.maxPositions) { reject('同時持倉上限已滿'); return; }
    const d = direction(plan.side);
    if (![plan.confirmedEntry!, plan.stopLoss, plan.takeProfit1, plan.takeProfit2, plan.impulse].every(positive)
      || d * (plan.confirmedEntry! - plan.stopLoss) <= 0 || d * (plan.takeProfit1 - plan.confirmedEntry!) <= 0
      || d * (plan.takeProfit2 - plan.takeProfit1) <= 0) { reject('點位方向或數值無效'); return; }
    this.state.orders.push({ id: this.nextId(), planId: plan.id, symbol: plan.symbol, side: plan.side, kind: 'ENTRY', reason: 'CONFIRMED',
      createdAt: now, eligibleAt: now + this.state.config.latencyMs, expiresAt: now + 5_000,
      plan: { ...plan }, signalTradeId: tradeId, signalTimestamp: timestamp });
    this.state.plans.push({ ...plan });
    this.record('ENTRY_QUEUED', now, '保守條件確認，等待延遲後新成交', plan.symbol);
  }
  private fillEntry(order: AutoOrder, frame: MarketTradeFrame) {
    const { config } = this.state;
    const rule = this.rules[order.symbol];
    const plan = order.plan!;
    const d = direction(order.side), slip = config.slippageBps / 10_000, fee = config.feeBps / 10_000;
    const price = frame.trade.price * (1 + d * slip);
    const retracement = d * (plan.triggerPrice - price) / plan.impulse;
    if (!positive(price) || d * (price - plan.stopLoss) <= 0 || d * (plan.takeProfit1 - price) <= 0 || retracement < 0.15 - 1e-10) {
      this.cancelOrder(order, frame.receivedAt, '滑價後已離開有效入場範圍'); return;
    }
    const equity = calculateAutoEquity(this.state);
    const stopFill = plan.stopLoss * (1 - d * slip);
    const unitRisk = d * (price - stopFill) + (price + stopFill) * fee;
    const qty = floorAutoQuantity(Math.min(equity * config.riskPct / 100 / unitRisk,
      equity * config.maxNotionalPct / 100 / price, Math.max(0, this.state.cash) / (price * (1 + fee)),
      rule.maxQty, (rule.maxNotional ?? Infinity) / price), rule.stepSize);
    if (!positive(qty) || qty < rule.minQty || qty * price < rule.minNotional || floorAutoQuantity(qty / 2, rule.stepSize) < rule.minQty
      || floorAutoQuantity(qty / 2, rule.stepSize) * plan.takeProfit1 < rule.minNotional) {
      this.cancelOrder(order, frame.receivedAt, '資金不足或不符合分批交易最低數量／金額'); return;
    }
    const entryFee = qty * price * fee;
    const p: AutoPosition = { id: `${this.state.id}-position-${this.nextId()}`, planId: plan.id, symbol: plan.symbol, side: plan.side,
      entryPrice: price, quantity: qty, remainingQuantity: qty, stopLoss: plan.stopLoss, takeProfit1: plan.takeProfit1,
      takeProfit2: plan.takeProfit2, openedAt: frame.receivedAt, currentPrice: frame.trade.price, entryFee,
      realizedPnl: 0, tp1Hit: false, lastReceivedAt: frame.receivedAt, exitNotional: 0, exitFees: 0, funding: 0 };
    this.state.cash -= qty * price + entryFee;
    this.state.positions.push(p); this.removeOrder(order);
    this.addFill(p, 'ENTRY', qty, price, entryFee, 0, 'CONFIRMED', frame);
    this.record('ENTRY', frame.receivedAt, `模擬${p.side === 'LONG' ? '做多' : '做空'} ${qty}，成交 ${price}，手續費 ${entryFee.toFixed(4)}`, p.symbol);
    this.notify('auto-entry', frame.receivedAt, p.symbol, price, '保守條件已確認，已模擬成交；不是真實訂單', p.planId);
    this.sampleEquity(frame.receivedAt, true);
  }
  private requestExit(p: AutoPosition, reason: string, quantity: number, now: number, timestamp: number) {
    const priorities: Record<string, number> = { TP1: 1, TP2: 2, TIMEOUT: 3, MANUAL: 4, REVERSAL: 5, SL: 6 };
    const existing = this.state.orders.find(o => o.positionId === p.id);
    if (existing) {
      if ((priorities[reason] ?? 0) > (priorities[existing.reason] ?? 0)) {
        existing.reason = reason; existing.quantity = p.remainingQuantity;
        existing.eligibleAt = now + this.state.config.latencyMs; existing.signalTimestamp = timestamp;
        this.record('EXIT_UPGRADED', now, `退出更新為 ${reason}，重新等待成交延遲`, p.symbol);
      }
      return;
    }
    this.state.orders.push({ id: this.nextId(), planId: p.planId, symbol: p.symbol, side: p.side, kind: 'EXIT', reason,
      positionId: p.id, quantity, createdAt: now, eligibleAt: now + this.state.config.latencyMs, expiresAt: Infinity, signalTimestamp: timestamp });
    this.record('EXIT_QUEUED', now, `${reason} 條件觸發，等待新成交退出`, p.symbol);
  }
  private fillExit(order: AutoOrder, p: AutoPosition, frame: MarketTradeFrame) {
    const rule = this.rules[p.symbol];
    let qty = order.reason === 'TP1' ? floorAutoQuantity(p.quantity / 2, rule.stepSize) : p.remainingQuantity;
    qty = Math.min(qty, p.remainingQuantity);
    const price = frame.trade.price * (1 - direction(p.side) * this.state.config.slippageBps / 10_000);
    const fee = qty * price * this.state.config.feeBps / 10_000;
    const pnl = direction(p.side) * (price - p.entryPrice) * qty;
    this.state.cash += qty * p.entryPrice + pnl - fee;
    p.remainingQuantity = Math.max(0, Number((p.remainingQuantity - qty).toPrecision(14)));
    p.exitNotional += qty * price; p.exitFees += fee; p.realizedPnl += pnl;
    if (order.reason === 'TP1') p.tp1Hit = true;
    this.removeOrder(order); this.addFill(p, 'EXIT', qty, price, fee, pnl, order.reason, frame);
    if (p.remainingQuantity < rule.stepSize / 2) {
      this.state.trades.push({ id: p.id, planId: p.planId, symbol: p.symbol, side: p.side, entryPrice: p.entryPrice,
        exitPrice: p.exitNotional / p.quantity, quantity: p.quantity, openedAt: p.openedAt, closedAt: frame.receivedAt,
        grossPnl: p.realizedPnl, fees: p.entryFee + p.exitFees, funding: p.funding,
        netPnl: p.realizedPnl - p.entryFee - p.exitFees - p.funding, reason: order.reason });
      this.state.positions = this.state.positions.filter(item => item.id !== p.id);
    }
    this.record('EXIT', frame.receivedAt, `${order.reason} 模擬平倉 ${qty}，成交 ${price}，扣費損益 ${(pnl - fee).toFixed(4)}`, p.symbol);
    this.notify('auto-exit', frame.receivedAt, p.symbol, price, `${order.reason} 已模擬退出 ${qty}；並非真實持倉損益`, p.planId);
    this.sampleEquity(frame.receivedAt, true);
  }
  private addFill(p: AutoPosition, action: AutoFill['action'], quantity: number, price: number, fee: number, grossPnl: number, reason: string, frame: MarketTradeFrame) {
    this.state.fills.push({ id: this.nextId(), positionId: p.id, symbol: p.symbol, side: p.side, action, quantity, price, fee, grossPnl,
      reason, timestamp: frame.receivedAt, tradeTimestamp: frame.trade.timestamp, tradeId: frame.trade.lastTradeId });
    if (this.state.marketType === 'futures') this.state.fundingStatus = 'PENDING';
  }
  private finishIfDrained(now: number) {
    if (this.state.status === 'DRAINING' && !this.state.positions.length && !this.state.orders.length) {
      this.state.status = 'COMPLETED'; this.state.endedAt = now; this.record('COMPLETED', now, '本批次評估完成'); this.sampleEquity(now);
    }
  }
  private sampleEquity(now: number, force = false) {
    const value = calculateAutoEquity(this.state);
    this.state.lastEquity = value;
    if (value > this.state.equityPeak) {
      this.state.equityPeak = value; this.state.peakTimestamp = now;
      this.state.riskExtrema.push({ timestamp: now, value });
    }
    const drawdown = (this.state.equityPeak - value) / this.state.equityPeak * 100;
    if (drawdown > this.state.maxDrawdownPct) {
      this.state.maxDrawdownPct = drawdown;
      this.state.riskExtrema.push({ timestamp: this.state.peakTimestamp, value: this.state.equityPeak }, { timestamp: now, value });
    }
    const last = this.state.equity.at(-1);
    if (!last || now - last.timestamp >= 1_000 || force && (last.timestamp !== now || last.value !== value)
      || !isAutoTradingActive(this.state.status) && value !== last.value) {
      this.state.equity.push({ timestamp: now, value }); this.revision++;
    }
  }
  private nextId() { return String(++this.sequence); }
  private record(type: string, timestamp: number, message: string, symbol?: string) {
    this.state.events.push({ id: `${this.state.id}-${this.nextId()}`, type, timestamp, message, symbol }); this.revision++;
  }
  private notify(type: AutoTradingNotification['type'], timestamp: number, symbol: string, price: number, message: string, planId?: string) {
    this.notifications.push({ id: `auto-notify-${this.state.id}-${this.nextId()}`, type, symbol, marketType: this.state.marketType,
      timestamp, price, planId, title: type === 'auto-interrupted' ? '自動模擬評估中斷'
        : `${symbol.replace(/USDT$/, '')} ${type === 'auto-entry' ? '自動模擬入場' : '自動模擬退出'}`, message });
  }
  private removeOrder(order: AutoOrder) { this.state.orders = this.state.orders.filter(o => o.id !== order.id); this.revision++; }
  private cancelOrder(order: AutoOrder, now: number, reason: string) { this.removeOrder(order); this.record('CANCEL', now, reason, order.symbol); }
  private cancelEntries(now: number, reason: string) {
    for (const o of [...this.state.orders]) if (o.kind === 'ENTRY') this.cancelOrder(o, now, reason);
  }
}
