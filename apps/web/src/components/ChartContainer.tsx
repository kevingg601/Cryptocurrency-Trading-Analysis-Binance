import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, CandlestickSeries, createSeriesMarkers, LineSeries, LineStyle, ColorType } from 'lightweight-charts';
import type { IChartApi, IPriceLine, ISeriesApi, ISeriesMarkersPluginApi, Time, UTCTimestamp, CandlestickData, LineData, SeriesMarker, AutoscaleInfo } from 'lightweight-charts';
import { connectKlineWebSocket, fetchKlines, fetchOpenInterest } from '../services/binance';
import type { KlineData, MarketType, TickerData } from '../services/binance';
import { applyTradeToKlines, upsertKline } from '../services/liveMarket';
import type { StreamStatus } from '../services/marketStream';
import type { MarketAlert } from '../services/marketAlerts';
import { deriveSuggestedTradeLevels, formatLevelText } from '../services/tradeLevels';
import { formatCryptoPrice, getPricePrecision } from '../services/utils';
import SignalAdvisor from './SignalAdvisor';
import FollowPlanSummary from './FollowPlanSummary';
import type { FollowPlan } from '../services/followPlans';
import { followPlanLines } from '../services/followPlanLines';

interface ChartContainerProps {
  symbol: string;
  coinName: string;
  logo: string;
  currentPrice: number | null;
  liveTicker?: TickerData;
  marketType: MarketType;
  alerts?: MarketAlert[];
  followPlan?: FollowPlan;
  onHideFollowPlan?: () => void;
  onOpenPaperTrade?: (
    symbol: string,
    side?: 'LONG' | 'SHORT',
    price?: number,
    suggestedTp?: number,
    suggestedSl?: number,
    conservativeEntry?: number,
    aggressiveEntry?: number
  ) => void;
  onQuickFollowTrade?: (
    symbol: string,
    side: 'LONG' | 'SHORT',
    entryPrice: number,
    type: 'MARKET' | 'LIMIT',
    takeProfitPrice?: number,
    stopLossPrice?: number
  ) => void;
  theme: 'dark' | 'light';
}

// Indicator Calculation Helpers

// SMA Calculation
function calculateSMA(data: KlineData[], period: number): LineData[] {
  const result: LineData[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) continue;
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += data[i - j].close;
    }
    result.push({
      time: data[i].time as UTCTimestamp,
      value: sum / period,
    });
  }
  return result;
}

// EMA Helper Series
function calculateEMASeries(data: KlineData[], period: number): { time: number; value: number }[] {
  const result: { time: number; value: number }[] = [];
  if (data.length < period) return result;
  
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += data[i].close;
  }
  let prevEma = sum / period;
  result.push({
    time: data[period - 1].time,
    value: prevEma
  });
  
  const multiplier = 2 / (period + 1);
  for (let i = period; i < data.length; i++) {
    const currentEma = (data[i].close - prevEma) * multiplier + prevEma;
    result.push({
      time: data[i].time,
      value: currentEma
    });
    prevEma = currentEma;
  }
  return result;
}

// EMA for lightweight-charts format
function calculateEMA(data: KlineData[], period: number): LineData[] {
  const series = calculateEMASeries(data, period);
  return series.map(s => ({
    time: s.time as UTCTimestamp,
    value: s.value
  }));
}

// Bollinger Bands Calculation
interface BBData {
  time: number;
  middle: number;
  upper: number;
  lower: number;
}
function calculateBollingerBands(data: KlineData[], period: number = 20, multiplier: number = 2): BBData[] {
  const result: BBData[] = [];
  if (data.length < period) return result;
  
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
      lower: middle - multiplier * sd
    });
  }
  return result;
}

// MACD Calculation
interface MACDResult {
  macdLines: LineData[];
  signalLines: LineData[];
  histograms: LineData[];
}
function calculateMACD(data: KlineData[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9): MACDResult {
  const fastEma = calculateEMASeries(data, fastPeriod);
  const slowEma = calculateEMASeries(data, slowPeriod);
  
  // MACD Line = Fast EMA - Slow EMA
  const macdLines: LineData[] = [];
  const slowStartIdx = slowPeriod - 1;
  for (let i = slowStartIdx; i < data.length; i++) {
    const fastVal = fastEma.find(e => e.time === data[i].time)?.value || 0;
    const slowVal = slowEma.find(e => e.time === data[i].time)?.value || 0;
    macdLines.push({
      time: data[i].time as UTCTimestamp,
      value: fastVal - slowVal
    });
  }
  
  // Signal Line = EMA(9) of macdLines
  const signalLines: LineData[] = [];
  if (macdLines.length < signalPeriod) return { macdLines, signalLines, histograms: [] };
  
  let sum = 0;
  for (let i = 0; i < signalPeriod; i++) {
    sum += macdLines[i].value;
  }
  let prevSignal = sum / signalPeriod;
  signalLines.push({
      time: macdLines[signalPeriod - 1].time,
    value: prevSignal
  });
  
  const multiplier = 2 / (signalPeriod + 1);
  for (let i = signalPeriod; i < macdLines.length; i++) {
    const currentSignal = (macdLines[i].value - prevSignal) * multiplier + prevSignal;
    signalLines.push({
      time: macdLines[i].time,
      value: currentSignal
    });
    prevSignal = currentSignal;
  }
  
  // Histograms = MACD Line - Signal Line
  const histograms: LineData[] = [];
  for (let i = signalPeriod - 1; i < macdLines.length; i++) {
    const macdVal = macdLines[i].value;
    const sigVal = signalLines.find(s => s.time === macdLines[i].time)?.value || 0;
    histograms.push({
      time: macdLines[i].time,
      value: macdVal - sigVal
    });
  }
  
  return { macdLines, signalLines, histograms };
}

// RSI Calculation
function calculateRSI(data: KlineData[], period: number = 14): number | null {
  if (data.length <= period) return null;

  let gains = 0;
  let losses = 0;

  // First period changes
  for (let i = 1; i <= period; i++) {
    const difference = data[i].close - data[i - 1].close;
    if (difference >= 0) {
      gains += difference;
    } else {
      losses -= difference;
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Smoothing
  for (let i = period + 1; i < data.length; i++) {
    const difference = data[i].close - data[i - 1].close;
    avgGain = (avgGain * (period - 1) + (difference > 0 ? difference : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (difference < 0 ? -difference : 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function indicatorBundle(klines: KlineData[]) {
  const sma = calculateSMA(klines, 20);
  const ema = calculateEMA(klines, 50);
  const bb = calculateBollingerBands(klines);
  const macd = calculateMACD(klines);
  const latestBb = bb.at(-1);
  const latestMacd = macd.macdLines.at(-1);
  const latestSignal = macd.signalLines.at(-1);
  return {
    lines: [sma, ema, bb.map(item => ({ time: item.time as UTCTimestamp, value: item.upper })), bb.map(item => ({ time: item.time as UTCTimestamp, value: item.lower }))],
    indicators: {
      rsi: calculateRSI(klines), sma20: sma.at(-1)?.value ?? null, ema50: ema.at(-1)?.value ?? null,
      bb: latestBb ? { middle: latestBb.middle, upper: latestBb.upper, lower: latestBb.lower } : null,
      macd: latestMacd && latestSignal ? { macd: latestMacd.value, signal: latestSignal.value, histogram: macd.histograms.at(-1)?.value ?? 0 } : null,
    },
  };
}

export default function ChartContainer({ symbol, coinName, logo, currentPrice, liveTicker, marketType, alerts = [], followPlan, onHideFollowPlan, onOpenPaperTrade, onQuickFollowTrade, theme }: ChartContainerProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlestickSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const lineSeriesRef = useRef<ISeriesApi<'Line'>[]>([]);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const firstDataRef = useRef(true);
  const liveTickerRef = useRef(liveTicker);
  useEffect(() => { liveTickerRef.current = liveTicker; }, [liveTicker]);
  
  const [timeframe, setTimeframe] = useState<string>('1h');
  const [klines, setKlines] = useState<KlineData[]>([]);
  const [loadedKey, setLoadedKey] = useState('');
  const chartKey = `${marketType}:${symbol}:${timeframe}`;
  const isCurrentData = loadedKey === chartKey;
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [oiQty, setOiQty] = useState<{ key: string; quantity: number | null } | null>(null);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('connecting');
  const bundle = useMemo(() => indicatorBundle(klines), [klines]);
  const indicators = bundle.indicators;

  // Load Klines Data
  useEffect(() => {
    let active = true;
    let fetching = false;
    let ready = false;
    let health: StreamStatus = 'connecting';
    const buffer = new Map<number, KlineData>();
    const refresh = () => {
      if (fetching || !active) return;
      fetching = true;
      void fetchKlines(symbol, timeframe, 200, marketType).then(data => {
        if (!active) return;
        let merged = data;
        for (const candle of [...buffer.values()].sort((a, b) => a.time - b.time)) {
          if (candle.time >= (data[0]?.time ?? 0)) merged = upsertKline(merged, candle);
        }
        const quote = liveTickerRef.current;
        if (quote?.symbol === symbol && quote.priceSource === 'trade' && quote.priceTimestamp) merged = applyTradeToKlines(merged, quote.price, quote.priceTimestamp, timeframe, quote.tradeId);
        ready = true;
        setKlines(merged);
        setLoadedKey(chartKey);
        setLoading(false);
        setError(null);
      }).catch(err => {
        console.warn('Failed to load chart data:', err);
        if (active && !ready) { setLoading(false); setError('無法取得 K 線，請重新載入。'); }
      }).finally(() => { fetching = false; });
    };
    const stream = connectKlineWebSocket(marketType, symbol, timeframe, candle => {
      if (!active) return;
      buffer.set(candle.time, candle);
      if (buffer.size > 500) buffer.delete(buffer.keys().next().value!);
      if (ready) setKlines(previous => upsertKline(previous, candle));
    }, status => { if (active) { health = status; setStreamStatus(status); } }, refresh);
    const start = setTimeout(() => { setLoading(true); setError(null); setKlines([]); refresh(); }, 0);
    const fallback = setInterval(() => { if (health !== 'connected') refresh(); }, 5_000);
    return () => {
      active = false;
      stream.close();
      clearTimeout(start);
      clearInterval(fallback);
    };
  }, [symbol, timeframe, marketType, retry, chartKey]);

  // Load Open Interest Quantity (Futures only)
  useEffect(() => {
    let active = true;

    if (marketType === 'futures') {
      fetchOpenInterest(symbol, marketType)
        .then((qty) => {
          if (active) setOiQty({ key: `${marketType}:${symbol}`, quantity: qty });
        })
        .catch((err) => console.error('Failed to load Open Interest qty:', err));
    }

    return () => {
      active = false;
    };
  }, [symbol, marketType]);

  // Chart instances survive data and alert updates, preserving the user's zoom.
  useEffect(() => {
    if (!chartContainerRef.current) return;

    // Create chart instance
    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: theme === 'light' ? '#ffffff' : '#191c1c' },
        textColor: theme === 'light' ? '#5f6e80' : '#adb5b5',
      },
      grid: {
        vertLines: { color: theme === 'light' ? 'rgba(0, 0, 0, 0.04)' : 'rgba(255, 255, 255, 0.05)' },
        horzLines: { color: theme === 'light' ? 'rgba(0, 0, 0, 0.04)' : 'rgba(255, 255, 255, 0.05)' },
      },
      rightPriceScale: {
        borderColor: theme === 'light' ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.1)',
      },
      timeScale: {
        borderColor: theme === 'light' ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.1)',
        timeVisible: true,
        secondsVisible: false,
      },
      width: chartContainerRef.current.clientWidth,
      height: chartContainerRef.current.clientHeight,
    });

    // Create Candlestick series using v5 addSeries API
    const candlestickSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#00e676',
      downColor: '#ff1744',
      borderUpColor: '#00e676',
      borderDownColor: '#ff1744',
      wickUpColor: '#00e676',
      wickDownColor: '#ff1744',
      priceFormat: {
        type: 'price',
        precision: 5,
        minMove: 0.00001,
      },
    });

    candlestickSeriesRef.current = candlestickSeries;

    // Render SMA indicator (BB Middle) on chart
    const smaSeries = chart.addSeries(LineSeries, {
      color: '#00e5ff',
      lineWidth: 2,
    });

    // Render EMA indicator on chart
    const emaSeries = chart.addSeries(LineSeries, {
      color: '#7c4dff',
      lineWidth: 2,
    });

    // Render Bollinger Upper Band (orange dashed line)
    const bbUpperSeries = chart.addSeries(LineSeries, {
      color: '#ff7043',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed
    });

    // Render Bollinger Lower Band (purple dashed line)
    const bbLowerSeries = chart.addSeries(LineSeries, {
      color: '#ab47bc',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed
    });
    lineSeriesRef.current = [smaSeries, emaSeries, bbUpperSeries, bbLowerSeries];
    markersRef.current = createSeriesMarkers(candlestickSeries, [], { zOrder: 'top' });
    priceLinesRef.current = [];
    firstDataRef.current = true;
    chartRef.current = chart;

    const container = chartContainerRef.current;
    const observer = new ResizeObserver(() => {
      if (container.clientWidth > 0 && container.clientHeight > 0) chart.resize(container.clientWidth, container.clientHeight);
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      candlestickSeriesRef.current = null;
      lineSeriesRef.current = [];
      markersRef.current = null;
      priceLinesRef.current = [];
    };
  }, [theme, chartKey]);

  // Trades update the actual event-time bucket; authoritative klines reconcile OHLCV.
  useEffect(() => {
    if (!isCurrentData || liveTicker?.symbol !== symbol || liveTicker.priceSource !== 'trade' || !liveTicker.priceTimestamp) return;
    const timer = setTimeout(() => setKlines(previous => applyTradeToKlines(previous, liveTicker.price, liveTicker.priceTimestamp!, timeframe, liveTicker.tradeId)), 0);
    return () => clearTimeout(timer);
  }, [isCurrentData, liveTicker, symbol, timeframe]);

  useEffect(() => {
    const candles = candlestickSeriesRef.current;
    if (!isCurrentData || !candles || !klines.length) return;
    const precision = getPricePrecision(klines[klines.length - 1].close);
    candles.applyOptions({ priceFormat: { type: 'price', precision, minMove: 10 ** -precision } });
    candles.applyOptions({ autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
      const scale = original();
      if (!scale?.priceRange || !followPlan) return scale;
      const prices = followPlanLines(followPlan).map(line => line.price);
      return { ...scale, priceRange: { minValue: Math.min(scale.priceRange.minValue, ...prices), maxValue: Math.max(scale.priceRange.maxValue, ...prices) } };
    } });
    const data: CandlestickData[] = klines.map(candle => ({ ...candle, time: candle.time as UTCTimestamp }));
    candles.setData(data);
    bundle.lines.forEach((line, index) => lineSeriesRef.current[index]?.setData(line));
    if (firstDataRef.current) { chartRef.current?.timeScale().fitContent(); firstDataRef.current = false; }
    const levels = deriveSuggestedTradeLevels(klines[klines.length - 1].close, bundle.indicators);
    const options = followPlan && followPlan.symbol === symbol && followPlan.marketType === marketType
      ? followPlanLines(followPlan).map(line => ({ ...line, title: formatLevelText(line.title, line.price), lineStyle: LineStyle.Dashed }))
      : levels ? [
      { price: levels.conservativeEntry, color: levels.side === 'LONG' ? '#00e5ff' : '#ff7043', title: formatLevelText(levels.conservativePlan.mode === 'WAIT_CONFIRMATION' ? levels.side === 'LONG' ? '待收復' : '待跌破' : '保守觀察', levels.conservativeEntry), lineStyle: LineStyle.Dashed },
      { price: levels.aggressiveEntry, color: '#7c4dff', title: formatLevelText(levels.aggressivePlan.mode === 'WAIT_CONFIRMATION' ? levels.side === 'LONG' ? '待收復中軌' : '待跌破中軌' : '激進觀察', levels.aggressiveEntry), lineStyle: LineStyle.Dashed },
      { price: levels.takeProfit1, color: '#00e676', title: formatLevelText(levels.marketPlanValid ? 'TP1' : '條件 TP1', levels.takeProfit1), lineStyle: LineStyle.Dotted },
      { price: levels.stopLoss, color: '#ff1744', title: formatLevelText(levels.marketPlanValid ? 'SL' : '條件 SL', levels.stopLoss), lineStyle: LineStyle.Dotted },
    ] : [];
    while (priceLinesRef.current.length > options.length) candles.removePriceLine(priceLinesRef.current.pop()!);
    options.forEach((option, index) => {
      if (priceLinesRef.current[index]) priceLinesRef.current[index].applyOptions(option);
      else priceLinesRef.current[index] = candles.createPriceLine({ ...option, lineWidth: 1, axisLabelVisible: true });
    });
  }, [klines, bundle, isCurrentData, chartKey, theme, followPlan, symbol, marketType]);

  useEffect(() => {
    if (!isCurrentData || !klines.length) return;
    const markers: SeriesMarker<Time>[] = alerts.filter(alert => alert.marketType === marketType && alert.symbol === symbol)
      .slice(0, 30).map(alert => {
        const nearest = [...klines].reverse().find(candle => candle.time <= alert.timestamp / 1000) ?? klines[0];
        const bullish = alert.type === 'pump' || alert.type === 'whale-buy';
        return { id: alert.id, time: nearest.time as UTCTimestamp, position: bullish ? 'belowBar' : 'aboveBar', shape: bullish ? 'arrowUp' : 'arrowDown', color: bullish ? '#00e676' : '#ff1744', text: `${alert.type.startsWith('whale') ? '巨鯨' : bullish ? '急漲' : '急跌'} $${formatCryptoPrice(alert.price)}` } satisfies SeriesMarker<Time>;
      }).sort((a, b) => Number(a.time) - Number(b.time));
    markersRef.current?.setMarkers(markers);
  }, [alerts, klines, isCurrentData, chartKey, theme, marketType, symbol]);

  const timeframes = [
    { label: '1m', value: '1m' },
    { label: '5m', value: '5m' },
    { label: '15m', value: '15m' },
    { label: '1h', value: '1h' },
    { label: '4h', value: '4h' },
    { label: '1d', value: '1d' }
  ];

  // Dynamically compute current Open Interest USD value
  const openInterestUSD = (oiQty?.key === `${marketType}:${symbol}` && oiQty.quantity !== null && currentPrice !== null) ? oiQty.quantity * currentPrice : null;
  const tradeLevels = isCurrentData && !loading && !error && klines.length > 0 && currentPrice !== null ? deriveSuggestedTradeLevels(currentPrice, indicators) : null;

  return (
    <div className="chart-workspace-content" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className={`card chart-card${followPlan ? ' has-follow-plan' : ''}`}>
        <div className="chart-header">
          <div className="chart-title-section">
            {logo ? <img src={logo} alt={coinName} className="coin-logo" /> : <div className="focus-logo-fallback">{symbol.slice(0, 2)}</div>}
            <h2 className="logo-text">{coinName}<span>即時線圖</span></h2>
            <div className="chart-coin-badge">
              <span className="coin-symbol">{symbol}</span>
            </div>
          </div>
          
          <div className="timeframe-selector">
            {timeframes.map((tf) => (
              <button
                key={tf.value}
                className={`timeframe-btn ${timeframe === tf.value ? 'active' : ''}`}
                onClick={() => setTimeframe(tf.value)}
              >
                {tf.label}
              </button>
            ))}
          </div>
          <span className="chart-stream-status" role="status" title="K 線串流狀態">{streamStatus === 'connected' ? 'K 線同步中' : 'K 線待同步'}</span>
        </div>

        {followPlan && <FollowPlanSummary plan={followPlan} onClose={onHideFollowPlan} />}
        <div className="chart-container" style={{ position: 'relative' }}>
          {(loading || error || !isCurrentData) && (
            <div style={{
              position: 'absolute',
              top: 0, left: 0, right: 0, bottom: 0,
              background: 'var(--bg-secondary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 10,
              borderRadius: 'var(--radius-md)'
            }}>
              {error ? <div role="alert" className="chart-error"><span>{error}</span><button className="utility-icon-button" onClick={() => setRetry(value => value + 1)}>重新載入</button></div> : <span role="status">{symbol} · {timeframe} 載入中...</span>}
            </div>
          )}
          <div ref={chartContainerRef} className="chart-canvas-host" />
        </div>

        {tradeLevels && !followPlan && (
          <div className="entry-level-strip">
            <div className={`entry-level-side ${tradeLevels.side.toLowerCase()}`}>
              {!tradeLevels.marketPlanValid ? tradeLevels.side === 'LONG' ? '等待收復' : '等待跌破' : tradeLevels.side === 'LONG' ? '多方觀察點' : '空方觀察點'}
            </div>
            <div>
              <span>{tradeLevels.conservativePlan.mode === 'WAIT_CONFIRMATION' ? tradeLevels.side === 'LONG' ? '保守 · 待收復' : '保守 · 待跌破' : '保守觀察'}</span>
              <strong>${formatCryptoPrice(tradeLevels.conservativeEntry)}</strong>
            </div>
            <div>
              <span>{tradeLevels.aggressivePlan.mode === 'WAIT_CONFIRMATION' ? tradeLevels.side === 'LONG' ? '激進 · 待收復' : '激進 · 待跌破' : '激進觀察'}</span>
              <strong>${formatCryptoPrice(tradeLevels.aggressiveEntry)}</strong>
            </div>
            <div>
              <span>{tradeLevels.marketPlanValid ? 'TP1' : '條件 TP1'}</span>
              <strong className="trend-up">${formatCryptoPrice(tradeLevels.takeProfit1)}</strong>
            </div>
            <div>
              <span>{tradeLevels.marketPlanValid ? 'SL' : '條件 SL'}</span>
              <strong className="trend-down">${formatCryptoPrice(tradeLevels.stopLoss)}</strong>
            </div>
          </div>
        )}

        <div className="indicator-panel">
          <div className="indicator-pill">
            <span className="indicator-pill-label">RSI (14)</span>
            <span className="indicator-pill-val">
              {isCurrentData && indicators.rsi !== null ? indicators.rsi.toFixed(2) : '--'}
            </span>
          </div>
          <div className="indicator-pill">
            <span className="indicator-pill-label">MACD (12, 26)</span>
            <span className="indicator-pill-val" style={{ color: '#ffb300' }}>
              {isCurrentData && indicators.macd ? indicators.macd.macd.toFixed(4) : '--'}
            </span>
          </div>
          <div className="indicator-pill">
            <span className="indicator-pill-label">SMA (20) / 中軌</span>
            <span className="indicator-pill-val" style={{ color: '#00e5ff' }}>
              {isCurrentData && indicators.sma20 !== null ? `$${formatCryptoPrice(indicators.sma20)}` : '--'}
            </span>
          </div>
          <div className="indicator-pill">
            <span className="indicator-pill-label">EMA (50)</span>
            <span className="indicator-pill-val" style={{ color: '#7c4dff' }}>
              {isCurrentData && indicators.ema50 !== null ? `$${formatCryptoPrice(indicators.ema50)}` : '--'}
            </span>
          </div>
        </div>
      </div>

      {/* Render the AI Trade Advisor Panel */}
      {isCurrentData && !loading && !error && klines.length > 0 && <SignalAdvisor
        symbol={symbol}
        currentPrice={currentPrice}
        indicators={indicators}
        openInterest={openInterestUSD}
        onOpenPaperTrade={onOpenPaperTrade}
        onQuickFollowTrade={onQuickFollowTrade}
      />}
    </div>
  );
}
