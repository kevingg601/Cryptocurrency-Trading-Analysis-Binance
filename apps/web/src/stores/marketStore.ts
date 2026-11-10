import { create } from 'zustand';
import type { CoinMetadata, MarketType, TickerData } from '@fadachi/core';
import { FALLBACK_COINS, mergeQuote } from '@fadachi/core';
import { collectorClient } from '../api/collectorClient.ts';

export interface MarketState {
  marketType: MarketType;
  selectedSymbol: string;
  coins: CoinMetadata[];
  tickers: Record<string, TickerData>;
  streamStatus: string;
  error: string | null;
  watchList: string[];
  setMarketType: (market: MarketType) => void;
  setSelectedSymbol: (symbol: string) => void;
  setCoins: (coins: CoinMetadata[]) => void;
  updateTickers: (updates: Array<Partial<TickerData> & { symbol: string }>) => void;
  setStreamStatus: (status: string) => void;
  toggleWatchList: (symbol: string) => void;
  loadSymbols: () => Promise<void>;
}

let symbolRequest = 0;
export const useMarketStore = create<MarketState>((set, get) => ({
  marketType: 'futures',
  selectedSymbol: 'BTCUSDT',
  coins: FALLBACK_COINS,
  tickers: {},
  streamStatus: 'connecting',
  error: null,
  watchList: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],

  setMarketType: (marketType) => {
    set({ marketType, tickers: {}, coins: FALLBACK_COINS, streamStatus: 'connecting', error: null });
    get().loadSymbols();
  },

  setSelectedSymbol: (selectedSymbol) => set({ selectedSymbol }),

  setCoins: (coins) => set({ coins }),

  updateTickers: (updates) => {
    set((state) => {
      const nextTickers = { ...state.tickers };
      const now = Date.now();
      for (const update of Array.isArray(updates) ? updates : []) {
        if (!update || typeof update.symbol !== 'string' || (update.price !== undefined && (!Number.isFinite(update.price) || update.price <= 0))) continue;
        nextTickers[update.symbol] = mergeQuote(nextTickers[update.symbol], update, now);
      }
      return { tickers: nextTickers };
    });
  },

  setStreamStatus: (streamStatus) => set({ streamStatus }),

  toggleWatchList: (symbol) => {
    set((state) => {
      const exists = state.watchList.includes(symbol);
      const next = exists
        ? state.watchList.filter((s) => s !== symbol)
        : [...state.watchList, symbol];
      try {
        localStorage.setItem(`watchlist_${state.marketType}`, JSON.stringify(next));
      } catch {
        /* ignore storage error */
      }
      return { watchList: next };
    });
  },

  loadSymbols: async () => {
    const request = ++symbolRequest;
    const market = get().marketType;
    try {
      const data = await collectorClient.getSymbols(market);
      if (request !== symbolRequest || get().marketType !== market) return;
      if (!Array.isArray(data?.coins) || !data.coins.every(c => c && typeof c.symbol === 'string' && typeof c.name === 'string')) {
        throw new Error('交易對回應格式錯誤');
      }
      if (data.coins.length) {
        set({ coins: data.coins, error: null });
      }
    } catch (err) {
      if (request === symbolRequest && get().marketType === market) set({ coins: FALLBACK_COINS, error: `Collector 無法載入交易對：${String(err)}` });
    }
  },
}));
