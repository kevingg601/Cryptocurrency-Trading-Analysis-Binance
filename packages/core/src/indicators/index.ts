import type { KlineData } from '../market/types.ts';

export interface IndicatorPoint {
  time: number;
  value: number;
}

export interface BollingerBandPoint {
  time: number;
  middle: number;
  upper: number;
  lower: number;
}

export interface MACDResult {
  macdLines: IndicatorPoint[];
  signalLines: IndicatorPoint[];
  histograms: IndicatorPoint[];
}

export interface IndicatorBundleResult {
  lines: [IndicatorPoint[], IndicatorPoint[], IndicatorPoint[], IndicatorPoint[]];
  indicators: {
    rsi: number | null;
    sma20: number | null;
    ema50: number | null;
    bb: { middle: number; upper: number; lower: number } | null;
    macd: { macd: number; signal: number; histogram: number } | null;
  };
}

export function calculateSMA(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period || period <= 0) return result;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  result[period - 1] = sum / period;

  for (let i = period; i < values.length; i++) {
    sum += values[i] - values[i - period];
    result[i] = sum / period;
  }
  return result;
}

export function calculateSMASeries(data: Array<{ time: number; close: number }>, period: number): IndicatorPoint[] {
  const result: IndicatorPoint[] = [];
  if (data.length < period || period <= 0) return result;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i].close;
  result.push({ time: data[period - 1].time, value: sum / period });

  for (let i = period; i < data.length; i++) {
    sum += data[i].close - data[i - period].close;
    result.push({ time: data[i].time, value: sum / period });
  }
  return result;
}

export function calculateEMA(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period || period <= 0) return result;

  const multiplier = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = ema;

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
    result[i] = ema;
  }
  return result;
}

export function calculateEMASeries(data: Array<{ time: number; close: number }>, period: number): IndicatorPoint[] {
  const result: IndicatorPoint[] = [];
  if (data.length < period || period <= 0) return result;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i].close;
  let prevEma = sum / period;
  result.push({ time: data[period - 1].time, value: prevEma });

  const multiplier = 2 / (period + 1);
  for (let i = period; i < data.length; i++) {
    const currentEma = (data[i].close - prevEma) * multiplier + prevEma;
    result.push({ time: data[i].time, value: currentEma });
    prevEma = currentEma;
  }
  return result;
}

export function calculateRSI(values: number[], period: number = 14): Array<number | null> {
  const result: Array<number | null> = Array(values.length).fill(null);
  if (values.length <= period || period <= 0) return result;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  result[period] = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    result[i] = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

export function calculateRSILast(data: Array<{ close: number }>, period: number = 14): number | null {
  if (data.length <= period || period <= 0) return null;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = data[i].close - data[i - 1].close;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < data.length; i++) {
    const diff = data[i].close - data[i - 1].close;
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function calculateBollingerBands(
  data: Array<{ time: number; close: number }>,
  period: number = 20,
  multiplier: number = 2
): BollingerBandPoint[] {
  const result: BollingerBandPoint[] = [];
  if (data.length < period || period <= 0) return result;

  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += data[i - j].close;
    }
    const middle = sum / period;

    let varianceSum = 0;
    for (let j = 0; j < period; j++) {
      varianceSum += Math.pow(data[i - j].close - middle, 2);
    }
    const sd = Math.sqrt(varianceSum / period);

    result.push({
      time: data[i].time,
      middle,
      upper: middle + multiplier * sd,
      lower: middle - multiplier * sd,
    });
  }
  return result;
}

export function calculateMACD(
  data: Array<{ time: number; close: number }>,
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9
): MACDResult {
  const fastEma = calculateEMASeries(data, fastPeriod);
  const slowEma = calculateEMASeries(data, slowPeriod);

  const macdLines: IndicatorPoint[] = [];
  const slowStartIdx = slowPeriod - 1;
  for (let i = slowStartIdx; i < data.length; i++) {
    const fastVal = fastEma.find(e => e.time === data[i].time)?.value || 0;
    const slowVal = slowEma.find(e => e.time === data[i].time)?.value || 0;
    macdLines.push({
      time: data[i].time,
      value: fastVal - slowVal,
    });
  }

  const signalLines: IndicatorPoint[] = [];
  if (macdLines.length < signalPeriod) return { macdLines, signalLines, histograms: [] };

  let sum = 0;
  for (let i = 0; i < signalPeriod; i++) {
    sum += macdLines[i].value;
  }
  let prevSignal = sum / signalPeriod;
  signalLines.push({
    time: macdLines[signalPeriod - 1].time,
    value: prevSignal,
  });

  const multiplier = 2 / (signalPeriod + 1);
  for (let i = signalPeriod; i < macdLines.length; i++) {
    const currentSignal = (macdLines[i].value - prevSignal) * multiplier + prevSignal;
    signalLines.push({
      time: macdLines[i].time,
      value: currentSignal,
    });
    prevSignal = currentSignal;
  }

  const histograms: IndicatorPoint[] = [];
  for (let i = signalPeriod - 1; i < macdLines.length; i++) {
    const macdVal = macdLines[i].value;
    const sigVal = signalLines.find(s => s.time === macdLines[i].time)?.value || 0;
    histograms.push({
      time: macdLines[i].time,
      value: macdVal - sigVal,
    });
  }

  return { macdLines, signalLines, histograms };
}

export function indicatorBundle(klines: KlineData[]): IndicatorBundleResult {
  const sma = calculateSMASeries(klines, 20);
  const ema = calculateEMASeries(klines, 50);
  const bb = calculateBollingerBands(klines);
  const macd = calculateMACD(klines);
  const latestBb = bb.at(-1);
  const latestMacd = macd.macdLines.at(-1);
  const latestSignal = macd.signalLines.at(-1);

  return {
    lines: [
      sma,
      ema,
      bb.map(item => ({ time: item.time, value: item.upper })),
      bb.map(item => ({ time: item.time, value: item.lower })),
    ],
    indicators: {
      rsi: calculateRSILast(klines),
      sma20: sma.at(-1)?.value ?? null,
      ema50: ema.at(-1)?.value ?? null,
      bb: latestBb ? { middle: latestBb.middle, upper: latestBb.upper, lower: latestBb.lower } : null,
      macd: latestMacd && latestSignal ? { macd: latestMacd.value, signal: latestSignal.value, histogram: macd.histograms.at(-1)?.value ?? 0 } : null,
    },
  };
}
