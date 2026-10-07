import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import AutoTrading from '../../src/components/AutoTrading';
import { AutoTradingEngine, defaultAutoTradingConfig, isAutoTradingActive } from '../../src/services/autoTrading';
import type { AutoTradingConfig, AutoTradingSnapshot } from '../../src/services/autoTrading';
import type { AutoSymbolRules } from '../../src/services/autoTradingMarket';
import { loadAutoTradingBatches, saveAutoTradingBatch } from '../../src/services/autoTradingStorage';
import { FollowPlanTracker } from '../../src/services/followPlans';
import type { FollowPlanEvent } from '../../src/services/followPlans';
import type { MarketAlert } from '../../src/services/marketAlerts';
import type { MarketTradeFrame } from '../../src/services/marketEvents';
import '../../src/index.css';
import '../../src/App.css';

const SYMBOL = 'TESTUSDT';
const RULE: AutoSymbolRules = { stepSize: 0.001, minQty: 0.001, maxQty: 1_000_000, minNotional: 5 };
// A dedicated origin, not just a different path, isolates the fixed production DB name.
const STORAGE_ORIGIN = 'http://localhost:5174';
const storageEnabled = location.origin === STORAGE_ORIGIN && new URLSearchParams(location.search).get('storage') === '1';
const storageHint = `IndexedDB QA only: ${STORAGE_ORIGIN}/tests/fixtures/auto-trading.html?storage=1 (fixture-only origin)`;

class ReplayDriver {
  readonly engine = new AutoTradingEngine('futures');
  readonly tracker = new FollowPlanTracker();
  readonly batchIds = new Set<string>();
  readonly frames: MarketTradeFrame[] = [];
  readonly events: FollowPlanEvent[] = [];
  clock = Date.now() - 5_000;
  side: 'LONG' | 'SHORT' = 'LONG';
  healthy = true;
  private tradeId = 0;

  constructor() {
    this.engine.setRules({ [SYMBOL]: RULE });
    this.engine.setStreamHealthy(true, this.clock);
  }

  advance(ms = 1) {
    this.clock += ms;
    return this.clock;
  }

  start(side = this.side, config: AutoTradingConfig = defaultAutoTradingConfig('futures')) {
    const now = this.advance();
    if (isAutoTradingActive(this.engine.snapshot().status)) this.engine.interrupt(now, '合成重播重設');
    this.side = side;
    this.tracker.reset();
    this.frames.length = 0;
    this.events.length = 0;
    this.healthy = true;
    this.engine.setRules({ [SYMBOL]: RULE });
    this.engine.setStreamHealthy(true, this.advance());
    this.engine.start(config, this.advance(), { fixtureReplay: 1 });
    this.batchIds.add(this.engine.snapshot().id);
  }

  mirror(price: number) { return this.side === 'LONG' ? price : 200 - price; }

  feed(price: number, ms = 100, alertSide?: 'LONG' | 'SHORT') {
    const now = this.advance(ms);
    const trade = { symbol: SYMBOL, price, timestamp: now, lastTradeId: ++this.tradeId,
      quantity: 1, quoteValue: price, side: 'buy' as const };
    const alert: MarketAlert | null = alertSide ? {
      id: `fixture-${this.engine.snapshot().id}-${this.tradeId}`, symbol: SYMBOL, marketType: 'futures',
      type: alertSide === 'LONG' ? 'pump' : 'dump', price,
      referencePrice: price + (alertSide === 'LONG' ? -10 : 10), referenceTimestamp: now - 1,
      timestamp: now, title: 'TEST 合成急漲跌', message: '開發重播，非市場成交',
    } : null;
    const { events } = this.tracker.processMarketTrade(trade, 'futures', alert, now);
    const plans = this.tracker.getPlans();
    const frame: MarketTradeFrame = { trade, marketType: 'futures', receivedAt: now, alert,
      confirmations: events.filter(event => event.type === 'follow-confirmed').flatMap(event => {
        const plan = plans.find(item => item.id === event.planId);
        return plan ? [{ event, plan }] : [];
      }) };
    this.events.push(...events);
    this.frames.push(frame);
    this.engine.processFrame(frame);
  }

  confirm() {
    this.feed(this.mirror(110), 100, this.side);
    this.feed(this.mirror(106));
    this.feed(this.mirror(107));
    this.feed(this.mirror(107), 3_000);
  }

  fill() {
    const state = this.engine.snapshot();
    const entry = state.orders.find(order => order.kind === 'ENTRY');
    const price = entry?.plan?.confirmedEntry ?? state.positions[0]?.currentPrice;
    if (price !== undefined) this.feed(price, state.config.latencyMs);
  }

  exit(reason: 'TP1' | 'TP2' | 'SL' | 'REVERSAL') {
    const state = this.engine.snapshot();
    const position = state.positions[0];
    if (!position) return;
    const price = reason === 'TP1' ? position.takeProfit1 : reason === 'TP2' ? position.takeProfit2
      : reason === 'SL' ? position.stopLoss : position.currentPrice;
    this.feed(price, 100, reason === 'REVERSAL' ? (position.side === 'LONG' ? 'SHORT' : 'LONG') : undefined);
    this.feed(price, state.config.latencyMs);
  }

  disconnect() {
    this.healthy = false;
    this.engine.setStreamHealthy(false, this.clock);
    const now = this.advance(5_001);
    this.tracker.tick(now);
    this.engine.tick(now);
  }
}

export function Replay() {
  const [driver] = useState(() => new ReplayDriver());
  const [snapshot, setSnapshot] = useState(() => driver.engine.snapshot());
  const [light, setLight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState<AutoTradingSnapshot | null>(null);
  const [history, setHistory] = useState<AutoTradingSnapshot[]>([]);
  const [savedIds] = useState(() => new Set<string>());
  const [selected, setSelected] = useState<{ symbol: string; planId?: string } | null>(null);

  useEffect(() => { document.body.className = light ? 'light-theme' : 'dark-theme'; }, [light]);

  function run(action: () => void) {
    try { action(); setError(null); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    setSnapshot(driver.engine.snapshot());
  }

  async function saveAndLoad() {
    if (!storageEnabled || saving || snapshot.status === 'IDLE') return;
    const batch = driver.engine.snapshot();
    setSaving(true); setLoaded(null); setStorageError(null);
    try {
      const previous = await loadAutoTradingBatches();
      if (previous.some(item => item.id === batch.id) && !savedIds.has(batch.id)) {
        throw new Error('批次 ID 已存在，未覆寫既有紀錄；請重設後再試。');
      }
      await saveAutoTradingBatch(batch);
      savedIds.add(batch.id);
      const batches = await loadAutoTradingBatches();
      const restored = batches.find(item => item.id === batch.id);
      if (!restored || JSON.stringify(restored) !== JSON.stringify(batch)) throw new Error('IndexedDB 回讀與保存快照不一致。');
      setLoaded(restored);
      setHistory(batches.filter(item => savedIds.has(item.id)));
    } catch (failure) {
      setStorageError(failure instanceof Error ? failure.message : String(failure));
    } finally { setSaving(false); }
  }

  const active = isAutoTradingActive(snapshot.status);
  const entryPending = snapshot.orders.some(order => order.kind === 'ENTRY');
  const canExit = active && snapshot.positions.length > 0 && !snapshot.orders.length;

  return <main className="auto-replay">
    <h1>Auto Trading 合成重播 QA</h1>
    <p className="auto-replay-warning" role="note">僅開發測試：合成價格與時間，不連接市場，不代表市場績效。localhost:5174 為 fixture 專用來源，勿於此來源執行一般應用。</p>
    <div className="auto-replay-controls" role="group" aria-label="合成重播控制">
      <button type="button" disabled={saving} onClick={() => run(() => driver.start('LONG'))}>重設做多</button>
      <button type="button" disabled={saving} onClick={() => run(() => driver.start('SHORT'))}>重設做空</button>
      <button type="button" disabled={snapshot.status !== 'RUNNING' || driver.tracker.getPlans().length > 0 || saving}
        onClick={() => run(() => driver.confirm())}>完成回撤確認</button>
      <button type="button" disabled={!active || !snapshot.orders.length || saving} onClick={() => run(() => driver.fill())}>成交</button>
      <button type="button" disabled={!canExit || snapshot.positions[0]?.tp1Hit || saving} onClick={() => run(() => driver.exit('TP1'))}>TP1</button>
      <button type="button" disabled={!canExit || saving} onClick={() => run(() => driver.exit('TP2'))}>TP2</button>
      <button type="button" disabled={!canExit || saving} onClick={() => run(() => driver.exit('SL'))}>止損</button>
      <button type="button" disabled={!canExit || saving} onClick={() => run(() => driver.exit('REVERSAL'))}>反向</button>
      <button type="button" disabled={!active || saving} onClick={() => run(() => driver.disconnect())}>五秒中斷</button>
      <button type="button" aria-pressed={light} onClick={() => setLight(value => !value)}>明暗</button>
      <button type="button" title={storageHint} disabled={!storageEnabled || snapshot.status === 'IDLE' || saving}
        onClick={() => { void saveAndLoad(); }}>保存再讀取</button>
    </div>
    {error && <p role="alert">{error}</p>}
    <output data-testid="replay-state">{driver.side} / {snapshot.status} / {entryPending ? '等待延遲成交' : '待處理委託 ' + snapshot.orders.length}
      {' / '}時間 {driver.clock} / 逐筆 {driver.frames.length} / 追蹤事件 {driver.events.map(event => event.type).join(' → ') || '無'}</output>
    <output data-testid="storage-result" aria-live="polite">{saving ? '保存及回讀中' : loaded ? `已回讀 ${loaded.id} / ${loaded.status}`
      : storageEnabled ? 'IndexedDB：尚未保存' : 'IndexedDB：停用（僅 localhost:5174 + storage=1 啟用）'}</output>
    <output data-testid="selected-symbol" aria-live="polite">最後選取：{selected ? `${selected.symbol} / ${selected.planId ?? '--'}` : '--'}</output>
    <AutoTrading snapshot={snapshot} theme={light ? 'light' : 'dark'} ready={driver.healthy} history={history} storageError={storageError}
      onStart={config => run(() => driver.start(driver.side, config))}
      onPause={() => run(() => driver.engine.pause(driver.advance()))}
      onResume={() => run(() => driver.engine.resume(driver.advance()))}
      onDrain={() => run(() => driver.engine.drain(driver.advance()))}
      onCloseAll={() => run(() => driver.engine.closeAll(driver.advance()))}
      onSelectSymbol={(symbol, planId) => setSelected({ symbol, planId })} />
    <details><summary>重播快照</summary><pre data-testid="replay-snapshot">{JSON.stringify({ snapshot, plans: driver.tracker.getPlans(),
      events: driver.events, frames: driver.frames }, null, 2)}</pre></details>
  </main>;
}

const root = document.getElementById('root')!;
if (import.meta.env.DEV) createRoot(root).render(<Replay />);
else root.textContent = 'Development-only fixture.';
