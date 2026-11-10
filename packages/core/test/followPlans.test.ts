import test from 'node:test';
import assert from 'node:assert/strict';
import { FollowPlanTracker, createFollowPlan } from '../src/services/followPlans.ts';
import { followPlanLines } from '../src/services/followPlanLines.ts';
import { MarketAlertDetector } from '../src/services/marketAlerts.ts';
import type { MarketAlert } from '../src/services/marketAlerts.ts';
import type { AggregateTradeData } from '../src/services/binance.ts';

const epoch = 1_800_000_000_000;
const alert = (changes: Partial<MarketAlert> = {}): MarketAlert => ({
  id: 'pump-1', type: 'pump', symbol: 'TESTUSDT', marketType: 'futures', title: 'pump', message: '',
  price: 102, referencePrice: 100, referenceTimestamp: epoch - 100, timestamp: epoch, ...changes,
});
const trade = (price: number, offset: number, changes: Partial<AggregateTradeData> = {}): AggregateTradeData => ({
  symbol: 'TESTUSDT', price, timestamp: epoch + offset, lastTradeId: offset + 1,
  quantity: 1, quoteValue: price, side: 'buy', ...changes,
});
const state = (tracker: FollowPlanTracker) => tracker.getPlans()[0];
function confirmed(short = false) {
  const tracker = new FollowPlanTracker();
  tracker.observeAlert(alert(short ? { type: 'dump', price: 98 } : {}), epoch);
  tracker.processTrade(trade(short ? 99 : 101, 100), 'futures', epoch + 100);
  tracker.processTrade(trade(short ? 98.7 : 101.3, 200), 'futures', epoch + 200);
  const events = tracker.processTrade(trade(short ? 98.7 : 101.3, 3200), 'futures', epoch + 3200);
  assert.equal(events[0]?.type, 'follow-confirmed');
  return tracker;
}

test('detector includes the exact event-time wave origin without delaying the alert', () => {
  const detector = new MarketAlertDetector();
  detector.processTicker({ symbol: 'TESTUSDT', price: 100 }, 'futures', epoch - 100);
  const result = detector.processTicker({ symbol: 'TESTUSDT', price: 102 }, 'futures', epoch)!;
  assert.equal(result.referencePrice, 100);
  assert.equal(result.referenceTimestamp, epoch - 100);
  assert.equal(result.timestamp, epoch);
  assert.ok(createFollowPlan(result, epoch));
});

test('the originating aggregate trade seeds freshness but does not confirm an entry', () => {
  const tracker = new FollowPlanTracker();
  const result = tracker.processMarketTrade(trade(102, 0), 'futures', alert(), epoch);
  assert.deepEqual(result.events, []);
  assert.equal(state(tracker).stale, false);
  assert.equal(state(tracker).state, 'WAIT_PULLBACK');
  assert.equal(state(tracker).lastTradeTimestamp, epoch);
  tracker.processTrade(trade(50, -1), 'futures', epoch);
  assert.equal(state(tracker).currentPrice, 102);
});

test('long and short waves produce symmetric fixed observation, zone and invalidation levels', () => {
  const long = createFollowPlan(alert(), epoch)!;
  const short = createFollowPlan(alert({ type: 'dump', price: 98 }), epoch)!;
  assert.equal(long.observationPrice, 101.236);
  assert.equal(short.observationPrice, 98.764);
  assert.deepEqual([long.zoneLow, long.zoneHigh, long.stopLoss], [101, 101.5, 99.8]);
  assert.deepEqual([short.zoneLow, short.zoneHigh, short.stopLoss], [98.5, 99, 100.2]);
  assert.equal(long.confirmedEntry, undefined);
});

test('spot drops, whales, legacy payloads and impossible prices do not create short or invented plans', () => {
  assert.equal(createFollowPlan(alert({ marketType: 'spot', type: 'dump', price: 98 }), epoch), null);
  assert.equal(createFollowPlan(alert({ type: 'whale-buy' }), epoch), null);
  assert.equal(createFollowPlan(alert({ referencePrice: undefined }), epoch), null);
  assert.equal(createFollowPlan(alert({ referenceTimestamp: undefined }), epoch), null);
  assert.equal(createFollowPlan(alert({ referenceTimestamp: epoch + 1 }), epoch), null);
  assert.equal(createFollowPlan(alert({ price: 99 }), epoch), null);
  assert.equal(createFollowPlan(alert({ type: 'dump', price: 1, referencePrice: 100 }), epoch), null);
  for (const bad of [0, -1, Infinity, NaN]) assert.equal(createFollowPlan(alert({ price: bad }), epoch), null);
});

test('both sides confirm only on a new trade after three seconds and lock 1.5R/2R targets', () => {
  for (const short of [false, true]) {
    const tracker = confirmed(short);
    const plan = state(tracker);
    const direction = short ? -1 : 1;
    const risk = Math.abs(plan.confirmedEntry! - plan.stopLoss);
    assert.equal(plan.state, 'CONFIRMED');
    assert.equal(plan.takeProfit1, plan.confirmedEntry! + direction * risk * 1.5);
    assert.equal(plan.takeProfit2, plan.confirmedEntry! + direction * risk * 2);
    assert.equal(plan.expiresAt, epoch + 3200 + 900000);
    tracker.processTrade(trade(short ? 98.6 : 101.4, 3300), 'futures', epoch + 3300);
    assert.equal(state(tracker).confirmedEntry, plan.confirmedEntry);
    assert.equal(state(tracker).takeProfit1, plan.takeProfit1);
    assert.equal(followPlanLines(plan).length, 7);
  }
});

test('time alone and slow snapshots cannot confirm entry', () => {
  const tracker = new FollowPlanTracker();
  tracker.observeAlert(alert(), epoch);
  tracker.processTrade(trade(101, 100), 'futures', epoch + 100);
  tracker.processTrade(trade(101.3, 200), 'futures', epoch + 200);
  tracker.tick(epoch + 4000);
  assert.equal(state(tracker).state, 'WAIT_CONFIRMATION');
  assert.equal(state(tracker).confirmedEntry, undefined);
  tracker.observeAlert(alert({ id: 'snapshot', price: 104, timestamp: epoch + 4000 }), epoch + 4000);
  assert.equal(state(tracker).triggerPrice, 102);
});

test('a deeper pullback must return to the allowed band before confirmation can start', () => {
  const tracker = new FollowPlanTracker();
  tracker.observeAlert(alert(), epoch);
  for (const [offset, price] of [[100, 101], [200, 100.5], [300, 100.8], [3300, 100.8]]) {
    assert.equal(tracker.processTrade(trade(price, offset), 'futures', epoch + offset).length, 0);
  }
  assert.equal(state(tracker).confirmationSince, undefined);
  tracker.processTrade(trade(101.1, 3400), 'futures', epoch + 3400);
  assert.equal(tracker.processTrade(trade(101.1, 6400), 'futures', epoch + 6400)[0]?.type, 'follow-confirmed');
});

test('new extremes and drops below the rebound threshold reset the hold period', () => {
  const tracker = new FollowPlanTracker();
  tracker.observeAlert(alert(), epoch);
  for (const [offset, price] of [[100, 101], [200, 101.3], [2500, 101.1], [3000, 100.9], [3100, 101.2], [5999, 101.2]]) {
    assert.equal(tracker.processTrade(trade(price, offset), 'futures', epoch + offset).length, 0);
  }
  assert.equal(state(tracker).extreme, 100.9);
  assert.equal(tracker.processTrade(trade(101.2, 6100), 'futures', epoch + 6100)[0]?.type, 'follow-confirmed');
});

test('a gap or stale stream clears confirmation and requires a fresh full hold', () => {
  const tracker = new FollowPlanTracker();
  tracker.observeAlert(alert(), epoch);
  tracker.processTrade(trade(101, 100), 'futures', epoch + 100);
  tracker.processTrade(trade(101.3, 200), 'futures', epoch + 200);
  tracker.tick(epoch + 5201);
  assert.equal(state(tracker).stale, true);
  assert.equal(state(tracker).confirmationSince, undefined);
  assert.equal(tracker.processTrade(trade(101.3, 6000), 'futures', epoch + 6000).length, 0);
  assert.equal(tracker.processTrade(trade(101.3, 8999), 'futures', epoch + 8999).length, 0);
  assert.equal(tracker.processTrade(trade(101.3, 9000), 'futures', epoch + 9000)[0]?.type, 'follow-confirmed');
});

test('replayed buffered trades cannot satisfy the three-second received-time hold', () => {
  const tracker = new FollowPlanTracker();
  tracker.observeAlert(alert(), epoch);
  tracker.processTrade(trade(101, 100), 'futures', epoch + 4000);
  tracker.processTrade(trade(101.3, 200), 'futures', epoch + 4001);
  assert.equal(tracker.processTrade(trade(101.3, 3200), 'futures', epoch + 4002).length, 0);
  assert.equal(tracker.processTrade(trade(101.3, 8000), 'futures', epoch + 14000).length, 0);
  assert.equal(state(tracker).confirmedEntry, undefined);
});

test('duplicates, obsolete IDs, wrong markets and out-of-order event times are ignored', () => {
  const tracker = new FollowPlanTracker();
  tracker.observeAlert(alert(), epoch);
  tracker.processTrade(trade(101, 100), 'futures', epoch + 100);
  tracker.processTrade(trade(50, 100), 'futures', epoch + 100);
  tracker.processTrade(trade(50, 50), 'futures', epoch + 100);
  tracker.processTrade(trade(50, 200, { lastTradeId: 1 }), 'futures', epoch + 200);
  tracker.processTrade(trade(50, 200), 'spot', epoch + 200);
  assert.equal(state(tracker).currentPrice, 101);
  assert.equal(state(tracker).state, 'WAIT_CONFIRMATION');
});

test('too little retracement is missed rather than chased, and pre-entry stop invalidates', () => {
  const tracker = new FollowPlanTracker();
  tracker.observeAlert(alert(), epoch);
  tracker.processTrade(trade(101, 100), 'futures', epoch + 100);
  tracker.processTrade(trade(101.8, 200), 'futures', epoch + 200);
  assert.equal(state(tracker).state, 'MISSED');
  const stopped = new FollowPlanTracker();
  stopped.observeAlert(alert(), epoch);
  assert.deepEqual(stopped.processTrade(trade(99.8, 100), 'futures', epoch + 100), []);
  assert.equal(state(stopped).state, 'INVALID');
});

test('same-direction upgrades preserve anchors and opposite waves invalidate and replace', () => {
  const tracker = new FollowPlanTracker();
  tracker.observeAlert(alert(), epoch);
  tracker.observeAlert(alert({ id: 'upgrade', price: 104, timestamp: epoch + 500 }), epoch + 500);
  assert.equal(tracker.getPlans().length, 1);
  assert.equal(state(tracker).triggerPrice, 102);
  tracker.observeAlert(alert({ id: 'opposite', type: 'dump', price: 98, timestamp: epoch + 600 }), epoch + 600);
  assert.equal(tracker.getPlans().length, 2);
  assert.equal(state(tracker).side, 'SHORT');
  assert.equal(tracker.getPlans()[1].state, 'INVALID');
});

test('a spot reversal invalidates the long plan without offering a short plan', () => {
  const tracker = new FollowPlanTracker();
  tracker.observeAlert(alert({ marketType: 'spot' }), epoch);
  tracker.observeAlert(alert({ id: 'drop', marketType: 'spot', type: 'dump', price: 98, timestamp: epoch + 100 }), epoch + 100);
  assert.equal(tracker.getPlans().length, 1);
  assert.equal(state(tracker).state, 'INVALID');
});

test('TP1 then TP2 and a direct TP2 gap emit each event once on both sides', () => {
  for (const short of [false, true]) {
    const tracker = confirmed(short);
    const plan = state(tracker);
    const first = tracker.processTrade(trade(plan.takeProfit1, 3300), 'futures', epoch + 3300);
    assert.deepEqual(first.map(event => event.type), ['follow-tp1']);
    assert.equal(state(tracker).stopLoss, plan.stopLoss);
    assert.deepEqual(tracker.processTrade(trade(plan.takeProfit1, 3400), 'futures', epoch + 3400), []);
    assert.deepEqual(tracker.processTrade(trade(plan.takeProfit2, 3500), 'futures', epoch + 3500).map(event => event.type), ['follow-tp2']);
    assert.deepEqual(tracker.processTrade(trade(plan.takeProfit2, 3600), 'futures', epoch + 3600), []);
    const gap = confirmed(short);
    assert.deepEqual(gap.processTrade(trade(state(gap).takeProfit2, 3300), 'futures', epoch + 3300).map(event => event.type), ['follow-tp1', 'follow-tp2']);
  }
});

test('stop remains active after TP1 and is notified only once', () => {
  const tracker = confirmed();
  tracker.processTrade(trade(state(tracker).takeProfit1, 3300), 'futures', epoch + 3300);
  const result = tracker.processTrade(trade(state(tracker).stopLoss, 3400), 'futures', epoch + 3400);
  assert.equal(result[0]?.type, 'follow-stop');
  assert.equal(state(tracker).state, 'STOPPED');
  assert.deepEqual(tracker.processTrade(trade(90, 3500), 'futures', epoch + 3500), []);
});

test('a simultaneous reversal cannot swallow a stop touch or publish an invalid entry confirmation', () => {
  const tracker = confirmed();
  const reversal = alert({ id: 'reverse-stop', type: 'dump', referencePrice: 102, price: 99.7, timestamp: epoch + 3300 });
  const result = tracker.processMarketTrade(trade(99.7, 3300), 'futures', reversal, epoch + 3300);
  assert.deepEqual(result.events.map(event => event.type), ['follow-stop']);
  assert.equal(tracker.getPlans()[1].state, 'STOPPED');
  assert.equal(result.plan?.side, 'SHORT');
  const waiting = new FollowPlanTracker();
  waiting.observeAlert(alert(), epoch);
  waiting.processTrade(trade(101, 100), 'futures', epoch + 100);
  waiting.processTrade(trade(101.3, 200), 'futures', epoch + 200);
  const conflicting = alert({ id: 'reverse-confirm', type: 'dump', referencePrice: 104, price: 101.3, timestamp: epoch + 3200 });
  assert.deepEqual(waiting.processMarketTrade(trade(101.3, 3200), 'futures', conflicting, epoch + 3200).events, []);
  assert.equal(waiting.getPlans()[1].state, 'INVALID');
});

test('entry and exit timeouts terminate observation; replaying the same alert cannot revive it', () => {
  const tracker = new FollowPlanTracker();
  tracker.observeAlert(alert(), epoch);
  tracker.tick(epoch + 180000);
  assert.equal(state(tracker).state, 'EXPIRED');
  tracker.observeAlert(alert(), epoch);
  assert.equal(tracker.getPlans().length, 1);
  const live = confirmed();
  live.tick(state(live).expiresAt);
  assert.equal(state(live).state, 'EXPIRED');
  assert.match(state(live).reason!, /不代表實際平倉/);
});

test('history is bounded, snapshots cannot mutate state, and reset clears market plans', () => {
  const tracker = new FollowPlanTracker();
  for (let i = 0; i < 60; i++) tracker.observeAlert(alert({ id: `${i}`, symbol: `COIN${i}USDT` }), epoch);
  assert.equal(tracker.getPlans().length, 50);
  const snapshot = tracker.getPlans();
  snapshot[0].observationPrice = 1;
  assert.equal(state(tracker).observationPrice, 101.236);
  tracker.reset();
  assert.deepEqual(tracker.getPlans(), []);
});
