import path from 'node:path';
import fs from 'node:fs';
import { createDuckDBClient, initDatabase } from './storage/duckdb.ts';
import { StorageWriter } from './storage/writer.ts';
import { LiveHub } from './live/hub.ts';
import { GapDetector } from './gaps/gapDetector.ts';
import { SessionManager } from './gaps/sessions.ts';
import { BinanceStreamManager } from './binance/streams.ts';
import type { MarketType } from './binance/streams.ts';
import { UniverseManager } from './ingest/universe.ts';
import { CollectorEventsManager } from './events/collectorEvents.ts';
import { createServer } from './api/server.ts';
import { flushAggTradesToParquet } from './storage/parquetFlush.ts';
import { backfillGap } from './gaps/restBackfill.ts';
import { collectorIPC } from './ipc.ts';
import { AIDataAggregator } from './ai/aiDataAggregator.ts';
import { AICLIRunner } from './ai/cliRunner.ts';
import { AIScheduler } from './ai/aiScheduler.ts';
import { AIScopeStore } from './ai/scopeStore.ts';
import { OllamaAnalysisRunner } from './ai/ollamaRunner.ts';
import { FourGroupService } from './ai/fourGroupService.ts';
import { ModelResearchRunner } from './research/modelResearchRunner.ts';
import { TradeBus } from './modelPaper/tradeBus.ts';
import { RollingModelPipeline } from './modelPaper/rollingPipeline.ts';
import { ModelPaperService, loadResearchUniverse } from './modelPaper/service.ts';

export function resolveDataDir(startDir = process.cwd()): string {
  if (process.env.FADACHI_DATA) {
    return path.resolve(process.env.FADACHI_DATA);
  }
  const current = path.resolve(startDir);
  const rootData = path.resolve(current, '..', '..', 'data');
  const localData = path.resolve(current, 'data');
  if (fs.existsSync(path.join(localData, 'fadachi.duckdb'))) {
    return localData;
  }
  if (fs.existsSync(rootData)) {
    return rootData;
  }
  return localData;
}

async function bootstrap() {
  const dataDir = resolveDataDir();
  // In dev/browser mode default to 4321; Electron passes FADACHI_PORT='0' for random ephemeral port
  const port = parseInt(process.env.FADACHI_PORT ?? '4321', 10);
  const token = process.env.FADACHI_TOKEN;
  const targetMarkets: MarketType[] = process.env.FADACHI_MARKET
    ? [process.env.FADACHI_MARKET as MarketType]
    : ['futures', 'spot'];

  if (!Number.isInteger(port) || port < 0 || port > 65535 || targetMarkets.some(m => !['spot', 'futures'].includes(m))) {
    throw new Error('Invalid collector port or market');
  }

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = path.join(dataDir, 'fadachi.duckdb');
  console.log(`[Collector] Initializing DuckDB at ${dbPath}`);

  const duckClient = await createDuckDBClient(dbPath);

  const writer = new StorageWriter(duckClient);


  const liveHub = new LiveHub();
  const universeManager = new UniverseManager(duckClient, 50);

  const sessionManagers: SessionManager[] = [];
  const gapDetectors = new Map<MarketType, GapDetector>();
  const eventsManagers = new Map<MarketType, CollectorEventsManager>();
  const streamManagers: BinanceStreamManager[] = [];

  const controller = new AbortController();
  writer.setOverflowHandler((kind, depth) => {
    console.error(`[Collector] ${kind} storage queue overflow at ${depth}; shutting down to preserve a detectable data gap`);
    controller.abort();
    void shutdown('storage_overflow', 1);
  });
  const ipc = collectorIPC();
  const background = new Set<Promise<unknown>>();
  const track = (job: Promise<unknown>) => {
    background.add(job);
    void job.catch(err => console.error('[Collector] Background task failed:', err))
      .finally(() => background.delete(job));
  };
  let server: ReturnType<typeof createServer> | undefined;
  let hourlyTimer: NodeJS.Timeout | undefined;
  let aiScheduler: AIScheduler | undefined;
  let aiAggregator: AIDataAggregator | undefined;
  const researchRunner = new ModelResearchRunner({ dataDir });
  const tradeBus = new TradeBus();
  const researchUniverse = loadResearchUniverse(researchRunner.dataDir);
  if (researchUniverse.error) {
    console.warn(`[Collector] ModelPaper universe unavailable: ${researchUniverse.error}`);
  }
  const rollingPipeline = new RollingModelPipeline({
    runner: researchRunner,
    dataDir: researchRunner.dataDir,
    workspaceRoot: researchRunner.workspaceRoot,
    autoHourlyEnabled: true,
    autoLgbmHourlyEnabled: true,
    chronosTrainingPaused: true,
    runOnStart: true,
    retrainIntervalHours: 6,
  });
  researchRunner.attachRollingPipeline(rollingPipeline);
  let ollamaRunner: OllamaAnalysisRunner | undefined;
  let modelPaperService: ModelPaperService | undefined;
  let fourGroupService: FourGroupService | undefined;
  const start = async () => {
    await initDatabase(duckClient, path.resolve(import.meta.dirname, 'storage', 'schema.sql'));
    controller.signal.throwIfAborted();
    writer.start();
  aiAggregator = new AIDataAggregator({ client: duckClient });
  const aiScopeStore = new AIScopeStore(duckClient, {
    market: targetMarkets.includes('futures') ? 'futures' : 'spot',
    symbols: ['BTCUSDT', 'ETHUSDT'],
    model: '',
  });
  await aiScopeStore.initialize();
  const cliRunner = new AICLIRunner({ client: duckClient });
  await cliRunner.verifyIsolation();
  ollamaRunner = new OllamaAnalysisRunner({ client: duckClient });
  aiScheduler = new AIScheduler({
    aggregator: aiAggregator,
    cliRunner,
    scopeStore: aiScopeStore,
    signal: controller.signal,
  });

  for (const market of targetMarkets) {
    const sm = new SessionManager(duckClient, market);
    sessionManagers.push(sm);
    await sm.start();

    const gd = new GapDetector(duckClient, market, dataDir);
    await gd.init();
    gapDetectors.set(market, gd);

    const em = new CollectorEventsManager(duckClient, market, (alert) => {
      if (alert.type === 'pump' || alert.type === 'dump') {
        track(aiScheduler.triggerEventUpdate(alert.symbol, alert.type === 'pump' ? '急漲' : '急跌'));
      }
    });
    eventsManagers.set(market, em);

    console.log(`[Collector] Updating universe symbols for ${market}...`);
    const symbols = await universeManager.updateUniverse(market);

    controller.signal.throwIfAborted();
    const streamNameSet = new Set<string>();
    if (market === 'futures') {
      streamNameSet.add('!ticker@arr');
    } else {
      symbols.forEach(s => streamNameSet.add(`${s.toLowerCase()}@ticker`));
    }

    const pipelineUniverse = rollingPipeline.getStatus().universeSymbols;
    const aggTradeSymbols = market === 'futures'
      ? Array.from(new Set([...symbols, ...researchUniverse.symbols, ...pipelineUniverse]))
      : symbols;
    aggTradeSymbols.forEach(s => {
      streamNameSet.add(`${s.toLowerCase()}@aggTrade`);
    });
    symbols.forEach(s => {
      streamNameSet.add(`${s.toLowerCase()}@kline_1m`);
    });
    const streamNames = Array.from(streamNameSet);

    const streamManager = new BinanceStreamManager(market, streamNames, {
      onMessage: (payload, receivedAt) => {
        if (controller.signal.aborted) return;
        const data = payload?.data ?? payload;

        // Handle ticker array or single ticker
        if (Array.isArray(data)) {
          for (const item of data) {
            if (item?.e === '24hrTicker' && item.s?.endsWith('USDT')) {
              liveHub.pushTicker(market, {
                symbol: item.s,
                price: parseFloat(item.c),
                priceChangePercent: parseFloat(item.P),
                high: parseFloat(item.h),
                low: parseFloat(item.l),
                volume: parseFloat(item.v),
                quoteVolume: parseFloat(item.q),
                open: parseFloat(item.o),
                priceSource: 'ticker',
                priceTimestamp: item.E,
                receivedAt,
              });
            }
          }
          return;
        }

        if (!data || typeof data !== 'object') return;

        // Handle spot individual ticker
        if (data.e === '24hrTicker' && data.s?.endsWith('USDT')) {
          liveHub.pushTicker(market, {
            symbol: data.s,
            price: parseFloat(data.c),
            priceChangePercent: parseFloat(data.P),
            high: parseFloat(data.h),
            low: parseFloat(data.l),
            volume: parseFloat(data.v),
            quoteVolume: parseFloat(data.q),
            open: parseFloat(data.o),
            priceSource: 'ticker',
            priceTimestamp: data.E,
            receivedAt,
          });
          return;
        }

        // 1. aggTrade
        if (data.e === 'aggTrade' && data.s?.endsWith('USDT')) {
          const symbol = data.s;
          const price = Number(data.p);
          const qty = Number(data.q);
          const aggId = Number(data.a);
          const tradeTime = Number(data.T);
          const isBuyerMaker = Boolean(data.m);

          if (Number.isFinite(price) && Number.isFinite(qty) && price > 0 && qty > 0
              && Number.isSafeInteger(aggId) && aggId >= 0 && Number.isSafeInteger(tradeTime) && tradeTime >= 0) {
            if (!writer.pushAggTrade({
              market,
              symbol,
              agg_id: aggId,
              price,
              qty,
              first_id: Number.isSafeInteger(data.f) ? data.f : null,
              last_id: Number.isSafeInteger(data.l) ? data.l : null,
              trade_time: tradeTime,
              recv_time: receivedAt,
              is_buyer_maker: isBuyerMaker,
              source: 'ws',
            })) return;

            const tradeObj = {
              symbol,
              price,
              quantity: qty,
              quoteValue: price * qty,
              side: (isBuyerMaker ? 'sell' : 'buy') as 'buy' | 'sell',
              timestamp: tradeTime,
              lastTradeId: Number.isSafeInteger(data.l) ? data.l : undefined,
            };

            liveHub.broadcastTrade(tradeObj, market);

            liveHub.pushTicker(market, {
              symbol,
              price,
              priceSource: 'trade',
              priceTimestamp: tradeTime,
              receivedAt,
            });

            if (market === 'futures') {
              tradeBus.emitTrade({
                symbol,
                price,
                qty,
                aggId,
                tradeTime,
                receivedAt,
                side: tradeObj.side,
                lastTradeId: tradeObj.lastTradeId,
              });
            }

            track(em.processTrade(tradeObj, receivedAt));

            track(gd.checkAggTrade(symbol, aggId, tradeTime).then(async (gap) => {
              if (gap) await backfillGap(gap, writer, gd, controller.signal);
            }));
          }
        }

        // 2. kline
        if (data.e === 'kline' && data.k) {
          const k = data.k;
          const symbol = data.s;
          const openTime = Number(k.t);
          const open = Number(k.o);
          const high = Number(k.h);
          const low = Number(k.l);
          const close = Number(k.c);
          const volume = Number(k.v);
          const isFinal = Boolean(k.x);

          if ([open, high, low, close, volume, Number(k.q)].every(Number.isFinite)
              && close > 0 && open > 0 && high >= low && low > 0 && volume >= 0
              && Number.isSafeInteger(openTime) && openTime >= 0 && typeof symbol === 'string') {
            if (!writer.pushKline({
              market,
              symbol,
              open_time: openTime,
              open,
              high,
              low,
              close,
              volume,
              quote_volume: Number(k.q),
              trades: k.n,
              taker_buy_base: Number(k.V),
              taker_buy_quote: Number(k.Q),
              is_final: isFinal,
              source: 'ws',
            })) return;

            liveHub.broadcastKline(symbol, {
              time: Math.floor(openTime / 1000),
              open,
              high,
              low,
              close,
              volume,
              lastTradeId: k.L,
            }, market);
          }
        }
      },
      onStatusChange: (status) => {
        liveHub.broadcastStatus(status, market);
        if (market === 'futures') {
          tradeBus.emitStatus(status);
        }
      },
    });

    streamManagers.push(streamManager);
  }

  controller.signal.throwIfAborted();
  if (targetMarkets.includes('futures')) {
    aiAggregator.derivatives.startLiquidationStream();
  }
  streamManagers.forEach(manager => manager.start());
  modelPaperService = new ModelPaperService({
    client: duckClient,
    dataDir: researchRunner.dataDir,
    workspaceRoot: researchRunner.workspaceRoot,
    runner: researchRunner,
    tradeBus,
    rollingPipeline,
    universeSymbols: researchUniverse.symbols,
    available: !researchUniverse.error && researchUniverse.symbols.length >= 10,
    availabilityReason: researchUniverse.error,
  });
  await modelPaperService.start();
  fourGroupService = new FourGroupService({
    client: duckClient,
    tradeBus,
    rollingPipeline,
    aiAggregator,
    ollamaRunner,
  });
  await fourGroupService.start();
  rollingPipeline.start();
  controller.signal.throwIfAborted();

  // Hourly Parquet flush
  hourlyTimer = setInterval(() => {
    const oneHourAgo = Date.now() - 3600 * 1000;
    track(flushAggTradesToParquet(duckClient, dataDir, oneHourAgo));
  }, 3600 * 1000);

  // API Server (uses primary futures managers for defaults)
  const primaryGd = gapDetectors.get('futures') || gapDetectors.values().next().value!;
  const primarySm = sessionManagers[0];
  const primaryEm = eventsManagers.get('futures') || eventsManagers.values().next().value!;
  const primaryStreamManager = streamManagers[0];

  server = createServer({
    client: duckClient,
    writer,
    liveHub,
    gapDetector: primaryGd,
    gapDetectors,
    sessionManager: primarySm,
    streamManager: primaryStreamManager,
    universeManager,
    eventsManager: primaryEm,
    dataDir,
    token,
    aiAggregator,
    cliRunner,
    ollamaRunner,
    researchRunner,
    tradeBus,
    modelPaperService,
    fourGroupService,
    rollingPipeline,
  });

  const address = await server.listen({ port, host: '127.0.0.1' });
  const actualPort = (server.server.address() as any)?.port;
  console.log(`[Collector] Server listening at ${address} (port: ${actualPort})`);

  aiScheduler.start();

  // Electron utilityProcess communication
  controller.signal.throwIfAborted();
  ipc.send({ type: 'ready', port: actualPort });

  };
  const starting = start();
  let stopping: Promise<void> | undefined;
  const shutdown = (reason: string, exitCode = 0): Promise<void> => {
    stopping ??= (async () => {
      controller.abort();
      if (aiScheduler) await aiScheduler.stop();
      await starting.catch(() => {});
      const failures: unknown[] = [];
      const attempt = async (work: () => Promise<unknown>) => {
        try { await work(); } catch (err) { failures.push(err); console.error('[Collector] Shutdown error:', err); }
      };
      if (fourGroupService) await attempt(() => fourGroupService!.stop());
      if (modelPaperService) await attempt(() => modelPaperService!.stop());
      ollamaRunner?.close();
      researchRunner.close();
      await attempt(() => rollingPipeline.stop());
      if (hourlyTimer) clearInterval(hourlyTimer);
      streamManagers.forEach(manager => manager.stop());
      aiAggregator?.derivatives.stop();
      liveHub.close();
      if (server) await attempt(() => server!.close());
      await Promise.allSettled([...background]);
      let drained = false;
      await attempt(async () => { await writer.stop(); drained = true; });
      if (drained) await attempt(() => flushAggTradesToParquet(duckClient, dataDir, Date.now()));
      for (const manager of sessionManagers) await attempt(() => manager.stop(failures.length ? 'shutdown_error' : reason));
      await attempt(() => duckClient.close());
      removeMessageListener();
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
      ipc.send({ type: failures.length ? 'shutdown-error' : 'flushed' });
      process.exit(failures.length ? 1 : exitCode);
    })();
    return stopping;
  };
  const onInterrupt = () => { void shutdown('sigint'); };
  const onTerminate = () => { void shutdown('sigterm'); };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  const removeMessageListener = ipc.onMessage((message) => {
    if (message?.type === 'shutdown') void shutdown('electron_quit');
  });
  await starting.catch(async (err) => {
    console.error('[Collector] Startup failed:', err);
    await shutdown('startup_error', 1);
  });
}

bootstrap().catch((err) => {
  console.error('[Collector] Fatal startup error:', err);
  process.exit(1);
});
