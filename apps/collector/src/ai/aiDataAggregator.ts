import type { DuckDBClient } from '../storage/duckdb.ts';
import type { MarketType, KlineData } from '@fadachi/core';
import {
  createAIDataSnapshot,
  indicatorBundle,
  calculateEMASeries,
} from '@fadachi/core';
import type { AIDataSnapshot } from '@fadachi/core';
import { BinanceDerivativesSource } from './sources/binanceDerivatives.ts';
import { RSSNewsSource } from './sources/rssNews.ts';
import { CoinMetricsSource } from './sources/coinMetrics.ts';
import { fetchHistoricalKlines } from '../binance/rest.ts';
import type { AIDataSourceHealth } from './sources/rssNews.ts';

export interface DataAggregatorOptions {
  client: DuckDBClient;
  derivativesSource?: BinanceDerivativesSource;
  newsSource?: RSSNewsSource;
  coinMetricsSource?: CoinMetricsSource;
}

export class AIDataAggregator {
  private client: DuckDBClient;
  readonly derivatives: BinanceDerivativesSource;
  readonly news: RSSNewsSource;
  readonly coinMetrics: CoinMetricsSource;

  constructor(options: DataAggregatorOptions) {
    this.client = options.client;
    this.derivatives = options.derivativesSource ?? new BinanceDerivativesSource();
    this.news = options.newsSource ?? new RSSNewsSource();
    this.coinMetrics = options.coinMetricsSource ?? new CoinMetricsSource();
  }

  async buildSnapshot(symbol: string, market: MarketType = 'futures', now = Date.now()): Promise<AIDataSnapshot> {
    // 1. Fetch klines from DuckDB or fallback to Binance REST (consistent 1m timeframe)
    let klines = await this.getKlines(symbol, market, now);
    if (!klines.length || klines.length < 20) {
      try {
        const raw = await fetchHistoricalKlines(market, symbol, '1m', undefined, undefined, 100);
        if (Array.isArray(raw)) {
          klines = raw.map((item: any[]) => ({
            time: Math.floor(Number(item[0]) / 1000),
            open: parseFloat(item[1]),
            high: parseFloat(item[2]),
            low: parseFloat(item[3]),
            close: parseFloat(item[4]),
            volume: parseFloat(item[5]),
          }));
        }
      } catch {
        // proceed with whatever is available
      }
    }

    // Only finalized one-minute candles available at the cutoff are eligible.
    klines = klines.filter(k => k.time * 1000 + 60_000 <= now);
    // Sort ascending by time
    klines.sort((a, b) => a.time - b.time);

    // 2. Derive market summary from klines or latest price
    const lastKline = klines.at(-1);
    const firstKline = klines.at(0);
    const lastPrice = lastKline?.close ?? 0;
    const priceChangePercent = firstKline && firstKline.open > 0
      ? ((lastPrice - firstKline.open) / firstKline.open) * 100
      : 0;

    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    const high = highs.length ? Math.max(...highs) : lastPrice;
    const low = lows.length ? Math.min(...lows) : lastPrice;
    const volume = klines.reduce((sum, k) => sum + k.volume, 0);

    // 3. Technical indicators using bundle & EMA20 series
    const bundle = indicatorBundle(klines);
    const sma20 = bundle.indicators.sma20 ?? undefined;
    const emaSeries = calculateEMASeries(klines, 20);
    const ema20 = emaSeries.at(-1)?.value ?? undefined;
    const rsi14 = bundle.indicators.rsi ?? undefined;
    const macd = bundle.indicators.macd ?? undefined;
    const bollinger = bundle.indicators.bb ?? undefined;

    // 4. Derivatives
    let openInterest: number | null = null;
    let fundingRate: number | null = null;
    let liquidations: Array<{ price: number; quantity: number; side: 'buy' | 'sell'; timestamp: number }> = [];

    if (market === 'futures') {
      [openInterest, fundingRate, liquidations] = await Promise.all([
        this.derivatives.fetchOpenInterest(symbol),
        this.derivatives.fetchFundingRate(symbol),
        this.derivatives.fetchRecentLiquidationOrders(symbol),
      ]);
    }

    // 5. News (RSS)
    const newsItems = await this.news.getLatestNews();

    // 6. On-chain metrics
    const onChain = await this.coinMetrics.getAssetMetrics(symbol);

    const klineAsOf = lastKline ? lastKline.time * 1000 + 60_000 : undefined;
    const sourceHealth: Record<string, AIDataSourceHealth> = {
      market: klineAsOf && now - klineAsOf <= 120_000
        ? { status: 'healthy', lastSuccessAt: klineAsOf, dataAsOf: klineAsOf }
        : { status: klines.length ? 'stale' : 'missing', dataAsOf: klineAsOf },
      klines: klines.length >= 20 && klineAsOf && now - klineAsOf <= 120_000
        ? { status: 'healthy', lastSuccessAt: klineAsOf, dataAsOf: klineAsOf }
        : { status: klines.length ? 'stale' : 'missing', dataAsOf: klineAsOf },
      indicators: Number.isFinite(sma20) || Number.isFinite(ema20)
        ? { status: 'healthy', lastSuccessAt: klineAsOf, dataAsOf: klineAsOf }
        : { status: 'missing', dataAsOf: klineAsOf },
      derivatives: market === 'futures' ? this.derivatives.getHealth(now) : { status: 'missing' },
      liquidations: market === 'futures' ? this.derivatives.getHealth(now) : { status: 'missing' },
      openInterest: market === 'futures' ? this.derivatives.getMetricHealth('openInterest') : { status: 'missing' },
      fundingRate: market === 'futures' ? this.derivatives.getMetricHealth('fundingRate') : { status: 'missing' },
      news: this.news.getHealth(now),
      onChain: this.coinMetrics.getHealth(symbol, now),
    };
    const validOnChain = onChain && sourceHealth.onChain.status === 'healthy'
      && Boolean(onChain.date && /^\d{4}-\d{2}-\d{2}$/.test(onChain.date))
      && [onChain.activeAddresses, onChain.txCount].some(value => value !== undefined && Number.isFinite(value) && value >= 0)
      ? onChain
      : null;

    // 7. Create fixed snapshot
    const cutoffTime = Math.max(now, Date.now());
    const snapshot = createAIDataSnapshot({
      symbol,
      marketType: market,
      cutoffTime,
      now: cutoffTime,
      market: {
        price: lastPrice,
        priceChangePercent,
        volume,
        quoteVolume: volume * lastPrice,
        high,
        low,
        open: firstKline?.open ?? lastPrice,
        priceTimestamp: lastKline ? lastKline.time * 1000 + 60_000 : 0,
      },
      klines,
      indicators: {
        sma20,
        ema20,
        rsi14,
        macd,
        bollinger,
      },
      derivatives: {
        openInterest,
        fundingRate,
        liquidations,
      },
      news: newsItems.map(n => ({ ...n })),
      onChain: validOnChain,
      sourceHealth,
    });

    // 8. Persist snapshot to DuckDB
    await this.saveSnapshot(snapshot);

    return snapshot;
  }

  async refreshNews() {
    return this.news.refresh();
  }

  async refreshOnChain(symbols: string[]): Promise<void> {
    await this.coinMetrics.refresh(symbols);
  }

  private async getKlines(symbol: string, market: MarketType, now: number): Promise<KlineData[]> {
    try {
      const rows = await this.client.all(
        `SELECT open_time, open, high, low, close, volume
         FROM klines_1m
         WHERE symbol = ? AND market = ? AND is_final = true AND open_time + 60000 <= ?
         ORDER BY open_time DESC
         LIMIT 200;`,
        symbol,
        market,
        now
      );

      return rows.map((r: any) => ({
        time: Math.floor(Number(r.open_time) / 1000),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
      })).reverse();
    } catch {
      return [];
    }
  }

  async saveSnapshot(snapshot: AIDataSnapshot): Promise<void> {
    try {
      await this.client.run(
        `INSERT INTO ai_data_snapshots (id, symbol, market, cutoff_time, valid_until, hash, degraded, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           valid_until = excluded.valid_until,
           hash = excluded.hash,
           degraded = excluded.degraded,
           payload = excluded.payload;`,
        snapshot.id,
        snapshot.symbol,
        snapshot.marketType,
        snapshot.cutoffTime,
        snapshot.validUntil,
        snapshot.hash,
        snapshot.degraded,
        JSON.stringify(snapshot),
        snapshot.createdAt
      );
    } catch (err) {
      throw new Error('AI 快照保存失敗，停止分析以保留追溯性', { cause: err });
    }
  }

  async getSnapshot(id: string): Promise<AIDataSnapshot | null> {
    const rows = await this.client.all('SELECT payload FROM ai_data_snapshots WHERE id = ?;', id);
    if (!rows.length) return null;
    return JSON.parse(rows[0].payload) as AIDataSnapshot;
  }
}
