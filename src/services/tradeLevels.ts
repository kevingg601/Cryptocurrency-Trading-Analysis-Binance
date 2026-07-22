import { formatCryptoPrice } from './utils';

export interface TradeIndicatorSnapshot {
  rsi: number | null;
  sma20: number | null;
  ema50: number | null;
  bb: { middle: number; upper: number; lower: number } | null;
  macd: { macd: number; signal: number; histogram: number } | null;
}

export interface SuggestedTradeLevels {
  side: 'LONG' | 'SHORT';
  totalScore: number;
  conservativeEntry: number;
  aggressiveEntry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
}

export function deriveSuggestedTradeLevels(
  currentPrice: number,
  indicators: TradeIndicatorSnapshot
): SuggestedTradeLevels | null {
  const { rsi, sma20, ema50, bb, macd } = indicators;
  if (!bb || !macd) return null;

  let rsiScore = 0;
  if (rsi !== null) {
    if (rsi <= 35) rsiScore = 1;
    else if (rsi >= 65) rsiScore = -1;
  }

  const macdScore = macd.macd > macd.signal ? 1 : macd.macd < macd.signal ? -1 : 0;

  let bbScore = 0;
  const bbRange = bb.upper - bb.lower;
  const bbPosition = bbRange > 0 ? (currentPrice - bb.lower) / bbRange : 0.5;
  if (bbPosition <= 0.2) bbScore = 1;
  else if (bbPosition >= 0.8) bbScore = -1;

  let trendScore = 0;
  if (sma20 !== null && ema50 !== null) {
    if (currentPrice > sma20 && sma20 > ema50) trendScore = 1;
    else if (currentPrice < sma20 && sma20 < ema50) trendScore = -1;
  }

  const totalScore = (rsiScore * 1.5) + (macdScore * 1.5) + (bbScore * 1.0) + (trendScore * 1.0);
  const side: 'LONG' | 'SHORT' = totalScore < -0.5 ? 'SHORT' : 'LONG';
  const isLong = side === 'LONG';
  const conservativeEntry = isLong ? bb.lower : bb.upper;
  const aggressiveEntry = bb.middle;
  const stopLoss = isLong ? conservativeEntry * 0.985 : conservativeEntry * 1.015;
  const riskAmount = Math.abs(conservativeEntry - stopLoss);
  const takeProfit1 = isLong ? conservativeEntry + riskAmount * 1.5 : conservativeEntry - riskAmount * 1.5;
  const takeProfit2 = isLong ? conservativeEntry + riskAmount * 2.0 : conservativeEntry - riskAmount * 2.0;

  return {
    side,
    totalScore,
    conservativeEntry,
    aggressiveEntry,
    stopLoss,
    takeProfit1,
    takeProfit2,
  };
}

export function formatLevelText(label: string, value: number): string {
  return `${label} $${formatCryptoPrice(value)}`;
}
