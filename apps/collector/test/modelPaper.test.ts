import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MODEL_PAPER_CONFIG,
  type AutoFundingRecord,
  type AutoSymbolRules,
  type ModelPaperExperimentRecord,
  type ModelSource,
  type PaperAccountState,
  type PaperOrder,
  type PaperPosition,
} from '@fadachi/core';
import { ModelResearchBusyError } from '../src/research/modelResearchRunner.ts';
import { createDuckDBClient, initDatabase } from '../src/storage/duckdb.ts';
import { DataNotReadyError, FUNDING_RATES_CSV_COLUMNS, KLINES_1H_CSV_COLUMNS, MarketCacheUpdater } from '../src/modelPaper/marketCache.ts';
import { PaperExecutor } from '../src/modelPaper/executor.ts';
import { FundingSettler } from '../src/modelPaper/funding.ts';
import { ForwardScheduler } from '../src/modelPaper/scheduler.ts';
import { ModelPaperStore } from '../src/modelPaper/store.ts';
import { TradeBus } from '../src/modelPaper/tradeBus.ts';
import type { ForwardInferenceCoordinator, ForwardInferenceOutput } from '../src/modelPaper/forwardInference.ts';

const SCHEMA_PATH = path.resolve(import.meta.dirname, '..', 'src', 'storage', 'schema.sql');
const ONE_HOUR_MS = 3_600_000;
const EIGHT_HOURS_MS = 8 * ONE_HOUR_MS;

function makeRules(symbols: string[]): Record<string, AutoSymbolRules> {
  const out: Record<string, AutoSymbolRules> = {};
  for (const sym of symbols) {
    out[sym] = {
      stepSize: 0.001,
      minQty: 0.001,
      maxQty: 10_000,
      minNotional: 5,
      maxNotional: 100_000,
    };
  }
  return out;
}

class FakeClock {
  currentNow: number;
  private nextId = 1;
  readonly timers = new Map<number, { fn: () => void; fireAt: number }>();

  constructor(initialNow: number) {
    this.currentNow = initialNow;
  }

  now = (): number => this.currentNow;

  setTimeout = (fn: () => void, delayMs: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { fn, fireAt: this.currentNow + delayMs });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    if (typeof handle === 'number') {
      this.timers.delete(handle);
    }
  };

  advanceTo(ts: number): void {
    this.currentNow = ts;
  }

  async flushDue(): Promise<void> {
    const due = Array.from(this.timers.entries())
      .filter(([, t]) => t.fireAt <= this.currentNow)
      .sort((a, b) => a[1].fireAt - b[1].fireAt);
    for (const [id, timer] of due) {
      this.timers.delete(id);
      timer.fn();
      await new Promise(resolve => setImmediate(resolve));
    }
  }
}

const dummyModelSource: ModelSource = {
  adapterRunId: 'run-test-1',
  adapterRunDir: '/tmp/run-test-1',
  attemptDir: '/tmp/run-test-1/chronos2/attempt_1',
  artifactHashes: {
    'adapter/adapter_config.json': 'a'.repeat(64),
    'adapter/adapter_model.safetensors': 'b'.repeat(64),
  },
  adapterSha256Json: {
    'adapter_config.json': 'a'.repeat(64),
    'adapter_model.safetensors': 'b'.repeat(64),
  },
  fingerprint: 'fp-1',
  baseRepoId: 'amazon/chronos-2',
  baseRevision: 'rev-1',
  baseFiles: {},
};

function makeExp(id: string, createdAt: number, universe = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']): ModelPaperExperimentRecord {
  return {
    id,
    createdAt,
    status: 'RUNNING',
    config: { ...DEFAULT_MODEL_PAPER_CONFIG },
    modelKey: 'chronos2',
    modelSource: dummyModelSource,
    universe,
    startedAt: createdAt,
    stoppedAt: null,
    heartbeatAt: createdAt,
    statusReason: null,
  };
}

function makeAccount(expId: string, account: 'A' | 'B', cash = 10_000, updatedAt = 1_700_000_000_000): PaperAccountState {
  return {
    experimentId: expId,
    account,
    cash,
    reserved: 0,
    realizedPnl: 0,
    fees: 0,
    funding: 0,
    bankrupt: false,
    degraded: false,
    fundingPending: false,
    stoppedThisHour: [],
    updatedAt,
  };
}

test('MarketCacheUpdater: incremental CSV append, (symbol, open_time) dedup, closeTime<now, DATA_NOT_READY, and parquet untampered', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fadachi-mp-cache-'));
  const client = await createDuckDBClient(path.join(tmpDir, 'test.duckdb'));
  try {
    await initDatabase(client, SCHEMA_PATH);

    // Create tiny real parquet files via DuckDB to prove base parquet is read-only and never overwritten
    const baseKlinesParquet = path.join(tmpDir, 'klines_1h.parquet');
    const baseFundingParquet = path.join(tmpDir, 'funding_rates.parquet');
    const H0 = 1_700_006_400_000; // aligned UTC hour
    const H1 = H0 + ONE_HOUR_MS;
    const H2 = H1 + ONE_HOUR_MS;

    await client.exec(`
      CREATE TEMP TABLE tmp_k AS
      SELECT 'BTCUSDT' AS symbol, ${H0}::BIGINT AS open_time, ${H0 + ONE_HOUR_MS - 1}::BIGINT AS close_time,
        100.0 AS open, 101.0 AS high, 99.0 AS low, 100.5 AS close,
        10.0 AS volume, 1005.0 AS quote_volume, 50::BIGINT AS trades,
        5.0 AS taker_buy_base, 502.5 AS taker_buy_quote, true AS is_final, 'binance_rest_1h' AS source;
      COPY tmp_k TO '${baseKlinesParquet.replace(/\\/g, '/')}' (FORMAT PARQUET);
      DROP TABLE tmp_k;

      CREATE TEMP TABLE tmp_f AS
      SELECT 'BTCUSDT' AS symbol, ${H0}::BIGINT AS funding_time, 0.0001 AS funding_rate,
        100.5 AS mark_price, 'binance_rest_funding' AS source;
      COPY tmp_f TO '${baseFundingParquet.replace(/\\/g, '/')}' (FORMAT PARQUET);
      DROP TABLE tmp_f;
    `);

    const klinePqHashBefore = crypto.createHash('sha256').update(fs.readFileSync(baseKlinesParquet)).digest('hex');
    const fundingPqHashBefore = crypto.createHash('sha256').update(fs.readFileSync(baseFundingParquet)).digest('hex');

    const requestedStarts: Record<string, string> = {};
    let returnTargetForEth = false;

    const fakeFetch: typeof fetch = async (input) => {
      const url = new URL(String(input));
      const sym = url.searchParams.get('symbol')!;
      requestedStarts[sym] = url.searchParams.get('startTime')!;

      const rows: unknown[] = [];
      if (sym === 'BTCUSDT') {
        // Overlapping H0 (already in parquet), valid closed H1, plus unclosed future bar closeTime >= now
        rows.push(
          [H0, '100', '101', '99', '100.5', '10', H0 + ONE_HOUR_MS - 1, '1005', 50, '5', '502.5', '0'],
          [H1, '100.5', '102', '100', '101.5', '12', H1 + ONE_HOUR_MS - 1, '1218', 60, '6', '609', '0'],
          [H2, '101.5', '103', '101', '102.0', '5', H2 + ONE_HOUR_MS - 1, '510', 20, '2', '204', '0'],
        );
      } else {
        // ETHUSDT initially omits H1
        rows.push([H0, '50', '51', '49', '50.2', '100', H0 + ONE_HOUR_MS - 1, '5020', 80, '50', '2510', '0']);
        if (returnTargetForEth) {
          rows.push([H1, '50.2', '52', '50', '51.5', '110', H1 + ONE_HOUR_MS - 1, '5600', 90, '55', '2800', '0']);
        }
      }
      return new Response(JSON.stringify(rows), { status: 200 });
    };

    const fundingCalls: string[] = [];
    const fakeFunding = async (sym: string, start: number, _end: number): Promise<AutoFundingRecord[]> => {
      fundingCalls.push(`${sym}:${start}`);
      return [
        { symbol: sym, fundingTime: H0, fundingRate: 0.0001, markPrice: 100 },
        { symbol: sym, fundingTime: H1, fundingRate: 0.0002, markPrice: 101 },
      ];
    };

    const updater = new MarketCacheUpdater({
      dataDir: tmpDir,
      client,
      fetchImpl: fakeFetch,
      fetchFundingHistory: fakeFunding,
      baseKlinesParquetPath: baseKlinesParquet,
      baseFundingParquetPath: baseFundingParquet,
    });

    const nowDuringH2 = H1 + ONE_HOUR_MS + 30_000;
    await assert.rejects(
      () => updater.update(['BTCUSDT', 'ETHUSDT'], H1, nowDuringH2),
      (err: unknown) => err instanceof DataNotReadyError && err.missingSymbols.includes('ETHUSDT'),
    );

    // BTC incremental query started from H0 + 1h
    assert.equal(requestedStarts['BTCUSDT'], String(H0 + ONE_HOUR_MS));

    // Verify exact CSV column headers & deduplicated H1 saved even on partial failure
    const klinesLines1 = fs.readFileSync(updater.klinesCsvPath, 'utf8').trim().split(/\r?\n/);
    assert.equal(klinesLines1[0], KLINES_1H_CSV_COLUMNS.join(','));
    assert.equal(klinesLines1.length, 3); // header + BTC H1 + ETH H0 (H2 unclosed filtered out!)

    // Now allow ETH H1 and retry
    returnTargetForEth = true;
    const res2 = await updater.update(['BTCUSDT', 'ETHUSDT'], H1, nowDuringH2);
    assert.equal(res2.addedKlineRows, 1); // only ETH H1 appended; BTC H1 & ETH H0 not duplicated
    const klinesLines2 = fs.readFileSync(updater.klinesCsvPath, 'utf8').trim().split(/\r?\n/);
    assert.equal(klinesLines2.length, 4);

    // Run a third time: 0 duplicate klines and 0 duplicate funding rows
    const res3 = await updater.update(['BTCUSDT', 'ETHUSDT'], H1, nowDuringH2);
    assert.equal(res3.addedKlineRows, 0);
    assert.equal(res3.addedFundingRows, 0);

    const fundingLines = fs.readFileSync(updater.fundingCsvPath, 'utf8').trim().split(/\r?\n/);
    assert.equal(fundingLines[0], FUNDING_RATES_CSV_COLUMNS.join(','));
    assert.equal(fundingLines.length, 4); // header + BTC H1 + ETH H0 + ETH H1 (BTC H0 already in parquet!)

    // Verify base parquets are untouched byte-for-byte
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(baseKlinesParquet)).digest('hex'), klinePqHashBefore);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(baseFundingParquet)).digest('hex'), fundingPqHashBefore);
  } finally {
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('PaperExecutor: 250ms fill delay, duplicate aggId guard, gap-through SL, 5s stale -> AWAITING_RESUME, 60s entry timeout vs exit no-timeout', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fadachi-mp-exec-'));
  const client = await createDuckDBClient(path.join(tmpDir, 'test.duckdb'));
  try {
    await initDatabase(client, SCHEMA_PATH);
    const store = new ModelPaperStore(client);
    const tradeBus = new TradeBus();
    const baseNow = 1_700_006_400_000;
    const clock = new FakeClock(baseNow);
    const rules = makeRules(['BTCUSDT', 'ETHUSDT']);

    const exp = makeExp('exp-exec', baseNow);
    await store.withTx(async (tx) => {
      await store.insertExperiment(exp, tx);
      await store.insertAccounts([makeAccount(exp.id, 'A', 10_000, baseNow), makeAccount(exp.id, 'B', 10_000, baseNow)], tx);
    });

    const awaitingResumeCalls: string[] = [];
    const executor = new PaperExecutor({
      store,
      tradeBus,
      clock,
      getOwnedExperimentIds: () => [exp.id],
      getRules: () => rules,
      onAwaitingResume: (id) => awaitingResumeCalls.push(id),
    });

    // Submit ENTRY order for Account A BTCUSDT LONG qty=1 at t=baseNow
    const entryOrder: PaperOrder = {
      id: 'ord-entry-btc',
      experimentId: exp.id,
      account: 'A',
      decisionId: 'dec-1',
      symbol: 'BTCUSDT',
      side: 'LONG',
      action: 'ENTRY',
      reason: 'NEW_ENTRY',
      qty: 1,
      refPrice: 100,
      createdAt: baseNow,
      status: 'PENDING',
      cancelReason: null,
      positionId: null,
    };
    await store.withTx((tx) => store.insertOrderIfAbsent(entryOrder, tx));

    // Trade at +249ms -> NOT eligible
    clock.advanceTo(baseNow + 249);
    await executor.processTradeNow({ symbol: 'BTCUSDT', price: 100, qty: 1, aggId: 101, tradeTime: baseNow + 240, receivedAt: baseNow + 249 });
    assert.equal((await store.listPositions(exp.id, 'A', 'OPEN')).length, 0);

    // Trade with receivedAt >= +250ms but tradeTime < +250ms -> still NOT eligible
    clock.advanceTo(baseNow + 250);
    await executor.processTradeNow({ symbol: 'BTCUSDT', price: 100, qty: 1, aggId: 1015, tradeTime: baseNow + 245, receivedAt: baseNow + 250 });
    assert.equal((await store.listPositions(exp.id, 'A', 'OPEN')).length, 0);

    // Trade with both receivedAt >= +250ms and tradeTime >= +250ms -> fills at 100 * 1.0005 = 100.05
    clock.advanceTo(baseNow + 250);
    await executor.processTradeNow({ symbol: 'BTCUSDT', price: 100, qty: 1, aggId: 102, tradeTime: baseNow + 250, receivedAt: baseNow + 250 });

    // Duplicate aggId 102 -> ignored completely
    await executor.processTradeNow({ symbol: 'BTCUSDT', price: 90, qty: 1, aggId: 102, tradeTime: baseNow + 250, receivedAt: baseNow + 250 });

    let openPos = await store.listPositions(exp.id, 'A', 'OPEN');
    assert.equal(openPos.length, 1);
    assert.ok(Math.abs(openPos[0].entryPrice - 100.05) < 1e-6);

    // Trigger stop-loss with gap-through below 98.049 (2% below 100.05) -> price drops to 96.0
    const slTriggerAt = baseNow + 1000;
    clock.advanceTo(slTriggerAt);
    await executor.processTradeNow({ symbol: 'BTCUSDT', price: 96, qty: 1, aggId: 103, tradeTime: slTriggerAt - 5, receivedAt: slTriggerAt });

    const pendingAfterTrigger = await store.listPendingOrders(exp.id, 'A');
    assert.equal(pendingAfterTrigger.length, 1);
    assert.equal(pendingAfterTrigger[0].reason, 'STOP_LOSS');
    assert.equal((await store.getAccount(exp.id, 'A'))!.stoppedThisHour.includes('BTCUSDT'), true);

    // Next trade at +249ms still won't fill SL exit; even +65s later an EXIT order does NOT timeout!
    clock.advanceTo(slTriggerAt + 249);
    await executor.processTradeNow({ symbol: 'BTCUSDT', price: 95, qty: 1, aggId: 104, tradeTime: slTriggerAt + 240, receivedAt: slTriggerAt + 249 });
    assert.equal((await store.listPositions(exp.id, 'A', 'OPEN')).length, 1);

    clock.advanceTo(slTriggerAt + 65_000);
    tradeBus.emitStatus({ status: 'connected', lastValidAt: slTriggerAt + 65_000, totalMessages: 10, activeSockets: 1 });
    // Before checking exit no-timeout, also add a pending ENTRY on ETHUSDT to verify ENTRY times out after 60s
    await store.withTx((tx) => store.insertOrderIfAbsent({
      id: 'ord-entry-timeout',
      experimentId: exp.id,
      account: 'B',
      decisionId: 'dec-1',
      symbol: 'ETHUSDT',
      side: 'LONG',
      action: 'ENTRY',
      reason: 'NEW_ENTRY',
      qty: 1,
      refPrice: 50,
      createdAt: slTriggerAt,
      status: 'PENDING',
      cancelReason: null,
      positionId: null,
    }, tx));
    await executor.runMonitorTick(slTriggerAt + 65_000);

    // Check Account B pending ENTRY timed out -> EXECUTION_FAILED, whereas Account A SL EXIT stays PENDING!
    const allOrders = await store.listOrders(exp.id);
    assert.equal(allOrders.find(o => o.id === 'ord-entry-timeout')?.status, 'CANCELLED');
    assert.equal(allOrders.find(o => o.id === 'ord-entry-timeout')?.cancelReason, 'EXECUTION_FAILED');
    assert.equal((await store.listPendingOrders(exp.id, 'A')).length, 1);

    // Next BTC trade fills SL EXIT at market gap price 94 * (1 - 0.0005) = 93.953, NOT at 98.049 stopPrice line!
    clock.advanceTo(slTriggerAt + 65_500);
    await executor.processTradeNow({ symbol: 'BTCUSDT', price: 94, qty: 1, aggId: 105, tradeTime: slTriggerAt + 65_490, receivedAt: slTriggerAt + 65_500 });
    openPos = await store.listPositions(exp.id, 'A', 'OPEN');
    assert.equal(openPos.length, 0);
    const fillsA = await store.listFills(exp.id, 'A');
    const exitFill = fillsA.find(f => f.action === 'EXIT')!;
    assert.ok(Math.abs(exitFill.fillPrice - 94 * 0.9995) < 1e-6);

    // Now test 5s stale -> degraded=true & gap opened -> recovery -> AWAITING_RESUME
    const t2 = slTriggerAt + 70_000;
    clock.advanceTo(t2);
    await store.withTx((tx) => store.insertOrderIfAbsent({
      id: 'ord-entry-eth-a',
      experimentId: exp.id,
      account: 'A',
      decisionId: 'dec-2',
      symbol: 'ETHUSDT',
      side: 'LONG',
      action: 'ENTRY',
      reason: 'NEW_ENTRY',
      qty: 1,
      refPrice: 50,
      createdAt: t2,
      status: 'PENDING',
      cancelReason: null,
      positionId: null,
    }, tx));
    clock.advanceTo(t2 + 300);
    tradeBus.emitTrade({ symbol: 'ETHUSDT', price: 50, qty: 1, aggId: 201, tradeTime: t2 + 290, receivedAt: t2 + 300 });
    await executor.processTradeNow({ symbol: 'ETHUSDT', price: 50, qty: 1, aggId: 201, tradeTime: t2 + 290, receivedAt: t2 + 300 });

    // Advance 6 seconds with no new ETHUSDT trade -> degraded + gap opened
    clock.advanceTo(t2 + 6_500);
    await executor.runMonitorTick(t2 + 6_500);
    assert.equal((await store.getAccount(exp.id, 'A'))!.degraded, true);
    let gaps = await store.listGaps(exp.id);
    assert.equal(gaps.some(g => g.account === 'A' && g.kind === 'STALE_MARKET' && g.endedAt === null), true);

    // Fresh ETH trade arrives -> monitor tick clears degraded, closes gap, triggers AWAITING_RESUME
    clock.advanceTo(t2 + 7_000);
    tradeBus.emitTrade({ symbol: 'ETHUSDT', price: 50.5, qty: 1, aggId: 202, tradeTime: t2 + 6_990, receivedAt: t2 + 7_000 });
    await executor.runMonitorTick(t2 + 7_000);

    assert.equal((await store.getAccount(exp.id, 'A'))!.degraded, false);
    gaps = await store.listGaps(exp.id);
    assert.equal(gaps.every(g => g.endedAt !== null), true);
    assert.equal((await store.getExperiment(exp.id))?.status, 'AWAITING_RESUME');
    assert.deepEqual(awaitingResumeCalls, [exp.id]);
  } finally {
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('FundingSettler: strict tradeTime window, during_gap flag, funding_pending recovery, and idempotent settlement', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fadachi-mp-fund-'));
  const client = await createDuckDBClient(path.join(tmpDir, 'test.duckdb'));
  try {
    await initDatabase(client, SCHEMA_PATH);
    const store = new ModelPaperStore(client);

    // Align to 07:50 UTC before an 08:00 UTC boundary
    const boundary08 = Math.floor(1_700_006_400_000 / EIGHT_HOURS_MS) * EIGHT_HOURS_MS + EIGHT_HOURS_MS;
    const entryTradeTime = boundary08 - 10 * 60_000;
    const clock = new FakeClock(boundary08 + 5 * 60_000);
    const exp = makeExp('exp-fund', entryTradeTime);

    const posA: PaperPosition = {
      id: 'pos-a-btc',
      experimentId: exp.id,
      account: 'A',
      symbol: 'BTCUSDT',
      side: 'LONG',
      qty: 2,
      entryPrice: 100,
      stopPrice: 98,
      openedAt: entryTradeTime,
      openedDecisionHour: Math.floor(entryTradeTime / ONE_HOUR_MS) * ONE_HOUR_MS,
      closedAt: null,
      exitPrice: null,
      exitReason: null,
      status: 'OPEN',
    };

    await store.withTx(async (tx) => {
      await store.insertExperiment(exp, tx);
      await store.insertAccounts([makeAccount(exp.id, 'A', 9800, entryTradeTime), makeAccount(exp.id, 'B', 10000, entryTradeTime)], tx);
      await store.upsertPosition(posA, tx);
      await store.insertOrderIfAbsent({
        id: 'ord-a-1',
        experimentId: exp.id,
        account: 'A',
        decisionId: 'dec-1',
        symbol: 'BTCUSDT',
        side: 'LONG',
        action: 'ENTRY',
        reason: 'NEW_ENTRY',
        qty: 2,
        refPrice: 100,
        createdAt: entryTradeTime,
        status: 'FILLED',
        cancelReason: null,
        positionId: posA.id,
      }, tx);
      await store.insertFillIfAbsent({
        orderId: 'ord-a-1',
        experimentId: exp.id,
        account: 'A',
        symbol: 'BTCUSDT',
        action: 'ENTRY',
        aggId: 1,
        tradeTime: entryTradeTime,
        receivedAt: entryTradeTime + 300,
        rawPrice: 100,
        fillPrice: 100,
        qty: 2,
        fee: 0.08,
        slippageCost: 0,
        realizedPnl: 0,
        positionId: posA.id,
      }, tx);
      await store.insertGap({
        id: 'gap-during-funding',
        experimentId: exp.id,
        account: 'A',
        kind: 'STALE_MARKET',
        startedAt: boundary08 - 60_000,
        endedAt: boundary08 + 60_000,
        detail: 'gap overlapping 8h boundary',
      }, tx);
    });

    let shouldFailFetch = true;
    const settler = new FundingSettler({
      store,
      clock,
      getOwnedExperimentIds: () => [exp.id],
      getLastPrices: () => ({ BTCUSDT: 105 }),
      fetchFundingHistory: async (sym) => {
        if (shouldFailFetch) throw new Error('network down');
        return [
          // Before entry -> ignored
          { symbol: sym, fundingTime: boundary08 - EIGHT_HOURS_MS, fundingRate: 0.001, markPrice: 99 },
          // Inside [entryTradeTime, now] & during gap -> charged once
          { symbol: sym, fundingTime: boundary08, fundingRate: 0.001, markPrice: 100 },
        ];
      },
    });

    // 1. Fetch fails after crossing 8h boundary -> funding_pending = true
    await settler.settleExperiment(exp.id);
    assert.equal((await store.getAccount(exp.id, 'A'))!.fundingPending, true);

    // 2. Fetch succeeds -> settles boundary08 (+0.2 funding cost, cash -= 0.2), sets duringGap=true, clears fundingPending
    shouldFailFetch = false;
    await settler.settleExperiment(exp.id);
    const accAfter1 = (await store.getAccount(exp.id, 'A'))!;
    assert.equal(accAfter1.fundingPending, false);
    assert.ok(Math.abs(accAfter1.funding - 0.2) < 1e-9);
    assert.ok(Math.abs(accAfter1.cash - (9800 - 0.2)) < 1e-9);
    const charges1 = await store.listFunding(exp.id, 'A');
    assert.equal(charges1.length, 1);
    assert.equal(charges1[0].duringGap, true);

    // 3. Re-running settler is idempotent (still 1 charge, same funding)
    await settler.settleExperiment(exp.id);
    assert.equal((await store.listFunding(exp.id, 'A')).length, 1);
    assert.ok(Math.abs((await store.getAccount(exp.id, 'A'))!.funding - 0.2) < 1e-9);
  } finally {
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ForwardScheduler: immediate + HH:00:30 timing, BUSY/DATA_NOT_READY/FAILED retry, +10m SKIPPED, replay guard, and onExitFilled window', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fadachi-mp-sched-'));
  const client = await createDuckDBClient(path.join(tmpDir, 'test.duckdb'));
  let scheduler: ForwardScheduler | undefined;
  try {
    await initDatabase(client, SCHEMA_PATH);
    const store = new ModelPaperStore(client);
    const tradeBus = new TradeBus();

    // Pick 10:00:30 UTC => immediate target H = 09:00:00 UTC, next schedule = 11:00:30 UTC
    const hour10 = 1_700_006_400_000;
    const hour09 = hour10 - ONE_HOUR_MS;
    const clock = new FakeClock(hour10 + 30_000);
    const universe = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT'];
    const rules = makeRules(universe);

    const exp = makeExp('exp-sched', clock.now(), universe);
    await store.withTx(async (tx) => {
      await store.insertExperiment(exp, tx);
      await store.insertAccounts([makeAccount(exp.id, 'A', 10_000, clock.now()), makeAccount(exp.id, 'B', 10_000, clock.now())], tx);
    });

    // Populate fresh live reference prices >= H+1h (= hour10)
    for (const sym of universe) {
      tradeBus.emitTrade({ symbol: sym, price: 100, qty: 1, aggId: 1, tradeTime: hour10 + 10_000, receivedAt: hour10 + 30_000 });
    }

    let mode: 'busy' | 'not_ready' | 'cuda_fail' | 'replay' | 'ok' = 'busy';
    const makeInferOutput = (targetH: number, inputMode: 'live' | 'replay' = 'live'): ForwardInferenceOutput => ({
      snapshotDir: path.join(tmpDir, `snap-${targetH}`),
      inputDoc: {},
      rankResult: {
        inputMode,
        replay: inputMode === 'replay',
        decisionOpenTime: targetH,
        cutoffTime: targetH + ONE_HOUR_MS,
        universeSymbols: universe,
        eligibleCount: 10,
        insufficientSymbols: [],
        longTop5: [
          { rank: 1, symbol: 'BTCUSDT', side: 'LONG', closePrice: 100 },
          { rank: 2, symbol: 'ETHUSDT', side: 'LONG', closePrice: 100 },
        ],
        shortTop5: [{ rank: 1, symbol: 'SOLUSDT', side: 'SHORT', closePrice: 100 }],
        conflictSymbols: [],
        kronosTargetSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
        inputSha256: 'x'.repeat(64),
        inputHashes: {},
        lightgbm: { longSha256: 'l', shortSha256: 's', elapsedMs: 10 },
        generatedAt: clock.now(),
      },
      chronosResult: {
        decisionOpenTime: targetH,
        forecasts: {
          BTCUSDT: { symbol: 'BTCUSDT', lastClose: 100, predictedClose4h: 101, predictedPath: [100.2, 100.5, 100.8, 101] }, // +1%
          ETHUSDT: { symbol: 'ETHUSDT', lastClose: 100, predictedClose4h: 100.1, predictedPath: [100.02, 100.05, 100.08, 100.1] }, // below 0.25% threshold
          SOLUSDT: { symbol: 'SOLUSDT', lastClose: 100, predictedClose4h: 99, predictedPath: [99.8, 99.5, 99.2, 99] }, // -1%
        },
        skipped: [],
        modelInfo: {},
        elapsedMs: 10,
      },
    });

    const mockCoord = {
      runner: { isBusy: () => false },
      runHour: async ({ targetHourH }: { targetHourH: number }) => {
        if (mode === 'busy') throw new ModelResearchBusyError('worker busy');
        if (mode === 'not_ready') throw new DataNotReadyError('not ready', ['BTCUSDT']);
        if (mode === 'cuda_fail') throw new Error('CUDA_UNAVAILABLE');
        if (mode === 'replay') return makeInferOutput(targetHourH, 'replay');
        return makeInferOutput(targetHourH, 'live');
      },
    } as unknown as ForwardInferenceCoordinator;

    scheduler = new ForwardScheduler({
      store,
      tradeBus,
      forwardInference: mockCoord,
      getRules: async () => rules,
      isLeaseOwned: () => true,
      clock,
    });

    // Check nextScheduleAt = 11:00:30
    scheduler.start(exp.id, { runImmediate: false });
    assert.equal(scheduler.getNextScheduleAt(exp.id), hour10 + ONE_HOUR_MS + 30_000);

    // 1. BUSY -> PENDING_RETRY and zero positions
    mode = 'busy';
    await scheduler.triggerHour(exp.id, hour09);
    assert.equal((await store.getDecisionByHour(exp.id, 'chronos2', hour09))?.status, 'PENDING_RETRY');
    assert.equal((await store.listOrders(exp.id)).length, 0);

    // 2. DATA_NOT_READY -> PENDING_RETRY
    mode = 'not_ready';
    clock.advanceTo(hour10 + 60_000);
    await clock.flushDue();
    await scheduler.flush();
    assert.equal((await store.getDecisionByHour(exp.id, 'chronos2', hour09))?.status, 'PENDING_RETRY');

    // 3. CUDA_UNAVAILABLE -> FAILED (still retryable within +10m)
    mode = 'cuda_fail';
    clock.advanceTo(hour10 + 90_000);
    await clock.flushDue();
    await scheduler.flush();
    assert.equal((await store.getDecisionByHour(exp.id, 'chronos2', hour09))?.status, 'FAILED');
    assert.equal((await store.listOrders(exp.id)).length, 0);

    // 4. replay returned -> rejected as FAILED!
    mode = 'replay';
    clock.advanceTo(hour10 + 120_000);
    await clock.flushDue();
    await scheduler.flush();
    assert.equal((await store.getDecisionByHour(exp.id, 'chronos2', hour09))?.status, 'FAILED');
    assert.equal((await store.listOrders(exp.id)).length, 0);

    // 5. Succeeds within +10m -> SUBMITTED, same-hour dedup blocks duplicate run
    mode = 'ok';
    clock.advanceTo(hour10 + 150_000);
    await clock.flushDue();
    await scheduler.flush();
    const dec = await store.getDecisionByHour(exp.id, 'chronos2', hour09);
    assert.equal(dec?.status, 'SUBMITTED');
    const ordersAfterSubmit = await store.listOrders(exp.id);
    assert.ok(ordersAfterSubmit.length > 0);
    const attemptsAfterSubmit = dec!.attempts;

    // Duplicate triggerHour for hour09 -> ignored!
    await scheduler.triggerHour(exp.id, hour09);
    assert.equal((await store.getDecisionByHour(exp.id, 'chronos2', hour09))?.attempts, attemptsAfterSubmit);

    // 6. Test past +10m deadline -> SKIPPED with zero new orders
    const hour10Target = hour10;
    clock.advanceTo(hour10 + ONE_HOUR_MS + 10 * 60_000 + 1); // past H+1h+10m
    mode = 'busy';
    await scheduler.triggerHour(exp.id, hour10Target);
    assert.equal((await store.getDecisionByHour(exp.id, 'chronos2', hour10Target))?.status, 'SKIPPED');

    // 7. onExitFilled past deadline -> does NOT submit replacement orders
    const ordersBeforeLateExit = (await store.listOrders(exp.id)).length;
    await scheduler.onExitFilled({ experimentId: exp.id, account: 'A', now: hour10 + 10 * 60_000 + 5 });
    assert.equal((await store.listOrders(exp.id)).length, ordersBeforeLateExit);

    scheduler.stop();
    await scheduler.flush();
  } finally {
    await scheduler?.flush?.();
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Edge cases: immediate start, in-window onExitFilled replacement, failed-hour hold, bankrupt A vs healthy B, STOPPING->STOPPED, exact-boundary funding exit', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fadachi-mp-edge-'));
  const client = await createDuckDBClient(path.join(tmpDir, 'test.duckdb'));
  let scheduler: ForwardScheduler | undefined;
  try {
    await initDatabase(client, SCHEMA_PATH);
    const store = new ModelPaperStore(client);
    const tradeBus = new TradeBus();
    const hour10 = 1_700_006_400_000;
    const hour09 = hour10 - ONE_HOUR_MS;
    const hour11 = hour10 + ONE_HOUR_MS;
    const clock = new FakeClock(hour10 + 10_000);
    const universe = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT'];
    const rules = makeRules(universe);

    const exp = makeExp('exp-edge', clock.now(), universe);
    await store.withTx(async (tx) => {
      await store.insertExperiment(exp, tx);
      await store.insertAccounts([makeAccount(exp.id, 'A', 10_000, clock.now()), makeAccount(exp.id, 'B', 10_000, clock.now())], tx);
    });

    tradeBus.emitStatus({ status: 'connected', lastValidAt: clock.now(), totalMessages: 1, activeSockets: 1 });
    for (const sym of universe) {
      tradeBus.emitTrade({ symbol: sym, price: 100, qty: 1, aggId: 1, tradeTime: hour10 + 5_000, receivedAt: hour10 + 10_000 });
    }

    let failNext = false;
    let signalMode: 'initial' | 'reverse' = 'initial';
    const mockCoord = {
      runner: { isBusy: () => false },
      runHour: async ({ targetHourH }: { targetHourH: number }): Promise<ForwardInferenceOutput> => {
        if (failNext) throw new Error('CUDA_UNAVAILABLE');
        const longTop5 = signalMode === 'initial'
          ? [{ rank: 1, symbol: 'BTCUSDT', side: 'LONG' as const, closePrice: 100 }]
          : [{ rank: 1, symbol: 'ETHUSDT', side: 'LONG' as const, closePrice: 100 }];
        const shortTop5 = signalMode === 'initial'
          ? [{ rank: 1, symbol: 'SOLUSDT', side: 'SHORT' as const, closePrice: 100 }]
          : [{ rank: 1, symbol: 'BTCUSDT', side: 'SHORT' as const, closePrice: 100 }];
        return {
          snapshotDir: path.join(tmpDir, `snap-${targetHourH}`),
          inputDoc: {},
          rankResult: {
            inputMode: 'live',
            replay: false,
            decisionOpenTime: targetHourH,
            cutoffTime: targetHourH + ONE_HOUR_MS,
            universeSymbols: universe,
            eligibleCount: 10,
            insufficientSymbols: [],
            longTop5,
            shortTop5,
            conflictSymbols: [],
            kronosTargetSymbols: signalMode === 'initial' ? ['BTCUSDT', 'SOLUSDT'] : ['ETHUSDT', 'BTCUSDT'],
            inputSha256: 'x'.repeat(64),
            inputHashes: {},
            lightgbm: { longSha256: 'l', shortSha256: 's', elapsedMs: 5 },
            generatedAt: clock.now(),
          },
          chronosResult: {
            decisionOpenTime: targetHourH,
            forecasts: {
              BTCUSDT: { symbol: 'BTCUSDT', lastClose: 100, predictedClose4h: signalMode === 'initial' ? 102 : 98, predictedPath: [100, 100, 100, signalMode === 'initial' ? 102 : 98] },
              ETHUSDT: { symbol: 'ETHUSDT', lastClose: 100, predictedClose4h: 102, predictedPath: [101, 101, 102, 102] },
              SOLUSDT: { symbol: 'SOLUSDT', lastClose: 100, predictedClose4h: 98, predictedPath: [99, 99, 98, 98] },
            },
            skipped: [],
            modelInfo: {},
            elapsedMs: 5,
          },
        };
      },
    } as unknown as ForwardInferenceCoordinator;

    scheduler = new ForwardScheduler({
      store,
      tradeBus,
      forwardInference: mockCoord,
      getRules: async () => rules,
      isLeaseOwned: () => true,
      clock,
    });
    const executor = new PaperExecutor({
      store,
      tradeBus,
      clock,
      getOwnedExperimentIds: () => [exp.id],
      getRules: () => rules,
      onExitFilled: async ({ experimentId, account, now }) => {
        await scheduler!.onExitFilled({ experimentId, account, now });
      },
    });

    // 1. start with runImmediate: true triggers hour09 immediately
    scheduler.start(exp.id, { runImmediate: true });
    await scheduler.flush();
    assert.equal((await store.getDecisionByHour(exp.id, 'chronos2', hour09))?.status, 'SUBMITTED');
    const initialOrdersA = await store.listPendingOrders(exp.id, 'A');
    assert.equal(initialOrdersA.length, 2); // BTCUSDT LONG + SOLUSDT SHORT

    // Fill initial orders at +300ms
    clock.advanceTo(hour10 + 10_300);
    await executor.processTradeNow({ symbol: 'BTCUSDT', price: 100, qty: 1, aggId: 500, tradeTime: hour10 + 10_300, receivedAt: hour10 + 10_300 });
    await executor.processTradeNow({ symbol: 'SOLUSDT', price: 100, qty: 1, aggId: 501, tradeTime: hour10 + 10_300, receivedAt: hour10 + 10_300 });
    assert.equal((await store.listPositions(exp.id, 'A', 'OPEN')).length, 2);

    // 2. Next hour (hour10) fails -> existing positions remain OPEN with zero exit orders!
    clock.advanceTo(hour11 + 30_000);
    failNext = true;
    for (const sym of universe) {
      tradeBus.emitTrade({ symbol: sym, price: 100, qty: 1, aggId: 502, tradeTime: hour11 + 29_000, receivedAt: hour11 + 30_000 });
    }
    await scheduler.triggerHour(exp.id, hour10);
    assert.equal((await store.getDecisionByHour(exp.id, 'chronos2', hour10))?.status, 'FAILED');
    assert.equal((await store.listPositions(exp.id, 'A', 'OPEN')).length, 2);
    assert.equal((await store.listPendingOrders(exp.id, 'A')).length, 0);

    // 3. Recovery in same hour10 with reversed BTCUSDT signal -> generates REVERSED EXIT first, then onExitFilled opens BTCUSDT SHORT + ETHUSDT LONG
    failNext = false;
    signalMode = 'reverse';
    clock.advanceTo(hour11 + 60_000);
    for (const sym of universe) {
      tradeBus.emitTrade({ symbol: sym, price: 100, qty: 1, aggId: 503, tradeTime: hour11 + 59_000, receivedAt: hour11 + 60_000 });
    }
    await scheduler.triggerHour(exp.id, hour10);
    assert.equal((await store.getDecisionByHour(exp.id, 'chronos2', hour10))?.status, 'SUBMITTED');
    const pendingAfterRev = await store.listPendingOrders(exp.id, 'A');
    assert.equal(pendingAfterRev.some(o => o.symbol === 'BTCUSDT' && o.action === 'EXIT' && o.reason === 'REVERSED'), true);

    // Fill BTCUSDT EXIT at +300ms within +10m window -> onExitFilled immediately creates BTCUSDT SHORT ENTRY order!
    clock.advanceTo(hour11 + 60_300);
    await executor.processTradeNow({ symbol: 'BTCUSDT', price: 100, qty: 1, aggId: 504, tradeTime: hour11 + 60_300, receivedAt: hour11 + 60_300 });
    const pendingAfterExitFill = await store.listPendingOrders(exp.id, 'A');
    assert.equal(pendingAfterExitFill.some(o => o.symbol === 'BTCUSDT' && o.action === 'ENTRY' && o.side === 'SHORT'), true);

    // 4. Exact-boundary funding exit: position exited at tradeTime == boundary -> fundingPending stays false
    const boundary8h = Math.floor((hour11 + 60_300) / EIGHT_HOURS_MS) * EIGHT_HOURS_MS + EIGHT_HOURS_MS;
    await store.withTx(async (tx) => {
      const openSol = (await store.listPositions(exp.id, 'A', 'OPEN', tx)).find(p => p.symbol === 'SOLUSDT')!;
      await store.insertOrderIfAbsent({
        id: 'ord-exact-boundary-exit',
        experimentId: exp.id,
        account: 'A',
        decisionId: 'dec-boundary',
        symbol: 'SOLUSDT',
        side: 'SHORT',
        action: 'EXIT',
        reason: 'SIGNAL_GONE',
        qty: openSol.qty,
        refPrice: 100,
        createdAt: boundary8h - 1000,
        status: 'PENDING',
        cancelReason: null,
        positionId: openSol.id,
      }, tx);
    });
    clock.advanceTo(boundary8h);
    await executor.processTradeNow({ symbol: 'SOLUSDT', price: 100, qty: 1, aggId: 505, tradeTime: boundary8h, receivedAt: boundary8h });
    const settler = new FundingSettler({
      store,
      clock,
      getOwnedExperimentIds: () => [exp.id],
      getLastPrices: () => ({ BTCUSDT: 100, ETHUSDT: 100, SOLUSDT: 100 }),
      fetchFundingHistory: async () => [],
    });
    await settler.settleExperiment(exp.id);
    assert.equal((await store.getAccount(exp.id, 'A'))!.fundingPending, false);

    // 5. STOPPING -> STOPPED when all exit orders fill (after cancelling pending entries)
    await store.withTx(async (tx) => {
      await store.cancelPendingEntries(exp.id, null, 'STOPPED', tx);
      const allOpen = await store.listPositions(exp.id, undefined, 'OPEN', tx);
      for (const pos of allOpen) {
        await store.insertOrderIfAbsent({
          id: `manual-stop:${pos.id}`,
          experimentId: exp.id,
          account: pos.account,
          decisionId: `manual-stop:${exp.id}`,
          symbol: pos.symbol,
          side: pos.side,
          action: 'EXIT',
          reason: 'MANUAL_STOP',
          qty: pos.qty,
          refPrice: 100,
          createdAt: boundary8h,
          status: 'PENDING',
          cancelReason: null,
          positionId: pos.id,
        }, tx);
      }
      await store.updateExperimentStatus(exp.id, 'STOPPING', { heartbeatAt: boundary8h }, tx);
    });
    clock.advanceTo(boundary8h + 500);
    await executor.processTradeNow({ symbol: 'BTCUSDT', price: 100, qty: 1, aggId: 506, tradeTime: boundary8h + 500, receivedAt: boundary8h + 500 });
    await executor.processTradeNow({ symbol: 'ETHUSDT', price: 100, qty: 1, aggId: 507, tradeTime: boundary8h + 500, receivedAt: boundary8h + 500 });
    await executor.processTradeNow({ symbol: 'SOLUSDT', price: 100, qty: 1, aggId: 508, tradeTime: boundary8h + 500, receivedAt: boundary8h + 500 });
    assert.equal((await store.getExperiment(exp.id))?.status, 'STOPPED');

    scheduler.stop();
    await scheduler.flush();
  } finally {
    await scheduler?.flush?.();
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Review fixes: PaperExecutor DB BANKRUPT isolation, STOPPING->STOPPED final funding settlement, onExitFilled skips EXECUTION_FAILED rank-1 for rank-2, and restart grace', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fadachi-mp-fixes-'));
  const client = await createDuckDBClient(path.join(tmpDir, 'test.duckdb'));
  let scheduler: ForwardScheduler | undefined;
  let executor: PaperExecutor | undefined;
  try {
    await initDatabase(client, SCHEMA_PATH);
    const store = new ModelPaperStore(client);
    const tradeBus = new TradeBus();
    const hour10 = 1_700_006_400_000;
    const hour09 = hour10 - ONE_HOUR_MS;
    const clock = new FakeClock(hour10 + 10_000);
    const universe = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT'];
    const rules = makeRules(universe);

    // Part 1: onExitFilled skips EXECUTION_FAILED rank-1 and fills rank-2!
    const exp1 = makeExp('exp-fix-slot', clock.now(), universe);
    await store.withTx(async (tx) => {
      await store.insertExperiment(exp1, tx);
      await store.insertAccounts([makeAccount(exp1.id, 'A', 10_000, clock.now()), makeAccount(exp1.id, 'B', 10_000, clock.now())], tx);
      const decId = `${exp1.id}:chronos2:${hour09}`;
      await store.claimDecision({ id: decId, experimentId: exp1.id, modelKey: 'chronos2', decisionHour: hour09, now: clock.now() }, tx);
      await store.updateDecision({
        id: decId,
        status: 'SUBMITTED',
        submittedAt: clock.now(),
        signals: {
          signalsA: [
            { symbol: 'BTCUSDT', side: 'LONG', sideRank: 1, refPrice: 100, closePrice1h: 100 },
            { symbol: 'ETHUSDT', side: 'LONG', sideRank: 2, refPrice: 100, closePrice1h: 100 },
          ],
          signalsB: [],
          skippedA: [],
          skippedB: [],
        },
      }, tx);
      // Rank-1 BTCUSDT ENTRY already timed out (CANCELLED / EXECUTION_FAILED)
      await store.insertOrderIfAbsent({
        id: `${decId}:A:BTCUSDT:ENTRY`,
        experimentId: exp1.id,
        account: 'A',
        decisionId: decId,
        symbol: 'BTCUSDT',
        side: 'LONG',
        action: 'ENTRY',
        reason: 'SIGNAL',
        qty: 20,
        refPrice: 100,
        createdAt: clock.now(),
        status: 'PENDING',
        cancelReason: null,
        positionId: null,
      }, tx);
      await store.cancelOrder(`${decId}:A:BTCUSDT:ENTRY`, 'EXECUTION_FAILED', tx);
    });

    const mockCoord = {
      runner: { isBusy: () => false },
      runHour: async () => { throw new Error('unused'); },
    } as unknown as ForwardInferenceCoordinator;

    scheduler = new ForwardScheduler({
      store,
      tradeBus,
      forwardInference: mockCoord,
      getRules: async () => rules,
      isLeaseOwned: () => true,
      clock,
    });
    await scheduler.onExitFilled({ experimentId: exp1.id, account: 'A', now: hour10 + 15_000 });
    const pendingAfterFill = await store.listPendingOrders(exp1.id, 'A');
    assert.equal(pendingAfterFill.length, 1);
    assert.equal(pendingAfterFill[0].symbol, 'ETHUSDT'); // Rank-2 got the slot instead of wasting on cancelled BTCUSDT!

    // Part 2: DB-level BANKRUPT on Account A via PaperExecutor.processTradeNow + STOPPING -> STOPPED final funding settlement!
    const boundary08 = Math.floor(hour10 / EIGHT_HOURS_MS) * EIGHT_HOURS_MS + EIGHT_HOURS_MS;
    const exp2Start = boundary08 - 10 * 60_000;
    clock.advanceTo(exp2Start);
    const exp2 = makeExp('exp-fix-bankrupt-fund', exp2Start, universe);
    await store.withTx(async (tx) => {
      await store.insertExperiment(exp2, tx);
      // Account A starts with small cash=100 and opens a SHORT position qty=1 at 100, plus a pending ENTRY order on ETHUSDT
      await store.insertAccounts([makeAccount(exp2.id, 'A', 100, exp2Start), makeAccount(exp2.id, 'B', 10_000, exp2Start)], tx);
      await store.insertOrderIfAbsent({
        id: 'ord-a-short-entry',
        experimentId: exp2.id,
        account: 'A',
        decisionId: 'dec-b',
        symbol: 'SOLUSDT',
        side: 'SHORT',
        action: 'ENTRY',
        reason: 'SIGNAL',
        qty: 1,
        refPrice: 100,
        createdAt: exp2Start,
        status: 'PENDING',
        cancelReason: null,
        positionId: null,
      }, tx);
      await store.insertOrderIfAbsent({
        id: 'ord-b-long-entry',
        experimentId: exp2.id,
        account: 'B',
        decisionId: 'dec-b',
        symbol: 'BTCUSDT',
        side: 'LONG',
        action: 'ENTRY',
        reason: 'SIGNAL',
        qty: 1,
        refPrice: 100,
        createdAt: exp2Start,
        status: 'PENDING',
        cancelReason: null,
        positionId: null,
      }, tx);
    });

    const settler = new FundingSettler({
      store,
      clock,
      getOwnedExperimentIds: () => [exp2.id],
      getLastPrices: () => ({ SOLUSDT: 200, BTCUSDT: 100 }),
      fetchFundingHistory: async (sym) => [
        { symbol: sym, fundingTime: boundary08, fundingRate: 0.001, markPrice: 100 },
      ],
    });

    executor = new PaperExecutor({
      store,
      tradeBus,
      clock,
      getOwnedExperimentIds: () => [exp2.id],
      getRules: () => rules,
      onPositionClosed: async (expId, sym) => {
        await settler.settleExperiment(expId, [sym]);
      },
    });

    // Fill Account A SHORT SOLUSDT at 100 & Account B LONG BTCUSDT at 100
    clock.advanceTo(exp2Start + 300);
    await executor.processTradeNow({ symbol: 'SOLUSDT', price: 100, qty: 1, aggId: 9001, tradeTime: exp2Start + 300, receivedAt: exp2Start + 300 });
    await executor.processTradeNow({ symbol: 'BTCUSDT', price: 100, qty: 1, aggId: 9002, tradeTime: exp2Start + 300, receivedAt: exp2Start + 300 });

    // Insert a pending ENTRY on Account A for ETHUSDT, then gap SOLUSDT up to 250 -> exit triggers & fills -> Account A equity <= 0!
    await store.withTx((tx) => store.insertOrderIfAbsent({
      id: 'ord-a-pending-eth',
      experimentId: exp2.id,
      account: 'A',
      decisionId: 'dec-b2',
      symbol: 'ETHUSDT',
      side: 'LONG',
      action: 'ENTRY',
      reason: 'SIGNAL',
      qty: 1,
      refPrice: 50,
      createdAt: exp2Start + 400,
      status: 'PENDING',
      cancelReason: null,
      positionId: null,
    }, tx));

    // Trigger stop-loss on A's SOLUSDT SHORT at 250
    clock.advanceTo(exp2Start + 1000);
    await executor.processTradeNow({ symbol: 'SOLUSDT', price: 250, qty: 1, aggId: 9003, tradeTime: exp2Start + 1000, receivedAt: exp2Start + 1000 });
    // Fill SL exit at 250 -> A's realized loss (-150) > initial cash (100) -> equity < 0 -> A bankrupt, pending ETH entry cancelled, B unaffected, exp2 stays RUNNING!
    clock.advanceTo(exp2Start + 1300);
    await executor.processTradeNow({ symbol: 'SOLUSDT', price: 250, qty: 1, aggId: 9004, tradeTime: exp2Start + 1300, receivedAt: exp2Start + 1300 });

    const accA = (await store.getAccount(exp2.id, 'A'))!;
    const accB = (await store.getAccount(exp2.id, 'B'))!;
    assert.equal(accA.bankrupt, true);
    assert.equal(accB.bankrupt, false);
    assert.equal((await store.getExperiment(exp2.id))?.status, 'RUNNING');
    assert.equal((await store.listOrders(exp2.id, 'A')).find(o => o.id === 'ord-a-pending-eth')?.cancelReason, 'BANKRUPT');

    // Now cross 08:00 UTC boundary with B holding BTCUSDT, transition exp2 to STOPPING, fill MANUAL_STOP exit -> exp2 becomes STOPPED AND FundingSettler still settles B's 08:00 funding!
    clock.advanceTo(boundary08 + 60_000);
    const posB = (await store.listPositions(exp2.id, 'B', 'OPEN'))[0];
    await store.withTx(async (tx) => {
      await store.insertOrderIfAbsent({
        id: `manual-stop:${posB.id}`,
        experimentId: exp2.id,
        account: 'B',
        decisionId: `manual-stop:${exp2.id}`,
        symbol: 'BTCUSDT',
        side: 'LONG',
        action: 'EXIT',
        reason: 'MANUAL_STOP',
        qty: posB.qty,
        refPrice: 100,
        createdAt: boundary08 + 60_000,
        status: 'PENDING',
        cancelReason: null,
        positionId: posB.id,
      }, tx);
      await store.updateExperimentStatus(exp2.id, 'STOPPING', { heartbeatAt: boundary08 + 60_000 }, tx);
    });

    clock.advanceTo(boundary08 + 60_500);
    await executor.processTradeNow({ symbol: 'BTCUSDT', price: 100, qty: 1, aggId: 9005, tradeTime: boundary08 + 60_500, receivedAt: boundary08 + 60_500 });
    assert.equal((await store.getExperiment(exp2.id))?.status, 'STOPPED');
    const fundingB = await store.listFunding(exp2.id, 'B');
    assert.equal(fundingB.length, 1);
    assert.ok(Math.abs(fundingB[0].amount - 0.1) < 1e-9);
    assert.equal((await store.getAccount(exp2.id, 'B'))!.fundingPending, false);

    // Part 3: executor.start() grace prevents spurious STALE_MARKET on tick 1 after restart
    const exp3 = makeExp('exp-fix-grace', boundary08 - 2 * ONE_HOUR_MS, universe);
    await store.withTx(async (tx) => {
      await store.insertExperiment(exp3, tx);
      await store.insertAccounts([makeAccount(exp3.id, 'A', 9900, boundary08 - ONE_HOUR_MS), makeAccount(exp3.id, 'B', 10000, boundary08 - ONE_HOUR_MS)], tx);
      await store.upsertPosition({
        id: 'pos-old-opened',
        experimentId: exp3.id,
        account: 'A',
        symbol: 'BTCUSDT',
        side: 'LONG',
        qty: 1,
        entryPrice: 100,
        stopPrice: 98,
        openedAt: boundary08 - 2 * ONE_HOUR_MS,
        openedDecisionHour: boundary08 - 2 * ONE_HOUR_MS,
        status: 'OPEN',
      }, tx);
    });
    const graceBus = new TradeBus();
    graceBus.emitStatus({ status: 'connected', lastValidAt: boundary08 + 60_500, totalMessages: 1, activeSockets: 1 });
    const graceExec = new PaperExecutor({
      store,
      tradeBus: graceBus,
      clock,
      getOwnedExperimentIds: () => [exp3.id],
      getRules: () => rules,
    });
    graceExec.start();
    // 1 second after start() -> still within 5s grace, NOT degraded
    clock.advanceTo(boundary08 + 61_500);
    await graceExec.runMonitorTick(boundary08 + 61_500);
    assert.equal((await store.getAccount(exp3.id, 'A'))!.degraded, false);
    // 6 seconds after start() with no trade -> becomes degraded
    clock.advanceTo(boundary08 + 66_600);
    await graceExec.runMonitorTick(boundary08 + 66_600);
    assert.equal((await store.getAccount(exp3.id, 'A'))!.degraded, true);
    graceExec.stop();
    await graceExec.flush();

    scheduler.stop();
    await scheduler.flush();
    await executor.flush();
    await settler.flush();
  } finally {
    executor?.stop();
    await executor?.flush();
    await scheduler?.flush?.();
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('PaperExecutor: startup stream connection grace (staleMs) vs post-connect disconnect and pre-existing degraded preservation', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fadachi-mp-stream-grace-'));
  const client = await createDuckDBClient(path.join(tmpDir, 'test.duckdb'));
  try {
    await initDatabase(client, SCHEMA_PATH);
    const store = new ModelPaperStore(client);
    const rules = makeRules(['BTCUSDT']);
    const baseNow = 1_700_010_000_000;

    // 1. Stream starts 'connecting' -> stays healthy within staleMs (<= 5s), connects at +4s -> zero STREAM_DISCONNECTED gaps
    const expOk = makeExp('exp-grace-ok', baseNow);
    await store.withTx(async (tx) => {
      await store.insertExperiment(expOk, tx);
      await store.insertAccounts([makeAccount(expOk.id, 'A', 10_000, baseNow), makeAccount(expOk.id, 'B', 10_000, baseNow)], tx);
    });

    const clock1 = new FakeClock(baseNow);
    const bus1 = new TradeBus();
    bus1.emitStatus({ status: 'connecting', lastValidAt: 0, totalMessages: 0, activeSockets: 1 });
    const exec1 = new PaperExecutor({
      store,
      tradeBus: bus1,
      clock: clock1,
      getOwnedExperimentIds: () => [expOk.id],
      getRules: () => rules,
    });
    exec1.start();

    clock1.advanceTo(baseNow + 1_000);
    await exec1.runMonitorTick(baseNow + 1_000);
    clock1.advanceTo(baseNow + 5_000);
    await exec1.runMonitorTick(baseNow + 5_000);
    assert.equal((await store.getAccount(expOk.id, 'A'))!.degraded, false);
    assert.equal((await store.listGaps(expOk.id)).length, 0);

    bus1.emitStatus({ status: 'connected', lastValidAt: baseNow + 4_500, totalMessages: 1, activeSockets: 1 });
    clock1.advanceTo(baseNow + 6_000);
    await exec1.runMonitorTick(baseNow + 6_000);
    assert.equal((await store.getAccount(expOk.id, 'A'))!.degraded, false);
    assert.equal((await store.listGaps(expOk.id)).length, 0);
    exec1.stop();
    await exec1.flush();

    // 2. Stream never connects past staleMs (> 5s) -> opens STREAM_DISCONNECTED, then closes on connect & triggers AWAITING_RESUME
    const expTimeout = makeExp('exp-grace-timeout', baseNow);
    await store.withTx(async (tx) => {
      await store.insertExperiment(expTimeout, tx);
      await store.insertAccounts([makeAccount(expTimeout.id, 'A', 10_000, baseNow), makeAccount(expTimeout.id, 'B', 10_000, baseNow)], tx);
    });

    const clock2 = new FakeClock(baseNow);
    const bus2 = new TradeBus();
    bus2.emitStatus({ status: 'connecting', lastValidAt: 0, totalMessages: 0, activeSockets: 1 });
    const awaitingCalls: string[] = [];
    const exec2 = new PaperExecutor({
      store,
      tradeBus: bus2,
      clock: clock2,
      getOwnedExperimentIds: () => [expTimeout.id],
      getRules: () => rules,
      onAwaitingResume: (id) => awaitingCalls.push(id),
    });
    exec2.start();

    clock2.advanceTo(baseNow + 5_000);
    await exec2.runMonitorTick(baseNow + 5_000);
    assert.equal((await store.getAccount(expTimeout.id, 'A'))!.degraded, false);

    clock2.advanceTo(baseNow + 5_001);
    await exec2.runMonitorTick(baseNow + 5_001);
    assert.equal((await store.getAccount(expTimeout.id, 'A'))!.degraded, true);
    let timeoutGaps = await store.listGaps(expTimeout.id);
    assert.equal(timeoutGaps.filter(g => g.kind === 'STREAM_DISCONNECTED' && g.endedAt === null).length, 2);

    bus2.emitStatus({ status: 'connected', lastValidAt: baseNow + 7_000, totalMessages: 1, activeSockets: 1 });
    clock2.advanceTo(baseNow + 7_000);
    await exec2.runMonitorTick(baseNow + 7_000);
    assert.equal((await store.getAccount(expTimeout.id, 'A'))!.degraded, false);
    timeoutGaps = await store.listGaps(expTimeout.id);
    assert.equal(timeoutGaps.every(g => g.endedAt === baseNow + 7_000), true);
    assert.equal((await store.getExperiment(expTimeout.id))?.status, 'AWAITING_RESUME');
    assert.deepEqual(awaitingCalls, [expTimeout.id]);
    exec2.stop();
    await exec2.flush();

    // 3. Post-connect disconnect EVEN WITHIN staleMs of start() -> immediately flagged (not masked by grace!)
    const expDrop = makeExp('exp-post-connect-drop', baseNow);
    await store.withTx(async (tx) => {
      await store.insertExperiment(expDrop, tx);
      await store.insertAccounts([makeAccount(expDrop.id, 'A', 10_000, baseNow), makeAccount(expDrop.id, 'B', 10_000, baseNow)], tx);
    });

    const clock3 = new FakeClock(baseNow);
    const bus3 = new TradeBus();
    bus3.emitStatus({ status: 'connecting', lastValidAt: 0, totalMessages: 0, activeSockets: 1 });
    const exec3 = new PaperExecutor({
      store,
      tradeBus: bus3,
      clock: clock3,
      getOwnedExperimentIds: () => [expDrop.id],
      getRules: () => rules,
    });
    exec3.start();

    clock3.advanceTo(baseNow + 1_000);
    await exec3.runMonitorTick(baseNow + 1_000);
    assert.equal((await store.listGaps(expDrop.id)).length, 0);

    // Connects at +1.5s then drops at +2.0s (still < +5s!)
    bus3.emitStatus({ status: 'connected', lastValidAt: baseNow + 1_500, totalMessages: 1, activeSockets: 1 });
    bus3.emitStatus({ status: 'disconnected', lastValidAt: baseNow + 1_500, totalMessages: 1, activeSockets: 0 });
    clock3.advanceTo(baseNow + 3_000);
    await exec3.runMonitorTick(baseNow + 3_000);
    assert.equal((await store.getAccount(expDrop.id, 'A'))!.degraded, true);
    const dropGaps = await store.listGaps(expDrop.id);
    assert.equal(dropGaps.filter(g => g.kind === 'STREAM_DISCONNECTED' && g.endedAt === null).length, 2);
    exec3.stop();
    await exec3.flush();

    // 4. Pre-existing degraded=true + open gap across restart is NOT cleared during startup grace before stream connects
    const expPreDegraded: ModelPaperExperimentRecord = {
      ...makeExp('exp-pre-degraded', baseNow - 60_000),
      status: 'AWAITING_RESUME',
    };
    await store.withTx(async (tx) => {
      await store.insertExperiment(expPreDegraded, tx);
      await store.insertAccounts([
        { ...makeAccount(expPreDegraded.id, 'A', 10_000, baseNow - 10_000), degraded: true },
        { ...makeAccount(expPreDegraded.id, 'B', 10_000, baseNow - 10_000), degraded: true },
      ], tx);
      await store.insertGap({
        id: 'pre-gap-a',
        experimentId: expPreDegraded.id,
        account: 'A',
        kind: 'STREAM_DISCONNECTED',
        startedAt: baseNow - 10_000,
        endedAt: null,
        detail: 'prior disconnect',
      }, tx);
      await store.insertGap({
        id: 'pre-gap-b',
        experimentId: expPreDegraded.id,
        account: 'B',
        kind: 'STREAM_DISCONNECTED',
        startedAt: baseNow - 10_000,
        endedAt: null,
        detail: 'prior disconnect',
      }, tx);
    });

    const clock4 = new FakeClock(baseNow);
    const bus4 = new TradeBus();
    bus4.emitStatus({ status: 'connecting', lastValidAt: 0, totalMessages: 0, activeSockets: 1 });
    const exec4 = new PaperExecutor({
      store,
      tradeBus: bus4,
      clock: clock4,
      getOwnedExperimentIds: () => [expPreDegraded.id],
      getRules: () => rules,
    });
    exec4.start();

    clock4.advanceTo(baseNow + 1_000);
    await exec4.runMonitorTick(baseNow + 1_000);
    assert.equal((await store.getAccount(expPreDegraded.id, 'A'))!.degraded, true);
    assert.equal((await store.listGaps(expPreDegraded.id)).every(g => g.endedAt === null), true);

    bus4.emitStatus({ status: 'connected', lastValidAt: baseNow + 2_500, totalMessages: 1, activeSockets: 1 });
    clock4.advanceTo(baseNow + 2_500);
    await exec4.runMonitorTick(baseNow + 2_500);
    assert.equal((await store.getAccount(expPreDegraded.id, 'A'))!.degraded, false);
    assert.equal((await store.listGaps(expPreDegraded.id)).every(g => g.endedAt === baseNow + 2_500), true);
    exec4.stop();
    await exec4.flush();

    // 5. Unstarted executor (start() never called) does NOT skip STREAM_DISCONNECTED
    const expUnstarted = makeExp('exp-unstarted', baseNow);
    await store.withTx(async (tx) => {
      await store.insertExperiment(expUnstarted, tx);
      await store.insertAccounts([makeAccount(expUnstarted.id, 'A', 10_000, baseNow), makeAccount(expUnstarted.id, 'B', 10_000, baseNow)], tx);
    });
    const bus5 = new TradeBus();
    const exec5 = new PaperExecutor({
      store,
      tradeBus: bus5,
      clock: new FakeClock(baseNow),
      getOwnedExperimentIds: () => [expUnstarted.id],
      getRules: () => rules,
    });
    await exec5.runMonitorTick(baseNow + 1_000);
    assert.equal((await store.getAccount(expUnstarted.id, 'A'))!.degraded, true);
    assert.equal((await store.listGaps(expUnstarted.id)).filter(g => g.kind === 'STREAM_DISCONNECTED').length, 2);

    // 6. Stream connects & drops BEFORE executor.start() -> hasConnectedStream seeded via TradeBus history, so +1s flags STREAM_DISCONNECTED immediately
    const expPreDrop = makeExp('exp-pre-start-drop', baseNow);
    await store.withTx(async (tx) => {
      await store.insertExperiment(expPreDrop, tx);
      await store.insertAccounts([makeAccount(expPreDrop.id, 'A', 10_000, baseNow), makeAccount(expPreDrop.id, 'B', 10_000, baseNow)], tx);
    });
    const clock6 = new FakeClock(baseNow);
    const bus6 = new TradeBus();
    bus6.emitStatus({ status: 'connected', lastValidAt: baseNow - 500, totalMessages: 1, activeSockets: 1 });
    bus6.emitStatus({ status: 'disconnected', lastValidAt: baseNow - 500, totalMessages: 1, activeSockets: 0 });
    const exec6 = new PaperExecutor({
      store,
      tradeBus: bus6,
      clock: clock6,
      getOwnedExperimentIds: () => [expPreDrop.id],
      getRules: () => rules,
    });
    exec6.start();
    clock6.advanceTo(baseNow + 1_000);
    await exec6.runMonitorTick(baseNow + 1_000);
    assert.equal((await store.getAccount(expPreDrop.id, 'A'))!.degraded, true);
    assert.equal((await store.listGaps(expPreDrop.id)).filter(g => g.kind === 'STREAM_DISCONNECTED' && g.endedAt === null).length, 2);
    exec6.stop();
    await exec6.flush();

    // 7. Open position from before restart + late initial WS connect (+4.8s) -> no false STALE_MARKET at +5.1s (300ms post-connect), flags at +9.9s (>5s post-connect)
    const expLatePos = makeExp('exp-late-connect-pos', baseNow - 3_600_000);
    await store.withTx(async (tx) => {
      await store.insertExperiment(expLatePos, tx);
      await store.insertAccounts([makeAccount(expLatePos.id, 'A', 9_900, baseNow - 3_600_000), makeAccount(expLatePos.id, 'B', 10_000, baseNow - 3_600_000)], tx);
      await store.upsertPosition({
        id: 'pos-late-connect',
        experimentId: expLatePos.id,
        account: 'A',
        symbol: 'BTCUSDT',
        side: 'LONG',
        qty: 1,
        entryPrice: 100,
        stopPrice: 98,
        openedAt: baseNow - 3_600_000,
        openedDecisionHour: baseNow - 3_600_000,
        status: 'OPEN',
      }, tx);
    });
    const clock7 = new FakeClock(baseNow);
    const bus7 = new TradeBus();
    bus7.emitStatus({ status: 'connecting', lastValidAt: 0, totalMessages: 0, activeSockets: 1 });
    const exec7 = new PaperExecutor({
      store,
      tradeBus: bus7,
      clock: clock7,
      getOwnedExperimentIds: () => [expLatePos.id],
      getRules: () => rules,
    });
    exec7.start();

    clock7.advanceTo(baseNow + 4_800);
    bus7.emitStatus({ status: 'connected', lastValidAt: baseNow + 4_800, totalMessages: 1, activeSockets: 1 });
    clock7.advanceTo(baseNow + 5_100);
    await exec7.runMonitorTick(baseNow + 5_100);
    assert.equal((await store.getAccount(expLatePos.id, 'A'))!.degraded, false);
    assert.equal((await store.listGaps(expLatePos.id)).length, 0);

    clock7.advanceTo(baseNow + 9_900);
    await exec7.runMonitorTick(baseNow + 9_900);
    assert.equal((await store.getAccount(expLatePos.id, 'A'))!.degraded, true);
    assert.equal((await store.listGaps(expLatePos.id)).filter(g => g.kind === 'STALE_MARKET').length, 1);
    exec7.stop();
    await exec7.flush();

    // 8. stop() -> immediate start() while a monitor tick is running does not spawn duplicate monitor timers
    const clock8 = new FakeClock(baseNow);
    const bus8 = new TradeBus();
    bus8.emitStatus({ status: 'connected', lastValidAt: baseNow, totalMessages: 1, activeSockets: 1 });
    const exec8 = new PaperExecutor({
      store,
      tradeBus: bus8,
      clock: clock8,
      getOwnedExperimentIds: () => [],
      getRules: () => rules,
    });
    exec8.start();
    assert.equal(clock8.timers.size, 1);
    clock8.advanceTo(baseNow + 1_000);
    // Trigger tick 1 synchronously (queues async runMonitorTickInternal), then stop() + immediate start() before queue drains
    const [[firstTimerId, firstTimer]] = Array.from(clock8.timers.entries());
    clock8.timers.delete(firstTimerId);
    firstTimer.fn();
    exec8.stop();
    exec8.start();
    await exec8.flush();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(clock8.timers.size, 1);
    exec8.stop();
    await exec8.flush();
  } finally {
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
