import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CandlestickSeries, ColorType, createChart, LineStyle } from 'lightweight-charts';
import type { IChartApi, IPriceLine, ISeriesApi, UTCTimestamp, AutoscaleInfo } from 'lightweight-charts';
import MarketAlertCenter from '../../src/components/MarketAlertCenter';
import FollowPlanSummary from '../../src/components/FollowPlanSummary';
import { FollowPlanTracker } from '../../src/services/followPlans';
import type { FollowPlanEvent, MarketNotification } from '../../src/services/followPlans';
import { followPlanLines } from '../../src/services/followPlanLines';
import { DEFAULT_MARKET_ALERT_SETTINGS } from '../../src/services/marketAlerts';
import type { MarketAlert } from '../../src/services/marketAlerts';
import type { TickerData } from '../../src/services/binance';
import '../../src/index.css';
import '../../src/App.css';

function history(epoch: number) {
  return Array.from({ length: 60 }, (_, i) => {
    const close = 100 + Math.sin(i * 0.45) * 1.8;
    return { time: (Math.floor(epoch / 1000) - 60 + i) as UTCTimestamp, open: close - 0.1, high: close + 0.3, low: close - 0.3, close };
  });
}

function Replay() {
  const tracker = useRef(new FollowPlanTracker());
  const epoch = useRef(Date.now());
  const offset = useRef(0);
  const sequence = useRef(0);
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const lastBar = useRef<ReturnType<typeof history>[number] | null>(null);
  const [plans, setPlans] = useState(tracker.current.getPlans());
  const [alerts, setAlerts] = useState<MarketAlert[]>([]);
  const [events, setEvents] = useState<FollowPlanEvent[]>([]);
  const [toast, setToast] = useState<MarketNotification | null>(null);
  const [side, setSide] = useState<'LONG' | 'SHORT'>('LONG');
  const [light, setLight] = useState(false);
  const [selected, setSelected] = useState<string | undefined>();
  const plan = plans.find(item => item.id === selected) ?? plans[0];

  useEffect(() => {
    document.body.className = light ? 'light-theme' : 'dark-theme';
    if (!host.current) return;
    const instance = createChart(host.current, { width: host.current.clientWidth, height: 360,
      layout: { background: { type: ColorType.Solid, color: light ? '#ffffff' : '#191c1c' }, textColor: light ? '#52615c' : '#b4beba' },
      grid: { vertLines: { color: light ? '#e8eeeb' : '#252c29' }, horzLines: { color: light ? '#e8eeeb' : '#252c29' } },
      timeScale: { timeVisible: true, secondsVisible: true },
    });
    candles.current = instance.addSeries(CandlestickSeries, { upColor: '#30b889', downColor: '#ed6378', borderVisible: false, wickUpColor: '#30b889', wickDownColor: '#ed6378', priceFormat: { type: 'price', precision: 3, minMove: 0.001 } });
    candles.current.setData(history(epoch.current));
    lastBar.current = null;
    instance.timeScale().fitContent();
    chart.current = instance;
    lines.current = [];
    const observer = new ResizeObserver(() => instance.resize(host.current!.clientWidth, 360));
    observer.observe(host.current);
    return () => { observer.disconnect(); instance.remove(); candles.current = null; chart.current = null; };
  }, [light]);
  useEffect(() => {
    const series = candles.current;
    if (!series) return;
    lines.current.forEach(line => series.removePriceLine(line));
    lines.current = plan ? followPlanLines(plan).map(line => series.createPriceLine({ ...line, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true })) : [];
    series.applyOptions({ autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
      const scale = original();
      if (!scale?.priceRange || !plan) return scale;
      const prices = followPlanLines(plan).map(line => line.price);
      return { ...scale, priceRange: { minValue: Math.min(scale.priceRange.minValue, ...prices), maxValue: Math.max(scale.priceRange.maxValue, ...prices) } };
    } });
  }, [plan, light]);

  function start(short = false) {
    tracker.current.reset(); offset.current = 0; setSelected(undefined); setEvents([]);
    candles.current?.setData(history(epoch.current));
    lastBar.current = null;
    setSide(short ? 'SHORT' : 'LONG');
    const alert: MarketAlert = { id: `replay-${++sequence.current}`, type: short ? 'dump' : 'pump', marketType: 'futures', symbol: short ? 'DROPUSDT' : 'PUMPUSDT', price: short ? 98 : 102,
      referencePrice: 100, referenceTimestamp: epoch.current - 100, timestamp: epoch.current,
      title: short ? 'DROP 短線暴跌' : 'PUMP 短線暴漲', message: '重播成交：0.1 秒內異動 2%', };
    const created = tracker.current.observeAlert(alert, epoch.current)!;
    const published = { ...alert, followPlanId: created.id };
    setAlerts([published]); setToast(published); setPlans(tracker.current.getPlans());
  }
  function feed(price: number, advance = 100) {
    offset.current += advance;
    const time = epoch.current + offset.current;
    const barTime = Math.floor(time / 1000) as UTCTimestamp;
    const previous = lastBar.current;
    const open = previous?.time === barTime ? previous.open : previous?.close ?? plans[0].triggerPrice;
    const bar = { time: barTime, open, high: Math.max(previous?.time === barTime ? previous.high : open, price), low: Math.min(previous?.time === barTime ? previous.low : open, price), close: price };
    candles.current?.update(bar);
    lastBar.current = bar;
    const emitted = tracker.current.processTrade({ symbol: plans[0].symbol, price, timestamp: time, lastTradeId: offset.current, quantity: 1, quoteValue: price, side: 'buy' }, 'futures', time);
    if (emitted.length) { setEvents(current => [...emitted].reverse().concat(current)); setToast(emitted.at(-1)!); }
    setPlans(tracker.current.getPlans());
  }
  const ticker = plan ? { symbol: plan.symbol, price: plan.currentPrice } as TickerData : null;
  return <main style={{ padding: '20px', maxWidth: '1200px', margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
    <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '16px' }}><h1 style={{ fontSize: '18px' }}>跟進計畫成交重播 QA</h1>
      <MarketAlertCenter alerts={alerts} followPlans={plans} followEvents={events} activeToast={toast} unreadCount={events.length + alerts.length} notificationPermission="default" settings={DEFAULT_MARKET_ALERT_SETTINGS} tickers={ticker ? { [ticker.symbol]: ticker } : {}} monitoredCount={2}
        onEnableDesktopAlerts={async () => false} onSettingsChange={() => {}} onMarkAllRead={() => {}} onClearAlerts={() => { setAlerts([]); setEvents([]); }} onDismissToast={() => setToast(null)} onSelectSymbol={(_, id) => setSelected(id)} />
    </header>
    <div className="replay-controls" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '16px' }}>
      <button className="preset-btn" onClick={() => start(false)}>急漲重播</button><button className="preset-btn" onClick={() => start(true)}>急跌重播</button>
      <button className="preset-btn" disabled={!plan} onClick={() => feed(side === 'LONG' ? 101 : 99)}>進入回撤區</button>
      <button className="preset-btn" disabled={!plan} onClick={() => feed(side === 'LONG' ? 101.3 : 98.7)}>開始確認</button>
      <button className="preset-btn" disabled={!plan} onClick={() => feed(side === 'LONG' ? 101.3 : 98.7, 3000)}>維持三秒</button>
      <button className="preset-btn" disabled={!plan?.confirmedEntry} onClick={() => feed(plan!.takeProfit1)}>觸及 TP1</button><button className="preset-btn" disabled={!plan?.confirmedEntry} onClick={() => feed(plan!.takeProfit2)}>觸及 TP2</button>
      <button className="preset-btn" disabled={!plan} onClick={() => feed(plan!.stopLoss)}>觸及止損</button>
      <button className="preset-btn" disabled={!plan} onClick={() => { offset.current += 5100; tracker.current.tick(epoch.current + offset.current); setPlans(tracker.current.getPlans()); }}>資料延遲</button>
      <button className="preset-btn" disabled={!plan} onClick={() => { tracker.current.tick(plan!.expiresAt); setPlans(tracker.current.getPlans()); }}>觀察到期</button>
      <button className="preset-btn" onClick={() => setLight(value => !value)}>{light ? '深色主題' : '日間主題'}</button>
    </div>
    {plan && <FollowPlanSummary plan={plan} now={epoch.current + offset.current} />}
    <div ref={host} style={{ width: '100%', height: '360px' }} aria-label="重播 K 線" />
    <output style={{ display: 'block', marginTop: '12px', fontSize: '12px' }}>通知紀錄：{events.map(event => event.type).join(' → ') || '尚未確認'}</output>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Replay />);
