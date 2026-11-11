import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MODEL_PAPER_CONFIG,
  applyFill,
  applyFunding,
  buildCandidatePool,
  buildSignals,
  checkStop,
  computeAccountMetrics,
  evaluateComparability,
  fillSlots,
  reconcile,
  valuate,
  type AutoSymbolRules,
  type EquityPoint,
  type ModelPaperDecisionRecord,
  type ModelPaperGap,
  type PaperAccountState,
  type PaperFill,
  type PaperOrder,
  type PaperPosition,
} from '../src/index.ts';

const HOUR = 3_600_000;
const H = 1_762_819_200_000; // aligned UTC hour
const CUTOFF = H + HOUR;

function baseAccount(account: 'A' | 'B' = 'A', overrides: Partial<PaperAccountState> = {}): PaperAccountState {
  return {
    experimentId: 'exp-1',
    account,
    cash: 10_000,
    reserved: 0,
    realizedPnl: 0,
    fees: 0,
    funding: 0,
    bankrupt: false,
    degraded: false,
    fundingPending: false,
    stoppedThisHour: [],
    updatedAt: CUTOFF + 30_000,
    ...overrides,
  };
}

const DEFAULT_RULES: Record<string, AutoSymbolRules> = {
  BTCUSDT: { stepSize: 0.001, minQty: 0.001, maxQty: 100, minNotional: 10, maxNotional: 500_000 },
  ETHUSDT: { stepSize: 0.01, minQty: 0.01, maxQty: 1000, minNotional: 10, maxNotional: 500_000 },
  SOLUSDT: { stepSize: 0.1, minQty: 0.1, maxQty: 10000, minNotional: 10, maxNotional: 500_000 },
  XRPUSDT: { stepSize: 1, minQty: 1, maxQty: 100000, minNotional: 10, maxNotional: 500_000 },
  DOGEUSDT: { stepSize: 10, minQty: 10, maxQty: 1000000, minNotional: 10, maxNotional: 500_000 },
  NEARUSDT: { stepSize: 1, minQty: 1, maxQty: 100000, minNotional: 10, maxNotional: 500_000 },
};

test('signals: shared candidate pool excludes conflicts, enforces strict >0.25% threshold, direction match, freshness, and deterministic ordering', () => {
  const now = CUTOFF + 35_000;
  const result = buildSignals({
    decisionOpenTime: H,
    targetCutoffTime: CUTOFF,
    now,
    longTop5: [
      { rank: 1, symbol: 'CONFLICTUSDT', side: 'LONG', closePrice: 10 },
      { rank: 2, symbol: 'BTCUSDT', side: 'LONG', closePrice: 100_000 },
      { rank: 3, symbol: 'ETHUSDT', side: 'LONG', closePrice: 3_000 },
      { rank: 4, symbol: 'IGNORED4USDT', side: 'LONG', closePrice: 5 },
    ],
    shortTop5: [
      { rank: 1, symbol: 'CONFLICTUSDT', side: 'SHORT', closePrice: 10 },
      { rank: 2, symbol: 'SOLUSDT', side: 'SHORT', closePrice: 200 },
      { rank: 3, symbol: 'XRPUSDT', side: 'SHORT', closePrice: 1 },
    ],
    conflictSymbols: ['CONFLICTUSDT'],
    forecasts: {
      // Exact 0.25% boundary -> NOT accepted (must be strictly greater)
      BTCUSDT: { symbol: 'BTCUSDT', lastClose: 100_000, predictedClose4h: 100_250, predictedPath: [100_000, 100_100, 100_200, 100_250] },
      // Stale reference price (received > 5s ago)
      ETHUSDT: { symbol: 'ETHUSDT', lastClose: 3_000, predictedClose4h: 3_050, predictedPath: [3_010, 3_020, 3_030, 3_050] },
      // SHORT direction mismatch (predicts higher price)
      SOLUSDT: { symbol: 'SOLUSDT', lastClose: 200, predictedClose4h: 205, predictedPath: [201, 202, 203, 205] },
      // Valid SHORT > 0.25%: (1 - 0.996 / 1.0) = 0.004 > 0.0025
      XRPUSDT: { symbol: 'XRPUSDT', lastClose: 1, predictedClose4h: 0.996, predictedPath: [0.999, 0.998, 0.997, 0.996] },
    },
    referencePrices: {
      BTCUSDT: { symbol: 'BTCUSDT', price: 100_000, tradeTime: CUTOFF + 34_000, receivedAt: now - 1_000 },
      ETHUSDT: { symbol: 'ETHUSDT', price: 3_000, tradeTime: CUTOFF + 10_000, receivedAt: now - 5_001 },
      SOLUSDT: { symbol: 'SOLUSDT', price: 200, tradeTime: CUTOFF + 34_000, receivedAt: now - 500 },
      XRPUSDT: { symbol: 'XRPUSDT', price: 1, tradeTime: CUTOFF, receivedAt: now - 5_000 },
    },
  });

  // Shared pool excludes conflict symbols and only takes top 3 of each side
  assert.deepEqual(
    result.pool.map(p => `${p.symbol}:${p.side}:${p.sideRank}`),
    ['BTCUSDT:LONG:2', 'ETHUSDT:LONG:3', 'SOLUSDT:SHORT:2', 'XRPUSDT:SHORT:3'],
  );

  // Account B accepts all non-conflict pool entries, ordered by sideRank, symbol, LONG before SHORT
  assert.deepEqual(
    result.signalsB.map(s => `${s.symbol}:${s.side}:${s.sideRank}`),
    ['BTCUSDT:LONG:2', 'SOLUSDT:SHORT:2', 'ETHUSDT:LONG:3', 'XRPUSDT:SHORT:3'],
  );

  // Account A only accepts XRPUSDT
  assert.deepEqual(result.signalsA.map(s => s.symbol), ['XRPUSDT']);
  assert.deepEqual(
    result.skippedA.map(s => `${s.symbol}:${s.reason}`).sort(),
    [
      'BTCUSDT:BELOW_THRESHOLD',
      'CONFLICTUSDT:CONFLICT',
      'CONFLICTUSDT:CONFLICT',
      'ETHUSDT:STALE_REFERENCE_PRICE',
      'SOLUSDT:DIRECTION_MISMATCH',
    ],
  );
  assert.deepEqual(
    result.skippedB.map(s => `${s.symbol}:${s.reason}`),
    ['CONFLICTUSDT:CONFLICT', 'CONFLICTUSDT:CONFLICT'],
  );
});

test('signals: rejects tradeTime < H+1h as STALE_REFERENCE_PRICE, missing forecast as CHRONOS_MISSING, and breaks ties LONG before SHORT', () => {
  const now = CUTOFF + 2_000;
  const res = buildSignals({
    decisionOpenTime: H,
    targetCutoffTime: CUTOFF,
    now,
    longTop5: [
      { rank: 1, symbol: 'AAUSDT', side: 'LONG', closePrice: 10 },
      { rank: 1, symbol: 'BBUSDT', side: 'LONG', closePrice: 10 },
    ],
    shortTop5: [
      { rank: 1, symbol: 'AAUSDT', side: 'SHORT', closePrice: 10 }, // synthetic tie test with empty conflictSymbols
      { rank: 1, symbol: 'CCUSDT', side: 'SHORT', closePrice: 10 },
    ],
    conflictSymbols: [],
    forecasts: {
      AAUSDT: { symbol: 'AAUSDT', lastClose: 10, predictedClose4h: 10.1, predictedPath: [10.02, 10.05, 10.08, 10.1] },
      BBUSDT: { symbol: 'BBUSDT', lastClose: 10, predictedClose4h: 10.1, predictedPath: [10.02, 10.05, 10.08, 10.1] },
      // CCUSDT missing forecast
    },
    referencePrices: {
      AAUSDT: { symbol: 'AAUSDT', price: 10, tradeTime: CUTOFF, receivedAt: now },
      BBUSDT: { symbol: 'BBUSDT', price: 10, tradeTime: CUTOFF - 1, receivedAt: now }, // before H+1h
      CCUSDT: { symbol: 'CCUSDT', price: 10, tradeTime: CUTOFF, receivedAt: now },
    },
  });

  // Sort tie-breaker: same sideRank, same symbol -> LONG before SHORT
  assert.deepEqual(
    res.signalsB.map(s => `${s.symbol}:${s.side}`),
    ['AAUSDT:LONG', 'AAUSDT:SHORT', 'BBUSDT:LONG', 'CCUSDT:SHORT'],
  );
  assert.equal(res.skippedA.find(s => s.symbol === 'BBUSDT')?.reason, 'STALE_REFERENCE_PRICE');
  assert.equal(res.skippedA.find(s => s.symbol === 'CCUSDT')?.reason, 'CHRONOS_MISSING');
  assert.deepEqual(buildCandidatePool({ longTop5: [], shortTop5: [], conflictSymbols: [] }).pool, []);
});

test('engine: reconcile holds same-side without resetting stop, reverses via exit-first slot release, handles SIGNAL_GONE, NO_SLOT, SPEC_LIMIT, STOPPED_THIS_HOUR, INSUFFICIENT_CASH, DEGRADED, BANKRUPT', () => {
  const openPos: PaperPosition[] = [
    {
      id: 'pos-btc',
      experimentId: 'exp-1',
      account: 'A',
      symbol: 'BTCUSDT',
      side: 'LONG',
      qty: 0.02,
      entryPrice: 95_000,
      stopPrice: 93_100, // old custom stop that must not be reset
      openedAt: H - HOUR,
      openedDecisionHour: H - HOUR,
      status: 'OPEN',
    },
    {
      id: 'pos-eth',
      experimentId: 'exp-1',
      account: 'A',
      symbol: 'ETHUSDT',
      side: 'LONG',
      qty: 0.5,
      entryPrice: 3_000,
      stopPrice: 2_940,
      openedAt: H - HOUR,
      openedDecisionHour: H - HOUR,
      status: 'OPEN',
    },
    {
      id: 'pos-sol',
      experimentId: 'exp-1',
      account: 'A',
      symbol: 'SOLUSDT',
      side: 'LONG',
      qty: 10,
      entryPrice: 200,
      stopPrice: 196,
      openedAt: H - HOUR,
      openedDecisionHour: H - HOUR,
      status: 'OPEN',
    },
  ];

  // Cash after holding those 3 positions (~1900 + 1500 + 2000 = 5400 reserved)
  const acc = baseAccount('A', { cash: 4_600, reserved: 5_400 });
  const signals = [
    { symbol: 'BTCUSDT', side: 'LONG' as const, sideRank: 1, refPrice: 100_000, closePrice1h: 100_000 }, // hold
    { symbol: 'ETHUSDT', side: 'SHORT' as const, sideRank: 1, refPrice: 3_000, closePrice1h: 3_000 }, // reverse
    { symbol: 'XRPUSDT', side: 'LONG' as const, sideRank: 2, refPrice: 1, closePrice1h: 1 }, // wants slot
    { symbol: 'DOGEUSDT', side: 'SHORT' as const, sideRank: 2, refPrice: 0.1, closePrice1h: 0.1 }, // stopped this hour
  ];

  const rec = reconcile(acc, signals, {
    experimentStatus: 'RUNNING',
    decisionId: 'dec-1',
    decisionHour: H,
    now: CUTOFF + 35_000,
    rules: DEFAULT_RULES,
    positions: openPos,
    pendingOrders: [],
    stoppedThisHour: ['DOGEUSDT'],
    lastPrices: { BTCUSDT: 100_000, ETHUSDT: 3_000, SOLUSDT: 200 },
  });

  // BTC holds, ETH exits (REVERSED), SOL exits (SIGNAL_GONE), no entries yet while 3 positions open
  assert.equal(rec.exitOrders.length, 2);
  assert.equal(rec.exitOrders.find(o => o.symbol === 'ETHUSDT')?.reason, 'REVERSED');
  assert.equal(rec.exitOrders.find(o => o.symbol === 'SOLUSDT')?.reason, 'SIGNAL_GONE');
  assert.equal(rec.entryOrders.length, 0);
  assert.equal(rec.skipped.find(s => s.symbol === 'XRPUSDT')?.reason, 'NO_SLOT');
  assert.equal(rec.skipped.find(s => s.symbol === 'DOGEUSDT')?.reason, 'STOPPED_THIS_HOUR');

  // ETH exit fills -> 1 slot opens -> onExitFilled calls fillSlots -> ETH SHORT cannot be re-entered until slot freed AND ETH position closed!
  const ethExitOrder = rec.exitOrders.find(o => o.symbol === 'ETHUSDT')!;
  const filledExit = applyFill(
    acc,
    openPos,
    ethExitOrder,
    { symbol: 'ETHUSDT', price: 3_100, aggId: 101, tradeTime: CUTOFF + 36_000, receivedAt: CUTOFF + 36_000 },
    DEFAULT_MODEL_PAPER_CONFIG,
    H,
    { BTCUSDT: 100_000, ETHUSDT: 3_100, SOLUSDT: 200 },
  );
  assert.equal(filledExit.closedPosition?.symbol, 'ETHUSDT');
  assert.equal(filledExit.positions.filter(p => p.status === 'OPEN').length, 2);

  // Now fillSlots opens 1 position (ETH SHORT rank 1 beats XRP LONG rank 2)
  const afterExitSlots = fillSlots(filledExit.account, signals, {
    experimentStatus: 'RUNNING',
    decisionId: 'dec-1',
    decisionHour: H,
    now: CUTOFF + 36_000,
    rules: DEFAULT_RULES,
    positions: filledExit.positions,
    pendingOrders: [rec.exitOrders.find(o => o.symbol === 'SOLUSDT')!],
    stoppedThisHour: ['DOGEUSDT'],
    lastPrices: { BTCUSDT: 100_000, ETHUSDT: 3_100, SOLUSDT: 200 },
  });
  assert.equal(afterExitSlots.orders.length, 1);
  assert.equal(afterExitSlots.orders[0].symbol, 'ETHUSDT');
  assert.equal(afterExitSlots.orders[0].side, 'SHORT');

  // SPEC_LIMIT check (minNotional / maxQty / stepSize)
  const specRes = fillSlots(
    baseAccount('A', { cash: 10_000 }),
    [
      { symbol: 'TINYUSDT', side: 'LONG', sideRank: 1, refPrice: 100, closePrice1h: 100 },
      { symbol: 'XRPUSDT', side: 'LONG', sideRank: 2, refPrice: 1, closePrice1h: 1 },
    ],
    {
      experimentStatus: 'RUNNING',
      decisionId: 'dec-2',
      decisionHour: H,
      now: CUTOFF + 36_000,
      rules: {
        TINYUSDT: { stepSize: 100, minQty: 100, maxQty: 1000, minNotional: 50 }, // equity*0.2=2000 -> qty=20 -> floored 0 < minQty
        XRPUSDT: { stepSize: 1, minQty: 1, maxQty: 100_000, minNotional: 5_000 }, // 2000 < minNotional 5000
      },
      positions: [],
      pendingOrders: [],
      lastPrices: {},
    },
  );
  assert.equal(specRes.orders.length, 0);
  assert.deepEqual(specRes.skipped.map(s => s.reason), ['SPEC_LIMIT', 'SPEC_LIMIT']);

  // INSUFFICIENT_CASH with multi-order cash reservation
  const lowCashRes = fillSlots(
    baseAccount('A', { cash: 2_500, reserved: 7_500 }),
    [
      { symbol: 'ETHUSDT', side: 'LONG', sideRank: 1, refPrice: 2_000, closePrice1h: 2_000 }, // needs ~2002
      { symbol: 'SOLUSDT', side: 'LONG', sideRank: 2, refPrice: 100, closePrice1h: 100 }, // needs ~2002, only ~498 left
    ],
    {
      experimentStatus: 'RUNNING',
      decisionId: 'dec-3',
      decisionHour: H,
      now: CUTOFF + 36_000,
      rules: DEFAULT_RULES,
      positions: [],
      pendingOrders: [],
      lastPrices: {},
    },
  );
  assert.deepEqual(lowCashRes.orders.map(o => o.symbol), ['ETHUSDT']);
  assert.deepEqual(lowCashRes.skipped.map(s => `${s.symbol}:${s.reason}`), ['SOLUSDT:INSUFFICIENT_CASH']);

  // DEGRADED_MARKET, BANKRUPT, PAUSED block new entries
  const degradedRes = fillSlots(baseAccount('A', { degraded: true }), signals, {
    experimentStatus: 'RUNNING', decisionId: 'dec-4', decisionHour: H, now: CUTOFF, rules: DEFAULT_RULES, positions: [], pendingOrders: [], lastPrices: {},
  });
  assert.equal(degradedRes.orders.length, 0);
  assert.ok(degradedRes.skipped.every(s => s.reason === 'DEGRADED_MARKET'));

  const bankruptRes = fillSlots(baseAccount('A', { cash: 0, reserved: 0 }), signals, {
    experimentStatus: 'RUNNING', decisionId: 'dec-5', decisionHour: H, now: CUTOFF, rules: DEFAULT_RULES, positions: [], pendingOrders: [], lastPrices: {},
  });
  assert.equal(bankruptRes.bankrupt, true);
  assert.equal(bankruptRes.orders.length, 0);
  assert.ok(bankruptRes.skipped.every(s => s.reason === 'BANKRUPT'));

  const pausedRes = fillSlots(baseAccount('A'), signals, {
    experimentStatus: 'PAUSED', decisionId: 'dec-6', decisionHour: H, now: CUTOFF, rules: DEFAULT_RULES, positions: [], pendingOrders: [], lastPrices: {},
  });
  assert.equal(pausedRes.orders.length, 0);
});

test('accounting: exact step-by-step verification of entry, slippage, fee, funding, exit, valuation, stop-loss, and bankruptcy', () => {
  let account = baseAccount('A');
  let positions: PaperPosition[] = [];
  const fills: PaperFill[] = [];

  // Open LONG BTCUSDT: qty=0.2, rawPrice=10000
  // fill = 10000 * 1.0005 = 10005
  // reserved = 0.2 * 10005 = 2001
  // fee = 2001 * 0.0005 = 1.0005
  // cash = 10000 - 2001 - 1.0005 = 7997.9995
  const entryOrder: PaperOrder = {
    id: 'ord-1',
    experimentId: 'exp-1',
    account: 'A',
    decisionId: 'dec-1',
    symbol: 'BTCUSDT',
    side: 'LONG',
    action: 'ENTRY',
    reason: 'SIGNAL',
    qty: 0.2,
    refPrice: 10_000,
    createdAt: H + 1000,
    status: 'PENDING',
  };

  const entryRes = applyFill(
    account,
    positions,
    entryOrder,
    { symbol: 'BTCUSDT', price: 10_000, aggId: 1, tradeTime: H + 1300, receivedAt: H + 1300 },
    DEFAULT_MODEL_PAPER_CONFIG,
    H,
    { BTCUSDT: 10_000 },
  );
  account = entryRes.account;
  positions = entryRes.positions;
  fills.push(entryRes.fill!);

  assert.ok(Math.abs(entryRes.fill!.fillPrice - 10_005) < 1e-9);
  assert.ok(Math.abs(entryRes.fill!.fee - 1.0005) < 1e-9);
  assert.ok(Math.abs(entryRes.fill!.slippageCost - 1.0) < 1e-9); // |10005 - 10000| * 0.2 = 1
  assert.ok(Math.abs(account.reserved - 2_001) < 1e-9);
  assert.ok(Math.abs(account.cash - 7_997.9995) < 1e-9);
  assert.ok(Math.abs(entryRes.newPosition!.stopPrice - 10_005 * 0.98) < 1e-9);

  // Valuation at last=10_000: equity = 7997.9995 + 2001 + (10000 - 10005)*0.2 = 9997.9995
  const val1 = valuate(account, positions, { BTCUSDT: 10_000 });
  assert.ok(Math.abs(val1.unrealized - (-1.0)) < 1e-9);
  assert.ok(Math.abs(val1.equity - 9_997.9995) < 1e-9);

  // Stop check: LONG entry=10005 -> stop=9804.9
  assert.equal(checkStop(positions[0], 9804.91), false);
  assert.equal(checkStop(positions[0], 9804.9), true);

  // Funding charge: fundingRate = +0.0001, markPrice = 10500, qty = 0.2, LONG => amount = +0.21
  const fundRes = applyFunding(
    account,
    positions,
    fills,
    [],
    [
      { symbol: 'BTCUSDT', fundingTime: H + 2000, fundingRate: 0.0001, markPrice: 10_500 },
      // Duplicate / earlier than entry must be ignored
      { symbol: 'BTCUSDT', fundingTime: H + 1200, fundingRate: 0.01, markPrice: 10_500 },
    ],
    [{ startedAt: H + 1500, endedAt: H + 2500 }],
    H + 2500,
  );
  account = fundRes.account;
  assert.equal(fundRes.charges.length, 1);
  assert.equal(fundRes.charges[0].duringGap, true);
  assert.ok(Math.abs(fundRes.charges[0].amount - 0.21) < 1e-9);
  assert.ok(Math.abs(account.cash - (7_997.9995 - 0.21)) < 1e-9);
  assert.ok(Math.abs(account.funding - 0.21) < 1e-9);

  // Idempotent re-apply of same funding record
  const fundDup = applyFunding(
    account,
    positions,
    fills,
    fundRes.charges,
    [{ symbol: 'BTCUSDT', fundingTime: H + 2000, fundingRate: 0.0001, markPrice: 10_500 }],
  );
  assert.equal(fundDup.charges.length, 0);

  // Close LONG at rawPrice = 11_000 -> exitFill = 11000 * 0.9995 = 10994.5
  // pnl = (10994.5 - 10005) * 0.2 = 197.9
  // exitFee = 0.2 * 10994.5 * 0.0005 = 1.09945
  // cash += 2001 + 197.9 - 1.09945 = 7997.7895 + 2197.80055 = 10195.59005
  const exitOrder: PaperOrder = {
    id: 'ord-2',
    experimentId: 'exp-1',
    account: 'A',
    decisionId: 'dec-2',
    symbol: 'BTCUSDT',
    side: 'LONG',
    action: 'EXIT',
    reason: 'SIGNAL_GONE',
    qty: 0.2,
    refPrice: 11_000,
    createdAt: H + 3000,
    status: 'PENDING',
    positionId: positions[0].id,
  };

  const exitRes = applyFill(
    account,
    positions,
    exitOrder,
    { symbol: 'BTCUSDT', price: 11_000, aggId: 2, tradeTime: H + 3300, receivedAt: H + 3300 },
    DEFAULT_MODEL_PAPER_CONFIG,
    H,
  );
  account = exitRes.account;
  positions = exitRes.positions;
  fills.push(exitRes.fill!);

  assert.equal(account.reserved, 0);
  assert.ok(Math.abs(exitRes.fill!.fillPrice - 10_994.5) < 1e-9);
  assert.ok(Math.abs(exitRes.fill!.realizedPnl - 197.9) < 1e-9);
  assert.ok(Math.abs(exitRes.fill!.fee - 1.09945) < 1e-9);
  assert.ok(Math.abs(account.cash - 10_195.59005) < 1e-9);
  assert.ok(Math.abs(account.realizedPnl - 197.9) < 1e-9);
  assert.ok(Math.abs(account.fees - (1.0005 + 1.09945)) < 1e-9);

  // Identity check: cash === initialCash + realizedPnl - fees - funding
  const expectedCash = 10_000 + account.realizedPnl - account.fees - account.funding;
  assert.ok(Math.abs(account.cash - expectedCash) < 1e-9);

  // Metrics & Comparability check
  const equityCurve: EquityPoint[] = [
    { experimentId: 'exp-1', account: 'A', ts: H, equity: 10_000, cash: 10_000, reserved: 0, unrealized: 0, complete: true },
    { experimentId: 'exp-1', account: 'A', ts: H + 1500, equity: 9_800, cash: account.cash, reserved: 2001, unrealized: -200, complete: true },
    { experimentId: 'exp-1', account: 'A', ts: H + 3300, equity: account.cash, cash: account.cash, reserved: 0, unrealized: 0, complete: true },
  ];
  const gaps: ModelPaperGap[] = [
    { id: 'g1', experimentId: 'exp-1', account: 'A', kind: 'STALE', startedAt: H + 1000, endedAt: H + 2000 },
    { id: 'g2', experimentId: 'exp-1', account: 'BOTH', kind: 'RESTART', startedAt: H + 1500, endedAt: H + 2500 },
  ];
  const decisions: ModelPaperDecisionRecord[] = [
    {
      id: 'd1',
      experimentId: 'exp-1',
      modelKey: 'chronos2',
      decisionHour: H,
      status: 'SUBMITTED',
      attempts: 1,
      signals: {
        signalsA: [],
        signalsB: [],
        skippedA: [{ account: 'A', symbol: 'ETHUSDT', side: 'LONG', reason: 'BELOW_THRESHOLD' }],
        skippedB: [],
      },
      createdAt: H,
    },
  ];
  const metrics = computeAccountMetrics({
    account,
    config: DEFAULT_MODEL_PAPER_CONFIG,
    positions,
    orders: [entryOrder, exitOrder],
    fills,
    fundingCharges: fundRes.charges,
    equityCurve,
    decisions,
    gaps,
    lastPrices: {},
    startedAt: H,
    now: H + 5_000,
  });

  assert.equal(metrics.completedTrades, 1);
  assert.equal(metrics.winRatePct, 100);
  assert.ok(Math.abs(metrics.maxDrawdown - 200) < 1e-9);
  assert.ok(Math.abs(metrics.maxDrawdownPct - 2) < 1e-9);
  assert.equal(metrics.gapDurationMs, 1_500); // merged [1000, 2500]
  assert.equal(metrics.effectiveObservationMs, 3_500); // 5000 - 1500
  assert.equal(metrics.skipReasonCounts.BELOW_THRESHOLD, 1);

  const cmp = evaluateComparability(account, baseAccount('B'), gaps, [], []);
  assert.equal(cmp.comparable, false); // A has gap g1 while B doesn't
});

test('accounting SHORT + stop-loss + bankruptcy + comparability edge cases', () => {
  let accB = baseAccount('B', { cash: 100, reserved: 0 });
  const shortOrder: PaperOrder = {
    id: 'ord-short-1',
    experimentId: 'exp-1',
    account: 'B',
    decisionId: 'dec-s',
    symbol: 'ETHUSDT',
    side: 'SHORT',
    action: 'ENTRY',
    reason: 'SIGNAL',
    qty: 0.1,
    refPrice: 500,
    createdAt: H + 1000,
    status: 'PENDING',
  };
  // SHORT entry at raw=500 -> fill = 500 * 0.9995 = 499.75; reserved = 49.975; fee = 0.0249875
  const ent = applyFill(accB, [], shortOrder, { symbol: 'ETHUSDT', price: 500, aggId: 10, tradeTime: H + 1300, receivedAt: H + 1300 }, DEFAULT_MODEL_PAPER_CONFIG, H);
  accB = ent.account;
  assert.ok(Math.abs(ent.fill!.fillPrice - 499.75) < 1e-9);
  assert.ok(Math.abs(ent.newPosition!.stopPrice - 499.75 * 1.02) < 1e-9);
  assert.equal(checkStop(ent.newPosition!, 499.75 * 1.02 - 0.01), false);
  assert.equal(checkStop(ent.newPosition!, 499.75 * 1.02), true);

  // SHORT receives positive funding rate
  const fund = applyFunding(accB, ent.positions, [ent.fill!], [], [{ symbol: 'ETHUSDT', fundingTime: H + 2000, fundingRate: 0.001, markPrice: 500 }]);
  accB = fund.account;
  // dir = -1 => amount = -0.1 * 500 * 0.001 = -0.05 => cash increases by +0.05
  assert.ok(Math.abs(fund.charges[0].amount - (-0.05)) < 1e-9);
  assert.ok(Math.abs(accB.cash - (100 - 49.975 - 0.0249875 + 0.05)) < 1e-9);

  // Massive adverse move triggers bankruptcy on exit (rawPrice = 2000 => exitFill = 2001)
  const exitShort: PaperOrder = {
    id: 'ord-short-exit',
    experimentId: 'exp-1',
    account: 'B',
    decisionId: 'dec-s2',
    symbol: 'ETHUSDT',
    side: 'SHORT',
    action: 'EXIT',
    reason: 'STOP_LOSS',
    qty: 0.1,
    refPrice: 2_000,
    createdAt: H + 3000,
    status: 'PENDING',
    positionId: ent.newPosition!.id,
  };
  const exited = applyFill(accB, ent.positions, exitShort, { symbol: 'ETHUSDT', price: 2_000, aggId: 11, tradeTime: H + 3300, receivedAt: H + 3300 });
  assert.equal(exited.bankrupt, true);
  assert.equal(exited.account.bankrupt, true);
  assert.ok(exited.valuation.equity <= 0);

  // Comparability: identical BOTH gap and no failures and no fundingPending -> comparable=true
  const sharedGap: ModelPaperGap[] = [{ id: 'g-both', experimentId: 'exp-1', account: 'BOTH', kind: 'RESTART', startedAt: H, endedAt: H + 1000 }];
  assert.equal(evaluateComparability(baseAccount('A'), baseAccount('B'), sharedGap, [], []).comparable, true);
  // Funding pending -> comparable=false
  assert.equal(evaluateComparability(baseAccount('A', { fundingPending: true }), baseAccount('B'), sharedGap, [], []).comparable, false);
  // Different EXECUTION_FAILED orders -> comparable=false
  const failOrd: PaperOrder = { ...shortOrder, status: 'CANCELLED', cancelReason: 'EXECUTION_FAILED' };
  assert.equal(evaluateComparability(baseAccount('A'), baseAccount('B'), sharedGap, [], [failOrd]).comparable, false);
});
