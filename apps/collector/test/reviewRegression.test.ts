import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { createDuckDBClient, initDatabase } from '../src/storage/duckdb.ts';
import { StorageWriter } from '../src/storage/writer.ts';
import type { StoredAggTrade } from '../src/storage/writer.ts';
import { flushAggTradesToParquet, tradeSource } from '../src/storage/parquetFlush.ts';
import { GapDetector } from '../src/gaps/gapDetector.ts';
import { backfillGap } from '../src/gaps/restBackfill.ts';
import { LiveHub } from '../src/live/hub.ts';
import { BinanceStreamManager } from '../src/binance/streams.ts';
import { createServer } from '../src/api/server.ts';
import { SessionManager } from '../src/gaps/sessions.ts';
import { UniverseManager } from '../src/ingest/universe.ts';
import { CollectorEventsManager } from '../src/events/collectorEvents.ts';
import { collectorIPC } from '../src/ipc.ts';

const trade = (id: number): StoredAggTrade => ({
  market: 'futures', symbol: 'BTCUSDT', agg_id: id, price: 100, qty: 1,
  trade_time: 1700000000000 + id, recv_time: 1700000000000 + id, is_buyer_maker: false, source: 'ws',
});

async function fixture(t: test.TestContext, token?: string) {
  const db = await createDuckDBClient();
  t.after(() => db.close());
  await initDatabase(db);
  const root = path.resolve(import.meta.dirname);
  const dataDir = fs.mkdtempSync(path.join(root, ".review-quote'-"));
  t.after(() => {
    assert.ok(path.resolve(dataDir).startsWith(root + path.sep));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const writer = new StorageWriter(db);
  const liveHub = new LiveHub();
  const detector = new GapDetector(db, 'futures', dataDir);
  const streams = new BinanceStreamManager('futures', [], { onMessage() {} });
  const app = createServer({ client: db, writer, liveHub, gapDetector: detector,
    sessionManager: new SessionManager(db, 'futures'), streamManager: streams,
    universeManager: new UniverseManager(db), eventsManager: new CollectorEventsManager(db, 'futures'), dataDir, token,
  });
  t.after(async () => { streams.stop(); liveHub.close(); await writer.stop(); await app.close(); });
  return { db, writer, dataDir, detector, app };
}

test('stop waits for the active write and drains arrivals during that write', async t => {
  const { db, writer } = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const all = db.all.bind(db);
  let blocked = false;
  db.all = async (sql, ...params) => {
    if (sql.startsWith('INSERT INTO agg_trades') && !blocked) { blocked = true; await gate; }
    return all(sql, ...params);
  };
  writer.pushAggTrade(trade(1));
  const writing = writer.flush();
  writer.pushAggTrade(trade(2));
  let stopped = false;
  const stopping = writer.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  release();
  await Promise.all([writing, stopping]);
  assert.equal((await all('SELECT * FROM agg_trades')).length, 2);
  assert.equal(writer.getStats().queueDepthTrades, 0);
});

test('failed batch is retryable, overlapping IDs are counted only once', async t => {
  const { db, writer } = await fixture(t);
  const all = db.all.bind(db);
  let fail = true;
  db.all = async (sql, ...params) => {
    if (sql.startsWith('INSERT INTO agg_trades') && fail) { fail = false; throw new Error('disk failure'); }
    return all(sql, ...params);
  };
  writer.pushAggTrade(trade(1));
  await assert.rejects(writer.flush(), /disk failure/);
  writer.pushAggTrade({ ...trade(1), source: 'rest' });
  await writer.flush();
  assert.equal((await db.all('SELECT * FROM agg_trades')).length, 1);
  assert.equal(writer.getStats().totalTradesWritten, 1);
});

test('late non-final klines cannot roll back a finalized candle', async t => {
  const { db, writer } = await fixture(t);
  const candle = { market: 'futures' as const, symbol: 'BTCUSDT', open_time: 60000,
    open: 10, high: 12, low: 9, close: 11, volume: 10, quote_volume: 110, is_final: true, source: 'ws' as const };
  writer.pushKline(candle);
  await writer.flush();
  writer.pushKline({ ...candle, volume: 1, close: 10, is_final: false });
  await writer.flush();
  const [stored] = await db.all('SELECT * FROM klines_1m');
  assert.equal(stored.volume, 10);
  assert.equal(stored.close, 11);
  assert.equal(stored.is_final, true);
});

test('Parquet snapshot preserves late arrivals and appends without overwriting partitions', async t => {
  const { db, writer, dataDir } = await fixture(t);
  writer.pushAggTrade(trade(1));
  await writer.flush();
  const exec = db.exec.bind(db);
  let inserted = false;
  db.exec = async sql => {
    await exec(sql);
    if (sql.startsWith('COPY') && !inserted) {
      inserted = true;
      writer.pushAggTrade(trade(2));
      await writer.flush();
    }
  };
  await flushAggTradesToParquet(db, dataDir);
  assert.deepEqual((await db.all('SELECT agg_id FROM agg_trades')).map(row => row.agg_id), [2]);
  await Promise.all([flushAggTradesToParquet(db, dataDir), flushAggTradesToParquet(db, dataDir)]);
  assert.equal((await db.all(`SELECT * FROM ${tradeSource(dataDir)}`)).length, 2);
  assert.equal((await db.all('SELECT * FROM agg_trades')).length, 0);
});

test('API trades, replay, summary and coverage deduplicate hot/cold REST overlap', async t => {
  const { writer, db, dataDir, app } = await fixture(t);
  writer.pushAggTrade(trade(1));
  await writer.flush();
  await flushAggTradesToParquet(db, dataDir);
  writer.pushAggTrade({ ...trade(1), source: 'rest' });
  await writer.flush();
  const trades = await app.inject('/api/trades');
  assert.equal(trades.statusCode, 200, trades.body);
  assert.equal(trades.json().length, 1);
  const summary = await app.inject('/api/stats/summary');
  assert.equal(summary.statusCode, 200, summary.body);
  assert.equal(summary.json().totalAggTrades, 1);
  const coverage = await app.inject('/api/coverage');
  assert.equal(coverage.statusCode, 200, coverage.body);
  assert.equal(coverage.json().dailyCounts[0].count, 1);
  const replay = await app.inject({ method: 'POST', url: '/api/replay', payload: {} });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().totalTrades, 1);
});

test('BIGINT bindings and coverage responses preserve unsafe IDs without global prototype patches', async t => {
  const { db, app } = await fixture(t);
  const id = 9007199254740993n;
  assert.equal((await db.all('SELECT ?::BIGINT AS id', id))[0].id, String(id));
  assert.equal((await db.all('SELECT 1700000000000::BIGINT AS time'))[0].time, 1700000000000);
  await db.run(`INSERT INTO gaps (id,market,symbol,dataset,from_time,to_time,from_id,to_id,status,detected_at)
    VALUES ('large','futures','BTCUSDT','aggtrades',1,2,?,?,'open',1)`, id, id + 1n);
  const response = await app.inject('/api/coverage');
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().gaps[0].from_id, String(id));
  assert.equal(Object.hasOwn(BigInt.prototype, 'toJSON'), false);
});

test('gap cursor ignores duplicates and out-of-order trades, including concurrent initialization', async t => {
  const { detector } = await fixture(t);
  await Promise.all([detector.checkAggTrade('BTCUSDT', 100, 1000), detector.checkAggTrade('BTCUSDT', 101, 1100)]);
  await detector.checkAggTrade('BTCUSDT', 99, 900);
  assert.equal(await detector.checkAggTrade('BTCUSDT', 102, 1200), null);
  const gap = await detector.checkAggTrade('BTCUSDT', 105, 1500);
  assert.equal(gap?.from_id, 103);
  assert.equal(gap?.to_id, 104);
});

test('gap detector restores its cursor from archived trades after restart', async t => {
  const { db, dataDir, writer } = await fixture(t);
  writer.pushAggTrade(trade(100));
  await writer.flush();
  await flushAggTradesToParquet(db, dataDir);
  const restarted = new GapDetector(db, 'futures', dataDir);
  const gap = await restarted.checkAggTrade('BTCUSDT', 105, trade(105).trade_time);
  assert.equal(gap?.from_id, 101);
  assert.equal(gap?.to_id, 104);
});

test('backfill paginates past 1000 IDs, coalesces requests, and persists before resolution', async t => {
  const { db, writer, detector } = await fixture(t);
  await detector.checkAggTrade('BTCUSDT', 100, 1000);
  const gap = (await detector.checkAggTrade('BTCUSDT', 1605, 5000))!;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    calls++;
    const params = new URL(input).searchParams;
    const start = Number(params.get('fromId'));
    const limit = Number(params.get('limit'));
    const data = Array.from({ length: limit }, (_, index) => ({ a: start + index, p: '100', q: '1', T: start + index, m: false }));
    return new Response(JSON.stringify(data));
  });
  const results = await Promise.all([backfillGap(gap, writer, detector), backfillGap(gap, writer, detector)]);
  assert.deepEqual(results, [true, true]);
  assert.equal(calls, 2);
  assert.equal((await db.all('SELECT count(*) AS n FROM agg_trades'))[0].n, 1504);
  assert.equal((await db.all('SELECT status FROM gaps'))[0].status, 'backfilled');
});

test('partial and transient backfill failure leaves the gap open for retry', async t => {
  const { db, writer, detector } = await fixture(t);
  await detector.checkAggTrade('BTCUSDT', 100, 1000);
  const gap = (await detector.checkAggTrade('BTCUSDT', 104, 5000))!;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) return new Response(JSON.stringify([{ a: 101, p: '100', q: '1', T: 2000, m: false }]));
    return new Response('rate limited', { status: 429 });
  });
  assert.equal(await backfillGap(gap, writer, detector), false);
  assert.equal((await db.all('SELECT status FROM gaps'))[0].status, 'open');
  assert.equal((await db.all('SELECT count(*) AS n FROM agg_trades'))[0].n, 1);
});

test('API rejects malformed markets, intervals, ranges, limits and write bodies', async t => {
  const { app } = await fixture(t);
  for (const url of [
    '/api/trades?market=unknown', '/api/trades?limit=-1', '/api/trades?limit=1.5', '/api/trades?from=NaN',
    '/api/trades?from=20&to=10', '/api/trades?limit=100001', '/api/klines?interval=garbage', '/api/paper/invalid',
  ]) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 400, `${url}: ${response.body}`);
  }
  for (const [method, url, payload] of [
    ['POST', '/api/replay', { from: 2, to: 1 }], ['POST', '/api/replay', { autoConfig: { riskPct: 'bad' } }],
    ['PUT', '/api/paper/spot', { balance: 'bad', trades: {}, history: [] }],
    ['PUT', '/api/auto/batches', {}], ['POST', '/api/migrate/browser', { paper: { spot: null } }],
  ] as const) {
    const response = await app.inject({ method, url, payload });
    assert.equal(response.statusCode, 400, `${url}: ${response.body}`);
  }
});

test('API rejects untrusted origins and HTTP query tokens; explicit Bearer authorization succeeds', async t => {
  const { app } = await fixture(t, 'secret');
  assert.equal((await app.inject('/api/health?token=secret')).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/health', headers: { origin: 'https://attacker.example', authorization: 'Bearer secret' } })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/health', headers: { origin: 'http://localhost:5173', authorization: 'Bearer secret' } })).statusCode, 200);
});

test('replay excludes unresolved gaps but includes successfully backfilled ranges', async t => {
  const { writer, db, app } = await fixture(t);
  writer.pushAggTrade(trade(1));
  await writer.flush();
  await db.run(`INSERT INTO gaps (id,market,symbol,dataset,from_time,to_time,status,detected_at)
    VALUES ('resolved','futures','BTCUSDT','aggtrades',?,?,'backfilled',1)`, trade(1).trade_time - 1, trade(1).trade_time + 1);
  const result = await app.inject({ method: 'POST', url: '/api/replay', payload: {} });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().skippedByGap, 0);
});

test('server close terminates an authenticated live socket without waiting for a close handshake', { timeout: 5000 }, async t => {
  const { app } = await fixture(t, 'secret');
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as { port: number };
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/live?token=secret`);
  t.after(() => socket.terminate());
  await once(socket, 'open');
  const closed = once(socket, 'close');
  await app.close();
  await closed;
});

test('stream start/stop is idempotent and stopped managers emit no watchdog updates', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const statuses: string[] = [];
  const manager = new BinanceStreamManager('futures', [], { onMessage() {}, onStatusChange: info => statuses.push(info.status) });
  manager.start(); manager.start(); manager.stop(); manager.stop();
  const count = statuses.length;
  t.mock.timers.tick(30000);
  assert.equal(statuses.length, count);
  assert.equal(manager.getStatus().activeSockets, 0);
});

test('Electron utilityProcess IPC unwraps MessageEvent.data and removes listeners', () => {
  const port = new EventEmitter();
  const outgoing: unknown[] = [];
  const runtime = { parentPort: Object.assign(port, { postMessage: (msg: unknown) => outgoing.push(msg) }) };
  const ipc = collectorIPC(runtime as any);
  const incoming: unknown[] = [];
  const dispose = ipc.onMessage(msg => incoming.push(msg));
  ipc.send({ type: 'ready', port: 1234 });
  port.emit('message', { data: { type: 'shutdown' } });
  dispose();
  assert.deepEqual(outgoing, [{ type: 'ready', port: 1234 }]);
  assert.deepEqual(incoming, [{ type: 'shutdown' }]);
  assert.equal(port.listenerCount('message'), 0);
});

test('closing DuckDB releases a file database so it can be reopened', async t => {
  const root = path.resolve(import.meta.dirname);
  const dir = fs.mkdtempSync(path.join(root, '.review-lock-'));
  t.after(() => { assert.ok(dir.startsWith(root + path.sep)); fs.rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'test.duckdb');
  const first = await createDuckDBClient(file);
  await first.run('CREATE TABLE example (n BIGINT)');
  await Promise.all([first.close(), first.close()]);
  const second = await createDuckDBClient(file);
  try { assert.equal((await second.all('SELECT count(*) AS n FROM example'))[0].n, 0); }
  finally { await second.close(); }
});

test('failed gap persistence does not advance the detection cursor', async t => {
  const { db, detector } = await fixture(t);
  await detector.checkAggTrade('BTCUSDT', 100, 1000);
  const run = db.run.bind(db);
  let fail = true;
  db.run = async (sql, ...params) => {
    if (sql.includes('INSERT INTO gaps') && fail) { fail = false; throw new Error('write failure'); }
    return run(sql, ...params);
  };
  await assert.rejects(detector.checkAggTrade('BTCUSDT', 105, 5000), /write failure/);
  const gap = await detector.checkAggTrade('BTCUSDT', 106, 6000);
  assert.equal(gap?.from_id, 101);
  assert.equal(gap?.to_id, 105);
});

test('API accepts Unicode symbols and rejects unsafe stored numeric trading IDs without rounding', async t => {
  const { db, app } = await fixture(t);
  const unicode = await app.inject(`/api/trades?symbol=${encodeURIComponent('\u5e01\u5b89USDT')}`);
  assert.equal(unicode.statusCode, 200, unicode.body);
  await db.run(`INSERT INTO agg_trades (market,symbol,agg_id,price,qty,last_id,trade_time,recv_time,is_buyer_maker,source)
    VALUES ('futures','BTCUSDT',1,100,1,?,1000,1000,false,'ws')`, 9007199254740993n);
  const response = await app.inject('/api/trades');
  assert.equal(response.statusCode, 500);
  assert.match(response.json().message, /safe integer range/);
});

test('DuckDB worker survives a query error and rejects new queries after close', async t => {
  const { db } = await fixture(t);
  await assert.rejects(db.all('SELECT * FROM nonexistent_table'));
  assert.equal((await db.all('SELECT 1 AS n'))[0].n, 1);
  await db.close();
  await assert.rejects(db.all('SELECT 1'), /closing/);
});
