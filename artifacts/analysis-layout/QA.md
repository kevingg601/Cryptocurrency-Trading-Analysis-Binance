# Analysis Workspace QA

Date: 2026-10-07

## Scope

- 248px market list, responsive central chart, 248px momentum/watchlist panel.
- Independently scrollable regions; fixed market search and panel tabs.
- Icon navigation and compact monitoring summary on the analysis page only.
- Compact market rendering reuses the existing search, sort and watchlist state.
- No changes to quote providers, market alerts, backtest rules or paper execution.
- Chart sizing uses ResizeObserver with cleanup. Data identity gates hide previous-symbol signals and indicators during loading.

## Browser Checks

Verified in the Codex in-app browser against http://127.0.0.1:5173/.

| Viewport | Result |
| --- | --- |
| 1366 x 850 | Three columns visible; document 1366 x 850, no page overflow |
| 1440 x 900 | Three columns visible; document 1440 x 900, no page overflow |
| 1920 x 1080 | Three columns visible; document 1920 x 1080, no page overflow |
| 1200 x 850 | Both side panels visible |
| 1100 x 850 | Market panel visible; momentum drawer opens and closes |
| 1000 x 850 | Market panel visible; momentum panel hidden until opened |
| 390 x 844 | Chart-first layout; both lists use drawers; no page overflow |

- Scrolling the market list left the center and right scroll positions unchanged.
- Central PageDown and Control+Home scroll only the central analysis region.
- Selecting a coin updates the chart and selected-row appearance.
- Search text and momentum/watchlist tab survive coin changes.
- Drawer search survives closing, selecting a coin, and reopening.
- Sorting by gain produced descending changes; watchlist filter showed followed coins only.
- Star toggle added and removed a test coin successfully; restored original watchlist.
- Momentum coin selection updates the chart immediately.
- Arrow keys switch right-panel tabs. Shift+Tab is trapped inside an open drawer.
- Escape closes drawers and returns focus to the opening button.
- Dark and light themes checked; final preview restored to dark.
- K-line canvas rendered, resized with the center container, and responded to wheel zoom and time-axis reset.
- Previous-symbol signals are replaced by a loading state during symbol changes.

Screenshot: desktop-1366.jpg.

## Build and Packaging

- npm run build: passed.
- npm test: 6 passed, 0 failed.
- ESLint: AnalysisWorkspace.tsx, CryptoTable.tsx, MomentumRadar.tsx passed.
- Full-project lint was not used as an acceptance gate; existing legacy lint issues remain outside this layout change.
- Electron-builder was blocked by the local dependency rebuild permissions and unavailable network access to the Electron download.
- Reused the existing 20261002 desktop runtime and replaced resources/app.asar with a new archive containing only the current dist, main.cjs and package.json.
- Verified all 10 packaged application files against the production build by SHA-256.
- ZIP verified to contain the executable and the exact new app.asar.
- Native Electron window interaction was not tested; browser UI and desktop archive integrity were checked.

Output: dist-desktop/AntigravityCrypto-20261007.zip

App archive SHA-256: DA1DFA6570402F7B38293E865D6C7F6926CB2087B0862F790A5035DA78AE546A

Extract the entire ZIP and launch win-unpacked/AntigravityCrypto.exe. Keep the runtime files and resources beside the executable.
