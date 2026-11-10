import test from 'node:test';
import assert from 'node:assert/strict';
import { createAIDataSnapshot, isSnapshotValid, validateAIModelOutput } from '../src/index.ts';

const cutoff = 1_800_000_000_000;
const latestClosedOpen = cutoff / 1000 - 60;

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'BTCUSDT',
    marketType: 'futures' as const,
    cutoffTime: cutoff,
    now: cutoff,
    market: {
      price: 100, priceChangePercent: 1, volume: 100, quoteVolume: 10_000,
      high: 110, low: 90, open: 99, priceTimestamp: cutoff,
    },
    klines: Array.from({ length: 30 }, (_, i) => ({
      time: latestClosedOpen - (29 - i) * 60,
      open: 99, high: 110, low: 90, close: 100, volume: 10,
    })),
    indicators: { sma20: 100 },
    ...overrides,
  };
}

function validOutput(overrides: Record<string, unknown> = {}) {
  return {
    direction: 'LONG', confidence: 80, reasoning: 'Trend and momentum are aligned.',
    bullishEvidence: ['Price above SMA20'], bearishEvidence: [], risks: [],
    ...overrides,
  };
}

test('snapshot accepts only sorted, unique, complete and contiguous closed 1m candles through cutoff', () => {
  const base = makeInput();
  assert.equal(createAIDataSnapshot(base).essentialDataValid, true);

  const gap = [...base.klines];
  gap.splice(14, 1);
  assert.equal(createAIDataSnapshot({ ...base, klines: gap }).essentialDataValid, false);

  const old29PlusNew = [...base.klines.slice(0, 29), { ...base.klines[29], time: base.klines[29].time + 120 }];
  assert.equal(createAIDataSnapshot({ ...base, klines: old29PlusNew }).essentialDataValid, false);

  const duplicate = [...base.klines];
  duplicate[20] = { ...duplicate[19] };
  assert.equal(createAIDataSnapshot({ ...base, klines: duplicate }).essentialDataValid, false);

  const unordered = [...base.klines];
  [unordered[10], unordered[11]] = [unordered[11], unordered[10]];
  assert.equal(createAIDataSnapshot({ ...base, klines: unordered }).essentialDataValid, false);

  for (const candle of [
    { ...base.klines[29], time: base.klines[29].time + 60 },
    { ...base.klines[29], open: NaN },
    { ...base.klines[29], high: 99 },
    { ...base.klines[29], low: 101 },
    { ...base.klines[29], volume: -1 },
  ]) {
    assert.equal(createAIDataSnapshot({ ...base, klines: [...base.klines.slice(0, 29), candle] }).essentialDataValid, false);
  }

  assert.equal(createAIDataSnapshot({ ...base, klines: base.klines.slice(-19) }).essentialDataValid, false);
  assert.equal(createAIDataSnapshot({ ...base, market: { ...base.market, priceTimestamp: cutoff + 1 } }).essentialDataValid, false);
});

test('source health is preserved and explicit stale or missing essential sources fail closed', () => {
  const input = makeInput({ sourceHealth: {
    market: { status: 'healthy', dataAsOf: cutoff },
    klines: { status: 'healthy', dataAsOf: cutoff },
    news: { status: 'stale', dataAsOf: cutoff - 2 * 86_400_000 },
  } });
  const snapshot = createAIDataSnapshot(input);
  assert.equal(snapshot.essentialDataValid, true);
  assert.equal(snapshot.degraded, true);
  assert.equal(snapshot.sources.klines, true);
  assert.equal(snapshot.sources.news, false);
  assert.equal(snapshot.sourceHealth?.news.status, 'stale');
  assert.equal(isSnapshotValid(snapshot, cutoff + 1), true, 'stale optional sources degrade but do not invalidate essentials');

  const missingKlines = createAIDataSnapshot({
    ...makeInput(), sourceHealth: { klines: { status: 'missing' } },
  });
  assert.equal(missingKlines.essentialDataValid, false);

  const oldAsOf = createAIDataSnapshot({
    ...makeInput(), sourceHealth: { market: { status: 'healthy', dataAsOf: cutoff - 121_000 } },
  });
  assert.equal(oldAsOf.essentialDataValid, false);

  const missingMarketDate = makeInput({ market: { ...makeInput().market, priceTimestamp: undefined } });
  assert.equal(createAIDataSnapshot(missingMarketDate).essentialDataValid, false);
});

test('healthy source metadata without dataAsOf does not hit TDZ and empty healthy liquidation feed is usable', () => {
  const newsInput = makeInput({
    sourceHealth: { news: { status: 'healthy', lastSuccessAt: cutoff } },
  });
  const newsSnapshot = createAIDataSnapshot(newsInput);
  assert.equal(newsSnapshot.sourceHealth?.news.status, 'healthy');
  assert.equal(newsSnapshot.sources.news, false, 'feed health does not invent news content');

  const liquidationSnapshot = createAIDataSnapshot({
    ...makeInput(),
    derivatives: { openInterest: 1000, fundingRate: 0.001, liquidations: [] },
    sourceHealth: {
      liquidations: { status: 'healthy', lastSuccessAt: cutoff },
      openInterest: { status: 'healthy', lastSuccessAt: cutoff },
      fundingRate: { status: 'healthy', lastSuccessAt: cutoff },
    },
  });
  assert.equal(liquidationSnapshot.sources.liquidations, true);
  assert.equal(liquidationSnapshot.missingData.includes('liquidations_stream'), false);
  assert.equal(liquidationSnapshot.missingData.includes('openInterest_source_unverified'), false);
  assert.equal(liquidationSnapshot.missingData.includes('fundingRate_source_unverified'), false);

  const unverifiedRates = createAIDataSnapshot({
    ...makeInput(),
    derivatives: { openInterest: 1000, fundingRate: 0.001, liquidations: [] },
    sourceHealth: { news: { status: 'healthy', lastSuccessAt: cutoff } },
  });
  assert.equal(unverifiedRates.sources.openInterest, false);
  assert.equal(unverifiedRates.sources.fundingRate, false);
  assert.equal(unverifiedRates.missingData.includes('openInterest_source_unverified'), true);
  assert.equal(unverifiedRates.missingData.includes('fundingRate_source_unverified'), true);
  assert.equal(unverifiedRates.missingData.includes('liquidations_stream'), true);
});

test('AI model output requires exact schema, real confidence and typed evidence', () => {
  const snapshot = createAIDataSnapshot(makeInput());
  const meta = { model: 'fixture-model', promptVersion: 'p1', ruleVersion: 'r1', now: cutoff };
  const result = validateAIModelOutput(validOutput(), snapshot, meta);
  assert.equal(result.confidence, 80);
  assert.deepEqual(result.bullishEvidence, ['Price above SMA20']);

  for (const bad of [
    validOutput({ confidence: '80' }),
    validOutput({ confidence: NaN }),
    validOutput({ confidence: 101 }),
    validOutput({ reasoning: '' }),
    validOutput({ bullishEvidence: { item: 'evidence' } }),
    validOutput({ risks: 3 }),
    validOutput({ bullishEvidence: [] }),
    validOutput({ extra: 'unexpected' }),
    validOutput({ confidence: undefined }),
    validOutput({ direction: 'long' }),
  ]) {
    assert.throws(() => validateAIModelOutput(bad, snapshot, meta));
  }

  const neutral = validateAIModelOutput(validOutput({ direction: 'NEUTRAL', bullishEvidence: [], bearishEvidence: [] }), snapshot, meta);
  assert.equal(neutral.direction, 'NEUTRAL');
});
