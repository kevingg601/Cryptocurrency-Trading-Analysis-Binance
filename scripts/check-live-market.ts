import { mkdir, writeFile } from 'node:fs/promises';
import { connectAggregateTradeWebSocket, connectKlineWebSocket, connectTickerWebSocket, fetchKlines, fetchSupportedCoins } from '../src/services/binance.ts';
import type { MarketType } from '../src/services/binance.ts';
import { applyTradeToKlines, upsertKline } from '../src/services/liveMarket.ts';
import { MarketAlertDetector } from '../src/services/marketAlerts.ts';

const market = (process.argv[2] ?? 'futures') as MarketType;
if (!['spot', 'futures'].includes(market)) throw new Error('Use spot or futures');
const durationMs = Number(process.argv[3] ?? 65_000);
const symbol = 'BTCUSDT';
const timeUrl = market === 'spot' ? 'https://api.binance.com/api/v3/time' : 'https://fapi.binance.com/fapi/v1/time';
const before = Date.now();
const server = await (await fetch(timeUrl, { signal: AbortSignal.timeout(5000) })).json();
const after = Date.now();
const clockOffsetMs = server.serverTime - (before + after) / 2;
const coins = await fetchSupportedCoins(market);
let history = await fetchKlines(symbol, '1m', 200, market);
if (!history.length || coins.length < 100) throw new Error('Live bootstrap unavailable');
const initialTime = history.at(-1)!.time;
const initialHigh = history.at(-1)!.high;
const detector = new MarketAlertDetector();
const started = Date.now();
const observed = new Set<string>();
const trades: number[] = [], klines: number[] = [], tickers: number[] = [], approximateEventAges: number[] = [];
const processingMs: number[] = [];
const health: { feed: string; status: string; elapsedMs: number }[] = [];
let alerts = 0;
const status = (feed: string) => (value: string) => health.push({ feed, status: value, elapsedMs: Date.now() - started });
const tradeSocket = connectAggregateTradeWebSocket(market, coins.map(coin => coin.symbol), trade => {
  const entered = performance.now();
  observed.add(trade.symbol);
  if (detector.processTicker({ symbol: trade.symbol, price: trade.price }, market, trade.timestamp)) alerts++;
  processingMs.push(performance.now() - entered);
  if (trade.symbol !== symbol) return;
  trades.push(Date.now());
  approximateEventAges.push(Date.now() + clockOffsetMs - trade.timestamp);
  history = applyTradeToKlines(history, trade.price, trade.timestamp, '1m', trade.lastTradeId);
}, status('trades'));
const tickerSocket = connectTickerWebSocket(market, batch => {
  if (batch.some(tick => tick.symbol === symbol)) tickers.push(Date.now());
}, status('ticker'), coins.map(coin => coin.symbol));
const klineSocket = connectKlineWebSocket(market, symbol, '1m', candle => {
  klines.push(Date.now());
  history = upsertKline(history, candle);
}, status('klines'));

await new Promise(resolve => setTimeout(resolve, durationMs));
tradeSocket.close(); tickerSocket.close(); klineSocket.close();
const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, p95: sorted.length ? sorted[Math.floor((sorted.length - 1) * 0.95)] : null, max: sorted.at(-1) ?? null };
};
const gaps = (values: number[]) => summary(values.slice(1).map((value, i) => value - values[i]));
const report = {
  market, symbol, durationMs, subscribedSymbols: coins.length, observedTradingSymbols: observed.size,
  clockCalibration: { roundTripMs: after - before, clockOffsetMs, note: 'Event age is approximate, not a guaranteed end-to-end latency.' },
  received: { trades: trades.length, klines: klines.length, tickers: tickers.length },
  intervalMs: { trades: gaps(trades), klines: gaps(klines), ticker: gaps(tickers) },
  approximateTradeEventAgeMs: summary(approximateEventAges), detectorProcessingMs: summary(processingMs), alerts,
  candles: { initialTime, finalTime: history.at(-1)!.time, crossedMinute: history.at(-1)!.time > initialTime, highPreserved: history.find(candle => candle.time === initialTime)!.high >= initialHigh },
  feedsConnected: ['trades', 'ticker', 'klines'].every(feed => health.filter(item => item.feed === feed).at(-1)?.status === 'connected'),
  health,
};
await mkdir('artifacts/realtime', { recursive: true });
await writeFile(`artifacts/realtime/live-${market}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.feedsConnected || !trades.length || !klines.length || !tickers.length || !report.candles.highPreserved || (durationMs >= 65_000 && !report.candles.crossedMinute)) process.exitCode = 1;
