import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { DEFAULT_MODEL_PAPER_CONFIG, type ModelPaperExperimentListItem } from '@fadachi/core';
import {
  EXPERIMENT_STATUS_LABELS,
  findActiveExperiment,
  formatDurationMs,
  formatUtcTaipei,
  generateModelPaperRequestId,
  normalizeEquitySeriesPoints,
  pickPreferredExperimentId,
} from '../src/components/modelPaperHelpers.ts';

function makeListItem(id: string, status: ModelPaperExperimentListItem['experiment']['status']): ModelPaperExperimentListItem {
  return {
    experiment: {
      id,
      createdAt: 1_700_000_000_000,
      status,
      config: { ...DEFAULT_MODEL_PAPER_CONFIG },
      modelKey: 'chronos2',
      modelSource: {
        adapterRunId: 'run-1',
        adapterRunDir: '/tmp/run-1',
        attemptDir: '/tmp/run-1/chronos2/attempt_1',
        artifactHashes: {},
        baseRepoId: 'amazon/chronos-2',
        baseRevision: 'rev-1',
        baseFiles: {},
      },
      universe: ['BTCUSDT'],
      startedAt: 1_700_000_000_000,
      stoppedAt: status === 'STOPPED' ? 1_700_003_600_000 : null,
      heartbeatAt: 1_700_000_000_000,
      statusReason: null,
    },
    equityA: 10_000,
    equityB: 10_000,
    returnPctA: 0,
    returnPctB: 0,
    comparable: true,
  };
}

test('normalizeEquitySeriesPoints deduplicates same-second timestamps and sorts ascending', () => {
  const pts = normalizeEquitySeriesPoints([
    { ts: 1_700_000_005_900, equity: 10_050 },
    { ts: 1_700_000_001_200, equity: 10_000 },
    { ts: 1_700_000_001_800, equity: 10_010 },
    { ts: 1_700_000_001_500, equity: 10_005 },
  ]);
  assert.deepEqual(pts, [
    { time: 1_700_000_001, equity: 10_010 },
    { time: 1_700_000_005, equity: 10_050 },
  ]);
});

test('pickPreferredExperimentId prefers active experiment over stopped history and preserves explicit selection', () => {
  const list = [
    makeListItem('exp-stopped-newest', 'STOPPED'),
    makeListItem('exp-awaiting', 'AWAITING_RESUME'),
  ];
  assert.equal(pickPreferredExperimentId(list, null), 'exp-awaiting');
  assert.equal(findActiveExperiment(list)?.experiment.id, 'exp-awaiting');
  assert.equal(pickPreferredExperimentId(list, 'exp-stopped-newest'), 'exp-stopped-newest');
  assert.equal(pickPreferredExperimentId(list, 'exp-missing'), 'exp-awaiting');
});

test('generateModelPaperRequestId conforms to Collector requestId regex and formatting helpers work', () => {
  const reqId = generateModelPaperRequestId('mp_start');
  assert.match(reqId, /^[A-Za-z0-9_-]{8,80}$/);
  assert.equal(EXPERIMENT_STATUS_LABELS.AWAITING_RESUME, '中斷恢復待確認');
  assert.equal(formatDurationMs(3_661_000), '1h 1m');
  assert.equal(formatDurationMs(125_000), '2m 5s');
  assert.match(formatUtcTaipei(1_700_000_000_000), /UTC/);
});

test('ModelPaperPanel and Portfolio render via Vite SSR without runtime errors', async () => {
  const webRoot = path.resolve(import.meta.dirname, '..');
  const vite = await createServer({
    root: webRoot,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  try {
    const panelMod = await vite.ssrLoadModule('/src/components/ModelPaperPanel.tsx');
    const panelHtml = renderToStaticMarkup(React.createElement(panelMod.default, { theme: 'dark' }));
    assert.match(panelHtml, /模型前向測試：Chronos-2 微調版 vs LightGBM 基準/);
    assert.match(panelHtml, /180 天滑動視窗.*Chronos-2 LoRA/);
    assert.match(panelHtml, /開始測試/);

    const portfolioMod = await vite.ssrLoadModule('/src/components/Portfolio.tsx');
    const portfolioHtml = renderToStaticMarkup(
      React.createElement(portfolioMod.default, {
        tickers: {},
        coins: [],
        marketType: 'futures',
        theme: 'light',
      }),
    );
    assert.match(portfolioHtml, /資產持倉概覽/);
    assert.match(portfolioHtml, /data-testid="model-paper-panel"/);
  } finally {
    await vite.close();
  }
});
