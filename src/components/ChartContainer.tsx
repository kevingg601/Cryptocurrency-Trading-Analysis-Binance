import { useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries, createSeriesMarkers, LineSeries, LineStyle } from 'lightweight-charts';
import type { CandlestickData, LineData, SeriesMarker } from 'lightweight-charts';
import { fetchKlines, fetchOpenInterest } from '../services/binance';
import type { KlineData, MarketType } from '../services/binance';
import type { MarketAlert } from '../services/marketAlerts';
import { deriveSuggestedTradeLevels, formatLevelText } from '../services/tradeLevels';
import { formatCryptoPrice } from '../services/utils';
import SignalAdvisor from './SignalAdvisor';

interface ChartContainerProps {
  symbol: string;
  coinName: string;
  logo: string;
  currentPrice: number | null;
  marketType: MarketType;
  alerts?: MarketAlert[];
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
      time: data[i].time as any,
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
    time: s.time as any,
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
      time: data[i].time as any,
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
    time: macdLines[signalPeriod - 1].time as any,
    value: prevSignal
  });
  
  const multiplier = 2 / (signalPeriod + 1);
  for (let i = signalPeriod; i < macdLines.length; i++) {
    const currentSignal = (macdLines[i].value - prevSignal) * multiplier + prevSignal;
    signalLines.push({
      time: macdLines[i].time as any,
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
      time: macdLines[i].time as any,
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

export default function ChartContainer({ symbol, coinName, logo, currentPrice, marketType, alerts = [], onOpenPaperTrade, onQuickFollowTrade, theme }: ChartContainerProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const candlestickSeriesRef = useRef<any>(null);
  
  const [timeframe, setTimeframe] = useState<string>('1h');
  const [klines, setKlines] = useState<KlineData[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [oiQty, setOiQty] = useState<number | null>(null);
  
  const [indicators, setIndicators] = useState<{
    rsi: number | null;
    sma20: number | null;
    ema50: number | null;
    bb: { middle: number; upper: number; lower: number } | null;
    macd: { macd: number; signal: number; histogram: number } | null;
  }>({ rsi: null, sma20: null, ema50: null, bb: null, macd: null });

  // Load Klines Data
  useEffect(() => {
    let active = true;
    setLoading(true);
    
    fetchKlines(symbol, timeframe, 200, marketType)
      .then((data) => {
        if (!active) return;
        setKlines(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load chart data:', err);
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [symbol, timeframe, marketType]);

  // Load Open Interest Quantity (Futures only)
  useEffect(() => {
    let active = true;
    setOiQty(null);

    if (marketType === 'futures') {
      fetchOpenInterest(symbol, marketType)
        .then((qty) => {
          if (active) setOiQty(qty);
        })
        .catch((err) => console.error('Failed to load Open Interest qty:', err));
    }

    return () => {
      active = false;
    };
  }, [symbol, marketType]);

  // Create / Recreate Chart
  useEffect(() => {
    if (!chartContainerRef.current || klines.length === 0) return;

    // Create chart instance
    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: 'solid' as any, color: theme === 'light' ? '#ffffff' : '#0d1527' },
        textColor: theme === 'light' ? '#5f6e80' : '#8a99ad',
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
      height: 400,
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

    // Convert data to format required by lightweight-charts
    const chartData: CandlestickData[] = klines.map(k => ({
      time: k.time as any,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
    }));
    candlestickSeries.setData(chartData);

    // Calculate Indicators
    const sma20Data = calculateSMA(klines, 20);
    const ema50Data = calculateEMA(klines, 50);
    const latestRsi = calculateRSI(klines, 14);

    const bbData = calculateBollingerBands(klines, 20, 2);
    const macdData = calculateMACD(klines, 12, 26, 9);

    // Map BB upper and lower bands for line series
    const bbUpperData: LineData[] = bbData.map(b => ({ time: b.time as any, value: b.upper }));
    const bbLowerData: LineData[] = bbData.map(b => ({ time: b.time as any, value: b.lower }));

    // Render SMA indicator (BB Middle) on chart
    const smaSeries = chart.addSeries(LineSeries, {
      color: '#00e5ff',
      lineWidth: 2,
    });
    smaSeries.setData(sma20Data);

    // Render EMA indicator on chart
    const emaSeries = chart.addSeries(LineSeries, {
      color: '#7c4dff',
      lineWidth: 2,
    });
    emaSeries.setData(ema50Data);

    // Render Bollinger Upper Band (orange dashed line)
    const bbUpperSeries = chart.addSeries(LineSeries, {
      color: '#ff7043',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed
    });
    bbUpperSeries.setData(bbUpperData);

    // Render Bollinger Lower Band (purple dashed line)
    const bbLowerSeries = chart.addSeries(LineSeries, {
      color: '#ab47bc',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed
    });
    bbLowerSeries.setData(bbLowerData);

    const latestIndicators = {
      rsi: latestRsi,
      sma20: sma20Data.length > 0 ? sma20Data[sma20Data.length - 1].value : null,
      ema50: ema50Data.length > 0 ? ema50Data[ema50Data.length - 1].value : null,
      bb: bbData.length > 0 ? {
        middle: bbData[bbData.length - 1].middle,
        upper: bbData[bbData.length - 1].upper,
        lower: bbData[bbData.length - 1].lower,
      } : null,
      macd: (macdData.macdLines.length > 0 && macdData.signalLines.length > 0) ? {
        macd: macdData.macdLines[macdData.macdLines.length - 1].value,
        signal: macdData.signalLines[macdData.signalLines.length - 1].value,
        histogram: macdData.histograms.length > 0 ? macdData.histograms[macdData.histograms.length - 1].value : 0,
      } : null
    };

    const levels = deriveSuggestedTradeLevels(klines[klines.length - 1].close, latestIndicators);

    if (levels) {
      const entryColor = levels.side === 'LONG' ? '#00e5ff' : '#ff7043';
      const aggressiveColor = '#7c4dff';
      candlestickSeries.createPriceLine({
        price: levels.conservativeEntry,
        color: entryColor,
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: formatLevelText('保守入場', levels.conservativeEntry),
      });
      candlestickSeries.createPriceLine({
        price: levels.aggressiveEntry,
        color: aggressiveColor,
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: formatLevelText('激進入場', levels.aggressiveEntry),
      });
      candlestickSeries.createPriceLine({
        price: levels.takeProfit1,
        color: '#00e676',
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: formatLevelText('TP1', levels.takeProfit1),
      });
      candlestickSeries.createPriceLine({
        price: levels.stopLoss,
        color: '#ff1744',
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: formatLevelText('SL', levels.stopLoss),
      });
    }

    const alertMarkers: SeriesMarker<any>[] = alerts
      .map((alert) => {
        const alertTime = Math.floor(alert.timestamp / 1000);
        const nearest = [...klines].reverse().find((kline) => kline.time <= alertTime) ?? klines[klines.length - 1];
        const isBullish = alert.type === 'pump' || alert.type === 'whale-buy';
        const shortType = alert.type === 'whale-buy' || alert.type === 'whale-sell' ? '巨鯨' : isBullish ? '急漲' : '急跌';
        return {
          id: alert.id,
          time: nearest.time as any,
          position: isBullish ? 'belowBar' : 'aboveBar',
          shape: isBullish ? 'arrowUp' : 'arrowDown',
          color: isBullish ? '#00e676' : '#ff1744',
          text: `${shortType} $${formatCryptoPrice(alert.price)}`,
          size: alert.quoteValue ? 1.45 : 1.15,
        } satisfies SeriesMarker<any>;
      })
      .slice(0, 30);
    createSeriesMarkers(candlestickSeries, alertMarkers, { zOrder: 'top' });

    chartRef.current = chart;

    // Update state indicators
    setIndicators(latestIndicators);

    // Responsive resize handler
    const handleResize = () => {
      if (chartContainerRef.current && chartRef.current) {
        chartRef.current.resize(chartContainerRef.current.clientWidth, 400);
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
      chartRef.current = null;
      candlestickSeriesRef.current = null;
    };
  }, [klines, theme, alerts]);

  // Handle Real-Time Price ticks to update the chart in real time!
  useEffect(() => {
    if (!candlestickSeriesRef.current || klines.length === 0 || currentPrice === null) return;

    const lastKline = klines[klines.length - 1];
    const latestClose = currentPrice;
    
    // Create new tick candle updating the last candle
    // Binance WebSocket sends live close, but if we don't have new time interval yet, update last candle
    const updatedCandle: CandlestickData = {
      time: lastKline.time as any,
      open: lastKline.open,
      high: Math.max(lastKline.high, latestClose),
      low: Math.min(lastKline.low, latestClose),
      close: latestClose,
    };

    candlestickSeriesRef.current.update(updatedCandle);
  }, [currentPrice, klines]);

  const timeframes = [
    { label: '1m', value: '1m' },
    { label: '5m', value: '5m' },
    { label: '15m', value: '15m' },
    { label: '1h', value: '1h' },
    { label: '4h', value: '4h' },
    { label: '1d', value: '1d' }
  ];

  // Dynamically compute current Open Interest USD value
  const openInterestUSD = (oiQty !== null && currentPrice !== null) ? oiQty * currentPrice : null;
  const tradeLevels = currentPrice !== null ? deriveSuggestedTradeLevels(currentPrice, indicators) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="card chart-card">
        <div className="chart-header">
          <div className="chart-title-section">
            <img src={logo} alt={coinName} className="coin-logo" />
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
        </div>

        <div className="chart-container" style={{ position: 'relative' }}>
          {loading && (
            <div style={{
              position: 'absolute',
              top: 0, left: 0, right: 0, bottom: 0,
              background: 'rgba(13, 21, 39, 0.8)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 10,
              borderRadius: 'var(--radius-md)'
            }}>
              載入中...
            </div>
          )}
          <div ref={chartContainerRef} style={{ width: '100%', height: '400px' }} />
        </div>

        {tradeLevels && (
          <div className="entry-level-strip">
            <div className={`entry-level-side ${tradeLevels.side.toLowerCase()}`}>
              {tradeLevels.side === 'LONG' ? '做多窗口' : '做空窗口'}
            </div>
            <div>
              <span>保守</span>
              <strong>${formatCryptoPrice(tradeLevels.conservativeEntry)}</strong>
            </div>
            <div>
              <span>激進</span>
              <strong>${formatCryptoPrice(tradeLevels.aggressiveEntry)}</strong>
            </div>
            <div>
              <span>TP1</span>
              <strong className="trend-up">${formatCryptoPrice(tradeLevels.takeProfit1)}</strong>
            </div>
            <div>
              <span>SL</span>
              <strong className="trend-down">${formatCryptoPrice(tradeLevels.stopLoss)}</strong>
            </div>
          </div>
        )}

        <div className="indicator-panel">
          <div className="indicator-pill">
            <span className="indicator-pill-label">RSI (14)</span>
            <span className="indicator-pill-val">
              {indicators.rsi ? indicators.rsi.toFixed(2) : 'N/A'}
            </span>
          </div>
          <div className="indicator-pill">
            <span className="indicator-pill-label">MACD (12, 26)</span>
            <span className="indicator-pill-val" style={{ color: '#ffb300' }}>
              {indicators.macd ? indicators.macd.macd.toFixed(4) : 'N/A'}
            </span>
          </div>
          <div className="indicator-pill">
            <span className="indicator-pill-label">SMA (20) / 中軌</span>
            <span className="indicator-pill-val" style={{ color: '#00e5ff' }}>
              {indicators.sma20 ? `$${formatCryptoPrice(indicators.sma20)}` : 'N/A'}
            </span>
          </div>
          <div className="indicator-pill">
            <span className="indicator-pill-label">EMA (50)</span>
            <span className="indicator-pill-val" style={{ color: '#7c4dff' }}>
              {indicators.ema50 ? `$${formatCryptoPrice(indicators.ema50)}` : 'N/A'}
            </span>
          </div>
        </div>
      </div>

      {/* Render the AI Trade Advisor Panel */}
      <SignalAdvisor
        symbol={symbol}
        currentPrice={currentPrice}
        indicators={indicators}
        openInterest={openInterestUSD}
        onOpenPaperTrade={onOpenPaperTrade}
        onQuickFollowTrade={onQuickFollowTrade}
      />
    </div>
  );
}
