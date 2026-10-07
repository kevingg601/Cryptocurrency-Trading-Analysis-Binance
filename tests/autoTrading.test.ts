import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AutoTradingEngine, calculateAutoEquity, calculateAutoMetrics, defaultAutoTradingConfig,
  floorAutoQuantity, idleAutoTradingSnapshot, isAutoTradingActive,
} from '../src/services/autoTrading.ts';
import type { AutoTradingConfig } from '../src/services/autoTrading.ts';
import type { AutoFundingRecord, AutoSymbolRules } from '../src/services/autoTradingMarket.ts';
import type { AggregateTradeData, MarketType } from '../src/services/binance.ts';
import type { FollowPlan } from '../src/services/followPlans.ts';
import type { MarketAlert } from '../src/services/marketAlerts.ts';
import type { MarketTradeFrame } from '../src/services/marketEvents.ts';

const epoch = 1_800_000_000_000;
const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const rule: AutoSymbolRules = { stepSize: 0.001, minQty: 0.001, maxQty: 10_000, minNotional: 5 };
const near = (actual: number, expected: number) => {
  assert.ok(Math.abs(actual - expected) < 1e-8, `expected ${actual} to equal ${expected}`);
};
const mirror = (price: number, side: FollowPlan['side']) => side === 'LONG' ? price : 200 - price;

function confirmedPlan(changes: Partial<FollowPlan> = {}): FollowPlan {
  const side = changes.side ?? 'LONG';
  const price = (value: number) => mirror(value, side);
  return {
    id: 'plan-1', alertId: 'alert-1', marketType: 'futures', symbol: 'BTCUSDT', side,
    state: 'CONFIRMED', referencePrice: 100, triggerPrice: price(110), impulse: 10,
    triggerTimestamp: epoch - 4_000, observationPrice: price(106.18),
    zoneLow: side === 'LONG' ? 105 : 92.5, zoneHigh: side === 'LONG' ? 107.5 : 95,
    stopLoss: price(99), takeProfit1: price(116.5), takeProfit2: price(120),
    confirmedEntry: price(106), confirmedAt: epoch, createdAt: epoch - 4_000,
    expiresAt: epoch + 900_000, currentPrice: price(106), stale: false, ...changes,
  };
}

interface FrameOptions {
  trade?: Partial<AggregateTradeData>;
  marketType?: MarketType;
  alert?: MarketAlert;
  plans?: FollowPlan[];
}

function harness(config: Partial<AutoTradingConfig> = {}, rules?: Record<string, AutoSymbolRules>) {
  const market = config.marketType ?? 'futures';
  const engine = new AutoTradingEngine(market);
  engine.setRules(rules ?? Object.fromEntries(symbols.map(symbol => [symbol, { ...rule }])));
  engine.setStreamHealthy(true, epoch);
  engine.start({ ...defaultAutoTradingConfig(market), feeBps: 0, slippageBps: 0, ...config }, epoch);
  let tradeId = 0;
  function frame(offset: number, price: number, options: FrameOptions = {}): MarketTradeFrame {
    return {
      marketType: options.marketType ?? market, receivedAt: epoch + offset,
      trade: {
        symbol: 'BTCUSDT', price, quantity: 1, quoteValue: price, side: 'buy',
        timestamp: epoch + offset, lastTradeId: ++tradeId, ...options.trade,
      },
      alert: options.alert ?? null,
      confirmations: (options.plans ?? []).map(plan => ({
        plan, event: {
          id: `confirmed-${plan.id}`, planId: plan.id, type: 'follow-confirmed',
          symbol: plan.symbol, marketType: plan.marketType, side: plan.side,
          title: 'confirmed', message: '', price: plan.confirmedEntry!, timestamp: plan.confirmedAt!,
        },
      })),
    };
  }
  function send(offset: number, price: number, options: FrameOptions = {}) {
    const value = frame(offset, price, options);
    engine.processFrame(value);
    return value;
  }
  function confirm(plan = confirmedPlan({ marketType: market }), offset = 0) {
    return send(offset, plan.confirmedEntry!, { trade: { symbol: plan.symbol }, plans: [plan] });
  }
  return { engine, frame, send, confirm };
}

function opened(side: FollowPlan['side'] = 'LONG', config: Partial<AutoTradingConfig> = {}, rules?: Record<string, AutoSymbolRules>) {
  const h = harness(config, rules);
  const plan = confirmedPlan({ side, marketType: config.marketType ?? 'futures' });
  h.confirm(plan);
  h.send(250, plan.confirmedEntry!);
  assert.equal(h.engine.snapshot().positions.length, 1, 'fixture must fill a valid retracement entry');
  return { ...h, plan, position: h.engine.snapshot().positions[0] };
}

function reversal(offset: number, side: FollowPlan['side'], price: number): MarketAlert {
  return {
    id: `reversal-${offset}`, symbol: 'BTCUSDT', marketType: 'futures',
    type: side === 'LONG' ? 'dump' : 'pump', title: 'reversal', message: '',
    price, timestamp: epoch + offset, referencePrice: 100, referenceTimestamp: epoch,
  };
}

test('defaults, idle state, active statuses and snapshots are independent', () => {
  assert.deepEqual(defaultAutoTradingConfig('spot'), {
    marketType: 'spot', initialCapital: 10_000, riskPct: 0.5, maxNotionalPct: 20,
    maxPositions: 3, feeBps: 10, slippageBps: 5, latencyMs: 250,
  });
  assert.equal(defaultAutoTradingConfig('futures').feeBps, 5);
  assert.equal(idleAutoTradingSnapshot('spot').fundingStatus, 'NOT_REQUIRED');
  assert.equal(idleAutoTradingSnapshot('futures').fundingStatus, 'NOT_REQUIRED');
  assert.deepEqual(idleAutoTradingSnapshot('futures').plans, []);
  assert.equal(idleAutoTradingSnapshot('futures').equityPeak, 10_000);
  assert.equal(idleAutoTradingSnapshot('futures').maxDrawdownPct, 0);
  assert.deepEqual(idleAutoTradingSnapshot('futures').riskExtrema, []);
  assert.equal(idleAutoTradingSnapshot('futures').peakTimestamp, 0);
  for (const status of ['RUNNING', 'PAUSED', 'DRAINING'] as const) assert.equal(isAutoTradingActive(status), true);
  for (const status of ['IDLE', 'COMPLETED', 'INTERRUPTED'] as const) assert.equal(isAutoTradingActive(status), false);
  const { engine } = harness();
  const copy = engine.snapshot();
  copy.config.initialCapital = 1;
  copy.events.length = 0;
  assert.equal(engine.snapshot().config.initialCapital, 10_000);
  assert.equal(engine.snapshot().events[0].type, 'START');
  assert.deepEqual(engine.snapshot().riskExtrema, [{ timestamp: epoch, value: 10_000 }]);
  assert.equal(engine.snapshot().peakTimestamp, epoch);
});

test('quantity floors to the exchange step and rejects nonpositive or nonfinite inputs', () => {
  assert.equal(floorAutoQuantity(7.142857, 0.001), 7.142);
  assert.equal(floorAutoQuantity(0.3, 0.1), 0.3);
  assert.equal(floorAutoQuantity(0.0009, 0.001), 0);
  for (const bad of [0, -1, NaN, Infinity]) {
    assert.equal(floorAutoQuantity(bad, 0.001), 0);
    assert.equal(floorAutoQuantity(1, bad), 0);
  }
});

test('start requires a healthy stream and loaded rules and cannot replace an active batch', () => {
  const engine = new AutoTradingEngine('futures');
  const config = defaultAutoTradingConfig('futures');
  assert.throws(() => engine.start(config, epoch));
  engine.setStreamHealthy(true, epoch);
  assert.throws(() => engine.start(config, epoch));
  engine.setRules({ BTCUSDT: rule });
  assert.throws(() => engine.start({ ...config, marketType: 'spot' }, epoch));
  engine.start(config, epoch, { threshold: 1 });
  assert.throws(() => engine.start(config, epoch + 1));
  engine.pause(epoch + 2);
  assert.throws(() => engine.start(config, epoch + 3));
  assert.deepEqual(engine.snapshot().signalSettings, { threshold: 1 });
});

test('entry needs both 250ms latency and a strictly later trade, not just a timer or trade id', () => {
  const h = harness();
  h.confirm();
  const order = h.engine.snapshot().orders[0];
  assert.equal(order.kind, 'ENTRY');
  assert.equal(order.eligibleAt, epoch + 250);
  assert.equal(order.expiresAt, epoch + 5_000);
  assert.equal(h.engine.snapshot().fills.length, 0);
  h.send(249, 106);
  h.engine.tick(epoch + 250);
  assert.equal(h.engine.snapshot().fills.length, 0);
  h.send(250, 106, { trade: { timestamp: epoch } });
  assert.equal(h.engine.snapshot().fills.length, 0);
  const fillFrame = h.send(251, 106);
  const state = h.engine.snapshot();
  assert.equal(state.orders.length, 0);
  assert.equal(state.positions.length, 1);
  assert.equal(state.fills.length, 1);
  assert.equal(state.fills[0].tradeId, fillFrame.trade.lastTradeId);
  assert.equal(state.fills[0].tradeTimestamp, epoch + 251);
  assert.equal(state.fills[0].timestamp, epoch + 251);
  assert.deepEqual(h.engine.takeNotifications().map(n => n.type), ['auto-entry']);
  assert.deepEqual(h.engine.takeNotifications(), []);
});

test('a configured longer latency is honored at its exact boundary', () => {
  const h = harness({ latencyMs: 1_000 });
  h.confirm();
  h.send(999, 106);
  assert.equal(h.engine.snapshot().fills.length, 0);
  h.send(1_000, 106);
  assert.equal(h.engine.snapshot().fills.length, 1);
});

for (const side of ['LONG', 'SHORT'] as const) {
  test(`${side}: collateral, mark-to-market, realized PnL and cash reconcile with fees and adverse slippage`, () => {
    const h = opened(side, { feeBps: 10, slippageBps: 5 });
    const d = side === 'LONG' ? 1 : -1;
    const rawEntry = mirror(106, side);
    const entry = rawEntry * (1 + d * 0.0005);
    const stopFill = h.plan.stopLoss * (1 - d * 0.0005);
    const riskPerUnit = d * (entry - stopFill) + (entry + stopFill) * 0.001;
    const quantity = Math.floor((50 / riskPerUnit) / 0.001) * 0.001;
    near(h.position.quantity, quantity);
    near(h.position.entryPrice, entry);
    const entryFee = quantity * entry * 0.001;
    near(h.position.entryFee, entryFee);
    near(h.engine.snapshot().cash, 10_000 - quantity * entry - entryFee);
    near(calculateAutoEquity(h.engine.snapshot()), 10_000 - entryFee + d * (rawEntry - entry) * quantity);
    assert.equal(h.engine.snapshot().equity.at(-1)?.timestamp, h.position.openedAt);
    near(h.engine.snapshot().equity.at(-1)!.value, calculateAutoEquity(h.engine.snapshot()));
    h.send(500, mirror(108, side));
    near(calculateAutoMetrics(h.engine.snapshot()).unrealizedPnl, d * (mirror(108, side) - entry) * quantity);
    h.send(1_000, h.plan.takeProfit2);
    assert.equal(h.engine.snapshot().fills.length, 1, 'target touch cannot fill its own exit');
    h.send(1_249, mirror(121, side));
    assert.equal(h.engine.snapshot().fills.length, 1);
    h.send(1_250, mirror(121, side));
    const state = h.engine.snapshot();
    const exit = mirror(121, side) * (1 - d * 0.0005);
    const exitFee = quantity * exit * 0.001;
    const gross = d * (exit - entry) * quantity;
    assert.equal(state.positions.length, 0);
    assert.equal(state.trades.length, 1);
    assert.equal(state.trades[0].planId, h.plan.id);
    near(state.trades[0].exitPrice, exit);
    near(state.trades[0].grossPnl, gross);
    near(state.trades[0].fees, entryFee + exitFee);
    near(state.trades[0].netPnl, gross - entryFee - exitFee);
    near(state.cash, 10_000 + gross - entryFee - exitFee);
    assert.equal(state.equity.at(-1)?.timestamp, state.fills.at(-1)?.timestamp);
    near(state.equity.at(-1)!.value, state.cash);
    const metrics = calculateAutoMetrics(state);
    near(metrics.equity, state.cash);
    near(metrics.realizedPnl, state.trades[0].netPnl);
    near(metrics.fees, entryFee + exitFee);
    near(metrics.returnPct, (state.cash / 10_000 - 1) * 100);
    assert.equal(metrics.unrealizedPnl, 0);
    assert.equal(metrics.completedTrades, 1);
    assert.equal(metrics.winRate, 100);
    assert.equal(metrics.profitFactor, Infinity);
  });

  test(`${side}: TP1 floors half to the step, then TP2 closes the remainder with a weighted exit price`, () => {
    const h = opened(side, {}, { BTCUSDT: { ...rule, stepSize: 0.1 } });
    assert.equal(h.position.quantity, 7.1);
    h.send(1_000, h.plan.takeProfit1);
    h.send(1_250, h.plan.takeProfit1);
    let state = h.engine.snapshot();
    assert.equal(state.fills.length, 2);
    assert.equal(state.fills[1].reason, 'TP1');
    assert.equal(state.fills[1].quantity, 3.5);
    assert.equal(state.positions[0].remainingQuantity, 3.6);
    assert.equal(state.positions[0].tp1Hit, true);
    assert.equal(state.trades.length, 0);
    h.send(1_500, h.plan.takeProfit1);
    assert.equal(h.engine.snapshot().orders.length, 0, 'TP1 must not trigger twice');
    h.send(2_000, h.plan.takeProfit2);
    h.send(2_250, h.plan.takeProfit2);
    state = h.engine.snapshot();
    assert.deepEqual(state.fills.map(f => f.reason), ['CONFIRMED', 'TP1', 'TP2']);
    assert.equal(state.fills[2].quantity, 3.6);
    assert.equal(state.trades.length, 1);
    near(state.trades[0].exitPrice, (3.5 * h.plan.takeProfit1 + 3.6 * h.plan.takeProfit2) / 7.1);
    near(state.cash, 10_000 + 3.5 * 10.5 + 3.6 * 14);
  });

  test(`${side}: a gap through TP2 closes the full quantity once, without a synthetic TP1`, () => {
    const h = opened(side);
    h.send(1_000, mirror(122, side));
    assert.deepEqual(h.engine.snapshot().orders.map(o => o.reason), ['TP2']);
    h.send(1_250, mirror(123, side));
    h.send(1_500, mirror(124, side));
    const state = h.engine.snapshot();
    assert.equal(state.positions.length, 0);
    assert.equal(state.orders.length, 0);
    assert.equal(state.trades.length, 1);
    assert.deepEqual(state.fills.map(f => f.reason), ['CONFIRMED', 'TP2']);
    assert.equal(state.fills[1].quantity, h.position.quantity);
    near(state.trades[0].exitPrice, mirror(123, side));
  });

  for (const target of ['takeProfit1', 'takeProfit2'] as const) {
    test(`${side}: SL overrides a pending ${target} and exits the entire remaining position`, () => {
      const h = opened(side);
      h.send(1_000, h.plan[target]);
      h.send(1_100, h.plan.stopLoss);
      const pending = h.engine.snapshot().orders;
      assert.equal(pending.length, 1);
      assert.equal(pending[0].reason, 'SL');
      assert.equal(pending[0].quantity, h.position.quantity);
      assert.equal(pending[0].eligibleAt, epoch + 1_350);
      assert.equal(pending[0].signalTimestamp, epoch + 1_100);
      assert.equal(h.engine.snapshot().fills.length, 1);
      h.send(1_250, mirror(98, side), { trade: { timestamp: epoch + 1_100 } });
      h.send(1_349, mirror(98, side), { trade: { timestamp: epoch + 1_100 } });
      assert.equal(h.engine.snapshot().fills.length, 1, 'the original TP latency does not apply to SL');
      assert.equal(h.engine.snapshot().orders[0].eligibleAt, epoch + 1_350, 'repeated SL touches do not restart latency');
      // New ids alone cannot fill an upgraded exit on the upgrade's trade timestamp.
      h.send(1_350, mirror(98, side), { trade: { timestamp: epoch + 1_100 } });
      assert.equal(h.engine.snapshot().fills.length, 1);
      h.send(1_351, mirror(98, side));
      h.engine.tick(epoch + 1_352);
      const state = h.engine.snapshot();
      assert.equal(state.fills[1].reason, 'SL');
      assert.equal(state.fills[1].quantity, h.position.quantity);
      assert.equal(state.trades[0].reason, 'SL');
      near(state.trades[0].netPnl, -8 * h.position.quantity);
      const metrics = calculateAutoMetrics(state);
      assert.equal(metrics.winRate, 0);
      assert.equal(metrics.profitFactor, 0);
      near(metrics.maxDrawdownPct, (h.plan[target] - mirror(98, side)) * (side === 'LONG' ? 1 : -1) * h.position.quantity
        / (10_000 + Math.abs(h.plan[target] - h.position.entryPrice) * h.position.quantity) * 100);
    });
  }

  test(`${side}: an opposite alert cancels an entry or supersedes a partial profit exit`, () => {
    const waiting = harness();
    const plan = confirmedPlan({ side });
    waiting.confirm(plan);
    waiting.send(250, plan.confirmedEntry!, { alert: reversal(250, side, plan.confirmedEntry!) });
    assert.equal(waiting.engine.snapshot().orders.length, 0);
    assert.equal(waiting.engine.snapshot().fills.length, 0);
    assert.equal(waiting.engine.snapshot().events.at(-1)?.type, 'CANCEL');
    const h = opened(side);
    h.send(1_000, h.plan.takeProfit1);
    h.send(1_100, mirror(107, side), { alert: reversal(1_100, side, mirror(107, side)) });
    assert.equal(h.engine.snapshot().orders[0].reason, 'REVERSAL');
    assert.equal(h.engine.snapshot().orders[0].quantity, h.position.quantity);
    assert.equal(h.engine.snapshot().orders[0].eligibleAt, epoch + 1_350);
    assert.equal(h.engine.snapshot().orders[0].signalTimestamp, epoch + 1_100);
    h.send(1_250, mirror(105, side));
    h.send(1_349, mirror(105, side));
    assert.equal(h.engine.snapshot().fills.length, 1);
    h.send(1_350, mirror(105, side));
    assert.equal(h.engine.snapshot().trades[0].reason, 'REVERSAL');
    assert.equal(h.engine.snapshot().positions.length, 0);
  });

  test(`${side}: TP2 upgrading an already eligible TP1 restarts latency and cannot fill the upgrade trade`, () => {
    const h = opened(side);
    h.send(1_000, h.plan.takeProfit1);
    const originalId = h.engine.snapshot().orders[0].id;
    h.send(1_250, h.plan.takeProfit2);
    const order = h.engine.snapshot().orders[0];
    assert.equal(order.id, originalId);
    assert.equal(order.reason, 'TP2');
    assert.equal(order.quantity, h.position.quantity);
    assert.equal(order.eligibleAt, epoch + 1_500);
    assert.equal(order.signalTimestamp, epoch + 1_250);
    assert.equal(h.engine.snapshot().fills.length, 1);
    h.send(1_499, h.plan.takeProfit2);
    assert.equal(h.engine.snapshot().fills.length, 1);
    h.send(1_500, h.plan.takeProfit2);
    assert.equal(h.engine.snapshot().fills[1].quantity, h.position.quantity);
    assert.equal(h.engine.snapshot().trades[0].reason, 'TP2');
  });

  test(`${side}: SL wins over a simultaneous reversal and a later target cannot downgrade the exit`, () => {
    const h = opened(side);
    h.send(1_000, h.plan.stopLoss, { alert: reversal(1_000, side, h.plan.stopLoss) });
    assert.equal(h.engine.snapshot().orders[0].reason, 'SL');
    h.send(1_100, h.plan.takeProfit2);
    assert.equal(h.engine.snapshot().orders[0].reason, 'SL');
    assert.equal(h.engine.snapshot().orders[0].eligibleAt, epoch + 1_250);
    h.send(1_250, h.plan.confirmedEntry!);
    assert.equal(h.engine.snapshot().trades[0].reason, 'SL');
  });

  test(`${side}: exactly 15% retracement is eligible, less retracement cancels without chasing`, () => {
    const boundary = harness();
    boundary.confirm(confirmedPlan({ side }));
    boundary.send(250, mirror(108.5, side));
    assert.equal(boundary.engine.snapshot().positions.length, 1);
    for (const price of [108.5001, 109, 99, 116.5]) {
      const h = harness();
      h.confirm(confirmedPlan({ side }));
      h.send(100, mirror(price, side));
      assert.equal(h.engine.snapshot().orders.length, 0, `invalid entry at ${price} cancels before latency`);
      h.send(250, mirror(106, side));
      assert.equal(h.engine.snapshot().fills.length, 0, 'a canceled entry is not resurrected');
    }
    const slipped = harness({ slippageBps: 5 });
    slipped.confirm(confirmedPlan({ side }));
    slipped.send(250, mirror(108.5, side));
    assert.equal(slipped.engine.snapshot().fills.length, 0, 'slippage must also satisfy the retracement floor');
    assert.equal(slipped.engine.snapshot().orders.length, 0);
  });
}

test('risk budget includes entry/stop fees and slippage, and notional caps bind independently', () => {
  const riskLimited = opened('LONG', { feeBps: 10, slippageBps: 5 });
  const p = riskLimited.position;
  const unitRisk = p.entryPrice - 99 * 0.9995 + (p.entryPrice + 99 * 0.9995) * 0.001;
  assert.ok(p.quantity * unitRisk <= 50);
  assert.ok((p.quantity + rule.stepSize) * unitRisk > 50);
  const capped = opened('LONG', { riskPct: 5 });
  assert.equal(capped.position.quantity, 18.867);
  assert.ok(capped.position.quantity * 106 <= 2_000);
  assert.ok((capped.position.quantity + rule.stepSize) * 106 > 2_000);
});

test('unrealized gains cannot be spent as cash when a third entry exhausts available collateral', () => {
  const h = opened('LONG', { riskPct: 5, feeBps: 10 });
  h.send(500, 1_000);
  for (const [index, symbol] of ['ETHUSDT', 'SOLUSDT'].entries()) {
    const offset = 500 + index * 250;
    const plan = confirmedPlan({ id: `cash-${symbol}`, symbol, confirmedAt: epoch + offset });
    h.confirm(plan, offset);
    const before = h.engine.snapshot();
    h.send(offset + 250, 106, { trade: { symbol } });
    const state = h.engine.snapshot();
    const fill = state.fills.at(-1)!;
    assert.equal(fill.symbol, symbol);
    assert.ok(fill.price * fill.quantity + fill.fee <= before.cash + 1e-8);
    assert.ok(fill.price * fill.quantity <= calculateAutoEquity(before) * 0.2 + 1e-8);
    assert.ok(state.cash >= 0);
  }
  const state = h.engine.snapshot();
  assert.equal(state.positions.length, 3);
  assert.ok(state.cash < 106 * 1.0005 * 0.001 * 1.001, 'last entry is limited by free cash, not paper gains');
});

test('three slots count pending entries and positions, and duplicate symbols/plans never consume another slot', () => {
  const h = harness();
  h.confirm();
  h.confirm(confirmedPlan(), 1);
  h.confirm(confirmedPlan({ id: 'same-symbol', confirmedAt: epoch + 2 }), 2);
  for (const [index, symbol] of symbols.slice(1).entries()) {
    h.confirm(confirmedPlan({ id: symbol, symbol, confirmedAt: epoch + index + 3 }), index + 3);
  }
  assert.deepEqual(h.engine.snapshot().orders.map(o => o.symbol), symbols.slice(0, 3));
  for (const [index, symbol] of symbols.slice(0, 3).entries()) h.send(300 + index, 106, { trade: { symbol } });
  assert.equal(h.engine.snapshot().positions.length, 3);
  h.confirm(confirmedPlan({ id: 'held-symbol', confirmedAt: epoch + 500 }), 500);
  h.confirm(confirmedPlan({ id: 'fourth-again', symbol: 'XRPUSDT', confirmedAt: epoch + 501 }), 501);
  assert.equal(h.engine.snapshot().orders.length, 0);
  assert.equal(h.engine.snapshot().fills.length, 3);
  assert.ok(h.engine.snapshot().cash >= 0);
});

test('a lower configured slot limit is enforced and the same plan cannot reenter after closing', () => {
  const h = opened('LONG', { maxPositions: 1 });
  h.confirm(confirmedPlan({ id: 'second', symbol: 'ETHUSDT', confirmedAt: epoch + 500 }), 500);
  assert.equal(h.engine.snapshot().orders.length, 0);
  h.send(1_000, 120);
  h.send(1_250, 120);
  h.confirm({ ...h.plan, confirmedAt: epoch + 1_500 }, 1_500);
  assert.equal(h.engine.snapshot().orders.length, 0);
  h.confirm(confirmedPlan({ id: 'new-plan', confirmedAt: epoch + 1_750 }), 1_750);
  h.send(2_000, 106);
  assert.equal(h.engine.snapshot().positions.length, 1);
  assert.equal(h.engine.snapshot().fills.length, 3);
});

test('exchange maximum quantity and notional cap sizing without rounding up', () => {
  for (const [limits, expected] of [
    [{ maxQty: 2.005 }, 2.005], [{ maxNotional: 200 }, 1.886],
  ] as const) {
    const h = opened('LONG', {}, { BTCUSDT: { ...rule, ...limits } });
    assert.equal(h.position.quantity, expected);
  }
});

test('minimum quantity/notional must permit both the entry and a rounded TP1 half', () => {
  for (const limits of [
    { minQty: 8 }, { minQty: 4 }, { minNotional: 800 }, { minNotional: 500 },
    { maxQty: 0.001 }, { maxNotional: 4 },
  ]) {
    const h = harness({}, { BTCUSDT: { ...rule, ...limits } });
    h.confirm();
    h.send(250, 106);
    assert.equal(h.engine.snapshot().fills.length, 0, JSON.stringify(limits));
    assert.equal(h.engine.snapshot().orders.length, 0);
  }
  const small = harness({ initialCapital: 100 });
  small.confirm();
  small.send(250, 106);
  assert.equal(small.engine.snapshot().fills.length, 0);
  assert.equal(small.engine.snapshot().cash, 100);
});

test('entry expires at five seconds, but a fresh trade just before expiry can fill', () => {
  const before = harness();
  before.confirm();
  before.send(4_999, 106);
  assert.equal(before.engine.snapshot().fills.length, 1);
  for (const withFrame of [false, true]) {
    const h = harness();
    h.confirm();
    if (withFrame) h.send(5_000, 106);
    else h.engine.tick(epoch + 5_000);
    assert.equal(h.engine.snapshot().orders.length, 0);
    assert.equal(h.engine.snapshot().fills.length, 0);
    h.confirm(confirmedPlan(), 5_001);
    assert.equal(h.engine.snapshot().orders.length, 0, 'expired plan is not requeued');
  }
});

test('pre-start, stale, unconfirmed and non-confirmed-event plans never backfill entries', () => {
  for (const changes of [
    { confirmedAt: epoch - 1 }, { confirmedAt: undefined }, { stale: true }, { state: 'WAIT_CONFIRMATION' as const },
  ]) {
    const h = harness();
    h.confirm(confirmedPlan(changes));
    h.send(250, 106);
    assert.equal(h.engine.snapshot().fills.length, 0, JSON.stringify(changes));
  }
  const old = harness();
  old.confirm(confirmedPlan(), 5_001);
  assert.equal(old.engine.snapshot().orders.length, 0);
  const wrongEvent = harness();
  const frame = wrongEvent.frame(0, 106, { plans: [confirmedPlan()] });
  frame.confirmations[0].event.type = 'follow-tp1';
  wrongEvent.engine.processFrame(frame);
  assert.equal(wrongEvent.engine.snapshot().orders.length, 0);
});

test('wrong-market, spot-short, unknown-symbol and invalid protective levels are rejected', () => {
  for (const changes of [
    { marketType: 'spot' as const }, { symbol: 'UNKNOWNUSDT' }, { confirmedEntry: NaN },
    { confirmedEntry: 0 }, { stopLoss: 106 }, { stopLoss: Infinity }, { takeProfit1: 105 },
    { takeProfit2: 116.5 }, { impulse: 0 },
  ]) {
    const h = harness();
    h.confirm(confirmedPlan(changes));
    assert.equal(h.engine.snapshot().orders.length, 0, JSON.stringify(changes));
  }
  const spot = harness({ marketType: 'spot' });
  spot.confirm(confirmedPlan({ side: 'SHORT', marketType: 'spot' }));
  assert.equal(spot.engine.snapshot().orders.length, 0);
  assert.equal(opened('LONG', { marketType: 'spot' }).engine.snapshot().fundingStatus, 'NOT_REQUIRED');
});

test('replayed ids, older timestamps, wrong markets, invalid prices and stale trade times cannot fill an entry', () => {
  const h = harness();
  const signal = h.confirm();
  h.engine.processFrame({ ...signal, receivedAt: epoch + 250 });
  h.send(251, 106, { trade: { lastTradeId: signal.trade.lastTradeId } });
  h.send(252, 106, { trade: { timestamp: epoch - 1 } });
  h.send(253, 106, { marketType: 'spot' });
  h.send(254, 0);
  h.send(255, NaN);
  h.send(256, Infinity);
  h.send(257, 106, { trade: { timestamp: epoch - 5_001 } });
  h.send(258, 106, { trade: { timestamp: epoch + 5_259 } });
  assert.equal(h.engine.snapshot().fills.length, 0);
  h.send(300, 106);
  assert.equal(h.engine.snapshot().fills.length, 1);
});

test('an id-less same-timestamp trade is not new, and duplicate trades cannot refresh a held position', () => {
  const h = harness();
  const signal = h.frame(0, 106, { trade: { lastTradeId: undefined }, plans: [confirmedPlan()] });
  h.engine.processFrame(signal);
  h.send(250, 106, { trade: { timestamp: epoch, lastTradeId: undefined } });
  assert.equal(h.engine.snapshot().fills.length, 0);
  const entry = h.send(251, 106, { trade: { lastTradeId: undefined } });
  h.engine.processFrame({ ...entry, receivedAt: epoch + 1_000 });
  assert.equal(h.engine.snapshot().positions[0].lastReceivedAt, epoch + 251);
});

test('a greater-than-five-second position freshness gap interrupts with the last mark, never a fabricated close', () => {
  const h = opened();
  h.send(1_000, 117);
  h.engine.tick(epoch + 6_000);
  assert.equal(h.engine.snapshot().status, 'RUNNING');
  h.send(6_001, 120);
  const state = h.engine.snapshot();
  assert.equal(state.status, 'INTERRUPTED');
  assert.equal(state.endedAt, epoch + 6_001);
  assert.equal(state.positions[0].incomplete, true);
  assert.equal(state.positions[0].currentPrice, 117);
  assert.equal(state.orders.length, 0);
  assert.equal(state.fills.length, 1);
  assert.equal(state.trades.length, 0);
  near(state.lastEquity, 10_000 + 11 * h.position.quantity);
  assert.equal(calculateAutoMetrics(state).incompletePositions, 1);
  assert.equal(calculateAutoMetrics(state).completedTrades, 0);
  assert.equal(calculateAutoMetrics(state).winRate, null);
  h.send(6_250, 120);
  assert.equal(h.engine.snapshot().fills.length, 1);
  assert.deepEqual(h.engine.takeNotifications().map(n => n.type), ['auto-entry', 'auto-interrupted']);
});

test('plan archives preserve accepted levels after cancellation/closure and are isolated from caller changes', () => {
  const pending = harness();
  const plan = confirmedPlan();
  pending.confirm(plan);
  plan.stopLoss = 1;
  assert.equal(pending.engine.snapshot().plans[0].stopLoss, 99);
  assert.equal(pending.engine.snapshot().orders[0].plan?.stopLoss, 99);
  pending.engine.pause(epoch + 100);
  assert.equal(pending.engine.snapshot().orders.length, 0);
  assert.equal(pending.engine.snapshot().plans.length, 1);
  const h = opened();
  h.send(1_000, 120);
  h.send(1_250, 120);
  const state = h.engine.snapshot();
  assert.equal(state.plans.length, 1);
  assert.equal(state.trades[0].planId, state.plans[0].id);
  assert.equal(state.plans[0].confirmedEntry, 106);
  state.plans[0].takeProfit2 = 1;
  assert.equal(h.engine.snapshot().plans[0].takeProfit2, 120);
});

test('equity peak and drawdown retain sub-sample excursions even after equity recovers', () => {
  const h = opened();
  h.send(500, 115);
  h.engine.tick(epoch + 501);
  const peak = 10_000 + 9 * h.position.quantity;
  near(h.engine.snapshot().equityPeak, peak);
  h.send(600, 100);
  h.engine.tick(epoch + 601);
  const trough = 10_000 - 6 * h.position.quantity;
  const drawdown = (peak - trough) / peak * 100;
  assert.ok(h.engine.snapshot().equity.every(point => point.timestamp < epoch + 500),
    'the subsecond peak and trough are not regular equity samples');
  assert.ok(h.engine.snapshot().riskExtrema.some(point => point.timestamp === epoch + 500 && Math.abs(point.value - peak) < 1e-8));
  assert.ok(h.engine.snapshot().riskExtrema.some(point => point.timestamp === epoch + 600 && Math.abs(point.value - trough) < 1e-8));
  near(h.engine.snapshot().maxDrawdownPct, drawdown);
  h.send(700, 106);
  h.engine.tick(epoch + 701);
  near(h.engine.snapshot().equityPeak, peak);
  near(h.engine.snapshot().maxDrawdownPct, drawdown);
  near(calculateAutoMetrics(h.engine.snapshot()).maxDrawdownPct, drawdown);
});

for (const [fundingOffset, expectedPeak] of [[400, 1_099.9], [550, 1_100]] as const) {
  test(`historical funding at ${fundingOffset}ms corrects sampled equity and subsecond peak/trough risk`, () => {
    const h = opened('LONG', { initialCapital: 1_000, riskPct: 5 }, { BTCUSDT: { ...rule, maxQty: 1 } });
    assert.equal(h.position.quantity, 1);
    h.send(500, 206);
    h.send(600, 106);
    h.engine.closeAll(epoch + 650);
    h.send(900, 106);
    const before = h.engine.snapshot();
    assert.equal(before.status, 'COMPLETED');
    near(before.equityPeak, 1_100);
    assert.equal(before.peakTimestamp, epoch + 500);
    near(before.maxDrawdownPct, 100 / 1_100 * 100);
    assert.ok(before.equity.every(point => point.timestamp !== epoch + 500 && point.timestamp !== epoch + 600));
    assert.ok(before.riskExtrema.some(point => point.timestamp === epoch + 500 && point.value === 1_100));
    assert.ok(before.riskExtrema.some(point => point.timestamp === epoch + 600 && point.value === 1_000));
    const record: AutoFundingRecord = {
      symbol: 'BTCUSDT', fundingTime: epoch + fundingOffset, fundingRate: 0.001, markPrice: 100,
    };
    h.engine.applyFunding([record], epoch + 900, epoch + 1_000);
    const state = h.engine.snapshot();
    const expectedTrough = 999.9;
    const expectedDrawdown = (expectedPeak - expectedTrough) / expectedPeak * 100;
    near(state.fundingCharges[0].amount, 0.1);
    near(state.cash, expectedTrough);
    near(state.equityPeak, expectedPeak);
    assert.equal(state.peakTimestamp, epoch + 500);
    near(state.maxDrawdownPct, expectedDrawdown);
    near(calculateAutoMetrics(state).maxDrawdownPct, expectedDrawdown);
    near(state.equity.at(-1)!.value, state.cash);
    near(state.equity.at(-1)!.value, calculateAutoEquity(state));
    for (const [index, point] of before.equity.entries()) {
      near(state.equity[index].value, point.value - (point.timestamp >= record.fundingTime ? 0.1 : 0));
    }
    for (const [index, point] of before.riskExtrema.entries()) {
      assert.equal(state.riskExtrema[index].timestamp, point.timestamp);
      near(state.riskExtrema[index].value, point.value - (point.timestamp >= record.fundingTime ? 0.1 : 0));
    }
    assert.ok(state.riskExtrema.some(point => point.timestamp === epoch + 500 && Math.abs(point.value - expectedPeak) < 1e-8));
    assert.ok(state.riskExtrema.some(point => point.timestamp === epoch + 600 && Math.abs(point.value - expectedTrough) < 1e-8));
    h.engine.applyFunding([record], epoch + 900, epoch + 1_100);
    const repeated = h.engine.snapshot();
    assert.equal(repeated.fundingCharges.length, 1);
    near(repeated.equityPeak, expectedPeak);
    near(repeated.maxDrawdownPct, expectedDrawdown);
    assert.deepEqual(repeated.riskExtrema, state.riskExtrema);
    state.riskExtrema[0].value = 1;
    assert.equal(h.engine.snapshot().riskExtrema[0].value, 1_000);
  });
}

test('historical funding can move the corrected peak timestamp to an earlier subsecond extreme', () => {
  const h = opened('LONG', { initialCapital: 1_000, riskPct: 5 }, { BTCUSDT: { ...rule, maxQty: 1 } });
  h.send(300, 205.95);
  h.send(400, 206);
  h.send(450, 106);
  h.engine.closeAll(epoch + 500);
  h.send(750, 106);
  const before = h.engine.snapshot();
  near(before.equityPeak, 1_100);
  assert.equal(before.peakTimestamp, epoch + 400);
  h.engine.applyFunding([{
    symbol: 'BTCUSDT', fundingTime: epoch + 350, fundingRate: 0.001, markPrice: 100,
  }], epoch + 750, epoch + 800);
  const state = h.engine.snapshot();
  near(state.equityPeak, 1_099.95);
  assert.equal(state.peakTimestamp, epoch + 300);
  near(state.maxDrawdownPct, (1_099.95 - 999.9) / 1_099.95 * 100);
  near(calculateAutoMetrics(state).maxDrawdownPct, state.maxDrawdownPct);
  near(state.equity.at(-1)!.value, state.cash);
});

test('stream health blocks fills/resume and interrupts only after five seconds continuously unhealthy', () => {
  const h = harness();
  h.confirm();
  h.engine.setStreamHealthy(false, epoch + 100);
  h.send(250, 106);
  assert.equal(h.engine.snapshot().fills.length, 0);
  h.engine.pause(epoch + 300);
  h.engine.resume(epoch + 400);
  assert.equal(h.engine.snapshot().status, 'PAUSED');
  h.engine.setStreamHealthy(true, epoch + 500);
  h.engine.resume(epoch + 500);
  h.engine.setStreamHealthy(false, epoch + 1_000);
  h.engine.setStreamHealthy(false, epoch + 2_000);
  h.engine.tick(epoch + 6_000);
  assert.equal(h.engine.snapshot().status, 'RUNNING');
  h.engine.tick(epoch + 6_001);
  assert.equal(h.engine.snapshot().status, 'INTERRUPTED');
  assert.equal(h.engine.snapshot().endedAt, epoch + 6_001);
});

test('stream interruption starts at the original data timestamp, not when unhealthy status is noticed', () => {
  const h = harness();
  h.engine.setStreamHealthy(false, epoch + 4_000, epoch + 1_000);
  h.engine.setStreamHealthy(false, epoch + 5_000, epoch + 2_000);
  h.engine.tick(epoch + 6_000);
  assert.equal(h.engine.snapshot().status, 'RUNNING', 'exactly five seconds is still within tolerance');
  h.engine.tick(epoch + 6_001);
  const state = h.engine.snapshot();
  assert.equal(state.status, 'INTERRUPTED');
  assert.equal(state.endedAt, epoch + 6_001);
  assert.equal(state.positions.length, 0);
  assert.equal(state.fills.length, 0);
});

for (const held of [false, true]) {
  test(`healthy recovery after a five-second data gap cannot revive a batch ${held ? 'with' : 'without'} holdings`, () => {
    const h = held ? opened() : harness();
    const dataOffset = held ? 250 : 1_000;
    h.engine.setStreamHealthy(false, epoch + dataOffset + 3_000, epoch + dataOffset);
    assert.equal(h.engine.snapshot().status, 'RUNNING');
    // No tick occurs during the gap: the recovery callback itself must interrupt.
    const recoveredAt = epoch + dataOffset + 5_001;
    h.engine.setStreamHealthy(true, recoveredAt);
    const state = h.engine.snapshot();
    assert.equal(state.status, 'INTERRUPTED');
    assert.equal(state.endedAt, recoveredAt);
    assert.equal(state.positions.length, held ? 1 : 0);
    assert.equal(state.fills.length, held ? 1 : 0);
    assert.equal(state.orders.length, 0);
    assert.equal(state.trades.length, 0);
    if (held) {
      assert.equal(state.positions[0].incomplete, true);
      assert.equal(state.positions[0].currentPrice, 106);
    }
    h.engine.resume(recoveredAt + 1);
    const nextOffset = recoveredAt - epoch + 2;
    h.confirm(confirmedPlan({ id: 'after-recovery', confirmedAt: epoch + nextOffset }), nextOffset);
    h.send(nextOffset + 250, 106);
    assert.equal(h.engine.snapshot().status, 'INTERRUPTED');
    assert.equal(h.engine.snapshot().endedAt, recoveredAt);
    assert.equal(h.engine.snapshot().fills.length, state.fills.length);
    assert.deepEqual(h.engine.takeNotifications().filter(n => n.type === 'auto-interrupted').map(n => n.timestamp), [recoveredAt]);
  });
}

test('healthy recovery at exactly five seconds permits a new confirmation without interrupting', () => {
  const h = harness();
  h.engine.setStreamHealthy(false, epoch + 4_000, epoch + 1_000);
  h.engine.setStreamHealthy(true, epoch + 6_000);
  assert.equal(h.engine.snapshot().status, 'RUNNING');
  h.confirm(confirmedPlan({ id: 'within-tolerance', confirmedAt: epoch + 6_100 }), 6_100);
  h.send(6_350, 106);
  assert.equal(h.engine.snapshot().positions.length, 1);
  assert.equal(h.engine.snapshot().events.some(event => event.type === 'INTERRUPTED'), false);
});

test('pause cancels entries, keeps exit tracking, and does not replay observed paused confirmations after resume', () => {
  const h = opened();
  h.confirm(confirmedPlan({ id: 'pending', symbol: 'ETHUSDT', confirmedAt: epoch + 500 }), 500);
  h.engine.pause(epoch + 600);
  assert.equal(h.engine.snapshot().status, 'PAUSED');
  assert.equal(h.engine.snapshot().orders.length, 0);
  const pausedPlan = confirmedPlan({ id: 'paused', symbol: 'SOLUSDT', confirmedAt: epoch + 700 });
  h.confirm(pausedPlan, 700);
  h.send(1_000, 120);
  h.send(1_250, 120);
  assert.equal(h.engine.snapshot().trades.length, 1);
  assert.equal(h.engine.snapshot().status, 'PAUSED');
  h.engine.resume(epoch + 1_500);
  h.confirm(pausedPlan, 1_600);
  assert.equal(h.engine.snapshot().orders.length, 0);
  h.confirm(confirmedPlan({ id: 'fresh', confirmedAt: epoch + 1_750 }), 1_750);
  h.send(2_000, 106);
  assert.equal(h.engine.snapshot().positions.length, 1);
});

test('a confirmation created during pause but first delivered after resume must not backfill an entry', () => {
  const h = harness();
  h.engine.pause(epoch + 100);
  const pausedPlan = confirmedPlan({ id: 'delayed-paused', confirmedAt: epoch + 500 });
  h.engine.resume(epoch + 1_000);
  h.confirm(pausedPlan, 1_100);
  h.send(1_350, 106);
  assert.equal(h.engine.snapshot().fills.length, 0, 'resume must accept only newly confirmed signals');
  assert.equal(h.engine.snapshot().orders.length, 0);
});

test('drain cancels pending entries, refuses new ones, and completes only after existing positions exit', () => {
  const h = opened();
  h.confirm(confirmedPlan({ id: 'pending', symbol: 'ETHUSDT', confirmedAt: epoch + 500 }), 500);
  h.engine.drain(epoch + 600);
  assert.equal(h.engine.snapshot().status, 'DRAINING');
  assert.equal(h.engine.snapshot().orders.length, 0);
  assert.throws(() => h.engine.start(defaultAutoTradingConfig('futures'), epoch + 650));
  h.confirm(confirmedPlan({ id: 'draining', symbol: 'SOLUSDT', confirmedAt: epoch + 700 }), 700);
  h.send(1_000, 116.5);
  h.send(1_250, 116.5);
  assert.equal(h.engine.snapshot().status, 'DRAINING');
  h.send(1_500, 120);
  h.send(1_750, 120);
  const state = h.engine.snapshot();
  assert.equal(state.status, 'COMPLETED');
  assert.equal(state.endedAt, epoch + 1_750);
  assert.equal(state.positions.length, 0);
  assert.equal(state.orders.length, 0);
  assert.equal(state.trades.length, 1);
  h.send(2_000, 106, { plans: [confirmedPlan({ id: 'after-complete', confirmedAt: epoch + 2_000 })] });
  assert.equal(h.engine.snapshot().fills.length, 3);
  const empty = harness();
  empty.confirm();
  empty.engine.drain(epoch + 100);
  assert.equal(empty.engine.snapshot().status, 'COMPLETED');
  assert.equal(empty.engine.snapshot().fills.length, 0);
});

test('closeAll drains and queues a delayed manual exit instead of filling at the last mark', () => {
  const h = opened();
  h.engine.closeAll(epoch + 500);
  assert.equal(h.engine.snapshot().status, 'DRAINING');
  assert.equal(h.engine.snapshot().orders[0].reason, 'MANUAL');
  h.engine.tick(epoch + 750);
  assert.equal(h.engine.snapshot().fills.length, 1);
  h.send(750, 105);
  assert.equal(h.engine.snapshot().trades[0].reason, 'MANUAL');
  assert.equal(h.engine.snapshot().status, 'COMPLETED');
});

for (const side of ['LONG', 'SHORT'] as const) {
  test(`${side}: fifteen-minute expiry uses continuous fresh trades and still waits for latency and a later fill`, () => {
    const h = opened(side);
    const deadline = h.position.openedAt - epoch + 900_000;
    for (let offset = 4_250; offset < deadline; offset += 4_000) h.send(offset, h.plan.confirmedEntry!);
    h.send(deadline - 1, h.plan.confirmedEntry!);
    assert.equal(h.engine.snapshot().orders.length, 0);
    h.engine.tick(epoch + deadline);
    let state = h.engine.snapshot();
    assert.equal(state.status, 'RUNNING');
    assert.equal(state.orders[0].reason, 'TIMEOUT');
    assert.equal(state.orders[0].eligibleAt, epoch + deadline + 250);
    assert.equal(state.fills.length, 1);
    h.send(deadline + 249, h.plan.confirmedEntry!);
    assert.equal(h.engine.snapshot().fills.length, 1);
    h.send(deadline + 250, mirror(107, side));
    state = h.engine.snapshot();
    assert.equal(state.trades.length, 1);
    assert.equal(state.trades[0].reason, 'TIMEOUT');
    assert.equal(state.trades[0].closedAt, epoch + deadline + 250);
    assert.equal(state.positions.length, 0);
    assert.equal(state.events.some(e => e.type === 'INTERRUPTED'), false);
    near(state.trades[0].netPnl, h.position.quantity);
  });
}

for (const side of ['LONG', 'SHORT'] as const) {
  for (const fundingRate of [0.001, -0.001]) {
    test(`${side}: signed funding ${fundingRate} settles the open position and closed net PnL only once`, () => {
      const h = opened(side);
      const record: AutoFundingRecord = { symbol: 'BTCUSDT', fundingTime: epoch + 500, fundingRate, markPrice: 100 };
      const before = h.engine.snapshot();
      const amount = (side === 'LONG' ? 1 : -1) * h.position.quantity * 100 * fundingRate;
      h.engine.applyFunding([record, record], epoch + 500, epoch + 500);
      let state = h.engine.snapshot();
      assert.equal(state.fundingStatus, 'SETTLED');
      assert.equal(state.fundingThrough, epoch + 500);
      assert.equal(state.fundingCharges.length, 1);
      near(state.fundingCharges[0].amount, amount);
      near(state.cash, before.cash - amount);
      near(state.positions[0].funding, amount);
      near(calculateAutoMetrics(state).funding, amount);
      near(calculateAutoMetrics(state).realizedPnl, -amount);
      h.engine.applyFunding([record], epoch + 600, epoch + 600);
      assert.equal(h.engine.snapshot().fundingCharges.length, 1);
      h.send(1_000, h.plan.takeProfit2);
      h.send(1_250, h.plan.takeProfit2);
      state = h.engine.snapshot();
      assert.equal(state.fundingStatus, 'PENDING', 'new fills need funding coverage again');
      near(state.trades[0].funding, amount);
      near(state.trades[0].netPnl, 14 * h.position.quantity - amount);
      h.engine.applyFunding([record], epoch + 1_250, epoch + 1_500);
      state = h.engine.snapshot();
      near(state.cash, 10_000 + state.trades[0].netPnl);
      assert.equal(state.fundingCharges.length, 1);
      assert.equal(state.fundingStatus, 'SETTLED');
    });
  }

  test(`${side}: delayed historical funding uses the quantity held at settlement, including partial exit boundaries`, () => {
    const h = opened(side);
    h.send(1_000, h.plan.takeProfit1);
    h.send(1_250, h.plan.takeProfit1);
    const half = h.engine.snapshot().fills[1].quantity;
    h.send(2_000, h.plan.takeProfit2);
    h.send(2_250, h.plan.takeProfit2);
    const cashBefore = h.engine.snapshot().cash;
    // Entry at settlement is ineligible; quantities exited at settlement are already excluded.
    const records = [250, 500, 1_249, 1_250, 1_500, 2_250, 2_500].map(offset => ({
      symbol: 'BTCUSDT', fundingTime: epoch + offset, fundingRate: 0.001, markPrice: 100,
    }));
    h.engine.applyFunding(records, epoch + 2_500, epoch + 2_500);
    let state = h.engine.snapshot();
    assert.deepEqual(state.fundingCharges.map(c => c.timestamp - epoch), [500, 1_249, 1_250, 1_500]);
    const sign = side === 'LONG' ? 1 : -1;
    near(state.fundingCharges[0].amount, sign * h.position.quantity * 0.1);
    near(state.fundingCharges[2].amount, sign * (h.position.quantity - half) * 0.1);
    const total = sign * (2 * h.position.quantity + 2 * (h.position.quantity - half)) * 0.1;
    near(state.trades[0].funding, total);
    near(state.trades[0].netPnl, state.trades[0].grossPnl - total);
    near(state.cash, cashBefore - total);
    near(calculateAutoMetrics(state).realizedPnl, state.trades[0].netPnl);
    h.engine.applyFunding([...records, { ...records[1], symbol: 'ETHUSDT' }], epoch + 2_500, epoch + 2_750);
    state = h.engine.snapshot();
    assert.equal(state.fundingCharges.length, 4);
    near(state.cash, cashBefore - total);
  });
}

test('funding history distinguishes consecutive positions in the same symbol', () => {
  const h = opened();
  h.send(1_000, 120);
  h.send(1_250, 120);
  h.confirm(confirmedPlan({ id: 'next', confirmedAt: epoch + 1_500 }), 1_500);
  h.send(1_750, 106);
  const records = [500, 2_000].map(offset => ({
    symbol: 'BTCUSDT', fundingTime: epoch + offset, fundingRate: 0.001, markPrice: 100,
  }));
  h.engine.applyFunding(records, epoch + 2_000, epoch + 2_000);
  const state = h.engine.snapshot();
  assert.equal(state.fundingCharges.length, 2);
  assert.equal(new Set(state.fundingCharges.map(c => c.positionId)).size, 2);
  assert.equal(state.fundingCharges[0].positionId, state.trades[0].id);
  assert.equal(state.fundingCharges[1].positionId, state.positions[0].id);
  h.engine.applyFunding(records, epoch + 2_000, epoch + 2_250);
  assert.equal(h.engine.snapshot().fundingCharges.length, 2);
});

test('funding deduplicates by position and settlement, not globally by settlement time', () => {
  const h = opened();
  h.confirm(confirmedPlan({ id: 'eth', symbol: 'ETHUSDT', confirmedAt: epoch + 300 }), 300);
  h.send(550, 106, { trade: { symbol: 'ETHUSDT' } });
  const records = ['BTCUSDT', 'ETHUSDT'].map(symbol => ({
    symbol, fundingTime: epoch + 1_000, fundingRate: 0.001, markPrice: 100,
  }));
  h.engine.applyFunding([...records, ...records], epoch + 1_000, epoch + 1_000);
  const state = h.engine.snapshot();
  assert.equal(state.fundingCharges.length, 2);
  assert.equal(new Set(state.fundingCharges.map(c => c.positionId)).size, 2);
  assert.ok(state.positions.every(p => p.funding > 0));
  near(state.fundingCharges.reduce((sum, c) => sum + c.amount, 0),
    state.positions.reduce((sum, p) => sum + p.quantity * 0.1, 0));
});

test('funding coverage stays pending until through covers all fills or the end of an interrupted batch', () => {
  const h = opened();
  h.engine.applyFunding([], epoch + 249, epoch + 300);
  assert.equal(h.engine.snapshot().fundingStatus, 'PENDING');
  h.engine.applyFunding([], epoch + 250, epoch + 400);
  assert.equal(h.engine.snapshot().fundingStatus, 'SETTLED');
  h.send(500, 107);
  h.engine.interrupt(epoch + 600, 'test interruption');
  const record = { symbol: 'BTCUSDT', fundingTime: epoch + 500, fundingRate: 0.001, markPrice: 100 };
  h.engine.applyFunding([record, { ...record, fundingTime: epoch + 501 }], epoch + 599, epoch + 700);
  assert.equal(h.engine.snapshot().fundingStatus, 'PENDING');
  assert.deepEqual(h.engine.snapshot().fundingCharges.map(c => c.timestamp), [epoch + 500]);
  h.engine.applyFunding([record], epoch + 600, epoch + 800);
  assert.equal(h.engine.snapshot().fundingStatus, 'SETTLED');
  assert.equal(h.engine.snapshot().fundingCharges.length, 1);
});

test('spot ignores funding; futures expose failure, accept zero rates and reject nonfinite settlement data', () => {
  const record: AutoFundingRecord = { symbol: 'BTCUSDT', fundingTime: epoch + 500, fundingRate: 0, markPrice: 100 };
  const spot = opened('LONG', { marketType: 'spot' });
  const original = spot.engine.snapshot();
  spot.engine.applyFunding([record], epoch + 500, epoch + 500);
  assert.deepEqual(spot.engine.snapshot(), original);
  const h = opened();
  h.engine.fundingFailed(epoch + 300);
  assert.equal(h.engine.snapshot().fundingStatus, 'ERROR');
  h.engine.applyFunding([record], epoch + 500, epoch + 500);
  assert.equal(h.engine.snapshot().fundingStatus, 'SETTLED');
  assert.equal(h.engine.snapshot().fundingCharges[0].amount, 0);
  for (const changes of [
    { markPrice: 0 }, { markPrice: -1 }, { markPrice: NaN }, { markPrice: Infinity },
    { fundingRate: NaN }, { fundingRate: Infinity }, { fundingTime: NaN }, { fundingTime: Infinity },
  ]) assert.throws(() => h.engine.applyFunding([{ ...record, ...changes }], epoch + 600, epoch + 600));
  assert.equal(h.engine.snapshot().fundingCharges.length, 1);
});

test('restoring an active snapshot marks it incomplete without mutating the supplied history or inventing fills', () => {
  const h = opened();
  const original = h.engine.snapshot();
  const restored = new AutoTradingEngine('futures');
  restored.restoreInterrupted(original, epoch + 1_000);
  const state = restored.snapshot();
  assert.equal(state.status, 'INTERRUPTED');
  assert.equal(state.positions[0].incomplete, true);
  assert.equal(state.fills.length, 1);
  assert.equal(state.trades.length, 0);
  assert.equal(original.status, 'RUNNING');
  assert.equal(original.positions[0].incomplete, undefined);
  restored.interrupt(epoch + 2_000, 'again');
  assert.equal(restored.snapshot().endedAt, epoch + 1_000);
});

const invalidConfigs: Array<[string, Partial<AutoTradingConfig>]> = [
  ['unknown market', { marketType: 'margin' as MarketType }],
  ...[0, 99, NaN, Infinity].map(value => [`capital ${value}`, { initialCapital: value }] as [string, Partial<AutoTradingConfig>]),
  ...[0, -1, 5.01, NaN, Infinity].map(value => [`risk ${value}`, { riskPct: value }] as [string, Partial<AutoTradingConfig>]),
  ...[0, -1, 20.01, NaN, Infinity].map(value => [`notional ${value}`, { maxNotionalPct: value }] as [string, Partial<AutoTradingConfig>]),
  ...[0, 4, 1.5, NaN, Infinity].map(value => [`slots ${value}`, { maxPositions: value }] as [string, Partial<AutoTradingConfig>]),
  ...[-1, 100.01, NaN, Infinity].map(value => [`fees ${value}`, { feeBps: value }] as [string, Partial<AutoTradingConfig>]),
  ...[-1, 100.01, NaN, Infinity].map(value => [`slippage ${value}`, { slippageBps: value }] as [string, Partial<AutoTradingConfig>]),
  ...[249, 250.5, 5_000, 5_001, NaN, Infinity].map(value => [`latency ${value}`, { latencyMs: value }] as [string, Partial<AutoTradingConfig>]),
];
for (const [label, changes] of invalidConfigs) {
  test(`invalid config: ${label} is rejected without starting a batch`, () => {
    const engine = new AutoTradingEngine('futures');
    engine.setRules({ BTCUSDT: rule });
    engine.setStreamHealthy(true, epoch);
    assert.throws(() => engine.start({ ...defaultAutoTradingConfig('futures'), ...changes }, epoch));
    assert.equal(engine.snapshot().status, 'IDLE');
    assert.equal(engine.snapshot().events.length, 0);
  });
}

test('inclusive config bounds are accepted and copied rather than retained by reference', () => {
  for (const changes of [
    { initialCapital: 100, riskPct: 5, maxNotionalPct: 20, maxPositions: 1, feeBps: 0, slippageBps: 0, latencyMs: 250 },
    { maxPositions: 3, feeBps: 100, slippageBps: 100, latencyMs: 4_999 },
  ]) {
    const engine = new AutoTradingEngine('futures');
    engine.setRules({ BTCUSDT: rule });
    engine.setStreamHealthy(true, epoch);
    const config = { ...defaultAutoTradingConfig('futures'), ...changes };
    const settings = { threshold: 2 };
    engine.start(config, epoch, settings);
    config.riskPct = 100;
    settings.threshold = 100;
    assert.equal(engine.snapshot().status, 'RUNNING');
    assert.ok(engine.snapshot().config.riskPct <= 5);
    assert.equal(engine.snapshot().signalSettings?.threshold, 2);
  }
});

for (const [label, changes] of [
  ['zero step', { stepSize: 0 }], ['nonfinite step', { stepSize: NaN }],
  ['negative maximum', { maxQty: -1 }], ['contradictory quantity bounds', { minQty: 10, maxQty: 1 }],
  ['nonfinite minimum quantity', { minQty: NaN }], ['negative minimum quantity', { minQty: -1 }],
  ['nonfinite minimum notional', { minNotional: NaN }], ['negative minimum notional', { minNotional: -1 }],
  ['contradictory notional bounds', { minNotional: 100, maxNotional: 50 }],
] as const) {
  test(`invalid rules: ${label} must fail closed without a fill`, () => {
    const h = harness({}, { BTCUSDT: { ...rule, ...changes } });
    h.confirm();
    h.send(250, 106);
    assert.equal(h.engine.snapshot().fills.length, 0, 'malformed exchange rules must not authorize trading');
    assert.equal(h.engine.snapshot().positions.length, 0);
    assert.equal(h.engine.snapshot().cash, 10_000);
  });
}
