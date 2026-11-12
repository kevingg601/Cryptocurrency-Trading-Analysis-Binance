import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FourGroupComparisonCoordinator,
  FOUR_GROUP_IDS,
  evaluateLightgbmGate,
  isRemoteOllamaUrl,
  sanitizeOllamaUrl,
  selectDynamicCoinsFromLgbmSnapshot,
  defaultAutoTradingConfig,
  parseWithInfinity,
  stringifyWithInfinity,
} from '../src/index.ts';
import type {
  AutoSymbolRules,
  FollowPlan,
  LightgbmRankSnapshot,
  MarketTradeFrame,
  ResearchRankingEntry,
} from '../src/index.ts';
import type { ExtendedAIAnalysisInput } from '../src/auto/fourGroupTypes.ts';

const HOUR_MS = 3_600_000;
// Clean UTC hour boundary
const H0 = 1_800_000_000_000 - (1_800_000_000_000 % HOUR_MS);

const UNIVERSE_20 = [
  'BTCUSDT', 'ETHUSDT', 'JCTUSDT', 'ZECUSDT', 'SOLUSDT',
  'XRPUSDT', 'HYPEUSDT', '1000PEPEUSDT', 'NEARUSDT', 'DOGEUSDT',
  'BNBUSDT', 'ONEUSDT', 'ENAUSDT', 'AIOTUSDT', 'SUIUSDT',
  'UNIUSDT', 'HOTUSDT', 'KOMAUSDT', 'WLDUSDT', 'ICNTUSDT',
];

const RULES: Record<string, AutoSymbolRules> = Object.fromEntries(
  UNIVERSE_20.map(symbol => [symbol, { stepSize: 0.001, minQty: 0.001, maxQty: 10000, minNotional: 5 }]),
);

function makePlan(id: string, symbol: string, side: 'LONG' | 'SHORT', confirmedAt: number): FollowPlan {
  const mirror = (val: number) => (side === 'LONG' ? val : 200 - val);
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
    triggerTimestamp: confirmedAt - 4_000,
    observationPrice: mirror(106.18),
    zoneLow: side === 'LONG' ? 105 : 92.5,
    zoneHigh: side === 'LONG' ? 107.5 : 95,
    stopLoss: mirror(99),
    takeProfit1: mirror(116.5),
    takeProfit2: mirror(120),
    confirmedEntry: mirror(106),
    confirmedAt,
    createdAt: confirmedAt - 4_000,
    expiresAt: confirmedAt + 900_000,
    currentPrice: mirror(106),
    stale: false,
  };
}

function makeFrame(
  receivedAt: number,
  symbol: string,
  price: number,
  plan?: FollowPlan,
): MarketTradeFrame {
  return {
    marketType: 'futures',
    receivedAt,
    trade: {
      symbol,
      price,
      quantity: 1,
      quoteValue: price,
      side: plan?.side === 'SHORT' ? 'sell' : 'buy',
      timestamp: receivedAt,
    },
    alert: null,
    confirmations: plan ? [{ plan, event: { id: `evt-${plan.id}`, planId: plan.id, type: 'follow-confirmed', marketType: 'futures', symbol, side: plan.side, timestamp: plan.confirmedAt ?? receivedAt, price, title: '確認', message: '確認' } }] : [],
  };
}

function makeRankEntry(rank: number, symbol: string, side: 'LONG' | 'SHORT', conflict = false): ResearchRankingEntry {
  return {
    rank,
    symbol,
    side,
    rankingScore: 0.5 - rank * 0.05,
    longScore: side === 'LONG' ? 0.5 - rank * 0.05 : -0.1,
    shortScore: side === 'SHORT' ? 0.5 - rank * 0.05 : -0.1,
    longRank: side === 'LONG' ? rank : 15,
    shortRank: side === 'SHORT' ? rank : 15,
    conflict,
    closePrice: 106,
    ret1h: 0.01,
    ret4h: 0.02,
    ret24h: 0.05,
    rsi14: 55,
  };
}

function makeLgbmSnapshot(cutoffTime: number, publishedAt: number): LightgbmRankSnapshot {
  return {
    snapshotId: `lgbm-snap-${cutoffTime}`,
    status: 'SUCCESS',
    decisionOpenTime: cutoffTime - HOUR_MS,
    cutoffTime,
    generatedAt: publishedAt - 200,
    publishedAt,
    expiresAt: cutoffTime + HOUR_MS,
    versionId: 'lgbm-v1',
    longSha256: 'sha-long',
    shortSha256: 'sha-short',
    trainedAt: publishedAt - 500,
    universeSymbols: UNIVERSE_20,
    eligibleCount: 20,
    insufficientSymbols: [],
    longTop5: [
      makeRankEntry(1, 'BTCUSDT', 'LONG', false),
      makeRankEntry(2, 'ETHUSDT', 'LONG', false),
      makeRankEntry(3, 'SOLUSDT', 'LONG', true), // conflict!
      makeRankEntry(4, 'XRPUSDT', 'LONG', false),
      makeRankEntry(5, 'BNBUSDT', 'LONG', false),
    ],
    shortTop5: [
      makeRankEntry(1, 'DOGEUSDT', 'SHORT', false),
      makeRankEntry(2, 'SUIUSDT', 'SHORT', false),
      makeRankEntry(3, 'NEARUSDT', 'SHORT', false),
      makeRankEntry(4, 'SOLUSDT', 'SHORT', true), // conflict!
      makeRankEntry(5, 'WLDUSDT', 'SHORT', false),
    ],
    conflictSymbols: ['SOLUSDT'],
    reason: null,
  };
}

function makeAI(overrides: Partial<ExtendedAIAnalysisInput> = {}): ExtendedAIAnalysisInput {
  return {
    schemaVersion: 1,
    id: 'ai-1',
    snapshotId: 'snap-1',
    snapshotHash: 'hash-1',
    snapshotCreatedAt: H0 + 5_000,
    symbol: 'BTCUSDT',
    marketType: 'futures',
    model: 'gemma4:e2b',
    promptVersion: 'prompt-v1',
    ruleVersion: 'rule-v1',
    generatedAt: H0 + 6_000,
    expiresAt: H0 + 1_206_000,
    direction: 'LONG',
    confidence: 82,
    reasoning: 'trend ok',
    bullishEvidence: ['ema20'],
    bearishEvidence: [],
    risks: [],
    missingData: [],
    degraded: false,
    ...overrides,
  };
}

test('sanitizeOllamaUrl strips query/hash, rejects credentials, and flags remote hosts', () => {
  assert.equal(sanitizeOllamaUrl('http://127.0.0.1:11434///?token=leak#abc'), 'http://127.0.0.1:11434');
  assert.equal(isRemoteOllamaUrl('http://localhost:11434'), false);
  assert.equal(isRemoteOllamaUrl('http://127.0.0.1:11434'), false);
  assert.equal(isRemoteOllamaUrl('http://192.168.1.50:11434'), true);
  assert.throws(() => sanitizeOllamaUrl('http://user:secret@192.168.1.50:11434'));
  assert.throws(() => sanitizeOllamaUrl('ftp://127.0.0.1:11434'));
});

test('start validates futures-only, <=10 coins, and strict research universe membership', () => {
  const coord = new FourGroupComparisonCoordinator('futures');
  coord.setRules(RULES);
  coord.setStreamHealthy(true, H0);
  const cfg = defaultAutoTradingConfig('futures');

  assert.throws(() => coord.start({
    config: defaultAutoTradingConfig('spot'),
    selectedCoins: ['BTCUSDT'],
    universeSymbols: UNIVERSE_20,
    model: 'gemma4:e2b',
    now: H0,
  }), /永續合約/);

  assert.throws(() => coord.start({
    config: cfg,
    selectedCoins: UNIVERSE_20.slice(0, 11),
    universeSymbols: UNIVERSE_20,
    model: 'gemma4:e2b',
    now: H0,
  }), /10 檔/);

  assert.throws(() => coord.start({
    config: cfg,
    selectedCoins: ['BTCUSDT', 'NOTINUNIVERSEUSDT'],
    universeSymbols: UNIVERSE_20,
    model: 'gemma4:e2b',
    now: H0,
  }), /NOTINUNIVERSEUSDT/);

  coord.start({
    config: cfg,
    selectedCoins: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'],
    universeSymbols: UNIVERSE_20,
    ollamaUrl: 'http://192.168.1.80:11434/',
    model: 'gemma4:e2b',
    now: H0 + 1_000,
  });

  const snap = coord.snapshot();
  assert.equal(snap.status, 'RUNNING');
  assert.equal(snap.locked.isRemoteOllama, true);
  assert.equal(snap.locked.ollamaUrl, 'http://192.168.1.80:11434');
  assert.deepEqual(snap.locked.selectedCoins, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT']);
});

test('four-group gating matrix (A/B/C/D) strictly enforces Top 3, conflicts, AI alignment, and audits all 4 groups', () => {
  const coord = new FourGroupComparisonCoordinator('futures');
  coord.setRules(RULES);
  coord.setStreamHealthy(true, H0);
  coord.start({
    config: defaultAutoTradingConfig('futures'),
    selectedCoins: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'],
    universeSymbols: UNIVERSE_20,
    model: 'gemma4:e2b',
    now: H0 + 1_000,
  });

  coord.updateLightgbmRanking(makeLgbmSnapshot(H0, H0 + 2_000));

  // Case 1: BTCUSDT rank #1 LONG + AI LONG => A/B/C/D all ALLOWED
  coord.updateAnalysis(makeAI({ id: 'ai-btc', symbol: 'BTCUSDT', direction: 'LONG' }), H0 + 7_000);
  coord.processFrame(makeFrame(H0 + 10_000, 'BTCUSDT', 106, makePlan('p-btc', 'BTCUSDT', 'LONG', H0 + 10_000)));

  // Case 2: ETHUSDT rank #2 LONG + AI NEUTRAL => A & C allowed; B & D rejected (NEUTRAL)
  coord.updateAnalysis(makeAI({ id: 'ai-eth', symbol: 'ETHUSDT', direction: 'NEUTRAL' }), H0 + 7_000);
  coord.processFrame(makeFrame(H0 + 10_100, 'ETHUSDT', 106, makePlan('p-eth', 'ETHUSDT', 'LONG', H0 + 10_100)));

  // Case 3: XRPUSDT rank #4 LONG (outside Top 3) + AI LONG => A & B allowed; C & D rejected (NOT_IN_TOP3)
  coord.updateAnalysis(makeAI({ id: 'ai-xrp', symbol: 'XRPUSDT', direction: 'LONG' }), H0 + 7_000);
  coord.processFrame(makeFrame(H0 + 10_200, 'XRPUSDT', 106, makePlan('p-xrp', 'XRPUSDT', 'LONG', H0 + 10_200)));

  // Case 4: SOLUSDT rank #3 LONG + in conflictSymbols + AI LONG => A & B allowed; C & D rejected (CONFLICT)
  coord.updateAnalysis(makeAI({ id: 'ai-sol', symbol: 'SOLUSDT', direction: 'LONG' }), H0 + 7_000);
  coord.processFrame(makeFrame(H0 + 10_300, 'SOLUSDT', 106, makePlan('p-sol', 'SOLUSDT', 'LONG', H0 + 10_300)));

  // Case 5: DOGEUSDT rank #1 SHORT + AI LONG (mismatch!) => A & C allowed; B & D rejected (MISMATCH)
  coord.updateAnalysis(makeAI({ id: 'ai-doge', symbol: 'DOGEUSDT', direction: 'LONG' }), H0 + 7_000);
  coord.processFrame(makeFrame(H0 + 10_400, 'DOGEUSDT', 94, makePlan('p-doge', 'DOGEUSDT', 'SHORT', H0 + 10_400)));

  const snap = coord.snapshot();
  const followDecisions = snap.decisions.filter(d => d.signalSource === 'follow-rule');
  const dDirectDecisions = snap.decisions.filter(d => d.signalSource === 'lgbm-ai-direct');
  assert.equal(followDecisions.length, 5);
  assert.equal(dDirectDecisions.length, 3); // BTC (GO), ETH (NEUTRAL), DOGE (MISMATCH); XRP/SOL excluded by LGBM before AI

  const byPlan = Object.fromEntries(followDecisions.map(d => [d.planId, d]));
  assert.deepEqual(
    FOUR_GROUP_IDS.map(g => byPlan['p-btc'].groups[g].allowed),
    [true, true, true, false],
  );
  assert.equal(byPlan['p-btc'].groups.D.reason, 'INDEPENDENT_STRATEGY');
  assert.deepEqual(
    FOUR_GROUP_IDS.map(g => byPlan['p-eth'].groups[g].allowed),
    [true, false, true, false],
  );
  assert.equal(byPlan['p-eth'].ai.reason, 'NEUTRAL');
  assert.equal(byPlan['p-eth'].groups.B.reason, 'NEUTRAL');

  assert.deepEqual(
    FOUR_GROUP_IDS.map(g => byPlan['p-xrp'].groups[g].allowed),
    [true, true, false, false],
  );
  assert.equal(byPlan['p-xrp'].lgbm.reason, 'NOT_IN_TOP3');
  assert.equal(byPlan['p-xrp'].lgbm.sideRank, 4);

  assert.deepEqual(
    FOUR_GROUP_IDS.map(g => byPlan['p-sol'].groups[g].allowed),
    [true, true, false, false],
  );
  assert.equal(byPlan['p-sol'].lgbm.reason, 'CONFLICT');

  assert.deepEqual(
    FOUR_GROUP_IDS.map(g => byPlan['p-doge'].groups[g].allowed),
    [true, false, true, false],
  );
  assert.equal(byPlan['p-doge'].ai.reason, 'MISMATCH');

  const dBtcDirect = dDirectDecisions.find(d => d.symbol === 'BTCUSDT')!;
  assert.equal(dBtcDirect.groups.D.allowed, true);
  assert.equal(coord.snapshot().accounts.D.orders.length, 1);

  // Verify ALL follow decisions share identical signal/snapshot/model audit provenance
  for (const d of followDecisions) {
    assert.ok(d.lgbm.snapshotId);
    assert.equal(d.ai.model, 'gemma4:e2b');
    assert.ok(d.ai.snapshotId);
  }
});

test('time boundary & strict zero-lookahead: expired old-hour ranking, future ranking, and late AI are rejected', () => {
  const H1 = H0 + HOUR_MS;
  // Previous hour cutoff (H0) expired when H1 starts
  const staleSnap = makeLgbmSnapshot(H0, H0 + 1_000);
  assert.equal(
    evaluateLightgbmGate({
      symbol: 'BTCUSDT',
      side: 'LONG',
      confirmedAt: H1 + 500,
      snapshot: staleSnap,
      lockedUniverse: UNIVERSE_20,
    }).reason,
    'EXPIRED_RANKING',
  );

  // Future ranking completed at H1 + 20_000 cannot be used for signal at H1 + 500
  const futureSnap = makeLgbmSnapshot(H1, H1 + 20_000);
  assert.equal(
    evaluateLightgbmGate({
      symbol: 'BTCUSDT',
      side: 'LONG',
      confirmedAt: H1 + 500,
      snapshot: futureSnap,
      lockedUniverse: UNIVERSE_20,
    }).reason,
    'FUTURE_RANKING',
  );

  const coord = new FourGroupComparisonCoordinator('futures');
  coord.setRules(RULES);
  coord.setStreamHealthy(true, H0);
  coord.start({
    config: defaultAutoTradingConfig('futures'),
    selectedCoins: ['BTCUSDT', 'ETHUSDT'],
    universeSymbols: UNIVERSE_20,
    model: 'gemma4:e2b',
    now: H0,
  });

  // Set stale H0 snapshot, plus future H1+10000 AI analysis and incomplete essential ETH analysis
  coord.updateLightgbmRanking(makeLgbmSnapshot(H0, H0 + 500));
  coord.updateAnalysis(makeAI({ symbol: 'BTCUSDT', snapshotCreatedAt: H1 + 100, generatedAt: H1 + 10_000, expiresAt: H1 + 10_000 + 1_200_000 }), H1 + 10_000);
  coord.updateAnalysis(makeAI({ symbol: 'ETHUSDT', snapshotCreatedAt: H1 + 100, generatedAt: H1 + 200, expiresAt: H1 + 200 + 1_200_000, missingData: ['klines_sufficient', 'onchain_metrics'] }), H1 + 200);

  // Signal at H1 + 500 -> stale H0 LightGBM expired, BTC AI waiting -> only Group A enters!
  coord.processFrame(makeFrame(H1 + 500, 'BTCUSDT', 106, makePlan('p-h1-btc', 'BTCUSDT', 'LONG', H1 + 500)));
  coord.processFrame(makeFrame(H1 + 600, 'ETHUSDT', 106, makePlan('p-h1-eth', 'ETHUSDT', 'LONG', H1 + 600)));

  const dBtc = coord.snapshot().decisions.find(d => d.planId === 'p-h1-btc')!;
  const dEth = coord.snapshot().decisions.find(d => d.planId === 'p-h1-eth')!;
  assert.equal(dBtc.groups.A.allowed, true);
  assert.equal(dBtc.groups.B.allowed, false);
  assert.equal(dBtc.ai.reason, 'WAITING');
  assert.equal(dBtc.groups.C.allowed, false);
  assert.equal(dBtc.lgbm.reason, 'EXPIRED_RANKING');
  assert.equal(dBtc.groups.D.allowed, false);

  assert.equal(dEth.ai.reason, 'DATA_INCOMPLETE');
  assert.equal(dEth.groups.B.allowed, false);
});

test('independent funds, fills, counterfactual PnL, lifecycle sync, recovery, and CSV escaping', () => {
  const coord = new FourGroupComparisonCoordinator('futures');
  coord.setRules(RULES);
  coord.setStreamHealthy(true, H0);
  coord.start({
    config: defaultAutoTradingConfig('futures'),
    selectedCoins: ['BTCUSDT', 'DOGEUSDT'],
    universeSymbols: UNIVERSE_20,
    model: 'gemma4:e2b',
    now: H0 + 1_000,
  });

  coord.updateLightgbmRanking(makeLgbmSnapshot(H0, H0 + 2_000));
  coord.updateAnalysis(makeAI({ id: 'ai-btc', symbol: 'BTCUSDT', direction: 'LONG', snapshotCreatedAt: H0 + 2_000, generatedAt: H0 + 2_500 }), H0 + 3_000);
  // Mismatched model version -> blocks B and D
  coord.updateAnalysis(makeAI({ id: 'ai-doge', symbol: 'DOGEUSDT', direction: 'SHORT', model: 'wrong-model', snapshotCreatedAt: H0 + 2_000, generatedAt: H0 + 2_500 }), H0 + 3_000);

  // BTC enters all 4 groups; DOGE enters A & C only
  coord.processFrame(makeFrame(H0 + 5_000, 'BTCUSDT', 106, makePlan('p-btc', 'BTCUSDT', 'LONG', H0 + 5_000)));
  coord.processFrame(makeFrame(H0 + 5_100, 'DOGEUSDT', 94, makePlan('p-doge', 'DOGEUSDT', 'SHORT', H0 + 5_100)));

  // Fill both entries after 250ms latency
  coord.processFrame(makeFrame(H0 + 5_500, 'BTCUSDT', 106));
  coord.processFrame(makeFrame(H0 + 5_600, 'DOGEUSDT', 94));

  // Take full TP2 on BTC & move DOGE into profit -> realize divergence
  coord.processFrame(makeFrame(H0 + 6_000, 'BTCUSDT', 120));
  coord.processFrame(makeFrame(H0 + 6_300, 'BTCUSDT', 120));
  coord.processFrame(makeFrame(H0 + 6_400, 'DOGEUSDT', 80));
  coord.processFrame(makeFrame(H0 + 6_700, 'DOGEUSDT', 80));

  const m = coord.calculateMetrics();
  assert.equal(m.accounts.A.closedTradeCount, 2);
  assert.equal(m.accounts.B.closedTradeCount, 1);
  assert.equal(m.accounts.C.closedTradeCount, 2);
  // Group D operates independently on LightGBM+AI, holds BTCUSDT until SL/signal loss rather than TP2
  assert.equal(m.accounts.D.openPositionCount, 1);
  assert.ok(m.accounts.A.metrics.equity > m.accounts.B.metrics.equity);
  assert.equal(m.blockedCounterfactuals.length, 1);
  assert.equal(m.blockedCounterfactuals[0].planId, 'p-doge');
  assert.deepEqual(m.blockedCounterfactuals[0].blockedInGroups, ['B']);
  assert.equal(m.blockedCounterfactuals[0].tradeWinInA, true);

  // Pause & resume sync
  coord.pause(H0 + 7_000);
  assert.equal(coord.snapshot().status, 'PAUSED');
  coord.resume(H0 + 7_100);
  assert.equal(coord.snapshot().status, 'RUNNING');

  // Infinity serialization & restoreInterrupted
  const serialized = stringifyWithInfinity(coord.snapshot());
  const restoredCoord = new FourGroupComparisonCoordinator('futures');
  restoredCoord.restoreInterrupted(parseWithInfinity(serialized), H0 + 8_000);
  const restoredSnap = restoredCoord.snapshot();
  assert.equal(restoredSnap.status, 'INTERRUPTED');
  for (const id of FOUR_GROUP_IDS) {
    assert.equal(restoredSnap.accounts[id].status, 'INTERRUPTED');
  }

  // CSV contains all 4 BATCH_METADATA rows and injection-safe escaping
  const batchForCsv = coord.snapshot();
  batchForCsv.decisions[0].groups.A.explanation = '=CMD|calc';
  const csv = FourGroupComparisonCoordinator.exportCsvFromBatch(batchForCsv);
  assert.ok(csv.includes("'=CMD|calc"));
  const metaLines = csv.split('\n').filter(line => line.includes(',BATCH_METADATA,'));
  assert.equal(metaLines.length, 4);
});

test('rejects partial ranking universes, non-finite ranks and future/invalid confirmations', () => {
  const snap = makeLgbmSnapshot(H0, H0 + 1_000);
  const gate = () => evaluateLightgbmGate({ symbol: 'BTCUSDT', side: 'LONG',
    confirmedAt: H0 + 10_000, snapshot: snap, lockedUniverse: UNIVERSE_20 });
  snap.universeSymbols = ['BTCUSDT'];
  assert.equal(gate().reason, 'COIN_UNIVERSE_MISMATCH');
  snap.universeSymbols = UNIVERSE_20;
  snap.longTop5[0].rank = NaN;
  snap.allRankings = [{ ...snap.longTop5[0], longRank: NaN }];
  snap.longTop5 = [];
  assert.equal(gate().allowed, false);

  const coord = new FourGroupComparisonCoordinator();
  coord.setRules(RULES);
  coord.setStreamHealthy(true, H0);
  assert.throws(() => coord.start({ config: defaultAutoTradingConfig('futures'), selectedCoins: ['BTCUSDT'],
    universeSymbols: ['BTCUSDT'], model: 'gemma4:e2b', now: H0 }), /20 檔/);
  coord.start({ config: defaultAutoTradingConfig('futures'), selectedCoins: ['BTCUSDT'],
    universeSymbols: UNIVERSE_20, model: 'gemma4:e2b', now: H0 });
  for (const [i, confirmedAt] of [H0 + 60_000, NaN, Infinity].entries()) {
    coord.processFrame(makeFrame(H0 + 10_000 + i, 'BTCUSDT', 106,
      makePlan(`invalid-${i}`, 'BTCUSDT', 'LONG', confirmedAt)));
  }
  assert.equal(coord.snapshot().decisions.length, 0);
  assert.equal(coord.snapshot().accounts.A.orders.length, 0);
});

test('AI missingData fails closed, exact TTL expires, and restarting clears prior endpoint analyses', () => {
  const coord = new FourGroupComparisonCoordinator();
  coord.setRules(RULES);
  coord.setStreamHealthy(true, H0);
  const start = (url: string, now: number) => coord.start({ config: defaultAutoTradingConfig('futures'),
    selectedCoins: ['BTCUSDT'], universeSymbols: UNIVERSE_20, model: 'gemma4:e2b', ollamaUrl: url, now });
  start('http://localhost:11434', H0);
  coord.updateAnalysis(makeAI({ missingData: undefined }), H0 + 7_000);
  coord.processFrame(makeFrame(H0 + 10_000, 'BTCUSDT', 106, makePlan('missing-data', 'BTCUSDT', 'LONG', H0 + 10_000)));
  assert.equal(coord.snapshot().decisions[0].ai.reason, 'DATA_INCOMPLETE');
  coord.updateAnalysis(makeAI({ id: 'ttl', snapshotCreatedAt: H0, generatedAt: H0 + 11_000,
    expiresAt: H0 + 2_000_000 }), H0 + 12_000);
  coord.processFrame(makeFrame(H0 + 1_200_000, 'BTCUSDT', 106, makePlan('ttl-edge', 'BTCUSDT', 'LONG', H0 + 1_200_000)));
  assert.equal(coord.snapshot().decisions.at(-1)!.ai.reason, 'EXPIRED');
  coord.interrupt(H0 + 1_201_000, 'new endpoint');
  start('http://127.0.0.2:11434', H0 + 1_202_000);
  coord.processFrame(makeFrame(H0 + 1_203_000, 'BTCUSDT', 106,
    makePlan('new-endpoint', 'BTCUSDT', 'LONG', H0 + 1_203_000)));
  assert.equal(coord.snapshot().decisions[0].ai.reason, 'NO_ANALYSIS');
  assert.throws(() => sanitizeOllamaUrl('http://user:secret@['), error =>
    error instanceof Error && !error.message.includes('secret'));

  // Optional missing fields (e.g. CoinMetrics onchain_metrics / news_feed) must NOT fail-closed valid AI results
  const optCoord = new FourGroupComparisonCoordinator('futures');
  optCoord.setRules(RULES);
  optCoord.setStreamHealthy(true, H0);
  optCoord.updateLightgbmRanking(makeLgbmSnapshot(H0, H0 + 500));
  optCoord.start({ config: defaultAutoTradingConfig('futures'), coinMode: 'auto-lgbm', universeSymbols: UNIVERSE_20, model: 'gemma4:e2b', now: H0 + 1_000 });
  optCoord.updateAnalysis(makeAI({
    id: 'ai-opt-degraded',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    confidence: 78,
    degraded: true,
    missingData: ['onChain_source_missing', 'onchain_metrics', 'news_feed'],
    snapshotCreatedAt: H0 + 1_100,
    generatedAt: H0 + 1_200,
    expiresAt: H0 + 1_200_000,
  }), H0 + 1_300);
  optCoord.processFrame(makeFrame(H0 + 2_000, 'BTCUSDT', 100));
  const optDec = optCoord.snapshot().decisions.at(-1)!;
  assert.equal(optDec.ai.reason, 'ALLOWED');
  assert.equal(optDec.groups.D.allowed, true);
  assert.equal(optCoord.snapshot().accounts.D.orders.length, 1);
});

test('auto-lgbm coinMode derives <=10 coins dynamically, rotates across hours, and preserves open exits', () => {
  const H1 = H0 + HOUR_MS;
  const h0Snap = makeLgbmSnapshot(H0, H0 + 1_000);
  // 10 unique symbols across L1..L5 and S1..S5 plus an outside symbol filtered out
  const h1Snap: LightgbmRankSnapshot = {
    ...makeLgbmSnapshot(H1, H1 + 100),
    snapshotId: `lgbm-snap-${H1}`,
    longTop5: [
      makeRankEntry(1, 'KOMAUSDT', 'LONG', false),
      makeRankEntry(2, 'JCTUSDT', 'LONG', false),
      makeRankEntry(3, '1000PEPEUSDT', 'LONG', false),
      makeRankEntry(4, 'SUIUSDT', 'LONG', false),
      makeRankEntry(5, 'OUTSIDEUSDT', 'LONG', false),
    ],
    shortTop5: [
      makeRankEntry(1, 'HOTUSDT', 'SHORT', false),
      makeRankEntry(2, 'WLDUSDT', 'SHORT', false),
      makeRankEntry(3, 'ENAUSDT', 'SHORT', false),
      makeRankEntry(4, 'ONEUSDT', 'SHORT', false),
      makeRankEntry(5, 'ZECUSDT', 'SHORT', false),
    ],
    conflictSymbols: [],
  };

  const derivedH0 = selectDynamicCoinsFromLgbmSnapshot(h0Snap, UNIVERSE_20);
  assert.deepEqual(derivedH0, [
    'BTCUSDT', 'DOGEUSDT', 'ETHUSDT', 'SUIUSDT', 'SOLUSDT',
    'NEARUSDT', 'XRPUSDT', 'BNBUSDT', 'WLDUSDT',
  ]);
  const derivedH1 = selectDynamicCoinsFromLgbmSnapshot(h1Snap, UNIVERSE_20);
  assert.equal(derivedH1.length, 9);
  assert.ok(!derivedH1.includes('OUTSIDEUSDT'));
  assert.equal(derivedH1[0], 'KOMAUSDT');

  const coord = new FourGroupComparisonCoordinator('futures');
  coord.setRules(RULES);
  coord.setStreamHealthy(true, H1 - 4_000);
  coord.updateLightgbmRanking(h0Snap);
  coord.start({
    config: defaultAutoTradingConfig('futures'),
    coinMode: 'auto-lgbm',
    universeSymbols: UNIVERSE_20,
    model: 'gemma4:e2b',
    now: H1 - 3_500,
  });

  const startSnap = coord.snapshot();
  assert.equal(startSnap.locked.coinMode, 'auto-lgbm');
  assert.deepEqual(startSnap.activeCoins, derivedH0);
  assert.equal(startSnap.coinRotations?.length, 1);

  // Open LONG BTCUSDT just before hour boundary H1
  coord.processFrame(makeFrame(H1 - 2_500, 'BTCUSDT', 106, makePlan('p-btc-open', 'BTCUSDT', 'LONG', H1 - 2_500)));
  coord.processFrame(makeFrame(H1 - 2_000, 'BTCUSDT', 106));
  assert.equal(coord.snapshot().accounts.A.positions.length, 1);

  // H1 snapshot arrives (< 5s tick gap) -> BTCUSDT rotates OUT, KOMAUSDT rotates IN
  coord.updateLightgbmRanking(h1Snap);
  const rotatedSnap = coord.snapshot();
  assert.deepEqual(rotatedSnap.activeCoins, derivedH1);
  assert.equal(rotatedSnap.coinRotations?.length, 2);

  // Outdated snapshot (< H1) cannot revert rotation
  coord.updateLightgbmRanking(h0Snap);
  assert.deepEqual(coord.snapshot().activeCoins, derivedH1);

  // New signal for rotated-out BTCUSDT is ignored cleanly
  const beforeDecCount = coord.snapshot().decisions.length;
  coord.processFrame(makeFrame(H1 + 500, 'BTCUSDT', 106, makePlan('p-btc-ignored', 'BTCUSDT', 'LONG', H1 + 500)));
  assert.equal(coord.snapshot().decisions.length, beforeDecCount);

  // Existing open BTCUSDT position still settles/closes normally on TP2
  coord.processFrame(makeFrame(H1 + 1_000, 'BTCUSDT', 120));
  coord.processFrame(makeFrame(H1 + 1_300, 'BTCUSDT', 120));
  assert.equal(coord.snapshot().accounts.A.positions.length, 0);
  assert.equal(coord.snapshot().accounts.A.trades.length, 1);

  // Newly rotated-in KOMAUSDT receives confirmations cleanly
  coord.processFrame(makeFrame(H1 + 1_600, 'KOMAUSDT', 106, makePlan('p-koma', 'KOMAUSDT', 'LONG', H1 + 1_600)));
  assert.equal(coord.snapshot().decisions.length, beforeDecCount + 1);
  assert.equal(coord.snapshot().decisions.at(-1)?.symbol, 'KOMAUSDT');
});

test('Group D enters without 5s follow rules, requires AI confidence >= 60, blocks same-hour re-entry, and exits on SL / LGBM drop / AI flip', () => {
  const coord = new FourGroupComparisonCoordinator('futures');
  coord.setRules(RULES);
  coord.setStreamHealthy(true, H0);
  coord.updateLightgbmRanking(makeLgbmSnapshot(H0, H0 + 500));
  coord.start({
    config: defaultAutoTradingConfig('futures'),
    coinMode: 'auto-lgbm',
    universeSymbols: UNIVERSE_20,
    model: 'gemma4:e2b',
    now: H0 + 1_000,
  });

  // 1) Low AI confidence (59 < 60) blocks Group D even when LGBM #1 & AI LONG match
  coord.updateAnalysis(makeAI({ id: 'ai-btc-low', symbol: 'BTCUSDT', direction: 'LONG', confidence: 59, snapshotCreatedAt: H0 + 1_100, generatedAt: H0 + 1_200 }), H0 + 1_300);
  coord.processFrame(makeFrame(H0 + 2_000, 'BTCUSDT', 100)); // NO FollowPlan confirmations!
  assert.equal(coord.snapshot().accounts.A.orders.length, 0);
  assert.equal(coord.snapshot().accounts.D.orders.length, 0);
  assert.equal(coord.snapshot().decisions.at(-1)?.ai.reason, 'LOW_CONFIDENCE');

  // 2) AI confidence >= 60 triggers autonomous Group D entry immediately on plain trade frame (A/B/C stay 0)
  coord.updateAnalysis(makeAI({ id: 'ai-btc-ok', symbol: 'BTCUSDT', direction: 'LONG', confidence: 75, snapshotCreatedAt: H0 + 2_100, generatedAt: H0 + 2_200 }), H0 + 2_300);
  coord.processFrame(makeFrame(H0 + 3_000, 'BTCUSDT', 100));
  assert.equal(coord.snapshot().accounts.A.orders.length, 0);
  assert.equal(coord.snapshot().accounts.B.orders.length, 0);
  assert.equal(coord.snapshot().accounts.C.orders.length, 0);
  assert.equal(coord.snapshot().accounts.D.orders.length, 1);

  // Fill entry after 250ms latency
  coord.processFrame(makeFrame(H0 + 3_300, 'BTCUSDT', 100));
  assert.equal(coord.snapshot().accounts.D.positions.length, 1);
  assert.equal(coord.snapshot().accounts.D.positions[0].takeProfit1, 0);

  // 3) Group D does NOT exit at 15 minutes (900_000ms) -> stays open (no follow TIMEOUT)
  coord.processFrame(makeFrame(H0 + 3_500, 'BTCUSDT', 100.5));
  assert.equal(coord.snapshot().accounts.D.positions.length, 1);

  // 4) -2% stop-loss triggers SL exit and blocks re-entry in the SAME UTC hour H0
  const slPrice = coord.snapshot().accounts.D.positions[0].stopLoss - 0.1;
  coord.processFrame(makeFrame(H0 + 4_000, 'BTCUSDT', slPrice));
  coord.processFrame(makeFrame(H0 + 4_300, 'BTCUSDT', slPrice));
  assert.equal(coord.snapshot().accounts.D.positions.length, 0);
  assert.equal(coord.snapshot().accounts.D.trades.length, 1);
  assert.equal(coord.snapshot().accounts.D.trades[0].reason, 'SL');

  // Same hour H0 tick at normal price does NOT reopen BTCUSDT LONG
  coord.processFrame(makeFrame(H0 + 5_000, 'BTCUSDT', 100));
  assert.equal(coord.snapshot().accounts.D.orders.length, 0);

  // 5) Open ETHUSDT (#2 LONG) in H0, then keep holding across H1 while testing LGBM_EXIT when dropped
  coord.updateAnalysis(makeAI({ id: 'ai-eth', symbol: 'ETHUSDT', direction: 'LONG', confidence: 80, snapshotCreatedAt: H0 + 5_100, generatedAt: H0 + 5_200 }), H0 + 5_300);
  coord.processFrame(makeFrame(H0 + 5_500, 'ETHUSDT', 200));
  coord.processFrame(makeFrame(H0 + 5_800, 'ETHUSDT', 200));
  assert.equal(coord.snapshot().accounts.D.positions.length, 1);
  assert.equal(coord.snapshot().accounts.D.positions[0].symbol, 'ETHUSDT');

  // Cross into H1 briefly (< 10m grace): ETHUSDT does not prematurely exit before H1 LGBM snapshot lands
  const H1 = H0 + HOUR_MS;
  const h1StartedCoord = new FourGroupComparisonCoordinator('futures');
  h1StartedCoord.setRules(RULES);
  h1StartedCoord.setStreamHealthy(true, H1 - 3_000);
  h1StartedCoord.updateLightgbmRanking(makeLgbmSnapshot(H0, H0 + 500));
  h1StartedCoord.start({ config: defaultAutoTradingConfig('futures'), coinMode: 'auto-lgbm', universeSymbols: UNIVERSE_20, model: 'gemma4:e2b', now: H1 - 2_500 });
  h1StartedCoord.updateAnalysis(makeAI({ id: 'ai-eth-h0', symbol: 'ETHUSDT', direction: 'LONG', confidence: 82, snapshotCreatedAt: H1 - 2_400, generatedAt: H1 - 2_300, expiresAt: H1 + 1_200_000 }), H1 - 2_200);
  h1StartedCoord.processFrame(makeFrame(H1 - 2_000, 'ETHUSDT', 200));
  h1StartedCoord.processFrame(makeFrame(H1 - 1_600, 'ETHUSDT', 200));
  assert.equal(h1StartedCoord.snapshot().accounts.D.positions.length, 1);

  // At H1 + 500ms (still inside grace), position stays open until H1 snapshot arrives
  h1StartedCoord.processFrame(makeFrame(H1 + 500, 'ETHUSDT', 201));
  assert.equal(h1StartedCoord.snapshot().accounts.D.positions.length, 1);

  // H1 snapshot arrives with ETHUSDT dropped from Top 3 -> queues LGBM_EXIT & closes cleanly
  const h1DroppedSnap = makeLgbmSnapshot(H1, H1 + 1_000);
  h1DroppedSnap.longTop5 = [
    makeRankEntry(1, 'KOMAUSDT', 'LONG', false),
    makeRankEntry(2, 'JCTUSDT', 'LONG', false),
    makeRankEntry(3, 'BTCUSDT', 'LONG', false),
    makeRankEntry(4, 'ETHUSDT', 'LONG', false),
    makeRankEntry(5, 'BNBUSDT', 'LONG', false),
  ];
  h1StartedCoord.updateLightgbmRanking(h1DroppedSnap);
  h1StartedCoord.processFrame(makeFrame(H1 + 1_200, 'ETHUSDT', 201));
  h1StartedCoord.processFrame(makeFrame(H1 + 1_500, 'ETHUSDT', 201));
  assert.equal(h1StartedCoord.snapshot().accounts.D.positions.length, 0);
  assert.equal(h1StartedCoord.snapshot().accounts.D.trades[0].reason, 'LGBM_EXIT');

  // 6) BTCUSDT re-entry IS allowed cleanly in new hour H1 when AI switches fresh
  h1StartedCoord.updateAnalysis(makeAI({ id: 'ai-btc-h1', symbol: 'BTCUSDT', direction: 'LONG', confidence: 88, snapshotCreatedAt: H1 + 1_600, generatedAt: H1 + 1_700, expiresAt: H1 + 1_200_000 }), H1 + 1_800);
  h1StartedCoord.processFrame(makeFrame(H1 + 2_000, 'BTCUSDT', 100));
  h1StartedCoord.processFrame(makeFrame(H1 + 2_300, 'BTCUSDT', 100));
  assert.equal(h1StartedCoord.snapshot().accounts.D.positions.length, 1);
  assert.equal(h1StartedCoord.snapshot().accounts.D.positions[0].symbol, 'BTCUSDT');

  // AI flip to SHORT triggers AI_EXIT cleanly
  h1StartedCoord.updateAnalysis(makeAI({ id: 'ai-btc-flip', symbol: 'BTCUSDT', direction: 'SHORT', confidence: 75, snapshotCreatedAt: H1 + 2_400, generatedAt: H1 + 2_500, expiresAt: H1 + 1_200_000 }), H1 + 2_600);
  h1StartedCoord.processFrame(makeFrame(H1 + 2_800, 'BTCUSDT', 101));
  h1StartedCoord.processFrame(makeFrame(H1 + 3_100, 'BTCUSDT', 101));
  assert.equal(h1StartedCoord.snapshot().accounts.D.positions.length, 0);
  assert.equal(h1StartedCoord.snapshot().accounts.D.trades[1].reason, 'AI_EXIT');
});

test('Group D trailing take-profit activates at +2%, ratchets stop on favorable moves, and exits via TRAILING_TP symmetrically', () => {
  const coord = new FourGroupComparisonCoordinator('futures');
  coord.setRules(RULES);
  coord.setStreamHealthy(true, H0);
  coord.updateLightgbmRanking(makeLgbmSnapshot(H0, H0 + 500));
  coord.start({
    config: { ...defaultAutoTradingConfig('futures'), slippageBps: 0, feeBps: 0 },
    coinMode: 'auto-lgbm',
    universeSymbols: UNIVERSE_20,
    model: 'gemma4:e2b',
    now: H0 + 1_000,
  });

  // LONG BTCUSDT at 100 -> initial SL = 98
  coord.updateAnalysis(makeAI({ id: 'ai-btc-trail', symbol: 'BTCUSDT', direction: 'LONG', confidence: 80, snapshotCreatedAt: H0 + 1_100, generatedAt: H0 + 1_200 }), H0 + 1_300);
  coord.processFrame(makeFrame(H0 + 2_000, 'BTCUSDT', 100));
  coord.processFrame(makeFrame(H0 + 2_300, 'BTCUSDT', 100));
  assert.equal(coord.snapshot().accounts.D.positions.length, 1);
  assert.equal(coord.snapshot().accounts.D.positions[0].trailingActive, false);
  assert.equal(coord.snapshot().accounts.D.positions[0].stopLoss, 98);

  // +1.5% is below +2% activation -> trailing stays inactive, SL stays 98
  coord.processFrame(makeFrame(H0 + 2_600, 'BTCUSDT', 101.5));
  assert.equal(coord.snapshot().accounts.D.positions[0].trailingActive, false);
  assert.equal(coord.snapshot().accounts.D.positions[0].stopLoss, 98);

  // +6.0% activates trailing and ratchets SL to 106 * 0.985 = 104.41
  coord.processFrame(makeFrame(H0 + 2_900, 'BTCUSDT', 106));
  const posAfterRally = coord.snapshot().accounts.D.positions[0];
  assert.equal(posAfterRally.trailingActive, true);
  assert.equal(posAfterRally.peakPrice, 106);
  assert.ok(Math.abs(posAfterRally.stopLoss - 104.41) < 1e-9);

  // Pullback only down to 105 does NOT lower SL and stays open
  coord.processFrame(makeFrame(H0 + 3_200, 'BTCUSDT', 105));
  assert.equal(coord.snapshot().accounts.D.positions.length, 1);
  assert.ok(Math.abs(coord.snapshot().accounts.D.positions[0].stopLoss - 104.41) < 1e-9);

  // Pullback crossing 104.41 (e.g. 104.4) triggers TRAILING_TP with net profit
  coord.processFrame(makeFrame(H0 + 3_500, 'BTCUSDT', 104.4));
  coord.processFrame(makeFrame(H0 + 3_800, 'BTCUSDT', 104.4));
  const dAfterLong = coord.snapshot().accounts.D;
  assert.equal(dAfterLong.positions.length, 0);
  assert.equal(dAfterLong.trades.length, 1);
  assert.equal(dAfterLong.trades[0].reason, 'TRAILING_TP');
  assert.ok(dAfterLong.trades[0].netPnl > 0);

  // Symmetrical SHORT DOGEUSDT at 100 -> drops to 95 (-5%, favorable!), trailing SL ratchets to 95 * 1.015 = 96.425
  coord.updateAnalysis(makeAI({ id: 'ai-doge-trail', symbol: 'DOGEUSDT', direction: 'SHORT', confidence: 85, snapshotCreatedAt: H0 + 4_000, generatedAt: H0 + 4_100 }), H0 + 4_200);
  coord.processFrame(makeFrame(H0 + 4_500, 'DOGEUSDT', 100));
  coord.processFrame(makeFrame(H0 + 4_800, 'DOGEUSDT', 100));
  coord.processFrame(makeFrame(H0 + 5_100, 'DOGEUSDT', 95));
  const shortPos = coord.snapshot().accounts.D.positions[0];
  assert.equal(shortPos.trailingActive, true);
  assert.ok(Math.abs(shortPos.stopLoss - 96.425) < 1e-9);

  // Bounce above 96.425 triggers TRAILING_TP profitably
  coord.processFrame(makeFrame(H0 + 5_400, 'DOGEUSDT', 96.5));
  coord.processFrame(makeFrame(H0 + 5_700, 'DOGEUSDT', 96.5));
  const dAfterShort = coord.snapshot().accounts.D;
  assert.equal(dAfterShort.positions.length, 0);
  assert.equal(dAfterShort.trades[1].reason, 'TRAILING_TP');
  assert.ok(dAfterShort.trades[1].netPnl > 0);
});
