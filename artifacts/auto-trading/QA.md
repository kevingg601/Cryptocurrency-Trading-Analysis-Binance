# Conservative Follow Paper Auto Trading QA

Date: 2026-10-07 (Asia/Taipei)
Strategy: conservative-follow-v1. Record schema: 1.

## Scope

- Real public Binance trades, separate virtual account; no keys or private order endpoints.
- Default 10,000 USDT; 0.5% risk budget, 20% position notional cap, three slots, 1x.
- Only new conservative pullback confirmations after start/resume are eligible.
- Fills use a later trade after configured latency and adverse slippage, not target-line prices.
- TP1 reduces half (exchange quantity step), TP2 closes the remainder; original stop is retained.
- Fees, historical funding, incomplete records, archived plans and batch provenance are retained.
- All IndexedDB batches remain available. Restart does not restart trading.

## Automated Checks

- `npm run build`: PASS (TypeScript and production Vite build).
- `node --experimental-strip-types --test --test-reporter=dot tests/*.test.ts`: 191 PASS, zero failures.
- Focused ESLint covering new auto-trading modules, integration hooks, stream service,
  EquityChart, MarketAlertCenter, new tests and replay fixture: PASS.
- `npm run lint`: FAIL, 19 existing errors in App.tsx (6), Portfolio.tsx (1),
  binance.ts (6), and follow-plan-replay.tsx (6). These are existing effect-state,
  explicit-any and fixture purity/ref/refresh issues, not suppressed for this release.
- Production build retains the existing main-chunk-size warning (527.16 kB).

Tests cover long/short mirror calculations, risk sizing, fees, quantity/notional filters,
latency boundaries, later-trade execution, partial exits, priorities, reversal, expiry,
deduplication, pause/resume, interruption/recovery, funding sign/quantity/timing,
funding-adjusted subsecond drawdown, strict storage validation and preserved history.
The stream regression verifies one stalled shard interrupts at the original five-second
deadline without adding a second five-second grace period.

## Browser Checks

Browser: Codex in-app browser, real application at http://127.0.0.1:5173/.
Replay: http://localhost:5174/tests/fixtures/auto-trading.html?storage=1.
Replay uses a separate origin and synthetic TESTUSDT prices, not market-performance evidence.

- Requested desktop sizes: 1366x850, 1440x900, 1920x1080.
- Measured document widths: 1358, 1432, 1912 respectively; scrollWidth equals clientWidth.
- Requested mobile size: 390x844; measured width 382 with no page-wide horizontal overflow.
- Dark desktop and light mobile visually checked; controls wrap without overlap.
- Start, pause, switching analysis/auto views, drain, market/settings lock: PASS.
- Real-quote operational batch auto-1791373796082-1 completed with no trades.
- Reload returns to idle and retains that completed batch: PASS.
- Synthetic long confirmation -> entry -> TP1 -> TP2 -> completion: PASS.
- Synthetic short confirmation -> entry -> stop: PASS; net loss about 50 USDT after fees.
- Synthetic short -> reversal: PASS, exit reason REVERSAL.
- Five-second interruption: INTERRUPTED, incomplete open position, no invented closed trade.
- Arrow-key record tabs and symbol/archived-plan selection callback: PASS.
- CSV downloaded and inspected; completed replay snapshot saved and read back identically.
- Chart canvases have nonzero sizes matching their containers (e.g. 1494x232 plot).
- Saved screenshots visually inspected and sampled for nonblank content (over 1,000 colors each).
- Temporary viewport override reset; application left idle in dark mode.

## Evidence

- live-desktop-1366.png, live-desktop-1440.png, live-desktop-1920.png
- live-mobile-light.png, live-final.png
- replay-long-desktop.png, replay-short-reversal.png
- replay-completed.csv (synthetic replay; exported before additive equity-extrema CSV columns)

Screenshots may be a few pixels smaller than requested viewports due to browser capture
and scrollbar boundaries. They do not demonstrate profitability.

## Boundaries

- No sustained real-market trading profitability evaluation has been completed.
- No native Windows executable launch, OS notification permission, or actual live funding
  settlement boundary was exercised in this pass. Packaged ASAR content is hash-verified.
- Funding may remain pending until aged public records can be reconciled; pending is not zero cost.
- Fixed adverse slippage is an assumption, not an order-book liquidity/market-impact model.
- Latency, spread, funding publication delay, network loss and sleep can affect observed results.
- Browser and desktop storage are separate origins; records are not silently transferred.
- Automatic trading is paper-only. No guarantee of low risk, execution fidelity or future profit.
