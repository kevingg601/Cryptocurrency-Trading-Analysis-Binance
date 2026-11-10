import WebSocket from 'ws';

export type StreamStatus = 'connecting' | 'connected' | 'stale' | 'disconnected';
export type MarketType = 'spot' | 'futures';

export interface StreamStatusInfo {
  status: StreamStatus;
  lastValidAt: number;
  totalMessages: number;
  activeSockets: number;
}

export interface StreamCallbacks {
  onMessage: (payload: any, receivedAt: number) => void;
  onStatusChange?: (status: StreamStatusInfo) => void;
}

const SPOT_WS_BASE = 'wss://stream.binance.com:9443';
const FUTURES_WS_BASE = 'wss://fstream.binance.com';

const SHARD_SIZE = 50;
const WATCHDOG_INTERVAL_MS = 1000;
const STALE_THRESHOLD_MS = 5000;

export class BinanceStreamManager {
  private sockets: Map<number, WebSocket> = new Map();
  private reconnectTimeouts: Map<number, NodeJS.Timeout> = new Map();
  private watchdogTimer: NodeJS.Timeout | null = null;
  private lastValidAt = 0;
  private totalMessages = 0;
  private currentStatus: StreamStatus = 'disconnected';
  private backoffAttempts: Map<number, number> = new Map();
  private isClosed = true;
  private lastActivity = new Map<number, number>();

  private market: MarketType;
  private streams: string[];
  private callbacks: StreamCallbacks;

  constructor(
    market: MarketType,
    streams: string[],
    callbacks: StreamCallbacks
  ) {
    this.market = market;
    this.streams = streams;
    this.callbacks = callbacks;
  }

  start() {
    if (!this.isClosed) return;
    this.isClosed = false;
    this.lastValidAt = 0;
    this.shardAndConnect();
    this.startWatchdog();
  }

  stop() {
    this.isClosed = true;
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    for (const timeout of this.reconnectTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.reconnectTimeouts.clear();
    for (const ws of this.sockets.values()) {
      try {
        ws.terminate();
      } catch {}
    }
    this.sockets.clear();
    this.lastActivity.clear();
    this.backoffAttempts.clear();
    this.updateStatus('disconnected');
  }

  private shardAndConnect() {
    const shards: string[][] = [];
    for (let i = 0; i < this.streams.length; i += SHARD_SIZE) {
      shards.push(this.streams.slice(i, i + SHARD_SIZE));
    }

    shards.forEach((shard, index) => {
      this.connectShard(index, shard);
    });
  }

  private getUrl(shard: string[]): string {
    const base = this.market === 'spot' ? SPOT_WS_BASE : FUTURES_WS_BASE;
    if (this.market === 'futures' && shard.length === 1 && shard[0] === '!ticker@arr') {
      return `${base}/market/ws/!ticker@arr`;
    }
    return `${base}/stream?streams=${shard.join('/')}`;
  }

  private connectShard(shardIndex: number, shard: string[]) {
    if (this.isClosed) return;

    const url = this.getUrl(shard);
    this.updateStatus('connecting');

    try {
      const ws = new WebSocket(url);
      this.sockets.set(shardIndex, ws);
      this.lastActivity.set(shardIndex, Date.now());

      ws.on('open', () => {
        if (this.isClosed || this.sockets.get(shardIndex) !== ws) return;
        this.backoffAttempts.set(shardIndex, 0);
      });

      ws.on('message', (data: WebSocket.RawData) => {
        if (this.isClosed || this.sockets.get(shardIndex) !== ws) return;
        const now = Date.now();

        try {
          const parsed = JSON.parse(data.toString());
          this.lastActivity.set(shardIndex, now);
          this.lastValidAt = now;
          this.totalMessages++;
          if (this.currentStatus !== 'connected') this.updateStatus('connected');
          this.callbacks.onMessage(parsed, now);
        } catch (err) {
          console.error('Failed to parse Binance WS message:', err);
        }
      });

      ws.on('error', (err) => {
        console.warn(`Shard ${shardIndex} error:`, err.message);
      });

      ws.on('close', () => {
        if (this.sockets.get(shardIndex) !== ws) return;
        this.sockets.delete(shardIndex);
        this.lastActivity.delete(shardIndex);
        if (!this.isClosed) {
          this.scheduleReconnect(shardIndex, shard);
        }
      });
    } catch (err) {
      console.error(`Failed to connect shard ${shardIndex}:`, err);
      this.scheduleReconnect(shardIndex, shard);
    }
  }

  private scheduleReconnect(shardIndex: number, shard: string[]) {
    if (this.isClosed || this.reconnectTimeouts.has(shardIndex)) return;

    const attempts = this.backoffAttempts.get(shardIndex) ?? 0;
    const delay = Math.min(1000 * Math.pow(1.5, attempts), 30000);
    this.backoffAttempts.set(shardIndex, attempts + 1);

    this.updateStatus(this.sockets.size === 0 ? 'disconnected' : 'connecting');

    const timeout = setTimeout(() => {
      this.reconnectTimeouts.delete(shardIndex);
      this.connectShard(shardIndex, shard);
    }, delay);
    timeout.unref();

    this.reconnectTimeouts.set(shardIndex, timeout);
  }

  private startWatchdog() {
    this.watchdogTimer = setInterval(() => {
      const now = Date.now();
      for (const [index, ws] of this.sockets) {
        if (now - (this.lastActivity.get(index) ?? now) > STALE_THRESHOLD_MS) ws.terminate();
      }
      if (this.lastValidAt > 0 && now - this.lastValidAt > STALE_THRESHOLD_MS) {
        if (this.currentStatus !== 'stale') {
          this.updateStatus('stale');
        }
      }
    }, WATCHDOG_INTERVAL_MS);
    this.watchdogTimer.unref();
  }

  private updateStatus(newStatus: StreamStatus) {
    this.currentStatus = newStatus;
    if (this.callbacks.onStatusChange) {
      this.callbacks.onStatusChange({
        status: newStatus,
        lastValidAt: this.lastValidAt,
        totalMessages: this.totalMessages,
        activeSockets: this.sockets.size,
      });
    }
  }

  getStatus(): StreamStatusInfo {
    return {
      status: this.currentStatus,
      lastValidAt: this.lastValidAt,
      totalMessages: this.totalMessages,
      activeSockets: this.sockets.size,
    };
  }
}
