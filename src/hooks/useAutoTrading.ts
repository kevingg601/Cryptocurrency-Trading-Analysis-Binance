import { useCallback, useEffect, useRef, useState } from 'react';
import type { MarketType } from '../services/binance';
import { AutoTradingEngine, idleAutoTradingSnapshot, isAutoTradingActive } from '../services/autoTrading';
import type { AutoTradingConfig, AutoTradingNotification, AutoTradingSnapshot } from '../services/autoTrading';
import type { MarketTradeFrame } from '../services/marketEvents';
import { fetchAutoFundingHistory, fetchAutoSymbolRules } from '../services/autoTradingMarket';
import { loadAutoTradingBatches, saveAutoTradingBatch } from '../services/autoTradingStorage';
import type { StreamHealth, StreamStatus } from '../services/marketStream';

export function useAutoTrading(marketType: MarketType) {
  const engineRef = useRef(new AutoTradingEngine(marketType));
  const [snapshot, setSnapshot] = useState<AutoTradingSnapshot>(() => idleAutoTradingSnapshot(marketType));
  const [history, setHistory] = useState<AutoTradingSnapshot[]>([]);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('正在載入評估紀錄與交易規格');
  const [ready, setReady] = useState(false);
  const [universeSymbols, setUniverseSymbols] = useState<string[]>([]);
  const loadedRef = useRef(false);
  const rulesReadyRef = useRef(false);
  const healthRef = useRef(false);
  const storageFailedRef = useRef(false);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const revisionRef = useRef(-1);
  const persistedRef = useRef(-1);
  const notifierRef = useRef<((notification: AutoTradingNotification) => void) | null>(null);
  const signalSettingsRef = useRef<Record<string, number>>({});
  const fundingBusy = useRef(false);
  const batchesRef = useRef(new Map<string, AutoTradingSnapshot>());

  const publish = useCallback(() => {
    const engine = engineRef.current;
    if (revisionRef.current !== engine.revision) {
      const next = engine.snapshot();
      revisionRef.current = engine.revision;
      setSnapshot(next);
      if (next.id !== 'idle') {
        batchesRef.current.set(next.id, next);
        setHistory([...batchesRef.current.values()].sort((a, b) => b.startedAt - a.startedAt));
      }
    }
    engine.takeNotifications().forEach(notification => notifierRef.current?.(notification));
  }, []);
  const persist = useCallback(() => {
    const engine = engineRef.current;
    if (!loadedRef.current || storageFailedRef.current || persistedRef.current === engine.revision) return;
    const next = engine.snapshot();
    if (next.id === 'idle') return;
    persistedRef.current = engine.revision;
    queueRef.current = queueRef.current.then(() => saveAutoTradingBatch(next)).catch(error => {
      storageFailedRef.current = true;
      setStorageError(`無法保存評估紀錄：${error instanceof Error ? error.message : '儲存失敗'}。本次紀錄僅存於記憶體，請匯出。`);
      engineRef.current.interrupt(Date.now(), '紀錄儲存失敗');
      setReady(false); publish();
    });
  }, [publish]);

  useEffect(() => {
    let active = true;
    void loadAutoTradingBatches().then(async batches => {
      if (!active) return;
      const recovered = batches.map(batch => {
        if (!isAutoTradingActive(batch.status)) return batch;
        const recovery = new AutoTradingEngine(batch.marketType);
        recovery.restoreInterrupted(batch, Date.now());
        return recovery.snapshot();
      });
      for (const batch of recovered) {
        if (batches.find(old => old.id === batch.id)?.status !== batch.status) await saveAutoTradingBatch(batch);
      }
      if (!active) return;
      loadedRef.current = true;
      batchesRef.current = new Map(recovered.map(batch => [batch.id, batch]));
      setHistory(recovered);
    }).catch(error => {
      if (!active) return;
      storageFailedRef.current = true;
      setStorageError(`評估紀錄無法讀取：${error instanceof Error ? error.message : '資料異常'}。為避免覆蓋舊紀錄，暫不開放啟動。`);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    rulesReadyRef.current = false;
    const engine = new AutoTradingEngine(marketType);
    engine.setStreamHealthy(healthRef.current, Date.now());
    engineRef.current = engine; revisionRef.current = -1; persistedRef.current = -1;
    const update = setTimeout(() => {
      setReady(false); setUniverseSymbols([]); setStatusMessage('正在取得交易對規格'); setSnapshot(engine.snapshot());
    }, 0);
    void fetchAutoSymbolRules(marketType).then(rules => {
      if (!active) return;
      if (!Object.keys(rules).length) throw new Error('交易規格為空');
      engine.setRules(rules); rulesReadyRef.current = true; setUniverseSymbols(Object.keys(rules));
    }).catch(error => { if (active) setStatusMessage(`交易規格載入失敗：${error instanceof Error ? error.message : '網路異常'}，可重新整理重試`); });
    return () => { active = false; clearTimeout(update); };
  }, [marketType]);

  useEffect(() => {
    let lastPulse = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      if (now - lastPulse > 5_000) engineRef.current.interrupt(now, '電腦休眠或程式執行中斷超過五秒');
      lastPulse = now;
      engineRef.current.tick(now); publish(); persist();
      const canStart = loadedRef.current && rulesReadyRef.current && healthRef.current && !storageFailedRef.current;
      setReady(canStart);
      if (rulesReadyRef.current) setStatusMessage(!loadedRef.current ? '正在讀取歷史紀錄'
        : storageFailedRef.current ? '儲存異常，無法開始新評估' : !healthRef.current ? '等待所有成交串流恢復'
        : '逐筆成交已連線 · 全市場 · 1 倍 · 最多三筆');
    }, 250);
    const interrupt = () => { engineRef.current.interrupt(Date.now(), '頁面關閉或重新載入'); publish(); persist(); };
    window.addEventListener('pagehide', interrupt);
    window.addEventListener('beforeunload', interrupt);
    return () => { clearInterval(timer); window.removeEventListener('pagehide', interrupt); window.removeEventListener('beforeunload', interrupt); };
  }, [persist, publish]);

  useEffect(() => {
    let active = true;
    const reconcile = async () => {
      if (fundingBusy.current || !loadedRef.current || storageFailedRef.current) return;
      fundingBusy.current = true;
      try {
        for (const current of batchesRef.current.values()) {
          if (!active) break;
          if (current.marketType !== 'futures' || !current.fills.length) continue;
          const latestFillTime = Math.max(...current.fills.map(f => f.tradeTimestamp));
          const end = Math.max(current.endedAt ?? Date.now(), latestFillTime);
          if (current.fundingStatus === 'SETTLED' && !isAutoTradingActive(current.status) && (current.fundingThrough ?? 0) >= end) continue;
          // Reconcile only aged settlements; recent publication can lag the settlement boundary.
          const through = Math.min(end, Date.now() - 60_000);
          const first = Math.min(...current.fills.map(f => f.tradeTimestamp));
          if (through < first || through <= (current.fundingThrough ?? 0)) continue;
          const liveEngine = engineRef.current;
          const isCurrent = liveEngine.snapshot().id === current.id;
          const engine = isCurrent ? liveEngine : new AutoTradingEngine(current.marketType);
          if (!isCurrent) engine.restoreInterrupted(current, Date.now());
          try {
            const records = [];
            const cursor = Math.max(first, (current.fundingThrough ?? first) - 60_000);
            const pendingSymbols = new Set(current.fills.filter(fill => fill.action === 'ENTRY' && fill.tradeTimestamp <= through
              && !current.trades.some(trade => trade.id === fill.positionId
                && current.fills.filter(exit => exit.positionId === trade.id && exit.action === 'EXIT')
                  .every(exit => exit.tradeTimestamp < cursor))).map(fill => fill.symbol));
            // Restrict requests to held/recently closed symbols, with an overlap for publication lag.
            for (const symbol of pendingSymbols) {
              const fills = current.fills.filter(f => f.symbol === symbol);
              const start = Math.max(cursor, Math.min(...fills.map(f => f.tradeTimestamp)));
              if (start <= through) records.push(...await fetchAutoFundingHistory(symbol, start, through));
            }
            if (!active) break;
            engine.applyFunding(records, through, Date.now());
          } catch { if (active) engine.fundingFailed(Date.now()); }
          if (!active) break;
          const next = engine.snapshot();
          if (engine === engineRef.current && current.id === next.id) { publish(); persist(); }
          else {
            batchesRef.current.set(next.id, next);
            setHistory([...batchesRef.current.values()].sort((a, b) => b.startedAt - a.startedAt));
            queueRef.current = queueRef.current.then(() => saveAutoTradingBatch(next));
            await queueRef.current;
          }
        }
      } catch (error) {
        storageFailedRef.current = true;
        setStorageError(`資金費紀錄保存失敗：${error instanceof Error ? error.message : '儲存異常'}`);
        engineRef.current.interrupt(Date.now(), '紀錄儲存失敗'); publish();
      }
      finally { fundingBusy.current = false; }
    };
    const timer = setInterval(() => void reconcile(), 30_000);
    return () => { active = false; clearInterval(timer); };
  }, [persist, publish]);

  const processFrame = useCallback((frame: MarketTradeFrame) => {
    const engine = engineRef.current;
    const before = engine.revision;
    engine.processFrame(frame);
    if (engine.revision !== before) persist();
  }, [persist]);
  const onTradeStatus = useCallback((status: StreamStatus, health?: StreamHealth) => {
    healthRef.current = status === 'connected';
    const now = Date.now();
    engineRef.current.setStreamHealthy(healthRef.current, now, health?.interruptedSince);
    engineRef.current.tick(now);
  }, []);
  const registerNotifications = useCallback((notifier: ((n: AutoTradingNotification) => void) | null) => { notifierRef.current = notifier; }, []);
  const setSignalSettings = useCallback((settings: Record<string, number>) => { signalSettingsRef.current = { ...settings }; }, []);
  const start = useCallback((config: AutoTradingConfig) => {
    if (!loadedRef.current || !rulesReadyRef.current || storageFailedRef.current) { setStorageError('紀錄或交易規格尚未就緒'); return; }
    const previous = engineRef.current.snapshot();
    if (previous.marketType === 'futures' && previous.fills.length && (previous.fundingStatus !== 'SETTLED'
      || (previous.fundingThrough ?? 0) < (previous.endedAt ?? Date.now()))) {
      setStorageError('前一批資金費尚未核對完成，請等待結算或重試後再開始。'); return;
    }
    try { engineRef.current.start(config, Date.now(), signalSettingsRef.current); setStorageError(null); publish(); persist(); }
    catch (error) { setStorageError(error instanceof Error ? error.message : '無法啟動'); }
  }, [persist, publish]);
  const action = useCallback((method: 'pause' | 'resume' | 'drain' | 'closeAll') => {
    engineRef.current[method](Date.now()); publish(); persist();
  }, [persist, publish]);
  return { snapshot, history, storageError, ready, statusMessage, universeSymbols, processFrame, onTradeStatus, start,
    pause: () => action('pause'), resume: () => action('resume'), drain: () => action('drain'), closeAll: () => action('closeAll'),
    registerNotifications, setSignalSettings, marketLocked: isAutoTradingActive(snapshot.status) };
}
