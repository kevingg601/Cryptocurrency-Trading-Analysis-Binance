import test from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest } from '../src/services/backtest.ts';
import { deriveSuggestedTradeLevels } from '../src/services/tradeLevels.ts';

const candles = Array.from({ length: 240 }, (_, i) => {
  const close = 100 + 12 * Math.sin(i / 9);
  const open = 100 + 12 * Math.sin((i - 1) / 9);
  return { time: 1_700_000_000 + i * 900, open, close, high: Math.max(open, close) + 0.5, low: Math.min(open, close) - 0.5, volume: 100 };
});
const run = (market: 'spot' | 'futures' = 'futures', fees = 0, slip = 0, leverage = 1) => runBacktest(candles, 'ema-trend', 10000, 10, leverage, 3, 1.5, fees, market, slip);

test('spot never shorts and ignores leverage', () => {
  const result = run('spot');
  assert.ok(result.trades.length > 0);
  assert.ok(result.trades.every(trade => trade.side === 'LONG'));
  assert.deepEqual(run('spot', 0, 0, 20), result);
});

test('entries execute at a later candle open, not the signal close', () => {
  const result = run();
  assert.ok(result.trades.length > 0);
  for (const trade of result.trades) {
    const candle = candles.find(item => item.time === trade.entryTime)!;
    assert.equal(trade.entryPrice, candle.open);
    assert.ok(trade.exitTime >= trade.entryTime);
  }
});

test('costs reduce net returns and all trades reconcile to final equity', () => {
  assert.ok(run('futures', 10, 0).finalEquity < run().finalEquity);
  const result = run('futures', 4, 5);
  assert.ok(Math.abs(result.finalEquity - (10000 + result.trades.reduce((sum, trade) => sum + trade.pnl, 0))) < 1e-8);
  assert.equal(result.equityCurve.at(-1)!.equity, result.finalEquity);
  assert.ok(result.equityCurve.every((point, i, all) => i === 0 || point.time > all[i - 1].time));
});

test('stop wins when a candle touches both TP and SL', () => {
  const baseline = run();
  const entry = baseline.trades[0].entryTime;
  const wide = candles.map(candle => candle.time === entry ? { ...candle, high: candle.open * 1.1, low: candle.open * 0.9 } : candle);
  const result = runBacktest(wide, 'ema-trend', 10000, 10, 1, 3, 1.5, 0);
  assert.equal(result.trades[0].reason, 'SL');
  assert.ok(result.trades[0].pnl < 0);
});

test('flat prices do not create trades and invalid parameters fail', () => {
  const flat = candles.map(candle => ({ ...candle, open: 100, high: 100, low: 100, close: 100 }));
  assert.equal(runBacktest(flat, 'rsi-reversal', 10000, 10, 1, 3, 1.5, 4).trades.length, 0);
  assert.throws(() => runBacktest(candles, 'ema-trend', 0, 10, 1, 3, 1.5, 4));
  assert.throws(() => runBacktest(candles, 'ema-trend', 10000, 101, 1, 3, 1.5, 4));
});

test('profit targets remain beyond both market and suggested entries', () => {
  const bullish = { rsi: 50, sma20: 100, ema50: 90, bb: { middle: 100, upper: 120, lower: 80 }, macd: { macd: 2, signal: 1, histogram: 1 } };
  const long = deriveSuggestedTradeLevels(110, bullish)!;
  assert.equal(long.side, 'LONG');
  assert.ok(long.takeProfit1 > 110 && long.takeProfit1 > long.aggressiveEntry);
  const short = deriveSuggestedTradeLevels(110, { ...bullish, rsi: 80, macd: { macd: -2, signal: -1, histogram: -1 } })!;
  assert.equal(short.side, 'SHORT');
  assert.ok(short.takeProfit1 < 110 && short.takeProfit1 < short.aggressiveEntry);
});
