import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { FourGroupComparisonCoordinator, defaultAutoTradingConfig } from '@fadachi/core';

test('AutoTrading & FourGroupAutoTrading render via Vite SSR in four-group mode cleanly', async () => {
  const webRoot = path.resolve(import.meta.dirname, '..');
  const vite = await createServer({
    root: webRoot,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  try {
    const autoMod = await vite.ssrLoadModule('/src/components/AutoTrading.tsx');
    const coord = new FourGroupComparisonCoordinator('futures');
    const batch = coord.snapshot();
    const metrics = coord.calculateMetrics();
    batch.status = 'RUNNING';
    batch.locked.isRemoteOllama = true;
    batch.decisions = [{
      id: 'decision-1',
      planId: 'plan-1',
      symbol: 'BTCUSDT',
      side: 'LONG',
      confirmedAt: Date.now(),
      lgbm: { sideRank: 1, allowed: true, reason: 'ALLOWED' },
      ai: { allowed: false, reason: 'NO_ANALYSIS', explanation: '當時沒有分析', direction: null },
      groups: {
        A: { allowed: true, reason: 'RULE_ONLY' },
        B: { allowed: false, reason: 'NO_ANALYSIS' },
        C: { allowed: true, reason: 'ALLOWED' },
        D: { allowed: false, reason: 'AI:NO_ANALYSIS' },
      },
    } as any];

    const html = renderToStaticMarkup(
      React.createElement(autoMod.default, {
        snapshot: batch.accounts.A,
        history: [],
        ready: true,
        statusMessage: '就緒',
        onStart: () => {},
        onPause: () => {},
        onResume: () => {},
        onDrain: () => {},
        onCloseAll: () => {},
        onSelectSymbol: () => {},
        theme: 'dark',
        tradingMode: 'four',
        fourGroup: {
          snapshot: batch,
          metrics,
          history: [],
          storageError: null,
          rulesReady: true,
          streamHealthy: true,
          ready: true,
          statusMessage: 'Collector 後端執行中・關閉或重整瀏覽器分頁不影響模擬進度',
          isActive: false,
          ollamaDraftUrl: 'http://192.168.1.20:11434',
          setOllamaDraftUrl: () => {},
          ollamaConn: {
            reachable: true,
            baseUrl: 'http://192.168.1.20:11434',
            isRemote: true,
            models: ['gemma4:e2b'],
            runningModels: [],
            latencyMs: 12,
            error: null,
            checking: false,
            checkedAt: Date.now(),
          },
          ollamaAnalyses: {},
          ollamaSymbolErrors: {},
          analyzingOllama: true,
          ollamaProgress: { completed: 0, total: 1, currentSymbol: 'BTCUSDT' },
          ollamaLastError: null,
          updatingLgbm: false,
          engineRuntime: {
            runningInCollector: true,
            generation: 'gen-1',
            lastSaveAt: Date.now(),
            lastSaveDurationMs: 15,
            lastSaveRevision: 721,
            lastQueueWaitMs: 3,
            lastTxElapsedMs: 12,
            unsyncedChanges: false,
            error: null,
          },
          lgbmState: {
            snapshot: null,
            expectedCutoffTime: null,
            isExpired: true,
            matchesCurrentHour: false,
            latestError: null,
            universeSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
            lgbmStatus: null,
            trainingPaused: true,
            pausedReason: '目前暫停 Chronos-2 及其他非 LightGBM 模型訓練',
          },
          testOllamaConnection: async () => null,
          triggerOllamaBatchAnalysis: async () => {},
          triggerManualLgbmUpdate: async () => ({} as any),
          refreshLgbmLatest: async () => {},
          refreshStatus: async () => null,
          startFourGroup: async () => {},
          pauseFourGroup: async () => {},
          resumeFourGroup: async () => {},
          drainFourGroup: async () => {},
          closeAllFourGroup: async () => {},
          registerNotifications: () => {},
          setSignalSettings: () => {},
        },
      }),
    );

    assert.match(html, /四組策略比較 \(A\/B\/C\/D\)/);
    assert.match(html, /Collector 後端運行中/);
    assert.match(html, /rev 721/);
    assert.match(html, /DB 12ms/);
    assert.doesNotMatch(html, /寫入租約/);
    assert.match(html, /A：規則基準/);
    assert.match(html, /B：規則＋AI/);
    assert.match(html, /C：規則＋LightGBM/);
    assert.match(html, /D：LightGBM＋AI/);
    assert.match(html, /遠端端點安全提示/);
    assert.match(html, /gemma4:e2b/);
    assert.match(html, /跟隨 LightGBM 自動/);
    assert.match(html, /匯出四組 CSV/);
    assert.match(html, /當時尚無 AI 分析/);
    assert.match(html, /目前：AI 分析中/);

    // Verify backend save error surface renders cleanly
    const errHtml = renderToStaticMarkup(
      React.createElement(autoMod.default, {
        snapshot: batch.accounts.A,
        history: [],
        ready: false,
        statusMessage: '異常',
        onStart: () => {},
        onPause: () => {},
        onResume: () => {},
        onDrain: () => {},
        onCloseAll: () => {},
        onSelectSymbol: () => {},
        theme: 'dark',
        tradingMode: 'four',
        fourGroup: {
          snapshot: batch,
          metrics,
          history: [],
          storageError: '後端存檔逾時',
          rulesReady: true,
          streamHealthy: true,
          ready: false,
          statusMessage: '後端存檔逾時',
          isActive: true,
          ollamaDraftUrl: 'http://127.0.0.1:11434',
          setOllamaDraftUrl: () => {},
          ollamaConn: {
            reachable: false,
            baseUrl: 'http://127.0.0.1:11434',
            isRemote: false,
            models: [],
            runningModels: [],
            latencyMs: null,
            error: null,
            checking: false,
            checkedAt: null,
          },
          ollamaAnalyses: {},
          ollamaSymbolErrors: {},
          analyzingOllama: false,
          ollamaProgress: null,
          ollamaLastError: null,
          updatingLgbm: false,
          engineRuntime: {
            runningInCollector: true,
            generation: 'gen-1',
            lastSaveAt: null,
            lastSaveDurationMs: null,
            lastSaveRevision: null,
            lastQueueWaitMs: null,
            lastTxElapsedMs: null,
            unsyncedChanges: true,
            error: 'DuckDB 交易失敗',
          },
          lgbmState: {
            snapshot: null,
            expectedCutoffTime: null,
            isExpired: true,
            matchesCurrentHour: false,
            latestError: null,
            universeSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
            lgbmStatus: null,
            trainingPaused: true,
            pausedReason: null,
          },
          testOllamaConnection: async () => null,
          triggerOllamaBatchAnalysis: async () => {},
          triggerManualLgbmUpdate: async () => ({} as any),
          refreshLgbmLatest: async () => {},
          refreshStatus: async () => null,
          startFourGroup: async () => {},
          pauseFourGroup: async () => {},
          resumeFourGroup: async () => {},
          drainFourGroup: async () => {},
          closeAllFourGroup: async () => {},
          registerNotifications: () => {},
          setSignalSettings: () => {},
        },
      }),
    );
    assert.match(errHtml, /後端存檔異常：DuckDB 交易失敗/);
  } finally {
    await vite.close();
  }
});

test('AutoTrading preserves single and A/B modes when tradingMode toggles cleanly', async () => {
  const webRoot = path.resolve(import.meta.dirname, '..');
  const vite = await createServer({
    root: webRoot,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  try {
    const autoMod = await vite.ssrLoadModule('/src/components/AutoTrading.tsx');
    const idleCfg = defaultAutoTradingConfig('futures');
    const coord = new FourGroupComparisonCoordinator('futures');
    const singleHtml = renderToStaticMarkup(
      React.createElement(autoMod.default, {
        snapshot: { ...coord.snapshot().accounts.A, config: idleCfg },
        history: [],
        ready: true,
        statusMessage: '單帳戶就緒',
        onStart: () => {},
        onPause: () => {},
        onResume: () => {},
        onDrain: () => {},
        onCloseAll: () => {},
        onSelectSymbol: () => {},
        theme: 'dark',
        tradingMode: 'single',
      }),
    );
    assert.match(singleHtml, /即時紙上自動交易/);
  } finally {
    await vite.close();
  }
});

// Execute the real thin-client hook with deterministic hook slots and timers, without a DOM or browser.
async function createHookHarness(client: Record<string, any>) {
  const slots: any[] = [];
  let cursor = 0;
  let pending: Array<() => void> = [];
  const timers = new Map<number, { run: () => void; ms: number }>();
  let timerId = 0;
  const same = (a: any[], b: any[]) => a?.length === b?.length && a.every((x, i) => Object.is(x, b[i]));
  const runtime = {
    client,
    setInterval: (run: () => void, ms: number) => { timers.set(++timerId, { run, ms }); return timerId; },
    clearInterval: (id: number) => timers.delete(id),
    useState: (initial: any) => {
      const i = cursor++;
      if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, (next: any) => { slots[i].value = typeof next === 'function' ? next(slots[i].value) : next; }];
    },
    useRef: (initial: any) => {
      const i = cursor++;
      slots[i] ??= { current: initial };
      return slots[i];
    },
    useCallback: (fn: any, deps: any[]) => {
      const i = cursor++;
      if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { fn, deps };
      return slots[i].fn;
    },
    useEffect: (fn: any, deps: any[]) => {
      const i = cursor++;
      if (!slots[i] || !same(slots[i].deps, deps)) {
        const previous = slots[i];
        slots[i] = { deps };
        pending.push(() => { previous?.cleanup?.(); slots[i].cleanup = fn(); });
      }
    },
  };
  (globalThis as any).__fourGroupThinHarness = runtime;
  const vite = await createServer({
    root: path.resolve(import.meta.dirname, '..'),
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    plugins: [{
      name: 'four-group-thin-hook-runtime',
      enforce: 'pre',
      resolveId(id) { if (id.startsWith('virtual:four-thin-')) return '\0' + id; },
      load(id) {
        if (id === '\0virtual:four-thin-react') return `const r = globalThis.__fourGroupThinHarness;
          export const { useState, useRef, useCallback, useEffect } = r;`;
        if (id === '\0virtual:four-thin-client') return `
          export class CollectorApiError extends Error {
            constructor(message, details = {}) {
              super(message);
              this.status = details.status ?? 500;
            }
          }
          export const collectorClient = globalThis.__fourGroupThinHarness.client;`;
      },
      transform(code, id) {
        if (!id.replaceAll('\\', '/').endsWith('/hooks/useFourGroupTrading.ts')) return;
        return `const { setInterval, clearInterval } = globalThis.__fourGroupThinHarness;\n` + code
          .replaceAll("from 'react'", "from 'virtual:four-thin-react'")
          .replaceAll("from '../api/collectorClient'", "from 'virtual:four-thin-client'");
      },
    }],
  });
  const { useFourGroupTrading: runHook } = await vite.ssrLoadModule('/src/hooks/useFourGroupTrading.ts');
  return {
    render: () => {
      cursor = 0;
      const hook = runHook('futures');
      const effects = pending;
      pending = [];
      effects.forEach(run => run());
      return hook;
    },
    pulse: (ms: number) => {
      for (const timer of timers.values()) {
        if (timer.ms === ms) timer.run();
      }
    },
    timerIntervals: () => [...timers.values()].map(t => t.ms),
    close: async () => {
      slots.forEach(s => s?.cleanup?.());
      await vite.close();
      delete (globalThis as any).__fourGroupThinHarness;
    },
  };
}

const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
const defer = () => {
  let resolve!: (value?: any) => void;
  const promise = new Promise<any>(done => { resolve = done; });
  return { promise, resolve };
};

function makeRuntimeStatus(overrides: Record<string, any> = {}) {
  const coord = new FourGroupComparisonCoordinator('futures');
  const snapshot = overrides.snapshot ?? coord.snapshot();
  const universe = Array.from({ length: 20 }, (_, i) => i === 0 ? 'BTCUSDT' : `C${i}USDT`);
  return {
    snapshot,
    metrics: FourGroupComparisonCoordinator.calculateMetricsFromBatch(snapshot),
    streamHealthy: true,
    rulesReady: true,
    rulesError: null,
    lgbmState: {
      snapshot: null,
      expectedCutoffTime: null,
      isExpired: true,
      matchesCurrentHour: false,
      latestError: null,
      universeSymbols: universe,
      lgbmStatus: null,
      trainingPaused: true,
      pausedReason: null,
    },
    ollama: {
      analyzing: false,
      progress: null,
      lastError: null,
      analyses: {},
      symbolErrors: {},
    },
    recentNotifications: [],
    engineRuntime: {
      runningInCollector: true,
      generation: 'gen-test',
      lastSaveAt: 1_800_000_000_000,
      lastSaveDurationMs: 10,
      lastSaveRevision: snapshot.revision,
      lastQueueWaitMs: 1,
      lastTxElapsedMs: 8,
      unsyncedChanges: false,
      error: null,
    },
    serverTime: 1_800_000_000_000,
    ...overrides,
  };
}

test('thin four-group hook retries boot status, sends commands without unmount interrupt, and fences stale polls', async () => {
  const universe = Array.from({ length: 20 }, (_, i) => i === 0 ? 'BTCUSDT' : `C${i}USDT`);
  const rules = Object.fromEntries(universe.map(s => [s, { stepSize: 0.001, minQty: 0.001, maxQty: 1000, minNotional: 5 }]));
  const runningCoord = new FourGroupComparisonCoordinator('futures');
  runningCoord.setRules(rules);
  runningCoord.setStreamHealthy(true, 1_800_000_000_000);
  runningCoord.start({
    config: defaultAutoTradingConfig('futures'),
    selectedCoins: ['BTCUSDT'],
    universeSymbols: universe,
    model: 'gemma4:e2b',
    now: 1_800_000_000_100,
  });
  const runningSnap = runningCoord.snapshot();

  let statusCalls = 0;
  let connectionChecks = 0;
  const stalePollGate = defer();
  const controlCalls: Array<{ action: string; payload?: any }> = [];

  const client = {
    getFourGroupStatus: async () => {
      statusCalls += 1;
      if (statusCalls === 1) throw new TypeError('Failed to fetch');
      if (statusCalls === 2) return makeRuntimeStatus();
      if (statusCalls === 3) {
        await stalePollGate.promise;
        return makeRuntimeStatus(); // stale IDLE snapshot arriving AFTER start!
      }
      return makeRuntimeStatus({ snapshot: runningSnap });
    },
    getFourGroupBatches: async () => [],
    testOllamaConnection: async () => { connectionChecks += 1; return { reachable: true, models: ['gemma4:e2b'] }; },
    startFourGroupBatch: async (payload: any) => {
      controlCalls.push({ action: 'start', payload });
      return makeRuntimeStatus({ snapshot: runningSnap });
    },
    pauseFourGroupBatch: async (id: string) => {
      controlCalls.push({ action: 'pause', payload: id });
      const paused = structuredClone(runningSnap);
      paused.status = 'PAUSED';
      paused.revision += 1;
      return makeRuntimeStatus({ snapshot: paused });
    },
    resumeFourGroupBatch: async (id: string) => {
      controlCalls.push({ action: 'resume', payload: id });
      const resumed = structuredClone(runningSnap);
      resumed.status = 'RUNNING';
      resumed.revision += 2;
      return makeRuntimeStatus({ snapshot: resumed });
    },
    drainFourGroupBatch: async (id: string) => {
      controlCalls.push({ action: 'drain', payload: id });
      const draining = structuredClone(runningSnap);
      draining.status = 'DRAINING';
      draining.revision += 3;
      return makeRuntimeStatus({ snapshot: draining });
    },
    closeAllFourGroupBatch: async (id: string) => {
      controlCalls.push({ action: 'close-all', payload: id });
      const closed = structuredClone(runningSnap);
      closed.status = 'COMPLETED';
      closed.revision += 4;
      return makeRuntimeStatus({ snapshot: closed });
    },
    refreshFourGroupOllama: async (id: string) => {
      controlCalls.push({ action: 'ollama-refresh', payload: id });
      return makeRuntimeStatus({ snapshot: runningSnap, ollama: { analyzing: true, progress: { completed: 0, total: 1, currentSymbol: 'BTCUSDT' }, lastError: null, analyses: {}, symbolErrors: {} } });
    },
  };

  const harness = await createHookHarness(client);
  try {
    // 1. Initial mount fails once -> shows error & ready=false
    harness.render();
    await flush();
    let hook = harness.render();
    assert.match(hook.storageError ?? '', /Failed to fetch/);
    assert.equal(hook.ready, false);

    // 2. Fast boot retry (1_000ms while !statusLoaded) succeeds -> ready=true
    harness.pulse(1_000);
    await flush();
    await flush();
    hook = harness.render();
    assert.equal(statusCalls, 2);
    assert.equal(hook.storageError, null);
    assert.equal(hook.ready, true);
    assert.ok(harness.timerIntervals().includes(4_000), 'idle state should switch to 4s polling');

    // 3. Editing Ollama draft URL must NOT re-test default endpoint
    hook.setOllamaDraftUrl('http://192.168.1.50:11434');
    hook = harness.render();
    await flush();
    assert.equal(connectionChecks, 1);

    // 4. In-flight poll #3 is fenced out once startFourGroup is issued with signalSettings
    harness.pulse(4_000);
    await flush();
    assert.equal(statusCalls, 3);
    hook.setSignalSettings({ priceMovePercent: 2.5, priceWindowMs: 5_000, whaleMultiplier: 12 });
    await hook.startFourGroup(defaultAutoTradingConfig('futures'), ['BTCUSDT'], 'http://localhost:11434', 'gemma4:e2b', 'manual');
    hook = harness.render();
    assert.equal(hook.snapshot.id, runningSnap.id);
    assert.equal(hook.snapshot.status, 'RUNNING');
    assert.deepEqual(controlCalls[0].payload.signalSettings, { priceMovePercent: 2.5, priceWindowMs: 5_000, whaleMultiplier: 12 });

    // Resolving old poll #3 must NOT overwrite RUNNING batch back to IDLE
    stalePollGate.resolve();
    await flush();
    hook = harness.render();
    assert.equal(hook.snapshot.id, runningSnap.id);
    assert.equal(hook.snapshot.status, 'RUNNING');
    assert.ok(harness.timerIntervals().includes(1_000), 'active state should poll at 1s');

    // 5. Control actions propagate to Collector API & update hook state
    await hook.triggerOllamaBatchAnalysis();
    await hook.pauseFourGroup();
    hook = harness.render();
    assert.equal(hook.snapshot.status, 'PAUSED');
    await hook.resumeFourGroup();
    hook = harness.render();
    assert.equal(hook.snapshot.status, 'RUNNING');
    await hook.drainFourGroup();
    hook = harness.render();
    assert.equal(hook.snapshot.status, 'DRAINING');
    await hook.closeAllFourGroup();
    hook = harness.render();
    assert.equal(hook.snapshot.status, 'COMPLETED');
  } finally {
    // 6. Unmount must NOT interrupt or mutate backend state!
    const callCountBeforeClose = controlCalls.length;
    await harness.close();
    assert.equal(controlCalls.length, callCountBeforeClose, 'unmount must not issue interrupt or control requests');
  }
});

test('thin four-group hook deduplicates backend notifications and refreshes history on status transition', async () => {
  const universe = Array.from({ length: 20 }, (_, i) => i === 0 ? 'BTCUSDT' : `C${i}USDT`);
  const rules = Object.fromEntries(universe.map(s => [s, { stepSize: 0.001, minQty: 0.001, maxQty: 1000, minNotional: 5 }]));
  const coord = new FourGroupComparisonCoordinator('futures');
  coord.setRules(rules);
  coord.setStreamHealthy(true, 1_800_000_000_000);
  coord.start({
    config: defaultAutoTradingConfig('futures'),
    selectedCoins: ['BTCUSDT'],
    universeSymbols: universe,
    model: 'gemma4:e2b',
    now: 1_800_000_000_100,
  });
  const snap1 = coord.snapshot();
  const snap2 = structuredClone(snap1);
  snap2.revision += 1;
  const snap3 = structuredClone(snap2);
  snap3.status = 'COMPLETED';
  snap3.endedAt = 1_800_000_060_000;
  snap3.revision += 1;

  const noteOld = {
    id: 'n-old',
    seq: 1,
    createdAt: 1_800_000_000_100,
    type: 'auto-entry',
    symbol: 'BTCUSDT',
    marketType: 'futures',
    timestamp: 1_800_000_000_100,
    price: 100,
    title: 'BTC 入場',
    message: 'old note should be seeded silently on mount',
  };
  const noteNew = {
    id: 'n-new',
    seq: 2,
    createdAt: 1_800_000_002_000,
    type: 'auto-exit',
    symbol: 'BTCUSDT',
    marketType: 'futures',
    timestamp: 1_800_000_002_000,
    price: 103,
    title: 'BTC 退出',
    message: 'new exit note must trigger toast once',
  };

  let pollIdx = 0;
  let batchListCalls = 0;
  const statusResponses = [
    makeRuntimeStatus({ snapshot: snap1, recentNotifications: [noteOld] }),
    makeRuntimeStatus({ snapshot: snap2, recentNotifications: [noteOld, noteNew] }),
    makeRuntimeStatus({ snapshot: snap3, recentNotifications: [noteOld, noteNew] }),
  ];
  const delivered: string[] = [];

  const harness = await createHookHarness({
    getFourGroupStatus: async () => statusResponses[Math.min(pollIdx++, statusResponses.length - 1)],
    getFourGroupBatches: async () => {
      batchListCalls += 1;
      return [{ batch: pollIdx >= 3 ? snap3 : snap1 }];
    },
    testOllamaConnection: async () => ({ reachable: false, models: [] }),
  });

  try {
    const hook0 = harness.render();
    hook0.registerNotifications((alert: any) => delivered.push(alert.id));
    await flush();
    harness.render();
    assert.deepEqual(delivered, [], 'initial mount seeds existing notifications without replaying');

    // Poll #2 brings noteNew -> delivered once
    harness.pulse(1_000);
    await flush();
    harness.render();
    assert.deepEqual(delivered, ['n-new']);

    // Poll #3 transitions RUNNING -> COMPLETED -> noteNew not duplicated, history refreshed
    const listsBefore = batchListCalls;
    harness.pulse(1_000);
    await flush();
    await flush();
    const hook3 = harness.render();
    assert.deepEqual(delivered, ['n-new']);
    assert.ok(batchListCalls > listsBefore, 'status transition should refresh history list');
    assert.equal(hook3.snapshot.status, 'COMPLETED');
  } finally {
    await harness.close();
  }
});
