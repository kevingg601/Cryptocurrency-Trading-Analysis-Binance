import { create } from 'zustand';
import type { MarketType } from '@fadachi/core';
import { collectorClient } from '../api/collectorClient.ts';

export interface PaperTrade {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  type: 'MARKET' | 'LIMIT';
  entryPrice: number;
  quantity: number;
  leverage: number;
  initialMargin: number;
  liquidationPrice?: number;
  takeProfitPrice?: number;
  stopLossPrice?: number;
  timestamp: number;
  status: 'OPEN' | 'CLOSED';
  closePrice?: number;
  closeTimestamp?: number;
  pnl?: number;
  pnlPercent?: number;
  unrealizedPnl?: number;
}

export interface PaperAccountState {
  balance: number;
  trades: PaperTrade[];
  history: PaperTrade[];
  loaded: boolean;
  market: MarketType | null;
  error: string | null;
  loadAccount: (market: MarketType) => Promise<void>;
  addTrade: (market: MarketType, trade: PaperTrade) => void;
  closeTrade: (market: MarketType, tradeId: string, currentPrice: number) => void;
  resetAccount: (market: MarketType) => void;
}

export const usePaperStore = create<PaperAccountState>((set, get) => {
  let loadVersion = 0;
  const save = (market: MarketType, account: { balance: number; trades: PaperTrade[]; history: PaperTrade[] }) => {
    collectorClient.savePaperAccount(market, account).then(() => {
      if (get().market === market) set({ error: null });
    }).catch(() => {
      if (get().market === market) set({ error: 'Collector 儲存失敗，紙上帳戶尚未同步；請恢復連線後重試。' });
    });
  };
  return ({
  balance: 10000,
  trades: [],
  history: [],
  loaded: false,
  market: null,
  error: null,

  loadAccount: async (market: MarketType) => {
    const version = ++loadVersion;
    if (get().market !== market) set({ market, balance: 10000, trades: [], history: [], loaded: false });
    set({ error: null });
    try {
      const data = await collectorClient.getPaperAccount(market);
      if (!data || !Number.isFinite(data.balance) || !Array.isArray(data.trades) || !Array.isArray(data.history)
          || ![...data.trades, ...data.history].every(trade => trade && typeof trade.id === 'string' && typeof trade.symbol === 'string'
            && ['LONG', 'SHORT'].includes(trade.side) && Number.isFinite(trade.entryPrice) && Number.isFinite(trade.quantity) && Number.isFinite(trade.initialMargin))) {
        throw new Error('Invalid paper account');
      }
      if (version === loadVersion) {
        set({
          balance: data.balance ?? 10000,
          trades: data.trades ?? [],
          history: data.history ?? [],
          loaded: true,
        });
      }
    } catch {
      if (version === loadVersion) set({ error: 'Collector 帳戶載入失敗，請確認連線後重試。' });
    }
  },

  addTrade: (market, trade) => {
    if (get().market !== market || !get().loaded) return;
    ++loadVersion;
    set((state) => {
      const nextBalance = state.balance - (trade.initialMargin || 0);
      const nextTrades = [trade, ...state.trades];
      save(market, {
        balance: nextBalance,
        trades: nextTrades,
        history: state.history,
      });
      return { balance: nextBalance, trades: nextTrades };
    });
  },

  closeTrade: (market, tradeId, currentPrice) => {
    if (get().market !== market || !get().loaded || !Number.isFinite(currentPrice) || currentPrice <= 0) return;
    ++loadVersion;
    set((state) => {
      const trade = state.trades.find((t) => t.id === tradeId);
      if (!trade) return state;

      const direction = trade.side === 'LONG' ? 1 : -1;
      const priceDiff = currentPrice - trade.entryPrice;
      const rawPnl = direction * priceDiff * trade.quantity;
      const pnl = Number(rawPnl.toFixed(4));
      const pnlPercent = Number(((pnl / trade.initialMargin) * 100).toFixed(2));

      const closedTrade: PaperTrade = {
        ...trade,
        status: 'CLOSED',
        closePrice: currentPrice,
        closeTimestamp: Date.now(),
        pnl,
        pnlPercent,
      };

      const nextBalance = state.balance + trade.initialMargin + pnl;
      const nextTrades = state.trades.filter((t) => t.id !== tradeId);
      const nextHistory = [closedTrade, ...state.history];

      save(market, {
        balance: nextBalance,
        trades: nextTrades,
        history: nextHistory,
      });

      return {
        balance: nextBalance,
        trades: nextTrades,
        history: nextHistory,
      };
    });
  },

  resetAccount: (market) => {
    if (get().market !== market || !get().loaded) return;
    ++loadVersion;
    const nextState = {
      balance: 10000,
      trades: [],
      history: [],
    };
    save(market, nextState);
    set(nextState);
  },
});
});
