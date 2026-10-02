import type { KlineData, MarketType } from './binance';

export type BotStrategy = 'ema-trend' | 'rsi-reversal';
type BotSide = 'LONG' | 'SHORT';

interface BacktestTrade {
  id: string;
  side: BotSide;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  reason: 'TP' | 'SL' | 'SIGNAL' | 'END';
}

export interface BacktestResult {
  equityCurve: Array<{ time: number; equity: number }>;
  trades: BacktestTrade[];
  finalEquity: number;
  returnPct: number;
  winRate: number;
  maxDrawdownPct: number;
  profitFactor: number;
  currentSignal: '做多' | '做空' | '等待';
}

function calculateEMA(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period) return result;

  const multiplier = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = ema;

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
    result[i] = ema;
  }

  return result;
}

function calculateRSI(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = Array(values.length).fill(null);
  if (values.length <= period) return result;

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

function getStrategySignal(
  strategy: BotStrategy,
  closes: number[],
  index: number,
  fastEma: Array<number | null>,
  slowEma: Array<number | null>,
  rsi: Array<number | null>
): BotSide | null {
  if (index <= 0) return null;

  if (strategy === 'ema-trend') {
    const prevFast = fastEma[index - 1];
    const prevSlow = slowEma[index - 1];
    const currentFast = fastEma[index];
    const currentSlow = slowEma[index];
    if (prevFast === null || prevSlow === null || currentFast === null || currentSlow === null) return null;
    if (prevFast <= prevSlow && currentFast > currentSlow) return 'LONG';
    if (prevFast >= prevSlow && currentFast < currentSlow) return 'SHORT';
    return null;
  }

  const prevRsi = rsi[index - 1];
  const currentRsi = rsi[index];
  if (prevRsi === null || currentRsi === null) return null;
  if (prevRsi < 30 && currentRsi >= 30 && closes[index] > closes[index - 1]) return 'LONG';
  if (prevRsi > 70 && currentRsi <= 70 && closes[index] < closes[index - 1]) return 'SHORT';
  return null;
}

export function runBacktest(
  candles: KlineData[],
  strategy: BotStrategy,
  initialCapital: number,
  riskPct: number,
  leverage: number,
  takeProfitPct: number,
  stopLossPct: number,
  feeBps: number,
  marketType: MarketType = 'futures',
  slippageBps: number = 5
): BacktestResult {
  if (![initialCapital, riskPct, leverage, takeProfitPct, stopLossPct, feeBps, slippageBps].every(Number.isFinite)
    || initialCapital <= 0 || riskPct <= 0 || riskPct > 100 || leverage < 1 || leverage > 20
    || takeProfitPct <= 0 || takeProfitPct >= 100 || stopLossPct <= 0 || stopLossPct >= 100
    || feeBps < 0 || slippageBps < 0) throw new Error('Invalid backtest parameters');
  const closes = candles.map(candle => candle.close);
  const fastEma = calculateEMA(closes, 12);
  const slowEma = calculateEMA(closes, 26);
  const rsi = calculateRSI(closes, 14);
  const feeRate = feeBps / 10_000;
  const slippage = slippageBps / 10_000;
  const effectiveLeverage = marketType === 'spot' ? 1 : leverage;

  let equity = initialCapital;
  let peakEquity = initialCapital;
  let maxDrawdownPct = 0;
  let position: {
    side: BotSide;
    entryTime: number;
    entryPrice: number;
    notional: number;
    entryFee: number;
  } | null = null;

  const trades: BacktestTrade[] = [];
  const equityCurve: Array<{ time: number; equity: number }> = [{ time: candles[0]?.time ?? 0, equity }];

  const closePosition = (candle: KlineData, exitPrice: number, reason: BacktestTrade['reason']) => {
    if (!position) return;
    const direction = position.side === 'LONG' ? 1 : -1;
    exitPrice *= 1 - direction * slippage;
    const rawPct = ((exitPrice - position.entryPrice) / position.entryPrice) * direction;
    const exitFee = position.notional * (exitPrice / position.entryPrice) * feeRate;
    const pnl = position.notional * rawPct - position.entryFee - exitFee;
    equity += pnl;

    trades.push({
      id: `${position.entryTime}-${candle.time}-${position.side}`,
      side: position.side,
      entryTime: position.entryTime,
      exitTime: candle.time,
      entryPrice: position.entryPrice,
      exitPrice,
      pnl,
      pnlPct: (pnl / initialCapital) * 100,
      reason,
    });

    peakEquity = Math.max(peakEquity, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, ((peakEquity - equity) / peakEquity) * 100);
    position = null;
  };

  for (let i = 30; i < candles.length; i++) {
    const candle = candles[i];
    // A completed candle's signal can execute only at the following open.
    const signal = getStrategySignal(strategy, closes, i - 1, fastEma, slowEma, rsi);
    if (position && signal && signal !== position.side) {
      closePosition(candle, candle.open, 'SIGNAL');
    }
    if (!position && signal && equity > 0 && (marketType === 'futures' || signal === 'LONG')) {
      const notional = equity * (riskPct / 100) * effectiveLeverage;
      position = {
        side: signal, entryTime: candle.time,
        entryPrice: candle.open * (1 + (signal === 'LONG' ? 1 : -1) * slippage),
        notional, entryFee: notional * feeRate,
      };
    }

    if (position) {
      const tp = position.side === 'LONG'
        ? position.entryPrice * (1 + takeProfitPct / 100)
        : position.entryPrice * (1 - takeProfitPct / 100);
      const sl = position.side === 'LONG'
        ? position.entryPrice * (1 - stopLossPct / 100)
        : position.entryPrice * (1 + stopLossPct / 100);

      const touchedSl = position.side === 'LONG' ? candle.low <= sl : candle.high >= sl;
      const touchedTp = position.side === 'LONG' ? candle.high >= tp : candle.low <= tp;

      if (touchedSl) {
        const gapPrice = position.side === 'LONG' ? Math.min(candle.open, sl) : Math.max(candle.open, sl);
        closePosition(candle, gapPrice, 'SL');
      } else if (touchedTp) {
        closePosition(candle, tp, 'TP');
      }
    }
    const markedEquity = position
      ? equity - position.entryFee + position.notional * ((candle.close / position.entryPrice) - 1) * (position.side === 'LONG' ? 1 : -1)
      : equity;
    peakEquity = Math.max(peakEquity, markedEquity);
    maxDrawdownPct = Math.max(maxDrawdownPct, ((peakEquity - markedEquity) / peakEquity) * 100);
    equityCurve.push({ time: candle.time, equity: markedEquity });
  }

  if (position && candles.length > 0) {
    const lastCandle = candles[candles.length - 1];
    closePosition(lastCandle, lastCandle.close, 'END');
    equityCurve[equityCurve.length - 1] = { time: lastCandle.time, equity };
  }

  const winningTrades = trades.filter(trade => trade.pnl > 0);
  const losingTrades = trades.filter(trade => trade.pnl < 0);
  const grossProfit = winningTrades.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losingTrades.reduce((sum, trade) => sum + trade.pnl, 0));
  const latestSignal = getStrategySignal(strategy, closes, candles.length - 1, fastEma, slowEma, rsi);

  return {
    equityCurve,
    trades,
    finalEquity: equity,
    returnPct: ((equity - initialCapital) / initialCapital) * 100,
    winRate: trades.length > 0 ? (winningTrades.length / trades.length) * 100 : 0,
    maxDrawdownPct,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0,
    currentSignal: latestSignal === 'LONG' ? '做多' : latestSignal === 'SHORT' && marketType === 'futures' ? '做空' : '等待',
  };
}
