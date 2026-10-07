import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { MarketAlertDetector, DEFAULT_MARKET_ALERT_SETTINGS, normalizeMarketAlertSettings } from '../src/services/marketAlerts.ts';
import { applyTradeToKlines, upsertKline, mergeQuote } from '../src/services/liveMarket.ts';
import { connectMarketStreams, marketStreamUrls } from '../src/services/marketStream.ts';
import { connectAggregateTradeWebSocket, connectTickerWebSocket, connectKlineWebSocket } from '../src/services/binance.ts';
import type { KlineData } from '../src/services/binance.ts';

const epoch = 1_800_000_000_000;
const ticker = (price: number) => ({ symbol: 'TESTUSDT', price });
const candle: KlineData = { time: epoch / 1000, open: 100, high: 101, low: 99, close: 100, volume: 10, lastTradeId: 1 };

test('legacy and malformed settings cannot restore the old slow window', () => {
  assert.equal(normalizeMarketAlertSettings({ priceWindowMs: 30_000 }).priceWindowMs, 5_000);
  assert.deepEqual(normalizeMarketAlertSettings({ priceMovePercent: NaN, whaleMultiplier: Infinity }), DEFAULT_MARKET_ALERT_SETTINGS);
  const detector = new MarketAlertDetector({ ...DEFAULT_MARKET_ALERT_SETTINGS, priceWindowMs: 30_000 });
  detector.processTicker(ticker(100), 'spot', epoch);
  assert.equal(detector.processTicker(ticker(102), 'spot', epoch + 5_001), null);
});

test('five-second default fires on first threshold crossing, not after warmup', () => {
  assert.equal(DEFAULT_MARKET_ALERT_SETTINGS.priceWindowMs, 5000);
  const d = new MarketAlertDetector();
  assert.equal(d.processTicker(ticker(100), 'futures', epoch), null);
  const alert = d.processTicker(ticker(102), 'futures', epoch + 100);
  assert.equal(alert?.type, 'pump');
  assert.equal(alert?.timestamp, epoch + 100);
});

test('immediate reversal is detected without clearing the history', () => {
  const d = new MarketAlertDetector();
  d.processTicker(ticker(100), 'futures', epoch);
  assert.equal(d.processTicker(ticker(102), 'futures', epoch + 100)?.type, 'pump');
  assert.equal(d.processTicker(ticker(100), 'futures', epoch + 200)?.type, 'dump');
});

test('same-millisecond oscillations cannot spam or reuse alert IDs', () => {
  const d = new MarketAlertDetector();
  d.processTicker(ticker(100), 'futures', epoch);
  const pump = d.processTicker(ticker(102), 'futures', epoch + 100)!;
  const dump = d.processTicker(ticker(100), 'futures', epoch + 100)!;
  assert.equal(dump.type, 'dump');
  assert.equal(d.processTicker(ticker(102), 'futures', epoch + 100), null);
  d.reset();
  d.processTicker(ticker(100), 'futures', epoch);
  const afterReset = d.processTicker(ticker(102), 'futures', epoch + 100)!;
  assert.equal(new Set([pump.id, dump.id, afterReset.id]).size, 3);
});

test('repeated snapshots do not spam; a stronger move escalates inside 5 seconds', () => {
  const d = new MarketAlertDetector();
  d.processTicker(ticker(100), 'spot', epoch);
  assert.equal(d.processTicker(ticker(102), 'spot', epoch + 100)?.type, 'pump');
  assert.equal(d.processTicker(ticker(102), 'spot', epoch + 600), null);
  assert.equal(d.processTicker(ticker(104), 'spot', epoch + 1000)?.type, 'pump');
});

test('sliding window excludes old moves and rejects out-of-order ticks', () => {
  const d = new MarketAlertDetector();
  d.processTicker(ticker(100), 'spot', epoch);
  assert.equal(d.processTicker(ticker(102), 'spot', epoch + 5001), null);
  assert.equal(d.processTicker(ticker(200), 'spot', epoch + 4999), null);
});

test('alert text preserves small-coin price precision', () => {
  const d = new MarketAlertDetector();
  d.processTicker(ticker(0.073), 'spot', epoch);
  assert.match(d.processTicker(ticker(0.07469), 'spot', epoch + 100)!.message, /0\.07469/);
});

test('a new episode can alert again without a 60-second cooldown', () => {
  const d = new MarketAlertDetector();
  d.processTicker(ticker(100), 'spot', epoch);
  assert.equal(d.processTicker(ticker(102), 'spot', epoch + 100)?.type, 'pump');
  d.processTicker(ticker(102), 'spot', epoch + 5200);
  assert.equal(d.processTicker(ticker(104), 'spot', epoch + 5300)?.type, 'pump');
});

test('live candles accumulate extrema through a retracement', () => {
  let data = applyTradeToKlines([candle], 110, epoch + 100, '1m', 2);
  data = applyTradeToKlines(data, 100, epoch + 200, '1m', 3);
  assert.equal(data[0].high, 110);
  assert.equal(data[0].low, 99);
  assert.equal(data[0].close, 100);
});

test('live candles roll over and preserve the previous bar', () => {
  let data = applyTradeToKlines([candle], 105, epoch + 100, '1m', 2);
  data = applyTradeToKlines(data, 106, epoch + 60000, '1m', 3);
  assert.equal(data.length, 2);
  assert.equal(data[0].close, 105);
  assert.equal(data[1].time, candle.time + 60);
  assert.equal(data[1].open, 106);
  assert.equal(applyTradeToKlines(data, 10, epoch, '1m', 1), data);
});

test('authoritative candles reconcile open and volume without reverting newer trades', () => {
  const fast = applyTradeToKlines([candle], 110, epoch + 100, '1m', 20);
  const reconciled = upsertKline(fast, { ...candle, open: 99.5, high: 108, close: 107, volume: 20, lastTradeId: 19 });
  assert.equal(reconciled[0].open, 99.5);
  assert.equal(reconciled[0].high, 110);
  assert.equal(reconciled[0].close, 110);
  assert.equal(reconciled[0].volume, 20);
  assert.equal(upsertKline(reconciled, { ...candle, high: 112, close: 111, lastTradeId: 21 })[0].close, 111);
});

test('slower ticker and REST responses cannot overwrite a fresh trade', () => {
  const base = mergeQuote(undefined, { ...ticker(100), open: 90, high: 110, priceSource: 'ticker', receivedAt: epoch }, epoch);
  const fast = mergeQuote(base, { ...ticker(102), priceSource: 'trade', receivedAt: epoch + 100, priceTimestamp: epoch + 100, tradeId: 20 }, epoch + 100);
  const slow = mergeQuote(fast, { ...ticker(101), open: 90, quoteVolume: 5000, priceSource: 'ticker', receivedAt: epoch + 200 }, epoch + 200);
  assert.equal(slow.price, 102);
  assert.equal(slow.high, 110);
  assert.equal(slow.quoteVolume, 5000);
  assert.ok(Math.abs(slow.priceChangePercent - 13.3333333333) < 1e-8);
  assert.equal(mergeQuote(slow, { ...ticker(90), priceSource: 'rest', receivedAt: epoch }, epoch + 200).price, 102);
  assert.equal(mergeQuote(slow, { ...ticker(101), priceSource: 'trade', tradeId: 19 }, epoch + 300).price, 102);
});

test('all symbols are sharded, and futures use the market route', () => {
  const streams = Array.from({ length: 525 }, (_, i) => `coin${i}usdt@aggTrade`);
  const urls = marketStreamUrls('futures', streams);
  assert.equal(urls.length, 6);
  assert.ok(urls.every(url => url.startsWith('wss://fstream.binance.com/market/stream?streams=')));
  assert.ok(urls.join('/').includes('coin524usdt@aggTrade'));
  assert.ok(urls.every(url => new URL(url).searchParams.get('streams')!.split('/').length >= 85));
  assert.match(marketStreamUrls('spot', ['btcusdt@aggTrade'])[0], /^wss:\/\/stream.binance.com:9443\/stream/);
});

class MockSocket {
  static instances: MockSocket[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  constructor(url: string) { this.url = url; MockSocket.instances.push(this); }
  close() { this.onclose?.(); }
  emit(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
}

function mockSockets(t: TestContext) {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = MockSocket as unknown as typeof WebSocket;
  t.after(() => { globalThis.WebSocket = original; });
}

test('a silent open stream is not healthy, becomes stale and reconnects', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: epoch });
  mockSockets(t);
  const statuses: string[] = [];
  const connection = connectMarketStreams('futures', ['testusdt@aggTrade'], () => true, status => statuses.push(status));
  assert.equal(statuses.at(-1), 'connecting');
  t.mock.timers.tick(6000);
  assert.equal(statuses.at(-1), 'stale');
  t.mock.timers.tick(10000);
  assert.equal(statuses.at(-1), 'connecting');
  const latest = MockSocket.instances.at(-1)!;
  latest.emit({ e: 'aggTrade' });
  assert.equal(statuses.at(-1), 'connected');
  connection.close();
  const count = MockSocket.instances.length;
  t.mock.timers.tick(60000);
  assert.equal(MockSocket.instances.length, count);
});

test('reconnect ignores messages from an obsolete socket', t => {
  mockSockets(t);
  let received = 0;
  const connection = connectMarketStreams('spot', ['testusdt@ticker'], () => { received++; return true; });
  const first = MockSocket.instances.at(-1)!;
  connection.reconnect();
  first.emit({ e: '24hrTicker' });
  assert.equal(received, 0);
  connection.close();
});

test('trade, ticker and kline adapters parse prices and trade IDs and exclude CM payloads', t => {
  mockSockets(t);
  const trades: unknown[] = [], tickers: unknown[] = [], klines: KlineData[] = [];
  const trade = connectAggregateTradeWebSocket('futures', ['TESTUSDT'], value => trades.push(value));
  const a = MockSocket.instances.at(-1)!;
  a.emit({ data: { e: 'aggTrade', s: 'TESTUSDT', p: '0.07469', q: '100', T: epoch, l: 123, m: false } });
  a.emit({ data: { e: 'aggTrade', s: 'TESTUSDT', p: '0.1', q: '100', T: epoch, st: 2 } });
  assert.equal(trades.length, 1);
  assert.equal((trades[0] as { lastTradeId: number }).lastTradeId, 123);
  const tickerStream = connectTickerWebSocket('futures', value => tickers.push(...value));
  MockSocket.instances.at(-1)!.emit([{ e: '24hrTicker', s: 'TESTUSDT', c: '0.07469', p: '0.005', P: '5', h: '0.08', l: '0.06', v: '1', q: '2', o: '0.07', E: epoch }]);
  assert.equal((tickers[0] as { price: number }).price, 0.07469);
  const kline = connectKlineWebSocket('futures', 'TESTUSDT', '1m', value => klines.push(value));
  MockSocket.instances.at(-1)!.emit({ e: 'kline', s: 'TESTUSDT', k: { t: epoch, o: '1', h: '2', l: '0.5', c: '1.5', v: '100', L: 125 } });
  assert.equal(klines[0].lastTradeId, 125);
  trade.close(); tickerStream.close(); kline.close();
});
