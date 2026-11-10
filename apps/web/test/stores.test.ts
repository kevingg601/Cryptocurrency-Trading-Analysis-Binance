import test from 'node:test';
import assert from 'node:assert/strict';
import { collectorClient, CollectorClient } from '../src/api/collectorClient.ts';
import { useDataCenterStore } from '../src/stores/dataCenterStore.ts';
import { useMarketStore } from '../src/stores/marketStore.ts';
import { usePaperStore } from '../src/stores/paperStore.ts';
import { FALLBACK_COINS } from '@fadachi/core';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const summary = { totalAggTrades: 1, totalKlines: 2, openGaps: 0, diskBytes: 100, recentSessions: [], recentAlerts: [] };
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

test('DataCenter rejects malformed summary, coverage and replay responses without publishing crashable state', async t => {
  t.mock.method(collectorClient, 'getStatsSummary', async () => ({ totalAggTrades: {} }));
  t.mock.method(collectorClient, 'getCoverage', async () => ({ gaps: [null], dailyCounts: {} }));
  t.mock.method(collectorClient, 'runReplay', async () => ({ totalTrades: 1, plans: null }));
  await useDataCenterStore.getState().loadSummary();
  await useDataCenterStore.getState().loadCoverage('spot', 'BTCUSDT');
  await useDataCenterStore.getState().runReplay({ symbol: 'BTCUSDT' });
  const state = useDataCenterStore.getState();
  assert.equal(state.summary, null);
  assert.deepEqual(state.coverageGaps, []);
  assert.equal(state.replayResult, null);
  assert.ok(state.summaryError && state.coverageError && state.replayError);
  assert.equal(state.isLoading, false);
  assert.equal(state.isReplaying, false);
});

test('DataCenter drops stale failures after a newer summary succeeds', async t => {
  const old = deferred<any>();
  let call = 0;
  t.mock.method(collectorClient, 'getStatsSummary', () => ++call === 1 ? old.promise : Promise.resolve(summary));
  const first = useDataCenterStore.getState().loadSummary();
  await useDataCenterStore.getState().loadSummary();
  old.reject(new Error('stale disconnection'));
  await first;
  assert.deepEqual(useDataCenterStore.getState().summary, summary);
  assert.equal(useDataCenterStore.getState().summaryError, null);
});

test('coverage requests cannot overwrite the latest selected symbol', async t => {
  const old = deferred<any>();
  t.mock.method(collectorClient, 'getCoverage', (_market, symbol) => symbol === 'BTCUSDT' ? old.promise : Promise.resolve({
    gaps: [], dailyCounts: [{ symbol, date: '2026-10-29', count: 2 }],
  }));
  const first = useDataCenterStore.getState().loadCoverage('spot', 'BTCUSDT');
  await useDataCenterStore.getState().loadCoverage('spot', 'ETHUSDT');
  old.resolve({ gaps: [], dailyCounts: [{ symbol: 'BTCUSDT', date: '2026-10-29', count: 1 }] });
  await first;
  assert.equal(useDataCenterStore.getState().dailyCounts[0].symbol, 'ETHUSDT');
});

test('symbol reloads ignore stale responses and degrade to fallback on invalid response', async t => {
  useMarketStore.setState({ marketType: 'futures', tickers: {} });
  const old = deferred<any>();
  let call = 0;
  t.mock.method(collectorClient, 'getSymbols', () => ++call === 1 ? old.promise : Promise.resolve({ coins: [FALLBACK_COINS[1]] }));
  const first = useMarketStore.getState().loadSymbols();
  await useMarketStore.getState().loadSymbols();
  old.resolve({ coins: [FALLBACK_COINS[0]] });
  await first;
  assert.equal(useMarketStore.getState().coins[0].symbol, FALLBACK_COINS[1].symbol);
  t.mock.method(collectorClient, 'getSymbols', async () => ({ coins: [null] }));
  await useMarketStore.getState().loadSymbols();
  assert.deepEqual(useMarketStore.getState().coins, FALLBACK_COINS);
  assert.ok(useMarketStore.getState().error);
  useMarketStore.getState().updateTickers([null, { symbol: 'BTCUSDT', price: NaN }] as any);
  assert.deepEqual(useMarketStore.getState().tickers, {});
});

test('paper account rejects malformed responses and does not inherit a previous market after disconnection', async t => {
  usePaperStore.setState({ market: 'futures', balance: 123, trades: [], history: [], loaded: true });
  t.mock.method(collectorClient, 'getPaperAccount', async () => ({ balance: 10, trades: {}, history: [] }));
  await usePaperStore.getState().loadAccount('spot');
  assert.equal(usePaperStore.getState().loaded, false);
  assert.equal(usePaperStore.getState().market, 'spot');
  assert.notEqual(usePaperStore.getState().balance, 123);
  assert.ok(usePaperStore.getState().error);
});

test('paper loads ignore a stale market response and report save failure', async t => {
  const old = deferred<any>();
  t.mock.method(collectorClient, 'getPaperAccount', market => market === 'spot' ? old.promise : Promise.resolve({ balance: 999, trades: [], history: [] }));
  const first = usePaperStore.getState().loadAccount('spot');
  await usePaperStore.getState().loadAccount('futures');
  old.resolve({ balance: 123, trades: [], history: [] });
  await first;
  assert.equal(usePaperStore.getState().balance, 999);
  t.mock.method(collectorClient, 'savePaperAccount', async () => { throw new Error('offline'); });
  usePaperStore.getState().resetAccount('futures');
  await nextTurn();
  assert.ok(usePaperStore.getState().error);
});

test('CollectorClient serializes paper saves per market and later saves recover from a prior failure', async t => {
  const gate = deferred<Response>();
  const bodies: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    assert.ok(options.signal instanceof AbortSignal);
    if (bodies.length === 1) return gate.promise;
    return new Response(JSON.stringify({ success: true }));
  });
  const client = new CollectorClient({ apiBase: 'http://127.0.0.1:4321' });
  const first = client.savePaperAccount('spot', { balance: 1, trades: [], history: [] });
  const failed = assert.rejects(first, /500/);
  const second = client.savePaperAccount('spot', { balance: 2, trades: [], history: [] });
  await nextTurn();
  assert.equal(bodies.length, 1);
  gate.resolve(new Response('{}', { status: 500 }));
  await failed;
  await second;
  assert.deepEqual(bodies.map(body => body.balance), [1, 2]);
});

test('live client resubscribes after reconnect and ignores obsolete socket callbacks', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sockets: any[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    onopen: any; onmessage: any; onclose: any; onerror: any;
    sent: string[] = [];
    constructor(_url: string) { sockets.push(this); }
    send(data: string) { this.sent.push(data); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')!;
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: FakeSocket });
  t.after(() => Object.defineProperty(globalThis, 'WebSocket', original));
  const statuses: string[] = [];
  const client = new CollectorClient({ apiBase: 'http://127.0.0.1:4321' });
  const live = client.connectLive('spot', { onStatus: status => statuses.push(status.status) });
  live.subscribeSymbol('ETHUSDT');
  sockets[0].readyState = 1;
  sockets[0].onopen();
  assert.deepEqual(JSON.parse(sockets[0].sent[0]), { type: 'subscribe', symbol: 'ETHUSDT' });
  assert.equal(statuses.at(-1), 'connecting');
  sockets[0].close();
  t.mock.timers.tick(2000);
  sockets[1].readyState = 1;
  sockets[1].onopen();
  assert.equal(sockets[1].sent.length, 1);
  sockets[0].onmessage({ data: JSON.stringify({ type: 'status', data: { status: 'connected' } }) });
  assert.equal(statuses.at(-1), 'connecting');
  live.close();
  const count = sockets.length;
  t.mock.timers.tick(10000);
  assert.equal(sockets.length, count);
});
