import type WebSocket from 'ws';
import type { AggregateTradeData, KlineData, TickerData } from '@fadachi/core';

interface ClientState {
  ws: WebSocket;
  market: 'spot' | 'futures';
  selectedSymbol?: string;
}

export class LiveHub {
  private clients: Set<ClientState> = new Set();
  private pendingTickers: Map<'spot' | 'futures', Map<string, Partial<TickerData> & { symbol: string }>> = new Map([
    ['spot', new Map()],
    ['futures', new Map()],
  ]);
  private tickerFlushTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private statuses = new Map<'spot' | 'futures', any>();

  private send(client: ClientState, payload: string) {
    // A stalled local client must not retain an unbounded stream of trades.
    try {
      if (client.ws.bufferedAmount > 1024 * 1024) {
        client.ws.terminate();
        this.clients.delete(client);
      } else {
        client.ws.send(payload, (error) => {
          if (error) { client.ws.terminate(); this.clients.delete(client); }
        });
      }
    } catch {
      client.ws.terminate();
      this.clients.delete(client);
    }
  }

  constructor(flushIntervalMs = 100) {
    this.tickerFlushTimer = setInterval(() => {
      this.flushTickers();
    }, flushIntervalMs);
    this.tickerFlushTimer.unref();
  }

  addClient(ws: WebSocket, market: 'spot' | 'futures' = 'futures') {
    if (this.closed) { ws.terminate(); return; }
    const client: ClientState = { ws, market };
    this.clients.add(client);
    if (this.statuses.has(market)) {
      this.send(client, JSON.stringify({ type: 'status', market, data: this.statuses.get(market), timestamp: Date.now() }));
    }

    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'subscribe' && data.symbol) {
          client.selectedSymbol = data.symbol;
        }
      } catch {}
    });

    ws.on('close', () => {
      this.clients.delete(client);
    });

    ws.on('error', () => {
      this.clients.delete(client);
    });
  }

  pushTicker(market: 'spot' | 'futures', ticker: Partial<TickerData> & { symbol: string }): void;
  pushTicker(ticker: Partial<TickerData> & { symbol: string }): void;
  pushTicker(
    arg1: 'spot' | 'futures' | (Partial<TickerData> & { symbol: string }),
    arg2?: Partial<TickerData> & { symbol: string }
  ) {
    if (this.closed) return;
    const market: 'spot' | 'futures' = typeof arg1 === 'string' ? arg1 : 'futures';
    const ticker = typeof arg1 === 'string' ? arg2! : arg1;

    let marketMap = this.pendingTickers.get(market);
    if (!marketMap) {
      marketMap = new Map();
      this.pendingTickers.set(market, marketMap);
    }

    marketMap.set(ticker.symbol, {
      ...marketMap.get(ticker.symbol),
      ...ticker,
    });
  }

  private flushTickers() {
    if (this.clients.size === 0) return;

    for (const [market, marketMap] of this.pendingTickers.entries()) {
      if (marketMap.size === 0) continue;

      const batch = Array.from(marketMap.values());
      marketMap.clear();

      const payload = JSON.stringify({
        type: 'tickers',
        market,
        data: batch,
        timestamp: Date.now(),
      });

      for (const client of this.clients) {
        if (client.ws.readyState === 1 && client.market === market) {
          this.send(client, payload);
        }
      }
    }
  }

  broadcastTrade(trade: AggregateTradeData, market: 'spot' | 'futures' = 'futures') {
    if (this.clients.size === 0) return;

    const payload = JSON.stringify({
      type: 'trade',
      market,
      data: trade,
    });

    for (const client of this.clients) {
      if (client.ws.readyState === 1 && client.market === market) {
        // Send if client is listening to all or specifically this symbol
        if (!client.selectedSymbol || client.selectedSymbol === trade.symbol) {
          this.send(client, payload);
        }
      }
    }
  }

  broadcastKline(symbol: string, kline: KlineData, market: 'spot' | 'futures' = 'futures') {
    if (this.clients.size === 0) return;

    const payload = JSON.stringify({
      type: 'kline',
      market,
      symbol,
      data: kline,
    });

    for (const client of this.clients) {
      if (client.ws.readyState === 1 && client.market === market) {
        this.send(client, payload);
      }
    }
  }

  broadcastStatus(status: any, market?: 'spot' | 'futures') {
    if (market) this.statuses.set(market, status);
    if (this.clients.size === 0) return;

    const payload = JSON.stringify({
      type: 'status',
      market,
      data: status,
      timestamp: Date.now(),
    });

    for (const client of this.clients) {
      if (client.ws.readyState === 1 && (!market || client.market === market)) {
        this.send(client, payload);
      }
    }
  }

  close() {
    this.closed = true;
    if (this.tickerFlushTimer) {
      clearInterval(this.tickerFlushTimer);
      this.tickerFlushTimer = null;
    }
    for (const client of this.clients) {
      try {
        client.ws.terminate();
      } catch {}
    }
    this.clients.clear();
    for (const pending of this.pendingTickers.values()) pending.clear();
    this.statuses.clear();
  }
}
