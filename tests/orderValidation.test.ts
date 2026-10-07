import test from 'node:test';
import assert from 'node:assert/strict';
import { describeEntry, validatePaperOrder, validateProtection, paperLimitFillPrice } from '../src/services/orderValidation.ts';
import { deriveSuggestedTradeLevels } from '../src/services/tradeLevels.ts';

const screenshot = {
  rsi: 28.43, sma20: 0.03476, ema50: 0.03458,
  bb: { lower: 0.03375, middle: 0.03476, upper: 0.03577 },
  macd: { macd: -0.0002, signal: -0.0001, histogram: -0.0001 },
};

test('screenshot: entries above market are reclaim observations, not buy limits', () => {
  const levels = deriveSuggestedTradeLevels(0.03286, screenshot)!;
  assert.equal(levels.side, 'LONG');
  assert.equal(levels.conservativeEntry, 0.03375);
  assert.equal(levels.conservativePlan.mode, 'WAIT_CONFIRMATION');
  assert.equal(levels.aggressivePlan.mode, 'WAIT_CONFIRMATION');
  assert.ok(levels.stopLoss > 0.03286);
  assert.equal(levels.marketPlanValid, false);
  assert.match(levels.marketPlanIssue!, /止損/);
  assert.match(validatePaperOrder('LONG', 'LIMIT', 0.03375, 0.03286)!, /立即成交/);
});

test('short observations below market must wait for a breakdown', () => {
  const levels = deriveSuggestedTradeLevels(0.037, {
    ...screenshot, rsi: 80, sma20: 0.03476, ema50: 0.035,
  })!;
  assert.equal(levels.side, 'SHORT');
  assert.equal(levels.conservativePlan.mode, 'WAIT_CONFIRMATION');
  assert.equal(levels.aggressivePlan.mode, 'WAIT_CONFIRMATION');
  assert.equal(levels.marketPlanValid, false);
});

test('passive entries are classified symmetrically and equal prices are not passive', () => {
  assert.equal(describeEntry('LONG', 99, 100).mode, 'LIMIT');
  assert.equal(describeEntry('SHORT', 101, 100).mode, 'LIMIT');
  assert.equal(describeEntry('LONG', 101, 100).mode, 'WAIT_CONFIRMATION');
  assert.equal(describeEntry('SHORT', 99, 100).mode, 'WAIT_CONFIRMATION');
  for (const side of ['LONG', 'SHORT'] as const) {
    assert.equal(describeEntry(side, 100, 100).mode, 'MARKETABLE');
    assert.notEqual(validatePaperOrder(side, 'LIMIT', 100, 100), null);
  }
});

test('only valid passive limits are accepted', () => {
  assert.equal(validatePaperOrder('LONG', 'LIMIT', 99, 100, 105, 95), null);
  assert.equal(validatePaperOrder('SHORT', 'LIMIT', 101, 100, 95, 105), null);
  assert.notEqual(validatePaperOrder('LONG', 'LIMIT', 101, 100, 105, 95), null);
  assert.notEqual(validatePaperOrder('SHORT', 'LIMIT', 99, 100, 95, 105), null);
});

test('market protection is validated against the fresh quote, not the old requested price', () => {
  assert.equal(validatePaperOrder('LONG', 'MARKET', 100, 100, 110, 95), null);
  assert.match(validatePaperOrder('LONG', 'MARKET', 100, 94, 110, 95)!, /止損/);
  assert.match(validatePaperOrder('SHORT', 'MARKET', 100, 106, 90, 105)!, /止損/);
  assert.match(validatePaperOrder('LONG', 'MARKET', 100, 111, 110, 95)!, /止盈/);
});

test('protection is strictly on the correct side of entry', () => {
  for (const side of ['LONG', 'SHORT'] as const) {
    assert.notEqual(validateProtection(side, 100, 100), null);
    assert.notEqual(validateProtection(side, 100, undefined, 100), null);
    assert.equal(validateProtection(side, 100), null);
  }
});

test('missing or malformed prices and protection cannot be submitted', () => {
  for (const invalid of [0, -1, NaN, Infinity]) {
    assert.notEqual(validatePaperOrder('LONG', 'MARKET', 100, invalid), null);
    assert.notEqual(validatePaperOrder('LONG', 'LIMIT', invalid, 100), null);
    assert.notEqual(validateProtection('LONG', 100, invalid), null);
    assert.notEqual(validateProtection('SHORT', 100, undefined, invalid), null);
    assert.equal(paperLimitFillPrice('LONG', 100, invalid), null);
  }
});

test('paper limits fill at the observed better price after a gap, not the requested limit', () => {
  assert.equal(paperLimitFillPrice('LONG', 100, 98), 98);
  assert.equal(paperLimitFillPrice('SHORT', 100, 102), 102);
  assert.equal(paperLimitFillPrice('LONG', 100, 101), null);
  assert.equal(paperLimitFillPrice('SHORT', 100, 99), null);
  assert.equal(paperLimitFillPrice('LONG', 100, 100), 100);
});

test('impossible targets and malformed bands do not produce a trading plan', () => {
  assert.equal(deriveSuggestedTradeLevels(70, {
    ...screenshot, rsi: 80, bb: { lower: 80, middle: 100, upper: 120 },
  }), null);
  assert.equal(deriveSuggestedTradeLevels(0, screenshot), null);
  assert.equal(deriveSuggestedTradeLevels(0.03286, { ...screenshot, bb: { lower: 1, middle: 0.5, upper: 2 } }), null);
});
