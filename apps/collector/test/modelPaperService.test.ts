import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AutoSymbolRules } from '@fadachi/core';
import { createServer } from '../src/api/server.ts';
import { LiveHub } from '../src/live/hub.ts';
import { ModelResearchBusyError, ModelResearchRunner } from '../src/research/modelResearchRunner.ts';
import { createDuckDBClient, initDatabase } from '../src/storage/duckdb.ts';
import { BinanceStreamManager } from '../src/binance/streams.ts';
import { ModelPaperService } from '../src/modelPaper/service.ts';
import { TradeBus } from '../src/modelPaper/tradeBus.ts';
import { RollingModelPipeline } from '../src/modelPaper/rollingPipeline.ts';
import { listChronos2Adapters, validateAdapterRun } from '../src/modelPaper/adapters.ts';

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SCHEMA_PATH = path.resolve(import.meta.dirname, '..', 'src', 'storage', 'schema.sql');
const LOCK_PATH = path.join(WORKSPACE_ROOT, 'research', 'model_benchmark', 'model-assets.lock.json');

const TEST_UNIVERSE = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT',
];

function makeTestRules(): Record<string, AutoSymbolRules> {
  const rules: Record<string, AutoSymbolRules> = {};
  for (const symbol of TEST_UNIVERSE) {
    rules[symbol] = {
      stepSize: 0.001,
      minQty: 0.001,
      maxQty: 10_000,
      minNotional: 5,
      maxNotional: 100_000,
    };
  }
  return rules;
}

function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function createFakeAdapterRun(
  runsRoot: string,
  runId: string,
  opts: { status?: string; badRevision?: boolean; tamperFile?: boolean; smoke?: boolean; finishedUtc?: string } = {},
): string {
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  const revision = opts.badRevision ? 'wrong-revision-000' : String(lock.models.chronos2.revision);
  const runDir = path.join(runsRoot, runId);
  const attemptDir = path.join(runDir, 'chronos2', 'attempt_1');
  const adapterDir = path.join(attemptDir, 'adapter');
  fs.mkdirSync(adapterDir, { recursive: true });

  const cfgBuf = Buffer.from(JSON.stringify({ peft_type: 'LORA', r: 8 }), 'utf8');
  const weightsBuf = Buffer.from('fake-safetensors-payload', 'utf8');
  fs.writeFileSync(path.join(adapterDir, 'adapter_config.json'), cfgBuf);
  fs.writeFileSync(path.join(adapterDir, 'adapter_model.safetensors'), weightsBuf);

  const innerHashes = {
    'adapter_config.json': sha256(cfgBuf),
    'adapter_model.safetensors': sha256(weightsBuf),
  };
  fs.writeFileSync(path.join(adapterDir, 'adapter.sha256.json'), JSON.stringify(innerHashes, null, 2));

  // Deliberately use Linux/Colab-style absolute path in attempt_dir & Windows backslash in artifact_hashes
  const manifest = {
    run_id: runId,
    smoke: opts.smoke ?? false,
    started_utc: '2026-11-10T00:00:00Z',
    finished_utc: opts.finishedUtc ?? '2026-11-10T00:05:00Z',
    models: {
      chronos2: {
        status: opts.status ?? 'SUCCESS',
        fingerprint: 'fp-1234',
        attempt_dir: `/content/drive/MyDrive/runs/${runId}/chronos2/attempt_1`,
        training: { revision },
        artifact_hashes: {
          'adapter\\adapter_config.json': innerHashes['adapter_config.json'],
          'adapter\\adapter_model.safetensors': innerHashes['adapter_model.safetensors'],
        },
      },
    },
  };
  fs.writeFileSync(path.join(runDir, 'run_manifest.json'), JSON.stringify(manifest, null, 2));

  if (opts.tamperFile) {
    fs.writeFileSync(path.join(adapterDir, 'adapter_model.safetensors'), 'tampered-bytes');
  }
  return runDir;
}

function makeNoopSpawn() {
  return () => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {}, on: () => {}, destroy: () => {} };
    child.killed = false;
    child.exitCode = 1;
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.emit('data', JSON.stringify({ event: 'error', errorCode: 'DATA_NOT_READY', message: 'noop test worker' }) + '\n');
      child.emit('close', 4, null);
    });
    return child;
  };
}

function makeServerStubs(dataDir: string, client: any) {
  return {
    client,
    writer: { stop: async () => {}, start: () => {}, flush: async () => {} } as any,
    liveHub: new LiveHub(),
    gapDetector: { getCursor: () => 0 } as any,
    sessionManager: {} as any,
    streamManager: { getStatus: () => ({ status: 'connected', lastValidAt: Date.now(), totalMessages: 0, activeSockets: 1 }) } as any,
    universeManager: { getSymbols: () => TEST_UNIVERSE } as any,
    eventsManager: {} as any,
    dataDir,
    token: 'test-token-123',
  };
}

test('ModelPaperService HTTP API: adapter validation, create/idempotency/409, pause/resume/stop, exports, and paper/AB table isolation', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fadachi-mp-api-'));
  const runsRoot = path.join(tmpDir, 'runs');
  const outsideDir = path.join(tmpDir, 'outside-run');
  fs.mkdirSync(runsRoot, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });

  const goodRun = createFakeAdapterRun(runsRoot, '20261110T010000Z-good');
  const failedRun = createFakeAdapterRun(runsRoot, '20261110T000000Z-fail', { status: 'FAILED' });
  const tamperedRun = createFakeAdapterRun(runsRoot, '20261110T020000Z-tamper', { tamperFile: true });
  createFakeAdapterRun(outsideDir, 'outside-1');

  const client = await createDuckDBClient(path.join(tmpDir, 'test.duckdb'));
  await initDatabase(client, SCHEMA_PATH);

  const runner = new ModelResearchRunner({
    workspaceRoot: WORKSPACE_ROOT,
    dataDir: tmpDir,
    spawnWorker: makeNoopSpawn(),
  });
  const tradeBus = new TradeBus();

  const nowMs = 1_700_006_450_000;
  const fakeClock = {
    now: () => nowMs,
    setTimeout: (fn: () => void, ms: number) => {
      const t = setTimeout(fn, Math.min(ms, 60_000));
      t.unref();
      return t;
    },
    clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout),
  };

  const service = new ModelPaperService({
    client,
    dataDir: tmpDir,
    workspaceRoot: WORKSPACE_ROOT,
    runner,
    tradeBus,
    clock: fakeClock,
    runsRoot,
    universeSymbols: TEST_UNIVERSE,
    available: true,
    fetchSymbolRules: async () => makeTestRules(),
    fetchFundingHistory: async () => [],
    fetchImpl: async () => new Response('[]', { status: 200 }),
  });

  const stubs = makeServerStubs(tmpDir, client);
  const app = createServer({
    ...stubs,
    researchRunner: runner,
    tradeBus,
    modelPaperService: service,
  });

  const authHeaders = { authorization: 'Bearer test-token-123' };

  try {
    await service.start();
    // 1. List adapters reports local-rolling mode (Colab runsRoot no longer surfaced)
    const adaptersRes = await app.inject({ method: 'GET', url: '/api/model-paper/adapters', headers: authHeaders });
    assert.equal(adaptersRes.statusCode, 200);
    const adaptersBody = adaptersRes.json();
    assert.equal(adaptersBody.pipelineMode, 'local-rolling');
    assert.equal(adaptersBody.available, true);
    assert.equal(adaptersBody.defaultRunDir, null);
    assert.equal(adaptersBody.adapters.length, 0);
    assert.equal(adaptersBody.rollingPipeline.mode, 'local-rolling');
    assert.equal(adaptersBody.rollingPipeline.chronos2.ready, false);

    // 2. Reject invalid requestId (Fastify schema -> 400)
    const badReqId = await app.inject({
      method: 'POST',
      url: '/api/model-paper/experiments',
      headers: authHeaders,
      payload: { requestId: 'bad', adapterRunDir: goodRun },
    });
    assert.equal(badReqId.statusCode, 400);

    // 3. Reject outside RUNS_ROOT, FAILED, tampered adapter -> 400
    for (const badDir of [path.join(outsideDir, 'outside-1'), failedRun, tamperedRun]) {
      const badAdapterRes = await app.inject({
        method: 'POST',
        url: '/api/model-paper/experiments',
        headers: authHeaders,
        payload: { requestId: 'req_bad_adapter_01', adapterRunDir: badDir },
      });
      assert.equal(badAdapterRes.statusCode, 400);
    }

    // 4. Reject when futures stream is disconnected -> 409
    const discRes = await app.inject({
      method: 'POST',
      url: '/api/model-paper/experiments',
      headers: authHeaders,
      payload: { requestId: 'req_create_0001', adapterRunDir: goodRun },
    });
    assert.equal(discRes.statusCode, 409);

    // 5. Connect stream & create experiment -> 200
    tradeBus.emitStatus({ status: 'connected', lastValidAt: nowMs, totalMessages: 1, activeSockets: 1 });
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/model-paper/experiments',
      headers: authHeaders,
      payload: { requestId: 'req_create_0001', adapterRunDir: goodRun },
    });
    assert.equal(createRes.statusCode, 200);
    const created = createRes.json();
    const expId = created.experiment.id;
    assert.equal(created.experiment.status, 'RUNNING');
    assert.equal(created.accounts.A.state.cash, 10_000);
    assert.equal(created.accounts.B.state.cash, 10_000);

    // 6. Idempotent replay with same requestId returns exact experiment
    const replayRes = await app.inject({
      method: 'POST',
      url: '/api/model-paper/experiments',
      headers: authHeaders,
      payload: { requestId: 'req_create_0001', adapterRunDir: goodRun },
    });
    assert.equal(replayRes.statusCode, 200);
    assert.equal(replayRes.json().experiment.id, expId);

    // 7. Reused requestId for pause -> 409
    const reuseRes = await app.inject({
      method: 'POST',
      url: `/api/model-paper/experiments/${expId}/pause`,
      headers: authHeaders,
      payload: { requestId: 'req_create_0001' },
    });
    assert.equal(reuseRes.statusCode, 409);

    // 8. Concurrent second active experiment -> 409
    const dupRes = await app.inject({
      method: 'POST',
      url: '/api/model-paper/experiments',
      headers: authHeaders,
      payload: { requestId: 'req_create_0002', adapterRunDir: goodRun },
    });
    assert.equal(dupRes.statusCode, 409);

    // 9. Pause -> Resume -> Stop lifecycle
    const pauseRes = await app.inject({
      method: 'POST',
      url: `/api/model-paper/experiments/${expId}/pause`,
      headers: authHeaders,
      payload: { requestId: 'req_pause_0001' },
    });
    assert.equal(pauseRes.statusCode, 200);
    assert.equal(pauseRes.json().experiment.status, 'PAUSED');

    const resumeRes = await app.inject({
      method: 'POST',
      url: `/api/model-paper/experiments/${expId}/resume`,
      headers: authHeaders,
      payload: { requestId: 'req_resume_0001' },
    });
    assert.equal(resumeRes.statusCode, 200);
    assert.equal(resumeRes.json().experiment.status, 'RUNNING');

    // Stop with 0 open positions -> transitions immediately to STOPPED
    const stopRes = await app.inject({
      method: 'POST',
      url: `/api/model-paper/experiments/${expId}/stop`,
      headers: authHeaders,
      payload: { requestId: 'req_stop_0001' },
    });
    assert.equal(stopRes.statusCode, 200);
    assert.equal(stopRes.json().experiment.status, 'STOPPED');

    // 10. List & Get detail & Export (including CSV formula guard & kind=all&format=csv -> 400)
    const listRes = await app.inject({ method: 'GET', url: '/api/model-paper/experiments', headers: authHeaders });
    assert.equal(listRes.statusCode, 200);
    assert.equal(listRes.json().experiments.length, 1);

    const getRes = await app.inject({ method: 'GET', url: `/api/model-paper/experiments/${expId}`, headers: authHeaders });
    assert.equal(getRes.statusCode, 200);
    assert.equal(getRes.json().experiment.id, expId);

    const badExport = await app.inject({
      method: 'GET',
      url: `/api/model-paper/experiments/${expId}/export?kind=all&format=csv`,
      headers: authHeaders,
    });
    assert.equal(badExport.statusCode, 400);

    const allJson = await app.inject({
      method: 'GET',
      url: `/api/model-paper/experiments/${expId}/export?kind=all&format=json`,
      headers: authHeaders,
    });
    assert.equal(allJson.statusCode, 200);
    assert.equal(allJson.json().experiment.id, expId);

    const configCsv = await app.inject({
      method: 'GET',
      url: `/api/model-paper/experiments/${expId}/export?kind=config&format=csv`,
      headers: authHeaders,
    });
    assert.equal(configCsv.statusCode, 200);
    assert.match(configCsv.body, /adapter_run_id,20261110T010000Z-good/);

    // 11. Verify paper_accounts & ab_trading_batches remain untouched (0 rows)
    const paperRows = await client.all<{ cnt: number }>('SELECT COUNT(*)::INT AS cnt FROM paper_accounts');
    const abRows = await client.all<{ cnt: number }>('SELECT COUNT(*)::INT AS cnt FROM ab_trading_batches');
    assert.equal(paperRows[0].cnt, 0);
    assert.equal(abRows[0].cnt, 0);
  } finally {
    await app.close();
    await service.stop();
    runner.close();
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ModelPaperService: restart recovery (AWAITING_RESUME, cancels ENTRY, keeps EXIT) & single-owner lease fencing', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fadachi-mp-recover-'));
  const runsRoot = path.join(tmpDir, 'runs');
  fs.mkdirSync(runsRoot, { recursive: true });
  const goodRun = createFakeAdapterRun(runsRoot, '20261110T010000Z-rec');

  const client = await createDuckDBClient(path.join(tmpDir, 'test.duckdb'));
  const runner1 = new ModelResearchRunner({ workspaceRoot: WORKSPACE_ROOT, dataDir: tmpDir, spawnWorker: makeNoopSpawn() });
  const runner2 = new ModelResearchRunner({ workspaceRoot: WORKSPACE_ROOT, dataDir: tmpDir, spawnWorker: makeNoopSpawn() });
  let svc1: ModelPaperService | undefined;
  let intruder: ModelPaperService | undefined;
  let svc2: ModelPaperService | undefined;

  try {
    await initDatabase(client, SCHEMA_PATH);
    const tradeBus1 = new TradeBus();
    const tradeBus2 = new TradeBus();
    tradeBus1.emitStatus({ status: 'connected', lastValidAt: Date.now(), totalMessages: 1, activeSockets: 1 });
    tradeBus2.emitStatus({ status: 'connected', lastValidAt: Date.now(), totalMessages: 1, activeSockets: 1 });

    let nowMs = 1_700_006_450_000;
    const fakeClock = {
      now: () => nowMs,
      setTimeout: (fn: () => void, ms: number) => {
        const t = setTimeout(fn, Math.min(ms, 60_000));
        t.unref();
        return t;
      },
      clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout),
    };

    svc1 = new ModelPaperService({
      client,
      dataDir: tmpDir,
      workspaceRoot: WORKSPACE_ROOT,
      runner: runner1,
      tradeBus: tradeBus1,
      clock: fakeClock,
      runsRoot,
      universeSymbols: TEST_UNIVERSE,
      available: true,
      leaseTtlMs: 30_000,
      generation: 100,
      ownerToken: 'owner-1',
      fetchSymbolRules: async () => makeTestRules(),
      fetchFundingHistory: async () => [],
      fetchImpl: async () => new Response('[]', { status: 200 }),
    });

    await svc1.start();
    const created = await svc1.createExperiment({ requestId: 'req_rec_create_1', adapterRunDir: goodRun });
    const expId = created.experiment.id;

    await svc1.scheduler.flush();

    // Insert 1 pending ENTRY order, 1 pending EXIT order, and 1 orphaned PENDING decision
    const currentH = Math.floor(nowMs / 3_600_000) * 3_600_000 - 3_600_000;
    const orphanH = currentH - 3_600_000;
    await svc1.store.withTx(async (tx) => {
      await svc1!.store.claimDecision({
        id: `${expId}:chronos2:${orphanH}`,
        experimentId: expId,
        modelKey: 'chronos2',
        decisionHour: orphanH,
        now: nowMs,
      }, tx);
      await svc1!.store.insertOrderIfAbsent({
        id: 'ord-rec-entry',
        experimentId: expId,
        account: 'A',
        decisionId: 'dec-rec',
        symbol: 'BTCUSDT',
        side: 'LONG',
        action: 'ENTRY',
        reason: 'NEW_ENTRY',
        qty: 1,
        refPrice: 100,
        createdAt: nowMs,
        status: 'PENDING',
        cancelReason: null,
        positionId: null,
      }, tx);
      await svc1!.store.insertOrderIfAbsent({
        id: 'ord-rec-exit',
        experimentId: expId,
        account: 'B',
        decisionId: 'dec-rec',
        symbol: 'ETHUSDT',
        side: 'SHORT',
        action: 'EXIT',
        reason: 'SIGNAL_GONE',
        qty: 2,
        refPrice: 50,
        createdAt: nowMs,
        status: 'PENDING',
        cancelReason: null,
        positionId: 'pos-rec-b',
      }, tx);
    });

    // Simulate another lower/equal instance trying to take over while owner-1 lease is still active (nowMs + 5s < +30s)
    nowMs += 5_000;
    intruder = new ModelPaperService({
      client,
      dataDir: tmpDir,
      workspaceRoot: WORKSPACE_ROOT,
      runner: runner2,
      tradeBus: tradeBus2,
      clock: fakeClock,
      runsRoot,
      universeSymbols: TEST_UNIVERSE,
      available: true,
      leaseTtlMs: 30_000,
      generation: 100,
      ownerToken: 'owner-2',
      fetchSymbolRules: async () => makeTestRules(),
      fetchFundingHistory: async () => [],
      fetchImpl: async () => new Response('[]', { status: 200 }),
    });
    await intruder.start();
    // Active lease blocked owner-2: experiment still RUNNING and orders untouched
    assert.equal((await svc1.store.getExperiment(expId))?.status, 'RUNNING');
    assert.equal((await svc1.store.listPendingOrders(expId)).length, 2);
    await intruder.stop();
    intruder = undefined;

    // Now simulate clean shutdown/crash of svc1 (release lease via stop) and restart as svc2 with higher generation
    await svc1.stop();
    svc1 = undefined;
    nowMs += 40_000;

    svc2 = new ModelPaperService({
      client,
      dataDir: tmpDir,
      workspaceRoot: WORKSPACE_ROOT,
      runner: runner2,
      tradeBus: tradeBus2,
      clock: fakeClock,
      runsRoot,
      universeSymbols: TEST_UNIVERSE,
      available: true,
      leaseTtlMs: 30_000,
      generation: 200,
      ownerToken: 'owner-3',
      fetchSymbolRules: async () => makeTestRules(),
      fetchFundingHistory: async () => [],
      fetchImpl: async () => new Response('[]', { status: 200 }),
    });
    await svc2.start();

    const afterRestart = await svc2.getExperimentDetail(expId);
    assert.equal(afterRestart.experiment.status, 'AWAITING_RESUME');
    assert.equal(afterRestart.gaps.some(g => g.kind === 'PROCESS_RESTART'), true);
    const orphanDec = afterRestart.decisions.find(d => d.decisionHour === orphanH);
    assert.equal(orphanDec?.status, 'FAILED');
    assert.match(orphanDec?.reason ?? '', /程序重啟中斷推論/);

    const ordersAfterRestart = [
      ...afterRestart.accounts.A.pendingOrders,
      ...afterRestart.accounts.A.recentOrders,
      ...afterRestart.accounts.B.pendingOrders,
      ...afterRestart.accounts.B.recentOrders,
    ];
    assert.equal(ordersAfterRestart.find(o => o.id === 'ord-rec-entry')?.status, 'CANCELLED');
    assert.equal(ordersAfterRestart.find(o => o.id === 'ord-rec-entry')?.cancelReason, 'RESTART_RECOVERY');
    assert.equal(ordersAfterRestart.find(o => o.id === 'ord-rec-exit')?.status, 'PENDING');
  } finally {
    await intruder?.stop().catch(() => {});
    await svc1?.stop().catch(() => {});
    await svc2?.stop().catch(() => {});
    runner1.close();
    runner2.close();
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ModelPaperService: restart with connecting stream avoids false STREAM_DISCONNECTED gap for restarted and STOPPING experiments, while flagging post-connect disconnect', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fadachi-mp-restart-grace-'));
  const runsRoot = path.join(tmpDir, 'runs');
  fs.mkdirSync(runsRoot, { recursive: true });
  const goodRun = createFakeAdapterRun(runsRoot, '20261110T010000Z-grace');

  const client = await createDuckDBClient(path.join(tmpDir, 'test.duckdb'));
  const runner1 = new ModelResearchRunner({ workspaceRoot: WORKSPACE_ROOT, dataDir: tmpDir, spawnWorker: makeNoopSpawn() });
  const runner2 = new ModelResearchRunner({ workspaceRoot: WORKSPACE_ROOT, dataDir: tmpDir, spawnWorker: makeNoopSpawn() });
  const runner3 = new ModelResearchRunner({ workspaceRoot: WORKSPACE_ROOT, dataDir: tmpDir, spawnWorker: makeNoopSpawn() });
  let svc1: ModelPaperService | undefined;
  let svc2: ModelPaperService | undefined;
  let svc3: ModelPaperService | undefined;

  try {
    await initDatabase(client, SCHEMA_PATH);
    let nowMs = 1_700_020_000_000;
    const makeClock = () => ({
      now: () => nowMs,
      setTimeout: (fn: () => void, ms: number) => {
        const t = setTimeout(fn, Math.min(ms, 60_000));
        t.unref();
        return t;
      },
      clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout),
    });

    const tradeBus1 = new TradeBus();
    tradeBus1.emitStatus({ status: 'connected', lastValidAt: nowMs, totalMessages: 1, activeSockets: 1 });

    svc1 = new ModelPaperService({
      client,
      dataDir: tmpDir,
      workspaceRoot: WORKSPACE_ROOT,
      runner: runner1,
      tradeBus: tradeBus1,
      clock: makeClock(),
      runsRoot,
      universeSymbols: TEST_UNIVERSE,
      available: true,
      ownerToken: 'grace-owner-1',
      generation: 10,
      fetchSymbolRules: async () => makeTestRules(),
      fetchFundingHistory: async () => [],
      fetchImpl: async () => new Response('[]', { status: 200 }),
    });
    await svc1.start();
    const created = await svc1.createExperiment({ requestId: 'req_grace_create_1', adapterRunDir: goodRun });
    const expId = created.experiment.id;
    await svc1.scheduler.flush();

    // Seed a historical STOPPED experiment too (should never acquire gaps on restart)
    const stoppedExpId = 'mp-stopped-hist';
    await svc1.store.withTx(async (tx) => {
      await svc1!.store.insertExperiment({
        ...created.experiment,
        id: stoppedExpId,
        status: 'STOPPED',
        stoppedAt: nowMs - 10_000,
        createdAt: nowMs - 60_000,
      }, tx);
      await svc1!.store.insertAccounts([
        { ...created.accounts.A.state, experimentId: stoppedExpId },
        { ...created.accounts.B.state, experimentId: stoppedExpId },
      ], tx);
    });

    await svc1.stop();
    svc1 = undefined;

    // Restart with tradeBus2 in 'connecting' (NOT pre-connected!)
    nowMs += 10_000;
    const restartAt = nowMs;
    const tradeBus2 = new TradeBus();
    tradeBus2.emitStatus({ status: 'connecting', lastValidAt: 0, totalMessages: 0, activeSockets: 1 });

    svc2 = new ModelPaperService({
      client,
      dataDir: tmpDir,
      workspaceRoot: WORKSPACE_ROOT,
      runner: runner2,
      tradeBus: tradeBus2,
      clock: makeClock(),
      runsRoot,
      universeSymbols: TEST_UNIVERSE,
      available: true,
      ownerToken: 'grace-owner-2',
      generation: 20,
      fetchSymbolRules: async () => makeTestRules(),
      fetchFundingHistory: async () => [],
      fetchImpl: async () => new Response('[]', { status: 200 }),
    });
    await svc2.start();

    // Tick at +1s and +3s while stream is still connecting -> NO spurious STREAM_DISCONNECTED gap!
    nowMs = restartAt + 1_000;
    await svc2.executor.runMonitorTick(nowMs);
    nowMs = restartAt + 3_000;
    await svc2.executor.runMonitorTick(nowMs);

    let detail = await svc2.getExperimentDetail(expId);
    assert.equal(detail.experiment.status, 'AWAITING_RESUME');
    assert.equal(detail.accounts.A.state.degraded, false);
    assert.equal(detail.accounts.B.state.degraded, false);
    assert.deepEqual(detail.gaps.map(g => g.kind), ['PROCESS_RESTART']);
    assert.equal((await svc2.store.listGaps(stoppedExpId)).length, 0);

    // Stream finishes connecting at +3.5s -> still zero STREAM_DISCONNECTED gaps
    nowMs = restartAt + 3_500;
    tradeBus2.emitStatus({ status: 'connected', lastValidAt: nowMs, totalMessages: 1, activeSockets: 1 });
    await svc2.executor.runMonitorTick(nowMs);
    detail = await svc2.getExperimentDetail(expId);
    assert.deepEqual(detail.gaps.map(g => g.kind), ['PROCESS_RESTART']);

    // Real post-connect disconnect at +4.2s (even inside +5s!) -> immediately records STREAM_DISCONNECTED
    nowMs = restartAt + 4_200;
    tradeBus2.emitStatus({ status: 'disconnected', lastValidAt: restartAt + 3_500, totalMessages: 1, activeSockets: 0 });
    await svc2.executor.runMonitorTick(nowMs);
    detail = await svc2.getExperimentDetail(expId);
    assert.equal(detail.accounts.A.state.degraded, true);
    assert.equal(detail.accounts.B.state.degraded, true);
    assert.equal(detail.gaps.filter(g => g.kind === 'STREAM_DISCONNECTED' && g.endedAt === null).length, 2);

    // Reconnect closes those STREAM_DISCONNECTED gaps
    nowMs = restartAt + 5_000;
    tradeBus2.emitStatus({ status: 'connected', lastValidAt: nowMs, totalMessages: 2, activeSockets: 1 });
    await svc2.executor.runMonitorTick(nowMs);
    detail = await svc2.getExperimentDetail(expId);
    assert.equal(detail.accounts.A.state.degraded, false);
    assert.equal(detail.gaps.every(g => g.endedAt !== null), true);

    // Transition experiment to STOPPING with an open position, restart again with 'connecting' stream -> no false STREAM_DISCONNECTED gap
    await svc2.store.withTx(async (tx) => {
      await svc2!.store.upsertPosition({
        id: 'pos-stopping-1',
        experimentId: expId,
        account: 'A',
        symbol: 'BTCUSDT',
        side: 'LONG',
        qty: 1,
        entryPrice: 100,
        stopPrice: 98,
        openedAt: nowMs,
        openedDecisionHour: Math.floor(nowMs / 3_600_000) * 3_600_000,
        status: 'OPEN',
      }, tx);
      await svc2!.store.updateExperimentStatus(expId, 'STOPPING', { heartbeatAt: nowMs }, tx);
    });
    await svc2.stop();
    svc2 = undefined;

    nowMs += 5_000;
    const restart2At = nowMs;
    const tradeBus3 = new TradeBus();
    tradeBus3.emitStatus({ status: 'connecting', lastValidAt: 0, totalMessages: 0, activeSockets: 1 });
    svc3 = new ModelPaperService({
      client,
      dataDir: tmpDir,
      workspaceRoot: WORKSPACE_ROOT,
      runner: runner3,
      tradeBus: tradeBus3,
      clock: makeClock(),
      runsRoot,
      universeSymbols: TEST_UNIVERSE,
      available: true,
      ownerToken: 'grace-owner-3',
      generation: 30,
      fetchSymbolRules: async () => makeTestRules(),
      fetchFundingHistory: async () => [],
      fetchImpl: async () => new Response('[]', { status: 200 }),
    });
    await svc3.start();

    nowMs = restart2At + 1_000;
    await svc3.executor.runMonitorTick(nowMs);
    const stoppingDetail = await svc3.getExperimentDetail(expId);
    assert.equal(stoppingDetail.experiment.status, 'STOPPING');
    assert.equal(stoppingDetail.accounts.A.state.degraded, false);
    assert.equal(
      stoppingDetail.gaps.filter(g => g.kind === 'STREAM_DISCONNECTED' && g.startedAt >= restart2At).length,
      0,
    );

    // Pre-start connect->disconnect on TradeBus is NOT masked by startup grace when svc4 restarts
    await svc3.stop();
    svc3 = undefined;
    nowMs += 5_000;
    const restart3At = nowMs;
    const tradeBus4 = new TradeBus();
    tradeBus4.emitStatus({ status: 'connected', lastValidAt: restart3At - 500, totalMessages: 1, activeSockets: 1 });
    tradeBus4.emitStatus({ status: 'disconnected', lastValidAt: restart3At - 500, totalMessages: 1, activeSockets: 0 });
    const svc4 = new ModelPaperService({
      client,
      dataDir: tmpDir,
      workspaceRoot: WORKSPACE_ROOT,
      runner: runner3,
      tradeBus: tradeBus4,
      clock: makeClock(),
      runsRoot,
      universeSymbols: TEST_UNIVERSE,
      available: true,
      ownerToken: 'grace-owner-4',
      generation: 40,
      fetchSymbolRules: async () => makeTestRules(),
      fetchFundingHistory: async () => [],
      fetchImpl: async () => new Response('[]', { status: 200 }),
    });
    try {
      await svc4.start();
      nowMs = restart3At + 1_000;
      await svc4.executor.runMonitorTick(nowMs);
      const dropDetail = await svc4.getExperimentDetail(expId);
      assert.equal(dropDetail.accounts.A.state.degraded, true);
      assert.equal(
        dropDetail.gaps.filter(g => g.kind === 'STREAM_DISCONNECTED' && g.startedAt >= restart3At && g.endedAt === null).length,
        2,
      );
    } finally {
      await svc4.stop().catch(() => {});
    }
  } finally {
    await svc1?.stop().catch(() => {});
    await svc2?.stop().catch(() => {});
    await svc3?.stop().catch(() => {});
    runner1.close();
    runner2.close();
    runner3.close();
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ModelResearchRunner: runExclusive shares busy lock with startRunJob in both directions & validateAdapterRun normalizes hashes', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fadachi-mp-lock-'));
  const runsRoot = path.join(tmpDir, 'runs');
  const goodRun = createFakeAdapterRun(runsRoot, '20261110T010000Z-norm');

  // Verify validateAdapterRun handles Windows backslash artifact_hashes & Linux attempt_dir rebase
  const validated = validateAdapterRun(runsRoot, goodRun, WORKSPACE_ROOT);
  assert.ok(validated.modelSource.artifactHashes['adapter/adapter_config.json']);
  assert.ok(validated.modelSource.attemptDir.endsWith(path.join('chronos2', 'attempt_1')));

  let releaseChild!: () => void;
  const fakeSpawn = () => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {}, on: () => {}, destroy: () => {} };
    child.killed = false;
    child.exitCode = null;
    child.kill = () => {
      child.killed = true;
      child.exitCode = 1;
      child.emit('close', 1, 'SIGTERM');
      return true;
    };
    releaseChild = () => {
      child.stdout.emit('data', JSON.stringify({
        event: 'result',
        data: {
          runId: 'job-1',
          status: 'SUCCESS',
          market: 'futures',
          kronosModel: 'chronos2',
          decisionOpenTime: 1_700_002_800_000,
          cutoffTime: 1_700_006_400_000,
          expiresAt: 1_700_010_000_000,
          generatedAt: Date.now(),
          rankings: { longTop5: [], shortTop5: [], allRankings: [], conflictSymbols: [] },
          forecasts: {},
        },
      }) + '\n');
      child.exitCode = 0;
      child.emit('close', 0, null);
    };
    return child;
  };

  const runner = new ModelResearchRunner({
    workspaceRoot: WORKSPACE_ROOT,
    dataDir: tmpDir,
    spawnWorker: fakeSpawn,
  });

  try {
    // 1. Hold exclusive forward lock -> startRunJob throws ModelResearchBusyError (409)
    let insideExclusive = false;
    let releaseExclusive!: () => void;
    const exclusiveDone = runner.runExclusive('forward-test', () => new Promise<string>((resolve) => {
      insideExclusive = true;
      releaseExclusive = () => resolve('done');
    }));

    assert.equal(insideExclusive, true);
    assert.equal(runner.isBusy(), true);
    assert.throws(
      () => runner.startRunJob({ kronosModel: 'chronos2', cutoffTime: 1_700_006_400_000 }),
      (err: unknown) => err instanceof ModelResearchBusyError,
    );

    releaseExclusive();
    assert.equal(await exclusiveDone, 'done');
    assert.equal(runner.isBusy(), false);

    // 2. Start Kronos/benchmark run job -> runExclusive throws ModelResearchBusyError
    runner.startRunJob({ kronosModel: 'chronos2', cutoffTime: 1_700_006_400_000 });
    assert.equal(runner.isBusy(), true);
    await assert.rejects(
      () => runner.runExclusive('forward-test', async () => 'nope'),
      (err: unknown) => err instanceof ModelResearchBusyError,
    );

    releaseChild();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(runner.isBusy(), false);
  } finally {
    runner.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('BinanceStreamManager uses /market/stream for futures shards & listChronos2Adapters prefers valid non-smoke runs over smoke runs', () => {
  const futuresMgr = new BinanceStreamManager('futures', [], { onMessage: () => {} });
  assert.equal(
    futuresMgr.getUrl(['!ticker@arr']),
    'wss://fstream.binance.com/market/ws/!ticker@arr',
  );
  assert.equal(
    futuresMgr.getUrl(['!ticker@arr', 'btcusdt@aggTrade']),
    'wss://fstream.binance.com/market/stream?streams=!ticker@arr/btcusdt@aggTrade',
  );
  const spotMgr = new BinanceStreamManager('spot', [], { onMessage: () => {} });
  assert.equal(
    spotMgr.getUrl(['btcusdt@aggTrade', 'ethusdt@kline_1m']),
    'wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade/ethusdt@kline_1m',
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fadachi-mp-adapters-pref-'));
  const runsRoot = path.join(tmpDir, 'runs');
  try {
    const fullRun = createFakeAdapterRun(runsRoot, 'full-older', {
      smoke: false,
      finishedUtc: '2026-11-10T10:00:00Z',
    });
    createFakeAdapterRun(runsRoot, 'smoke-newer', {
      smoke: true,
      finishedUtc: '2026-11-11T10:00:00Z',
    });

    const listed = listChronos2Adapters(WORKSPACE_ROOT, runsRoot);
    assert.equal(fs.realpathSync(listed.defaultRunDir!), fs.realpathSync(fullRun));
    assert.equal(listed.adapters.find(a => a.runId === 'full-older')?.isDefault, true);
    assert.equal(listed.adapters.find(a => a.runId === 'smoke-newer')?.isDefault, undefined);

    // Real workspace default run resolves to latest full run colab-2ac72155a17a4a91-full when present
    const realListed = listChronos2Adapters(WORKSPACE_ROOT);
    const hasColabFull = realListed.adapters.some(a => a.runId === 'colab-2ac72155a17a4a91-full' && a.valid && !a.smoke);
    if (hasColabFull) {
      assert.ok(realListed.defaultRunDir?.endsWith('colab-2ac72155a17a4a91-full'));
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Local rolling pipeline: creates experiment without adapterRunDir, deduplicates hourly cycle, commits research, and enforces GPU train lock', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fadachi-rolling-int-'));
  const fakeWorkspace = path.join(tmpDir, 'ws');
  const fakeData = path.join(tmpDir, 'data');

  const lockObj = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  const chronosLock = lockObj.models.chronos2;
  fs.mkdirSync(path.join(fakeWorkspace, 'research', 'model_benchmark'), { recursive: true });
  fs.writeFileSync(path.join(fakeWorkspace, 'research', 'model_benchmark', 'model-assets.lock.json'), JSON.stringify(lockObj, null, 2));

  const baseCacheDir = path.join(fakeWorkspace, '.benchmark-cache', 'models', 'chronos2');
  fs.mkdirSync(baseCacheDir, { recursive: true });
  for (const filename of Object.keys(chronosLock.files)) {
    fs.writeFileSync(path.join(baseCacheDir, filename), `dummy-base-${filename}`);
  }

  // Write valid local rolling datasets, lgbm v1, and chronos2 v1
  const liveRoot = path.join(fakeData, 'model-live');
  const datasetsDir = path.join(liveRoot, 'datasets');
  fs.mkdirSync(datasetsDir, { recursive: true });
  fs.writeFileSync(path.join(datasetsDir, 'klines_1h.parquet'), 'PAR1-mock');
  const targetHourH = Math.floor(1_700_002_800_000 / 3_600_000) * 3_600_000;
  const targetCutoff = targetHourH + 3_600_000;
  fs.writeFileSync(
    path.join(datasetsDir, 'dataset_state.json'),
    JSON.stringify({ windowDays: 180, datasetVersion: 'rolling-v1', lastCutoffTime: targetCutoff, universeSymbols: TEST_UNIVERSE }),
  );

  const lgbmVerDir = path.join(liveRoot, 'models', 'lgbm', 'versions', 'lgbm-v1');
  fs.mkdirSync(lgbmVerDir, { recursive: true });
  fs.writeFileSync(path.join(lgbmVerDir, 'lgbm_long_ranker.txt'), 'tree-long');
  fs.writeFileSync(path.join(lgbmVerDir, 'lgbm_short_ranker.txt'), 'tree-short');
  fs.writeFileSync(path.join(lgbmVerDir, 'lgbm_metadata.json'), JSON.stringify({ versionId: 'lgbm-v1' }));
  fs.writeFileSync(
    path.join(liveRoot, 'models', 'lgbm', 'current.json'),
    JSON.stringify({
      versionId: 'lgbm-v1',
      trainedAt: targetCutoff - 1000,
      cutoffTime: targetCutoff,
      longSha256: sha256('tree-long'),
      shortSha256: sha256('tree-short'),
      valNdcg5Long: 0.72,
      valNdcg5Short: 0.69,
    }),
  );

  const writeChronosVersion = (versionId: string, trainedAt: number) => {
    const adapterDir = path.join(liveRoot, 'models', 'chronos2', 'versions', versionId, 'attempt', 'adapter');
    fs.mkdirSync(adapterDir, { recursive: true });
    const cfgBuf = Buffer.from(JSON.stringify({ peft_type: 'LORA', r: 8 }), 'utf8');
    const weightsBuf = Buffer.from(`lora-weights-${versionId}`, 'utf8');
    fs.writeFileSync(path.join(adapterDir, 'adapter_config.json'), cfgBuf);
    fs.writeFileSync(path.join(adapterDir, 'adapter_model.safetensors'), weightsBuf);
    const innerHashes = {
      'adapter_config.json': sha256(cfgBuf),
      'adapter_model.safetensors': sha256(weightsBuf),
    };
    fs.writeFileSync(path.join(adapterDir, 'adapter.sha256.json'), JSON.stringify(innerHashes, null, 2));
    fs.writeFileSync(
      path.join(liveRoot, 'models', 'chronos2', 'current.json'),
      JSON.stringify({
        versionId,
        trainedAt,
        cutoffTime: targetCutoff,
        nextRetrainAt: trainedAt + 6 * 3_600_000,
        retrainIntervalHours: 6,
        baseRepoId: chronosLock.repo_id,
        baseRevision: chronosLock.revision,
        attemptDir: path.join(liveRoot, 'models', 'chronos2', 'versions', versionId, 'attempt'),
        adapterSha256Json: innerHashes,
        artifactHashes: {
          'adapter/adapter_config.json': innerHashes['adapter_config.json'],
          'adapter/adapter_model.safetensors': innerHashes['adapter_model.safetensors'],
        },
        valReturnMae: 0.0042,
        valDirectionHitRate: 0.58,
      }),
    );
  };
  writeChronosVersion('chronos2-v1', targetCutoff - 2 * 3_600_000);

  let rankCalls = 0;
  let chronosLiveCalls = 0;
  let commitCalls = 0;
  let trainCalls = 0;
  let holdTrain = false;
  let releaseTrain!: () => void;

  const mockSpawn = (_py: string, args: string[]) => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let stdinText = '';
    child.stdin = {
      write: (chunk: string | Buffer) => { stdinText += chunk.toString(); return true; },
      end: (chunk?: string | Buffer) => {
        if (chunk !== undefined) stdinText += chunk.toString();
        const modIdx = args.indexOf('-m');
        const modName = modIdx >= 0 ? args[modIdx + 1] : '';
        if (modName !== 'research.model_research.worker') return;
        queueMicrotask(() => {
          if (modName === 'research.model_research.worker') {
            const payload = JSON.parse(stdinText || '{}');
            if (payload.action === 'rolling_prepare_and_train_rank') {
              rankCalls += 1;
              const rankOut = {
                inputMode: 'live',
                replay: false,
                decisionOpenTime: targetHourH,
                cutoffTime: targetCutoff,
                universeSymbols: TEST_UNIVERSE,
                eligibleCount: TEST_UNIVERSE.length,
                insufficientSymbols: [],
                longTop5: [
                  { symbol: 'BTCUSDT', side: 'LONG', rank: 1, predScore: 0.9, longScore: 0.9, shortScore: 0.1 },
                ],
                shortTop5: [
                  { symbol: 'ETHUSDT', side: 'SHORT', rank: 1, predScore: 0.85, longScore: 0.1, shortScore: 0.85 },
                ],
                conflictSymbols: [],
                kronosTargetSymbols: ['BTCUSDT', 'ETHUSDT'],
                chronosTargetSymbols: ['BTCUSDT', 'ETHUSDT'],
                inputSha256: 'abc',
                inputHashes: {},
                lightgbm: {
                  versionId: 'lgbm-v2',
                  trainedAt: targetCutoff + 100,
                  longSha256: sha256('tree-long'),
                  shortSha256: sha256('tree-short'),
                  valNdcg5Long: 0.75,
                  valNdcg5Short: 0.71,
                  elapsedMs: 1200,
                },
                chronosTrainDue: false,
                generatedAt: targetCutoff + 200,
              };
              if (payload.outputPath) {
                fs.writeFileSync(payload.outputPath, JSON.stringify(rankOut, null, 2));
              }
              child.stdout.emit('data', JSON.stringify({ event: 'result', data: rankOut }) + '\n');
              child.exitCode = 0;
              child.emit('close', 0, null);
              return;
            }
            if (payload.action === 'commit_rolling_research') {
              commitCalls += 1;
              const runDir = path.join(fakeData, 'model-research', payload.runId);
              fs.mkdirSync(runDir, { recursive: true });
              const runRes = {
                runId: payload.runId,
                status: 'SUCCESS',
                market: 'futures',
                kronosModel: 'chronos2',
                cutoffTime: targetCutoff,
                expiresAt: targetCutoff + 3_600_000,
                generatedAt: targetCutoff + 500,
                rankings: { longTop5: [], shortTop5: [], allRankings: [], conflictSymbols: [] },
                forecasts: {},
                warnings: [],
              };
              fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(runRes, null, 2));
              child.stdout.emit('data', JSON.stringify({ event: 'result', data: { committed: true, runId: payload.runId } }) + '\n');
              child.exitCode = 0;
              child.emit('close', 0, null);
              return;
            }
            if (payload.action === 'status') {
              child.stdout.emit('data', JSON.stringify({ event: 'result', data: { datasetReady: true } }) + '\n');
              child.exitCode = 0;
              child.emit('close', 0, null);
              return;
            }
          }
          child.exitCode = 1;
          child.emit('close', 1, null);
        });
      },
      on: () => {},
      destroy: () => {},
    };
    child.killed = false;
    child.exitCode = null;
    child.kill = () => true;

    // CLI mode without stdin (chronos2_live / chronos2_train)
    const modIdx = args.indexOf('-m');
    const modName = modIdx >= 0 ? args[modIdx + 1] : '';
    if (modName === 'research.model_research.chronos2_live') {
      chronosLiveCalls += 1;
      const outIdx = args.indexOf('--output');
      const outPath = outIdx >= 0 ? args[outIdx + 1] : '';
      const outDoc = {
        decisionOpenTime: targetHourH,
        forecasts: {
          BTCUSDT: {
            symbol: 'BTCUSDT',
            decisionOpenTime: targetHourH,
            cutoffClose: 35000,
            predReturn4h: 0.008,
            predictedCloses: [35100, 35200, 35250, 35280],
            candles: [],
            historyCandles: [],
          },
          ETHUSDT: {
            symbol: 'ETHUSDT',
            decisionOpenTime: targetHourH,
            cutoffClose: 2000,
            predReturn4h: -0.006,
            predictedCloses: [1995, 1990, 1989, 1988],
            candles: [],
            historyCandles: [],
          },
        },
        skipped: [],
        modelInfo: {
          versionId: 'chronos2-v1',
          baseRevision: chronosLock.revision,
          valReturnMae: 0.0042,
        },
        elapsedMs: 320,
      };
      queueMicrotask(() => {
        if (outPath) fs.writeFileSync(outPath, JSON.stringify(outDoc, null, 2));
        child.stdout.emit('data', JSON.stringify({ event: 'result', data: outDoc }) + '\n');
        child.exitCode = 0;
        child.emit('close', 0, null);
      });
    } else if (modName === 'research.model_research.chronos2_train') {
      trainCalls += 1;
      const outIdx = args.indexOf('--output');
      const outPath = outIdx >= 0 ? args[outIdx + 1] : '';
      const completeTrain = () => {
        writeChronosVersion('chronos2-v2', targetCutoff + 1000);
        const outDoc = { versionId: 'chronos2-v2', promoted: true, valReturnMae: 0.0038 };
        if (outPath) fs.writeFileSync(outPath, JSON.stringify(outDoc, null, 2));
        child.stdout.emit('data', JSON.stringify({ event: 'result', data: outDoc }) + '\n');
        child.exitCode = 0;
        child.emit('close', 0, null);
      };
      if (holdTrain) {
        releaseTrain = completeTrain;
      } else {
        queueMicrotask(completeTrain);
      }
    }
    return child;
  };

  const client = await createDuckDBClient(path.join(tmpDir, 'rolling.duckdb'));
  await initDatabase(client, SCHEMA_PATH);

  const runner = new ModelResearchRunner({
    workspaceRoot: fakeWorkspace,
    dataDir: fakeData,
    spawnWorker: mockSpawn,
  });
  const nowMs = targetCutoff + 30_000;
  const fakeClock = {
    now: () => nowMs,
    setTimeout: (fn: () => void, ms: number) => {
      const t = setTimeout(fn, Math.min(ms, 60_000));
      t.unref();
      return t;
    },
    clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout),
  };
  const pipeline = new RollingModelPipeline({
    runner,
    dataDir: fakeData,
    workspaceRoot: fakeWorkspace,
    chronosPython: process.execPath,
    clock: fakeClock,
    autoHourlyEnabled: false,
    chronosTrainingPaused: false,
    runOnStart: false,
    retrainIntervalHours: 6,
  });
  runner.attachRollingPipeline(pipeline);

  const tradeBus = new TradeBus();
  tradeBus.emitStatus({ status: 'connected', lastValidAt: nowMs, totalMessages: 1, activeSockets: 1 });
  const service = new ModelPaperService({
    client,
    dataDir: fakeData,
    workspaceRoot: fakeWorkspace,
    runner,
    tradeBus,
    clock: fakeClock,
    rollingPipeline: pipeline,
    chronosPython: process.execPath,
    universeSymbols: TEST_UNIVERSE,
    available: true,
    fetchSymbolRules: async () => makeTestRules(),
    fetchFundingHistory: async () => [],
    fetchImpl: async () => new Response('[]', { status: 200 }),
  });

  const stubs = makeServerStubs(fakeData, client);
  const app = createServer({
    ...stubs,
    researchRunner: runner,
    tradeBus,
    modelPaperService: service,
    rollingPipeline: pipeline,
  });
  const authHeaders = { authorization: 'Bearer test-token-123' };

  try {
    await service.start();
    // 1. Pipeline & adapters endpoints report local-rolling ready
    const pipeRes = await app.inject({ method: 'GET', url: '/api/research/pipeline', headers: authHeaders });
    assert.equal(pipeRes.statusCode, 200);
    assert.equal(pipeRes.json().mode, 'local-rolling');
    assert.equal(pipeRes.json().chronos2.ready, true);
    assert.equal(pipeRes.json().chronos2.versionId, 'chronos2-v1');

    // 2. Create experiment WITHOUT adapterRunDir -> resolves to local-rolling modelSource
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/model-paper/experiments',
      headers: authHeaders,
      payload: { requestId: 'req_local_rolling_01', retrainIntervalHours: 6 },
    });
    assert.equal(createRes.statusCode, 200);
    const created = createRes.json();
    assert.equal(created.experiment.modelSource.pipelineMode, 'local-rolling');
    assert.equal(created.experiment.modelSource.adapterRunId, 'chronos2-v1');

    // Stop initial experiment so scheduler background timer is quiesced before testing pipeline concurrency deterministically
    await new Promise(r => setTimeout(r, 20));
    const stopRes = await app.inject({
      method: 'POST',
      url: `/api/model-paper/experiments/${created.experiment.id}/stop`,
      headers: authHeaders,
      payload: { requestId: 'req_local_stop_01' },
    });
    assert.equal(stopRes.statusCode, 200);

    // 3. Single-flight hourly cycle deduplication + cached reuse
    rankCalls = 0;
    chronosLiveCalls = 0;
    commitCalls = 0;
    const [cycleA, cycleB] = await Promise.all([
      pipeline.runHourlyCycle({ targetHourH, now: nowMs, force: true, commitResearch: true }),
      pipeline.runHourlyCycle({ targetHourH, now: nowMs, force: true, commitResearch: true }),
    ]);
    assert.equal(rankCalls, 1);
    assert.equal(chronosLiveCalls, 1);
    assert.equal(commitCalls, 1);
    assert.equal(cycleA.modelVersions.lgbmVersionId, 'lgbm-v2');
    assert.equal(cycleA.modelVersions.chronosVersionId, 'chronos2-v1');
    assert.equal(cycleB.committedRunId, cycleA.committedRunId);
    const cached = await pipeline.runHourlyCycle({ targetHourH, now: nowMs, commitResearch: true });
    assert.equal(cached.snapshotDir, cycleA.snapshotDir);
    assert.equal(rankCalls, 1);
    const isolatedDir = path.join(tmpDir, 'isolated-snapshot');
    const isolated = await pipeline.runHourlyCycle({
      targetHourH, now: nowMs, snapshotDir: isolatedDir,
      universeSymbols: TEST_UNIVERSE.slice(0, 10), commitResearch: true,
    });
    assert.equal(isolated.snapshotDir, isolatedDir);
    assert.equal(rankCalls, 2);

    // 4. Trigger manual Chronos GPU retrain -> 202, concurrent request -> 409, then promotes chronos2-v2
    holdTrain = true;
    const retrainRes = await app.inject({
      method: 'POST',
      url: '/api/research/pipeline/retrain-chronos',
      headers: authHeaders,
      payload: { retrainIntervalHours: 6 },
    });
    assert.equal(retrainRes.statusCode, 202);
    await new Promise(r => setTimeout(r, 20));
    const busyRes = await app.inject({
      method: 'POST',
      url: '/api/research/pipeline/retrain-chronos',
      headers: authHeaders,
      payload: { retrainIntervalHours: 6 },
    });
    assert.equal(busyRes.statusCode, 409);

    releaseTrain();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(trainCalls, 1);
    const pipeAfter = await app.inject({ method: 'GET', url: '/api/research/pipeline', headers: authHeaders });
    assert.equal(pipeAfter.json().chronos2.versionId, 'chronos2-v2');
  } finally {
    await app.close();
    await service.stop();
    await pipeline.stop();
    runner.close();
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
