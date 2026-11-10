import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createDuckDBClient, initDatabase } from '../src/storage/duckdb.ts';
import { StorageWriter } from '../src/storage/writer.ts';
import { LiveHub } from '../src/live/hub.ts';
import { GapDetector } from '../src/gaps/gapDetector.ts';
import { SessionManager } from '../src/gaps/sessions.ts';
import { BinanceStreamManager } from '../src/binance/streams.ts';
import { UniverseManager } from '../src/ingest/universe.ts';
import { CollectorEventsManager } from '../src/events/collectorEvents.ts';
import { createServer } from '../src/api/server.ts';
import { ModelResearchRunner } from '../src/research/modelResearchRunner.ts';
import type { ModelResearchRunResult } from '@fadachi/core';

function createFakeWorkerProcess(
  onInput: (line: string, proc: {
    stdout: PassThrough;
    stderr: PassThrough;
    emitClose: (code: number | null) => void;
    emitError: (err: Error) => void;
  }) => void,
  killDelayMs = 0,
): ChildProcessWithoutNullStreams {
  const emitter = new EventEmitter() as any;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  emitter.stdin = stdin;
  emitter.stdout = stdout;
  emitter.stderr = stderr;
  emitter.pid = 99999;
  emitter.exitCode = null;
  emitter.kill = () => {
    const finish = () => { emitter.exitCode = 1; emitter.emit('close', 1); };
    if (killDelayMs) setTimeout(finish, killDelayMs);
    else finish();
    return true;
  };

  let buf = '';
  stdin.on('data', (chunk) => {
    buf += chunk.toString('utf8');
  });
  stdin.on('finish', () => {
    onInput(buf.trim(), {
      stdout,
      stderr,
      emitClose: (code) => {
        emitter.exitCode = code;
        stdout.end();
        stderr.end();
        emitter.emit('close', code);
      },
      emitError: (err) => {
        emitter.emit('error', err);
      },
    });
  });

  return emitter as ChildProcessWithoutNullStreams;
}

function buildMockRunResult(runId: string, cutoffTime: number, expiresAt: number): ModelResearchRunResult {
  return {
    runId,
    status: 'SUCCESS',
    market: 'futures',
    kronosModel: 'small',
    decisionOpenTime: cutoffTime - 3_600_000,
    cutoffTime,
    expiresAt,
    generatedAt: cutoffTime + 5_000,
    rankings: {
      longTop5: [
        {
          rank: 1,
          symbol: 'BTCUSDT',
          side: 'LONG',
          rankingScore: 1.42,
          longScore: 1.42,
          shortScore: -0.5,
          longRank: 1,
          shortRank: 12,
          conflict: false,
          closePrice: 92000,
          ret1h: 0.005,
          ret4h: 0.012,
          ret24h: 0.031,
          rsi14: 61.2,
        },
      ],
      shortTop5: [
        {
          rank: 1,
          symbol: 'SOLUSDT',
          side: 'SHORT',
          rankingScore: 1.18,
          longScore: -0.8,
          shortScore: 1.18,
          longRank: 15,
          shortRank: 1,
          conflict: false,
          closePrice: 180,
          ret1h: -0.006,
          ret4h: -0.019,
          ret24h: -0.042,
          rsi14: 38.4,
        },
      ],
      allRankings: [],
      conflictSymbols: [],
    },
    forecasts: {
      BTCUSDT: {
        symbol: 'BTCUSDT',
        modelKey: 'small',
        repoId: 'NeoQuasar/Kronos-small',
        revision: 'rev-123456',
        cutoffTime,
        lastOpenTime: cutoffTime - 3_600_000,
        lastClosePrice: 92000,
        predictedClose4h: 92850,
        predictedReturn4h: 0.009239,
        elapsedMs: 210,
        peakVramAllocatedMb: 420.5,
        peakVramReservedMb: 512.0,
        inferenceConfig: {
          lookback: 256,
          pred_len: 4,
          max_context: 512,
          batch_size: 1,
          sample_count: 5,
          seed: 42,
          temperature: 1.0,
          top_k: 0,
          top_p: 0.9,
          clip: 5.0,
        },
        historicalCandles: [],
        predictedCandles: [
          {
            step: 1,
            openTime: cutoffTime,
            closeTime: cutoffTime + 3_599_999,
            time: Math.floor(cutoffTime / 1000),
            open: 92000,
            high: 92400,
            low: 91900,
            close: 92250,
            volume: 1200,
            sampleDispersion: {
              closeMin: 91950,
              closeMax: 92500,
              closeStd: 180,
              highMax: 92600,
              lowMin: 91800,
              sampleCloses: [91950, 92100, 92250, 92450, 92500],
              sampleCount: 5,
              label: '抽樣離散程度（5 次抽樣範圍，非校準信賴區間）',
            },
          },
        ],
        dispersionDisclaimer: '抽樣範圍僅代表 5 次抽樣之離散程度，不得解釋為校準信賴區間。',
      },
    },
    warnings: [],
  };
}

test('ModelResearchRunner & Collector API: normal run, concurrent 409, invalid JSON, timeout, OOM, missing model, and expiry', async (t) => {
  const workspaceRoot = path.resolve(import.meta.dirname, '..', '..', '..');
  const tmpBase = path.join(workspaceRoot, 'artifacts', 'review-tmp');
  fs.mkdirSync(tmpBase, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(tmpBase, 'research-api-test-'));

  const dbPath = path.join(tmpDir, 'test.duckdb');
  const client = await createDuckDBClient(dbPath);
  const schemaPath = path.resolve(import.meta.dirname, '..', 'src', 'storage', 'schema.sql');
  await initDatabase(client, schemaPath);

  let workerMode: 'normal' | 'slow_hang' | 'invalid_json' | 'oom' | 'missing_model' | 'invalid_result' | 'duplicate_event' | 'insufficient' | 'utf8' = 'normal';

  const researchRunner = new ModelResearchRunner({
    dataDir: tmpDir,
    workspaceRoot,
    jobTimeoutMs: 150,
    statusTimeoutMs: 500,
    spawnWorker: (_cmd, _args, opts) => {
      assert.equal(opts.shell, false);
      assert.equal(opts.windowsHide, true);
      return createFakeWorkerProcess((line, proc) => {
        const req = JSON.parse(line);
        if (req.action === 'status') {
          proc.stderr.write('[diagnostic] checking status\n');
          proc.stdout.write(
            JSON.stringify({
              event: 'result',
              data: {
                pythonExecutable: 'python.exe',
                pythonVersion: '3.12.14',
                gpuEnvironment: {
                  cudaAvailable: true,
                  gpuName: 'NVIDIA GeForce RTX 4050 Laptop GPU',
                  totalVramMb: 6141,
                },
                datasetReady: true,
                datasetVersion: 'ds-test-v1',
                datasetCutoffTime: Date.now(),
                universeSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
                insufficientSymbols: [],
                lightgbmReady: true,
                kronosModels: {
                  small: {
                    modelKey: 'small',
                    repoId: 'NeoQuasar/Kronos-small',
                    tokenizerRepoId: 'NeoQuasar/Kronos-Tokenizer-base',
                    installed: true,
                    revision: 'rev-small',
                    tokenizerRevision: 'rev-tok',
                  },
                  base: {
                    modelKey: 'base',
                    repoId: 'NeoQuasar/Kronos-base',
                    tokenizerRepoId: 'NeoQuasar/Kronos-Tokenizer-base',
                    installed: true,
                    revision: 'rev-base',
                    tokenizerRevision: 'rev-tok',
                  },
                },
                offlineComparisonReady: true,
              },
            }) + '\n',
          );
          proc.emitClose(0);
          return;
        }

        if (workerMode === 'invalid_json') {
          proc.stdout.write('WARNING: polluted non-json stdout line\n');
          proc.emitClose(0);
          return;
        }

        if (workerMode === 'oom') {
          proc.stderr.write('RuntimeError: CUDA out of memory\n');
          proc.stdout.write(
            JSON.stringify({
              event: 'error',
              errorCode: 'CUDA_OOM',
              message: 'CUDA OOM during Kronos-base inference; 依規範不降級模型或改用 CPU',
            }) + '\n',
          );
          proc.emitClose(2);
          return;
        }

        if (workerMode === 'missing_model') {
          proc.stdout.write(
            JSON.stringify({
              event: 'error',
              errorCode: 'MODEL_OR_DATA_MISSING',
              message: 'Kronos-base 權重尚未安裝（POST 推論不會自動下載）',
            }) + '\n',
          );
          proc.emitClose(3);
          return;
        }

        if (workerMode === 'slow_hang') {
          return;
        }
        if (workerMode === 'invalid_result') {
          proc.stdout.write(JSON.stringify({ event: 'result', data: { runId: 'run-unrelated' } }) + '\n');
          proc.emitClose(0);
          return;
        }
        if (workerMode === 'duplicate_event') {
          proc.stdout.write(JSON.stringify({ event: 'error', errorCode: 'CUDA_OOM' }) + '\n');
          proc.stdout.write(JSON.stringify({ event: 'result', data: buildMockRunResult(req.runId, Date.now(), Date.now() + 3600000) }) + '\n');
          proc.emitClose(0);
          return;
        }
        if (workerMode === 'insufficient') {
          const result = buildMockRunResult(req.runId, Date.now(), Date.now() + 3600000);
          result.status = 'INSUFFICIENT_DATA';
          result.forecasts = {};
          proc.stdout.write(JSON.stringify({ event: 'result', data: result }) + '\n');
          proc.emitClose(0);
          return;
        }

        // Normal run: also write result.json & latest-run.json to simulate worker's atomic commit
        const now = Date.now();
        const result = buildMockRunResult(req.runId, now, now + 3_600_000);
        const runDir = path.join(tmpDir, 'model-research', req.runId);
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));
        fs.writeFileSync(
          path.join(tmpDir, 'model-research', 'latest-run.json'),
          JSON.stringify({
            runId: req.runId,
            kronosModel: req.kronosModel,
            cutoffTime: result.cutoffTime,
            expiresAt: result.expiresAt,
            generatedAt: result.generatedAt,
          }),
        );
        result.warnings = ['測試中文'];
        const encoded = Buffer.from(JSON.stringify({ event: 'result', data: result }) + '\n');
        // Split a Chinese codepoint across pipe chunks; the JSON must survive intact.
        const split = encoded.indexOf(Buffer.from('測')) + 1;
        proc.stdout.write(encoded.subarray(0, split));
        proc.stdout.write(encoded.subarray(split));
        proc.emitClose(0);
      });
    },
  });

  const server = createServer({
    client,
    writer: new StorageWriter(client),
    liveHub: new LiveHub(),
    gapDetector: new GapDetector(client, 'futures', tmpDir),
    sessionManager: new SessionManager(client, 'futures'),
    streamManager: new BinanceStreamManager('futures', [], { onMessage: () => {} }),
    universeManager: new UniverseManager(client, 10),
    eventsManager: new CollectorEventsManager(client, 'futures'),
    dataDir: tmpDir,
    researchRunner,
  });

  t.after(async () => {
    await server.close();
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. Check GET /api/research/status and initial empty GET /api/research/latest
  const statusRes = await server.inject({ method: 'GET', url: '/api/research/status' });
  assert.equal(statusRes.statusCode, 200);
  const statusBody = statusRes.json();
  assert.equal(statusBody.configured, true);
  assert.equal(statusBody.datasetReady, true);
  assert.equal(statusBody.lightgbmReady, true);
  assert.equal(statusBody.kronosModels.small.installed, true);

  const emptyLatestRes = await server.inject({ method: 'GET', url: '/api/research/latest' });
  assert.equal(emptyLatestRes.statusCode, 200);
  assert.equal(emptyLatestRes.json().validityStatus, 'EMPTY');
  assert.equal(emptyLatestRes.json().result, null);

  // 2. Spot market must be rejected with 400
  const spotRes = await server.inject({
    method: 'POST',
    url: '/api/research/run',
    payload: { market: 'spot', kronosModel: 'small' },
  });
  assert.equal(spotRes.statusCode, 400);
  for (const payload of [{ kronosModel: 'typo' }, { cutoffTime: 123.5 }, { cutoffTime: -1 }, { cutoffTime: Date.now() + 60000 }]) {
    const invalid = await server.inject({ method: 'POST', url: '/api/research/run', payload });
    assert.equal(invalid.statusCode, 400);
  }

  // 3. Normal run succeeds and updates /api/research/latest
  workerMode = 'normal';
  const runRes = await server.inject({
    method: 'POST',
    url: '/api/research/run',
    payload: { kronosModel: 'small' },
  });
  assert.equal(runRes.statusCode, 200);
  const { jobId, runId } = runRes.json();
  assert.ok(jobId);
  assert.ok(runId);

  // Wait for job completion
  for (let i = 0; i < 20; i++) {
    const jobRes = await server.inject({ method: 'GET', url: `/api/research/jobs/${jobId}` });
    if (jobRes.json().status !== 'RUNNING') break;
    await new Promise((r) => setTimeout(r, 15));
  }

  const jobDone = (await server.inject({ method: 'GET', url: `/api/research/jobs/${jobId}` })).json();
  assert.equal(jobDone.status, 'SUCCEEDED');
  assert.equal(jobDone.result.runId, runId);
  assert.equal(jobDone.result.validityStatus, 'SUCCESS');
  assert.equal(jobDone.result.isExpired, false);
  assert.deepEqual(jobDone.result.warnings, ['測試中文']);

  const latestRes = await server.inject({ method: 'GET', url: '/api/research/latest' });
  assert.equal(latestRes.statusCode, 200);
  assert.equal(latestRes.json().runId, runId);
  assert.equal(latestRes.json().validityStatus, 'SUCCESS');

  // 4. Concurrent run rejection (409) and timeout handling
  workerMode = 'slow_hang';
  const hangRun = await server.inject({
    method: 'POST',
    url: '/api/research/run',
    payload: { kronosModel: 'small' },
  });
  assert.equal(hangRun.statusCode, 200);
  const hangJobId = hangRun.json().jobId;

  // Concurrent request while hangJobId is RUNNING must return 409
  const concurrentRes = await server.inject({
    method: 'POST',
    url: '/api/research/run',
    payload: { kronosModel: 'base' },
  });
  assert.equal(concurrentRes.statusCode, 409);
  assert.equal(concurrentRes.json().activeJobId, hangJobId);

  // Wait for 150ms timeout to trigger
  await new Promise((r) => setTimeout(r, 220));
  const timedOutJob = (await server.inject({ method: 'GET', url: `/api/research/jobs/${hangJobId}` })).json();
  assert.equal(timedOutJob.status, 'FAILED');
  assert.equal(timedOutJob.errorCode, 'WORKER_TIMEOUT');
  assert.equal(timedOutJob.result, undefined);

  // 5. Invalid JSON output -> FAILED with INVALID_JSON_OUTPUT
  workerMode = 'invalid_json';
  const badJsonRun = await server.inject({
    method: 'POST',
    url: '/api/research/run',
    payload: { kronosModel: 'small' },
  });
  await new Promise((r) => setTimeout(r, 40));
  const badJsonJob = (await server.inject({ method: 'GET', url: `/api/research/jobs/${badJsonRun.json().jobId}` })).json();
  assert.equal(badJsonJob.status, 'FAILED');
  assert.equal(badJsonJob.errorCode, 'INVALID_JSON_OUTPUT');
  assert.equal(badJsonJob.result, undefined);

  // 6. OOM error -> FAILED with CUDA_OOM (never disguises old result as new job result)
  workerMode = 'oom';
  const oomRun = await server.inject({
    method: 'POST',
    url: '/api/research/run',
    payload: { kronosModel: 'base' },
  });
  await new Promise((r) => setTimeout(r, 40));
  const oomJob = (await server.inject({ method: 'GET', url: `/api/research/jobs/${oomRun.json().jobId}` })).json();
  assert.equal(oomJob.status, 'FAILED');
  assert.equal(oomJob.errorCode, 'CUDA_OOM');
  assert.equal(oomJob.result, undefined);

  // 7. Missing model error -> FAILED with MODEL_OR_DATA_MISSING
  workerMode = 'missing_model';
  const missingRun = await server.inject({
    method: 'POST',
    url: '/api/research/run',
    payload: { kronosModel: 'base' },
  });
  await new Promise((r) => setTimeout(r, 40));
  const missingJob = (await server.inject({ method: 'GET', url: `/api/research/jobs/${missingRun.json().jobId}` })).json();
  assert.equal(missingJob.status, 'FAILED');
  assert.equal(missingJob.errorCode, 'MODEL_OR_DATA_MISSING');

  for (const [mode, expectedCode] of [['invalid_result', 'INVALID_WORKER_OUTPUT'], ['duplicate_event', 'INVALID_PROTOCOL_OUTPUT']] as const) {
    workerMode = mode;
    const started = researchRunner.startRunJob();
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(researchRunner.getJob(started.jobId)?.errorCode, expectedCode);
  }

  workerMode = 'insufficient';
  const insufficient = researchRunner.startRunJob();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(researchRunner.getJob(insufficient.jobId)?.result?.status, 'INSUFFICIENT_DATA');
  assert.equal((await researchRunner.getLatestResult())?.runId, runId);
  const restarted = new ModelResearchRunner({ dataDir: tmpDir, workspaceRoot,
    spawnWorker: () => createFakeWorkerProcess((_line, proc) => {
      proc.stdout.write(JSON.stringify({ event: 'result', data: {} }) + '\n'); proc.emitClose(0);
    }),
  });
  assert.equal(restarted.getJob(insufficient.jobId)?.result?.status, 'INSUFFICIENT_DATA');
  restarted.close();

  // 8. Expired result detection when past next hourly cutoff
  const pastCutoff = Date.now() - 2 * 3_600_000;
  const pastExpiry = Date.now() - 3_600_000;
  const expiredResult = buildMockRunResult('run-expired', pastCutoff, pastExpiry);
  const expDir = path.join(tmpDir, 'model-research', 'run-expired');
  fs.mkdirSync(expDir, { recursive: true });
  fs.writeFileSync(path.join(expDir, 'result.json'), JSON.stringify(expiredResult, null, 2));
  fs.writeFileSync(
    path.join(tmpDir, 'model-research', 'latest-run.json'),
    JSON.stringify({
      runId: 'run-expired',
      kronosModel: 'small',
      cutoffTime: pastCutoff,
      expiresAt: pastExpiry,
      generatedAt: pastCutoff + 1000,
    }),
  );

  const expiredLatest = (await server.inject({ method: 'GET', url: '/api/research/latest' })).json();
  assert.equal(expiredLatest.runId, 'run-expired');
  assert.equal(expiredLatest.isExpired, true);
  assert.equal(expiredLatest.validityStatus, 'EXPIRED');
  fs.writeFileSync(path.join(expDir, 'result.json'), JSON.stringify({ runId: 'run-expired' }));
  assert.equal(await researchRunner.getLatestResult(), null);
  fs.writeFileSync(path.join(tmpDir, 'model-research', 'latest-run.json'), JSON.stringify({ runId: '../datasets' }));
  assert.equal(await researchRunner.getLatestResult(), null);
});

test('Timeout retains the inference lock until the worker actually closes', async () => {
  const runner = new ModelResearchRunner({
    dataDir: path.resolve('research/model_research/.test-tmp/delayed-close'),
    workspaceRoot: process.cwd(), jobTimeoutMs: 20,
    spawnWorker: () => createFakeWorkerProcess(() => {}, 100),
  });
  const job = runner.startRunJob();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(runner.getJob(job.jobId)?.errorCode, 'WORKER_TIMEOUT');
  assert.equal(runner.isBusy(), true);
  assert.throws(() => runner.startRunJob(), /忙碌/);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(runner.isBusy(), false);
  runner.close();
});
