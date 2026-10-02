import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Download, Play, RefreshCw, ShieldAlert } from 'lucide-react';
import { fetchKlines } from '../services/binance';
import type { KlineData, MarketType } from '../services/binance';
import { formatCryptoPrice } from '../services/utils';
import { runBacktest } from '../services/backtest';
import type { BacktestResult, BotStrategy } from '../services/backtest';
import EquityChart from './EquityChart';

interface AutoBotLabProps {
  symbol: string;
  marketType: MarketType;
  currentPrice: number | null;
  theme: 'dark' | 'light';
}

function formatDateTime(time: number): string {
  return new Date(time * 1000).toLocaleString('zh-TW', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Taipei',
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

export default function AutoBotLab({ symbol, marketType, currentPrice, theme }: AutoBotLabProps) {
  const [strategy, setStrategy] = useState<BotStrategy>('ema-trend');
  const [timeframe, setTimeframe] = useState('15m');
  const [initialCapital, setInitialCapital] = useState(10_000);
  const [riskPct, setRiskPct] = useState(10);
  const [leverage, setLeverage] = useState(3);
  const [takeProfitPct, setTakeProfitPct] = useState(3);
  const [stopLossPct, setStopLossPct] = useState(1.5);
  const [feeBps, setFeeBps] = useState(4);
  const [slippageBps, setSlippageBps] = useState(5);
  const [dataset, setDataset] = useState<{ key: string; candles: KlineData[] } | null>(null);
  const datasetKey = `${marketType}:${symbol}:${timeframe}`;
  const requestId = useRef(0);
  const invalidateRequests = useCallback(() => { requestId.current++; }, []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchKlines(symbol, timeframe, 800, marketType);
      const duration = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400 }[timeframe] ?? 900;
      const candles = data.filter(candle => candle.time + duration <= Date.now() / 1000);
      if (id === requestId.current) setDataset({ key: datasetKey, candles });
    } catch (err) {
      if (id === requestId.current) setError(err instanceof Error ? err.message : '無法取得回測資料');
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [symbol, timeframe, marketType, datasetKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void run();
    }, 0);
    return () => { window.clearTimeout(timer); invalidateRequests(); };
  }, [run, invalidateRequests]);

  const result = useMemo(() => {
    if (loading || error || dataset?.key !== datasetKey || dataset.candles.length < 80) return null;
    try {
      return runBacktest(dataset.candles, strategy, initialCapital, riskPct, leverage, takeProfitPct, stopLossPct, feeBps, marketType, slippageBps);
    } catch { return null; }
  }, [dataset, datasetKey, loading, error, strategy, initialCapital, riskPct, leverage, takeProfitPct, stopLossPct, feeBps, marketType, slippageBps]);

  const verdict = getVerdict(result);
  const exportTrades = () => {
    if (!result) return;
    const rows = [['symbol', 'market', 'strategy', 'side', 'entry_utc', 'exit_utc', 'entry_price', 'exit_price', 'pnl_usdt', 'reason'],
      ...result.trades.map(trade => [symbol, marketType, strategy, trade.side, new Date(trade.entryTime * 1000).toISOString(), new Date(trade.exitTime * 1000).toISOString(), trade.entryPrice, trade.exitPrice, trade.pnl, trade.reason])];
    const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(row => row.join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${symbol}-${timeframe}-${strategy}-trades.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="auto-bot-lab">
      <section className="card bot-hero-card">
        <div className="bot-hero-copy">
          <div className="bot-title-row">
            <Bot size={22} color="var(--accent-secondary)" />
            <div>
              <h2>策略回測</h2>
              <p>{symbol} · {marketType === 'spot' ? '現貨・只做多・1 倍' : '合約・多空模擬'} · 紙上評估</p>
            </div>
          </div>
          <div className={`bot-verdict ${verdict.tone}`}>
            <strong>{loading ? '取得歷史資料中' : error ? '資料取得失敗' : verdict.label}</strong>
            <span>{loading ? `${symbol} · ${timeframe}` : error ?? verdict.text}</span>
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
            <input type="number" value={marketType === 'spot' ? 1 : leverage} disabled={marketType === 'spot'} min={1} max={20} step={1} onChange={(event) => setLeverage(Number(event.target.value))} />
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

          <label className="bot-field">
            <span>單邊滑價 bps</span>
            <input type="number" value={slippageBps} min={0} max={100} step={1} onChange={event => setSlippageBps(Number(event.target.value))} />
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

          <div className="bot-chart-heading"><strong>帳戶淨值</strong><span>{dataset?.key === datasetKey && dataset.candles.length > 0 ? `${formatDateTime(dataset.candles[0].time)} — ${formatDateTime(dataset.candles.at(-1)!.time)} · ${dataset.candles.length} 根已收盤 K 線` : '等待資料'}</span></div>
          {result ? <EquityChart points={result.equityCurve} initialCapital={initialCapital} theme={theme} /> : <div className="equity-chart-canvas empty-state">{loading ? '回測中...' : error ? '沒有可用資料' : '請確認參數與資料'}</div>}

          <div className="bot-note">
            收盤訊號於下一根開盤成交，扣除手續費與滑價；同根觸及止盈與止損時先計止損。回撤包含未實現損益。合約未計資金費率與強制平倉。
          </div>
        </div>
      </section>

      <section className="card bot-trades-card">
        <div className="bot-section-title">
          <span>最近交易紀錄</span>
          <button className="utility-icon-button" onClick={exportTrades} disabled={!result?.trades.length} title="匯出完整交易紀錄 CSV"><Download size={15} />匯出</button>
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
