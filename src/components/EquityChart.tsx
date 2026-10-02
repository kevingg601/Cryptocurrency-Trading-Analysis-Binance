import { useEffect, useRef } from 'react';
import { BaselineSeries, createChart } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';

interface Props {
  points: Array<{ time: number; equity: number }>;
  initialCapital: number;
  theme: 'dark' | 'light';
}

export default function EquityChart({ points, initialCapital, theme }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Baseline'> | null>(null);
  useEffect(() => {
    if (!container.current) return;
    const instance = createChart(container.current, {
      autoSize: true,
      layout: { background: { color: theme === 'dark' ? '#191c1c' : '#ffffff' }, textColor: theme === 'dark' ? '#adb5b5' : '#5f6e80' },
      grid: { vertLines: { visible: false }, horzLines: { color: theme === 'dark' ? '#ffffff0a' : '#0000000a' } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true },
      localization: { locale: 'zh-TW', priceFormatter: (value: number) => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
    });
    chart.current = instance;
    series.current = instance.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: initialCapital },
      topLineColor: '#69d6a0', bottomLineColor: '#ff858b',
      topFillColor1: '#69d6a030', topFillColor2: '#69d6a005',
      bottomFillColor1: '#ff858b05', bottomFillColor2: '#ff858b30',
      priceLineVisible: false, lineWidth: 2,
    });
    return () => { instance.remove(); chart.current = null; series.current = null; };
  }, [theme, initialCapital]);

  useEffect(() => {
    series.current?.setData(points.map(point => ({ time: point.time as UTCTimestamp, value: point.equity })));
    chart.current?.timeScale().fitContent();
  }, [points, theme, initialCapital]);

  return <div ref={container} className="equity-chart-canvas" role="img" aria-label={`帳戶淨值走勢，起始 ${initialCapital}，最終 ${points.at(-1)?.equity.toFixed(2) ?? '--'} USDT`} />;
}
