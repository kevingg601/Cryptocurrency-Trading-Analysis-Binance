import test from 'node:test';
import assert from 'node:assert/strict';
import {
  type ModelResearchJobRecord,
  type ModelResearchPanelState,
  type ModelResearchRunResult,
  type ModelResearchStatusResponse,
  deriveResearchPanelState,
} from '@fadachi/core';

function makeReadyStatus(overrides: Partial<ModelResearchStatusResponse> = {}): ModelResearchStatusResponse {
  return {
    configured: true,
    pythonAvailable: true,
    datasetReady: true,
    universeSymbols: ['BTCUSDT', 'ETHUSDT'],
    insufficientSymbols: [],
    lightgbmReady: true,
    kronosModels: {
      small: {
        modelKey: 'small',
        repoId: 'NeoQuasar/Kronos-small',
        tokenizerRepoId: 'NeoQuasar/Kronos-Tokenizer-base',
        installed: true,
        revision: '901c26c1332695a2a8f243eb2f37243a37bea320',
        tokenizerRevision: '0e0117387f3900ee3eff6efeb4ad1fec2ce7bcb2',
      },
      base: {
        modelKey: 'base',
        repoId: 'NeoQuasar/Kronos-base',
        tokenizerRepoId: 'NeoQuasar/Kronos-Tokenizer-base',
        installed: true,
        revision: '0eb6dfd2cae6cd9ac6eb4ad6bfbc8fd9efbe5cd9',
        tokenizerRevision: '0e0117387f3900ee3eff6efeb4ad1fec2ce7bcb2',
      },
    },
    offlineComparisonReady: true,
    isBusy: false,
    activeJob: null,
    lastJob: null,
    ...overrides,
  };
}

function makeRunResult(overrides: Partial<ModelResearchRunResult> = {}): ModelResearchRunResult {
  return {
    runId: 'run-1',
    status: 'SUCCESS',
    market: 'futures',
    kronosModel: 'small',
    cutoffTime: 1_700_000_000_000,
    expiresAt: 1_700_003_600_000,
    generatedAt: 1_700_000_100_000,
    rankings: {
      longTop5: [],
      shortTop5: [],
      allRankings: [],
      conflictSymbols: [],
    },
    forecasts: {},
    warnings: [],
    ...overrides,
  };
}

test('ModelResearchCenter: deriveResearchPanelState covers all 8 states, spot restriction, and prevents old SUCCESS from masking newer FAILED/INSUFFICIENT_DATA', () => {
  const readyStatus = makeReadyStatus();

  // 1. Spot mode restriction
  const spotState: ModelResearchPanelState = deriveResearchPanelState({
    marketType: 'spot',
    statusData: readyStatus,
    latestResult: makeRunResult(),
    now: 1_700_001_000_000,
  });
  assert.equal(spotState, 'UNCONFIGURED');

  // 2. LOADING when initial load or job running
  assert.equal(
    deriveResearchPanelState({
      loadingInitial: true,
      statusData: null,
    }),
    'LOADING',
  );
  assert.equal(
    deriveResearchPanelState({
      statusData: makeReadyStatus({ isBusy: true }),
    }),
    'LOADING',
  );

  // 3. UNCONFIGURED when python or status not configured
  assert.equal(
    deriveResearchPanelState({
      statusData: makeReadyStatus({ configured: false, pythonAvailable: false }),
    }),
    'UNCONFIGURED',
  );

  // 4. EMPTY when dataset not ready or no latestResult yet
  assert.equal(
    deriveResearchPanelState({
      statusData: makeReadyStatus({ datasetReady: false }),
    }),
    'EMPTY',
  );
  assert.equal(
    deriveResearchPanelState({
      statusData: readyStatus,
      latestResult: null,
    }),
    'EMPTY',
  );

  // 5. MODEL_MISSING when LightGBM or selected Kronos model is not installed
  assert.equal(
    deriveResearchPanelState({
      statusData: makeReadyStatus({ lightgbmReady: false }),
    }),
    'MODEL_MISSING',
  );
  assert.equal(
    deriveResearchPanelState({
      statusData: makeReadyStatus({
        kronosModels: {
          ...readyStatus.kronosModels,
          base: { ...readyStatus.kronosModels.base, installed: false },
        },
      }),
      selectedKronosModel: 'base',
    }),
    'MODEL_MISSING',
  );

  // 6. SUCCESS and EXPIRED when latestResult is valid
  const runResult = makeRunResult();
  assert.equal(
    deriveResearchPanelState({
      statusData: readyStatus,
      latestResult: runResult,
      now: 1_700_001_000_000,
    }),
    'SUCCESS',
  );
  assert.equal(
    deriveResearchPanelState({
      statusData: readyStatus,
      latestResult: runResult,
      now: 1_700_003_600_001,
    }),
    'EXPIRED',
  );

  // 7. INSUFFICIENT_DATA from result or newer job
  assert.equal(
    deriveResearchPanelState({
      statusData: readyStatus,
      latestResult: makeRunResult({ status: 'INSUFFICIENT_DATA' }),
      now: 1_700_001_000_000,
    }),
    'INSUFFICIENT_DATA',
  );

  // 8. FAILED when a newer lastJob failed even if an older SUCCESS latestResult exists on disk
  const newerFailedJob: ModelResearchJobRecord = {
    jobId: 'job-failed-2',
    runId: 'run-failed-2',
    kronosModel: 'small',
    status: 'FAILED',
    createdAt: 1_700_002_000_000,
    startedAt: 1_700_002_000_000,
    completedAt: 1_700_002_005_000,
    errorCode: 'CUDA_OUT_OF_MEMORY',
    errorMessage: 'CUDA out of memory',
  };
  assert.equal(
    deriveResearchPanelState({
      statusData: makeReadyStatus({ lastJob: newerFailedJob }),
      activeJob: null,
      latestResult: runResult, // generatedAt = 1_700_000_100_000 (older than newerFailedJob)
      now: 1_700_002_010_000,
    }),
    'FAILED',
  );
});

test('Real aggregate configured=false preserves missing-model and empty-data states', () => {
  assert.equal(deriveResearchPanelState({ statusData: makeReadyStatus({
    configured: false, lightgbmReady: false,
  }) }), 'MODEL_MISSING');
  assert.equal(deriveResearchPanelState({ statusData: makeReadyStatus({
    configured: false, datasetReady: false,
  }) }), 'EMPTY');
});



test('Chronos selection requires its own deployment rather than a ready Kronos model', () => {
  assert.equal(deriveResearchPanelState({ statusData: makeReadyStatus(), selectedKronosModel: 'chronos2' }), 'MODEL_MISSING');
  assert.equal(deriveResearchPanelState({ statusData: makeReadyStatus({ chronos2: { installed: true } }), selectedKronosModel: 'chronos2' }), 'EMPTY');
});
