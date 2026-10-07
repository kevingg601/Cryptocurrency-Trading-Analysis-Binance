# Conservative Follow Plan QA

Date: 2026-10-07

## Scope And Rules

- Public market-data observation only. No automatic, paper or real orders are created by this feature.
- Pump -> long; futures dump -> short; spot dump -> risk message only.
- Origin/trigger prices and observation levels are fixed per wave. Observation is 38.2% retracement; initial zone is 25%-50%.
- Recovery of 10% of the wave must hold for three seconds in both exchange event time and local receive time, completed by a new aggregate trade.
- Deeper-than-50% retracements cannot start confirmation until returning to the allowed band. Less-than-15% retracement is marked missed instead of chased.
- Stop/invalidation is 10% of the wave outside its origin. Confirmation locks reference price and 1.5R/2R targets. TP1 does not move the stop.
- Entry wait: three minutes. Exit observation: fifteen minutes. Expiration is not an actual close.
- Five-second missing-trade detection resets confirmation. Buffered old data and slow ticker/REST snapshots cannot confirm entry.
- Same-direction upgrades retain anchors; opposite alerts replace active plans. A simultaneous stop touch is retained before processing a reversal.
- Fifty plans maximum, in memory only. Market switches/restarts clear plans; symbol switches retain them. Clearing alert records does not cancel plans.

## Automated Checks

- `npm test`: 50 passed, 0 failed. Includes 19 follow-plan tests and all 31 prior alert, candle, order-safety and backtest tests.
- Coverage: symmetric directions, origin metadata, triggering-trade freshness, malformed/legacy input, confirmation timing/reset, deep pullbacks, stale and buffered trades, duplicate/out-of-order updates, stop/missed conditions, same/opposite waves, spot reversal, TP1/TP2 gaps, stop after TP1, simultaneous reversal/exit, expiration and bounded immutable snapshots.
- Targeted ESLint for followPlans, followPlanLines, marketAlerts, useMarketAlerts, FollowPlanSummary, MarketAlertCenter and ChartContainer: passed. Repository-wide lint is not claimed clean.
- Final `npm run build`: passed. QA HTML/TSX fixtures are not entrypoints in the production build and are not included in ASAR.
- The original detector publishes on the threshold-crossing event. Follow-plan calculation uses existing data synchronously, with no new REST requests, waiting period or K-line dependency on the original alert path.

## Browser Verification

- Replay fixture: `/tests/fixtures/follow-plan.html`; uses the real tracker, summary, alert-center components and shared chart price-line definitions. Its candles are synthetic; it does not claim to reproduce a real historical trade.
- Long replay confirmed at 101.30, with stop 99.80, TP1 103.55 and TP2 104.30. Prior estimated targets changed once on confirmation and then locked.
- Short replay confirmed at 98.70, with stop 100.20, TP1 96.45 and TP2 95.70.
- Confirm/TP1/TP2 records and TP1-then-stop records were visible in the alert center. Each event appeared once.
- Delay replay showed paused confirmation, then required a new full hold after data resumed.
- Tab ArrowRight navigation and Escape-close verified. Native disclosure and buttons support keyboard activation.
- Live public futures workbench loaded 525 pairs, rendered its chart, and continued receiving trade and whale alerts. No real-market pump was required for deterministic replay validation.
- Mobile live watchlist drawer opened, search selected ETH, drawer closed and chart symbol switched.
- Light theme and short-plan center were checked in a 390 x 844 iframe. Document clientWidth and scrollWidth both equaled 390.
- Live workbench iframe widths 1366, 1440, 1920 and 390 had no horizontal document overflow. The same chart resized: at 1440, main canvas width 724 plus price-axis width 70; at 1920, main canvas width 1204 plus price-axis width 70 matched a 1274px chart host.
- The browser viewport override did not affect its actual 1280 x 720 top-level viewport. Fixed-size same-origin iframe fixtures were used for responsive verification, not claimed as top-level browser resizing or a physical mobile-device test.
- The local development server stopped during verification and was relaunched on 127.0.0.1:5173. Subsequent checks used the restarted server.
- Desktop OS notification permission was not requested; OS delivery/sound were not exercised. Existing notification permission and tone infrastructure is reused.

Screenshots: `confirmed-desktop.jpg`, `mobile-light.jpg`, `mobile-plan-center.jpg`, `live-desktop-1366.jpg`.

## Packaging

- Desktop ZIP: `dist-desktop/AntigravityCrypto-20261007-follow-plans.zip`.
- Existing Electron runtime reused with freshly built application assets; prior order-safety and realtime ZIPs preserved.
- All 10 staged application files compared to final ASAR with SHA-256. ZIP executable/ASAR entries and embedded ASAR hash verified after compression.
- Packaged Electron UI was not separately launched during this change; rendering and interaction verification used the browser build.

## Financial And Operational Limits

These heuristic ratios have not been validated for profitability, low risk or improved win rate. Reference prices are not guaranteed exchange execution prices. No simulated holdings, position sizes, fees, funding, liquidity or slippage are inferred. A touched observation level is not realized PnL. Network, operating-system and sleep restrictions can delay notifications; no unconditional end-to-end latency guarantee is made.
