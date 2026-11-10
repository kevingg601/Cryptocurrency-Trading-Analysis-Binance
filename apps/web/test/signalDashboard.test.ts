import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateTargetMilestones,
  calculateTrackPosition,
  evaluateTargetProgress,
  deriveAutomaticTargetSetup,
  INITIAL_SCREENSHOT_TARGET_SETUPS,
  MAINSTREAM_SYMBOLS,
} from '@fadachi/core';

test('SignalTargetDashboard: mainstream setup configurations and screenshot parity', () => {
  // Check mainstream symbols list
  assert.ok(MAINSTREAM_SYMBOLS.includes('BTCUSDT'));
  assert.ok(MAINSTREAM_SYMBOLS.includes('ETHUSDT'));
  assert.ok(MAINSTREAM_SYMBOLS.includes('SOLUSDT'));
  assert.ok(MAINSTREAM_SYMBOLS.includes('XRPUSDT'));

  const xrpLevels = calculateTargetMilestones('SHORT', 1.2445, 1.2722);
  assert.ok(xrpLevels !== null);
  assert.equal(xrpLevels.slDistancePercent.toFixed(2), '2.23');

  // Check screenshot cards initial setup presence
  for (const sym of ['XRPUSDT', 'HYPEUSDT', 'ETHUSDT', 'SOLUSDT']) {
    const setup = INITIAL_SCREENSHOT_TARGET_SETUPS[sym];
    assert.ok(setup, `Setup for ${sym} must exist`);
    assert.equal(setup.side, 'SHORT');
    assert.ok(setup.entryPrice > 0);
    assert.ok(setup.stopLoss > setup.entryPrice);
    assert.ok(setup.tp1 < setup.entryPrice);
    assert.ok(setup.tp2 < setup.tp1);
    assert.ok(setup.tp3 < setup.tp2);
    assert.ok(setup.ftp < setup.tp3);
  }
});

test('SignalTargetDashboard: progress calculation preserves reached milestones and computes correct ROI matching screenshot', () => {
  const xrp = INITIAL_SCREENSHOT_TARGET_SETUPS.XRPUSDT;
  
  // Test evaluation at current screenshot price 1.1129
  const result = evaluateTargetProgress(xrp, 1.1129, {
    achievedMilestone: xrp.achievedMilestone,
  });

  assert.equal(result.tp1Reached, true);
  assert.equal(result.tp2Reached, true);
  assert.equal(result.tp3Reached, true);
  assert.equal(result.ftpReached, false);
  assert.equal(result.stoppedOut, false);
  assert.equal(result.maxPnlPercent.toFixed(2), '11.15'); // Matches screenshot +11.15%!
  assert.equal(result.statusLabel, 'TP3 達成，持倉中 | 現價');
  assert.equal(result.priceDisplay, '1.1129');

  // Track position should be positioned between TP2 and TP3
  assert.ok(result.positionPercent > 55 && result.positionPercent < 75);

  // Parity tests for HYPE, ETH, SOL
  const hype = evaluateTargetProgress(INITIAL_SCREENSHOT_TARGET_SETUPS.HYPEUSDT, 74.361, {
    achievedMilestone: 'TP2',
  });
  assert.equal(hype.maxPnlPercent.toFixed(2), '5.79'); // Matches screenshot +5.79%!
  assert.equal(hype.priceDisplay, '74.361');

  const eth = evaluateTargetProgress(INITIAL_SCREENSHOT_TARGET_SETUPS.ETHUSDT, 2133.49, {
    achievedMilestone: 'TP2',
  });
  assert.equal(eth.maxPnlPercent.toFixed(2), '5.18'); // Matches screenshot +5.18%!
  assert.equal(eth.priceDisplay, '2,133.49');

  const sol = evaluateTargetProgress(INITIAL_SCREENSHOT_TARGET_SETUPS.SOLUSDT, 87.385, {
    achievedMilestone: 'TP2',
  });
  assert.equal(sol.maxPnlPercent.toFixed(2), '5.43'); // Matches screenshot +5.43%!
  assert.equal(sol.priceDisplay, '87.385');
});

test('SignalTargetDashboard: automatic setup generation for user watchlist coins', () => {
  const customCoin = deriveAutomaticTargetSetup('PEPEUSDT', 'PEPE', 'Pepe', 0.00001, 'LONG', 3.0);
  assert.ok(customCoin !== null);
  assert.equal(customCoin.side, 'LONG');
  assert.ok(customCoin.stopLoss < customCoin.entryPrice);
  assert.ok(customCoin.tp1 > customCoin.entryPrice);

  const pos = calculateTrackPosition(customCoin, customCoin.tp1);
  assert.equal(pos, 38); // TP1 anchor is 38%
});
