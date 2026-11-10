import { useEffect, useRef } from 'react';
import { LineSeries, createChart } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';

interface Props {
  pointsA: Array<{ time: number; equity: number }>;
  pointsB: Array<{ time: number; equity: number }>;
  initialCapital: number;
  theme: 'dark' | 'light';
}

export default function ABEquityChart({ pointsA, pointsB, initialCapital, theme }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const seriesA = useRef<ISeriesApi<'Line'> | null>(null);
  const seriesB = useRef<ISeriesApi<'Line'> | null>(null);
  const fitted = useRef(false);

  useEffect(() => {
    if (!container.current) return;
    const instance = createChart(container.current, {
      autoSize: true,
      layout: {
        background: { color: theme === 'dark' ? '#191c1c' : '#ffffff' },
        textColor: theme === 'dark' ? '#adb5b5' : '#5f6e80',
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: theme === 'dark' ? '#ffffff0a' : '#0000000a' },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true },
      localization: {
        locale: 'zh-TW',
        priceFormatter: (value: number) =>
          value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      },
    });

    chart.current = instance;
    fitted.current = false;

    // Series A: Cyan / Blue (Conservative Baseline)
    seriesA.current = instance.addSeries(LineSeries, {
      color: '#38bdf8',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'A: 保守基準',
    });

    // Series B: Purple (AI-Gated)
    seriesB.current = instance.addSeries(LineSeries, {
      color: '#a855f7',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'B: AI 門禁',
    });

    return () => {
      instance.remove();
      chart.current = null;
      seriesA.current = null;
      seriesB.current = null;
    };
  }, [theme, initialCapital]);

  useEffect(() => {
    seriesA.current?.setData(pointsA.map(p => ({ time: p.time as UTCTimestamp, value: p.equity })));
    seriesB.current?.setData(pointsB.map(p => ({ time: p.time as UTCTimestamp, value: p.equity })));
    if (!fitted.current && (pointsA.length > 1 || pointsB.length > 1)) {
      chart.current?.timeScale().fitContent();
      fitted.current = true;
    }
  }, [pointsA, pointsB, theme, initialCapital]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: '260px' }}>
      <div
        style={{
          position: 'absolute',
          top: '8px',
          right: '12px',
          zIndex: 5,
          display: 'flex',
          gap: '14px',
          fontSize: '12px',
          fontWeight: 600,
          background: theme === 'dark' ? 'rgba(0,0,0,0.65)' : 'rgba(255,255,255,0.85)',
          padding: '4px 10px',
          borderRadius: '4px',
          pointerEvents: 'none',
        }}
      >
        <span style={{ color: '#38bdf8', display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ width: '10px', height: '3px', background: '#38bdf8', borderRadius: '1px' }}></span>
          A (基準): {pointsA.at(-1)?.equity.toFixed(2) ?? initialCapital.toFixed(2)} USDT
        </span>
        <span style={{ color: '#a855f7', display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ width: '10px', height: '3px', background: '#a855f7', borderRadius: '1px' }}></span>
          B (AI 門禁): {pointsB.at(-1)?.equity.toFixed(2) ?? initialCapital.toFixed(2)} USDT
        </span>
      </div>
      <div
        ref={container}
        className="equity-chart-canvas"
        role="img"
        aria-label="A/B 共同時間軸淨值走勢比較"
      />
    </div>
  );
}
