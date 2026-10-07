import type { KlineData, TickerData } from './binance.ts';

export type QuoteUpdate = Partial<TickerData> & { symbol: string };

export function mergeQuote(previous: TickerData | undefined, update: QuoteUpdate, now = Date.now()): TickerData {
  const next: TickerData = {
    price: 0, priceChange: 0, priceChangePercent: 0,
    high: 0, low: 0, volume: 0, quoteVolume: 0, open: 0,
    ...previous, ...update,
  };
  const olderTrade = update.priceSource === 'trade' && previous?.priceSource === 'trade'
    && (update.tradeId !== undefined && previous.tradeId !== undefined
      ? update.tradeId <= previous.tradeId
      : (update.priceTimestamp ?? 0) < (previous.priceTimestamp ?? 0));
  const fastPriceIsFresher = previous?.priceSource === 'trade' && update.priceSource !== 'trade'
    && now - (previous.receivedAt ?? 0) < 3_000;
  const olderRequest = update.priceSource === 'rest' && (previous?.receivedAt ?? 0) > (update.receivedAt ?? 0);
  if (previous && (olderTrade || fastPriceIsFresher || olderRequest)) {
    next.price = previous.price;
    next.priceTimestamp = previous.priceTimestamp;
    next.priceSource = previous.priceSource;
    next.receivedAt = previous.receivedAt;
    next.tradeId = previous.tradeId;
  }
  if (next.open > 0) {
    next.priceChange = next.price - next.open;
    next.priceChangePercent = next.priceChange / next.open * 100;
  }
  return next;
}

export function intervalSeconds(interval: string): number {
  const match = /^(\d+)([mhdw])$/.exec(interval);
  if (!match) throw new Error(`Unsupported chart interval: ${interval}`);
  return Number(match[1]) * ({ m: 60, h: 3600, d: 86400, w: 604800 }[match[2] as 'm' | 'h' | 'd' | 'w']);
}

export function upsertKline(history: KlineData[], candle: KlineData, limit = 500): KlineData[] {
  const index = history.findIndex(item => item.time === candle.time);
  if (index >= 0) {
    const previous = history[index];
    const keepClose = (previous.lastTradeId ?? -1) > (candle.lastTradeId ?? -1);
    const merged = {
      ...candle,
      high: Math.max(previous.high, candle.high),
      low: Math.min(previous.low, candle.low),
      volume: Math.max(previous.volume, candle.volume),
      close: keepClose ? previous.close : candle.close,
      lastTradeId: Math.max(previous.lastTradeId ?? -1, candle.lastTradeId ?? -1),
    };
    return history.map((item, i) => i === index ? merged : item);
  }
  if (history.length && candle.time < history[history.length - 1].time) return history;
  return [...history, candle].slice(-limit);
}

export function applyTradeToKlines(history: KlineData[], price: number, timestamp: number, interval: string, tradeId?: number): KlineData[] {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(timestamp) || !history.length) return history;
  const seconds = intervalSeconds(interval);
  const time = Math.floor(timestamp / 1000 / seconds) * seconds;
  const last = history[history.length - 1];
  if (time < last.time || (time === last.time && tradeId !== undefined && tradeId <= (last.lastTradeId ?? -1))) return history;
  const candle: KlineData = time === last.time ? {
    ...last, close: price, high: Math.max(last.high, price), low: Math.min(last.low, price), lastTradeId: tradeId ?? last.lastTradeId,
  } : { time, open: price, high: price, low: price, close: price, volume: 0, lastTradeId: tradeId };
  return upsertKline(history, candle);
}
