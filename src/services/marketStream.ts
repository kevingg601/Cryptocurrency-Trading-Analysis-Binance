import type { MarketType, WsConnection } from './binance.ts';

export type StreamStatus = 'connecting' | 'connected' | 'stale' | 'disconnected';
export interface StreamHealth { lastValidAt: number; interruptedSince?: number }
export type StreamStatusCallback = (status: StreamStatus, attempts: number, health?: StreamHealth) => void;

export function marketStreamUrls(market: MarketType, streams: string[]): string[] {
  const base = market === 'spot' ? 'wss://stream.binance.com:9443' : 'wss://fstream.binance.com/market';
  const unique = [...new Set(streams)];
  const urls: string[] = [];
  // Balance shards so a tiny tail of inactive symbols cannot dominate feed health.
  const shardSize = unique.length ? Math.ceil(unique.length / Math.ceil(unique.length / 100)) : 100;
  for (let i = 0; i < unique.length; i += shardSize) urls.push(`${base}/stream?streams=${unique.slice(i, i + shardSize).join('/')}`);
  return urls;
}

// A socket opening is not proof that its subscription is receiving valid data.
export function connectMarketStreams(
  market: MarketType,
  streams: string[],
  onPayload: (payload: unknown) => boolean,
  onStatus?: StreamStatusCallback,
  onResume?: () => void,
): WsConnection {
  let active = true;
  let lastStatus = '';
  const shards = marketStreamUrls(market, streams).map(url => ({
    url, socket: null as WebSocket | null, timer: null as ReturnType<typeof setTimeout> | null,
    status: 'connecting' as StreamStatus, attempts: 0, lastData: 0, lastValidAt: 0, started: 0, receivedOnce: false,
  }));
  const report = () => {
    const states = shards.map(shard => shard.status);
    const status: StreamStatus = !states.length ? 'disconnected'
      : states.every(state => state === 'connected') ? 'connected'
      : states.includes('stale') || states.includes('connected') ? 'stale'
      : states.includes('connecting') ? 'connecting' : 'disconnected';
    const attempts = Math.max(0, ...shards.map(shard => shard.attempts));
    const key = `${status}:${attempts}`;
    if (key !== lastStatus) {
      lastStatus = key;
      const affected = shards.filter(shard => shard.status !== 'connected');
      onStatus?.(status, attempts, { lastValidAt: Math.min(...shards.map(shard => shard.lastValidAt || shard.started || Date.now())),
        interruptedSince: affected.length ? Math.min(...affected.map(shard => shard.lastValidAt || shard.started || Date.now())) : undefined });
    }
  };
  const connect = (shard: typeof shards[number]) => {
    if (!active) return;
    if (shard.timer) clearTimeout(shard.timer);
    if (shard.socket) { shard.socket.onclose = null; shard.socket.close(); }
    shard.started = Date.now();
    shard.lastData = 0;
    shard.status = 'connecting';
    shard.attempts++;
    report();
    const socket = new WebSocket(shard.url);
    shard.socket = socket;
    socket.onmessage = event => {
      if (!active || socket !== shard.socket) return;
      try {
        if (!onPayload(JSON.parse(event.data))) return;
        const resume = shard.receivedOnce && shard.status !== 'connected';
        shard.receivedOnce = true;
        shard.lastData = Date.now();
        shard.lastValidAt = shard.lastData;
        shard.status = 'connected';
        shard.attempts = 0;
        report();
        if (resume) onResume?.();
      } catch (error) { console.warn('Invalid market stream message', error); }
    };
    socket.onerror = () => { if (active && socket === shard.socket) socket.close(); };
    socket.onclose = () => {
      if (!active || socket !== shard.socket) return;
      shard.status = 'disconnected';
      report();
      shard.timer = setTimeout(() => connect(shard), Math.min(500 * 2 ** Math.min(shard.attempts, 4), 5_000));
    };
  };
  shards.forEach(connect);
  const watchdog = setInterval(() => {
    if (!active) return;
    for (const shard of shards) {
      const age = Date.now() - (shard.lastData || shard.started);
      if (shard.status === 'disconnected') continue;
      if (age > 15_000) { connect(shard); continue; }
      if (age > 5_000 && shard.status !== 'stale') { shard.status = 'stale'; report(); }
    }
  }, 250);
  return {
    close: () => {
      active = false;
      clearInterval(watchdog);
      for (const shard of shards) { if (shard.timer) clearTimeout(shard.timer); shard.socket?.close(); }
    },
    reconnect: () => { if (active) shards.forEach(shard => { shard.attempts = 0; connect(shard); }); },
  };
}
