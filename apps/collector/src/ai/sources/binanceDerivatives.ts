import type { AIDataSourceHealth } from './rssNews.ts';
import WebSocket from 'ws';

export interface ObservedLiquidation {
  price: number;
  quantity: number;
  side: 'buy' | 'sell';
  timestamp: number;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
type Socket = Pick<WebSocket, 'on' | 'close' | 'terminate'>;
type SocketFactory = (url: string) => Socket;

export class BinanceDerivativesSource {
  private readonly liquidationsBuffer = new Map<string, ObservedLiquidation[]>();
  private readonly fetcher: Fetcher;
  private streamHealth: AIDataSourceHealth = { status: 'missing' };
  private lastRestSuccessAt = 0;
  private lastAttemptAt = 0;
  private lastError?: string;
  private readonly socketFactory: SocketFactory;
  private liquidationSocket?: Socket;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = true;
  private readonly metricHealth = new Map<string, AIDataSourceHealth>();

  constructor(fetcher: Fetcher = fetch, socketFactory: SocketFactory = url => new WebSocket(url)) {
    this.fetcher = fetcher;
    this.socketFactory = socketFactory;
  }

  startLiquidationStream(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connectLiquidationStream();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.setStreamHealth('missing', Date.now());
    const socket = this.liquidationSocket;
    this.liquidationSocket = undefined;
    try { socket?.close(); } catch { try { socket?.terminate(); } catch {} }
  }

  private connectLiquidationStream(): void {
    if (this.stopped) return;
    const socket = this.socketFactory('wss://fstream.binance.com/ws/!forceOrder@arr');
    this.liquidationSocket = socket;
    socket.on('open', () => {
      if (this.liquidationSocket !== socket || this.stopped) return;
      this.setStreamHealth('healthy', Date.now());
    });
    socket.on('message', (raw: WebSocket.RawData) => {
      if (this.liquidationSocket !== socket || this.stopped) return;
      try {
        const message = JSON.parse(raw.toString());
        const order = message?.data?.o ?? message?.o;
        const symbol = order?.s;
        const timestamp = Number(order?.T ?? message?.data?.E ?? message?.E);
        const averagePrice = Number(order?.ap);
        const price = averagePrice > 0 ? averagePrice : Number(order?.p);
        const executedQuantity = Number(order?.z);
        const quantity = executedQuantity > 0 ? executedQuantity : Number(order?.q);
        if (typeof symbol === 'string' && Number.isFinite(timestamp) && Number.isFinite(price) && Number.isFinite(quantity)) {
          this.recordLiquidation(symbol, {
            price, quantity, side: order?.S?.toLowerCase() === 'sell' ? 'sell' : 'buy', timestamp,
          });
          this.streamHealth.dataAsOf = timestamp;
          this.streamHealth.lastSuccessAt = Date.now();
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.setStreamHealth('error', Date.now(), this.lastError);
      }
    });
    socket.on('error', (error: Error) => {
      this.lastError = error.message;
      this.setStreamHealth('error', Date.now(), error.message);
    });
    socket.on('close', () => {
      if (this.liquidationSocket !== socket) return;
      this.liquidationSocket = undefined;
      if (this.stopped) return;
      this.setStreamHealth('stale', Date.now(), this.lastError);
      this.reconnectTimer = setTimeout(() => this.connectLiquidationStream(), 5000);
      this.reconnectTimer.unref();
    });
  }

  recordLiquidation(symbol: string, liq: ObservedLiquidation): void {
    if (![liq.price, liq.quantity, liq.timestamp].every(Number.isFinite) || liq.price <= 0 || liq.quantity <= 0) return;
    const key = symbol.toUpperCase();
    const list = this.liquidationsBuffer.get(key) ?? [];
    list.push(liq);
    if (list.length > 100) list.splice(0, list.length - 100);
    this.liquidationsBuffer.set(key, list);
  }

  setStreamHealth(status: 'healthy' | 'stale' | 'missing' | 'error', timestamp = Date.now(), error?: string): void {
    this.streamHealth = {
      status,
      lastSuccessAt: status === 'healthy' ? timestamp : this.streamHealth.lastSuccessAt,
      lastAttemptAt: timestamp,
      dataAsOf: this.streamHealth.dataAsOf,
      error,
    };
  }

  getObservedLiquidations(symbol: string, windowMs = 3600_000): ObservedLiquidation[] {
    const cutoff = Date.now() - windowMs;
    return (this.liquidationsBuffer.get(symbol.toUpperCase()) ?? []).filter(item => item.timestamp >= cutoff);
  }

  async fetchOpenInterest(symbol: string): Promise<number | null> {
    return this.fetchNumber(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`, 'openInterest');
  }

  async fetchFundingRate(symbol: string): Promise<number | null> {
    const now = Date.now();
    try {
      const response = await this.fetcher(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${encodeURIComponent(symbol)}&limit=1`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error(`Binance funding rate HTTP ${response.status}`);
      const data = await response.json();
      const value = Array.isArray(data) && data[0]?.fundingRate !== undefined ? Number(data[0].fundingRate) : NaN;
      if (!Number.isFinite(value)) throw new Error('Binance funding rate response is invalid');
      this.metricHealth.set('fundingRate', { status: 'healthy', lastSuccessAt: now, lastAttemptAt: now, dataAsOf: now });
      return value;
    } catch (error) {
      this.metricHealth.set('fundingRate', { status: 'error', lastAttemptAt: now, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  private async fetchNumber(url: string, field: string): Promise<number | null> {
    const now = Date.now();
    try {
      const response = await this.fetcher(url, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error(`Binance ${field} HTTP ${response.status}`);
      const data = await response.json();
      const value = Number(data?.[field]);
      if (!Number.isFinite(value) || value < 0) throw new Error(`Binance ${field} response is invalid`);
      this.metricHealth.set(field, { status: 'healthy', lastSuccessAt: now, lastAttemptAt: now, dataAsOf: now });
      return value;
    } catch (error) {
      this.metricHealth.set(field, { status: 'error', lastAttemptAt: now, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  getMetricHealth(metric: 'openInterest' | 'fundingRate'): AIDataSourceHealth {
    return { ...(this.metricHealth.get(metric) ?? { status: 'missing' }) };
  }

  async fetchRecentLiquidationOrders(symbol: string): Promise<ObservedLiquidation[]> {
    const now = Date.now();
    this.lastAttemptAt = now;
    try {
      const response = await this.fetcher(`https://fapi.binance.com/fapi/v1/allForceOrders?symbol=${encodeURIComponent(symbol)}&limit=20`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error(`Binance force orders HTTP ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body)) throw new Error('Binance force orders response is invalid');
      const observations = body.map((item: any) => ({
        price: Number(item.price || item.avgPrice),
        quantity: Number(item.origQty || item.executedQty),
        side: item.side?.toLowerCase() === 'sell' ? 'sell' as const : 'buy' as const,
        timestamp: Number(item.time),
      })).filter((item: ObservedLiquidation) => Number.isFinite(item.price) && item.price > 0
        && Number.isFinite(item.quantity) && item.quantity > 0 && Number.isFinite(item.timestamp));
      observations.forEach((item: ObservedLiquidation) => this.recordLiquidation(symbol, item));
      this.lastRestSuccessAt = now;
      this.lastError = undefined;
      return observations;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return this.streamHealth.status === 'healthy' ? this.getObservedLiquidations(symbol) : [];
    }
  }

  getHealth(now = Date.now()): AIDataSourceHealth {
    const streamFresh = this.streamHealth.status === 'healthy' && Boolean(this.liquidationSocket);
    const restFresh = this.lastRestSuccessAt > 0 && now - this.lastRestSuccessAt <= 60_000;
    if (streamFresh || restFresh) {
      return {
        status: 'healthy',
        lastSuccessAt: streamFresh ? now : this.lastRestSuccessAt,
        lastAttemptAt: this.lastAttemptAt || this.streamHealth.lastAttemptAt,
        dataAsOf: this.streamHealth.dataAsOf,
      };
    }
    if (this.lastError) return {
      status: this.streamHealth.status === 'healthy' ? 'stale' : this.lastRestSuccessAt ? 'stale' : 'error',
      lastSuccessAt: this.lastRestSuccessAt || this.streamHealth.lastSuccessAt,
      lastAttemptAt: this.lastAttemptAt,
      dataAsOf: this.streamHealth.dataAsOf,
      error: this.lastError,
    };
    return { ...this.streamHealth };
  }
}
