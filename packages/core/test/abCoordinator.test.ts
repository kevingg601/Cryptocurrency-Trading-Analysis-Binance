import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ABComparisonCoordinator,
  createAIDataSnapshot,
  validateAIModelOutput,
  stringifyWithInfinity,
  parseWithInfinity,
  defaultAutoTradingConfig,
} from '../src/index.ts';
import type { FollowPlan, MarketTradeFrame, AIAnalysisResult } from '../src/index.ts';

const epoch = 1_800_000_000_000;

function createDummyPlan(id: string, symbol: string, side: 'LONG' | 'SHORT' = 'LONG', confirmedAt = epoch): FollowPlan {
  const mirror = (val: number) => side === 'LONG' ? val : 200 - val;
  return {
    id,
    alertId: `alert-${id}`,
    marketType: 'futures',
    symbol,
    side,
    state: 'CONFIRMED',
    referencePrice: 100,
    triggerPrice: mirror(110),
    impulse: 10,
    triggerTimestamp: confirmedAt - 4000,
    observationPrice: mirror(106.18),
    zoneLow: side === 'LONG' ? 105 : 92.5,
    zoneHigh: side === 'LONG' ? 107.5 : 95,
    stopLoss: mirror(99),
    takeProfit1: mirror(116.5),
    takeProfit2: mirror(120),
    confirmedEntry: mirror(106),
    confirmedAt,
    createdAt: confirmedAt - 4000,
    expiresAt: confirmedAt + 900_000,
    currentPrice: mirror(106),
    stale: false,
  };
}

const DUMMY_RULES = {
  BTCUSDT: { stepSize: 0.001, minQty: 0.001, maxQty: 1000, minNotional: 5 },
  ETHUSDT: { stepSize: 0.01, minQty: 0.01, maxQty: 5000, minNotional: 5 },
};

function makeFrame(
  receivedAt: number,
  trade: { symbol: string; price: number; quantity: number; quoteValue: number; side: 'buy' | 'sell'; timestamp: number },
  confirmations: Array<{ event: any; plan: FollowPlan }> = []
): MarketTradeFrame {
  return {
    marketType: 'futures',
    receivedAt,
    trade,
    alert: null,
    confirmations,
  };
}

function reviewedCoordinator() {
  const coord = new ABComparisonCoordinator('futures');
  coord.setRules(DUMMY_RULES);
  coord.setStreamHealthy(true, epoch);
  coord.start(defaultAutoTradingConfig('futures'), ['BTCUSDT'], 'gemini-2.5-flash', epoch);
  return coord;
}

function reviewedAnalysis(overrides: Partial<AIAnalysisResult> = {}): AIAnalysisResult {
  return {
    schemaVersion: 1, id: 'analysis-review', snapshotId: 'snap-review', snapshotHash: 'hash',
    symbol: 'BTCUSDT', marketType: 'futures', model: 'gemini-2.5-flash',
    promptVersion: 'prompt-v1', ruleVersion: 'rule-v1', generatedAt: epoch,
    expiresAt: epoch + 1_200_000, direction: 'LONG', confidence: 80,
    reasoning: 'fixture', bullishEvidence: [], bearishEvidence: [], risks: [], missingData: [], degraded: false,
    ...overrides,
  };
}

function reviewedFrame(time: number, plan?: FollowPlan) {
  return makeFrame(time, { symbol: 'BTCUSDT', price: 106, quantity: 1, quoteValue: 106, side: 'buy', timestamp: time },
    plan ? [{ plan, event: { type: 'follow-confirmed' } }] : []);
}

test('review: account revisions publish fills and equity without an analysis update', () => {
  const coord = reviewedCoordinator();
  coord.updateAnalysis(reviewedAnalysis(), epoch);
  assert.notEqual(coord.snapshot().id, reviewedCoordinator().snapshot().id, 'separate coordinators cannot collide at the same start time');
  coord.processFrame(reviewedFrame(epoch + 100, createDummyPlan('revision', 'BTCUSDT')));
  const queuedRevision = coord.revision;
  coord.processFrame(reviewedFrame(epoch + 500));
  const snap = coord.snapshot();
  assert.equal(snap.accountA.positions.length, 1);
  assert.equal(snap.accountB.positions.length, 1);
  assert.ok(coord.revision > queuedRevision, 'fill must trigger publishing and persistence');
  assert.notEqual(snap.accountA.id, snap.accountB.id);
  assert.deepEqual(snap.accountA.fills, snap.accountB.fills);
  const fillRevision = coord.revision;
  coord.tick(epoch + 1500);
  assert.ok(coord.revision > fillRevision, 'equity samples must trigger publishing');
});

test('review: invalid and out-of-order frames cannot consume a one-shot decision', () => {
  const coord = reviewedCoordinator();
  coord.processFrame(reviewedFrame(epoch + 1000));
  const plan = createDummyPlan('ordered', 'BTCUSDT', 'LONG', epoch + 1000);
  coord.processFrame(reviewedFrame(epoch + 900, plan));
  coord.processFrame({ ...reviewedFrame(epoch + 1100, plan), marketType: 'spot' });
  assert.equal(coord.snapshot().decisions.length, 0);
  coord.updateAnalysis(reviewedAnalysis(), epoch);
  coord.processFrame(reviewedFrame(epoch + 1200, plan));
  assert.equal(coord.snapshot().decisions[0].allowed, true);
});

test('review: gate rejects future, late-available, expired and unlocked-version analyses', () => {
  const cases: Array<{ analysis: Partial<AIAnalysisResult>; availableAt: number; reason: string }> = [
    { analysis: { generatedAt: epoch + 300 }, availableAt: epoch, reason: 'WAITING' },
    { analysis: {}, availableAt: epoch + 300, reason: 'WAITING' },
    { analysis: { expiresAt: epoch + 400 }, availableAt: epoch, reason: 'EXPIRED' },
    { analysis: { expiresAt: NaN }, availableAt: epoch, reason: 'EXPIRED' },
    { analysis: { model: 'other-model' }, availableAt: epoch, reason: 'MISMATCH' },
    { analysis: { promptVersion: 'other-prompt' }, availableAt: epoch, reason: 'MISMATCH' },
    { analysis: { ruleVersion: 'other-rule' }, availableAt: epoch, reason: 'MISMATCH' },
    { analysis: { missingData: ['indicators_basic'] }, availableAt: epoch, reason: 'DATA_INCOMPLETE' },
  ];
  for (const item of cases) {
    const coord = reviewedCoordinator();
    coord.updateAnalysis(reviewedAnalysis(item.analysis), item.availableAt);
    coord.processFrame(reviewedFrame(epoch + 400, createDummyPlan('gate', 'BTCUSDT', 'LONG', epoch + 200)));
    assert.equal(coord.snapshot().decisions[0].reason, item.reason);
    assert.equal(coord.snapshot().accountB.orders.length, 0);
    coord.updateAnalysis(reviewedAnalysis({ id: 'late', generatedAt: epoch + 500 }), epoch + 500);
    coord.processFrame(reviewedFrame(epoch + 600, createDummyPlan('gate', 'BTCUSDT', 'LONG', epoch + 200)));
    assert.equal(coord.snapshot().accountB.orders.length, 0, 'late results never replay the confirmation');
  }
});

test('review: analysis normalization does not duplicate, regress or expose mutable state', () => {
  const coord = reviewedCoordinator();
  coord.updateAnalysis(reviewedAnalysis({ symbol: 'btcusdt', generatedAt: epoch + 100 }), epoch + 100);
  coord.updateAnalysis(reviewedAnalysis({ id: 'old', generatedAt: epoch }), epoch + 200);
  const result = coord.getAnalysis(' BTCUSDT ')!;
  result.direction = 'SHORT';
  assert.equal(coord.getAllAnalyses().length, 1);
  assert.equal(coord.getAnalysis('btcusdt')?.direction, 'LONG');
  assert.equal(coord.getAnalysis('btcusdt')?.id, 'analysis-review');
});

test('review: failed start leaves coordinator idle and whitespace coins are rejected', () => {
  const coord = new ABComparisonCoordinator('futures');
  assert.throws(() => coord.start(defaultAutoTradingConfig('futures'), ['BTCUSDT'], 'model', epoch));
  assert.equal(coord.snapshot().status, 'IDLE');
  assert.throws(() => coord.start(defaultAutoTradingConfig('futures'), ['  '], 'model', epoch));
});

test('review: neutral analysis counts as covered while the gate still blocks entry', () => {
  const coord = reviewedCoordinator();
  coord.updateAnalysis(reviewedAnalysis({ direction: 'NEUTRAL' }), epoch);
  coord.processFrame(reviewedFrame(epoch + 100, createDummyPlan('neutral-coverage', 'BTCUSDT')));
  assert.equal(coord.calculateMetrics().aiCoverage.coveragePct, 100);
  assert.equal(coord.calculateMetrics().aiCoverage.allowedSignals, 0);
});

test('review: snapshot hashes cover evidence, candles and nested copies; invalid essentials fail closed', () => {
  const input = {
    symbol: 'BTCUSDT', marketType: 'futures' as const, cutoffTime: epoch, now: epoch,
    market: { price: 100, priceChangePercent: 1, volume: 1, quoteVolume: 100, high: 110, low: 90, open: 99, priceTimestamp: epoch },
    klines: Array.from({ length: 30 }, (_, i) => ({ time: epoch / 1000 - (30 - i) * 60, open: 99, high: 110, low: 90, close: 100, volume: 1 })),
    indicators: { sma20: 100, macd: { macd: 1, signal: 1, histogram: 0 } },
    news: [{ id: 'n1', title: 'original', summary: 'summary', link: 'https://example.com/1', source: 'fixture', publishedAt: epoch, receivedAt: epoch }],
  };
  const first = createAIDataSnapshot(input);
  input.news[0].title = 'changed';
  assert.notEqual(createAIDataSnapshot(input).hash, first.hash);
  assert.equal(first.news[0].title, 'original');
  input.klines[0].close++;
  const changedCandle = createAIDataSnapshot(input);
  assert.notEqual(changedCandle.hash, createAIDataSnapshot({ ...input, klines: first.klines }).hash);
  input.indicators.macd.macd++;
  assert.notEqual(createAIDataSnapshot(input).hash, changedCandle.hash);
  assert.equal(first.indicators.macd?.macd, 1);
  input.indicators.sma20 = NaN;
  assert.equal(createAIDataSnapshot(input).essentialDataValid, false);
  input.indicators.sma20 = 100;
  input.market.priceTimestamp = epoch - 120001;
  assert.equal(createAIDataSnapshot(input).essentialDataValid, false);
  assert.notEqual(first.id, createAIDataSnapshot({ ...input, marketType: 'spot' }).id);
});

test('abSerialization preserves Infinity without converting to null', () => {
  const payload = {
    orderId: '1',
    expiresAt: Infinity,
    nested: {
      max: Infinity,
      negative: -Infinity,
      normal: 12345,
    },
  };

  const serialized = stringifyWithInfinity(payload);
  assert.ok(serialized.includes('@@INFINITY@@'), 'Serialized JSON must contain token instead of null');

  const restored = parseWithInfinity<typeof payload>(serialized);
  assert.equal(restored.expiresAt, Infinity);
  assert.equal(restored.nested.max, Infinity);
  assert.equal(restored.nested.negative, -Infinity);
  assert.equal(restored.nested.normal, 12345);
});

test('aiSnapshot validates completeness, computes hash, and enforces 20m validity', () => {
  const cutoff = 1700000000000;
  const snapshot = createAIDataSnapshot({
    symbol: 'BTCUSDT',
    marketType: 'futures',
    cutoffTime: cutoff,
    now: cutoff,
    market: {
      price: 50000,
      priceChangePercent: 2.5,
      volume: 1000,
      quoteVolume: 50000000,
      high: 51000,
      low: 49000,
      open: 49500,
      priceTimestamp: cutoff,
    },
    klines: Array.from({ length: 30 }, (_, i) => ({
      time: Math.floor(cutoff / 60_000) * 60 - 60 - (29 - i) * 60,
      open: 50000,
      high: 50100,
      low: 49900,
      close: 50050,
      volume: 10,
    })),
    indicators: {
      sma20: 50000,
      ema20: 50020,
      rsi14: 55,
    },
  });

  assert.equal(snapshot.symbol, 'BTCUSDT');
  assert.equal(snapshot.essentialDataValid, true);
  assert.equal(snapshot.validUntil, cutoff + 20 * 60 * 1000);
  assert.ok(snapshot.hash.length === 64, 'SHA-256 hash must be 64 characters');
  assert.equal(snapshot.degraded, true, 'Should be degraded because optional derivatives & news are missing');
  assert.ok(snapshot.missingData.includes('open_interest'));
});

test('aiOutputValidator rejects illegal parameter modifications and enforces schema', () => {
  const cutoff = 1_800_000_000_000;
  const snapshot = createAIDataSnapshot({
    symbol: 'BTCUSDT',
    marketType: 'futures',
    cutoffTime: cutoff,
    market: { price: 50000, priceChangePercent: 1, volume: 100, quoteVolume: 5000000, high: 50500, low: 49500, open: 50000, priceTimestamp: cutoff },
    klines: Array.from({ length: 25 }, (_, i) => ({ time: cutoff / 1000 - 60 - 24 * 60 + i * 60, open: 50000, high: 50100, low: 49900, close: 50000, volume: 10 })),
    indicators: { sma20: 50000 },
  });

  // Valid output
  const valid = validateAIModelOutput({
    direction: 'LONG',
    confidence: 85,
    reasoning: 'Strong breakout above SMA20 with solid volume.',
    bullishEvidence: ['MA Golden Cross', 'Increasing volume'],
    bearishEvidence: [],
    risks: ['Resistance at 52000'],
  }, snapshot, { model: 'gemini-2.5-flash', promptVersion: 'prompt-v1', ruleVersion: 'rule-v1' });

  assert.equal(valid.direction, 'LONG');
  assert.equal(valid.confidence, 85);
  assert.equal(valid.expiresAt, snapshot.validUntil);
  assert.throws(() => validateAIModelOutput('null', snapshot, { model: 'gemini-2.5-flash', promptVersion: 'prompt-v1', ruleVersion: 'rule-v1' }), /non-object/);
  assert.throws(() => validateAIModelOutput({ response: 'null' }, snapshot, { model: 'gemini-2.5-flash', promptVersion: 'prompt-v1', ruleVersion: 'rule-v1' }), /non-object/);

  // Illegal parameter modification attempt
  assert.throws(() => {
    validateAIModelOutput({
      direction: 'LONG',
      stopLoss: 45000, // Forbidden!
      reasoning: 'Attack',
    }, snapshot, { model: 'gemini-2.5-flash', promptVersion: 'prompt-v1', ruleVersion: 'rule-v1' });
  }, /attempted illegal parameter modification/);

  // Invalid direction
  assert.throws(() => {
    validateAIModelOutput({
      direction: 'BUY_NOW', // Invalid enum
      reasoning: 'Invalid direction',
    }, snapshot, { model: 'gemini-2.5-flash', promptVersion: 'prompt-v1', ruleVersion: 'rule-v1' });
  }, /Invalid AI direction/);
});

test('ABComparisonCoordinator: fair comparison where AI permits -> A and B match; AI blocks -> B takes 0 trades', () => {
  const coord = new ABComparisonCoordinator('futures');
  coord.setRules(DUMMY_RULES);

  const t0 = epoch;
  coord.setStreamHealthy(true, t0);

  const config = defaultAutoTradingConfig('futures');
  coord.start(config, ['BTCUSDT', 'ETHUSDT'], 'gemini-2.5-flash', t0);

  // Initially, no AI analysis is registered
  // Create a confirmed plan for BTCUSDT (LONG)
  const planBTC = createDummyPlan('plan-btc-1', 'BTCUSDT', 'LONG', t0);

  const frame1 = makeFrame(
    t0 + 100,
    { symbol: 'BTCUSDT', price: 106, quantity: 1, quoteValue: 106, side: 'buy', timestamp: t0 + 100 },
    [{ event: { id: 'evt-1', planId: 'plan-btc-1', type: 'follow-confirmed', symbol: 'BTCUSDT', marketType: 'futures', state: 'CONFIRMED', eventTime: t0 + 100 } as any, plan: planBTC }]
  );

  coord.processFrame(frame1);

  // Account A queues the entry; Account B should have blocked it due to NO_ANALYSIS!
  let snap = coord.snapshot();
  assert.equal(snap.accountA.orders.length, 1, 'Account A must queue entry');
  assert.equal(snap.accountB.orders.length, 0, 'Account B must not queue entry without AI permission');
  assert.equal(snap.decisions.length, 1);
  assert.equal(snap.decisions[0].allowed, false);
  assert.equal(snap.decisions[0].reason, 'NO_ANALYSIS');

  // Now register a valid LONG analysis for ETHUSDT
  coord.updateAnalysis({
    schemaVersion: 1,
    id: 'analysis-eth-1',
    snapshotId: 'snap-eth-1',
    snapshotHash: 'hash-eth',
    symbol: 'ETHUSDT',
    marketType: 'futures',
    model: 'gemini-2.5-flash',
    promptVersion: 'prompt-v1',
    ruleVersion: 'rule-v1',
    generatedAt: t0 + 200,
    expiresAt: t0 + 200 + 20 * 60 * 1000,
    direction: 'LONG',
    confidence: 80,
    reasoning: 'Uptrend confirmed',
    bullishEvidence: ['Support hold'],
    bearishEvidence: [],
    risks: [],
    missingData: [],
    degraded: false,
  });

  // Create confirmed plan for ETHUSDT
  const planETH = createDummyPlan('plan-eth-1', 'ETHUSDT', 'LONG', t0 + 250);
  const frame2 = makeFrame(
    t0 + 300,
    { symbol: 'ETHUSDT', price: 106, quantity: 5, quoteValue: 530, side: 'buy', timestamp: t0 + 300 },
    [{ event: { id: 'evt-2', planId: 'plan-eth-1', type: 'follow-confirmed', symbol: 'ETHUSDT', marketType: 'futures', state: 'CONFIRMED', eventTime: t0 + 300 } as any, plan: planETH }]
  );

  coord.processFrame(frame2);

  snap = coord.snapshot();
  // Both A and B should now queue the entry for ETH!
  const orderETH_A = snap.accountA.orders.find(o => o.symbol === 'ETHUSDT');
  const orderETH_B = snap.accountB.orders.find(o => o.symbol === 'ETHUSDT');
  assert.ok(orderETH_A, 'Account A must queue ETH entry');
  assert.ok(orderETH_B, 'Account B must queue ETH entry because AI allowed');
  assert.equal(snap.decisions.length, 2);
  const decisionETH = snap.decisions.find(d => d.symbol === 'ETHUSDT');
  assert.equal(decisionETH?.allowed, true);
  assert.equal(decisionETH?.reason, 'ACCEPTED');

  // Simulate execution after latency (250ms)
  const frame3 = makeFrame(
    t0 + 600,
    { symbol: 'ETHUSDT', price: 106, quantity: 2, quoteValue: 212, side: 'buy', timestamp: t0 + 600 },
    []
  );
  coord.processFrame(frame3);

  snap = coord.snapshot();
  assert.equal(snap.accountB.positions.length, 1, 'Account B must have filled ETH position');
  assert.equal(snap.accountA.positions.length, 1, 'Account A must have filled ETH position');
  assert.equal(snap.accountA.positions[0].quantity, snap.accountB.positions[0].quantity, 'Fill quantity must be identical on both accounts');
});

test('ABComparisonCoordinator: late arriving analysis does NOT retroactively enter Account B', () => {
  const coord = new ABComparisonCoordinator('futures');
  coord.setRules(DUMMY_RULES);
  const t0 = epoch;
  coord.setStreamHealthy(true, t0);
  coord.start(defaultAutoTradingConfig('futures'), ['BTCUSDT'], 'gemini-2.5-flash', t0);

  const planBTC = createDummyPlan('plan-btc-late', 'BTCUSDT', 'LONG', t0);
  const frame1 = makeFrame(
    t0 + 100,
    { symbol: 'BTCUSDT', price: 106, quantity: 1, quoteValue: 106, side: 'buy', timestamp: t0 + 100 },
    [{ event: { id: 'evt-1', planId: 'plan-btc-late', type: 'follow-confirmed', symbol: 'BTCUSDT', marketType: 'futures', state: 'CONFIRMED', eventTime: t0 + 100 } as any, plan: planBTC }]
  );

  coord.processFrame(frame1);

  // Decision recorded as NO_ANALYSIS, blocked
  assert.equal(coord.snapshot().accountB.orders.length, 0);

  // Late analysis arrives 5 seconds later
  coord.updateAnalysis({
    schemaVersion: 1,
    id: 'analysis-btc-late',
    snapshotId: 'snap-btc-late',
    snapshotHash: 'hash-btc',
    symbol: 'BTCUSDT',
    marketType: 'futures',
    model: 'gemini-2.5-flash',
    promptVersion: 'prompt-v1',
    ruleVersion: 'rule-v1',
    generatedAt: t0 + 5000,
    expiresAt: t0 + 5000 + 20 * 60 * 1000,
    direction: 'LONG',
    confidence: 90,
    reasoning: 'Late arrival',
    bullishEvidence: [],
    bearishEvidence: [],
    risks: [],
    missingData: [],
    degraded: false,
  });

  // Next trade ticks through
  const frame2 = makeFrame(
    t0 + 5500,
    { symbol: 'BTCUSDT', price: 106.5, quantity: 1, quoteValue: 106.5, side: 'buy', timestamp: t0 + 5500 },
    []
  );
  coord.processFrame(frame2);

  // Account B MUST NOT have created any order for the past plan
  assert.equal(coord.snapshot().accountB.orders.length, 0, 'Late analysis must not trigger retrospective entry');
  assert.equal(coord.snapshot().accountB.positions.length, 0);
});

test('ABComparisonCoordinator: Account B exits continue tracking without AI intervention', () => {
  const coord = new ABComparisonCoordinator('futures');
  coord.setRules(DUMMY_RULES);
  const t0 = epoch;
  coord.setStreamHealthy(true, t0);
  coord.start(defaultAutoTradingConfig('futures'), ['BTCUSDT'], 'gemini-2.5-flash', t0);

  // Register valid LONG analysis
  coord.updateAnalysis({
    schemaVersion: 1,
    id: 'analysis-btc-1',
    snapshotId: 'snap-btc-1',
    snapshotHash: 'hash-btc',
    symbol: 'BTCUSDT',
    marketType: 'futures',
    model: 'gemini-2.5-flash',
    promptVersion: 'prompt-v1',
    ruleVersion: 'rule-v1',
    generatedAt: t0,
    expiresAt: t0 + 20 * 60 * 1000,
    direction: 'LONG',
    confidence: 85,
    reasoning: 'Long signal',
    bullishEvidence: [],
    bearishEvidence: [],
    risks: [],
    missingData: [],
    degraded: false,
  });

  const plan = createDummyPlan('plan-btc-exit', 'BTCUSDT', 'LONG', t0);
  coord.processFrame(
    makeFrame(
      t0 + 100,
      { symbol: 'BTCUSDT', price: 106, quantity: 1, quoteValue: 106, side: 'buy', timestamp: t0 + 100 },
      [{ event: { id: 'evt-1', planId: 'plan-btc-exit', type: 'follow-confirmed', symbol: 'BTCUSDT', marketType: 'futures', state: 'CONFIRMED', eventTime: t0 + 100 } as any, plan }]
    )
  );

  // Fill entry on trade
  coord.processFrame(
    makeFrame(
      t0 + 400,
      { symbol: 'BTCUSDT', price: 106, quantity: 1, quoteValue: 106, side: 'buy', timestamp: t0 + 400 },
      []
    )
  );

  assert.equal(coord.snapshot().accountB.positions.length, 1);

  // Now AI direction turns to NEUTRAL or SHORT
  coord.updateAnalysis({
    schemaVersion: 1,
    id: 'analysis-btc-2',
    snapshotId: 'snap-btc-2',
    snapshotHash: 'hash-btc-2',
    symbol: 'BTCUSDT',
    marketType: 'futures',
    model: 'gemini-2.5-flash',
    promptVersion: 'prompt-v1',
    ruleVersion: 'rule-v1',
    generatedAt: t0 + 1000,
    expiresAt: t0 + 1000 + 20 * 60 * 1000,
    direction: 'SHORT', // Opposite!
    confidence: 90,
    reasoning: 'Reversal detected',
    bullishEvidence: [],
    bearishEvidence: [],
    risks: [],
    missingData: [],
    degraded: false,
  });

  // Price hits Stop Loss (stopLoss is 99)
  coord.processFrame(
    makeFrame(
      t0 + 2000,
      { symbol: 'BTCUSDT', price: 98, quantity: 1, quoteValue: 98, side: 'sell', timestamp: t0 + 2000 },
      []
    )
  );

  // Stop Loss exit request queued
  assert.equal(coord.snapshot().accountB.orders.filter(o => o.kind === 'EXIT').length, 1);

  // Fill SL exit after latency
  coord.processFrame(
    makeFrame(
      t0 + 2300,
      { symbol: 'BTCUSDT', price: 97.5, quantity: 1, quoteValue: 97.5, side: 'sell', timestamp: t0 + 2300 },
      []
    )
  );

  // Position closed!
  assert.equal(coord.snapshot().accountB.positions.length, 0);
  assert.equal(coord.snapshot().accountB.trades.length, 1);
  assert.equal(coord.snapshot().accountB.trades[0].reason, 'SL');
});

test('ABComparisonCoordinator: boundary values, expiry, mismatch, neutral, and metrics', () => {
  const coord = new ABComparisonCoordinator('futures');
  coord.setRules(DUMMY_RULES);
  const t0 = epoch;
  coord.setStreamHealthy(true, t0);

  // Boundary: empty coins throws
  assert.throws(() => {
    coord.start(defaultAutoTradingConfig('futures'), [], 'model-1', t0);
  }, /請至少選擇一個追蹤幣種/);

  // Boundary: >10 coins throws
  assert.throws(() => {
    coord.start(defaultAutoTradingConfig('futures'), [
      'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
      'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'NEARUSDT'
    ], 'model-1', t0);
  }, /上限為 10 個/);

  // Start with 2 coins
  coord.start(defaultAutoTradingConfig('futures'), ['BTCUSDT', 'ETHUSDT'], 'gemini-2.5-flash', t0);

  // 1. Expired analysis: cutoffTime was 30 minutes ago (> 20 min validity)
  coord.updateAnalysis({
    schemaVersion: 1,
    id: 'analysis-btc-expired',
    snapshotId: 'snap-btc-exp',
    snapshotHash: 'hash-exp',
    symbol: 'BTCUSDT',
    marketType: 'futures',
    model: 'gemini-2.5-flash',
    promptVersion: 'prompt-v1',
    ruleVersion: 'rule-v1',
    generatedAt: t0 - 25 * 60 * 1000,
    expiresAt: t0 - 5 * 60 * 1000, // Expired 5 mins ago
    direction: 'LONG',
    confidence: 90,
    reasoning: 'Old bull move',
    bullishEvidence: [],
    bearishEvidence: [],
    risks: [],
    missingData: [],
    degraded: false,
  });

  const planBTC = createDummyPlan('plan-exp', 'BTCUSDT', 'LONG', t0);
  coord.processFrame(
    makeFrame(
      t0 + 100,
      { symbol: 'BTCUSDT', price: 106, quantity: 1, quoteValue: 106, side: 'buy', timestamp: t0 + 100 },
      [{ event: { id: 'evt-exp', planId: 'plan-exp', type: 'follow-confirmed', symbol: 'BTCUSDT', marketType: 'futures', state: 'CONFIRMED', eventTime: t0 + 100 } as any, plan: planBTC }]
    )
  );

  let decision = coord.snapshot().decisions.find(d => d.planId === 'plan-exp');
  assert.equal(decision?.allowed, false);
  assert.equal(decision?.reason, 'EXPIRED');

  // 2. Neutral analysis on ETH
  coord.updateAnalysis({
    schemaVersion: 1,
    id: 'analysis-eth-neutral',
    snapshotId: 'snap-eth-neut',
    snapshotHash: 'hash-neut',
    symbol: 'ETHUSDT',
    marketType: 'futures',
    model: 'gemini-2.5-flash',
    promptVersion: 'prompt-v1',
    ruleVersion: 'rule-v1',
    generatedAt: t0,
    expiresAt: t0 + 20 * 60 * 1000,
    direction: 'NEUTRAL',
    confidence: 50,
    reasoning: 'Ranging market',
    bullishEvidence: [],
    bearishEvidence: [],
    risks: [],
    missingData: [],
    degraded: false,
  });

  const planETH = createDummyPlan('plan-neut', 'ETHUSDT', 'LONG', t0 + 200);
  coord.processFrame(
    makeFrame(
      t0 + 250,
      { symbol: 'ETHUSDT', price: 106, quantity: 1, quoteValue: 106, side: 'buy', timestamp: t0 + 250 },
      [{ event: { id: 'evt-neut', planId: 'plan-neut', type: 'follow-confirmed', symbol: 'ETHUSDT', marketType: 'futures', state: 'CONFIRMED', eventTime: t0 + 250 } as any, plan: planETH }]
    )
  );

  decision = coord.snapshot().decisions.find(d => d.planId === 'plan-neut');
  assert.equal(decision?.allowed, false);
  assert.equal(decision?.reason, 'NEUTRAL');

  // 3. Direction mismatch on fresh BTC analysis
  coord.updateAnalysis({
    schemaVersion: 1,
    id: 'analysis-btc-mismatch',
    snapshotId: 'snap-btc-mismatch',
    snapshotHash: 'hash-mismatch',
    symbol: 'BTCUSDT',
    marketType: 'futures',
    model: 'gemini-2.5-flash',
    promptVersion: 'prompt-v1',
    ruleVersion: 'rule-v1',
    generatedAt: t0 + 300,
    expiresAt: t0 + 300 + 20 * 60 * 1000,
    direction: 'SHORT', // Analysis is SHORT, but signal is LONG
    confidence: 85,
    reasoning: 'Bearish continuation',
    bullishEvidence: [],
    bearishEvidence: [],
    risks: [],
    missingData: [],
    degraded: false,
  });

  const planBTCLong = createDummyPlan('plan-mismatch', 'BTCUSDT', 'LONG', t0 + 350);
  coord.processFrame(
    makeFrame(
      t0 + 400,
      { symbol: 'BTCUSDT', price: 106, quantity: 1, quoteValue: 106, side: 'buy', timestamp: t0 + 400 },
      [{ event: { id: 'evt-mismatch', planId: 'plan-mismatch', type: 'follow-confirmed', symbol: 'BTCUSDT', marketType: 'futures', state: 'CONFIRMED', eventTime: t0 + 400 } as any, plan: planBTCLong }]
    )
  );

  decision = coord.snapshot().decisions.find(d => d.planId === 'plan-mismatch');
  assert.equal(decision?.allowed, false);
  assert.equal(decision?.reason, 'MISMATCH');

  // Verify Metrics Calculation
  const metrics = coord.calculateMetrics();
  assert.equal(metrics.aiCoverage.totalSignals, 3);
  assert.equal(metrics.aiCoverage.allowedSignals, 0);
  assert.equal(metrics.aiCoverage.blockedSignals, 3);
  assert.equal(metrics.aiCoverage.skipReasons.EXPIRED, 1);
  assert.equal(metrics.aiCoverage.skipReasons.NEUTRAL, 1);
  assert.equal(metrics.aiCoverage.skipReasons.MISMATCH, 1);
  assert.equal(metrics.blockedSignalsInA.length, 3);

  // Verify CSV export
  const csv = coord.exportCsv();
  assert.ok(csv.startsWith('batch_id,record_type,account'));
  assert.ok(csv.includes('DECISION,B'));
  assert.ok(csv.includes('EXPIRED'));
  assert.ok(csv.includes('NEUTRAL'));
  assert.ok(csv.includes('MISMATCH'));
});

test('ABComparisonCoordinator: case normalization, coin deduplication, open position in blocked signals, and CSV formula injection protection', () => {
  const coord = new ABComparisonCoordinator('futures');
  // Lowercase keys in rules
  coord.setRules({
    btcusdt: { stepSize: 0.001, minQty: 0.001, maxQty: 1000, minNotional: 5 },
    ethusdt: { stepSize: 0.01, minQty: 0.01, maxQty: 5000, minNotional: 5 },
  });

  const t0 = epoch;
  coord.setStreamHealthy(true, t0);

  // Deduplication: passing duplicates in mixed case should deduplicate to 2 coins without throwing
  coord.start(defaultAutoTradingConfig('futures'), ['BTCUSDT', 'btcusdt', 'ETHUSDT', 'ethusdt'], 'gemini-2.5-flash', t0);
  assert.equal(coord.snapshot().selectedCoins.length, 2);
  assert.deepEqual(coord.snapshot().selectedCoins, ['BTCUSDT', 'ETHUSDT']);

  // Register analysis with lowercase symbol
  coord.updateAnalysis({
    schemaVersion: 1,
    id: 'analysis-btc-formula',
    snapshotId: 'snap-btc-formula',
    snapshotHash: 'hash-btc-formula',
    symbol: 'btcusdt', // lowercase
    marketType: 'futures',
    model: '@gemini-2.5-flash', // formula-like prefix
    promptVersion: 'prompt-v1',
    ruleVersion: 'rule-v1',
    generatedAt: t0,
    expiresAt: t0 + 20 * 60 * 1000,
    direction: 'SHORT', // Mismatch for LONG plan
    confidence: 85,
    reasoning: '=SUM(A1:B1) malicious Excel formula test', // formula-like prefix
    bullishEvidence: ['+Positive signal'],
    bearishEvidence: ['-Negative signal'],
    risks: ['@risk-tag'],
    missingData: [],
    degraded: false,
  });

  // Verify getAnalysis case normalization
  assert.ok(coord.getAnalysis('BTCUSDT'));
  assert.ok(coord.getAnalysis('btcusdt'));

  // Feed confirmed LONG plan for BTCUSDT
  const plan = createDummyPlan('plan-btc-open', 'BTCUSDT', 'LONG', t0);
  coord.processFrame(
    makeFrame(
      t0 + 100,
      { symbol: 'BTCUSDT', price: 106, quantity: 1, quoteValue: 106, side: 'buy', timestamp: t0 + 100 },
      [{ event: { id: 'evt-btc-open', planId: 'plan-btc-open', type: 'follow-confirmed', symbol: 'BTCUSDT', marketType: 'futures', state: 'CONFIRMED', eventTime: t0 + 100 } as any, plan }]
    )
  );

  // Fill entry for Account A on next trade; Account B blocked due to MISMATCH
  coord.processFrame(
    makeFrame(
      t0 + 400,
      { symbol: 'BTCUSDT', price: 106, quantity: 1, quoteValue: 106, side: 'buy', timestamp: t0 + 400 },
      []
    )
  );

  const snap = coord.snapshot();
  assert.equal(snap.accountA.positions.length, 1, 'Account A must have open position');
  assert.equal(snap.accountA.trades.length, 0, 'Account A has not closed trade yet');
  assert.equal(snap.accountB.positions.length, 0, 'Account B was blocked');

  // Verify blockedSignalsInA recognizes Account A open position
  const metrics = coord.calculateMetrics();
  assert.equal(metrics.blockedSignalsInA.length, 1);
  assert.equal(metrics.blockedSignalsInA[0].planId, 'plan-btc-open');
  assert.equal(metrics.blockedSignalsInA[0].executedInA, true, 'executedInA must be true for open positions in Account A');
  assert.ok(metrics.blockedSignalsInA[0].tradeNetPnlInA !== undefined);

  // Verify CSV formula injection protection prefixes =, +, -, @ with single quote
  const csv = coord.exportCsv();
  assert.ok(csv.includes("'@gemini-2.5-flash"), 'Excel formula/symbol prefixes like @ must be escaped with single quote');

  snap.decisions[0].explanation = '=SUM(1,2) test';
  const csvWithFormula = ABComparisonCoordinator.exportCsvFromBatch(snap);
  assert.ok(csvWithFormula.includes("'=SUM(1,2) test"), 'Formulas starting with = must be escaped with single quote');
});

test('A/B resume leaves both engines paused while stream is unhealthy and recovers atomically', () => {
  const coord = reviewedCoordinator();
  coord.pause(epoch + 100);
  coord.setStreamHealthy(false, epoch + 200);
  coord.resume(epoch + 300);
  let batch = coord.snapshot();
  assert.equal(batch.status, 'PAUSED');
  assert.equal(batch.accountA.status, 'PAUSED');
  assert.equal(batch.accountB.status, 'PAUSED');

  coord.setStreamHealthy(true, epoch + 400);
  coord.resume(epoch + 500);
  batch = coord.snapshot();
  assert.equal(batch.status, 'RUNNING');
  assert.equal(batch.accountA.status, 'RUNNING');
  assert.equal(batch.accountB.status, 'RUNNING');
});

test('blocked signal PnL includes partial realized profit, remaining mark, all fees and funding', () => {
  const coord = reviewedCoordinator();
  coord.updateAnalysis(reviewedAnalysis({ direction: 'SHORT' }), epoch);
  const plan = createDummyPlan('partial-pnl', 'BTCUSDT', 'LONG', epoch + 100);
  coord.processFrame(reviewedFrame(epoch + 100, plan));
  coord.processFrame(makeFrame(epoch + 400,
    { symbol: 'BTCUSDT', price: 106, quantity: 1, quoteValue: 106, side: 'buy', timestamp: epoch + 400 }));
  coord.processFrame(makeFrame(epoch + 600,
    { symbol: 'BTCUSDT', price: 116.5, quantity: 1, quoteValue: 116.5, side: 'buy', timestamp: epoch + 600 }));
  coord.processFrame(makeFrame(epoch + 900,
    { symbol: 'BTCUSDT', price: 116.5, quantity: 1, quoteValue: 116.5, side: 'buy', timestamp: epoch + 900 }));
  coord.applyFunding([{ symbol: 'BTCUSDT', fundingTime: epoch + 950, fundingRate: 0.001, markPrice: 116.5 }], epoch + 950, epoch + 950);

  const position = coord.snapshot().accountA.positions.find(item => item.planId === plan.id)!;
  assert.ok(position.realizedPnl > 0, 'TP1 must create realized PnL while position remains open');
  assert.ok(position.exitFees > 0);
  const expected = position.realizedPnl
    + (position.currentPrice - position.entryPrice) * position.remainingQuantity
    - position.entryFee - position.exitFees - position.funding;
  assert.ok(expected > 0, 'fixture must remain net positive after partial exit and all carried costs');
  const marked = coord.calculateMetrics().blockedSignalsInA[0];
  assert.ok(Math.abs(marked.tradeNetPnlInA! - expected) < 1e-10);
  assert.equal(marked.tradeWinInA, undefined, 'an open position mark is not a completed win/loss');
});

test('A/B CSV exports per-account cost metadata at one shared cutoff', () => {
  const batch = reviewedCoordinator().snapshot();
  batch.accountA.fundingStatus = 'ERROR';
  batch.accountA.positions = [{ incomplete: true } as (typeof batch.accountA.positions)[number]];
  batch.accountA.equity = [{ timestamp: epoch + 1_000, value: 100 }];
  batch.accountB.fundingStatus = 'PENDING';
  batch.accountB.equity = [{ timestamp: epoch + 2_000, value: 100 }];

  const csv = ABComparisonCoordinator.exportCsvFromBatch(batch);
  const parseRow = (line: string) => {
    const cells: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"' && quoted && line[i + 1] === '"') { cell += '"'; i++; }
      else if (line[i] === '"') quoted = !quoted;
      else if (line[i] === ',' && !quoted) { cells.push(cell); cell = ''; }
      else cell += line[i];
    }
    cells.push(cell);
    return cells;
  };
  const rows = csv.split('\n').slice(1).map(parseRow);
  const metadataRows = rows.filter(row => row[1] === 'BATCH_METADATA');
  assert.equal(metadataRows.length, 2);
  assert.ok(rows.every(row => row.length === 18), 'metadata keeps the existing CSV column contract');

  const metadataA = JSON.parse(metadataRows.find(row => row[2] === 'A')![17]);
  const metadataB = JSON.parse(metadataRows.find(row => row[2] === 'B')![17]);
  assert.equal(metadataRows[0][3], new Date(epoch + 1_000).toISOString());
  assert.equal(metadataRows[1][3], new Date(epoch + 1_000).toISOString());
  assert.equal(metadataA.fundingStatus, 'ERROR');
  assert.equal(metadataA.incomplete, true);
  assert.equal(metadataA.incompletePositions, 1);
  assert.equal(metadataA.commonCutoff, epoch + 1_000);
  assert.equal(metadataA.pairCostStatus, 'PROVISIONAL');
  assert.equal(metadataB.fundingStatus, 'PENDING');
  assert.equal(metadataB.incomplete, true);
  assert.equal(metadataB.pairCostStatus, 'PROVISIONAL');
  assert.equal(metadataB.commonCutoff, metadataA.commonCutoff);
});
