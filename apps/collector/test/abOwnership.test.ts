import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createDuckDBClient } from '../src/storage/duckdb.ts';
import { initDatabase } from '../src/storage/duckdb.ts';
import { StorageWriter } from '../src/storage/writer.ts';
import { LiveHub } from '../src/live/hub.ts';
import { GapDetector } from '../src/gaps/gapDetector.ts';
import { SessionManager } from '../src/gaps/sessions.ts';
import { BinanceStreamManager } from '../src/binance/streams.ts';
import { UniverseManager } from '../src/ingest/universe.ts';
import { CollectorEventsManager } from '../src/events/collectorEvents.ts';
import { createServer } from '../src/api/server.ts';
import { abStorageTransaction } from '../src/ai/abStorage.ts';
import { activateABOwnershipGeneration, claimABLease, getABLease, ownsABLease, renewABLease } from '../src/ai/abOwnership.ts';
import { AIDataAggregator } from '../src/ai/aiDataAggregator.ts';
import { AICLIRunner } from '../src/ai/cliRunner.ts';
import { ABComparisonCoordinator, createAIDataSnapshot, defaultAutoTradingConfig, stringifyWithInfinity } from '@fadachi/core';

test('A/B leases fence live owners, expire after 15 seconds, and reject stale generations', async (t) => {
  const db = await createDuckDBClient(':memory:');
  const transaction = abStorageTransaction(db);
  t.after(() => db.close());
  await transaction(connection => activateABOwnershipGeneration(connection, 'generation-1'));

  const first = await transaction(connection => claimABLease(connection, 'batch-1', 'generation-1', 1_000));
  assert.equal(first.owner, true);
  if (!first.owner) return;
  assert.equal(first.lease.expiresAt, 16_000);
  const second = await transaction(connection => claimABLease(connection, 'batch-1', 'generation-1', 5_000));
  assert.deepEqual(second, { owner: false, expiresAt: 16_000 });
  assert.equal(await transaction(connection => ownsABLease(connection, 'batch-1', first.lease.ownerToken, 'generation-1', 5_000)), true);
  assert.equal(await transaction(connection => renewABLease(connection, 'batch-1', first.lease.ownerToken, 'generation-1', 5_000)), true);
  assert.equal((await transaction(connection => getABLease(connection, 'batch-1')))?.expiresAt, 20_000);

  const afterExpiry = await transaction(connection => claimABLease(connection, 'batch-1', 'generation-1', 20_000));
  assert.equal(afterExpiry.owner, true);
  if (afterExpiry.owner) {
    assert.notEqual(afterExpiry.lease.ownerToken, first.lease.ownerToken);
    assert.equal(await transaction(connection => ownsABLease(connection, 'batch-1', first.lease.ownerToken, 'generation-1', 20_001)), false);
  }

  await transaction(connection => activateABOwnershipGeneration(connection, 'generation-2'));
  assert.equal(await transaction(connection => ownsABLease(connection, 'batch-1', afterExpiry.owner ? afterExpiry.lease.ownerToken : '', 'generation-1', 20_003)), false);
  const afterRestart = await transaction(connection => claimABLease(connection, 'batch-1', 'generation-2', 20_002));
  assert.equal(afterRestart.owner, true);
});

test('A/B API allows one owner and atomically recovers only expired ownership', async (t) => {
  const db = await createDuckDBClient(':memory:');
  await initDatabase(db, path.resolve(import.meta.dirname, '..', 'src', 'storage', 'schema.sql'));
  const writer = new StorageWriter(db);
  const liveHub = new LiveHub();
  const sessionManager = new SessionManager(db, 'futures');
  const gapDetector = new GapDetector(db, 'futures');
  const streamManager = new BinanceStreamManager('futures', [], { onMessage: () => {} });
  const universeManager = new UniverseManager(db, 10);
  const eventsManager = new CollectorEventsManager(db, 'futures');
  let providerCalls = 0;
  const aggregator = new AIDataAggregator({ client: db });
  aggregator.buildSnapshot = async (symbol, market) => {
    const now = Date.now();
    const cutoffTime = Math.floor(now / 60_000) * 60_000;
    const lastCandle = cutoffTime / 1000 - 60;
    return createAIDataSnapshot({
      symbol, marketType: market, cutoffTime, now,
      market: { price: 100, priceChangePercent: 0, volume: 1, quoteVolume: 100, high: 100, low: 100, open: 100, priceTimestamp: cutoffTime - 1000 },
      klines: Array.from({ length: 30 }, (_, i) => ({ time: lastCandle - (29 - i) * 60, open: 100, high: 100, low: 100, close: 100, volume: 1 })),
      indicators: { sma20: 100 },
    });
  };
  const runner = new AICLIRunner({ client: db, provider: {
    verifyIsolation: async () => ({ verified: true }),
    getModels: async () => ['model-test'],
    analyzeBatch: async (snapshots) => {
      providerCalls++;
      return { analyses: snapshots.map(snapshot => ({
        symbol: snapshot.symbol, marketType: snapshot.marketType, direction: 'LONG', confidence: 80,
        reasoning: 'fixture', bullishEvidence: ['fixture evidence'], bearishEvidence: [], risks: [],
      })) };
    },
  } });
  const server = createServer({
    client: db, writer, liveHub, gapDetector, sessionManager, streamManager, universeManager,
    eventsManager, dataDir: process.cwd(), token: 'lease-test',
    aiAggregator: aggregator, cliRunner: runner,
  });
  t.after(async () => { await server.close(); liveHub.close(); await writer.stop(); await db.close(); });

  const now = Date.now();
  const coordinator = new ABComparisonCoordinator('futures');
  coordinator.setRules({ BTCUSDT: { stepSize: 0.001, minQty: 0.001, maxQty: 1000, minNotional: 5 } });
  coordinator.setStreamHealthy(true, now);
  coordinator.start(defaultAutoTradingConfig('futures'), ['BTCUSDT'], 'model-test', now);
  const batch = coordinator.snapshot();
  batch.accountB.fundingStatus = 'ERROR';
  const headers = { authorization: 'Bearer lease-test', 'content-type': 'application/json' };

  const scope = await server.inject({ method: 'PUT', url: '/api/ai/scope', headers, payload: {
    market: 'spot', symbols: ['DOGEUSDT'], model: 'model-test',
  } });
  assert.equal(scope.statusCode, 200);
  assert.deepEqual(scope.json().symbols, ['DOGEUSDT']);
  assert.equal((await server.inject({ method: 'POST', url: '/api/ai/scope/lock', headers, payload: { owner: 'scope-owner' } })).statusCode, 200);
  assert.equal((await server.inject({ method: 'PUT', url: '/api/ai/scope', headers, payload: {
    market: 'futures', symbols: ['BTCUSDT'], model: 'model-test',
  } })).statusCode, 409);
  assert.equal((await server.inject({ method: 'POST', url: '/api/ai/scope/unlock', headers, payload: { owner: 'scope-owner' } })).statusCode, 200);

  await db.run(`INSERT INTO ai_analysis_results (id,snapshot_id,symbol,market,model,direction,confidence,generated_at,expires_at,payload)
    VALUES ('analysis-model','snap-model','DOGEUSDT','spot','model-test','LONG',80,?,?,'{"model":"model-test"}'),
           ('analysis-other','snap-other','DOGEUSDT','spot','other-model','SHORT',75,?,?,'{"model":"other-model"}')`,
  now, now + 60_000, now + 1, now + 60_001);
  const status = await server.inject({ method: 'GET', url: '/api/ai/status?market=spot', headers });
  assert.equal(status.statusCode, 200);
  assert.deepEqual(status.json().trackedSymbols, ['DOGEUSDT']);
  assert.equal(status.json().latestAnalyses.DOGEUSDT.model, 'model-test');
  const batchTrigger = await server.inject({ method: 'POST', url: '/api/ai/trigger', headers, payload: {
    symbols: ['BTCUSDT', 'ETHUSDT'], market: 'spot', model: 'model-test',
  } });
  assert.equal(batchTrigger.statusCode, 200, batchTrigger.body);
  assert.equal(batchTrigger.json().analyses.length, 2);
  assert.equal(providerCalls, 1);

  const firstClaim = await server.inject({ method: 'POST', url: `/api/ab/batches/${batch.id}/claim`, headers, payload: {} });
  assert.equal(firstClaim.statusCode, 200);
  const owner = firstClaim.json();
  assert.equal(owner.owner, true);
  const savePayload = (revision = batch.revision, value = batch, ownerToken = owner.ownerToken) => stringifyWithInfinity({
    id: value.id, market: value.marketType, status: value.status, revision, model: value.model,
    batch: value, ownerToken, generation: owner.generation,
  });
  assert.equal((await server.inject({ method: 'PUT', url: '/api/ab/batches', headers, payload: savePayload() })).statusCode, 200);
  const csv = await server.inject({ method: 'GET', url: `/api/ab/batches/${batch.id}/export.csv`, headers });
  assert.equal(csv.statusCode, 200);
  assert.match(csv.body, /account_b_funding_status,ERROR/);
  assert.match(csv.body, /pair_cost_status,PROVISIONAL/);
  assert.match(csv.body, /common_cutoff_utc,/);

  const secondClaim = await server.inject({ method: 'POST', url: `/api/ab/batches/${batch.id}/claim`, headers, payload: {} });
  assert.equal(secondClaim.statusCode, 200);
  assert.equal(secondClaim.json().owner, false);
  assert.equal((await server.inject({ method: 'PUT', url: '/api/ab/batches', headers, payload: savePayload(batch.revision + 1, { ...batch, revision: batch.revision + 1 }, 'other-client-token') })).statusCode, 409);

  await db.run('UPDATE ab_batch_leases SET expires_at = ? WHERE batch_id = ?;', Date.now() - 1, batch.id);
  const recoveredClaim = await server.inject({ method: 'POST', url: `/api/ab/batches/${batch.id}/claim`, headers, payload: {} });
  assert.equal(recoveredClaim.statusCode, 200);
  assert.equal(recoveredClaim.json().owner, true);
  assert.equal(recoveredClaim.json().batch.status, 'INTERRUPTED');
  assert.ok(recoveredClaim.json().batch.revision > batch.revision);
  assert.equal((await server.inject({ method: 'POST', url: `/api/ab/batches/${batch.id}/lease`, headers, payload: { ownerToken: owner.ownerToken, generation: owner.generation } })).statusCode, 409);
  const staleWrite = { ...batch, revision: batch.revision + 1 };
  assert.equal((await server.inject({ method: 'PUT', url: '/api/ab/batches', headers, payload: savePayload(staleWrite.revision, staleWrite) })).statusCode, 409);
});
