import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Play, RefreshCw, ShieldAlert } from 'lucide-react';
import { fetchKlines } from '../services/binance';
import type { KlineData, MarketType } from '../services/binance';
import { formatCryptoPrice } from '../services/utils';

type BotStrategy = 'ema-trend' | 'rsi-reversal';
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

interface BacktestResult {
  equityCurve: Array<{ time: number; equity: number }>;
  trades: BacktestTrade[];
  finalEquity: number;
  returnPct: number;
  winRate: number;
  maxDrawdownPct: number;
  profitFactor: number;
  currentSignal: '做多' | '做空' | '等待';
}

interface AutoBotLabProps {
  symbol: string;
  marketType: MarketType;
  currentPrice: number | null;
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
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
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

function runBacktest(
  candles: KlineData[],
  strategy: BotStrategy,
  initialCapital: number,
  riskPct: number,
  leverage: number,
  takeProfitPct: number,
  stopLossPct: number,
  feeBps: number
): BacktestResult {
  const closes = candles.map(candle => candle.close);
  const fastEma = calculateEMA(closes, 12);
  const slowEma = calculateEMA(closes, 26);
  const rsi = calculateRSI(closes, 14);
  const feeRate = feeBps / 10_000;

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
    const rawPct = ((exitPrice - position.entryPrice) / position.entryPrice) * direction;
    const exitFee = position.notional * feeRate;
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
    equityCurve.push({ time: candle.time, equity });
    position = null;
  };

  for (let i = 30; i < candles.length; i++) {
    const candle = candles[i];

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
        closePosition(candle, sl, 'SL');
        continue;
      }
      if (touchedTp) {
        closePosition(candle, tp, 'TP');
        continue;
      }
    }

    const signal = getStrategySignal(strategy, closes, i, fastEma, slowEma, rsi);
    if (!signal) continue;

    if (position && signal !== position.side) {
      closePosition(candle, candle.close, 'SIGNAL');
    }

    if (!position && equity > 0) {
      const margin = equity * (riskPct / 100);
      const notional = margin * leverage;
      position = {
        side: signal,
        entryTime: candle.time,
        entryPrice: candle.close,
        notional,
        entryFee: notional * feeRate,
      };
    }
  }

  if (position && candles.length > 0) {
    const lastCandle = candles[candles.length - 1];
    closePosition(lastCandle, lastCandle.close, 'END');
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
    currentSignal: latestSignal === 'LONG' ? '做多' : latestSignal === 'SHORT' ? '做空' : '等待',
  };
}

function formatDateTime(time: number): string {
  return new Date(time * 1000).toLocaleString('zh-TW', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getVerdict(result: BacktestResult | null): { label: string; tone: 'good' | 'bad' | 'neutral'; text: string } {
  if (!result || result.trades.length < 8) {
    return { label: '樣本不足', tone: 'neutral', text: '交易次數太少，不能判斷策略是否真的有效。' };
  }
  if (result.returnPct > 0 && result.profitFactor >= 1.2 && result.maxDrawdownPct <= 25) {
    return { label: '可繼續觀察', tone: 'good', text: '回測呈現正報酬，但仍需要換幣種、換週期做更多測試。' };
  }
  if (result.returnPct < 0 || result.profitFactor < 1) {
    return { label: '目前不合格', tone: 'bad', text: '這組參數在這段資料沒有正期望值，不適合拿去自動交易。' };
  }
  return { label: '邊際策略', tone: 'neutral', text: '數據不差但優勢不明顯，需要降低風險或調整參數。' };
}

export default function AutoBotLab({ symbol, marketType, currentPrice }: AutoBotLabProps) {
  const [strategy, setStrategy] = useState<BotStrategy>('ema-trend');
  const [timeframe, setTimeframe] = useState('15m');
  const [initialCapital, setInitialCapital] = useState(10_000);
  const [riskPct, setRiskPct] = useState(10);
  const [leverage, setLeverage] = useState(3);
  const [takeProfitPct, setTakeProfitPct] = useState(3);
  const [stopLossPct, setStopLossPct] = useState(1.5);
  const [feeBps, setFeeBps] = useState(4);
  const [candles, setCandles] = useState<KlineData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchKlines(symbol, timeframe, 800, marketType);
      setCandles(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '無法取得回測資料');
    } finally {
      setLoading(false);
    }
  }, [symbol, timeframe, marketType]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void run();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [run]);

  const result = useMemo(() => {
    if (candles.length < 80) return null;
    return runBacktest(candles, strategy, initialCapital, riskPct, leverage, takeProfitPct, stopLossPct, feeBps);
  }, [candles, strategy, initialCapital, riskPct, leverage, takeProfitPct, stopLossPct, feeBps]);

  const verdict = getVerdict(result);
  const equityMin = result ? Math.min(...result.equityCurve.map(point => point.equity)) : 0;
  const equityMax = result ? Math.max(...result.equityCurve.map(point => point.equity)) : 0;

  return (
    <div className="auto-bot-lab">
      <section className="card bot-hero-card">
        <div className="bot-hero-copy">
          <div className="bot-title-row">
            <Bot size={22} color="var(--accent-secondary)" />
            <div>
              <h2>自動交易機器人實驗室</h2>
              <p>只做回測與紙上評估，不接真實交易所下單。</p>
            </div>
          </div>
          <div className={`bot-verdict ${verdict.tone}`}>
            <strong>{verdict.label}</strong>
            <span>{verdict.text}</span>
          </div>
        </div>

        <div className="bot-live-signal">
          <span>目前策略訊號</span>
          <strong className={
            result?.currentSignal === '做多'
              ? 'trend-up-text'
              : result?.currentSignal === '做空'
              ? 'trend-down-text'
              : ''
          }>
            {result?.currentSignal ?? '等待資料'}
          </strong>
          <small>{symbol} · {timeframe} · 最新 {currentPrice ? `$${formatCryptoPrice(currentPrice)}` : '--'}</small>
        </div>
      </section>

      <section className="bot-layout">
        <div className="card bot-settings-card">
          <div className="bot-section-title">
            <ShieldAlert size={17} />
            <span>策略與風控</span>
          </div>

          <label className="bot-field">
            <span>策略</span>
            <select value={strategy} onChange={(event) => setStrategy(event.target.value as BotStrategy)}>
              <option value="ema-trend">EMA 趨勢跟隨</option>
              <option value="rsi-reversal">RSI 均值回歸</option>
            </select>
          </label>

          <label className="bot-field">
            <span>K 線週期</span>
            <select value={timeframe} onChange={(event) => setTimeframe(event.target.value)}>
              <option value="5m">5m</option>
              <option value="15m">15m</option>
              <option value="1h">1h</option>
              <option value="4h">4h</option>
            </select>
          </label>

          <label className="bot-field">
            <span>初始資金 USDT</span>
            <input type="number" value={initialCapital} min={100} step={100} onChange={(event) => setInitialCapital(Number(event.target.value))} />
          </label>

          <label className="bot-field">
            <span>單筆使用資金</span>
            <input type="number" value={riskPct} min={1} max={100} step={1} onChange={(event) => setRiskPct(Number(event.target.value))} />
            <small>{riskPct}% 帳戶資金作為保證金</small>
          </label>

          <label className="bot-field">
            <span>槓桿</span>
            <input type="number" value={leverage} min={1} max={20} step={1} onChange={(event) => setLeverage(Number(event.target.value))} />
          </label>

          <div className="bot-two-col">
            <label className="bot-field">
              <span>止盈 %</span>
              <input type="number" value={takeProfitPct} min={0.2} max={20} step={0.1} onChange={(event) => setTakeProfitPct(Number(event.target.value))} />
            </label>
            <label className="bot-field">
              <span>止損 %</span>
              <input type="number" value={stopLossPct} min={0.2} max={20} step={0.1} onChange={(event) => setStopLossPct(Number(event.target.value))} />
            </label>
          </div>

          <label className="bot-field">
            <span>單邊手續費 bps</span>
            <input type="number" value={feeBps} min={0} max={20} step={0.5} onChange={(event) => setFeeBps(Number(event.target.value))} />
          </label>

          <button className="bot-run-button" onClick={() => void run()} disabled={loading}>
            {loading ? <RefreshCw size={15} className="spin-icon" /> : <Play size={15} />}
            <span>{loading ? '回測中...' : '重新回測'}</span>
          </button>

          {error && <div className="bot-error">{error}</div>}
        </div>

        <div className="card bot-results-card">
          <div className="bot-stats-grid">
            <div className="bot-stat">
              <span>總報酬</span>
              <strong className={(result?.returnPct ?? 0) >= 0 ? 'trend-up-text' : 'trend-down-text'}>
                {result ? `${result.returnPct >= 0 ? '+' : ''}${result.returnPct.toFixed(2)}%` : '--'}
              </strong>
            </div>
            <div className="bot-stat">
              <span>最終資金</span>
              <strong>{result ? `$${result.finalEquity.toFixed(2)}` : '--'}</strong>
            </div>
            <div className="bot-stat">
              <span>勝率</span>
              <strong>{result ? `${result.winRate.toFixed(1)}%` : '--'}</strong>
            </div>
            <div className="bot-stat">
              <span>最大回撤</span>
              <strong className="trend-down-text">{result ? `${result.maxDrawdownPct.toFixed(2)}%` : '--'}</strong>
            </div>
            <div className="bot-stat">
              <span>Profit Factor</span>
              <strong>{result ? (Number.isFinite(result.profitFactor) ? result.profitFactor.toFixed(2) : '∞') : '--'}</strong>
            </div>
            <div className="bot-stat">
              <span>交易次數</span>
              <strong>{result ? result.trades.length : '--'}</strong>
            </div>
          </div>

          <div className="bot-equity-chart">
            {result?.equityCurve.map((point, index) => {
              const range = equityMax - equityMin || 1;
              const height = 12 + ((point.equity - equityMin) / range) * 88;
              const positive = point.equity >= initialCapital;
              return (
                <span
                  key={`${point.time}-${index}`}
                  style={{ height: `${height}%` }}
                  className={positive ? 'positive' : 'negative'}
                  title={`${formatDateTime(point.time)} $${point.equity.toFixed(2)}`}
                />
              );
            })}
          </div>

          <div className="bot-note">
            回測採用收盤訊號、下一段用同根 K 線高低點檢查 TP/SL；若同時碰到 TP 和 SL，保守假設先停損。
          </div>
        </div>
      </section>

      <section className="card bot-trades-card">
        <div className="bot-section-title">
          <span>最近交易紀錄</span>
        </div>
        <div className="bot-trade-table-wrap">
          <table className="bot-trade-table">
            <thead>
              <tr>
                <th>方向</th>
                <th>進場</th>
                <th>出場</th>
                <th>進場價</th>
                <th>出場價</th>
                <th>盈虧</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {result?.trades.slice(-20).reverse().map(trade => (
                <tr key={trade.id}>
                  <td className={trade.side === 'LONG' ? 'trend-up-text' : 'trend-down-text'}>{trade.side}</td>
                  <td>{formatDateTime(trade.entryTime)}</td>
                  <td>{formatDateTime(trade.exitTime)}</td>
                  <td>${formatCryptoPrice(trade.entryPrice)}</td>
                  <td>${formatCryptoPrice(trade.exitPrice)}</td>
                  <td className={trade.pnl >= 0 ? 'trend-up-text' : 'trend-down-text'}>
                    {trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}
                  </td>
                  <td>{trade.reason}</td>
                </tr>
              ))}
              {(!result || result.trades.length === 0) && (
                <tr>
                  <td colSpan={7}>這段資料沒有觸發交易。</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
