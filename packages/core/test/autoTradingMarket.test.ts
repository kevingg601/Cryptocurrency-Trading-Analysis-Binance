import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { idleAutoTradingSnapshot } from '../src/services/autoTrading.ts';
import type { AutoTradingSnapshot } from '../src/services/autoTrading.ts';
import type { FollowPlan } from '../src/services/followPlans.ts';
import {
  fetchAutoFundingHistory, fetchAutoServerTime, fetchAutoSymbolRules,
  parseAutoFundingHistory, parseAutoSymbolRules,
} from '../src/services/autoTradingMarket.ts';
import { loadAutoTradingBatches, saveAutoTradingBatch } from '../src/services/autoTradingStorage.ts';

const lot = { filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '100', stepSize: '0.001' };
const marketLot = { filterType: 'MARKET_LOT_SIZE', minQty: '0.01', maxQty: '10', stepSize: '0.01' };
const minimum = { filterType: 'MIN_NOTIONAL', minNotional: '5', applyToMarket: true };
const notional = { filterType: 'NOTIONAL', minNotional: '10', maxNotional: '1000', applyMinToMarket: true, applyMaxToMarket: true };
const symbolInfo = (overrides: Record<string, unknown> = {}) => ({
  symbol: 'BTCUSDT', status: 'TRADING', quoteAsset: 'USDT', contractType: 'PERPETUAL',
  filters: [lot, marketLot, minimum], ...overrides,
});
const parseSpot = (filters: unknown[]) => parseAutoSymbolRules({ symbols: [symbolInfo({ filters })] }, 'spot');
const funding = (fundingTime: number, overrides: Record<string, unknown> = {}) => ({
  symbol: 'BTCUSDT', fundingTime, fundingRate: '-0.0001', markPrice: '60000.25', ...overrides,
});
const unicodeSymbol = '\u9f99\u867eUSDT';

test('market lot sizes take priority and LOT_SIZE is the fallback', () => {
  assert.deepEqual(parseSpot([lot, marketLot, minimum]).BTCUSDT, {
    stepSize: 0.01, minQty: 0.01, maxQty: 10, minNotional: 5,
  });
  assert.equal(parseSpot([lot, minimum]).BTCUSDT.stepSize, 0.001);
});

test('zero market lot fields fall back without discarding a market maximum', () => {
  assert.deepEqual(parseSpot([lot, { ...marketLot, minQty: '0', stepSize: '0' }, minimum]).BTCUSDT, {
    stepSize: 0.001, minQty: 0.001, maxQty: 10, minNotional: 5,
  });
  assert.equal(parseSpot([lot, { ...marketLot, maxQty: '0' }, minimum]).BTCUSDT.maxQty, 100);
  assert.deepEqual(parseSpot([{ ...marketLot, stepSize: '0' }, minimum]), {});
});

test('zero market step still obeys both quantity bounds', () => {
  assert.deepEqual(parseSpot([
    { ...lot, minQty: '0.1', maxQty: '50' },
    { ...marketLot, minQty: '0.01', maxQty: '75', stepSize: '0' }, minimum,
  ]).BTCUSDT, { stepSize: 0.001, minQty: 0.1, maxQty: 50, minNotional: 5 });
  assert.deepEqual(parseSpot([
    { ...lot, minQty: '0.1', maxQty: '50' },
    { ...marketLot, minQty: '0.2', maxQty: '25', stepSize: '0' }, minimum,
  ]).BTCUSDT, { stepSize: 0.001, minQty: 0.2, maxQty: 25, minNotional: 5 });
  assert.deepEqual(parseSpot([lot, { ...marketLot, minQty: '0', maxQty: '0', stepSize: '0' }, minimum]).BTCUSDT,
    parseSpot([lot, minimum]).BTCUSDT);
  assert.deepEqual(parseSpot([{ ...lot, minQty: '20' }, { ...marketLot, stepSize: '0' }, minimum]), {});
});

test('nonzero lot steps intersect instead of permitting quantities invalid for either filter', () => {
  for (const [lotStep, marketStep, expected] of [
    ['0.01', '0.001', 0.01], ['0.002', '0.003', 0.006], ['2e-8', '3e-8', 6e-8],
  ] as const) {
    const rules = parseSpot([{ ...lot, stepSize: lotStep }, { ...marketLot, stepSize: marketStep }, minimum]);
    assert.equal(rules.BTCUSDT.stepSize, expected);
  }
  assert.deepEqual(parseSpot([{ ...lot, maxQty: '0.004', minQty: '0', stepSize: '0.002' },
    { ...marketLot, minQty: '0', stepSize: '0.003' }, minimum]), {});
  assert.deepEqual(parseSpot([{ ...lot, stepSize: 'bad' }, marketLot, minimum]), {});
});

test('spot notional flags determine the effective market limits', () => {
  assert.deepEqual(parseSpot([lot, { ...minimum, applyToMarket: false }]).BTCUSDT, {
    stepSize: 0.001, minQty: 0.001, maxQty: 100, minNotional: 0,
  });
  assert.deepEqual(parseSpot([lot, minimum, notional]).BTCUSDT, {
    stepSize: 0.001, minQty: 0.001, maxQty: 100, minNotional: 10, maxNotional: 1000,
  });
  assert.equal(parseSpot([lot, minimum, { ...notional, applyMinToMarket: false, applyMaxToMarket: false }]).BTCUSDT.minNotional, 5);
  assert.equal(parseSpot([lot, minimum, { ...notional, applyMaxToMarket: false }]).BTCUSDT.maxNotional, undefined);
  assert.equal(parseSpot([lot, { ...minimum, minNotional: '20' }, notional]).BTCUSDT.minNotional, 20);
});

test('futures MIN_NOTIONAL uses notional without a spot applyToMarket flag', () => {
  const payload = { symbols: [symbolInfo({ filters: [lot, { filterType: 'MIN_NOTIONAL', notional: '5' }] })] };
  assert.equal(parseAutoSymbolRules(payload, 'futures').BTCUSDT.minNotional, 5);
  assert.deepEqual(parseAutoSymbolRules(payload, 'spot'), {});
});

test('only trading USDT pairs and perpetual futures are eligible', () => {
  const entries = [
    symbolInfo(), symbolInfo({ symbol: 'ETHUSDT', status: 'BREAK' }),
    symbolInfo({ symbol: 'ETHBTC', quoteAsset: 'BTC' }),
    symbolInfo({ symbol: 'SOLUSDT', contractType: 'CURRENT_QUARTER' }),
    symbolInfo({ symbol: 'XRPUSDT', isSpotTradingAllowed: false }),
  ];
  assert.deepEqual(Object.keys(parseAutoSymbolRules({ symbols: entries }, 'spot')), ['BTCUSDT', 'SOLUSDT']);
  const futuresEntries = entries.map(entry => ({ ...entry, filters: [lot, { filterType: 'MIN_NOTIONAL', notional: '5' }] }));
  assert.deepEqual(Object.keys(parseAutoSymbolRules({ symbols: futuresEntries }, 'futures')), ['BTCUSDT', 'XRPUSDT']);
});

test('exchange rules include Unicode symbols on spot and perpetual futures', () => {
  const spot = { symbols: [symbolInfo({ symbol: unicodeSymbol })] };
  assert.deepEqual(parseAutoSymbolRules(spot, 'spot')[unicodeSymbol], parseSpot([lot, marketLot, minimum]).BTCUSDT);
  const futures = { symbols: [symbolInfo({ symbol: unicodeSymbol, filters: [lot, { filterType: 'MIN_NOTIONAL', notional: '5' }] })] };
  assert.equal(parseAutoSymbolRules(futures, 'futures')[unicodeSymbol].minNotional, 5);
  for (const symbol of ['btcUSDT', 'BTCUSDT&x=y', '\u9f99/\u867eUSDT', 'BTC USDT']) {
    assert.deepEqual(parseAutoSymbolRules({ symbols: [symbolInfo({ symbol })] }, 'spot'), {});
  }
});

test('missing, malformed, duplicated, or contradictory rules never get defaults', () => {
  const badFilters = [
    [], [lot], [minimum], [null, lot, minimum], [lot, lot, minimum],
    [lot, { ...marketLot, stepSize: 'bad' }, minimum],
    [{ ...lot, minQty: '101' }, minimum], [{ ...lot, maxQty: '-1' }, minimum],
    [{ ...lot, stepSize: 'Infinity' }, minimum], [{ ...lot, minQty: '' }, minimum],
    [{ ...lot, stepSize: null }, minimum], [{ ...lot, stepSize: true }, minimum],
    [{ ...lot, stepSize: Infinity }, { ...marketLot, stepSize: '0' }, minimum],
    [lot, { ...minimum, minNotional: 'NaN' }], [lot, { ...minimum, applyToMarket: 'true' }],
    [lot, { filterType: 'MIN_NOTIONAL', minNotional: '5' }],
    [lot, { ...notional, maxNotional: '1' }], [lot, { ...notional, applyMaxToMarket: undefined }],
    [lot, { ...minimum, minNotional: '2000' }, notional],
  ];
  for (const filters of badFilters) assert.deepEqual(parseSpot(filters), {}, JSON.stringify(filters));
  assert.deepEqual(parseAutoSymbolRules({ symbols: [symbolInfo(), symbolInfo()] }, 'spot'), {});
  for (const payload of [null, {}, { symbols: {} }]) assert.throws(() => parseAutoSymbolRules(payload, 'spot'), /exchangeInfo/);
});

test('funding parser preserves signed and zero rates and requires positive markPrice', () => {
  assert.deepEqual(parseAutoFundingHistory([funding(100), funding(200, { fundingRate: '0' })]), [
    { symbol: 'BTCUSDT', fundingTime: 100, fundingRate: -0.0001, markPrice: 60000.25 },
    { symbol: 'BTCUSDT', fundingTime: 200, fundingRate: 0, markPrice: 60000.25 },
  ]);
  for (const markPrice of [undefined, null, '', ' ', 'NaN', 'Infinity', 0, '-1', false]) {
    assert.throws(() => parseAutoFundingHistory([funding(100, { markPrice })]), /markPrice/);
  }
  for (const fundingRate of [undefined, null, '', 'NaN', Infinity, true]) {
    assert.throws(() => parseAutoFundingHistory([funding(100, { fundingRate })]), /fundingRate/);
  }
  for (const entry of [null, funding(-1), funding(1.5), funding(100, { symbol: '' }), funding(100, { fundingTime: '100' })]) {
    assert.throws(() => parseAutoFundingHistory([entry]), /record/);
  }
  assert.throws(() => parseAutoFundingHistory({ code: -1 }), /response/);
});

function mockResponses(t: TestContext, payloads: unknown[], status = 200): URL[] {
  const urls: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    const url = new URL(input);
    assert.ok(['api.binance.com', 'fapi.binance.com'].includes(url.hostname));
    assert.equal(init.headers, undefined);
    assert.equal(init.method, undefined);
    assert.ok(init.signal);
    urls.push(url);
    assert.ok(payloads.length > 0, 'unexpected extra request');
    return new Response(JSON.stringify(payloads.shift()), { status });
  });
  return urls;
}

test('exchangeInfo and server time use public endpoints for each market', async t => {
  const urls = mockResponses(t, [
    { symbols: [symbolInfo()] },
    { symbols: [symbolInfo({ filters: [lot, { filterType: 'MIN_NOTIONAL', notional: '5' }] })] },
    { serverTime: 1800000000000 }, { serverTime: 1800000000001 },
  ]);
  assert.ok((await fetchAutoSymbolRules('spot')).BTCUSDT);
  assert.ok((await fetchAutoSymbolRules('futures')).BTCUSDT);
  assert.equal(await fetchAutoServerTime('spot'), 1800000000000);
  assert.equal(await fetchAutoServerTime('futures'), 1800000000001);
  assert.deepEqual(urls.map(url => url.href), [
    'https://api.binance.com/api/v3/exchangeInfo', 'https://fapi.binance.com/fapi/v1/exchangeInfo',
    'https://api.binance.com/api/v3/time', 'https://fapi.binance.com/fapi/v1/time',
  ]);
});

test('funding pagination includes both boundaries and continues after short pages', async t => {
  const urls = mockResponses(t, [[funding(100), funding(200)], [funding(300)], [funding(400)]]);
  const result = await fetchAutoFundingHistory('BTCUSDT', 100, 400);
  assert.deepEqual(result.map(record => record.fundingTime), [100, 200, 300, 400]);
  assert.deepEqual(urls.map(url => url.searchParams.get('startTime')), ['100', '201', '301']);
  for (const url of urls) {
    assert.equal(url.pathname, '/fapi/v1/fundingRate');
    assert.equal(url.searchParams.get('endTime'), '400');
    assert.equal(url.searchParams.get('symbol'), 'BTCUSDT');
    assert.equal(url.searchParams.get('limit'), '1000');
  }
});

test('Unicode funding symbols parse and paginate with safely encoded query parameters', async t => {
  const first = funding(100, { symbol: unicodeSymbol });
  const second = funding(200, { symbol: unicodeSymbol });
  assert.equal(parseAutoFundingHistory([first])[0].symbol, unicodeSymbol);
  const urls = mockResponses(t, [[first], [second]]);
  const records = await fetchAutoFundingHistory(unicodeSymbol, 100, 200);
  assert.deepEqual(records.map(record => record.symbol), [unicodeSymbol, unicodeSymbol]);
  assert.deepEqual(records.map(record => record.fundingTime), [100, 200]);
  for (const url of urls) {
    assert.equal(url.searchParams.get('symbol'), unicodeSymbol);
    assert.ok(url.search.includes(`symbol=${encodeURIComponent(unicodeSymbol)}`));
    assert.deepEqual([...url.searchParams.keys()], ['symbol', 'startTime', 'endTime', 'limit']);
  }
});

test('funding history has no record cap across full pages', async t => {
  const page = Array.from({ length: 1000 }, (_, i) => funding(i));
  const urls = mockResponses(t, [page, [funding(1000)], []]);
  assert.equal((await fetchAutoFundingHistory('BTCUSDT', 0, 2000)).length, 1001);
  assert.equal(urls[1].searchParams.get('startTime'), '1000');
  assert.equal(urls[2].searchParams.get('startTime'), '1001');
});

test('empty and single-timestamp funding ranges terminate correctly', async t => {
  const urls = mockResponses(t, [[], [funding(100)]]);
  assert.deepEqual(await fetchAutoFundingHistory('BTCUSDT', 0, 100), []);
  assert.equal((await fetchAutoFundingHistory('BTCUSDT', 100, 100)).length, 1);
  assert.equal(urls.length, 2);
});

test('funding pagination rejects out-of-range, duplicate, unordered, and wrong-symbol rows', async t => {
  mockResponses(t, [
    [funding(99)], [funding(401)], [funding(200), funding(100)], [funding(100), funding(100)],
    [funding(100, { symbol: 'ETHUSDT' })], [funding(100)], [funding(100)],
  ]);
  for (let i = 0; i < 6; i++) {
    await assert.rejects(fetchAutoFundingHistory('BTCUSDT', 100, 400), /range|ascending/);
  }
});

test('invalid funding arguments do not make any network requests', async t => {
  const urls = mockResponses(t, []);
  for (const [symbol, start, end] of [
    ['', 0, 100], ['BTCUSDT&x=y', 0, 100], ['btcUSDT', 0, 100], ['\u9f99/\u867eUSDT', 0, 100], ['BTCUSDT', -1, 100],
    ['BTCUSDT', 1.5, 100], ['BTCUSDT', 101, 100], ['BTCUSDT', 0, Infinity],
  ] as const) await assert.rejects(fetchAutoFundingHistory(symbol, start, end), /Invalid/);
  assert.equal(urls.length, 0);
});

test('HTTP errors, corrupt server time, and missing funding prices propagate', async t => {
  mockResponses(t, [{ code: -1003 }, { code: -1003 }, { code: -1003 }], 429);
  await assert.rejects(fetchAutoSymbolRules('spot'), /HTTP 429/);
  await assert.rejects(fetchAutoServerTime('futures'), /HTTP 429/);
  await assert.rejects(fetchAutoFundingHistory('BTCUSDT', 0, 100), /HTTP 429/);
});

test('successful HTTP responses still require valid market data', async t => {
  mockResponses(t, [{ serverTime: '100' }, { serverTime: 0 }, { serverTime: 1.5 }, [funding(100, { markPrice: undefined })]]);
  for (let i = 0; i < 3; i++) await assert.rejects(fetchAutoServerTime('spot'), /serverTime/);
  await assert.rejects(fetchAutoFundingHistory('BTCUSDT', 100, 100), /markPrice/);
});

const snapshot = (id: string, startedAt: number): AutoTradingSnapshot => {
  const initial = idleAutoTradingSnapshot('spot');
  return { ...initial, id, startedAt, status: 'RUNNING', config: { ...initial.config, initialCapital: 1000 },
    cash: 1000, lastEquity: 1000, equityPeak: 1000, riskExtrema: [], peakTimestamp: startedAt };
};
const save = (value: unknown) => saveAutoTradingBatch(value as Parameters<typeof saveAutoTradingBatch>[0]);

const planFixture = (): FollowPlan => ({
  id: 'plan-1', alertId: 'alert-1', symbol: 'BTCUSDT', marketType: 'spot', side: 'LONG', state: 'CONFIRMED',
  referencePrice: 90, triggerPrice: 110, triggerTimestamp: 100, impulse: 20, observationPrice: 100,
  zoneLow: 95, zoneHigh: 105, stopLoss: 88, takeProfit1: 120, takeProfit2: 130,
  confirmedEntry: 100, confirmedAt: 150, extreme: 110, confirmationSince: 120, confirmationReceivedSince: 120,
  createdAt: 100, expiresAt: 10000, lastTradeTimestamp: 150, lastTradeId: 10, lastReceivedAt: 150,
  currentPrice: 100, stale: false,
});

function populatedSnapshot(): AutoTradingSnapshot {
  const value = snapshot('populated', 100);
  const plan = planFixture();
  value.plans = [plan];
  value.positions = [{
    id: 'position-1', planId: plan.id, symbol: 'BTCUSDT', side: 'LONG', entryPrice: 100, quantity: 2,
    remainingQuantity: 1, stopLoss: 88, takeProfit1: 120, takeProfit2: 130, openedAt: 150,
    currentPrice: 110, entryFee: 0.2, realizedPnl: -1, tp1Hit: true, lastReceivedAt: 200,
    exitNotional: 110, exitFees: 0.1, funding: -0.2, incomplete: false,
  }];
  value.orders = [{
    id: 'exit-1', planId: plan.id, symbol: 'BTCUSDT', side: 'LONG', kind: 'EXIT', reason: 'MANUAL',
    createdAt: 200, eligibleAt: 450, expiresAt: Infinity, quantity: 1, positionId: 'position-1',
    signalTimestamp: 200, signalTradeId: 11,
  }, {
    id: 'entry-1', planId: plan.id, symbol: 'BTCUSDT', side: 'LONG', kind: 'ENTRY', reason: 'CONFIRMED',
    createdAt: 200, eligibleAt: 450, expiresAt: 5200, signalTimestamp: 200, plan,
  }];
  value.fills = [{
    id: 'fill-1', positionId: 'position-1', symbol: 'BTCUSDT', side: 'LONG', action: 'ENTRY', timestamp: 150,
    tradeTimestamp: 150, tradeId: 10, price: 100, quantity: 2, fee: 0.2, grossPnl: 0, reason: 'CONFIRMED',
  }];
  value.trades = [{
    id: 'closed-1', planId: plan.id, symbol: 'BTCUSDT', side: 'LONG', entryPrice: 100, exitPrice: 99,
    quantity: 1, openedAt: 100, closedAt: 150, grossPnl: -1, fees: 0.2, funding: -0.1,
    netPnl: -1.1, reason: 'SL', incomplete: false,
  }];
  value.events = [{ id: 'event-1', timestamp: 100, type: 'START', symbol: 'BTCUSDT', message: 'Started' }];
  value.equity = [{ timestamp: 100, value: 1000 }, { timestamp: 200, value: 999 }];
  value.riskExtrema = [{ timestamp: 100, value: 1000 }, { timestamp: 150, value: 1020 }, { timestamp: 175, value: 998 }];
  value.equityPeak = 1020;
  value.peakTimestamp = 150;
  value.maxDrawdownPct = (1020 - 998) / 1020 * 100;
  value.fundingCharges = [{ id: 'charge-1', positionId: 'position-1', symbol: 'BTCUSDT', timestamp: 200, amount: -0.2 }];
  value.fundingThrough = 200;
  value.signalSettings = { priceMovePercent: 2 };
  return value;
}

function numericPaths(value: unknown, path: string[] = []): string[][] {
  if (typeof value === 'number') return [path];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => numericPaths(item, [...path, key]));
}

function withField(value: unknown, path: string[], replacement: unknown): unknown {
  const copy = structuredClone(value) as Record<string, unknown>;
  let target = copy;
  for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[path.at(-1)!] = replacement;
  return copy;
}

// A small event-driven IndexedDB test double; completion is distinct from request success.
function mockIndexedDB(t: TestContext, seed: unknown[] = [], abortWrites = false) {
  const state = { records: structuredClone(seed), closes: 0, commits: 0, upgrades: 0 };
  let hasStore = seed.length > 0;
  const factory = {
    open(name: string, version: number) {
      assert.equal(name, 'crypto-auto-trading');
      assert.equal(version, 1);
      const db = {
        objectStoreNames: { contains: (store: string) => store === 'batches' && hasStore },
        createObjectStore(store: string, options: { keyPath: string }) {
          assert.equal(store, 'batches');
          assert.deepEqual(options, { keyPath: 'id' });
          assert.equal(hasStore, false);
          hasStore = true;
          state.upgrades++;
        },
        close: () => { state.closes++; },
        transaction(store: string, mode: string) {
          assert.equal(store, 'batches');
          const tx = {
            error: new Error('commit failed'),
            onerror: null as null | (() => void), onabort: null as null | (() => void), oncomplete: null as null | (() => void),
            objectStore(storeName: string) {
              assert.equal(storeName, 'batches');
              return {
                getAll() {
                  assert.equal(mode, 'readonly');
                  const request = { result: structuredClone(state.records), error: null };
                  queueMicrotask(() => tx.oncomplete?.());
                  return request;
                },
                put(value: { id: string }) {
                  assert.equal(mode, 'readwrite');
                  const copy = structuredClone(value);
                  queueMicrotask(() => {
                    if (abortWrites) { tx.onabort?.(); return; }
                    state.records = state.records.filter(item => (item as { id: string }).id !== copy.id);
                    state.records.push(copy);
                    state.commits++;
                    tx.oncomplete?.();
                  });
                },
              };
            },
          };
          return tx;
        },
      };
      const request = {
        result: db, onsuccess: null as null | (() => void), onupgradeneeded: null as null | (() => void),
      };
      queueMicrotask(() => {
        if (!hasStore) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: factory });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  });
  return state;
}

test('storage returns every batch sorted newest first and upserts only its own id', async t => {
  const state = mockIndexedDB(t, Array.from({ length: 501 }, (_, i) => snapshot(String(i), i)));
  const loaded = await loadAutoTradingBatches();
  assert.equal(loaded.length, 501);
  assert.equal(loaded[0].id, '500');
  assert.equal(loaded[500].id, '0');
  await save({ ...snapshot('0', 600), cash: 900 });
  assert.equal(state.commits, 1);
  assert.equal(state.records.length, 501);
  const reloaded = await loadAutoTradingBatches();
  assert.equal(reloaded[0].id, '0');
  assert.equal(reloaded[0].cash, 900);
  assert.equal(state.closes, 3);
});

test('storage creates the id-keyed store once and captures the snapshot before awaiting open', async t => {
  const state = mockIndexedDB(t);
  assert.deepEqual(await loadAutoTradingBatches(), []);
  const value = snapshot('captured', 100);
  const saving = save(value);
  value.cash = 1;
  value.config.initialCapital = 0;
  await saving;
  assert.equal(state.upgrades, 1);
  assert.equal(state.commits, 1);
  const loaded = await loadAutoTradingBatches();
  assert.equal(loaded[0].cash, 1000);
  assert.equal(loaded[0].config.initialCapital, 1000);
});

test('a corrupt stored batch fails the whole load without deleting any records', async t => {
  const records = [snapshot('good', 100), { ...snapshot('bad', 200), schemaVersion: 2 }];
  const state = mockIndexedDB(t, records);
  await assert.rejects(loadAutoTradingBatches(), /Invalid auto-trading snapshot/);
  assert.deepEqual(state.records, records);
  assert.equal(state.closes, 1);
});

test('storage round-trips every current required collection and intentional infinite EXIT expiry', async t => {
  const value = populatedSnapshot();
  const original = structuredClone(value);
  mockIndexedDB(t);
  await saveAutoTradingBatch(value);
  assert.deepEqual(await loadAutoTradingBatches(), [original]);
  assert.deepEqual(value, original);
});

test('development v1 loads derive missing extrema and peak time without changing original records', async t => {
  const legacy: Partial<AutoTradingSnapshot> = populatedSnapshot();
  delete legacy.riskExtrema;
  delete legacy.peakTimestamp;
  legacy.equity = [
    { timestamp: 100, value: 1000 }, { timestamp: 200, value: 990 },
    { timestamp: 300, value: 1030 }, { timestamp: 400, value: 1030 },
  ];
  legacy.equityPeak = 1100;
  legacy.maxDrawdownPct = 10;
  const original = structuredClone(legacy);
  const current = snapshot('current', 500);
  const state = mockIndexedDB(t, [legacy, current]);
  const loaded = await loadAutoTradingBatches();
  assert.deepEqual(loaded.map(batch => batch.id), ['current', legacy.id]);
  const migrated = loaded[1];
  assert.deepEqual(migrated, { ...original, riskExtrema: original.equity, peakTimestamp: 300 });
  assert.notEqual(migrated.riskExtrema, migrated.equity);
  assert.notEqual(migrated.riskExtrema[0], migrated.equity[0]);
  migrated.riskExtrema[0].value = 1;
  assert.equal(migrated.equity[0].value, 1000);
  assert.deepEqual(state.records, [original, current]);
  assert.equal(state.commits, 0);
  assert.deepEqual((await loadAutoTradingBatches())[1].riskExtrema, original.equity);
});

test('v1 fallbacks are independent and preserve supplied extrema and zero peak time', async t => {
  const value = populatedSnapshot();
  const noExtrema: Partial<AutoTradingSnapshot> = { ...value, id: 'no-extrema', peakTimestamp: 0 };
  delete noExtrema.riskExtrema;
  const noPeakTime: Partial<AutoTradingSnapshot> = { ...value, id: 'no-peak-time' };
  delete noPeakTime.peakTimestamp;
  const current = { ...value, id: 'explicit-empty', riskExtrema: [], peakTimestamp: 0 };
  const state = mockIndexedDB(t, [noExtrema, noPeakTime, current]);
  const loaded = await loadAutoTradingBatches();
  assert.equal(loaded[0].peakTimestamp, 0);
  assert.deepEqual(loaded[0].riskExtrema, value.equity);
  assert.equal(loaded[1].peakTimestamp, 100);
  assert.deepEqual(loaded[1].riskExtrema, value.riskExtrema);
  assert.deepEqual(loaded[2], current);
  assert.deepEqual(state.records, [noExtrema, noPeakTime, current]);
});

test('v1 peak fallback uses actual loss-only samples and creates no empty-history points', async t => {
  const lossOnly: Partial<AutoTradingSnapshot> = { ...snapshot('loss-only', 100),
    equity: [{ timestamp: 200, value: 900 }, { timestamp: 300, value: 950 }] };
  delete lossOnly.riskExtrema;
  delete lossOnly.peakTimestamp;
  const empty: Partial<AutoTradingSnapshot> = snapshot('empty', 50);
  delete empty.riskExtrema;
  delete empty.peakTimestamp;
  const state = mockIndexedDB(t, [lossOnly, empty]);
  const [migratedLoss, migratedEmpty] = await loadAutoTradingBatches();
  assert.equal(migratedLoss.peakTimestamp, 300);
  assert.deepEqual(migratedLoss.riskExtrema, lossOnly.equity);
  assert.equal(migratedLoss.equityPeak, lossOnly.equityPeak);
  assert.equal(migratedEmpty.peakTimestamp, empty.startedAt);
  assert.deepEqual(migratedEmpty.riskExtrema, []);
  assert.deepEqual(migratedEmpty.equity, []);
  assert.deepEqual(state.records, [lossOnly, empty]);
});

test('v1 migration does not repair corrupt present fields or invalid source samples', async t => {
  const value = populatedSnapshot();
  const state = mockIndexedDB(t, [value]);
  for (const [key, invalid] of [
    ['riskExtrema', null], ['riskExtrema', {}], ['riskExtrema', [null]], ['riskExtrema', [{}]],
    ['riskExtrema', Array(1)], ['riskExtrema', [{ timestamp: 100, value: NaN }]],
    ['riskExtrema', [{ timestamp: Infinity, value: 1000 }]],
    ['peakTimestamp', null], ['peakTimestamp', -1], ['peakTimestamp', Infinity], ['peakTimestamp', '100'],
  ] as [string, unknown][]) {
    const corrupt = withField(value, [key], invalid);
    await assert.rejects(save(corrupt), /Invalid auto-trading snapshot/);
    state.records = [corrupt];
    await assert.rejects(loadAutoTradingBatches(), /Invalid auto-trading snapshot/);
    assert.deepEqual(state.records, [corrupt]);
  }
  const legacy: Partial<AutoTradingSnapshot> = populatedSnapshot();
  delete legacy.riskExtrema;
  delete legacy.peakTimestamp;
  legacy.equity = [{ timestamp: 100, value: Infinity }];
  state.records = [legacy];
  await assert.rejects(loadAutoTradingBatches(), /snapshot.equity/);
  assert.deepEqual(state.records, [legacy]);
  assert.equal(state.commits, 0);
});

test('all financial and timestamp fields reject non-finite values on save and restore', async t => {
  const value = populatedSnapshot();
  const good = snapshot('retained', 100);
  const state = mockIndexedDB(t, [good]);
  for (const path of numericPaths(value)) {
    for (const invalid of [NaN, Infinity, -Infinity, '1', null]) {
      if (path.join('.') === 'orders.0.expiresAt' && invalid === Infinity) continue;
      const corrupt = withField(value, path, invalid);
      const label = `${path.join('.')} = ${String(invalid)}`;
      await assert.rejects(save(corrupt), /Invalid auto-trading snapshot/, label);
      state.records = [good, corrupt];
      await assert.rejects(loadAutoTradingBatches(), /Invalid auto-trading snapshot/, label);
      assert.deepEqual(state.records, [good, corrupt], label);
    }
  }
  assert.equal(state.commits, 0);
});

test('missing required schema fields and malformed collections are rejected', async t => {
  const value = populatedSnapshot();
  const state = mockIndexedDB(t, [snapshot('retained', 100)]);
  const required = [
    ['strategyVersion'], ['status'], ['fundingStatus'], ['equityPeak'], ['maxDrawdownPct'],
    ['config', 'riskPct'], ['config', 'maxNotionalPct'], ['config', 'maxPositions'],
    ['config', 'feeBps'], ['config', 'slippageBps'], ['config', 'latencyMs'],
    ['positions', '0', 'remainingQuantity'], ['positions', '0', 'exitNotional'], ['positions', '0', 'exitFees'],
    ['positions', '0', 'funding'], ['positions', '0', 'tp1Hit'], ['positions', '0', 'currentPrice'],
    ['plans', '0', 'impulse'], ['plans', '0', 'state'], ['plans', '0', 'stale'],
    ['fills', '0', 'quantity'], ['fills', '0', 'fee'], ['fills', '0', 'grossPnl'], ['fills', '0', 'action'],
    ['trades', '0', 'planId'], ['trades', '0', 'fees'], ['trades', '0', 'netPnl'],
    ['fundingCharges', '0', 'amount'], ['fundingCharges', '0', 'positionId'], ['equity', '0', 'value'],
    ['events', '0', 'message'], ['orders', '0', 'quantity'], ['orders', '0', 'positionId'],
    ['orders', '1', 'plan'],
  ];
  for (const path of required) {
    const corrupt = withField(value, path, undefined);
    await assert.rejects(save(corrupt), /Invalid auto-trading snapshot/, path.join('.'));
    state.records = [corrupt];
    await assert.rejects(loadAutoTradingBatches(), /Invalid auto-trading snapshot/, path.join('.'));
  }
  for (const key of ['positions', 'plans', 'orders', 'fills', 'trades', 'events', 'equity', 'fundingCharges']) {
    for (const invalid of [undefined, null, {}, [null], [{}], Array(1)]) {
      await assert.rejects(save(withField(value, [key], invalid)), /Invalid auto-trading snapshot/, key);
    }
  }
  assert.equal(state.commits, 0);
});

test('status and funding enums are exact while valid signed financial values are retained', async t => {
  const state = mockIndexedDB(t);
  for (const status of ['IDLE', 'RUNNING', 'PAUSED', 'DRAINING', 'COMPLETED', 'INTERRUPTED']) {
    for (const fundingStatus of ['NOT_REQUIRED', 'PENDING', 'SETTLED', 'ERROR']) {
      await save({ ...snapshot('enums', 100), status, fundingStatus });
    }
  }
  for (const key of ['status', 'fundingStatus']) {
    for (const invalid of ['running', '', 1, null, ['RUNNING'], ['PENDING'], 'UNKNOWN']) {
      await assert.rejects(save(withField(snapshot('invalid', 100), [key], invalid)), /Invalid auto-trading snapshot/);
    }
  }
  const signed = populatedSnapshot();
  signed.cash = -100;
  signed.lastEquity = -90;
  signed.equity[0].value = -90;
  await save(signed);
  assert.equal((await loadAutoTradingBatches()).find(batch => batch.id === signed.id)?.cash, -100);
  assert.equal(state.commits, 25);
});

test('nested enums and order expiry exceptions cannot admit corrupted records', async t => {
  mockIndexedDB(t);
  const value = populatedSnapshot();
  for (const [path, replacement] of [
    [['positions', '0', 'side'], 'BUY'], [['plans', '0', 'state'], ['CONFIRMED']],
    [['plans', '0', 'marketType'], 'futures'], [['plans', '0', 'stale'], 0],
    [['fills', '0', 'action'], 'BUY'], [['trades', '0', 'incomplete'], 'false'],
    [['orders', '0', 'expiresAt'], -Infinity], [['orders', '1', 'expiresAt'], Infinity],
    [['orders', '1', 'plan', 'takeProfit1'], NaN], [['orders', '0', 'kind'], 'OTHER'],
    [['signalSettings', 'priceMovePercent'], NaN], [['positions', '0', 'remainingQuantity'], 3],
  ] as [string[], unknown][]) {
    await assert.rejects(save(withField(value, path, replacement)), /Invalid auto-trading snapshot/, path.join('.'));
  }
});

test('invalid snapshots reject before opening or mutating storage', async t => {
  const state = mockIndexedDB(t, [snapshot('retained', 100)]);
  const base = snapshot('bad', 200);
  for (const value of [
    null, {}, { ...base, id: '' }, { ...base, schemaVersion: 2 }, { ...base, config: null },
    { ...base, config: { marketType: 'futures', initialCapital: 1000 } },
    { ...base, config: { marketType: 'spot', initialCapital: 0 } },
    { ...base, cash: NaN }, { ...base, lastEquity: Infinity }, { ...base, startedAt: -1 },
    { ...base, positions: {} }, { ...base, orders: [null] }, { ...base, equity: undefined },
  ]) await assert.rejects(save(value), /Invalid auto-trading snapshot/);
  assert.equal(state.closes, 0);
  assert.equal(state.records.length, 1);
});

test('storage rejects aborted commits and closes the connection', async t => {
  const state = mockIndexedDB(t, [], true);
  await assert.rejects(save(snapshot('aborted', 100)), /commit failed/);
  assert.equal(state.records.length, 0);
  assert.equal(state.closes, 1);
});

test('missing IndexedDB fails explicitly instead of falling back to lossy storage', async t => {
  mockIndexedDB(t);
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
  await assert.rejects(loadAutoTradingBatches(), /IndexedDB is unavailable/);
  await assert.rejects(save(snapshot('unavailable', 100)), /IndexedDB is unavailable/);
});
