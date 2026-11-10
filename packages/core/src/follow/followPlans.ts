import type { AggregateTradeData, MarketType } from './binance';
import type { MarketAlert } from './marketAlerts';
import { formatCryptoPrice } from './utils.ts';
import type { AutoTradingNotification } from './autoTrading';

export type FollowPlanState = 'WAIT_PULLBACK' | 'WAIT_CONFIRMATION' | 'CONFIRMED' | 'TP1' | 'TP2' | 'STOPPED' | 'INVALID' | 'MISSED' | 'EXPIRED';
export interface FollowPlan {
  id: string;
  alertId: string;
  marketType: MarketType;
  symbol: string;
  side: 'LONG' | 'SHORT';
  state: FollowPlanState;
  referencePrice: number;
  triggerPrice: number;
  triggerTimestamp: number;
  impulse: number;
  observationPrice: number;
  zoneLow: number;
  zoneHigh: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  confirmedEntry?: number;
  confirmedAt?: number;
  extreme?: number;
  confirmationSince?: number;
  confirmationReceivedSince?: number;
  createdAt: number;
  expiresAt: number;
  lastTradeTimestamp?: number;
  lastTradeId?: number;
  lastReceivedAt?: number;
  currentPrice: number;
  stale: boolean;
  reason?: string;
}
export interface FollowPlanEvent {
  id: string;
  planId: string;
  type: 'follow-confirmed' | 'follow-tp1' | 'follow-tp2' | 'follow-stop';
  symbol: string;
  marketType: MarketType;
  side: 'LONG' | 'SHORT';
  title: string;
  message: string;
  price: number;
  timestamp: number;
}
export type MarketNotification = MarketAlert | FollowPlanEvent | AutoTradingNotification;
export const FOLLOW_PLAN_LABELS: Record<FollowPlanState, string> = {
  WAIT_PULLBACK: '等待回撤', WAIT_CONFIRMATION: '等待確認', CONFIRMED: '已確認', TP1: 'TP1 已觸及',
  TP2: 'TP2 已觸及', STOPPED: '止損觀察價已觸及', INVALID: '已失效', MISSED: '已錯過，不追價', EXPIRED: '觀察到期',
};
export const isFollowPlanActive = (plan: FollowPlan) => ['WAIT_PULLBACK', 'WAIT_CONFIRMATION', 'CONFIRMED', 'TP1'].includes(plan.state);
const FRESH_MS = 5_000;
const validPrice = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value > 0;

export function createFollowPlan(alert: MarketAlert, receivedAt: number): FollowPlan | null {
  if (alert.type !== 'pump' && alert.type !== 'dump') return null;
  if (alert.marketType === 'spot' && alert.type === 'dump') return null;
  if (!validPrice(alert.referencePrice) || !validPrice(alert.price) || !Number.isFinite(receivedAt)
    || !Number.isFinite(alert.timestamp) || !Number.isFinite(alert.referenceTimestamp)
    || alert.referenceTimestamp! > alert.timestamp || Math.abs(receivedAt - alert.timestamp) > FRESH_MS) return null;
  const direction = alert.type === 'pump' ? 1 : -1;
  const impulse = direction * (alert.price - alert.referencePrice);
  if (impulse <= 0) return null;
  const observationPrice = alert.price - direction * impulse * 0.382;
  const stopLoss = alert.referencePrice - direction * impulse * 0.1;
  const risk = Math.abs(observationPrice - stopLoss);
  const takeProfit1 = observationPrice + direction * risk * 1.5;
  const takeProfit2 = observationPrice + direction * risk * 2;
  const bounds = [0.25, 0.5].map(ratio => alert.price - direction * impulse * ratio);
  if (![observationPrice, stopLoss, takeProfit1, takeProfit2, ...bounds].every(validPrice)) return null;
  return {
    id: `follow-${alert.id}`, alertId: alert.id, marketType: alert.marketType, symbol: alert.symbol,
    side: direction === 1 ? 'LONG' : 'SHORT', state: 'WAIT_PULLBACK', referencePrice: alert.referencePrice,
    triggerPrice: alert.price, triggerTimestamp: alert.timestamp, impulse, observationPrice, zoneLow: Math.min(...bounds), zoneHigh: Math.max(...bounds),
    stopLoss, takeProfit1, takeProfit2, createdAt: receivedAt, expiresAt: receivedAt + 180_000,
    currentPrice: alert.price, stale: true,
  };
}

export class FollowPlanTracker {
  private plans: FollowPlan[] = [];

  reset() { this.plans = []; }
  getPlans(): FollowPlan[] { return this.plans.map(plan => ({ ...plan })); }

  observeAlert(alert: MarketAlert, receivedAt = Date.now()): FollowPlan | null {
    if (alert.type !== 'pump' && alert.type !== 'dump') return null;
    if (!validPrice(alert.price) || !validPrice(alert.referencePrice) || !Number.isFinite(alert.referenceTimestamp)
      || !Number.isFinite(alert.timestamp) || !Number.isFinite(receivedAt) || alert.referenceTimestamp! > alert.timestamp
      || Math.abs(receivedAt - alert.timestamp) > FRESH_MS
      || (alert.type === 'pump' ? alert.price <= alert.referencePrice : alert.price >= alert.referencePrice)) return null;
    this.tick(receivedAt);
    const existing = this.plans.find(plan => plan.alertId === alert.id);
    if (existing) return isFollowPlanActive(existing) ? { ...existing } : null;
    const active = this.plans.find(plan => plan.symbol === alert.symbol && plan.marketType === alert.marketType && isFollowPlanActive(plan));
    const side = alert.type === 'pump' ? 'LONG' : 'SHORT';
    if (active && alert.timestamp < (active.lastTradeTimestamp ?? active.triggerTimestamp)) return null;
    if (active?.side === side) return { ...active };
    if (active) {
      active.state = 'INVALID';
      active.reason = '反向急漲跌警報，原計畫失效';
      this.clearConfirmation(active);
    }
    const plan = createFollowPlan(alert, receivedAt);
    if (!plan) return null;
    this.plans.unshift(plan);
    this.plans = this.plans.slice(0, 50);
    return { ...plan };
  }

  tick(now = Date.now()) {
    for (const plan of this.plans) {
      if (!isFollowPlanActive(plan)) continue;
      if (now >= plan.expiresAt) {
        plan.state = 'EXPIRED';
        plan.reason = '觀察期限結束，不代表實際平倉';
        this.clearConfirmation(plan);
      } else if (plan.lastReceivedAt === undefined || now - plan.lastReceivedAt > FRESH_MS) {
        plan.stale = true;
        this.clearConfirmation(plan);
      }
    }
  }

  processTrade(trade: AggregateTradeData, market: MarketType, receivedAt = Date.now()): FollowPlanEvent[] {
    const plan = this.plans.find(item => item.symbol === trade.symbol && item.marketType === market && isFollowPlanActive(item));
    if (!plan || !validPrice(trade.price) || !Number.isFinite(trade.timestamp) || !Number.isFinite(receivedAt)) return [];
    this.tick(receivedAt);
    if (!isFollowPlanActive(plan) || trade.timestamp < plan.triggerTimestamp
      || Math.abs(receivedAt - trade.timestamp) > FRESH_MS) return [];
    if (plan.lastTradeTimestamp !== undefined && (trade.timestamp < plan.lastTradeTimestamp
      || (trade.lastTradeId !== undefined && plan.lastTradeId !== undefined ? trade.lastTradeId <= plan.lastTradeId : trade.timestamp === plan.lastTradeTimestamp))) return [];
    if (plan.lastReceivedAt === undefined || receivedAt - plan.lastReceivedAt > FRESH_MS
      || (plan.lastTradeTimestamp !== undefined && trade.timestamp - plan.lastTradeTimestamp > FRESH_MS)) this.clearConfirmation(plan);
    plan.lastReceivedAt = receivedAt;
    plan.lastTradeTimestamp = trade.timestamp;
    plan.lastTradeId = trade.lastTradeId;
    plan.currentPrice = trade.price;
    plan.stale = false;
    const direction = plan.side === 'LONG' ? 1 : -1;
    if (direction * (trade.price - plan.stopLoss) <= 0) {
      const wasConfirmed = plan.confirmedEntry !== undefined;
      plan.state = wasConfirmed ? 'STOPPED' : 'INVALID';
      plan.reason = wasConfirmed ? '止損觀察價觸及，未執行實際交易' : '入場確認前已觸及失效價';
      this.clearConfirmation(plan);
      return wasConfirmed ? [this.event(plan, 'follow-stop', trade)] : [];
    }
    if (plan.confirmedEntry !== undefined) {
      const events: FollowPlanEvent[] = [];
      if (plan.state === 'CONFIRMED' && direction * (trade.price - plan.takeProfit1) >= 0) {
        plan.state = 'TP1';
        events.push(this.event(plan, 'follow-tp1', trade));
      }
      if (direction * (trade.price - plan.takeProfit2) >= 0) {
        plan.state = 'TP2';
        events.push(this.event(plan, 'follow-tp2', trade));
      }
      return events;
    }
    if (plan.state === 'WAIT_PULLBACK') {
      if (trade.price >= plan.zoneLow && trade.price <= plan.zoneHigh) {
        plan.state = 'WAIT_CONFIRMATION';
        plan.extreme = trade.price;
      }
      return [];
    }
    if (plan.extreme === undefined || direction * (trade.price - plan.extreme) < 0) {
      plan.extreme = trade.price;
      this.clearConfirmation(plan);
      return [];
    }
    const recovery = direction * (trade.price - plan.extreme);
    if (recovery + plan.impulse * 1e-10 < plan.impulse * 0.1) {
      this.clearConfirmation(plan);
      return [];
    }
    const retracement = direction * (plan.triggerPrice - trade.price) / plan.impulse;
    if (retracement > 0.5 + 1e-10) {
      this.clearConfirmation(plan);
      return [];
    }
    if (retracement < 0.15 - 1e-10) {
      plan.state = 'MISSED';
      plan.reason = '回撤後價格已離開保守範圍，不追價';
      this.clearConfirmation(plan);
      return [];
    }
    if (plan.confirmationSince === undefined) {
      plan.confirmationSince = trade.timestamp;
      plan.confirmationReceivedSince = receivedAt;
      return [];
    }
    if (trade.timestamp - plan.confirmationSince < 3_000 || receivedAt - plan.confirmationReceivedSince! < 3_000) return [];
    const risk = direction * (trade.price - plan.stopLoss);
    const tp1 = trade.price + direction * risk * 1.5;
    const tp2 = trade.price + direction * risk * 2;
    if (risk <= 0 || ![tp1, tp2].every(validPrice)) {
      plan.state = 'INVALID';
      plan.reason = '無法產生有效的止盈止損';
      return [];
    }
    plan.confirmedEntry = trade.price;
    plan.confirmedAt = trade.timestamp;
    plan.takeProfit1 = tp1;
    plan.takeProfit2 = tp2;
    plan.state = 'CONFIRMED';
    plan.expiresAt = receivedAt + 900_000;
    this.clearConfirmation(plan);
    return [this.event(plan, 'follow-confirmed', trade)];
  }

  processMarketTrade(trade: AggregateTradeData, market: MarketType, alert: MarketAlert | null, receivedAt = Date.now()) {
    // Preserve an exit touch before a reversal alert replaces the old plan.
    const events = this.processTrade(trade, market, receivedAt);
    const plan = alert && alert.symbol === trade.symbol && alert.marketType === market ? this.observeAlert(alert, receivedAt) : null;
    if (plan) events.push(...this.processTrade(trade, market, receivedAt));
    return { plan, events: events.filter(event => event.type !== 'follow-confirmed'
      || this.plans.find(item => item.id === event.planId)?.state === 'CONFIRMED') };
  }

  private clearConfirmation(plan: FollowPlan) {
    plan.confirmationSince = undefined;
    plan.confirmationReceivedSince = undefined;
  }

  private event(plan: FollowPlan, type: FollowPlanEvent['type'], trade: AggregateTradeData): FollowPlanEvent {
    const label = type === 'follow-confirmed' ? '保守跟進條件已確認' : type === 'follow-tp1' ? 'TP1 觀察價觸及' : type === 'follow-tp2' ? 'TP2 觀察價觸及' : '止損觀察價觸及';
    return {
      id: `${plan.id}-${type}`, planId: plan.id, type, symbol: plan.symbol, marketType: plan.marketType, side: plan.side,
      title: `${plan.symbol.replace(/USDT$/, '')} ${label}`,
      message: `${plan.side === 'LONG' ? '做多' : '做空'}參考 $${formatCryptoPrice(plan.confirmedEntry)} · TP1 $${formatCryptoPrice(plan.takeProfit1)} · TP2 $${formatCryptoPrice(plan.takeProfit2)} · SL $${formatCryptoPrice(plan.stopLoss)}。僅條件觀察，未下單。`,
      price: trade.price, timestamp: trade.timestamp,
    };
  }
}
