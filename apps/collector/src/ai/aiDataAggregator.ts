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

export type HistoricalKlinesFetcher = typeof fetchHistoricalKlines;

export interface DataAggregatorOptions {
  client: DuckDBClient;
  derivativesSource?: BinanceDerivativesSource;
  newsSource?: RSSNewsSource;
  coinMetricsSource?: CoinMetricsSource;
  fetchKlines?: HistoricalKlinesFetcher;
}

/**
 * Extract the trailing contiguous sequence of finalized 1m candles up to `cutoffMs`
 * so an older collector restart gap does not invalidate fresh candles.
 */
function extractTrailingContiguousKlines(raw: KlineData[], cutoffMs: number): KlineData[] {
  const deduped = new Map<number, KlineData>();
  for (const k of raw) {
    if (!k || !Number.isInteger(k.time) || k.time < 0 || k.time * 1000 + 60_000 > cutoffMs) continue;
    if (![k.open, k.high, k.low, k.close, k.volume].every(Number.isFinite) || k.open <= 0 || k.low <= 0 || k.volume < 0) continue;
    deduped.set(k.time, k);
  }
  const sorted = [...deduped.values()].sort((a, b) => a.time - b.time);
  if (!sorted.length) return [];
  let startIdx = sorted.length - 1;
  while (startIdx > 0 && sorted[startIdx].time - sorted[startIdx - 1].time === 60) {
    startIdx -= 1;
  }
  return sorted.slice(startIdx);
}

function hasSufficientLatestWindow(klines: KlineData[], cutoffMs: number): boolean {
  const latestClosedOpen = Math.floor(cutoffMs / 60_000) * 60 - 60;
  return klines.length >= 20 && klines.at(-1)?.time === latestClosedOpen;
}

export class AIDataAggregator {
  private client: DuckDBClient;
  readonly derivatives: BinanceDerivativesSource;
  readonly news: RSSNewsSource;
  readonly coinMetrics: CoinMetricsSource;
  private readonly fetchKlines: HistoricalKlinesFetcher;

  constructor(options: DataAggregatorOptions) {
    this.client = options.client;
    this.derivatives = options.derivativesSource ?? new BinanceDerivativesSource();
    this.news = options.newsSource ?? new RSSNewsSource();
    this.coinMetrics = options.coinMetricsSource ?? new CoinMetricsSource();
    this.fetchKlines = options.fetchKlines ?? fetchHistoricalKlines;
  }

  async buildSnapshot(symbol: string, market: MarketType = 'futures', now = Date.now()): Promise<AIDataSnapshot> {
    // 1. Fetch slow optional context (derivatives, news, on-chain) BEFORE fixing cutoff & 1m candles
    // so minute boundaries crossed during HTTP calls never render freshly fetched 1m candles stale.
    const derivativesPromise = market === 'futures'
      ? Promise.all([
          this.derivatives.fetchOpenInterest(symbol),
          this.derivatives.fetchFundingRate(symbol),
          this.derivatives.fetchRecentLiquidationOrders(symbol),
        ])
      : Promise.resolve([null, null, []] as [number | null, number | null, Array<{ price: number; quantity: number; side: 'buy' | 'sell'; timestamp: number }>]);
    const [[openInterest, fundingRate, liquidations], newsItems, onChain] = await Promise.all([
      derivativesPromise,
      this.news.getLatestNews(),
      this.coinMetrics.getAssetMetrics(symbol),
    ]);

    const cutoffTime = Math.max(now, Date.now());

    // 2. Fetch finalized 1m klines from DuckDB and fill from Binance REST whenever the
    // trailing contiguous window is incomplete, stale, or interrupted by an old restart gap.
    const dbKlines = await this.getKlines(symbol, market, cutoffTime);
    let klines = extractTrailingContiguousKlines(dbKlines, cutoffTime);
    if (!hasSufficientLatestWindow(klines, cutoffTime)) {
      try {
        const raw = await this.fetchKlines(market, symbol, '1m', undefined, cutoffTime, 100);
        if (Array.isArray(raw)) {
          const restKlines: KlineData[] = raw.map((item: any[]) => ({
            time: Math.floor(Number(item[0]) / 1000),
            open: parseFloat(item[1]),
            high: parseFloat(item[2]),
            low: parseFloat(item[3]),
            close: parseFloat(item[4]),
            volume: parseFloat(item[5]),
          }));
          const merged = extractTrailingContiguousKlines([...dbKlines, ...restKlines], cutoffTime);
          if (merged.length > klines.length || hasSufficientLatestWindow(merged, cutoffTime)) {
            klines = merged;
          }
        }
      } catch {
        // proceed with whatever finalized contiguous bars are available
      }
    }

    // 3. Derive market summary from klines or latest price
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

    // 4. Technical indicators using bundle & EMA20 series
    const bundle = indicatorBundle(klines);
    const sma20 = bundle.indicators.sma20 ?? undefined;
    const emaSeries = calculateEMASeries(klines, 20);
    const ema20 = emaSeries.at(-1)?.value ?? undefined;
    const rsi14 = bundle.indicators.rsi ?? undefined;
    const macd = bundle.indicators.macd ?? undefined;
    const bollinger = bundle.indicators.bb ?? undefined;

    const klineAsOf = lastKline ? lastKline.time * 1000 + 60_000 : undefined;
    const klineWindowValid = hasSufficientLatestWindow(klines, cutoffTime);
    const sourceHealth: Record<string, AIDataSourceHealth> = {
      market: klineAsOf && cutoffTime - klineAsOf <= 120_000
        ? { status: 'healthy', lastSuccessAt: klineAsOf, dataAsOf: klineAsOf }
        : { status: klines.length ? 'stale' : 'missing', dataAsOf: klineAsOf },
      klines: klineWindowValid && klineAsOf && cutoffTime - klineAsOf <= 120_000
        ? { status: 'healthy', lastSuccessAt: klineAsOf, dataAsOf: klineAsOf }
        : { status: klines.length ? 'stale' : 'missing', dataAsOf: klineAsOf },
      indicators: Number.isFinite(sma20) || Number.isFinite(ema20)
        ? { status: 'healthy', lastSuccessAt: klineAsOf, dataAsOf: klineAsOf }
        : { status: 'missing', dataAsOf: klineAsOf },
      derivatives: market === 'futures' ? this.derivatives.getHealth(cutoffTime) : { status: 'missing' },
      liquidations: market === 'futures' ? this.derivatives.getHealth(cutoffTime) : { status: 'missing' },
      openInterest: market === 'futures' ? this.derivatives.getMetricHealth('openInterest') : { status: 'missing' },
      fundingRate: market === 'futures' ? this.derivatives.getMetricHealth('fundingRate') : { status: 'missing' },
      news: this.news.getHealth(cutoffTime),
      onChain: this.coinMetrics.getHealth(symbol, cutoffTime),
    };
    const validOnChain = onChain && sourceHealth.onChain.status === 'healthy'
      && Boolean(onChain.date && /^\d{4}-\d{2}-\d{2}$/.test(onChain.date))
      && [onChain.activeAddresses, onChain.txCount].some(value => value !== undefined && Number.isFinite(value) && value >= 0)
      ? onChain
      : null;

    // 5. Create fixed snapshot
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
