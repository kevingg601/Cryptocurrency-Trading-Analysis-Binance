import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateTargetMilestones,
  calculateTrackPosition,
  evaluateTargetProgress,
  deriveAutomaticTargetSetup,
  INITIAL_SCREENSHOT_TARGET_SETUPS,
  TARGET_TRACK_ANCHORS,
} from '../src/orders/targetDashboard.ts';

describe('targetDashboard: target milestone levels and progress tracking', () => {
  it('reproduces the exact screenshot levels for XRP, ETH, SOL, HYPE', () => {
    // 1. XRP
    const xrp = calculateTargetMilestones('SHORT', 1.2445, 1.2722)!;
    assert.ok(xrp !== null);
    assert.equal(xrp.slDistancePercent.toFixed(2), '2.23');
    assert.equal(xrp.tp1.toFixed(4), '1.2168');
    assert.equal(xrp.tp2.toFixed(4), '1.1891');
    assert.equal(xrp.tp3.toFixed(4), '1.1060');
    assert.equal(xrp.ftp.toFixed(4), '0.9675');

    // 2. HYPE
    const hype = calculateTargetMilestones('SHORT', 78.464, 80.7346)!;
    assert.ok(hype !== null);
    assert.equal(hype.slDistancePercent.toFixed(2), '2.89');
    assert.equal(hype.tp1.toFixed(4), '76.1934');
    assert.equal(hype.tp2.toFixed(4), '73.9228');
    assert.equal(hype.tp3.toFixed(4), '67.1110');
    assert.equal(hype.ftp.toFixed(4), '55.7580');

    // 3. ETH
    const eth = calculateTargetMilestones('SHORT', 2250.12, 2302.78)!;
    assert.ok(eth !== null);
    assert.equal(eth.slDistancePercent.toFixed(2), '2.34');
    assert.equal(eth.tp1.toFixed(2), '2197.46');
    assert.equal(eth.tp2.toFixed(2), '2144.80');
    assert.equal(eth.tp3.toFixed(2), '1986.82');
    assert.equal(eth.ftp.toFixed(2), '1723.52');

    // 4. SOL
    const sol = calculateTargetMilestones('SHORT', 90.15, 92.5997)!;
    assert.ok(sol !== null);
    assert.equal(sol.slDistancePercent.toFixed(2), '2.72');
    assert.equal(sol.tp1.toFixed(4), '87.7003');
    assert.equal(sol.tp2.toFixed(4), '85.2506');
    assert.equal(sol.tp3.toFixed(4), '77.9015');
    assert.equal(sol.ftp.toFixed(4), '65.6530');
  });

  it('calculates LONG milestones symmetrically', () => {
    const long = calculateTargetMilestones('LONG', 100, 98)!;
    assert.ok(long !== null);
    assert.equal(long.risk, 2);
    assert.equal(long.slDistancePercent, 2);
    assert.equal(long.tp1, 102);
    assert.equal(long.tp2, 104);
    assert.equal(long.tp3, 110);
    assert.equal(long.ftp, 120);
  });

  it('rejects invalid or inverted price inputs', () => {
    assert.equal(calculateTargetMilestones('SHORT', -10, 20), null);
    assert.equal(calculateTargetMilestones('SHORT', 10, 0), null);
    assert.equal(calculateTargetMilestones('SHORT', 10, Number.NaN), null);
    // Inverted: for SHORT, SL must be > Entry
    assert.equal(calculateTargetMilestones('SHORT', 100, 90), null);
    // Inverted: for LONG, SL must be < Entry
    assert.equal(calculateTargetMilestones('LONG', 100, 110), null);
    // Equal prices
    assert.equal(calculateTargetMilestones('SHORT', 100, 100), null);
  });

  it('calculates track positions corresponding to milestones and intermediate prices', () => {
    const xrpSetup = INITIAL_SCREENSHOT_TARGET_SETUPS.XRPUSDT;
    
    // Exactly at SL
    assert.equal(calculateTrackPosition(xrpSetup, xrpSetup.stopLoss), TARGET_TRACK_ANCHORS.SL);
    // Exactly at Entry
    assert.equal(calculateTrackPosition(xrpSetup, xrpSetup.entryPrice), TARGET_TRACK_ANCHORS.ENTRY);
    // Exactly at TP1
    assert.equal(calculateTrackPosition(xrpSetup, xrpSetup.tp1), TARGET_TRACK_ANCHORS.TP1);
    // Exactly at TP2
    assert.equal(calculateTrackPosition(xrpSetup, xrpSetup.tp2), TARGET_TRACK_ANCHORS.TP2);
    // Exactly at TP3
    assert.equal(calculateTrackPosition(xrpSetup, xrpSetup.tp3), TARGET_TRACK_ANCHORS.TP3);
    // Exactly at FTP
    assert.equal(calculateTrackPosition(xrpSetup, xrpSetup.ftp), TARGET_TRACK_ANCHORS.FTP);

    // XRP live price 1.1129 (between TP2 1.1890 and TP3 1.1058, closer to TP3)
    const xrpPos = calculateTrackPosition(xrpSetup, 1.1129);
    assert.ok(xrpPos > TARGET_TRACK_ANCHORS.TP2 && xrpPos < TARGET_TRACK_ANCHORS.TP3);
    assert.ok(Math.abs(xrpPos - 73.3) < 1.0);

    // HYPE live price 74.361 (between TP1 76.1934 and TP2 73.9229)
    const hypeSetup = INITIAL_SCREENSHOT_TARGET_SETUPS.HYPEUSDT;
    const hypePos = calculateTrackPosition(hypeSetup, 74.361);
    assert.ok(hypePos > TARGET_TRACK_ANCHORS.TP1 && hypePos < TARGET_TRACK_ANCHORS.TP2);
    assert.ok(Math.abs(hypePos - 51.7) < 1.0);
  });

  it('evaluates progress and returns correct status, PnL and milestone checks matching screenshot', () => {
    // 1. XRP: Achieved TP3 (+11.15%), retraced to 1.1129
    const xrpSetup = INITIAL_SCREENSHOT_TARGET_SETUPS.XRPUSDT;
    const xrpProgress = evaluateTargetProgress(xrpSetup, 1.1129, {
      achievedMilestone: xrpSetup.achievedMilestone,
    });
    assert.equal(xrpProgress.tp1Reached, true);
    assert.equal(xrpProgress.tp2Reached, true);
    assert.equal(xrpProgress.tp3Reached, true);
    assert.equal(xrpProgress.ftpReached, false);
    assert.equal(xrpProgress.stoppedOut, false);
    assert.equal(xrpProgress.inProfit, true);
    assert.equal(xrpProgress.maxPnlPercent.toFixed(2), '11.15'); // Matches screenshot +11.15%!
    assert.equal(xrpProgress.statusLabel, 'TP3 達成，持倉中 | 現價');
    assert.equal(xrpProgress.priceDisplay, '1.1129');

    // 2. HYPE: Achieved TP2 (+5.79%), retraced to 74.361
    const hypeSetup = INITIAL_SCREENSHOT_TARGET_SETUPS.HYPEUSDT;
    const hypeProgress = evaluateTargetProgress(hypeSetup, 74.361, {
      achievedMilestone: hypeSetup.achievedMilestone,
    });
    assert.equal(hypeProgress.maxPnlPercent.toFixed(2), '5.79'); // Matches screenshot +5.79%!
    assert.equal(hypeProgress.statusLabel, 'TP2 達成，持倉中 | 現價');
    assert.equal(hypeProgress.priceDisplay, '74.361');

    // 3. ETH: Achieved TP2, price extended to 2133.49 (+5.18%)
    const ethSetup = INITIAL_SCREENSHOT_TARGET_SETUPS.ETHUSDT;
    const ethProgress = evaluateTargetProgress(ethSetup, 2133.49, {
      achievedMilestone: ethSetup.achievedMilestone,
    });
    assert.equal(ethProgress.maxPnlPercent.toFixed(2), '5.18'); // Matches screenshot +5.18%!
    assert.equal(ethProgress.statusLabel, 'TP2 達成，持倉中 | 現價');
    assert.equal(ethProgress.priceDisplay, '2,133.49');

    // 4. SOL: Achieved TP2 (+5.43%), retraced to 87.385
    const solSetup = INITIAL_SCREENSHOT_TARGET_SETUPS.SOLUSDT;
    const solProgress = evaluateTargetProgress(solSetup, 87.385, {
      achievedMilestone: solSetup.achievedMilestone,
    });
    assert.equal(solProgress.maxPnlPercent.toFixed(2), '5.43'); // Matches screenshot +5.43%!
    assert.equal(solProgress.statusLabel, 'TP2 達成，持倉中 | 現價');
    assert.equal(solProgress.priceDisplay, '87.385');

    // Test stopped out
    const stopped = evaluateTargetProgress(xrpSetup, 1.2800);
    assert.equal(stopped.stoppedOut, true);
    assert.ok(stopped.statusText.includes('止損觸發'));

    // Test FTP reached
    const fullProfit = evaluateTargetProgress(xrpSetup, 0.9500);
    assert.equal(fullProfit.ftpReached, true);
    assert.ok(fullProfit.statusText.includes('FTP 達成，持倉中'));
  });

  it('formats target prices without unnecessary trailing zeros and with thousands separators', async () => {
    const { formatTargetPrice, formatCardTimestamp } = await import('../src/orders/targetDashboard.ts');
    assert.equal(formatTargetPrice(90.15), '90.15');
    assert.equal(formatTargetPrice(1.189), '1.189');
    assert.equal(formatTargetPrice(0.967), '0.967');
    assert.equal(formatTargetPrice(2144.8), '2,144.8');
    assert.equal(formatTargetPrice(1723.5), '1,723.5');
    assert.equal(formatTargetPrice(2302.78), '2,302.78');
    assert.equal(formatTargetPrice(74.361), '74.361');

    assert.equal(formatCardTimestamp(1730851200000, '11/06 00:00'), '11/06 00:00');
  });

  it('derives automatic target setup for any arbitrary market price', () => {
    const setup = deriveAutomaticTargetSetup('BTCUSDT', 'BTC', 'Bitcoin', 65000, 'LONG', 2.0);
    assert.ok(setup !== null);
    assert.equal(setup.symbol, 'BTCUSDT');
    assert.equal(setup.side, 'LONG');
    assert.equal(setup.entryPrice, 65000);
    assert.equal(setup.stopLoss, 63700);
    assert.equal(setup.tp1, 66300);
    assert.equal(setup.tp2, 67600);
    assert.equal(setup.tp3, 71500);
    assert.equal(setup.ftp, 78000);
  });
});
