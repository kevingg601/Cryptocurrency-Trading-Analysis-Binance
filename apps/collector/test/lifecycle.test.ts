import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { createDuckDBClient, initDatabase } from '../src/storage/duckdb.ts';
import { tradeSource } from '../src/storage/parquetFlush.ts';

function fixture(t: test.TestContext, port = '0') {
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
    start() {
      // Offline REST fixture yields an empty spot universe: no exchange sockets
      // or external network traffic. This starts only the Node Collector.
      child = fork(path.resolve(import.meta.dirname, '../src/main.ts'), [], {
        execArgv: ['--experimental-strip-types', '--import', 'data:text/javascript,globalThis.fetch=async()=>new Response(%22[]%22)'],
        env: { ...process.env, FADACHI_DATA: directory, FADACHI_PORT: port, FADACHI_MARKET: 'spot', FADACHI_TOKEN: 'test-secret' },
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
