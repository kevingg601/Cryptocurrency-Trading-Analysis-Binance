import type { MarketType } from '../binance/streams.ts';
import { fetch24hTickers } from '../binance/rest.ts';
import type { DuckDBClient } from '../storage/duckdb.ts';

export interface UniverseState {
  market: MarketType;
  symbols: string[];
  lastUpdated: number;
}

export class UniverseManager {
  private currentSymbols: Map<MarketType, string[]> = new Map();
  private lastUpdate: Map<MarketType, number> = new Map();

  private client: DuckDBClient;
  private topN: number;

  constructor(
    client: DuckDBClient,
    topN = 50
  ) {
    this.client = client;
    this.topN = topN;
  }

  async updateUniverse(market: MarketType): Promise<string[]> {
    try {
      const tickers = await fetch24hTickers(market);
      // Filter USDT pairs and sort by quoteVolume desc
      const usdtPairs = tickers
        .filter((t: any) => t.symbol.endsWith('USDT') && Number(t.quoteVolume) > 0)
        .sort((a: any, b: any) => Number(b.quoteVolume) - Number(a.quoteVolume));

      const selected = usdtPairs.slice(0, this.topN).map((t: any) => t.symbol as string);

      const prev = this.currentSymbols.get(market) ?? [];
      const added = selected.filter(s => !prev.includes(s));
      const removed = prev.filter(s => !selected.includes(s));

      if (prev.length > 0 && (added.length > 0 || removed.length > 0)) {
        const now = Date.now();
        await this.client.run(
          'INSERT INTO universe_changes (change_time, market, added, removed) VALUES (?, ?, ?, ?);',
          now,
          market,
          JSON.stringify(added),
          JSON.stringify(removed)
        );
      }

      this.currentSymbols.set(market, selected);
      this.lastUpdate.set(market, Date.now());
      return selected;
    } catch (err) {
      console.warn(`Failed to update universe for ${market}, using fallback symbols:`, err);
      const fallback = [
        'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
        'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'SUIUSDT'
      ];
      this.currentSymbols.set(market, fallback);
      return fallback;
    }
  }

  getSymbols(market: MarketType): string[] {
    return this.currentSymbols.get(market) ?? ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  }
}
