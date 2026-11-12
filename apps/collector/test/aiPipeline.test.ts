import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createAIDataSnapshot } from '@fadachi/core';
import { createDuckDBClient } from '../src/storage/duckdb.ts';
import { AICLIRunner, type AnalysisProvider } from '../src/ai/cliRunner.ts';
import { AIScheduler } from '../src/ai/aiScheduler.ts';
import { AIQuotaLedger, taipeiDateKey } from '../src/ai/quotaLedger.ts';
import { AIScopeStore } from '../src/ai/scopeStore.ts';
import { RSSNewsSource } from '../src/ai/sources/rssNews.ts';
import { CoinMetricsSource } from '../src/ai/sources/coinMetrics.ts';
import { BinanceDerivativesSource } from '../src/ai/sources/binanceDerivatives.ts';
import { AIDataAggregator } from '../src/ai/aiDataAggregator.ts';

const analysis = {
  direction: 'LONG', confidence: 81, reasoning: 'fixture batch result',
  bullishEvidence: ['evidence'], bearishEvidence: [], risks: ['risk'],
};

function snapshot(symbol: string, marketType: 'spot' | 'futures' = 'futures') {
  const now = Date.now();
  const lastOpen = Math.floor(now / 60_000) * 60 - 60;
  const klines = Array.from({ length: 30 }, (_, index) => ({
    time: lastOpen - (29 - index) * 60,
    open: 100, high: 101, low: 99, close: 100, volume: 2,
  }));
  const cutoffTime = lastOpen * 1000 + 60_000;
  return createAIDataSnapshot({
    symbol, marketType, cutoffTime, now,
    market: {
      price: 100, priceChangePercent: 0, volume: 60, quoteVolume: 6000,
      high: 101, low: 99, open: 100, priceTimestamp: cutoffTime,
    },
    klines,
    indicators: { sma20: 100, ema20: 100 },
  });
}

async function setupRunner(provider: AnalysisProvider) {
  const client = await createDuckDBClient(':memory:');
  await client.exec(`CREATE TABLE ai_analysis_results (
    id VARCHAR PRIMARY KEY, snapshot_id VARCHAR, symbol VARCHAR, market VARCHAR,
    model VARCHAR, direction VARCHAR, confidence DOUBLE, generated_at BIGINT,
    expires_at BIGINT, payload VARCHAR
  );`);
  const runner = new AICLIRunner({ client, provider });
  assert.equal(await runner.verifyIsolation(), true);
  return { client, runner };
}

function fakeProvider(analyzeBatch: AnalysisProvider['analyzeBatch']): AnalysisProvider {
  return {
    verifyIsolation: async () => ({ verified: true }),
    getModels: async () => ['fixture-model'],
    analyzeBatch,
  };
}

test('ten-symbol scheduled batch is one provider invocation and one quota reservation', async t => {
  let invocations = 0;
  let received = 0;
  const { client, runner } = await setupRunner(fakeProvider(async (snapshots) => {
    invocations++;
    received = snapshots.length;
    return { analyses: snapshots.map(item => ({ symbol: item.symbol, marketType: item.marketType, ...analysis })) };
  }));
  t.after(() => client.close());
  const snapshots = Array.from({ length: 10 }, (_, i) => snapshot(`C${i}USDT`));
  const results = await runner.runBatchAnalysis(snapshots, 'fixture-model');
  assert.equal(invocations, 1);
  assert.equal(received, 10);
  assert.deepEqual(results?.map(result => result.symbol), snapshots.map(item => item.symbol));
  assert.equal((await client.all('SELECT COUNT(*) AS calls FROM ai_quota_ledger'))[0].calls, 1);
  assert.equal((await client.all('SELECT COUNT(*) AS rows FROM ai_analysis_results'))[0].rows, 10);
});

test('unverified provider exposes its reason, no models, and cannot consume quota', async t => {
  const client = await createDuckDBClient(':memory:');
  t.after(() => client.close());
  const provider: AnalysisProvider = {
    verifyIsolation: async () => ({ verified: false, reason: '請在應用專用 profile 登入' }),
    getModels: async () => { throw new Error('must not query models before isolation'); },
    analyzeBatch: async () => { throw new Error('must not invoke provider before isolation'); },
  };
  const runner = new AICLIRunner({ client, provider });
  assert.equal(await runner.verifyIsolation(), false);
  assert.deepEqual(runner.getProviderStatus(), {
    verified: false, reason: '請在應用專用 profile 登入', models: [],
  });
  await assert.rejects(runner.runAnalysis(snapshot('BTCUSDT'), 'fixture-model'), /應用專用 profile/);
  assert.equal((await client.all('SELECT COUNT(*) AS calls FROM ai_quota_ledger'))[0].calls, 0);
});

test('pending batches coalesce distinct symbols and keep caller results scoped', async t => {
  let invocations = 0;
  let release!: (value: unknown) => void;
  const { client, runner } = await setupRunner(fakeProvider(async items => {
    invocations++;
    if (invocations === 1) return new Promise(resolve => { release = resolve; });
    return { analyses: items.map(item => ({ symbol: item.symbol, marketType: item.marketType, ...analysis })) };
  }));
  t.after(() => client.close());
  const active = runner.runBatchAnalysis([snapshot('BTCUSDT')], 'fixture-model');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const pendingA = runner.runBatchAnalysis([snapshot('ETHUSDT')], 'fixture-model');
  const pendingB = runner.runBatchAnalysis([snapshot('SOLUSDT')], 'fixture-model');
  release({ analyses: [{ symbol: 'BTCUSDT', marketType: 'futures', ...analysis }] });
  assert.deepEqual((await active)?.map(result => result.symbol), ['BTCUSDT']);
  assert.deepEqual((await pendingA)?.map(result => result.symbol), ['ETHUSDT']);
  assert.deepEqual((await pendingB)?.map(result => result.symbol), ['SOLUSDT']);
  assert.equal(invocations, 2);
  assert.equal((await client.all('SELECT COUNT(*) AS calls FROM ai_quota_ledger'))[0].calls, 2);
});

test('pending batches with overlapping symbols retain all requested symbols for each caller', async t => {
  let invocations = 0;
  let release!: (value: unknown) => void;
  const { client, runner } = await setupRunner(fakeProvider(async items => {
    invocations++;
    if (invocations === 1) return new Promise(resolve => { release = resolve; });
    return { analyses: items.map(item => ({ symbol: item.symbol, marketType: item.marketType, ...analysis })) };
  }));
  t.after(() => client.close());
  const active = runner.runBatchAnalysis([snapshot('BTCUSDT')], 'fixture-model');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const pendingA = runner.runBatchAnalysis([snapshot('ETHUSDT'), snapshot('SOLUSDT')], 'fixture-model');
  const pendingB = runner.runBatchAnalysis([snapshot('ETHUSDT')], 'fixture-model');
  release({ analyses: [{ symbol: 'BTCUSDT', marketType: 'futures', ...analysis }] });
  assert.deepEqual((await active)?.map(result => result.symbol), ['BTCUSDT']);
  assert.deepEqual((await pendingA)?.map(result => result.symbol), ['ETHUSDT', 'SOLUSDT']);
  assert.deepEqual((await pendingB)?.map(result => result.symbol), ['ETHUSDT']);
  assert.equal(invocations, 2);
});

test('provider failures and abort timeouts each consume one persisted call', async t => {
  const client = await createDuckDBClient(':memory:');
  await client.exec(`CREATE TABLE ai_analysis_results (
    id VARCHAR PRIMARY KEY, snapshot_id VARCHAR, symbol VARCHAR, market VARCHAR,
    model VARCHAR, direction VARCHAR, confidence DOUBLE, generated_at BIGINT,
    expires_at BIGINT, payload VARCHAR
  );`);
  t.after(() => client.close());
  const failure = new AICLIRunner({ client, provider: fakeProvider(async () => { throw new Error('fixture failure'); }) });
  await failure.verifyIsolation();
  await assert.rejects(failure.runAnalysis(snapshot('BTCUSDT'), 'fixture-model'), /fixture failure/);
  assert.equal((await client.all('SELECT COUNT(*) AS calls FROM ai_quota_ledger'))[0].calls, 1);

  let signal: AbortSignal | undefined;
  const timeout = new AICLIRunner({ client, provider: fakeProvider(async (_items, _model, inputSignal) => {
    signal = inputSignal;
    return new Promise(() => {});
  }) });
  await timeout.verifyIsolation();
  Object.defineProperty(timeout, 'TASK_TIMEOUT_MS', { value: 5 });
  await assert.rejects(timeout.runAnalysis(snapshot('ETHUSDT'), 'fixture-model'), /timed out/);
  assert.equal(signal?.aborted, true);
  assert.equal((await client.all('SELECT COUNT(*) AS calls FROM ai_quota_ledger'))[0].calls, 2);
});

test('periodic scheduler submits the locked spot scope and selected model as one batch', async () => {
  const symbols = Array.from({ length: 10 }, (_, index) => `X${index}USDT`);
  const collected: string[] = [];
  let submitted: { market: string; model: string; count: number } | undefined;
  const aggregator = {
    async buildSnapshot(symbol: string, market: 'spot' | 'futures') {
      assert.equal(market, 'spot');
      collected.push(symbol);
      return snapshot(symbol, market);
    },
  };
  const runner = {
    isIsolationVerified: () => true,
    async runBatchAnalysis(items: ReturnType<typeof snapshot>[], model: string) {
      submitted = { market: items[0].marketType, model, count: items.length };
      return [];
    },
  } as unknown as AICLIRunner;
  const scheduler = new AIScheduler({
    aggregator: aggregator as any,
    cliRunner: runner,
    getScope: async () => ({ market: 'spot', symbols, model: 'selected-model' }),
  });
  await scheduler.runPeriodicAnalysis();
  assert.deepEqual(collected, symbols);
  assert.deepEqual(submitted, { market: 'spot', model: 'selected-model', count: 10 });
  scheduler.stop();
});

test('quota ledger persists Taipei daily limits and event windows across instances', async t => {
  const client = await createDuckDBClient(':memory:');
  t.after(() => client.close());
  const ledger = new AIQuotaLedger(client);
  const midnight = Date.parse('2026-10-30T15:59:00Z');
  assert.notEqual(taipeiDateKey(midnight), taipeiDateKey(midnight + 120_000));
  await ledger.reserve(true, midnight);
  assert.equal((await ledger.getStatus(midnight + 120_000)).dailyCallsUsed, 0);
  await assert.rejects(ledger.reserve(true, midnight + 60_000), /冷卻/);
  await ledger.reserve(true, midnight + 5 * 60_000);
  const restarted = new AIQuotaLedger(client);
  await assert.rejects(restarted.reserve(true, midnight + 10 * 60_000), /每小時/);
  assert.equal((await restarted.getStatus(midnight + 10 * 60_000)).eventTriggersInLastHour, 2);
  const nextDayStatus = await restarted.getStatus(midnight + 6 * 60_000);
  assert.equal(nextDayStatus.dailyCallsUsed, 1);
  const nextDay = midnight + 120_000;
  for (let index = 0; index < 143; index++) await restarted.reserve(false, nextDay);
  await assert.rejects(restarted.reserve(false, nextDay), /每日呼叫上限/);
});

test('scope persists selected market, symbols, and model and enforces owner lock', async t => {
  const client = await createDuckDBClient(':memory:');
  t.after(() => client.close());
  const store = new AIScopeStore(client);
  await store.setScope({ market: 'spot', symbols: ['abcusdt', 'BTCUSDT', 'ABCUSDT'], model: 'fixture-model' });
  const lock = await store.lockScope('batch-1');
  assert.deepEqual(lock, { market: 'spot', symbols: ['ABCUSDT', 'BTCUSDT'], model: 'fixture-model' });
  await assert.rejects(store.setScope({ market: 'futures', symbols: ['BTCUSDT'], model: 'other' }), /locked/);
  await assert.rejects(store.unlockScope('batch-2'), /owner/);
  const restartedStore = new AIScopeStore(client);
  assert.equal((await restartedStore.getScope()).lockOwner, 'batch-1');
  await store.unlockScope('batch-1');
  assert.equal((await store.getScope()).locked, false);
});

test('source adapters report real health from fake responses and sockets only', async () => {
  const rss = new RSSNewsSource(async () => new Response('<rss><channel></channel></rss>', { status: 200 }));
  assert.deepEqual(await rss.refresh(), []);
  assert.equal(rss.getHealth().status, 'healthy');
  const article = '<rss><channel><item><title>SEC approves spot ETF</title><link>https://example.test/a</link><description>fixture</description><pubDate>Fri, 30 Oct 2026 12:00:00 GMT</pubDate></item></channel></rss>';
  const dedupedNews = new RSSNewsSource(async () => new Response(article, { status: 200 }));
  assert.equal((await dedupedNews.refresh()).length, 1);
  assert.equal((await dedupedNews.refresh()).length, 0);
  assert.equal(dedupedNews.isMajorNews((await dedupedNews.getLatestNews())[0]), true);

  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const chain = new CoinMetricsSource(async url => url.includes('/catalog/')
    ? new Response(JSON.stringify({ data: [{ asset: 'btc', metrics: ['AdrActCnt', 'TxCnt'] }] }), { status: 200 })
    : new Response(JSON.stringify({ data: [{ AdrActCnt: '12', TxCnt: '34', time: today }] }), { status: 200 }));
  assert.equal((await chain.getAssetMetrics('BTCUSDT'))?.activeAddresses, 12);
  assert.equal(chain.getHealth('BTCUSDT', now).status, 'healthy');
  const emptyChain = new CoinMetricsSource(async url => url.includes('/catalog/')
    ? new Response(JSON.stringify({ data: [{ asset: 'btc', metrics: ['AdrActCnt'] }] }), { status: 200 })
    : new Response(JSON.stringify({ data: [{ AdrActCnt: null, TxCnt: null, time: today }] }), { status: 200 }));
  assert.equal(await emptyChain.getAssetMetrics('BTCUSDT'), null);
  assert.equal(emptyChain.getHealth('BTCUSDT', now).status, 'error');

  const socket = new EventEmitter() as EventEmitter & { close(): void; terminate(): void };
  socket.close = () => socket.emit('close');
  socket.terminate = socket.close;
  const derivatives = new BinanceDerivativesSource(
    async () => new Response('[]', { status: 200 }),
    () => socket as any,
  );
  derivatives.startLiquidationStream();
  socket.emit('open');
  assert.equal(derivatives.getHealth().status, 'healthy');
  assert.deepEqual(derivatives.getObservedLiquidations('BTCUSDT'), []);
  socket.emit('message', Buffer.from(JSON.stringify({ e: 'forceOrder', o: {
    s: 'BTCUSDT', S: 'SELL', p: '100', ap: '0', q: '2', z: '0', T: Date.now(),
  } })));
  assert.equal(derivatives.getObservedLiquidations('BTCUSDT').length, 1);
  derivatives.stop();
  assert.equal(derivatives.getHealth().status, 'missing');
});

test('snapshot keeps essential market valid while excluding stale daily on-chain cache', async () => {
  const now = Date.now();
  const lastOpen = Math.floor(now / 60_000) * 60_000 - 60_000;
  const rows = Array.from({ length: 30 }, (_, index) => {
    const openTime = lastOpen - (29 - index) * 60_000;
    return { open_time: openTime, open: 100, high: 101, low: 99, close: 100, volume: 2 };
  });
  const client = {
    all: async () => rows,
    run: async () => {},
    exec: async () => {},
    close: async () => {},
  };
  const derivatives = new BinanceDerivativesSource(async url => {
    if (url.includes('openInterest')) return new Response(JSON.stringify({ openInterest: '12' }), { status: 200 });
    if (url.includes('fundingRate')) return new Response(JSON.stringify([{ fundingRate: '0.001' }]), { status: 200 });
    return new Response('[]', { status: 200 });
  });
  const news = new RSSNewsSource(async () => new Response('<rss><channel></channel></rss>', { status: 200 }));
  const chain = new CoinMetricsSource(async () => new Response('{}', { status: 200 }));
  const oldDate = new Date(now - 4 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  chain.injectFixtures('BTCUSDT', {
    asset: 'btc', activeAddresses: 100, txCount: 200, date: oldDate,
    isDaily: true, note: 'old daily fixture',
  });
  const aggregator = new AIDataAggregator({
    client: client as any,
    derivativesSource: derivatives,
    newsSource: news,
    coinMetricsSource: chain,
  });
  const result = await aggregator.buildSnapshot('BTCUSDT', 'futures', now);
  assert.equal(result.essentialDataValid, true);
  assert.equal(result.sourceHealth?.onChain.status, 'stale');
  assert.equal(result.onChain, null);
  assert.equal(result.sourceHealth?.news.status, 'healthy');
  assert.equal(result.sourceHealth?.liquidations.status, 'healthy');
  assert.equal(result.sources.news, false);
  assert.equal(result.sources.liquidations, true);
});

test('snapshot refreshes via REST when DuckDB has stale tail or an old gap even with >= 20 rows', async () => {
  const now = Date.now();
  const lastOpen = Math.floor(now / 60_000) * 60_000 - 60_000;
  // DuckDB has 25 stale rows ending 5 minutes ago -> length >= 20, yet stale!
  const staleRows = Array.from({ length: 25 }, (_, index) => {
    const openTime = lastOpen - 300_000 - (24 - index) * 60_000;
    return { open_time: openTime, open: 10, high: 11, low: 9, close: 10, volume: 5 };
  });
  let restCalls = 0;
  const freshRestRaw = Array.from({ length: 30 }, (_, index) => {
    const openTime = lastOpen - (29 - index) * 60_000;
    return [openTime, '12', '13', '11', '12.5', '100'];
  });
  const aggregator = new AIDataAggregator({
    client: { all: async () => staleRows, run: async () => {}, exec: async () => {}, close: async () => {} } as any,
    derivativesSource: new BinanceDerivativesSource(async () => new Response('[]', { status: 200 })),
    newsSource: new RSSNewsSource(async () => new Response('<rss><channel></channel></rss>', { status: 200 })),
    coinMetricsSource: new CoinMetricsSource(async () => new Response('{}', { status: 200 })),
    fetchKlines: async () => {
      restCalls += 1;
      return freshRestRaw;
    },
  });
  const snap = await aggregator.buildSnapshot('SUIUSDT', 'futures', now);
  assert.equal(restCalls, 1);
  assert.equal(snap.essentialDataValid, true);
  assert.equal(snap.klines.length, 30);
  assert.equal(snap.market.price, 12.5);
});
