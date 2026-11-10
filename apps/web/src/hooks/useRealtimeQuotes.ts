import { useEffect, useRef, useState, useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { connectAggregateTradeWebSocket, connectTickerWebSocket, fetchLatestPrice, fetchTickers } from '../services/binance';
import type { AggregateTradeData, MarketType, TickerData, WsConnection } from '../services/binance';
import { mergeQuote } from '../services/liveMarket';
import type { QuoteUpdate } from '../services/liveMarket';
import type { StreamHealth, StreamStatus } from '../services/marketStream';

export function useRealtimeQuotes(market: MarketType, symbolsKey: string, selectedSymbol: string, setTickers: Dispatch<SetStateAction<Record<string, TickerData>>>, processTickerBatch: (batch: QuoteUpdate[]) => void, processTrade: (trade: AggregateTradeData) => void, onTradeStatus?: (status: StreamStatus, health?: StreamHealth) => void) {
  const [tickerStatus, setTickerStatus] = useState<StreamStatus>('connecting');
  const [tradeStatus, setTradeStatus] = useState<StreamStatus>('connecting');
  const connections = useRef<WsConnection[]>([]);
  const selected = useRef(selectedSymbol);
  useEffect(() => { selected.current = selectedSymbol; }, [selectedSymbol]);

  useEffect(() => {
    let active = true;
    let tickerHealth: StreamStatus = 'connecting';
    let fullRequest = false, priceRequest = false;
    let lastFullPoll = 0;
    const fastQuotes = new Map<string, { id?: number; timestamp: number; receivedAt: number }>();
    let pending: QuoteUpdate[] = [];
    const queue = (update: QuoteUpdate) => { pending.push(update); };
    const tickers = connectTickerWebSocket(market, batch => {
      if (!active) return;
      const fallback: QuoteUpdate[] = [];
      for (const tick of batch) {
        queue(tick);
        if (Date.now() - (fastQuotes.get(tick.symbol)?.receivedAt ?? 0) > 3_000) fallback.push(tick);
      }
      // Only use slower snapshots for detection when the fast stream has no recent trade.
      processTickerBatch(fallback);
    }, status => { if (active) { tickerHealth = status; setTickerStatus(status); } }, symbolsKey.split(',').filter(Boolean));
    const trades = connectAggregateTradeWebSocket(market, symbolsKey.split(',').filter(Boolean), trade => {
      if (!active) return;
      const previous = fastQuotes.get(trade.symbol);
      if (previous && (trade.lastTradeId !== undefined && previous.id !== undefined ? trade.lastTradeId <= previous.id : trade.timestamp < previous.timestamp)) return;
      const receivedAt = Date.now();
      fastQuotes.set(trade.symbol, { id: trade.lastTradeId, timestamp: trade.timestamp, receivedAt });
      processTrade(trade);
      queue({ symbol: trade.symbol, price: trade.price, priceTimestamp: trade.timestamp, receivedAt, priceSource: 'trade', tradeId: trade.lastTradeId });
    }, (status, _attempts, health) => { if (active) { setTradeStatus(status); onTradeStatus?.(status, health); } });
    connections.current = [tickers, trades];
    const flush = setInterval(() => {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      setTickers(previous => {
        const next = { ...previous };
        for (const tick of batch) next[tick.symbol] = mergeQuote(next[tick.symbol], tick);
        return next;
      });
    }, 100);
    // This timer survives reconnect attempts; entering "connecting" cannot cancel fallback.
    const fallback = setInterval(() => {
      if (tickerHealth === 'connected') return;
      if (!priceRequest) {
        priceRequest = true;
        void fetchLatestPrice(selected.current, market).then(tick => {
          if (!active) return;
          queue(tick);
          processTickerBatch([tick]);
        }).catch(() => {}).finally(() => { priceRequest = false; });
      }
      if (!fullRequest && Date.now() - lastFullPoll >= 10_000) {
        fullRequest = true;
        lastFullPoll = Date.now();
        void fetchTickers(market).then(batch => { if (active) batch.forEach(queue); })
          .finally(() => { fullRequest = false; });
      }
    }, 2_000);
    return () => {
      active = false;
      clearInterval(flush); clearInterval(fallback);
      tickers.close(); trades.close();
      connections.current = [];
    };
  }, [market, symbolsKey, setTickers, processTickerBatch, processTrade, onTradeStatus]);
  const reconnect = useCallback(() => connections.current.forEach(connection => connection.reconnect()), []);
  return { tickerStatus, tradeStatus, reconnect };
}
