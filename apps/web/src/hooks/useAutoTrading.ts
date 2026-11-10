import { useCallback, useEffect, useRef, useState } from 'react';
import type { MarketType } from '../services/binance';
import { AutoTradingEngine, idleAutoTradingSnapshot, isAutoTradingActive } from '../services/autoTrading';
import type { AutoTradingConfig, AutoTradingNotification, AutoTradingSnapshot } from '../services/autoTrading';
import type { MarketTradeFrame } from '../services/marketEvents';
import { fetchAutoFundingHistory, fetchAutoSymbolRules } from '../services/autoTradingMarket';
import { loadAutoTradingBatches, saveAutoTradingBatch } from '../services/autoTradingStorage';
import type { StreamHealth, StreamStatus } from '../services/marketStream';
import { ABComparisonCoordinator } from '@fadachi/core';
import type { ABTradingBatch, ABComparisonMetrics, AIAnalysisResult } from '@fadachi/core';
import { collectorClient } from '../api/collectorClient';

export function useAutoTrading(marketType: MarketType) {
  const engineRef = useRef(new AutoTradingEngine(marketType));
  const coordinatorRef = useRef(new ABComparisonCoordinator(marketType));

  const [snapshot, setSnapshot] = useState<AutoTradingSnapshot>(() => idleAutoTradingSnapshot(marketType));
  const [history, setHistory] = useState<AutoTradingSnapshot[]>([]);

  const [abSnapshot, setAbSnapshot] = useState<ABTradingBatch>(() => coordinatorRef.current.snapshot());
  const [abHistory, setAbHistory] = useState<ABTradingBatch[]>([]);
  const [abMetrics, setAbMetrics] = useState<ABComparisonMetrics>(() => coordinatorRef.current.calculateMetrics());

  const [tradingMode, setTradingMode] = useState<'single' | 'ab'>('single');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [isolationVerified, setIsolationVerified] = useState(false);
  const [latestAnalyses, setLatestAnalyses] = useState<Record<string, AIAnalysisResult>>({});

  const [storageError, setStorageError] = useState<string | null>(null);
  const [abStorageError, setABStorageError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('正在載入評估紀錄與交易規格');
  const [ready, setReady] = useState(false);
  const [universeSymbols, setUniverseSymbols] = useState<string[]>([]);

  const loadedRef = useRef(false);
  const abLoadedRef = useRef(false);
  const abLoadingRef = useRef(true);
  const rulesReadyRef = useRef(false);
  const healthRef = useRef(false);
  const storageFailedRef = useRef(false);
  const abStorageFailedRef = useRef(false);
  const abStorageErrorRef = useRef<string | null>(null);

  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const revisionRef = useRef(-1);
  const persistedRef = useRef(-1);

  const abQueueRef = useRef<Promise<void>>(Promise.resolve());
  const abRevisionRef = useRef(-1);
  const abPersistedRef = useRef(-1);
  const abOwnersRef = useRef(new Map<string, { ownerToken: string; generation: string; renewedAt: number }>());
  const scopeOwnerRef = useRef<string | null>(null);
  const [readOnlyABActive, setReadOnlyABActive] = useState(false);
  const readOnlyABActiveRef = useRef(false);

  const notifierRef = useRef<((notification: AutoTradingNotification) => void) | null>(null);
  const signalSettingsRef = useRef<Record<string, number>>({});
  const fundingBusy = useRef(false);
  const batchesRef = useRef(new Map<string, AutoTradingSnapshot>());
  const abBatchesRef = useRef(new Map<string, ABTradingBatch>());

  const publish = useCallback(() => {
    // Single Engine
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

    // A/B Coordinator
    const coordinator = coordinatorRef.current;
    if (abRevisionRef.current !== coordinator.revision) {
      const nextAB = coordinator.snapshot();
      abRevisionRef.current = coordinator.revision;
      setAbSnapshot(nextAB);
      setAbMetrics(coordinator.calculateMetrics());
      if (nextAB.id !== 'idle') {
        abBatchesRef.current.set(nextAB.id, nextAB);
        setAbHistory([...abBatchesRef.current.values()].sort((a, b) => b.startedAt - a.startedAt));
      }
    }
    coordinator.takeNotifications().forEach(notification => notifierRef.current?.(notification));
  }, []);

  const persist = useCallback(() => {
    // Single Engine Persist
    const engine = engineRef.current;
    if (loadedRef.current && !storageFailedRef.current && persistedRef.current !== engine.revision) {
      const next = engine.snapshot();
      if (next.id !== 'idle') {
        persistedRef.current = engine.revision;
        queueRef.current = queueRef.current.then(() => saveAutoTradingBatch(next)).catch(error => {
          storageFailedRef.current = true;
          setStorageError(`無法保存評估紀錄：${error instanceof Error ? error.message : '儲存失敗'}。本次紀錄僅存於記憶體，請匯出。`);
          engineRef.current.interrupt(Date.now(), '紀錄儲存失敗');
          setReady(false);
          publish();
        });
      }
    }

    // A/B Coordinator Persist
    const coordinator = coordinatorRef.current;
    if (abLoadedRef.current && !abStorageFailedRef.current && abPersistedRef.current !== coordinator.revision) {
      const nextAB = coordinator.snapshot();
      if (nextAB.id !== 'idle' && abOwnersRef.current.has(nextAB.id)) {
        abPersistedRef.current = coordinator.revision;
        const owner = abOwnersRef.current.get(nextAB.id)!;
        abQueueRef.current = abQueueRef.current.then(async () => {
          await collectorClient.saveABBatch({
            id: nextAB.id,
            market: nextAB.marketType,
            status: nextAB.status,
            revision: nextAB.revision,
            model: nextAB.model,
            batch: nextAB,
            ownerToken: owner.ownerToken,
            generation: owner.generation,
          });
        }).catch(error => {
          abStorageFailedRef.current = true;
          const message = `無法保存 A/B 對照紀錄：${error instanceof Error ? error.message : '儲存失敗'}。已中斷整對評估。`;
          abStorageErrorRef.current = message;
          setABStorageError(message);
          coordinatorRef.current.interrupt(Date.now(), '紀錄儲存失敗');
          setReady(false);
          publish();
        });
      }
    }
  }, [publish]);

  // Load single engine history from IndexedDB
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

  // Load A/B history from collector DuckDB
  useEffect(() => {
    let active = true;
    abLoadingRef.current = true;
    abStorageFailedRef.current = false;
    abStorageErrorRef.current = null;
    setABStorageError(null);
    void collectorClient.getABBatches(marketType).then(async rows => {
      if (!active) return;
      const loadedBatches: ABTradingBatch[] = [];
      let anotherOwnerActive = false;
      for (const row of rows) {
        const batch = row.batch;
        if (!batch) continue;
        if (isAutoTradingActive(batch.status)) {
          if (row.ownerActive) {
            anotherOwnerActive = true;
            continue;
          }
          const claim = await collectorClient.claimABBatch(batch.id);
          if (claim.owner && claim.batch) loadedBatches.push(claim.batch);
          else if (claim.batch && !isAutoTradingActive(claim.batch.status)) loadedBatches.push(claim.batch);
          else if (claim.batch) anotherOwnerActive = true;
        } else {
          loadedBatches.push(batch);
        }
      }
      if (!active) return;
      setReadOnlyABActive(anotherOwnerActive);
      readOnlyABActiveRef.current = anotherOwnerActive;
      abLoadedRef.current = true;
      abBatchesRef.current = new Map(loadedBatches.map(b => [b.id, b]));
      setAbHistory(loadedBatches.sort((a, b) => b.startedAt - a.startedAt));
    }).catch(error => {
      if (!active) return;
      abStorageFailedRef.current = true;
      const message = `A/B 紀錄無法讀取：${error instanceof Error ? error.message : 'Collector 連線失敗'}`;
      abStorageErrorRef.current = message;
      setABStorageError(message);
    }).finally(() => {
      if (active) abLoadingRef.current = false;
    });
    return () => { active = false; };
  }, [marketType]);

  // Reset engine and coordinator on marketType change
  useEffect(() => {
    let active = true;
    rulesReadyRef.current = false;
    const engine = new AutoTradingEngine(marketType);
    const coordinator = new ABComparisonCoordinator(marketType);

    engine.setStreamHealthy(healthRef.current, Date.now());
    coordinator.setStreamHealthy(healthRef.current, Date.now());

    engineRef.current = engine;
    coordinatorRef.current = coordinator;

    revisionRef.current = -1;
    persistedRef.current = -1;
    abRevisionRef.current = -1;
    abPersistedRef.current = -1;

    const update = setTimeout(() => {
      setReady(false);
      setUniverseSymbols([]);
      setStatusMessage('正在取得交易對規格');
      setSnapshot(engine.snapshot());
      setAbSnapshot(coordinator.snapshot());
      setAbMetrics(coordinator.calculateMetrics());
    }, 0);

    void fetchAutoSymbolRules(marketType).then(rules => {
      if (!active) return;
      if (!Object.keys(rules).length) throw new Error('交易規格為空');
      engine.setRules(rules);
      coordinator.setRules(rules);
      rulesReadyRef.current = true;
      setUniverseSymbols(Object.keys(rules));
    }).catch(error => {
      if (active) setStatusMessage(`交易規格載入失敗：${error instanceof Error ? error.message : '網路異常'}，可重新整理重試`);
    });

    return () => { active = false; clearTimeout(update); };
  }, [marketType]);

  // Periodic AI Status Polling
  useEffect(() => {
    let active = true;
    const pollAI = async () => {
      try {
        const res = await collectorClient.getAIStatus(marketType);
        if (!active) return;
        if (res.models && res.models.length > 0) {
          setAvailableModels(res.models);
        }
        setIsolationVerified(Boolean(res.isolationVerified));
        if (res.latestAnalyses) {
          setLatestAnalyses(res.latestAnalyses);
          for (const analysis of Object.values(res.latestAnalyses)) {
            coordinatorRef.current.updateAnalysis(analysis as AIAnalysisResult);
          }
          publish();
        }
      } catch {
        // Collector might be offline or starting up
      }
    };

    void pollAI();
    const interval = setInterval(() => void pollAI(), 15_000);
    return () => { active = false; clearInterval(interval); };
  }, [marketType, publish]);

  // Heartbeat & Sleep Protection
  useEffect(() => {
    let lastPulse = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      if (now - lastPulse > 5_000) {
        engineRef.current.interrupt(now, '電腦休眠或程式執行中斷超過五秒');
        coordinatorRef.current.interrupt(now, '電腦休眠或程式執行中斷超過五秒');
      }
      lastPulse = now;
      engineRef.current.tick(now);
      coordinatorRef.current.tick(now);
      publish();
      persist();

      for (const [batchId, owner] of abOwnersRef.current) {
        if (now - owner.renewedAt < 5_000) continue;
        owner.renewedAt = now;
        void collectorClient.renewABLease(batchId, owner.ownerToken, owner.generation).catch(error => {
          if (abStorageFailedRef.current) return;
          abStorageFailedRef.current = true;
          const message = `A/B owner lease 失效，已停止寫入：${error instanceof Error ? error.message : '續租失敗'}`;
          abStorageErrorRef.current = message;
          setABStorageError(message);
          if (isAutoTradingActive(coordinatorRef.current.snapshot().status)) {
            coordinatorRef.current.interrupt(Date.now(), 'A/B owner lease 失效');
            publish();
          }
          setReady(false);
        });
      }

      const currentAB = coordinatorRef.current.snapshot();
      if (scopeOwnerRef.current && !isAutoTradingActive(currentAB.status)) {
        const ownerId = scopeOwnerRef.current;
        scopeOwnerRef.current = null;
        void collectorClient.unlockAIScope(ownerId).catch(() => {});
      }

      const canStart = loadedRef.current && rulesReadyRef.current && healthRef.current && !storageFailedRef.current;
      setReady(canStart);
      if (rulesReadyRef.current) {
        setStatusMessage(!loadedRef.current ? '正在讀取歷史紀錄'
          : storageFailedRef.current ? '單帳戶儲存異常，無法開始新評估'
          : abLoadingRef.current ? '正在載入 A/B 對照紀錄'
          : abStorageErrorRef.current ? abStorageErrorRef.current
          : !healthRef.current ? '等待所有成交串流恢復'
          : readOnlyABActiveRef.current ? '另一頁持有活動 A/B owner lease；本頁唯讀，不會恢復或覆寫該批次'
          : '逐筆成交已連線 · 全市場 · 1 倍 · 最多三筆');
      }
    }, 250);

    const interrupt = () => {
      engineRef.current.interrupt(Date.now(), '頁面關閉或重新載入');
      coordinatorRef.current.interrupt(Date.now(), '頁面關閉或重新載入');
      publish();
      persist();
    };

    window.addEventListener('pagehide', interrupt);
    window.addEventListener('beforeunload', interrupt);
    return () => {
      clearInterval(timer);
      window.removeEventListener('pagehide', interrupt);
      window.removeEventListener('beforeunload', interrupt);
    };
  }, [persist, publish]);

  // Funding reconciliation
  useEffect(() => {
    let active = true;
    const reconcile = async () => {
      if (fundingBusy.current || (!loadedRef.current && !abLoadedRef.current)) return;
      fundingBusy.current = true;
      let reconcilingAB = false;
      try {
        // Reconcile Single Engine Batches
        if (loadedRef.current && !storageFailedRef.current) for (const current of batchesRef.current.values()) {
          if (!active) break;
          if (current.marketType !== 'futures' || !current.fills.length) continue;
          const latestFillTime = Math.max(...current.fills.map(f => f.tradeTimestamp));
          const end = Math.max(current.endedAt ?? Date.now(), latestFillTime);
          if (current.fundingStatus === 'SETTLED' && !isAutoTradingActive(current.status) && (current.fundingThrough ?? 0) >= end) continue;
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

        // Reconcile A/B Batches
        reconcilingAB = true;
        if (abLoadedRef.current && !abStorageFailedRef.current) for (const currentAB of abBatchesRef.current.values()) {
          if (!active) break;
          if (!abOwnersRef.current.has(currentAB.id)) continue;
          if (currentAB.marketType !== 'futures') continue;
          const allFills = [...currentAB.accountA.fills, ...currentAB.accountB.fills];
          if (!allFills.length) continue;
          const latestFillTime = Math.max(...allFills.map(f => f.tradeTimestamp));
          const end = Math.max(currentAB.endedAt ?? Date.now(), latestFillTime);
          const through = Math.min(end, Date.now() - 60_000);
          const first = Math.min(...allFills.map(f => f.tradeTimestamp));
          if (through < first) continue;

          const liveCoord = coordinatorRef.current;
          const isCurrent = liveCoord.snapshot().id === currentAB.id;
          const coord = isCurrent ? liveCoord : new ABComparisonCoordinator(currentAB.marketType);
          if (!isCurrent) coord.restoreInterrupted(currentAB, Date.now());

          try {
            const records = [];
            const cursor = first - 60_000;
            const symbols = new Set(allFills.map(f => f.symbol));
            for (const symbol of symbols) {
              records.push(...await fetchAutoFundingHistory(symbol, cursor, through));
            }
            if (!active) break;
            coord.applyFunding(records, through, Date.now());
          } catch {
            if (active) coord.fundingFailed(Date.now());
          }

          if (!active) break;
          const nextAB = coord.snapshot();
          if (coord === coordinatorRef.current && currentAB.id === nextAB.id) {
            publish();
            persist();
          } else {
            abBatchesRef.current.set(nextAB.id, nextAB);
            setAbHistory([...abBatchesRef.current.values()].sort((a, b) => b.startedAt - a.startedAt));
            const owner = abOwnersRef.current.get(nextAB.id)!;
            abQueueRef.current = abQueueRef.current.then(() => collectorClient.saveABBatch({
              id: nextAB.id,
              market: nextAB.marketType,
              status: nextAB.status,
              revision: nextAB.revision,
              model: nextAB.model,
              batch: nextAB,
              ownerToken: owner.ownerToken,
              generation: owner.generation,
            }));
            await abQueueRef.current;
          }
        }
      } catch (error) {
        const message = `資金費紀錄保存失敗：${error instanceof Error ? error.message : '儲存異常'}`;
        if (reconcilingAB) {
          abStorageFailedRef.current = true;
          abStorageErrorRef.current = message;
          setABStorageError(message);
          coordinatorRef.current.interrupt(Date.now(), 'A/B 紀錄儲存失敗');
        } else {
          storageFailedRef.current = true;
          setStorageError(message);
          engineRef.current.interrupt(Date.now(), '紀錄儲存失敗');
        }
        publish();
      } finally {
        fundingBusy.current = false;
      }
    };

    const timer = setInterval(() => void reconcile(), 30_000);
    return () => { active = false; clearInterval(timer); };
  }, [persist, publish]);

  const processFrame = useCallback((frame: MarketTradeFrame) => {
    // Both engines receive identical trade frames
    const engine = engineRef.current;
    const coordinator = coordinatorRef.current;

    const beforeEngine = engine.revision;
    const beforeCoord = coordinator.revision;

    engine.processFrame(frame);
    coordinator.processFrame(frame);

    if (engine.revision !== beforeEngine || coordinator.revision !== beforeCoord) {
      persist();
    }
  }, [persist]);

  const onTradeStatus = useCallback((status: StreamStatus, health?: StreamHealth) => {
    healthRef.current = status === 'connected';
    const now = Date.now();
    engineRef.current.setStreamHealthy(healthRef.current, now, health?.interruptedSince);
    coordinatorRef.current.setStreamHealthy(healthRef.current, now, health?.interruptedSince);
    engineRef.current.tick(now);
    coordinatorRef.current.tick(now);
  }, []);

  const registerNotifications = useCallback((notifier: ((n: AutoTradingNotification) => void) | null) => {
    notifierRef.current = notifier;
  }, []);

  const setSignalSettings = useCallback((settings: Record<string, number>) => {
    signalSettingsRef.current = { ...settings };
  }, []);

  // Single Engine Actions
  const start = useCallback((config: AutoTradingConfig) => {
    if (!abLoadedRef.current || !rulesReadyRef.current || abStorageFailedRef.current) {
      setStorageError(abStorageErrorRef.current || (abLoadingRef.current ? 'A/B 對照紀錄尚在載入' : 'A/B 紀錄或交易規格尚未就緒'));
      return;
    }
    const previous = engineRef.current.snapshot();
    if (previous.marketType === 'futures' && previous.fills.length && (previous.fundingStatus !== 'SETTLED'
      || (previous.fundingThrough ?? 0) < (previous.endedAt ?? Date.now()))) {
      setStorageError('前一批資金費尚未核對完成，請等待結算或重試後再開始。');
      return;
    }
    try {
      engineRef.current.start(config, Date.now(), signalSettingsRef.current);
      setStorageError(null);
      publish();
      persist();
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : '無法啟動');
    }
  }, [persist, publish]);

  const action = useCallback((method: 'pause' | 'resume' | 'drain' | 'closeAll') => {
    engineRef.current[method](Date.now());
    publish();
    persist();
  }, [persist, publish]);

  // A/B Coordinator Actions
  const startAB = useCallback(async (config: AutoTradingConfig, selectedCoins: string[], model: string) => {
    if (!loadedRef.current || !rulesReadyRef.current || storageFailedRef.current) {
      setStorageError('紀錄或交易規格尚未就緒');
      return;
    }
    if (!isolationVerified) {
      setStorageError('AI CLI 執行環境未驗證隔離或不可用，依規範禁止啟動 A/B 對照批次');
      return;
    }
    try {
      coordinatorRef.current.start(
        config,
        selectedCoins,
        model,
        Date.now(),
        signalSettingsRef.current
      );
      const batch = coordinatorRef.current.snapshot();
      await collectorClient.setAIScope({ market: config.marketType, symbols: selectedCoins, model });
      const locked = await collectorClient.lockAIScope(batch.id);
      if (locked.scope.market !== config.marketType || locked.scope.model !== model
        || locked.scope.symbols.join('|') !== [...new Set(selectedCoins)].map(symbol => symbol.toUpperCase()).join('|')) {
        await collectorClient.unlockAIScope(batch.id);
        throw new Error('AI 批次 scope 與目前 A/B 設定不一致，已拒絕啟動');
      }
      scopeOwnerRef.current = batch.id;
      const lease = await collectorClient.claimABBatch(batch.id);
      if (!lease.owner || !lease.ownerToken || !lease.generation) {
        await collectorClient.unlockAIScope(batch.id);
        scopeOwnerRef.current = null;
        throw new Error('無法取得 A/B 批次 owner lease，可能已有另一頁持有相同批次');
      }
      abOwnersRef.current.set(batch.id, { ownerToken: lease.ownerToken, generation: lease.generation, renewedAt: Date.now() });
      setStorageError(null);
      publish();
      persist();
    } catch (error) {
      const current = coordinatorRef.current.snapshot();
      if (isAutoTradingActive(current.status)) coordinatorRef.current.interrupt(Date.now(), 'A/B owner lease 或 scope 初始化失敗');
      if (scopeOwnerRef.current) {
        void collectorClient.unlockAIScope(scopeOwnerRef.current).catch(() => {});
        scopeOwnerRef.current = null;
      }
      publish();
      const message = error instanceof Error ? error.message : '無法啟動 A/B 對照批次';
      setABStorageError(message);
      abStorageErrorRef.current = message;
    }
  }, [isolationVerified, persist, publish]);

  const actionAB = useCallback((method: 'pause' | 'resume' | 'drain' | 'closeAll') => {
    coordinatorRef.current[method](Date.now());
    publish();
    persist();
  }, [persist, publish]);

  const isSingleActive = isAutoTradingActive(snapshot.status);
  const isABActive = isAutoTradingActive(abSnapshot.status);

  return {
    // Single Engine
    snapshot,
    history,
    start,
    pause: () => action('pause'),
    resume: () => action('resume'),
    drain: () => action('drain'),
    closeAll: () => action('closeAll'),

    // A/B Coordinator
    abSnapshot,
    abHistory,
    abMetrics,
    startAB,
    pauseAB: () => actionAB('pause'),
    resumeAB: () => actionAB('resume'),
    drainAB: () => actionAB('drain'),
    closeAllAB: () => actionAB('closeAll'),
    tradingMode,
    setTradingMode,
    availableModels,
    isolationVerified,
    latestAnalyses,
    readOnlyABActive,

    // Shared Status & Controls
    storageError,
    abStorageError,
    ready,
    statusMessage,
    universeSymbols,
    processFrame,
    onTradeStatus,
    registerNotifications,
    setSignalSettings,
    marketLocked: isSingleActive || isABActive,
  };
}
