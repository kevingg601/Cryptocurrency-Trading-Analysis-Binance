import fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { DuckDBClient } from '../storage/duckdb.ts';
import type { StorageWriter } from '../storage/writer.ts';
import type { LiveHub } from '../live/hub.ts';
import type { GapDetector } from '../gaps/gapDetector.ts';
import type { SessionManager } from '../gaps/sessions.ts';
import type { BinanceStreamManager } from '../binance/streams.ts';
import type { UniverseManager } from '../ingest/universe.ts';
import type { CollectorEventsManager } from '../events/collectorEvents.ts';
import { fetchHistoricalKlines } from '../binance/rest.ts';
import { backfillGap } from '../gaps/restBackfill.ts';
import {
  runTradeReplay,
  FALLBACK_COINS,
  parseWithInfinity,
  stringifyWithInfinity,
  restoreInfinityInOrders,
  ABComparisonCoordinator,
} from '@fadachi/core';
import fs from 'node:fs';
import path from 'node:path';
import { tradeSource } from '../storage/parquetFlush.ts';
import { installValidation } from './validation.ts';
import { AIDataAggregator } from '../ai/aiDataAggregator.ts';
import { AICLIRunner } from '../ai/cliRunner.ts';
import { abStorageTransaction } from '../ai/abStorage.ts';
import { AB_SERVICE_GENERATION, activateABOwnershipGeneration, claimABLease, ensureABOwnership, getABLease, ownsABLease, renewABLease } from '../ai/abOwnership.ts';
import { AIScopeStore } from '../ai/scopeStore.ts';
import { ModelResearchRunner, ModelResearchBusyError } from '../research/modelResearchRunner.ts';

export interface ServerOptions {
  client: DuckDBClient;
  writer: StorageWriter;
  liveHub: LiveHub;
  gapDetector: GapDetector;
  gapDetectors?: Map<'spot' | 'futures', GapDetector>;
  sessionManager: SessionManager;
  streamManager: BinanceStreamManager;
  universeManager: UniverseManager;
  eventsManager: CollectorEventsManager;
  dataDir: string;
  token?: string;
  aiAggregator?: AIDataAggregator;
  cliRunner?: AICLIRunner;
  researchRunner?: ModelResearchRunner;
}

function safeInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError(`Stored ${field} exceeds safe integer range`);
  return number;
}

function calculateDirSize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const fullPath = path.join(dir, e.name);
      if (e.isDirectory()) {
        total += calculateDirSize(fullPath);
      } else {
        total += fs.statSync(fullPath).size;
      }
    }
  } catch {}
  return total;
}

export function createServer(options: ServerOptions) {
  const {
    client,
    writer,
    liveHub,
    gapDetector,
    gapDetectors,
    sessionManager,
    streamManager,
    universeManager,
    eventsManager,
    dataDir,
    token,
  } = options;

  const aiAggregator = options.aiAggregator ?? new AIDataAggregator({ client });
  const cliRunner = options.cliRunner ?? new AICLIRunner({ client });
  const researchRunner = options.researchRunner ?? new ModelResearchRunner({ dataDir });
  const aiScopeStore = new AIScopeStore(client);
  const saveAtomically = abStorageTransaction(client);
  const ownershipReady = saveAtomically(connection => activateABOwnershipGeneration(connection, AB_SERVICE_GENERATION));

  const app = fastify({ logger: false });
  app.addHook('onReady', async () => { await ownershipReady; });

  const trustedOrigin = (origin?: string) => {
    if (!origin) return true;
    if (origin === 'null') return Boolean(token);
    try {
      const url = new URL(origin);
      return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    } catch { return false; }
  };
  app.register(cors, { origin: (origin, callback) => callback(null, trustedOrigin(origin)) });
  installValidation(app);
  app.addHook('preClose', async () => {
    liveHub.close();
    researchRunner.close();
  });
  app.register(websocket);
  const requests = new AbortController();
  app.addHook('preClose', async () => { requests.abort(); });

  // Authentication hook
  app.addHook('onRequest', async (req, reply) => {
    // Only accept connections from localhost
    const remoteIp = req.socket.remoteAddress;
    if (remoteIp && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteIp)) {
      reply.status(403).send({ error: 'Forbidden: only localhost is allowed' });
      return;
    }

    if (!trustedOrigin(req.headers.origin)) {
      return reply.status(403).send({ error: 'Forbidden origin' });
    }

    // Token check if token is configured
    if (token) {
      // WS upgrade requests might pass token in query param ?token=
      const authHeader = req.headers['authorization'];
      const queryToken = req.headers.upgrade?.toLowerCase() === 'websocket' ? (req.query as any)?.token : undefined;
      const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      const providedToken = bearerToken || queryToken;

      if (!providedToken || providedToken !== token) {
        reply.status(401).send({ error: 'Unauthorized: invalid or missing bearer token' });
        return;
      }
    }
  });

  const getCurrentAIScope = async () => {
    let scope = await aiScopeStore.getScope();
    if (scope.lockOwner) {
      await saveAtomically(connection => ensureABOwnership(connection));
      const lease = await getABLease(client, scope.lockOwner);
      const batchRows = await client.all('SELECT status FROM ab_trading_batches WHERE id = ?;', scope.lockOwner);
      if (!lease || lease.generation !== AB_SERVICE_GENERATION || lease.expiresAt <= Date.now()
        || !batchRows.length || !['RUNNING', 'PAUSED', 'DRAINING'].includes(batchRows[0].status)) {
        await aiScopeStore.unlockScope(scope.lockOwner).catch(() => {});
        scope = await aiScopeStore.getScope();
      }
    }
    return scope;
  };

  // Register routes after the websocket plugin has installed its onRoute hook.
  app.register(async (routes) => {
  // GET /api/health
  routes.get('/api/health', async () => {
    return {
      status: 'ok',
      uptime: process.uptime(),
      session: sessionManager.getSessionId(),
      writer: writer.getStats(),
      stream: streamManager.getStatus(),
    };
  });

  // GET /api/symbols
  routes.get('/api/symbols', async (req) => {
    const market = ((req.query as any)?.market as string) || 'futures';
    const symbols = universeManager.getSymbols(market as any);
    const coins = FALLBACK_COINS.filter(c => symbols.includes(c.symbol));
    return {
      market,
      symbols,
      coins: coins.length ? coins : FALLBACK_COINS,
    };
  });

  // GET /api/klines
  routes.get('/api/klines', async (req) => {
    const query = req.query as any;
    const market = (query.market as string) || 'futures';
    const symbol = query.symbol || 'BTCUSDT';
    const interval = query.interval || '1h';
    const from = query.from !== undefined ? Number(query.from) : Date.now() - 24 * 3600 * 1000;
    const to = query.to !== undefined ? Number(query.to) : Date.now();
    const limit = query.limit !== undefined ? Number(query.limit) : 500;

    let rows: any[];

    if (interval === '1m') {
      rows = await client.all(
        `SELECT
          open_time / 1000 as time,
          open, high, low, close, volume
         FROM klines_1m
         WHERE market = ? AND symbol = ? AND open_time >= ? AND open_time <= ?
         ORDER BY open_time ASC LIMIT ?;`,
        market, symbol, from, to, limit
      );
    } else {
      // Aggregate from 1m
      const intervalMsMap: Record<string, number> = {
        '3m': 3 * 60 * 1000,
        '5m': 5 * 60 * 1000,
        '15m': 15 * 60 * 1000,
        '30m': 30 * 60 * 1000,
        '1h': 60 * 60 * 1000,
        '2h': 2 * 60 * 60 * 1000,
        '4h': 4 * 60 * 60 * 1000,
        '1d': 24 * 60 * 60 * 1000,
      };
      const bucketMs = intervalMsMap[interval] || 60 * 60 * 1000;

      rows = await client.all(
        `SELECT
          ((open_time // ${bucketMs}) * ${bucketMs}) / 1000 as time,
          arg_min(open, open_time) as open,
          max(high) as high,
          min(low) as low,
          arg_max(close, open_time) as close,
          sum(volume) as volume
         FROM klines_1m
         WHERE market = ? AND symbol = ? AND open_time >= ? AND open_time <= ?
         GROUP BY ((open_time // ${bucketMs}) * ${bucketMs})
         ORDER BY time ASC LIMIT ?;`,
        market, symbol, from, to, limit
      );
    }

    // If local DuckDB has insufficient klines, fetch from Binance REST and store
    if (rows.length === 0) {
      try {
        const restKlines = await fetchHistoricalKlines(market as any, symbol, interval, from, to, limit, requests.signal);
        if (Array.isArray(restKlines)) {
          return restKlines.map((item: any[]) => ({
            time: Math.floor(item[0] / 1000),
            open: parseFloat(item[1]),
            high: parseFloat(item[2]),
            low: parseFloat(item[3]),
            close: parseFloat(item[4]),
            volume: parseFloat(item[5]),
          }));
        }
      } catch (err) {
        console.warn(`Failed to fetch REST klines fallback for ${symbol}:`, err);
      }
    }

    return rows;
  });

  // GET /api/trades (merges hot DuckDB and Parquet cold storage)
  routes.get('/api/trades', async (req) => {
    const query = req.query as any;
    const market = (query.market as string) || 'futures';
    const symbol = query.symbol || 'BTCUSDT';
    const from = query.from !== undefined ? Number(query.from) : 0;
    const to = query.to !== undefined ? Number(query.to) : Date.now();
    const limit = query.limit !== undefined ? Number(query.limit) : 10000;

    const sql = `SELECT symbol, price, qty AS quantity, price * qty AS quoteValue,
      CASE WHEN is_buyer_maker THEN 'sell' ELSE 'buy' END AS side,
      trade_time AS timestamp, last_id AS lastTradeId
      FROM ${tradeSource(dataDir)}
      WHERE market = ? AND symbol = ? AND trade_time >= ? AND trade_time <= ?
      ORDER BY trade_time ASC, agg_id ASC LIMIT ?;`;

    const rows = await client.all(sql, market, symbol, from, to, limit);
    return rows.map((r: any) => ({
      symbol: r.symbol,
      price: Number(r.price),
      quantity: Number(r.quantity),
      quoteValue: Number(r.quoteValue),
      side: r.side,
      timestamp: safeInteger(r.timestamp, 'timestamp'),
      lastTradeId: r.lastTradeId != null ? safeInteger(r.lastTradeId, 'lastTradeId') : undefined,
    }));
  });

  // GET /api/coverage
  routes.get('/api/coverage', async (req) => {
    const query = req.query as any;
    const market = (query.market as string) || 'futures';
    const symbol = query.symbol;

    const gapsSql = symbol
      ? `SELECT * FROM gaps WHERE market = ? AND symbol = ? ORDER BY from_time DESC LIMIT 100;`
      : `SELECT * FROM gaps WHERE market = ? ORDER BY from_time DESC LIMIT 100;`;
    const gapsParams = symbol ? [market, symbol] : [market];

    const gapsList = await client.all(gapsSql, ...gapsParams);

    const countSql = `SELECT strftime(to_timestamp(trade_time / 1000), '%Y-%m-%d') AS date,
      symbol, count(*) AS count FROM ${tradeSource(dataDir)}
      WHERE market = ? ${symbol ? 'AND symbol = ?' : ''}
      GROUP BY date, symbol ORDER BY date DESC LIMIT 30;`;

    const counts = await client.all(countSql, ...gapsParams);

    return {
      market,
      symbol,
      gaps: gapsList,
      dailyCounts: counts,
    };
  });

  // GET /api/stats/summary
  routes.get('/api/stats/summary', async () => {
    const [total] = await client.all<{ cnt: number }>(`SELECT count(*) AS cnt FROM ${tradeSource(dataDir)};`);
    const totalAggTrades = Number(total?.cnt ?? 0);

    const [klineCount] = await client.all<{ cnt: number }>('SELECT count(*) as cnt FROM klines_1m;');
    const [gapCount] = await client.all<{ cnt: number }>('SELECT count(*) as cnt FROM gaps WHERE status = \'open\';');

    const recentSessions = await client.all('SELECT * FROM collection_sessions ORDER BY started_at DESC LIMIT 5;');
    const recentAlerts = await client.all('SELECT * FROM alert_events ORDER BY detected_at DESC LIMIT 10;');

    let diskBytes = 0;
    try {
      const dbFile = path.join(dataDir, 'fadachi.duckdb');
      if (fs.existsSync(dbFile)) {
        diskBytes += fs.statSync(dbFile).size;
      }
      diskBytes += calculateDirSize(path.join(dataDir, 'parquet'));
    } catch {}

    return {
      totalAggTrades,
      totalKlines: klineCount?.cnt ?? 0,
      openGaps: gapCount?.cnt ?? 0,
      diskBytes,
      recentSessions,
      recentAlerts,
    };
  });

  // POST /api/replay (merges DuckDB and Parquet trades)
  routes.post('/api/replay', async (req) => {
    const body = (req.body as any) || {};
    const market = body.market || 'futures';
    const symbol = body.symbol || 'BTCUSDT';
    const from = body.from !== undefined ? Number(body.from) : 0;
    const to = body.to !== undefined ? Number(body.to) : Date.now();
    const limit = body.limit !== undefined ? Number(body.limit) : 20000;

    const sql = `SELECT symbol, price, qty AS quantity, price * qty AS quoteValue,
      CASE WHEN is_buyer_maker THEN 'sell' ELSE 'buy' END AS side,
      trade_time AS timestamp, last_id AS lastTradeId
      FROM ${tradeSource(dataDir)}
      WHERE market = ? AND symbol = ? AND trade_time >= ? AND trade_time <= ?
      ORDER BY trade_time ASC, agg_id ASC LIMIT ?;`;

    const rawTrades = await client.all(sql, market, symbol, from, to, limit);
    const trades = rawTrades.map((r: any) => ({
      symbol: r.symbol,
      price: Number(r.price),
      quantity: Number(r.quantity),
      quoteValue: Number(r.quoteValue),
      side: r.side,
      timestamp: safeInteger(r.timestamp, 'timestamp'),
      lastTradeId: r.lastTradeId != null ? safeInteger(r.lastTradeId, 'lastTradeId') : undefined,
    }));

    const gaps = await client.all<{ symbol: string; from_time: number; to_time: number }>(
      "SELECT symbol, from_time, to_time FROM gaps WHERE market = ? AND symbol = ? AND status <> 'backfilled';",
      market, symbol
    );

    const replayGaps = gaps.map(g => ({
      symbol: g.symbol,
      from: Number(g.from_time),
      to: Number(g.to_time),
    }));

    const result = await runTradeReplay({
      market,
      trades,
      gaps: replayGaps,
      alertSettings: body.alertSettings,
      autoConfig: body.autoConfig,
    });

    return result;
  });

  // POST /api/gaps/backfill
  routes.post('/api/gaps/backfill', async (req) => {
    const body = (req.body as any) || {};
    const gapId = body.gapId;
    let targetGaps: any[];
    if (gapId) {
      targetGaps = await client.all('SELECT * FROM gaps WHERE id = ?;', gapId);
    } else {
      targetGaps = await client.all('SELECT * FROM gaps WHERE status = \'open\';');
    }

    let backfilledCount = 0;
    for (const g of targetGaps) {
      const success = await backfillGap(g, writer, gapDetectors?.get(g.market) ?? gapDetector, requests.signal);
      if (success) backfilledCount++;
    }

    return { total: targetGaps.length, backfilled: backfilledCount, success: backfilledCount === targetGaps.length };
  });

  // GET /api/events/plans
  routes.get('/api/events/plans', async () => {
    return eventsManager.getPlans();
  });

  // Paper trading storage routes
  routes.get('/api/paper/:market', async (req) => {
    const market = (req.params as any).market;
    const rows = await client.all('SELECT * FROM paper_accounts WHERE market = ?;', market);
    if (!rows.length) {
      return { market, balance: 100000, trades: [], history: [] };
    }
    const row = rows[0];
    return {
      market: row.market,
      balance: row.balance,
      trades: JSON.parse(row.trades),
      history: JSON.parse(row.history),
      updatedAt: row.updated_at,
    };
  });

  routes.put('/api/paper/:market', async (req) => {
    const market = (req.params as any).market;
    const body = req.body as any;
    const now = Date.now();
    await client.run(
      `INSERT INTO paper_accounts (market, balance, trades, history, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (market) DO UPDATE SET
         balance = excluded.balance,
         trades = excluded.trades,
         history = excluded.history,
         updated_at = excluded.updated_at;`,
      market,
      body.balance,
      JSON.stringify(body.trades || []),
      JSON.stringify(body.history || []),
      now
    );
    return { success: true };
  });

  // Auto trading batches routes
  routes.get('/api/auto/batches', async (req) => {
    const market = (req.query as any)?.market;
    const sql = market
      ? 'SELECT * FROM auto_batches WHERE market = ? ORDER BY updated_at DESC;'
      : 'SELECT * FROM auto_batches ORDER BY updated_at DESC;';
    const params = market ? [market] : [];
    const rows = await client.all(sql, ...params);
    return rows.map(r => ({
      id: r.id,
      market: r.market,
      status: r.status,
      snapshot: JSON.parse(r.snapshot),
      updatedAt: r.updated_at,
    }));
  });

  routes.put('/api/auto/batches', async (req) => {
    const body = req.body as any;
    const now = Date.now();
    await client.run(
      `INSERT INTO auto_batches (id, market, status, snapshot, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         status = excluded.status,
         snapshot = excluded.snapshot,
         updated_at = excluded.updated_at;`,
      body.id,
      body.market || body.snapshot?.marketType || 'futures',
      body.status || body.snapshot?.status || 'IDLE',
      JSON.stringify(body.snapshot || body),
      now
    );
    return { success: true };
  });

  // POST /api/migrate/browser
  routes.post('/api/migrate/browser', async (req) => {
    const body = req.body as any;
    let migratedPaper = 0;
    let migratedBatches = 0;
    const now = Date.now();

    if (body.paper) {
      for (const m of ['spot', 'futures'] as const) {
        if (body.paper[m]) {
          const p = body.paper[m];
          await client.run(
            `INSERT INTO paper_accounts (market, balance, trades, history, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (market) DO UPDATE SET
               balance = excluded.balance,
               trades = excluded.trades,
               history = excluded.history,
               updated_at = excluded.updated_at;`,
            m,
            p.balance ?? 100000,
            JSON.stringify(p.trades || []),
            JSON.stringify(p.history || []),
            now
          );
          migratedPaper++;
        }
      }
    }

    if (Array.isArray(body.batches)) {
      for (const batch of body.batches) {
        if (batch?.id) {
          await client.run(
            `INSERT INTO auto_batches (id, market, status, snapshot, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET
               status = excluded.status,
               snapshot = excluded.snapshot,
               updated_at = excluded.updated_at;`,
            batch.id,
            batch.marketType || batch.market || 'futures',
            batch.status || 'COMPLETED',
            JSON.stringify(batch),
            now
          );
          migratedBatches++;
        }
      }
    }

    return { migratedPaper, migratedBatches, success: true };
  });

  // AI Analysis Center Routes
  routes.get('/api/ai/status', async (req, reply) => {
    const query = (req.query as any) || {};
    const configured = await getCurrentAIScope();
    const market = (query.market as 'spot' | 'futures') || configured.market;
    const model = (query.model as string) || configured.model;
    const quota = await cliRunner.getQuotaStatus();
    const isolationVerified = await cliRunner.verifyIsolation();
    const providerStatus = await cliRunner.getProviderStatus();
    const models = providerStatus.models;
    const trackedSymbols = query.symbols
      ? [...new Set(String(query.symbols).split(',').map((symbol: string) => symbol.trim().toUpperCase()).filter(Boolean))]
      : configured.market === market ? configured.symbols : universeManager.getSymbols(market).slice(0, 10);
    if ((query.symbols && !trackedSymbols.length) || trackedSymbols.length > 10
      || trackedSymbols.some((symbol: string) => !/^[A-Z0-9]{2,20}$/.test(symbol))) {
      return reply.status(400).send({ error: 'status scope must contain 1 to 10 valid symbols' });
    }
    const latestAnalyses: Record<string, any> = {};

    for (const sym of trackedSymbols) {
      const rows = await client.all(
        'SELECT payload FROM ai_analysis_results WHERE symbol = ? AND market = ? AND model = ? ORDER BY generated_at DESC LIMIT 1;',
        sym, market, model,
      );
      if (rows.length) latestAnalyses[sym] = JSON.parse(rows[0].payload);
    }

    return {
      market,
      quota,
      models,
      isolationVerified,
      isolationReason: providerStatus.reason,
      trackedSymbols,
      model,
      scope: configured,
      latestAnalyses,
    };
  });

  routes.get('/api/ai/scope', async () => getCurrentAIScope());

  routes.put('/api/ai/scope', async (req, reply) => {
    const body = req.body as any;
    try {
      return await aiScopeStore.setScope({ market: body.market, symbols: body.symbols, model: body.model });
    } catch (error) {
      return reply.status(409).send({ error: error instanceof Error ? error.message : 'AI scope update failed' });
    }
  });

  routes.post('/api/ai/scope/lock', async (req, reply) => {
    const body = req.body as any;
    try { return { scope: await aiScopeStore.lockScope(body.owner) }; }
    catch (error) { return reply.status(409).send({ error: error instanceof Error ? error.message : 'AI scope lock failed' }); }
  });

  routes.post('/api/ai/scope/unlock', async (req, reply) => {
    const body = req.body as any;
    try { await aiScopeStore.unlockScope(body.owner); return { success: true }; }
    catch (error) { return reply.status(409).send({ error: error instanceof Error ? error.message : 'AI scope unlock failed' }); }
  });

  routes.get('/api/ai/history', async (req) => {
    const query = (req.query as any) || {};
    const symbol = query.symbol;
    const market = query.market;
    const limit = query.limit ? Number(query.limit) : 50;
    return cliRunner.getAnalysisHistory(symbol, market, limit);
  });

  routes.post('/api/ai/trigger', async (req, reply) => {
    const body = (req.body as any) || {};
    const configured = await getCurrentAIScope();
    const symbols = body.symbols ? [...new Set(body.symbols.map((item: string) => item.trim().toUpperCase()))] : [body.symbol];
    const market = body.market || configured.market;
    const model = body.model || configured.model;
    const isEventTrigger = Boolean(body.isEventTrigger);

    try {
      if (!await cliRunner.verifyIsolation()) {
        return reply.status(503).send({ error: 'AI CLI 隔離環境未通過驗證或尚未登入；Provider 已停用，沒有可用模型 fallback' });
      }
      if (!cliRunner.getAvailableModels().includes(model)) return reply.status(400).send({ error: `目前隔離 profile 不提供模型：${model}` });
      if (configured.locked && (configured.market !== market || configured.model !== model
        || (body.symbols && JSON.stringify(configured.symbols) !== JSON.stringify(symbols)))) {
        return reply.status(409).send({ error: 'A/B 批次進行中，market、symbols、model 已鎖定' });
      }
      if (!symbols.length || symbols.length > 10 || symbols.some((symbol: string) => typeof symbol !== 'string' || !/^[A-Z0-9]{2,20}$/.test(symbol))) {
        return reply.status(400).send({ error: 'symbols 必須包含 1 到 10 個有效標的' });
      }
      const snapshots = await Promise.all(symbols.map((symbol: string) => aiAggregator.buildSnapshot(symbol, market)));
      const analyses = await cliRunner.runBatchAnalysis(snapshots, model, isEventTrigger);
      if (body.symbols) return { success: true, analyses: analyses ?? [], snapshots };
      return { success: true, analysis: analyses?.[0] ?? null, snapshot: snapshots[0] };
    } catch (err: any) {
      reply.status(400).send({ error: err.message || 'AI 分析觸發失敗' });
    }
  });

  routes.get('/api/ai/snapshots/:id', async (req, reply) => {
    const id = (req.params as any).id;
    const snapshot = await aiAggregator.getSnapshot(id);
    if (!snapshot) return reply.status(404).send({ error: 'Snapshot not found' });
    return snapshot;
  });

  // A/B Comparison Batches Routes
  routes.get('/api/ab/batches', async (req, reply) => {
    const market = (req.query as any)?.market;
    const limit = (req.query as any)?.limit ? Number((req.query as any).limit) : 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return reply.status(400).send({ error: 'limit must be an integer between 1 and 200' });
    }
    const sql = market
      ? 'SELECT * FROM ab_trading_batches WHERE market = ? ORDER BY started_at DESC LIMIT ?;'
      : 'SELECT * FROM ab_trading_batches ORDER BY started_at DESC LIMIT ?;';
    const params = market ? [market, limit] : [limit];
    await saveAtomically(connection => ensureABOwnership(connection));
    const rows = await client.all(sql, ...params);
    const now = Date.now();
    const result = await Promise.all(rows.map(async (r: any) => {
      const lease = await getABLease(client, r.id);
      const batch = parseWithInfinity(r.payload);
      const active = ['RUNNING', 'PAUSED', 'DRAINING'].includes(batch.status);
      return {
      id: r.id,
      market: r.market,
      status: r.status,
      revision: Number(r.revision),
      model: r.model,
      startedAt: Number(r.started_at),
      endedAt: r.ended_at ? Number(r.ended_at) : undefined,
      batch,
      ownerActive: active && lease?.generation === AB_SERVICE_GENERATION && lease.expiresAt > now,
      updatedAt: Number(r.updated_at),
    }; }));
    reply.type('application/json').send(stringifyWithInfinity(result));
  });

  routes.get('/api/ab/batches/:id', async (req, reply) => {
    const id = (req.params as any).id;
    const rows = await client.all('SELECT * FROM ab_trading_batches WHERE id = ?;', id);
    if (!rows.length) return reply.status(404).send({ error: 'A/B batch not found' });
    const r = rows[0];
    await saveAtomically(connection => ensureABOwnership(connection));
    const lease = await getABLease(client, id);
    const batch = parseWithInfinity(r.payload);
    const result = {
      id: r.id,
      market: r.market,
      status: r.status,
      revision: Number(r.revision),
      model: r.model,
      startedAt: Number(r.started_at),
      endedAt: r.ended_at ? Number(r.ended_at) : undefined,
      batch,
      ownerActive: ['RUNNING', 'PAUSED', 'DRAINING'].includes(batch.status)
        && lease?.generation === AB_SERVICE_GENERATION && lease.expiresAt > Date.now(),
      updatedAt: Number(r.updated_at),
    };
    reply.type('application/json').send(stringifyWithInfinity(result));
  });

  routes.post('/api/ab/batches/:id/claim', async (req) => {
    const id = (req.params as any).id as string;
    const now = Date.now();
    const result = await saveAtomically(async connection => {
      await ensureABOwnership(connection);
      const rows = await connection.all('SELECT * FROM ab_trading_batches WHERE id = ?;', id);
      const batchRow = rows[0];
      if (batchRow && !['RUNNING', 'PAUSED', 'DRAINING'].includes(batchRow.status)) {
        return { owner: false, expiresAt: 0, batch: parseWithInfinity(batchRow.payload) };
      }
      const claim = await claimABLease(connection, id, AB_SERVICE_GENERATION, now);
      if (claim.owner === false) {
        const batch = batchRow ? parseWithInfinity(batchRow.payload) : undefined;
        return { owner: false, expiresAt: claim.expiresAt, batch };
      }
      let batch;
      if (batchRow) {
        batch = parseWithInfinity(batchRow.payload);
        const coordinator = new ABComparisonCoordinator(batch.marketType);
        coordinator.restoreInterrupted(batch, now);
        batch = coordinator.snapshot();
        const payload = stringifyWithInfinity(batch);
        await connection.run(
          `UPDATE ab_trading_batches SET status = ?, revision = ?, ended_at = ?, payload = ?, updated_at = ? WHERE id = ?;`,
          batch.status, batch.revision, batch.endedAt ?? now, payload, now, id
        );
      }
      return { owner: true, ownerToken: claim.lease.ownerToken, generation: claim.lease.generation, expiresAt: claim.lease.expiresAt, batch };
    });
    if (result?.owner && result.batch && !['RUNNING', 'PAUSED', 'DRAINING'].includes(result.batch.status)) {
      const scope = await aiScopeStore.getScope();
      if (scope.lockOwner === id) await aiScopeStore.unlockScope(id).catch(() => {});
    }
    return result;
  });

  routes.post('/api/ab/batches/:id/lease', async (req, reply) => {
    const id = (req.params as any).id as string;
    const body = req.body as any;
    const renewed = await saveAtomically(async connection => {
      await ensureABOwnership(connection);
      return renewABLease(connection, id, body?.ownerToken, body?.generation, Date.now());
    });
    if (!renewed) return reply.status(409).send({ error: 'A/B owner lease expired or was fenced' });
    return { success: true, expiresAt: Date.now() + 15_000 };
  });

  routes.put('/api/ab/batches', async (req, reply) => {
    const body = req.body as any;
    const id = body.id;
    const market = body.market || body.batch?.marketType || 'futures';
    const status = body.status || body.batch?.status || 'IDLE';
    const revision = Number(body.revision ?? body.batch?.revision ?? 0);
    const model = body.model || body.batch?.model;
    const ownerToken = body.ownerToken;
    const generation = body.generation;
    const startedAt = Number(body.batch?.startedAt ?? Date.now());
    const endedAt = body.batch?.endedAt ? Number(body.batch.endedAt) : null;
    const now = Date.now();

    const batch = restoreInfinityInOrders(body.batch || body);
    if (batch.id !== id || batch.marketType !== market || batch.revision !== revision
      || typeof model !== 'string' || !model.trim() || batch.model !== model || batch.status !== status || !Number.isSafeInteger(revision) || revision < 0
      || !Array.isArray(batch.decisions) || !batch.accountA || !batch.accountB) {
      return reply.status(400).send({ error: 'A/B batch metadata is inconsistent or incomplete' });
    }
    const decisionIds = new Set<string>();
    for (const dec of batch.decisions) {
      if (!dec.id || decisionIds.has(dec.id) || dec.batchId !== id || dec.marketType !== market) {
        return reply.status(400).send({ error: 'A/B decision identity is inconsistent' });
      }
      decisionIds.add(dec.id);
    }
    const payload = stringifyWithInfinity(batch);

    return saveAtomically(async connection => {
      await ensureABOwnership(connection);
      if (!ownerToken || generation !== AB_SERVICE_GENERATION
        || !await ownsABLease(connection, id, ownerToken, generation, now)) {
        return reply.status(409).send({ error: 'A/B owner lease missing, expired, or fenced' });
      }
      // Check and write inside one reserved transaction. Exact retries are safe,
      // but equal revisions with different content must never overwrite a writer.
      const existing = await connection.all('SELECT revision, payload FROM ab_trading_batches WHERE id = ?;', id);
      if (existing.length) {
        const currentRevision = Number(existing[0].revision);
        if (currentRevision === revision && existing[0].payload === payload) return { success: true, id, revision };
        if (currentRevision >= revision) {
          return reply.status(409).send({ error: 'Conflict: outgoing revision is stale', currentRevision });
        }
        const previous = parseWithInfinity(existing[0].payload);
        for (const key of ['marketType', 'startedAt', 'config', 'selectedCoins', 'model', 'promptVersion', 'ruleVersion']) {
          if (stringifyWithInfinity(previous[key]) !== stringifyWithInfinity(batch[key])) {
            return reply.status(409).send({ error: `A/B batch setting is locked: ${key}` });
          }
        }
        const decisions = new Map(batch.decisions.map((dec: any) => [dec.id, JSON.stringify(dec)]));
        if (previous.decisions.some((dec: any) => decisions.get(dec.id) !== JSON.stringify(dec))) {
          return reply.status(409).send({ error: 'Previously saved decisions are immutable' });
        }
      }
      await connection.run(
        `INSERT INTO ab_trading_batches (id, market, status, revision, model, started_at, ended_at, payload, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           status = excluded.status,
           revision = excluded.revision,
           model = excluded.model,
           ended_at = excluded.ended_at,
           payload = excluded.payload,
           updated_at = excluded.updated_at;`,
        id, market, status, revision, model, startedAt, endedAt, payload, now
      );

      // Persist entry decisions to ai_entry_decisions table
      if (Array.isArray(batch.decisions)) {
        for (const dec of batch.decisions) {
          const owner = await connection.all('SELECT batch_id FROM ai_entry_decisions WHERE id = ?;', dec.id);
          if (owner.length && owner[0].batch_id !== id) throw new Error('Decision belongs to another A/B batch');
          await connection.run(
            `INSERT INTO ai_entry_decisions (id, batch_id, plan_id, symbol, market, account, allowed, reason, analysis_id, timestamp, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET
               allowed = excluded.allowed,
               reason = excluded.reason,
               analysis_id = excluded.analysis_id,
               payload = excluded.payload;`,
            dec.id,
            id,
            dec.planId,
            dec.symbol,
            dec.marketType || market,
            dec.account,
            dec.allowed,
            dec.reason,
            dec.analysisId ?? null,
            dec.timestamp,
            JSON.stringify(dec)
          );
        }
      }

      return { success: true, id, revision };
    });
  });

  routes.get('/api/ab/batches/:id/decisions', async (req, reply) => {
    const id = (req.params as any).id;
    const rows = await client.all('SELECT payload FROM ai_entry_decisions WHERE batch_id = ? ORDER BY timestamp ASC;', id);
    const decisions = rows.map((r: any) => JSON.parse(r.payload));
    reply.type('application/json').send(JSON.stringify(decisions));
  });

  routes.get('/api/ab/batches/:id/export.csv', async (req, reply) => {
    const id = (req.params as any).id;
    const rows = await client.all('SELECT payload FROM ab_trading_batches WHERE id = ?;', id);
    if (!rows.length) return reply.status(404).send({ error: 'A/B batch not found' });
    const batch = parseWithInfinity(rows[0].payload);
    const incomplete = (account: any) => account.fundingStatus === 'PENDING' || account.fundingStatus === 'ERROR'
      || account.positions.length > 0 || account.orders.length > 0 || account.trades.some((trade: any) => trade.incomplete)
      || account.status === 'INTERRUPTED';
    const latestA = batch.accountA.equity.at(-1)?.timestamp ?? batch.startedAt;
    const latestB = batch.accountB.equity.at(-1)?.timestamp ?? batch.startedAt;
    const cutoff = new Date(Math.min(latestA, latestB)).toISOString();
    const metadata = [
      'batch_metadata,field,value',
      `batch_metadata,common_cutoff_utc,${cutoff}`,
      `batch_metadata,account_a_funding_status,${batch.accountA.fundingStatus}`,
      `batch_metadata,account_a_incomplete,${incomplete(batch.accountA)}`,
      `batch_metadata,account_b_funding_status,${batch.accountB.fundingStatus}`,
      `batch_metadata,account_b_incomplete,${incomplete(batch.accountB)}`,
      `batch_metadata,pair_cost_status,${incomplete(batch.accountA) || incomplete(batch.accountB) ? 'PROVISIONAL' : 'COMPLETE'}`,
      '',
    ].join('\r\n');
    const csv = metadata + ABComparisonCoordinator.exportCsvFromBatch(batch);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="ab-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.csv"`);
    return csv;
  });

  // Model Research Routes (LightGBM Ranking + Kronos Forecasting)
  routes.get('/api/research/status', async () => {
    return researchRunner.getStatus();
  });

  routes.get('/api/research/latest', async () => {
    const latest = await researchRunner.getLatestResult();
    if (!latest) {
      return {
        status: 'EMPTY',
        validityStatus: 'EMPTY',
        isExpired: false,
        result: null,
      };
    }
    return {
      ...latest,
      result: latest,
    };
  });

  routes.post('/api/research/run', async (req, reply) => {
    const body = (req.body as any) || {};
    if (body.market && body.market !== 'futures') {
      return reply.status(400).send({
        error: '模型選幣研究僅支援 Binance USDT 永續合約（futures），不支援現貨模式',
      });
    }
    if (body.kronosModel !== undefined && body.kronosModel !== 'small' && body.kronosModel !== 'base') {
      return reply.status(400).send({ error: 'kronosModel 必須為 small 或 base' });
    }
    if (body.cutoffTime !== undefined && (
      typeof body.cutoffTime !== 'number' || !Number.isSafeInteger(body.cutoffTime)
      || body.cutoffTime < 0 || body.cutoffTime > Date.now()
    )) {
      return reply.status(400).send({ error: 'cutoffTime 必須為非負且不晚於目前時間的整數毫秒時間戳' });
    }
    const kronosModel = body.kronosModel === 'base' ? 'base' : 'small';
    try {
      const job = researchRunner.startRunJob({
        kronosModel,
        cutoffTime: body.cutoffTime !== undefined ? Number(body.cutoffTime) : undefined,
      });
      return {
        jobId: job.jobId,
        runId: job.runId,
        status: job.status,
        kronosModel: job.kronosModel,
        startedAt: job.startedAt,
      };
    } catch (err) {
      if (err instanceof ModelResearchBusyError) {
        return reply.status(409).send({
          error: err.message,
          activeJobId: err.activeJobId,
        });
      }
      return reply.status(500).send({
        error: err instanceof Error ? err.message : '啟動模型推論工作失敗',
      });
    }
  });

  routes.get('/api/research/jobs/:id', async (req, reply) => {
    const id = (req.params as any).id as string;
    const job = researchRunner.getJob(id);
    if (!job) {
      return reply.status(404).send({ error: '找不到指定的研究推論工作 (Job not found)' });
    }
    return job;
  });

  // WS /live
  routes.get('/live', { websocket: true }, (socket, req) => {
    const market = ((req.query as any)?.market as 'spot' | 'futures') || 'futures';
    liveHub.addClient(socket as any, market);
  });
  });

  return app;
}
