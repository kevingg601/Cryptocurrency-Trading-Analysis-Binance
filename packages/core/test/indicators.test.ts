import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateSMA,
  calculateEMA,
  calculateRSI,
  calculateRSILast,
  calculateBollingerBands,
  calculateMACD,
  indicatorBundle,
} from '../src/indicators/index.ts';
import type { KlineData } from '../src/market/types.ts';

test('review: flat-market RSI is neutral in both series and snapshot calculations', () => {
  const closes = Array(30).fill(100);
  assert.equal(calculateRSI(closes).at(-1), 50);
  assert.equal(calculateRSILast(closes.map(close => ({ close }))), 50);
});

test('calculateSMA calculates correct moving average', () => {
  const values = [1, 2, 3, 4, 5];
  const sma3 = calculateSMA(values, 3);
  assert.equal(sma3[0], null);
  assert.equal(sma3[1], null);
  assert.equal(sma3[2], 2); // (1+2+3)/3
  assert.equal(sma3[3], 3); // (2+3+4)/3
  assert.equal(sma3[4], 4); // (3+4+5)/3
});

test('calculateEMA weights recent values higher than SMA', () => {
  const values = [10, 10, 10, 10, 20];
  const ema = calculateEMA(values, 3);
  assert.equal(ema[0], null);
  assert.equal(ema[1], null);
  assert.equal(ema[2], 10);
  assert.ok(ema[4]! > 13); // SMA would be (10+10+20)/3 = 13.333
});

test('calculateRSI returns bounds between 0 and 100', () => {
  const values = Array.from({ length: 30 }, (_, i) => 100 + i * 2);
  const rsi = calculateRSI(values, 14);
  const lastRsi = rsi.at(-1);
  assert.ok(lastRsi !== null && lastRsi !== undefined);
  assert.ok(lastRsi >= 0 && lastRsi <= 100);
  assert.equal(lastRsi, 100); // Monotonically rising -> RSI 100
});

test('calculateBollingerBands returns middle, upper, lower bands', () => {
  const data = Array.from({ length: 30 }, (_, i) => ({
    time: 1000 + i * 60,
    close: 100 + (i % 2 === 0 ? 2 : -2),
  }));
  const bb = calculateBollingerBands(data, 20, 2);
  assert.ok(bb.length > 0);
  const last = bb.at(-1)!;
  assert.ok(last.upper > last.middle);
  assert.ok(last.lower < last.middle);
  assert.ok(Math.abs(last.middle - 100) < 0.5);
});

test('calculateMACD returns macd, signal, and histogram arrays', () => {
  const data = Array.from({ length: 40 }, (_, i) => ({
    time: 1000 + i * 60,
    close: 50 + Math.sin(i / 5) * 10,
  }));
  const macd = calculateMACD(data);
  assert.ok(macd.macdLines.length > 0);
  assert.ok(macd.signalLines.length > 0);
  assert.ok(macd.histograms.length > 0);
});

test('indicatorBundle computes full suite of indicators on klines', () => {
  const klines: KlineData[] = Array.from({ length: 60 }, (_, i) => ({
    time: 1000 + i * 60,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100.5 + i,
    volume: 500,
  }));
  const result = indicatorBundle(klines);
  assert.ok(result.indicators.rsi !== null);
  assert.ok(result.indicators.sma20 !== null);
  assert.ok(result.indicators.ema50 !== null);
  assert.ok(result.indicators.bb !== null);
  assert.ok(result.indicators.macd !== null);
});
