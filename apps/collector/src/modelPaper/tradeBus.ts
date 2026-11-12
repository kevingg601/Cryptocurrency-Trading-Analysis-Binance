import { EventEmitter } from 'node:events';
import type { ReferencePriceQuote } from '@fadachi/core';
import type { StreamStatusInfo } from '../binance/streams.ts';

export interface TradeBusTradeEvent {
  symbol: string;
  price: number;
  qty: number;
  aggId: number;
  tradeTime: number;
  receivedAt: number;
  side?: 'buy' | 'sell';
  lastTradeId?: number;
}

export class TradeBus extends EventEmitter {
  private readonly lastTrades = new Map<string, ReferencePriceQuote>();
  private streamStatus: StreamStatusInfo = {
    status: 'disconnected',
    lastValidAt: 0,
    totalMessages: 0,
    activeSockets: 0,
  };
  private everConnected = false;

  emitTrade(trade: TradeBusTradeEvent): void {
    const symbol = trade.symbol.toUpperCase();
    const normalized: TradeBusTradeEvent = { ...trade, symbol };
    const prev = this.lastTrades.get(symbol);
    if (!prev || prev.aggId === undefined || normalized.aggId >= prev.aggId) {
      this.lastTrades.set(symbol, {
        symbol,
        price: normalized.price,
        tradeTime: normalized.tradeTime,
        receivedAt: normalized.receivedAt,
        aggId: normalized.aggId,
      });
    }
    this.emit('trade', normalized);
  }

  emitStatus(status: StreamStatusInfo): void {
    this.streamStatus = { ...status };
    if (status.status === 'connected') {
      this.everConnected = true;
    }
    this.emit('status', this.streamStatus);
  }

  hasEverConnected(): boolean {
    return this.everConnected;
  }

  getLastTrade(symbol: string): ReferencePriceQuote | null {
    const entry = this.lastTrades.get(symbol.toUpperCase());
    return entry ? { ...entry } : null;
  }

  getLastPrices(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [symbol, q] of this.lastTrades.entries()) {
      out[symbol] = q.price;
    }
    return out;
  }

  getReferencePrices(symbols: string[]): Record<string, ReferencePriceQuote | null> {
    const out: Record<string, ReferencePriceQuote | null> = {};
    for (const sym of symbols) {
      out[sym] = this.getLastTrade(sym);
    }
    return out;
  }

  getStreamStatus(): StreamStatusInfo {
    return { ...this.streamStatus };
  }
}
