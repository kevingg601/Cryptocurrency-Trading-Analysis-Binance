import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { DEFAULT_MODEL_PAPER_CONFIG } from '@fadachi/core';
import { createDuckDBClient, initDatabase } from '../src/storage/duckdb.ts';
import { tradeSource } from '../src/storage/parquetFlush.ts';

const DEFAULT_OFFLINE_IMPORT = 'data:text/javascript,globalThis.fetch=async()=>new Response(%22[]%22)';

function fixture(
  t: test.TestContext,
  port = '0',
  opts: { importSpec?: string } = {},
) {
  const root = path.resolve(import.meta.dirname);
  const directory = fs.mkdtempSync(path.join(root, '.review-process-'));
  let child: ReturnType<typeof fork> | undefined;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited;
    }
    assert.ok(directory.startsWith(root + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let output = '';
  return {
    directory,
    start(extraEnv: Record<string, string> = {}) {
      // Offline REST fixture yields an empty spot universe: no exchange sockets
      // or external network traffic. This starts only the Node Collector.
      child = fork(path.resolve(import.meta.dirname, '../src/main.ts'), [], {
        execArgv: ['--experimental-strip-types', '--import', opts.importSpec ?? DEFAULT_OFFLINE_IMPORT],
        env: {
          ...process.env,
          FADACHI_DATA: directory,
          FADACHI_PORT: port,
          FADACHI_MARKET: 'spot',
          FADACHI_TOKEN: 'test-secret',
          ...extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      child.stdout!.on('data', data => { output += data; });
      child.stderr!.on('data', data => { output += data; });
      return child;
    },
    get output() { return output; },
  };
}

test('Collector process acknowledges shutdown only after flush, closes handles and releases its database', { timeout: 15000 }, async t => {
  const state = fixture(t);
  const file = path.join(state.directory, 'fadachi.duckdb');
  const seed = await createDuckDBClient(file);
  await initDatabase(seed);
  await seed.run(`INSERT INTO agg_trades (market,symbol,agg_id,price,qty,trade_time,recv_time,is_buyer_maker,source)
    VALUES ('spot','BTCUSDT',1,100,1,1000,1000,false,'ws')`);
  await seed.close();
  const child = state.start();
  const exited = once(child, 'exit');
  const [message] = await once(child, 'message');
  assert.equal(message.type, 'ready', state.output);
  const health = await fetch(`http://127.0.0.1:${message.port}/api/health`, { headers: { authorization: 'Bearer test-secret' } });
  assert.equal(health.status, 200);
  await health.json();
  const flushed = once(child, 'message');
  child.send({ type: 'shutdown' });
  child.send({ type: 'shutdown' });
  assert.equal((await flushed)[0].type, 'flushed', state.output);
  assert.equal((await exited)[0], 0, state.output);
  const reopened = await createDuckDBClient(file);
  try {
    assert.equal((await reopened.all('SELECT count(*) AS n FROM agg_trades'))[0].n, 0);
    assert.equal((await reopened.all(`SELECT count(*) AS n FROM ${tradeSource(state.directory)}`))[0].n, 1);
    assert.equal((await reopened.all('SELECT end_reason FROM collection_sessions'))[0].end_reason, 'electron_quit');
  } finally { await reopened.close(); }
});

test('Collector startup failure closes sessions, timers and native handles before exiting nonzero', { timeout: 15000 }, async t => {
  const occupied = net.createServer();
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve())));
  const port = String((occupied.address() as net.AddressInfo).port);
  const state = fixture(t, port);
  const child = state.start();
  assert.equal((await once(child, 'exit'))[0], 1, state.output);
  assert.match(state.output, /EADDRINUSE/);
  const reopened = await createDuckDBClient(path.join(state.directory, 'fadachi.duckdb'));
  try {
    const [session] = await reopened.all('SELECT ended_at, end_reason FROM collection_sessions');
    assert.ok(session.ended_at > 0);
    assert.equal(session.end_reason, 'startup_error');
  } finally { await reopened.close(); }
});

test('Collector starts ModelPaperService after universe fetch & stream startup without spurious STREAM_DISCONNECTED gap', { timeout: 20000 }, async t => {
  const markerImport = 'data:text/javascript,' + encodeURIComponent(
    `import fs from 'node:fs';
     globalThis.fetch = async (url) => {
       if (String(url).includes('/ticker/24hr')) {
         await new Promise(r => setTimeout(r, 60));
         fs.writeFileSync(process.env.TEST_FETCH_MARKER, String(Date.now()));
       }
       return new Response('[]');
     };`,
  );
  const state = fixture(t, '0', { importSpec: markerImport });
  const markerFile = path.join(state.directory, 'fetch-done.txt');

  const file = path.join(state.directory, 'fadachi.duckdb');
  const seed = await createDuckDBClient(file);
  await initDatabase(seed);
  const expId = 'mp-boot-order';
  const modelSource = JSON.stringify({
    adapterRunId: 'run-1',
    adapterRunDir: '/tmp/run-1',
    attemptDir: '/tmp/run-1/chronos2/attempt_1',
    artifactHashes: {},
    baseRepoId: 'amazon/chronos-2',
    baseRevision: 'rev-1',
    baseFiles: {},
  });
  await seed.run(
    `INSERT INTO model_paper_experiments
     (id, created_at, status, config_json, model_key, model_source_json, universe_json, started_at, stopped_at, heartbeat_at, status_reason)
     VALUES (?, ?, 'RUNNING', ?, 'chronos2', ?, ?, ?, NULL, ?, NULL);`,
    expId, 1000, JSON.stringify(DEFAULT_MODEL_PAPER_CONFIG), modelSource, JSON.stringify(['BTCUSDT']), 1000, 1000,
  );
  for (const acc of ['A', 'B']) {
    await seed.run(
      `INSERT INTO model_paper_accounts
       (experiment_id, account, cash, reserved, realized_pnl, fees, funding, bankrupt, degraded, funding_pending, stopped_this_hour_json, updated_at)
       VALUES (?, ?, 10000, 0, 0, 0, 0, false, false, false, '[]', 1000);`,
      expId, acc,
    );
  }
  await seed.close();

  const child = state.start({ TEST_FETCH_MARKER: markerFile });
  const exited = once(child, 'exit');
  const [message] = await once(child, 'message');
  assert.equal(message.type, 'ready', state.output);

  // Wait past the 1s PaperExecutor monitor tick (well within 5s staleMs startup grace)
  // to verify tick 1 inside the real Collector process does not open a spurious gap.
  await new Promise(resolve => setTimeout(resolve, 1250));

  const detailRes = await fetch(`http://127.0.0.1:${message.port}/api/model-paper/experiments/${expId}`, {
    headers: { authorization: 'Bearer test-secret' },
  });
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json() as any;
  assert.equal(detail.experiment.status, 'AWAITING_RESUME');
  assert.deepEqual(detail.gaps.map((g: any) => g.kind), ['PROCESS_RESTART']);

  const fetchDoneAt = Number(fs.readFileSync(markerFile, 'utf8'));
  assert.ok(Number.isFinite(fetchDoneAt) && fetchDoneAt > 0);
  assert.ok(detail.gaps[0].endedAt >= fetchDoneAt, `expected PROCESS_RESTART endedAt (${detail.gaps[0].endedAt}) >= fetchDoneAt (${fetchDoneAt})`);

  const flushed = once(child, 'message');
  child.send({ type: 'shutdown' });
  assert.equal((await flushed)[0].type, 'flushed', state.output);
  assert.equal((await exited)[0], 0, state.output);

  const reopened = await createDuckDBClient(file);
  try {
    const gaps = await reopened.all<{ kind: string }>('SELECT kind FROM model_paper_gaps WHERE experiment_id = ?;', expId);
    assert.deepEqual(gaps.map(g => g.kind), ['PROCESS_RESTART']);
  } finally {
    await reopened.close();
  }
});
