import test from 'node:test';
import assert from 'node:assert/strict';
import { connectMarketStreams } from '../src/services/marketStream.ts';
import { AutoTradingEngine, defaultAutoTradingConfig } from '../src/services/autoTrading.ts';

class Socket {
  static instances: Socket[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { Socket.instances.push(this); }
  close() { this.onclose?.(); }
  emit() { this.onmessage?.({ data: '{}' }); }
}

test('a silent shard ends the batch on the original five-second data deadline, not a second grace period', t => {
  const epoch = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: epoch });
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  t.after(() => { globalThis.WebSocket = previous; });
  Socket.instances = [];
  const engine = new AutoTradingEngine('futures');
  engine.setRules({ BTCUSDT: { stepSize: 0.001, minQty: 0.001, maxQty: 100, minNotional: 5 } });
  const streams = Array.from({ length: 101 }, (_, i) => `coin${i}usdt@aggTrade`);
  const connection = connectMarketStreams('futures', streams, () => true, (status, _attempts, health) => {
    engine.setStreamHealthy(status === 'connected', Date.now(), health?.interruptedSince);
    engine.tick(Date.now());
  });
  t.after(() => connection.close());
  Socket.instances.forEach(socket => socket.emit());
  engine.start(defaultAutoTradingConfig('futures'), epoch);
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(1_000); Socket.instances[0].emit(); }
  assert.equal(engine.snapshot().status, 'RUNNING');
  t.mock.timers.tick(250);
  assert.equal(engine.snapshot().status, 'INTERRUPTED');
  assert.equal(engine.snapshot().endedAt, epoch + 5_250);
  Socket.instances[1].emit();
  assert.equal(engine.snapshot().status, 'INTERRUPTED');
  assert.equal(engine.snapshot().fills.length, 0);
});
