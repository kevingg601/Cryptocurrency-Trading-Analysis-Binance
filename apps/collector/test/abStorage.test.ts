import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createDuckDBClient, initDatabase } from '../src/storage/duckdb.ts';
import { StorageWriter } from '../src/storage/writer.ts';
import { LiveHub } from '../src/live/hub.ts';
import { GapDetector } from '../src/gaps/gapDetector.ts';
import { SessionManager } from '../src/gaps/sessions.ts';
import { BinanceStreamManager } from '../src/binance/streams.ts';
import { UniverseManager } from '../src/ingest/universe.ts';
import { CollectorEventsManager } from '../src/events/collectorEvents.ts';
import { createServer } from '../src/api/server.ts';
import { AIDataAggregator } from '../src/ai/aiDataAggregator.ts';
import { AICLIRunner } from '../src/ai/cliRunner.ts';
import { abStorageTransaction } from '../src/ai/abStorage.ts';
import type { DuckDBClient } from '../src/storage/duckdb.ts';
import {
  ABComparisonCoordinator,
  defaultAutoTradingConfig,
  stringifyWithInfinity,
  parseWithInfinity,
  createAIDataSnapshot,
} from '@fadachi/core';

test('Collector AI & AB Storage API: persistence, atomic concurrency, Infinity encoding, and CSV export', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fadachi-ab-test-'));
  const dbPath = path.join(tmpDir, 'test.duckdb');
  const client = await createDuckDBClient(dbPath);
  const schemaPath = path.resolve(import.meta.dirname, '..', 'src', 'storage', 'schema.sql');
  await initDatabase(client, schemaPath);

  const writer = new StorageWriter(client);
  const liveHub = new LiveHub();
  const sessionManager = new SessionManager(client, 'futures');
  const gapDetector = new GapDetector(client, 'futures', tmpDir);
  const streamManager = new BinanceStreamManager('futures', [], { onMessage: () => {} });
  const universeManager = new UniverseManager(client, 10);
  const eventsManager = new CollectorEventsManager(client, 'futures');

  const aiAggregator = new AIDataAggregator({ client });
  // Fixed offline sources: this API test verifies contracts, not live providers.
  aiAggregator.derivatives.fetchOpenInterest = async () => null;
  aiAggregator.derivatives.fetchFundingRate = async () => null;
  aiAggregator.derivatives.fetchRecentLiquidationOrders = async () => [];
  aiAggregator.news.injectFixtures([{ id: 'fixture-news', title: 'fixture', summary: 'offline', link: 'https://example.com/fixture', source: 'fixture', publishedAt: Date.now(), receivedAt: Date.now() }]);
  aiAggregator.coinMetrics.injectFixtures('BTCUSDT', { asset: 'btc', isDaily: true, note: 'offline fixture' });
  const cliRunner = new AICLIRunner({
    client,
    provider: {
      verifyIsolation: async () => ({ verified: true }),
      getModels: async () => ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-thinking'],
      analyzeBatch: async (snapshots, model) => ({
        analyses: snapshots.map(snapshot => ({
          symbol: snapshot.symbol,
          marketType: snapshot.marketType,
          direction: 'LONG',
          confidence: 88,
          reasoning: `Mock analysis for ${snapshot.symbol} with ${model}`,
          bullishEvidence: ['Technical breakout', 'OI expanding'],
          bearishEvidence: [],
          risks: ['General market risk'],
        })),
      }),
    },
    mockProvider: async (snapshot, model) => {
      return {
        direction: 'LONG',
        confidence: 88,
        reasoning: `Mock analysis for ${snapshot.symbol} with ${model}`,
        bullishEvidence: ['Technical breakout', 'OI expanding'],
        bearishEvidence: [],
        risks: ['General market risk'],
      };
    },
  });

  const server = createServer({
    client,
    writer,
    liveHub,
    gapDetector,
    sessionManager,
    streamManager,
    universeManager,
    eventsManager,
    dataDir: tmpDir,
    token: 'test-token',
    aiAggregator,
    cliRunner,
  });

  t.after(async () => {
    await server.close();
    liveHub.close();
    await writer.stop();
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. Check AI Status
  const statusRes = await server.inject({
    method: 'GET',
    url: '/api/ai/status?market=futures',
    headers: { authorization: 'Bearer test-token' },
  });
  assert.equal(statusRes.statusCode, 200);
  const statusData = statusRes.json();
  assert.equal(statusData.market, 'futures');
  assert.equal(statusData.quota.dailyCallsUsed, 0);
  assert.equal(statusData.quota.dailyCallsLimit, 144);
  assert.equal(statusData.isolationVerified, true);
  assert.ok(statusData.models.includes('gemini-2.5-flash'));

  // 2. Trigger AI Analysis with mock provider
  // Insert minimum required klines so essential data passes
  const now = Date.now();
  const lastOpen = Math.floor(now / 60_000) * 60_000 - 60_000;
  for (let i = 0; i < 30; i++) {
    await client.run(
      `INSERT INTO klines_1m (market, symbol, open_time, open, high, low, close, volume, quote_volume, is_final, source)
       VALUES ('futures', 'BTCUSDT', ?, 50000, 50100, 49900, 50050, 10, 500500, true, 'ws');`,
      lastOpen - (29 - i) * 60_000
    );
  }

  const triggerRes = await server.inject({
    method: 'POST',
    url: '/api/ai/trigger',
    headers: { authorization: 'Bearer test-token' },
    payload: {
      symbol: 'BTCUSDT',
      market: 'futures',
      model: 'gemini-2.5-flash',
    },
  });
  assert.equal(triggerRes.statusCode, 200);
  const triggerData = triggerRes.json();
  assert.equal(triggerData.success, true);
  assert.equal(triggerData.analysis.direction, 'LONG');
  assert.equal(triggerData.analysis.confidence, 88);

  // Check quota increased to 1
  const quotaAfter = cliRunner.getQuotaStatus();
  assert.equal(quotaAfter.dailyCallsUsed, 1);

  // 3. Save A/B batch with Infinity in exit orders
  const coord = new ABComparisonCoordinator('futures');
  coord.setRules({ BTCUSDT: { stepSize: 0.001, minQty: 0.001, maxQty: 1000, minNotional: 5 } });
  coord.setStreamHealthy(true, now);
  coord.start(defaultAutoTradingConfig('futures'), ['BTCUSDT'], 'gemini-2.5-flash', now);

  const initialBatch = coord.snapshot();
  // Manually add an exit order with expiresAt: Infinity to verify lossless persistence
  initialBatch.accountB.orders.push({
    id: 'exit-1',
    planId: 'plan-1',
    symbol: 'BTCUSDT',
    side: 'LONG',
    kind: 'EXIT',
    reason: 'TP1',
    createdAt: now,
    eligibleAt: now + 250,
    expiresAt: Infinity, // Infinity preserved!
    signalTimestamp: now,
  });

  // Add an entry decision to verify persistence to ai_entry_decisions table
  initialBatch.decisions.push({
    id: 'dec-test-1',
    batchId: initialBatch.id,
    planId: 'plan-test-1',
    symbol: 'BTCUSDT',
    marketType: 'futures',
    account: 'B',
    allowed: true,
    reason: 'ACCEPTED',
    analysisId: 'analysis-test-1',
    timestamp: now,
    confirmedSide: 'LONG',
    analysisDirection: 'LONG',
    explanation: 'AI permission granted',
  });

  const claimRes = await server.inject({
    method: 'POST',
    url: `/api/ab/batches/${encodeURIComponent(initialBatch.id)}/claim`,
    headers: { authorization: 'Bearer test-token' },
    payload: {},
  });
  assert.equal(claimRes.statusCode, 200);
  const lease = claimRes.json();

  const saveRes = await server.inject({
    method: 'PUT',
    url: '/api/ab/batches',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    payload: stringifyWithInfinity({
      id: initialBatch.id,
      market: 'futures',
      status: initialBatch.status,
      revision: initialBatch.revision,
      model: initialBatch.model,
      batch: initialBatch,
      ownerToken: lease.ownerToken,
      generation: lease.generation,
    }),
  });
  assert.equal(saveRes.statusCode, 200);

  // Verify decisions table was populated in DuckDB
  const decisionRows = await client.all('SELECT * FROM ai_entry_decisions WHERE batch_id = ?;', initialBatch.id);
  assert.equal(decisionRows.length, 1, 'Decision must be persisted in ai_entry_decisions table');
  assert.equal(decisionRows[0].id, 'dec-test-1');
  assert.equal(decisionRows[0].allowed, true);

  // Verify GET /api/ab/batches/:id/decisions endpoint
  const decEndpointRes = await server.inject({
    method: 'GET',
    url: `/api/ab/batches/${encodeURIComponent(initialBatch.id)}/decisions`,
    headers: { authorization: 'Bearer test-token' },
  });
  assert.equal(decEndpointRes.statusCode, 200);
  const decList = decEndpointRes.json();
  assert.equal(decList.length, 1);
  assert.equal(decList[0].id, 'dec-test-1');

  // 4. Retrieve A/B batch and verify Infinity was preserved without becoming null
  const getRes = await server.inject({
    method: 'GET',
    url: `/api/ab/batches/${encodeURIComponent(initialBatch.id)}`,
    headers: { authorization: 'Bearer test-token' },
  });
  assert.equal(getRes.statusCode, 200);
  const retrieved = parseWithInfinity<{ id: string; batch: any }>(getRes.body);
  assert.equal(retrieved.id, initialBatch.id);
  const exitOrder = retrieved.batch.accountB.orders.find((o: any) => o.id === 'exit-1');
  assert.ok(exitOrder, 'Exit order must exist');
  assert.equal(exitOrder.expiresAt, Infinity, 'expiresAt must remain Infinity, not null or 0');

  // 5. Concurrency control: out-of-order revision is rejected with HTTP 409
  const staleSaveRes = await server.inject({
    method: 'PUT',
    url: '/api/ab/batches',
    headers: { authorization: 'Bearer test-token' },
    payload: {
      id: initialBatch.id,
      market: 'futures',
      status: initialBatch.status,
      revision: initialBatch.revision - 1, // Stale revision!
      model: initialBatch.model,
      batch: { ...initialBatch, revision: initialBatch.revision - 1 },
      ownerToken: lease.ownerToken,
      generation: lease.generation,
    },
  });
  assert.equal(staleSaveRes.statusCode, 409, 'Stale revision must be rejected with 409 conflict');

  // Higher revision succeeds
  const nextSaveRes = await server.inject({
    method: 'PUT',
    url: '/api/ab/batches',
    headers: { authorization: 'Bearer test-token' },
    payload: {
      id: initialBatch.id,
      market: 'futures',
      status: 'PAUSED',
      revision: initialBatch.revision + 1,
      model: initialBatch.model,
      batch: { ...initialBatch, status: 'PAUSED', revision: initialBatch.revision + 1 },
      ownerToken: lease.ownerToken,
      generation: lease.generation,
    },
  });
  assert.equal(nextSaveRes.statusCode, 200);

  // 6. Test CSV Export endpoint
  const csvRes = await server.inject({
    method: 'GET',
    url: `/api/ab/batches/${encodeURIComponent(initialBatch.id)}/export.csv`,
    headers: { authorization: 'Bearer test-token' },
  });
  assert.equal(csvRes.statusCode, 200);
  assert.ok(csvRes.headers['content-type']?.includes('text/csv'));
  const csvContent = csvRes.body;
  assert.ok(csvContent.includes('batch_id,record_type,account'));

  const save = (batch: typeof initialBatch) => server.inject({
    method: 'PUT', url: '/api/ab/batches',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    payload: stringifyWithInfinity({
      id: batch.id, market: batch.marketType, status: batch.status, revision: batch.revision, model: batch.model, batch,
      ownerToken: lease.ownerToken, generation: lease.generation,
    }),
  });
  const current = { ...initialBatch, status: 'PAUSED' as const, revision: initialBatch.revision + 1 };
  assert.equal((await save(current)).statusCode, 200, 'exact retry is idempotent');
  assert.equal((await save({ ...current, reason: 'conflicting equal revision' })).statusCode, 409);
  assert.equal((await save({ ...current, revision: current.revision + 1, model: 'other-model' })).statusCode, 409);
  assert.equal((await save({ ...current, revision: current.revision + 1, decisions: [] })).statusCode, 409);
  const [writer1, writer2] = await Promise.all([
    save({ ...current, revision: current.revision + 1, reason: 'writer-one' }),
    save({ ...current, revision: current.revision + 1, reason: 'writer-two' }),
  ]);
  assert.deepEqual([writer1.statusCode, writer2.statusCode].sort(), [200, 409], 'one concurrent writer wins');
  const beforeFailure = (await client.all('SELECT revision, payload FROM ab_trading_batches WHERE id = ?;', initialBatch.id))[0];
  const failed = await save({
    ...current, revision: current.revision + 2,
    decisions: [
      ...current.decisions,
      { ...current.decisions[0], id: 'dec-before-failure' },
      { ...current.decisions[0], id: 'dec-invalid', planId: undefined as any },
    ],
  });
  assert.equal(failed.statusCode, 500, 'failure after batch and first decision writes is surfaced');
  assert.deepEqual((await client.all('SELECT revision, payload FROM ab_trading_batches WHERE id = ?;', initialBatch.id))[0], beforeFailure);
  assert.equal((await client.all("SELECT * FROM ai_entry_decisions WHERE id IN ('dec-before-failure','dec-invalid');")).length, 0, 'both tables roll back together');

  // Unrelated collector writes must not join a transaction that will roll back.
  await client.run('CREATE TABLE ab_review_transaction (value INTEGER)');
  let entered!: () => void;
  let release!: () => void;
  const entry = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const transaction = abStorageTransaction(client)(async connection => {
    await connection.run('INSERT INTO ab_review_transaction VALUES (1)');
    entered();
    await barrier;
    throw new Error('rollback fixture');
  });
  await entry;
  const outsideWrite = client.run('INSERT INTO ab_review_transaction VALUES (2)');
  release();
  await assert.rejects(transaction, /rollback fixture/);
  await outsideWrite;
  assert.deepEqual(await client.all('SELECT value FROM ab_review_transaction'), [{ value: 2 }]);

  // Provisional candles must never enter the analysis snapshot.
  await client.run(`INSERT INTO klines_1m (market,symbol,open_time,open,high,low,close,volume,quote_volume,is_final,source)
    VALUES ('futures','BTCUSDT',?,90000,90000,90000,90000,1,90000,false,'ws')`, now - 10_000);
  const finalizedSnapshot = await aiAggregator.buildSnapshot('BTCUSDT', 'futures', now);
  assert.ok(finalizedSnapshot.klines.every(k => k.close !== 90000));
  assert.equal(finalizedSnapshot.market.price, 50050);
  const disabled = t.mock.method(cliRunner, 'verifyIsolation', async () => false);
  const aggregate = t.mock.method(aiAggregator, 'buildSnapshot', async () => { throw new Error('must not collect while disabled'); });
  const disabledResponse = await server.inject({
    method: 'POST', url: '/api/ai/trigger', headers: { authorization: 'Bearer test-token' },
    payload: { symbol: 'BTCUSDT', market: 'futures' },
  });
  assert.equal(disabledResponse.statusCode, 503);
  assert.equal(aggregate.mock.callCount(), 0);
  disabled.mock.restore();
  aggregate.mock.restore();

  // 7. Isolation Guard: an unverified runner must reject runAnalysis
  const unverifiedRunner = new AICLIRunner({ client, cliCommand: 'non_existent_cli_xyz' });
  await assert.rejects(async () => {
    const snap = await aiAggregator.buildSnapshot('BTCUSDT', 'futures');
    await unverifiedRunner.runAnalysis(snap, 'gemini-2.5-flash');
  }, /AI CLI 隔離環境未通過驗證或不可用/);
});

function runnerSnapshot(now = Date.now()) {
  const lastOpen = Math.floor(now / 60_000) * 60 - 60;
  return createAIDataSnapshot({
    symbol: 'BTCUSDT', marketType: 'futures', cutoffTime: now, now,
    market: { price: 100, priceChangePercent: 0, volume: 1, quoteVolume: 100, high: 100, low: 100, open: 100, priceTimestamp: now },
    klines: Array.from({ length: 30 }, (_, i) => ({ time: lastOpen - (29 - i) * 60, open: 100, high: 100, low: 100, close: 100, volume: 1 })),
    indicators: { sma20: 100 },
  });
}

let quotaRows: Array<{ id: string; called_at: number; taipei_day: string; is_event: boolean }> = [];
const runnerClient: DuckDBClient = {
  all: async <T = any>(sql: string, ...params: any[]): Promise<T[]> => {
    if (sql.includes('COUNT(*) AS calls FROM ai_quota_ledger WHERE taipei_day')) {
      const day = params[0];
      const count = quotaRows.filter(r => r.taipei_day === day).length;
      return [{ calls: count }] as unknown as T[];
    }
    if (sql.includes('ai_quota_ledger WHERE called_at >=')) {
      const since = params[0];
      const matching = quotaRows.filter(r => r.called_at >= since && r.is_event);
      return [{ calls: matching.length, last_event_at: matching.length ? matching.at(-1)!.called_at : null }] as unknown as T[];
    }
    return [] as T[];
  },
  run: async (sql: string, ...params: any[]) => {
    if (sql.includes('INSERT INTO ai_quota_ledger')) {
      quotaRows.push({ id: params[0], called_at: params[1], taipei_day: params[2], is_event: params[3] });
    }
  },
  exec: async () => {},
  close: async () => {},
};
const runnerOutput = { direction: 'LONG', confidence: 80, reasoning: 'fixture', bullishEvidence: ['Technical breakout'], bearishEvidence: [], risks: [] };

test('review: production CLI remains disabled without verifiable isolation; stale work is rejected', async () => {
  const runner = new AICLIRunner({ client: runnerClient, cliCommand: 'node --help --sandbox --approval-mode' });
  assert.equal(await runner.verifyIsolation(), false);
  assert.deepEqual(runner.getAvailableModels(), []);
  await assert.rejects(runner.runAnalysis(runnerSnapshot()), /隔離環境未通過驗證/);
  const mock = new AICLIRunner({ client: runnerClient, mockProvider: async () => runnerOutput });
  await assert.rejects(mock.runAnalysis(runnerSnapshot(Date.now() - 1_200_001)), /過期/);
  assert.equal(mock.getQuotaStatus().dailyCallsUsed, 0);
});

test('review: pending analyses recheck daily quota at execution', async () => {
  quotaRows = [];
  let release!: (value: typeof runnerOutput) => void;
  // Use the same instance's budget rather than mutating its private state.
  let calls = 0;
  const limited = new AICLIRunner({ client: runnerClient, mockProvider: async () => {
    if (++calls === 143) return new Promise(resolve => { release = resolve; });
    return runnerOutput;
  } });
  for (let i = 0; i < 142; i++) await limited.runAnalysis(runnerSnapshot());
  const active = limited.runAnalysis(runnerSnapshot());
  const superseded = limited.runAnalysis(runnerSnapshot());
  const pending = limited.runAnalysis(runnerSnapshot());
  assert.equal(await superseded, null);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release(runnerOutput);
  await active;
  await pending;
  assert.equal(limited.getQuotaStatus().dailyCallsUsed, 144);
  await assert.rejects(limited.runAnalysis(runnerSnapshot()), /每日呼叫上限/);
  assert.equal(calls, 144);
});

test('review: timeout releases the runner without blocking subsequent requests', async t => {
  quotaRows = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const runner = new AICLIRunner({ client: runnerClient, mockProvider: () => new Promise(() => {}) });
  const active = runner.runAnalysis(runnerSnapshot());
  const failed = assert.rejects(active, /timed out/);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(120_000);
  await failed;
  assert.equal(runner.getQuotaStatus().isBusy, false);
  assert.equal(runner.getQuotaStatus().hasPending, false);
});
