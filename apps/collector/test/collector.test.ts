import test from 'node:test';
import assert from 'node:assert/strict';
import { createDuckDBClient, initDatabase } from '../src/storage/duckdb.ts';
import { StorageWriter } from '../src/storage/writer.ts';
import { GapDetector } from '../src/gaps/gapDetector.ts';
import { SessionManager } from '../src/gaps/sessions.ts';
import { flushAggTradesToParquet } from '../src/storage/parquetFlush.ts';
import { createServer } from '../src/api/server.ts';
import { LiveHub } from '../src/live/hub.ts';
import { BinanceStreamManager } from '../src/binance/streams.ts';
import { UniverseManager } from '../src/ingest/universe.ts';
import { CollectorEventsManager } from '../src/events/collectorEvents.ts';
import fs from 'node:fs';
import path from 'node:path';

const schemaPath = path.resolve(import.meta.dirname, '..', 'src', 'storage', 'schema.sql');

test('deduplication: WS and REST overlapping agg_id inserts only once', async () => {
  const db = await createDuckDBClient(':memory:');
  await initDatabase(db, schemaPath);

  const writer = new StorageWriter(db);

  // Push trade from WS
  writer.pushAggTrade({
    market: 'futures',
    symbol: 'BTCUSDT',
    agg_id: 1001,
    price: 50000,
    qty: 0.5,
    trade_time: 1700000000000,
    recv_time: 1700000000100,
    is_buyer_maker: false,
    source: 'ws',
  });

  // Push identical agg_id from REST backfill
  writer.pushAggTrade({
    market: 'futures',
    symbol: 'BTCUSDT',
    agg_id: 1001,
    price: 50000,
    qty: 0.5,
    trade_time: 1700000000000,
    recv_time: 1700000000500,
    is_buyer_maker: false,
    source: 'rest',
  });

  await writer.flush();

  const rows = await db.all('SELECT * FROM agg_trades WHERE symbol = \'BTCUSDT\' AND agg_id = 1001;');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'ws'); // Original preserved

  await db.close();
});

test('gap detection: agg_id jump creates open gap record and marks resolved', async () => {
  const db = await createDuckDBClient(':memory:');
  await initDatabase(db, schemaPath);

  const detector = new GapDetector(db, 'futures');

  // Trade 100 at time 1000
  await detector.checkAggTrade('BTCUSDT', 100, 1000);

  // Trade 105 at time 5000 -> jump!
  const gap = await detector.checkAggTrade('BTCUSDT', 105, 5000);

  assert.ok(gap !== null);
  assert.equal(gap.from_id, 101);
  assert.equal(gap.to_id, 104);
  assert.equal(gap.status, 'open');

  const openGaps = await db.all('SELECT * FROM gaps WHERE status = \'open\';');
  assert.equal(openGaps.length, 1);
  assert.equal(Number(openGaps[0].from_id), 101);
  assert.equal(Number(openGaps[0].to_id), 104);

  // Mark resolved
  await detector.markResolved(gap.id, 'backfilled');
  const resolved = await db.all('SELECT * FROM gaps WHERE id = ?;', gap.id);
  assert.equal(resolved[0].status, 'backfilled');
  assert.ok(resolved[0].resolved_at > 0);

  await db.close();
});

test('parquet flush: exports hot data to Parquet and purges hot DuckDB table', async () => {
  const tmpDir = path.resolve(import.meta.dirname, '..', '.tmp_test_parquet');
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tmpDir, { recursive: true });

  const db = await createDuckDBClient(':memory:');
  await initDatabase(db, schemaPath);

  const writer = new StorageWriter(db);
  const epoch = 1700000000000;

  for (let i = 0; i < 10; i++) {
    writer.pushAggTrade({
      market: 'futures',
      symbol: 'BTCUSDT',
      agg_id: 500 + i,
      price: 60000 + i,
      qty: 0.1,
      trade_time: epoch + i * 1000,
      recv_time: epoch + i * 1000,
      is_buyer_maker: i % 2 === 0,
      source: 'ws',
    });
  }

  await writer.flush();

  const beforeRows = await db.all('SELECT count(*)::INT as cnt FROM agg_trades;');
  assert.equal(beforeRows[0].cnt, 10);

  // Flush to Parquet
  const result = await flushAggTradesToParquet(db, tmpDir, epoch + 20000);
  assert.equal(result.flushedCount, 10);

  // Check DuckDB is purged
  const afterRows = await db.all('SELECT count(*)::INT as cnt FROM agg_trades;');
  assert.equal(afterRows[0].cnt, 0);

  // Read back directly from Parquet files
  const normalizedPath = path.join(tmpDir, 'parquet', 'aggtrades', '**', '*.parquet').replaceAll('\\', '/');
  const pqRows = await db.all(`SELECT count(*)::INT as cnt FROM '${normalizedPath}';`);
  assert.equal(pqRows[0].cnt, 10);

  await db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('unclean shutdown recovery: marks previous orphaned session with latest trade time', async () => {
  const db = await createDuckDBClient(':memory:');
  await initDatabase(db, schemaPath);

  // Insert an orphaned session
  await db.run(
    'INSERT INTO collection_sessions (id, market, started_at) VALUES (\'old-session\', \'futures\', 1000);'
  );

  // Insert a trade with recv_time = 5000
  await db.run(
    `INSERT INTO agg_trades (market, symbol, agg_id, price, qty, trade_time, recv_time, is_buyer_maker, source)
     VALUES ('futures', 'BTCUSDT', 1, 100, 1, 5000, 5000, false, 'ws');`
  );

  const sessionManager = new SessionManager(db, 'futures');
  const newSessionId = await sessionManager.start();

  const oldSessions = await db.all('SELECT * FROM collection_sessions WHERE id = \'old-session\';');
  assert.equal(Number(oldSessions[0].ended_at), 5000);
  assert.equal(oldSessions[0].end_reason, 'unclean_shutdown');
  assert.notEqual(newSessionId, 'old-session');

  await db.close();
});

test('kline aggregation: aggregates 1m candles into 5m candles accurately', async () => {
  const db = await createDuckDBClient(':memory:');
  await initDatabase(db, schemaPath);

  const writer = new StorageWriter(db);
  const baseTime = Math.floor(1700000000000 / (5 * 60 * 1000)) * (5 * 60 * 1000); // 5m aligned

  // Insert five 1m candles
  const candles = [
    { o: 100, h: 105, l: 98, c: 102, v: 10 },
    { o: 102, h: 108, l: 101, c: 107, v: 20 },
    { o: 107, h: 110, l: 104, c: 105, v: 15 },
    { o: 105, h: 106, l: 99, c: 101, v: 12 },
    { o: 101, h: 103, l: 97, c: 100, v: 8 },
  ];

  candles.forEach((c, idx) => {
    writer.pushKline({
      market: 'futures',
      symbol: 'ETHUSDT',
      open_time: baseTime + idx * 60 * 1000,
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
      volume: c.v,
      quote_volume: c.v * c.c,
      is_final: true,
      source: 'ws',
    });
  });

  await writer.flush();

  const bucketMs = 5 * 60 * 1000;
  const aggregated = await db.all(
    `SELECT
      ((open_time // ${bucketMs}) * ${bucketMs}) / 1000 as time,
      arg_min(open, open_time) as open,
      max(high) as high,
      min(low) as low,
      arg_max(close, open_time) as close,
      sum(volume) as volume
     FROM klines_1m
     WHERE market = 'futures' AND symbol = 'ETHUSDT'
     GROUP BY ((open_time // ${bucketMs}) * ${bucketMs});`
  );

  assert.equal(aggregated.length, 1);
  assert.equal(aggregated[0].open, 100); // Open of 1st candle
  assert.equal(aggregated[0].high, 110); // Max high across all 5
  assert.equal(aggregated[0].low, 97);   // Min low across all 5
  assert.equal(aggregated[0].close, 100); // Close of 5th candle
  assert.equal(aggregated[0].volume, 65); // 10+20+15+12+8

  await db.close();
});

test('API security: rejects request without token or with invalid token', async () => {
  const db = await createDuckDBClient(':memory:');
  await initDatabase(db, schemaPath);

  const writer = new StorageWriter(db);
  const liveHub = new LiveHub();
  const gapDetector = new GapDetector(db, 'futures');
  const sessionManager = new SessionManager(db, 'futures');
  const universeManager = new UniverseManager(db);
  const eventsManager = new CollectorEventsManager(db, 'futures');
  const streamManager = new BinanceStreamManager('futures', [], { onMessage: () => {} });

  const app = createServer({
    client: db,
    writer,
    liveHub,
    gapDetector,
    sessionManager,
    streamManager,
    universeManager,
    eventsManager,
    dataDir: ':memory:',
    token: 'secret-token-12345',
  });

  await app.ready();

  // 1. Without token -> 401
  const resNoAuth = await app.inject({
    method: 'GET',
    url: '/api/health',
  });
  assert.equal(resNoAuth.statusCode, 401);

  // 2. With wrong token -> 401
  const resBadAuth = await app.inject({
    method: 'GET',
    url: '/api/health',
    headers: { authorization: 'Bearer wrong-token' },
  });
  assert.equal(resBadAuth.statusCode, 401);

  // 3. With correct token -> 200
  const resGoodAuth = await app.inject({
    method: 'GET',
    url: '/api/health',
    headers: { authorization: 'Bearer secret-token-12345' },
  });
  assert.equal(resGoodAuth.statusCode, 200);
  const body = JSON.parse(resGoodAuth.body);
  assert.equal(body.status, 'ok');

  await app.close();
  liveHub.close();
  await db.close();
});

test('kline upsert: accumulated updates modify open candle and mark final candle accurately', async () => {
  const db = await createDuckDBClient(':memory:');
  await initDatabase(db, schemaPath);

  const writer = new StorageWriter(db);

  // Initial tick of candle
  writer.pushKline({
    market: 'futures',
    symbol: 'BTCUSDT',
    open_time: 1700000000000,
    open: 60000,
    high: 60100,
    low: 59900,
    close: 60050,
    volume: 1.0,
    quote_volume: 60050,
    trades: 10,
    is_final: false,
    source: 'ws',
  });
  await writer.flush();

  // Subsequent tick in same minute with higher high, lower low, higher volume, final=true
  writer.pushKline({
    market: 'futures',
    symbol: 'BTCUSDT',
    open_time: 1700000000000,
    open: 60000,
    high: 60300,
    low: 59800,
    close: 60250,
    volume: 5.5,
    quote_volume: 331000,
    trades: 45,
    is_final: true,
    source: 'ws',
  });
  await writer.flush();

  const rows = await db.all('SELECT * FROM klines_1m WHERE symbol = \'BTCUSDT\';');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].high, 60300);
  assert.equal(rows[0].low, 59800);
  assert.equal(rows[0].close, 60250);
  assert.equal(rows[0].volume, 5.5);
  assert.equal(rows[0].is_final, true);

  await db.close();
});

test('API parquet query: /api/trades, /api/replay, and /api/stats/summary retrieve records from Parquet cold storage', async () => {
  const tmpDir = path.resolve(import.meta.dirname, '..', '.tmp_test_api_pq');
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tmpDir, { recursive: true });

  const db = await createDuckDBClient(':memory:');
  await initDatabase(db, schemaPath);

  const writer = new StorageWriter(db);
  const liveHub = new LiveHub();
  const gapDetector = new GapDetector(db, 'futures');
  const sessionManager = new SessionManager(db, 'futures');
  const universeManager = new UniverseManager(db);
  const eventsManager = new CollectorEventsManager(db, 'futures');
  const streamManager = new BinanceStreamManager('futures', [], { onMessage: () => {} });

  // 1. Seed and flush trades to Parquet
  const epoch = 1700000000000;
  for (let i = 0; i < 5; i++) {
    writer.pushAggTrade({
      market: 'futures',
      symbol: 'SOLUSDT',
      agg_id: 100 + i,
      price: 150 + i,
      qty: 2,
      trade_time: epoch + i * 1000,
      recv_time: epoch + i * 1000,
      is_buyer_maker: false,
      source: 'ws',
    });
  }
  await writer.flush();
  await flushAggTradesToParquet(db, tmpDir, epoch + 10000);

  // 2. Add 2 fresh hot trades in DuckDB
  for (let i = 5; i < 7; i++) {
    writer.pushAggTrade({
      market: 'futures',
      symbol: 'SOLUSDT',
      agg_id: 100 + i,
      price: 150 + i,
      qty: 2,
      trade_time: epoch + i * 1000,
      recv_time: epoch + i * 1000,
      is_buyer_maker: false,
      source: 'ws',
    });
  }
  await writer.flush();

  const app = createServer({
    client: db,
    writer,
    liveHub,
    gapDetector,
    sessionManager,
    streamManager,
    universeManager,
    eventsManager,
    dataDir: tmpDir,
  });

  try {
    await app.ready();

    // /api/trades should return all 7 trades (5 from parquet + 2 from hot DuckDB)
    const tradesRes = await app.inject({
      method: 'GET',
      url: '/api/trades?market=futures&symbol=SOLUSDT',
    });
    assert.equal(tradesRes.statusCode, 200);
    const trades = JSON.parse(tradesRes.body);
    assert.equal(trades.length, 7);

    // /api/stats/summary should report totalAggTrades = 7
    const summaryRes = await app.inject({
      method: 'GET',
      url: '/api/stats/summary',
    });
    const summary = JSON.parse(summaryRes.body);
    assert.equal(summary.totalAggTrades, 7);
    assert.ok(summary.diskBytes > 0);

    // /api/replay should successfully process the 7 trades
    const replayRes = await app.inject({
      method: 'POST',
      url: '/api/replay',
      payload: {
        market: 'futures',
        symbol: 'SOLUSDT',
      },
    });
    assert.equal(replayRes.statusCode, 200);
    const replay = JSON.parse(replayRes.body);
    assert.equal(replay.totalTrades, 7);
  } finally {
    await app.close();
    liveHub.close();
    await db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});
