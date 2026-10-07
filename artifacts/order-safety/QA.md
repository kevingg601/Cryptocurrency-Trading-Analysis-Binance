# Entry And Order Safety QA

Date: 2026-10-07

## Root Cause

- Bollinger band observation levels were presented as directly executable limit entries even when they were on the marketable side of the current price.
- Market entry could inherit protection levels whose stop was already beyond the current price.
- Market fills used a modal snapshot; pending limit fills always used the requested limit instead of the observed crossing price.

## Changes

- Explicit passive-limit, reclaim/breakdown-confirmation and marketable classifications.
- Conditional TP/SL labels and disabled unsuitable quick-order actions.
- Modal and submission validation, with market protection checked against the latest quote.
- No stop/trigger entry order implementation; unsupported entry intentions are blocked explicitly.
- Paper gap fills use the observed crossing quote. This is not an order-book execution model.
- Reject impossible nonpositive targets and malformed bands.

## Automated Verification

- `npm test`: 31 passed, 0 failed, including nine new order-safety tests.
- Exact screenshot regression: market 0.03286; lower band 0.03375; middle 0.03476; stop 0.03324375. Both entries require reclaim confirmation; current-market protection is invalid.
- Mirrored short case, equal-price limits, invalid numeric values, stale market protection and better-price limit fills covered.
- `npm run build`: passed.
- Targeted ESLint on orderValidation, tradeLevels, TradingModal, SignalAdvisor and ChartContainer: passed. This is not a claim that repository-wide lint is clean.

## Browser Verification

Live public futures data at `http://127.0.0.1:5173/`, PARTI selected:

- Buy limit 0.1 with market around 0.033: immediate-fill explanation shown and submit disabled.
- Passive buy limit 0.02: submit enabled with valid protection.
- Short limit 0.02: submit disabled; passive short limit 0.05: enabled.
- Market long stop 0.1 above current quote: submit disabled with stop-direction explanation.
- Observation preset above live market became disabled and displayed pending confirmation.
- Screenshot: `blocked-buy-limit.jpg` shows the top-of-dialog explanation.
- No paper or real orders submitted. No exchange credentials used.
- Live price moved since the user's screenshot; exact historical values are covered by unit tests, not injected into the live UI.

## Packaging

Reuses the previously bundled Electron runtime with freshly built application assets. ASAR contents are compared to staging using SHA-256. Previous desktop ZIP remains unchanged.

## Limits

No real exchange execution, order-book liquidity/slippage model or guarantee of profitability. Observation and protection validity do not establish strategy quality. This patch does not change alert, backtest or strategy scoring logic.
