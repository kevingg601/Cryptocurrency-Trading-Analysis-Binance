import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ABComparisonCoordinator,
  FourGroupComparisonCoordinator,
  createAIDataSnapshot,
  defaultAutoTradingConfig,
  parseWithInfinity,
} from '@fadachi/core';
import { createDuckDBClient, initDatabase } from '../src/storage/duckdb.ts';
import { StorageWriter } from '../src/storage/writer.ts';
import { LiveHub } from '../src/live/hub.ts';
import { GapDetector } from '../src/gaps/gapDetector.ts';
import { SessionManager } from '../src/gaps/sessions.ts';
import { BinanceStreamManager } from '../src/binance/streams.ts';
import { UniverseManager } from '../src/ingest/universe.ts';
import { CollectorEventsManager } from '../src/events/collectorEvents.ts';
import { AIDataAggregator } from '../src/ai/aiDataAggregator.ts';
import { AICLIRunner } from '../src/ai/cliRunner.ts';
import { OllamaProvider } from '../src/ai/ollamaProvider.ts';
import { OllamaAnalysisRunner } from '../src/ai/ollamaRunner.ts';
import { FourGroupBatchRepository, FourGroupStorageError } from '../src/ai/fourGroupStorage.ts';
import { FourGroupService } from '../src/ai/fourGroupService.ts';
import { AB_SERVICE_GENERATION } from '../src/ai/abOwnership.ts';
import { abStorageTransaction } from '../src/ai/abStorage.ts';
import { createServer } from '../src/api/server.ts';
import { RollingModelPipeline } from '../src/modelPaper/rollingPipeline.ts';
import { TradeBus } from '../src/modelPaper/tradeBus.ts';
import { ModelResearchRunner } from '../src/research/modelResearchRunner.ts';

const HOUR_MS = 3_600_000;
const BASE_H = 1_800_000_000_000 - (1_800_000_000_000 % HOUR_MS);

const UNIVERSE_12 = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'BNBUSDT',
  'SUIUSDT', 'NEARUSDT', 'WLDUSDT', 'ENAUSDT', 'ONEUSDT', 'HOTUSDT',
  'JCTUSDT', 'ZECUSDT', 'HYPEUSDT', '1000PEPEUSDT', 'AIOTUSDT', 'UNIUSDT', 'KOMAUSDT', 'ICNTUSDT',
];

function makeSnapshot(symbol: string, now = Date.now()) {
  const lastOpen = Math.floor(now / 60_000) * 60 - 60;
  const cutoff = (lastOpen + 60) * 1000;
  return createAIDataSnapshot({
    symbol,
    marketType: 'futures',
    cutoffTime: cutoff,
    now: cutoff,
    market: {
      price: 100,
      priceChangePercent: 1.5,
      volume: 1200,
      quoteVolume: 120000,
      high: 102,
      low: 98,
      open: 99,
      priceTimestamp: cutoff,
    },
    klines: Array.from({ length: 25 }, (_, i) => ({
      time: lastOpen - (24 - i) * 60,
      open: 99,
      high: 102,
      low: 98,
      close: 100,
      volume: 40,
    })),
    indicators: { sma20: 99.5, ema20: 99.8, rsi14: 58 },
  });
}

async function withMockOllamaServer(
  handler: (req: http.IncomingMessage, body: any, res: http.ServerResponse) => void,
) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let parsed: any = null;
      if (chunks.length) {
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          parsed = Buffer.concat(chunks).toString('utf8');
        }
      }
      handler(req, parsed, res);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

test('OllamaProvider lists models, analyzes snapshot via /api/chat, rejects URL credentials, and handles timeout/invalid JSON', async (t) => {
  let slowMode = false;
  let invalidJson = false;
  let chatRequest: any;
  const mock = await withMockOllamaServer((req, body, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        models: [
          { name: 'gemma4:e2b', model: 'gemma4:e2b', size: 3_200_000_000 },
          { name: 'qwen3:8b', model: 'qwen3:8b', size: 5_000_000_000 },
        ],
      }));
      return;
    }
    if (req.url === '/api/ps') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        models: [{ name: 'gemma4:e2b', model: 'gemma4:e2b', size: 3_400_000_000, size_vram: 2_800_000_000 }],
      }));
      return;
    }
    if (req.url === '/api/chat') {
      chatRequest = body;
      if (slowMode) {
        const t = setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200);
            res.end('{}');
          }
        }, 2_500);
        t.unref();
        req.on('close', () => clearTimeout(t));
        return;
      }
      if (invalidJson) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: { content: 'not valid json' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        eval_count: 42,
        eval_duration: 120_000_000,
        message: {
          content: JSON.stringify({
            direction: 'LONG',
            confidence: 78,
            reasoning: `Bullish setup on ${body?.model}`,
            bullishEvidence: ['EMA20 above SMA20'],
            bearishEvidence: [],
            risks: ['Macro headline risk'],
          }),
        },
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  t.after(() => mock.close());

  const provider = new OllamaProvider({ baseUrl: mock.url, analyzeTimeoutMs: 1_200 });
  const testRes = await provider.testConnection(mock.url, 'gemma4:e2b');
  assert.equal(testRes.reachable, true);
  assert.equal(testRes.isRemote, false);
  assert.deepEqual(testRes.models, ['gemma4:e2b', 'qwen3:8b']);
  assert.equal(testRes.hasRequestedModel, true);

  await assert.rejects(
    () => provider.testConnection('http://admin:secret@192.168.1.99:11434'),
    /憑證/,
  );

  const snap = makeSnapshot('BTCUSDT');
  const ok = await provider.analyzeSnapshot(snap, 'gemma4:e2b');
  assert.equal(ok.result.direction, 'LONG');
  assert.equal(ok.result.model, 'gemma4:e2b');
  assert.equal(chatRequest.think, false);
  assert.equal(chatRequest.options.num_predict, 512);
  assert.equal(ok.telemetry.evalCount, 42);
  assert.ok((ok.telemetry.modelMemoryMb ?? 0) > 3000);

  invalidJson = true;
  await assert.rejects(() => provider.analyzeSnapshot(snap, 'gemma4:e2b'), /JSON/);

  invalidJson = false;
  slowMode = true;
  await assert.rejects(() => provider.analyzeSnapshot(snap, 'gemma4:e2b', { timeoutMs: 1000 }), /Timeout|abort/i);
});

test('Ollama runner enforces a global concurrency limit and separates spot/futures deduplication', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let active = 0, peak = 0, calls = 0;
  const provider = new OllamaProvider({ fetchImpl: async (url) => {
    if (String(url).endsWith('/api/ps')) return Response.json({ models: [] });
    calls += 1;
    active += 1;
    peak = Math.max(peak, active);
    await gate;
    active -= 1;
    return Response.json({ message: { content: JSON.stringify({ direction: 'LONG', confidence: 70,
      reasoning: 'trend', bullishEvidence: ['momentum'], bearishEvidence: [], risks: [] }) } });
  } });
  const runner = new OllamaAnalysisRunner({ client: { run: async () => {} } as any, provider, maxConcurrency: 2 });
  const aggregator = { buildSnapshot: async (symbol, marketType) => ({ ...makeSnapshot(symbol), marketType }) } as AIDataAggregator;
  const request = (symbols: string[], market: 'spot' | 'futures' = 'futures') =>
    runner.analyzeSymbols({ aggregator, symbols, market, model: 'gemma4:e2b' });
  const jobs = [request(['BTCUSDT', 'ETHUSDT']), request(['SOLUSDT', 'XRPUSDT']),
    request(['BTCUSDT'], 'spot'), request(['BTCUSDT'])];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(peak, 2);
  release();
  const results = await Promise.all(jobs);
  assert.equal(peak, 2);
  assert.equal(calls, 5);
  assert.equal(results[0].results.BTCUSDT.marketType, 'futures');
  assert.equal(results[2].results.BTCUSDT.marketType, 'spot');
  runner.close();
});

test('Ollama retries an incomplete snapshot once and still rejects persistent missing data', async () => {
  let builds = 0;
  let inferenceCalls = 0;
  let recover = true;
  const provider = new OllamaProvider({ fetchImpl: async (url) => {
    if (String(url).endsWith('/api/ps')) return Response.json({ models: [] });
    inferenceCalls++;
    return Response.json({ message: { content: JSON.stringify({ direction: 'LONG', confidence: 70,
      reasoning: 'trend', bullishEvidence: ['momentum'], bearishEvidence: [], risks: [] }) } });
  } });
  const runner = new OllamaAnalysisRunner({ client: { run: async () => {} } as any, provider });
  const aggregator = { buildSnapshot: async (symbol: string) => {
    builds++;
    const snapshot = makeSnapshot(symbol);
    return builds === 1 || !recover ? { ...snapshot, essentialDataValid: false, missingData: ['klines_sufficient'] } : snapshot;
  } } as AIDataAggregator;
  const first = await runner.analyzeSymbols({ aggregator, symbols: ['BTCUSDT'], model: 'gemma4:e2b' });
  assert.equal(builds, 2);
  assert.equal(first.results.BTCUSDT.failed, false);
  assert.equal(inferenceCalls, 1);
  recover = false;
  const second = await runner.analyzeSymbols({ aggregator, symbols: ['ETHUSDT'], model: 'gemma4:e2b' });
  assert.equal(builds, 4);
  assert.equal(second.results.ETHUSDT.degraded, true);
  assert.ok(second.results.ETHUSDT.missingData.includes('klines_sufficient'));
  assert.equal(inferenceCalls, 1);
  runner.close();
});

test('LightGBM starts after minute ten, ignores invalid startup snapshots, and stop awaits manual updates', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fadachi-lgbm-start-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = BASE_H + 35 * 60_000;
  const rankingDir = path.join(root, 'model-live', 'models', 'lgbm');
  fs.mkdirSync(rankingDir, { recursive: true });
  fs.writeFileSync(path.join(rankingDir, 'latest-ranking.json'), JSON.stringify({
    cutoffTime: BASE_H + HOUR_MS, status: 'FAILED',
  }));
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runner = {
    pythonExecutable: process.execPath,
    runExclusive: async (_name, run) => run(),
    invokeWorkerWith: async (_py, _args, payload) => {
      assert.equal(payload.action, 'rolling_update_lgbm_rank');
      calls += 1;
      await gate;
      return { inputMode: 'live', decisionOpenTime: BASE_H - HOUR_MS, cutoffTime: BASE_H,
        generatedAt: now, publishedAt: now, expiresAt: BASE_H + HOUR_MS };
    },
  } as unknown as ModelResearchRunner;
  const pipeline = new RollingModelPipeline({ runner, dataDir: root, workspaceRoot: root,
    chronosPython: process.execPath, clock: { now: () => now,
      setTimeout: () => 1, clearTimeout: () => {} }, runOnStart: true });
  pipeline.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  let stopped = false;
  const stopping = pipeline.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(stopped, true);
  await assert.rejects(() => pipeline.runLightgbmHourlyUpdate({ targetHourH: BASE_H }), /已收盤/);
});

test('Collector routes: Ollama kept separate from Antigravity isolation, Chronos training paused by default, independent LightGBM update works, and 4-group batches are leased/immutable/isolated from AB', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fadachi-4g-'));
  const db = await createDuckDBClient(':memory:');
  await initDatabase(db, path.resolve(import.meta.dirname, '..', 'src', 'storage', 'schema.sql'));

  const writer = new StorageWriter(db);
  const liveHub = new LiveHub();
  const sessionManager = new SessionManager(db, 'futures');
  const gapDetector = new GapDetector(db, 'futures');
  const streamManager = new BinanceStreamManager('futures', [], { onMessage: () => {} });
  const universeManager = new UniverseManager(db, 10);
  const eventsManager = new CollectorEventsManager(db, 'futures');

  let chatCalls = 0;
  const mockOllama = await withMockOllamaServer((req, _body, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'gemma4:e2b' }] }));
      return;
    }
    if (req.url === '/api/ps') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    if (req.url === '/api/chat') {
      chatCalls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        message: {
          content: JSON.stringify({
            direction: 'LONG',
            confidence: 80,
            reasoning: 'Trend alignment',
            bullishEvidence: ['momentum'],
            bearishEvidence: [],
            risks: ['volatility'],
          }),
        },
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // Mocked Antigravity CLI runner explicitly UNVERIFIED
  const cliRunner = new AICLIRunner({
    client: db,
    provider: {
      verifyIsolation: async () => ({ verified: false, reason: 'Antigravity CLI profile 尚未登入' }),
      getModels: async () => [],
      analyzeBatch: async () => { throw new Error('must not run'); },
    },
  });

  const aggregator = new AIDataAggregator({ client: db });
  aggregator.buildSnapshot = async (symbol, _market) => makeSnapshot(symbol, Date.now());

  const ollamaRunner = new OllamaAnalysisRunner({ client: db, defaultBaseUrl: mockOllama.url });

  // Fake ResearchRunner mocking LightGBM independent worker update WITHOUT Chronos
  const dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(path.join(dataDir, 'model-live', 'datasets'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'model-live', 'models', 'lgbm'), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'model-live', 'datasets', 'universe.json'),
    JSON.stringify({ symbols: UNIVERSE_12 }),
    'utf8',
  );

  let lgbmWorkerCalls = 0;
  let chronosWorkerCalled = false;
  const fakeResearchRunner = new ModelResearchRunner({
    dataDir,
    workspaceRoot: tmpDir,
    pythonExecutable: process.execPath,
    workerScript: path.join(tmpDir, 'noop.py'),
    spawnWorker: (() => { throw new Error('unused'); }) as any,
  });
  fakeResearchRunner.invokeWorkerWith = async (_py, _args, payload) => {
    const req = (payload || {}) as Record<string, any>;
    if (req.action === 'rolling_update_lgbm_rank') {
      lgbmWorkerCalls += 1;
      const cutoff = Number(req.targetCutoffTime);
      const doc = {
        snapshotId: `lgbm-${cutoff}-v1`,
        status: 'SUCCESS',
        inputMode: 'live',
        replay: false,
        decisionOpenTime: cutoff - HOUR_MS,
        cutoffTime: cutoff,
        generatedAt: Date.now(),
        publishedAt: Date.now(),
        expiresAt: cutoff + HOUR_MS,
        universeSymbols: UNIVERSE_12,
        eligibleCount: 12,
        insufficientSymbols: [],
        longTop5: UNIVERSE_12.slice(0, 5).map((s, idx) => ({
          rank: idx + 1,
          symbol: s,
          side: 'LONG',
          rankingScore: 0.5 - idx * 0.05,
          longScore: 0.5 - idx * 0.05,
          shortScore: 0,
          longRank: idx + 1,
          shortRank: 10,
          conflict: false,
          closePrice: 100,
          ret1h: 0.01,
          ret4h: 0.02,
          ret24h: 0.05,
          rsi14: 55,
        })),
        shortTop5: UNIVERSE_12.slice(5, 10).map((s, idx) => ({
          rank: idx + 1,
          symbol: s,
          side: 'SHORT',
          rankingScore: 0.4 - idx * 0.05,
          longScore: 0,
          shortScore: 0.4 - idx * 0.05,
          longRank: 10,
          shortRank: idx + 1,
          conflict: false,
          closePrice: 100,
          ret1h: -0.01,
          ret4h: -0.02,
          ret24h: -0.05,
          rsi14: 45,
        })),
        allRankings: [],
        conflictSymbols: [],
        versionId: 'lgbm-v1',
        longSha256: 'abc',
        shortSha256: 'def',
        trainedAt: cutoff,
        lightgbm: { versionId: 'lgbm-v1', trainedAt: cutoff, cutoffTime: cutoff, longSha256: 'abc', shortSha256: 'def' },
        trainAudit: { startedAt: cutoff + 100, finishedAt: cutoff + 500, elapsedMs: 400, cpuPercent: 18.5, rssMb: 128, retrained: true },
      };
      fs.writeFileSync(
        path.join(dataDir, 'model-live', 'models', 'lgbm', 'latest-ranking.json'),
        JSON.stringify(doc),
        'utf8',
      );
      return doc;
    }
    chronosWorkerCalled = true;
    throw new Error('Chronos worker must not be invoked during paused LightGBM update');
  };

  const rollingPipeline = new RollingModelPipeline({
    runner: fakeResearchRunner,
    dataDir,
    workspaceRoot: tmpDir,
    chronosPython: process.execPath,
    autoHourlyEnabled: false,
    runOnStart: false,
    // default chronosTrainingPaused === true
  });
  fakeResearchRunner.attachRollingPipeline(rollingPipeline);

  const rules = Object.fromEntries(UNIVERSE_12.map(s => [s, { stepSize: 0.001, minQty: 0.001, maxQty: 1000, minNotional: 5 }]));
  let simNow = Date.now();
  const tradeBus = new TradeBus();
  tradeBus.emitStatus({ status: 'connected', lastValidAt: simNow, totalMessages: 1, activeSockets: 1 });
  const fourGroupService = new FourGroupService({
    client: db,
    tradeBus,
    rollingPipeline,
    aiAggregator: aggregator,
    ollamaRunner,
    fetchSymbolRules: async () => rules,
    fetchFundingHistory: async () => [],
    clock: () => simNow,
    heartbeatMs: 100,
    saveThrottleMs: 150,
    lgbmPollIntervalMs: 10_000,
    ollamaRefreshIntervalMs: 600_000,
    fundingIntervalMs: 60_000,
  });
  await fourGroupService.start();

  const app = createServer({
    client: db,
    writer,
    liveHub,
    gapDetector,
    sessionManager,
    streamManager,
    universeManager,
    eventsManager,
    dataDir,
    token: 'test-4g',
    aiAggregator: aggregator,
    cliRunner,
    ollamaRunner,
    researchRunner: fakeResearchRunner,
    tradeBus,
    fourGroupService,
    rollingPipeline,
  });

  t.after(async () => {
    await Promise.allSettled([
      fourGroupService.stop(),
      Promise.resolve().then(() => ollamaRunner.close()),
      Promise.resolve().then(() => aggregator.derivatives.stop()),
      rollingPipeline.stop(),
      app.close(),
      Promise.resolve().then(() => liveHub.close()),
      writer.stop(),
      Promise.resolve().then(() => fakeResearchRunner.close()),
      mockOllama.close(),
    ]);
    await db.close().catch(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const headers = { authorization: 'Bearer test-4g', 'content-type': 'application/json' };

  // 1. Ollama reachable does NOT affect Antigravity CLI isolation check
  const ollamaStatusRes = await app.inject({
    method: 'GET',
    url: `/api/ollama/status?url=${encodeURIComponent(mockOllama.url)}`,
    headers: { authorization: 'Bearer test-4g' },
  });
  assert.equal(ollamaStatusRes.statusCode, 200);
  assert.equal(ollamaStatusRes.json().reachable, true);

  const aiStatusRes = await app.inject({
    method: 'GET',
    url: '/api/ai/status?market=futures',
    headers: { authorization: 'Bearer test-4g' },
  });
  assert.equal(aiStatusRes.statusCode, 200);
  assert.equal(aiStatusRes.json().isolationVerified, false);

  // 2. Credential-bearing Ollama URL rejected before outbound request
  const badUrlRes = await app.inject({
    method: 'POST',
    url: '/api/ollama/test',
    headers,
    payload: { url: 'http://user:pw@127.0.0.1:11434' },
  });
  assert.equal(badUrlRes.statusCode, 400);

  // 3. Analyze symbols with coalesced deduplication via /api/ollama/analyze
  const analyzeRes = await app.inject({
    method: 'POST',
    url: '/api/ollama/analyze',
    headers,
    payload: {
      url: mockOllama.url,
      model: 'gemma4:e2b',
      symbols: ['BTCUSDT', 'ETHUSDT'],
      market: 'futures',
    },
  });
  assert.equal(analyzeRes.statusCode, 200);
  const analyzeJson = analyzeRes.json();
  assert.equal(chatCalls, 2);
  assert.equal(analyzeJson.results.BTCUSDT.direction, 'LONG');
  assert.equal(analyzeJson.results.ETHUSDT.model, 'gemma4:e2b');

  // 4. Chronos manual retrain endpoint rejects clearly as paused; LightGBM hourly update succeeds without Chronos
  const pausedRetrainRes = await app.inject({
    method: 'POST',
    url: '/api/research/pipeline/retrain-chronos',
    headers,
    payload: { retrainIntervalHours: 6 },
  });
  assert.equal(pausedRetrainRes.statusCode, 409);
  assert.equal(pausedRetrainRes.json().paused, true);
  assert.match(pausedRetrainRes.json().error, /暫停/);

  const lgbmUpdRes = await app.inject({
    method: 'POST',
    url: '/api/research/lgbm/update',
    headers,
    payload: {},
  });
  assert.equal(lgbmUpdRes.statusCode, 200);
  assert.equal(lgbmWorkerCalls, 1);
  assert.equal(chronosWorkerCalled, false);

  const lgbmLatestRes = await app.inject({
    method: 'GET',
    url: '/api/research/lgbm/latest',
    headers: { authorization: 'Bearer test-4g' },
  });
  assert.equal(lgbmLatestRes.statusCode, 200);
  assert.equal(lgbmLatestRes.json().snapshot.versionId, 'lgbm-v1');
  assert.equal(lgbmLatestRes.json().trainingPaused, true);

  // 5. Legacy browser lease endpoints return 410 Gone
  for (const req of [
    { method: 'POST' as const, url: '/api/four-group/batches/legacy-1/claim', payload: {} },
    { method: 'POST' as const, url: '/api/four-group/batches/legacy-1/lease', payload: { ownerToken: 'x', generation: 'g' } },
    { method: 'PUT' as const, url: '/api/four-group/batches', payload: { id: 'legacy-1' } },
    { method: 'POST' as const, url: '/api/four-group/batches/reconcile', payload: { market: 'futures' } },
  ]) {
    const depRes = await app.inject({ ...req, headers });
    assert.equal(depRes.statusCode, 410, `${req.method} ${req.url} should return 410 Gone`);
    assert.equal(depRes.json().code, 'ENDPOINT_DEPRECATED');
  }

  // 6. Backend FourGroupService status + start + double-start 409 + TradeBus signals + LightGBM rotation + control routes
  const status0 = await app.inject({
    method: 'GET',
    url: '/api/four-group/status',
    headers: { authorization: 'Bearer test-4g' },
  });
  assert.equal(status0.statusCode, 200);
  const s0 = status0.json();
  assert.equal(s0.rulesReady, true);
  assert.equal(s0.streamHealthy, true);
  assert.equal(s0.engineRuntime.runningInCollector, true);
  assert.equal(s0.lgbmState.snapshot.versionId, 'lgbm-v1');

  // Reject out-of-universe coin selection on /start
  const badStartRes = await app.inject({
    method: 'POST',
    url: '/api/four-group/batches/start',
    headers,
    payload: {
      config: defaultAutoTradingConfig('futures'),
      coinMode: 'manual',
      selectedCoins: ['OUTSIDEUSDT'],
      ollamaUrl: mockOllama.url,
      model: 'gemma4:e2b',
    },
  });
  assert.equal(badStartRes.statusCode, 400);

  // Start backend batch in auto-lgbm mode without any browser lease
  const startRes = await app.inject({
    method: 'POST',
    url: '/api/four-group/batches/start',
    headers,
    payload: {
      config: { ...defaultAutoTradingConfig('futures'), latencyMs: 250 },
      coinMode: 'auto-lgbm',
      ollamaUrl: mockOllama.url,
      model: 'gemma4:e2b',
      signalSettings: { priceMovePercent: 1.5, priceWindowMs: 5_000, whaleMultiplier: 10 },
    },
  });
  assert.equal(startRes.statusCode, 200);
  const startedStatus = parseWithInfinity(startRes.body);
  const batchId = startedStatus.snapshot.id;
  assert.equal(startedStatus.snapshot.status, 'RUNNING');
  assert.equal(startedStatus.snapshot.locked.coinMode, 'auto-lgbm');
  assert.equal(startedStatus.snapshot.coinRotations.length, 1);

  // Concurrent second start is rejected with 409
  const doubleStartRes = await app.inject({
    method: 'POST',
    url: '/api/four-group/batches/start',
    headers,
    payload: {
      config: defaultAutoTradingConfig('futures'),
      coinMode: 'auto-lgbm',
      ollamaUrl: mockOllama.url,
      model: 'gemma4:e2b',
    },
  });
  assert.equal(doubleStartRes.statusCode, 409);

  // Wait briefly for background Ollama per-symbol loop to analyze at least BTCUSDT
  for (let i = 0; i < 30; i += 1) {
    const st = (await app.inject({ method: 'GET', url: '/api/four-group/status', headers: { authorization: 'Bearer test-4g' } })).json();
    if (st.ollama.analyses?.BTCUSDT) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }

  // Feed TradeBus futures aggTrades -> pump + pullback confirmation -> simulated fills & decisions in DuckDB
  const feedTrade = (aggId: number, price: number, dtMs: number) => {
    simNow += dtMs;
    tradeBus.emitStatus({ status: 'connected', lastValidAt: simNow, totalMessages: aggId, activeSockets: 1 });
    tradeBus.emitTrade({
      symbol: 'BTCUSDT',
      price,
      qty: 1,
      aggId,
      tradeTime: simNow,
      receivedAt: simNow,
      side: 'buy',
      lastTradeId: aggId,
    });
  };
  feedTrade(101, 100.0, 200);
  feedTrade(102, 102.0, 500);   // +2% pump triggers FollowPlan (impulse = 2.0, zone = 101.0..101.5)
  feedTrade(103, 101.2, 500);   // pullback into zone -> WAIT_CONFIRMATION (extreme = 101.2)
  feedTrade(104, 101.45, 500);  // recovery +0.25 >= 0.1 * impulse -> starts 3s confirmation timer
  feedTrade(105, 101.46, 3_100); // hold >= 3s -> follow-confirmed
  feedTrade(106, 101.46, 350);  // past 250ms latency -> fills ENTRY across A/B/C

  await new Promise(resolve => setTimeout(resolve, 220));
  const afterTradesStatus = parseWithInfinity((await app.inject({
    method: 'GET',
    url: '/api/four-group/status',
    headers: { authorization: 'Bearer test-4g' },
  })).body);
  assert.ok(afterTradesStatus.snapshot.decisions.length >= 1, 'TradeBus aggTrades should drive signal decisions');
  assert.ok(afterTradesStatus.snapshot.accounts.A.fills.length >= 1, 'Group A should simulate entry fill');
  assert.ok(afterTradesStatus.recentNotifications.length >= 1, 'Backend notifications should be recorded');

  // Verify decisions persisted in DuckDB four_group_decisions
  const decRows = await db.all('SELECT id FROM four_group_decisions WHERE batch_id = ?;', batchId);
  assert.ok(decRows.length >= 1);

  // Legacy /api/ab/batches stays completely empty / unaffected
  const abCoord = new ABComparisonCoordinator('futures');
  abCoord.setRules(rules);
  assert.equal((await app.inject({ method: 'GET', url: '/api/ab/batches?market=futures', headers: { authorization: 'Bearer test-4g' } })).json().length, 0);

  // CSV export returns 4 BATCH_METADATA rows cleanly
  const csvRes = await app.inject({
    method: 'GET',
    url: `/api/four-group/batches/${encodeURIComponent(batchId)}/export.csv`,
    headers: { authorization: 'Bearer test-4g' },
  });
  assert.equal(csvRes.statusCode, 200);
  assert.equal(csvRes.body.split('\n').filter(l => l.includes(',BATCH_METADATA,')).length, 4);

  // LightGBM hourly snapshot update rotates activeCoins without any browser connected
  const snap0 = lgbmLatestRes.json().snapshot;
  const rotatedSnap = structuredClone(snap0);
  rotatedSnap.cutoffTime = snap0.cutoffTime + HOUR_MS;
  rotatedSnap.snapshotId = `rotated-${rotatedSnap.cutoffTime}`;
  rotatedSnap.longTop5 = [
    { ...rotatedSnap.longTop5[0], symbol: 'ZECUSDT', longRank: 1, rank: 1 },
    ...rotatedSnap.longTop5.slice(1),
  ];
  fs.writeFileSync(
    path.join(dataDir, 'model-live', 'models', 'lgbm', 'latest-ranking.json'),
    JSON.stringify(rotatedSnap),
    'utf8',
  );
  // Force rollingPipeline to reload snapshot from disk via getLatestLightgbmRanking or trigger update
  (rollingPipeline as any).latestLgbmSnapshot = rotatedSnap;
  fourGroupService.syncLgbmState();
  await new Promise(resolve => setTimeout(resolve, 100));
  const rotatedStatus = (await app.inject({
    method: 'GET',
    url: '/api/four-group/status',
    headers: { authorization: 'Bearer test-4g' },
  })).json();
  assert.equal(rotatedStatus.snapshot.coinRotations.length, 2);
  assert.ok(rotatedStatus.snapshot.activeCoins.includes('ZECUSDT'));

  // Control routes: pause -> resume -> close-all (sets EXIT order with Infinity expiresAt) -> drain
  const pauseRes = await app.inject({
    method: 'POST',
    url: `/api/four-group/batches/${encodeURIComponent(batchId)}/pause`,
    headers,
    payload: {},
  });
  assert.equal(pauseRes.statusCode, 200);
  assert.equal(pauseRes.json().snapshot.status, 'PAUSED');

  const resumeRes = await app.inject({
    method: 'POST',
    url: `/api/four-group/batches/${encodeURIComponent(batchId)}/resume`,
    headers,
    payload: {},
  });
  assert.equal(resumeRes.statusCode, 200);
  assert.equal(resumeRes.json().snapshot.status, 'RUNNING');

  const closeAllRes = await app.inject({
    method: 'POST',
    url: `/api/four-group/batches/${encodeURIComponent(batchId)}/close-all`,
    headers,
    payload: {},
  });
  assert.equal(closeAllRes.statusCode, 200);
  const closeAllStatus = parseWithInfinity(closeAllRes.body);
  assert.equal(closeAllStatus.snapshot.status, 'DRAINING');
  assert.equal(closeAllStatus.snapshot.accounts.A.orders[0]?.expiresAt, Infinity);

  // Reload from DuckDB GET /api/four-group/batches/:id preserves Infinity on EXIT orders
  const getRes = await app.inject({
    method: 'GET',
    url: `/api/four-group/batches/${encodeURIComponent(batchId)}`,
    headers: { authorization: 'Bearer test-4g' },
  });
  assert.equal(getRes.statusCode, 200);
  const loaded = parseWithInfinity(getRes.body);
  assert.equal(loaded.batch.accounts.A.orders[0].expiresAt, Infinity);

  // Graceful stop interrupts active batch & flushes to DuckDB
  await fourGroupService.stop('測試關機收尾');
  const afterStop = parseWithInfinity((await app.inject({
    method: 'GET',
    url: `/api/four-group/batches/${encodeURIComponent(batchId)}`,
    headers: { authorization: 'Bearer test-4g' },
  })).body);
  assert.equal(afterStop.batch.status, 'INTERRUPTED');
  assert.equal(afterStop.batch.accounts.A.status, 'INTERRUPTED');
  assert.equal(afterStop.batch.accounts.A.positions[0].incomplete, true);
});

test('FourGroupService Option A startup recovery reconciles orphaned active batch to INTERRUPTED and preserves open position price', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fadachi-4g-recover-'));
  const db = await createDuckDBClient(':memory:');
  await initDatabase(db, path.resolve(import.meta.dirname, '..', 'src', 'storage', 'schema.sql'));
  t.after(async () => {
    await db.close().catch(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const now = BASE_H + 10_000;
  const rules = Object.fromEntries(UNIVERSE_12.map(s => [s, { stepSize: 0.001, minQty: 0.001, maxQty: 1000, minNotional: 5 }]));
  const coord = new FourGroupComparisonCoordinator('futures');
  coord.setRules(rules);
  coord.setStreamHealthy(true, now);
  coord.start({
    config: defaultAutoTradingConfig('futures'),
    selectedCoins: ['BTCUSDT'],
    universeSymbols: UNIVERSE_12,
    model: 'gemma4:e2b',
    now,
  });
  const orphan = coord.snapshot();
  orphan.revision += 1;
  orphan.accounts.A.positions.push({
    id: 'pos-orphan-1',
    planId: 'p-orphan',
    symbol: 'BTCUSDT',
    side: 'LONG',
    entryPrice: 100,
    quantity: 1,
    remainingQuantity: 1,
    stopLoss: 98,
    takeProfit1: 103,
    takeProfit2: 104,
    openedAt: now + 100,
    currentPrice: 101.5,
    entryFee: 0.05,
    realizedPnl: 0,
    tp1Hit: false,
    lastReceivedAt: now + 5_000,
    exitNotional: 0,
    exitFees: 0,
    funding: 0,
  });

  const repo = new FourGroupBatchRepository(db, () => now + 6_000);
  await repo.saveSystemBatch(orphan);

  const tradeBus = new TradeBus();
  const fakeResearchRunner = new ModelResearchRunner({
    dataDir: tmpDir,
    workspaceRoot: tmpDir,
    pythonExecutable: process.execPath,
    workerScript: path.join(tmpDir, 'noop.py'),
    spawnWorker: (() => { throw new Error('unused'); }) as any,
  });
  const rollingPipeline = new RollingModelPipeline({
    runner: fakeResearchRunner,
    dataDir: tmpDir,
    workspaceRoot: tmpDir,
    chronosPython: process.execPath,
    autoHourlyEnabled: false,
    runOnStart: false,
  });
  const aggregator = new AIDataAggregator({ client: db });
  const ollamaRunner = new OllamaAnalysisRunner({ client: db });

  const service = new FourGroupService({
    client: db,
    tradeBus,
    rollingPipeline,
    aiAggregator: aggregator,
    ollamaRunner,
    fetchSymbolRules: async () => rules,
    fetchFundingHistory: async () => [],
    clock: () => now + 20_000,
  });
  t.after(async () => {
    await service.stop();
    ollamaRunner.close();
    aggregator.derivatives.stop();
    await rollingPipeline.stop();
    fakeResearchRunner.close();
  });

  await service.start();
  const row = await service.repo.getById(orphan.id);
  assert.ok(row);
  assert.equal(row.batch.status, 'INTERRUPTED');
  assert.equal(row.batch.accounts.A.status, 'INTERRUPTED');
  assert.equal(row.batch.accounts.A.positions.length, 1);
  assert.equal(row.batch.accounts.A.positions[0].incomplete, true);
  assert.equal(row.batch.accounts.A.positions[0].currentPrice, 101.5);
  assert.equal(service.getStatus().snapshot.status, 'IDLE');
});

test('FourGroupBatchRepository resolves clock inside tx queue, keeps expiresAt monotonic, and writes decisions incrementally', async (t) => {
  const db = await createDuckDBClient(':memory:');
  await initDatabase(db, path.resolve(import.meta.dirname, '..', 'src', 'storage', 'schema.sql'));
  t.after(() => db.close().catch(() => {}));

  let now = 1_800_000_000_000;
  const repo = new FourGroupBatchRepository(db, () => now);
  const tx = abStorageTransaction(db);

  const coord = new FourGroupComparisonCoordinator('futures');
  const rules = Object.fromEntries(UNIVERSE_12.map(s => [s, { stepSize: 0.001, minQty: 0.001, maxQty: 1000, minNotional: 5 }]));
  coord.setRules(rules);
  coord.setStreamHealthy(true, now);
  coord.start({
    config: defaultAutoTradingConfig('futures'),
    selectedCoins: ['BTCUSDT', 'ETHUSDT'],
    universeSymbols: UNIVERSE_12,
    model: 'gemma4:e2b',
    now,
  });

  // Queue a slow transaction that advances `now` by 6s BEFORE `claim` acquires the DB tx lock
  let releaseBlocker!: () => void;
  const blocker = new Promise<void>(resolve => { releaseBlocker = resolve; });
  const blockingTx = tx(async () => {
    await blocker;
    now += 6_000;
  });
  const claimPromise = repo.claim(coord.snapshot().id);
  await new Promise(resolve => setTimeout(resolve, 20));
  releaseBlocker();
  await blockingTx;
  const claimed = await claimPromise;

  assert.equal(claimed.owner, true);
  assert.equal(claimed.serverTime, now);
  assert.equal(claimed.expiresAt, now + 15_000);
  assert.equal(claimed.queueWaitMs, 6_000);

  // Monotonicity: even if clock is unchanged/smaller check, renewLease never shrinks expiresAt
  const renewSameTime = await repo.renewLease(coord.snapshot().id, claimed.ownerToken!, AB_SERVICE_GENERATION, now - 2_000);
  assert.equal(renewSameTime.expiresAt, claimed.expiresAt);

  // Incremental decision write check
  const batch1 = coord.snapshot();
  batch1.decisions.push({
    id: 'dec-1', planId: 'plan-1', signalSource: 'follow-rule', symbol: 'BTCUSDT', side: 'LONG',
    confirmedAt: now + 100, receivedAt: now + 100,
    lgbm: { allowed: true, reason: 'ALLOWED', explanation: 'ok', snapshotId: 's1', cutoffTime: BASE_H, publishedAt: BASE_H, generatedAt: BASE_H, versionId: 'v1', longSha256: 'l', shortSha256: 's', sideRank: 1, longRank: 1, shortRank: 10, sideScore: 0.5, conflict: false },
    ai: { allowed: true, reason: 'ALLOWED', explanation: 'ok', analysisId: 'a1', snapshotId: 'sa1', snapshotHash: 'h', snapshotCreatedAt: now, generatedAt: now, availableAt: now, expiresAt: now + 60_000, model: 'gemma4:e2b', promptVersion: 'prompt-v1', ruleVersion: 'rule-v1', direction: 'LONG', confidence: 80, degraded: false, missingData: [] },
    groups: { A: { allowed: true, reason: 'OK', explanation: 'ok' }, B: { allowed: true, reason: 'OK', explanation: 'ok' }, C: { allowed: true, reason: 'OK', explanation: 'ok' }, D: { allowed: false, reason: 'INDEPENDENT_STRATEGY', explanation: 'skip' } },
  });
  batch1.revision += 1;
  const s1 = await repo.save({ id: batch1.id, market: 'futures', status: batch1.status, revision: batch1.revision, batch: batch1, ownerToken: claimed.ownerToken!, generation: AB_SERVICE_GENERATION });
  assert.equal(s1.writtenDecisions, 1);

  const batch2 = structuredClone(batch1);
  batch2.decisions.push({ ...structuredClone(batch1.decisions[0]), id: 'dec-2', planId: 'plan-2', symbol: 'ETHUSDT' });
  batch2.revision += 1;
  const s2 = await repo.save({ id: batch2.id, market: 'futures', status: batch2.status, revision: batch2.revision, batch: batch2, ownerToken: claimed.ownerToken!, generation: AB_SERVICE_GENERATION });
  assert.equal(s2.writtenDecisions, 1);

  const decRows = await db.all('SELECT id FROM four_group_decisions WHERE batch_id = ?;', batch2.id);
  assert.equal(decRows.length, 2);

  await assert.rejects(
    () => repo.renewLease(batch2.id, claimed.ownerToken!, AB_SERVICE_GENERATION, s2.expiresAt + 1),
    err => err instanceof FourGroupStorageError && err.code === 'LEASE_EXPIRED',
  );

  // saveSystemBatch enforces locked config, revision monotonicity, and append-only decisions
  const staleRev = structuredClone(batch2);
  staleRev.revision -= 1;
  await assert.rejects(
    () => repo.saveSystemBatch(staleRev),
    err => err instanceof FourGroupStorageError && err.code === 'REVISION_CONFLICT',
  );
  const tamperedModel = structuredClone(batch2);
  tamperedModel.revision += 1;
  tamperedModel.locked.model = 'other-model';
  await assert.rejects(
    () => repo.saveSystemBatch(tamperedModel),
    err => err instanceof FourGroupStorageError && err.code === 'LOCKED_IMMUTABLE',
  );
  const tamperedDecision = structuredClone(batch2);
  tamperedDecision.revision += 1;
  tamperedDecision.decisions[0].symbol = 'SOLUSDT';
  await assert.rejects(
    () => repo.saveSystemBatch(tamperedDecision),
    err => err instanceof FourGroupStorageError && err.code === 'DECISION_IMMUTABLE',
  );
});

test('FourGroupService clears analyzingOllama on closeAll, survives background save errors without unhandled rejection, and keeps stop idempotent', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fadachi-4g-resilience-'));
  const db = await createDuckDBClient(':memory:');
  await initDatabase(db, path.resolve(import.meta.dirname, '..', 'src', 'storage', 'schema.sql'));

  const dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(path.join(dataDir, 'model-live', 'datasets'), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'model-live', 'datasets', 'universe.json'),
    JSON.stringify({ symbols: UNIVERSE_12 }),
    'utf8',
  );

  let releaseOllama!: () => void;
  const ollamaGate = new Promise<void>(resolve => { releaseOllama = resolve; });
  const provider = new OllamaProvider({
    fetchImpl: async (url) => {
      if (String(url).endsWith('/api/ps')) return Response.json({ models: [] });
      await ollamaGate;
      return Response.json({
        message: {
          content: JSON.stringify({
            direction: 'LONG',
            confidence: 75,
            reasoning: 'ok',
            bullishEvidence: ['trend'],
            bearishEvidence: [],
            risks: [],
          }),
        },
      });
    },
  });
  const ollamaRunner = new OllamaAnalysisRunner({ client: db, provider });
  const aggregator = new AIDataAggregator({ client: db });
  aggregator.buildSnapshot = async (symbol) => makeSnapshot(symbol, Date.now());

  const fakeResearchRunner = new ModelResearchRunner({
    dataDir,
    workspaceRoot: tmpDir,
    pythonExecutable: process.execPath,
    workerScript: path.join(tmpDir, 'noop.py'),
    spawnWorker: (() => { throw new Error('unused'); }) as any,
  });
  const rollingPipeline = new RollingModelPipeline({
    runner: fakeResearchRunner,
    dataDir,
    workspaceRoot: tmpDir,
    chronosPython: process.execPath,
    autoHourlyEnabled: false,
    runOnStart: false,
  });

  const rules = Object.fromEntries(UNIVERSE_12.map(s => [s, { stepSize: 0.001, minQty: 0.001, maxQty: 1000, minNotional: 5 }]));
  let simNow = Date.now();
  const tradeBus = new TradeBus();
  tradeBus.emitStatus({ status: 'connected', lastValidAt: simNow, totalMessages: 1, activeSockets: 1 });

  const service = new FourGroupService({
    client: db,
    tradeBus,
    rollingPipeline,
    aiAggregator: aggregator,
    ollamaRunner,
    fetchSymbolRules: async () => rules,
    fetchFundingHistory: async () => [],
    clock: () => simNow,
    heartbeatMs: 50,
    saveThrottleMs: 100,
    lgbmPollIntervalMs: 60_000,
    ollamaRefreshIntervalMs: 600_000,
    fundingIntervalMs: 60_000,
  });

  t.after(async () => {
    releaseOllama();
    await service.stop().catch(() => {});
    ollamaRunner.close();
    aggregator.derivatives.stop();
    await rollingPipeline.stop();
    fakeResearchRunner.close();
    await db.close().catch(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await service.start();
  const st1 = await service.startBatch({
    config: defaultAutoTradingConfig('futures'),
    coinMode: 'manual',
    selectedCoins: ['BTCUSDT'],
    model: 'gemma4:e2b',
  });
  assert.equal(st1.snapshot.status, 'RUNNING');

  // Wait a microtask so background refreshOllama enters analyzeSymbols and sets analyzingOllama=true
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(service.getStatus().ollama.analyzing, true);

  // closeAllBatch must immediately reset analyzingOllama=false even if in-flight Ollama resolves afterwards
  const closedSt = await service.closeAllBatch(st1.snapshot.id);
  assert.equal(closedSt.ollama.analyzing, false);
  assert.equal(closedSt.ollama.progress, null);
  releaseOllama();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(service.getStatus().ollama.analyzing, false);

  // Start a second batch and test background save error handling + flushPendingSaves surfacing
  const st2 = await service.startBatch({
    config: defaultAutoTradingConfig('futures'),
    coinMode: 'manual',
    selectedCoins: ['BTCUSDT'],
    model: 'gemma4:e2b',
  });
  assert.equal(st2.snapshot.status, 'RUNNING');

  let failSave = true;
  const origSave = service.repo.saveSystemBatch.bind(service.repo);
  service.repo.saveSystemBatch = async (batch, opts) => {
    if (failSave) throw new Error('Simulated DuckDB write failure');
    return origSave(batch, opts);
  };

  let unhandled = false;
  const onUnhandled = () => { unhandled = true; };
  process.on('unhandledRejection', onUnhandled);
  try {
    // Trigger urgent background save via stream disconnect >5s heartbeat interrupt while DB save fails
    tradeBus.emitStatus({ status: 'disconnected', lastValidAt: simNow, totalMessages: 1, activeSockets: 0 });
    simNow += 6_000;
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(unhandled, false, 'background save failure must not cause unhandledRejection');
    assert.equal(service.getStatus().engineRuntime.error, 'Simulated DuckDB write failure');

    // Failing stop() surfaces the storage error instead of swallowing it
    await assert.rejects(() => service.stop('test-fail'), /Simulated DuckDB write failure/);

    // Once DB recovers, idempotent stop() finishes cleanly and persists the interrupted batch
    failSave = false;
    await service.stop();
    await service.stop();
    const persisted2 = await service.repo.getById(st2.snapshot.id);
    assert.equal(persisted2?.status, 'INTERRUPTED');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
