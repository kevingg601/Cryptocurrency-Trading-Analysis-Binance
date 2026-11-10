import { useState, useMemo, useEffect } from 'react';
import {
  Star,
  Search,
  Plus,
  Crosshair,
  TrendingUp,
  RotateCcw,
  Edit3,
  ExternalLink,
  X,
} from 'lucide-react';
import type { CoinMetadata, TickerData, MarketType } from '../services/binance';
import { formatCryptoPrice } from '../services/utils';
import {
  type TargetCardSetup,
  type TargetDirection,
  INITIAL_SCREENSHOT_TARGET_SETUPS,
  MAINSTREAM_SYMBOLS,
  TARGET_TRACK_ANCHORS,
  calculateTargetMilestones,
  evaluateTargetProgress,
  deriveAutomaticTargetSetup,
  formatCardTimestamp,
  formatTargetPrice,
} from '@fadachi/core';
import './SignalTargetDashboard.css';

interface SignalTargetDashboardProps {
  coins: CoinMetadata[];
  tickers: Record<string, TickerData>;
  watchlist: string[];
  onToggleWatchlist: (symbol: string) => void;
  onSelectSymbol: (symbol: string) => void;
  onOpenPaperTrade: (
    symbol: string,
    side?: 'LONG' | 'SHORT',
    price?: number,
    suggestedTp?: number,
    suggestedSl?: number,
    conservativeEntry?: number,
    aggressiveEntry?: number
  ) => void;
  marketType: MarketType;
  theme: 'light' | 'dark';
}

export default function SignalTargetDashboard({
  coins,
  tickers,
  watchlist,
  onToggleWatchlist,
  onSelectSymbol,
  onOpenPaperTrade,
  marketType,
  theme = 'dark',
}: SignalTargetDashboardProps) {
  const [scopeFilter, setScopeFilter] = useState<'all' | 'mainstream' | 'watchlist'>('all');
  const [directionFilter, setDirectionFilter] = useState<'all' | 'LONG' | 'SHORT'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddDropdown, setShowAddDropdown] = useState(false);
  const [editingSetup, setEditingSetup] = useState<TargetCardSetup | null>(null);

  // Storage key for custom setups
  const storageKey = `crypto_target_setups_${marketType}`;

  // Custom user-defined or modified setups
  const [customSetups, setCustomSetups] = useState<Record<string, TargetCardSetup>>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  // Track session extreme prices (e.g. lowest price seen for SHORT, highest for LONG)
  const [extremePrices, setExtremePrices] = useState<Record<string, number>>({});

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(customSetups));
    } catch (e) {
      console.warn('Failed to save custom setups', e);
    }
  }, [customSetups, storageKey]);

  // Update session extreme prices as live tickers arrive
  useEffect(() => {
    setExtremePrices(prev => {
      let changed = false;
      const next = { ...prev };
      for (const [symbol, ticker] of Object.entries(tickers)) {
        const price = ticker.price;
        if (!price) continue;
        const currentExtreme = next[symbol];
        if (currentExtreme === undefined) {
          next[symbol] = price;
          changed = true;
        } else {
          // If price is a new extreme (either higher or lower)
          // We keep track of the best price according to setup
          const setup = customSetups[symbol] ?? INITIAL_SCREENSHOT_TARGET_SETUPS[symbol];
          if (setup) {
            if (setup.side === 'SHORT' && price < currentExtreme) {
              next[symbol] = price;
              changed = true;
            } else if (setup.side === 'LONG' && price > currentExtreme) {
              next[symbol] = price;
              changed = true;
            }
          }
        }
      }
      return changed ? next : prev;
    });
  }, [tickers, customSetups]);

  // Determine active coin set
  // 1. Mainstream coins
  const mainstreamList = useMemo(() => {
    const list: string[] = [...MAINSTREAM_SYMBOLS];
    // Include HYPE if present in coins or screenshot
    if (coins.some(c => c.symbol === 'HYPEUSDT') || 'HYPEUSDT' in INITIAL_SCREENSHOT_TARGET_SETUPS) {
      if (!list.includes('HYPEUSDT')) list.push('HYPEUSDT');
    }
    return list;
  }, [coins]);

  // 2. All symbols to display: Mainstream + Watchlist + Custom
  const allSymbols = useMemo(() => {
    const set = new Set<string>();
    mainstreamList.forEach(s => set.add(s));
    watchlist.forEach(s => set.add(s));
    Object.keys(customSetups).forEach(s => set.add(s));
    return Array.from(set);
  }, [mainstreamList, watchlist, customSetups]);

  // Build the complete setup for each symbol
  const setupsMap = useMemo(() => {
    const map: Record<string, TargetCardSetup> = {};

    for (const symbol of allSymbols) {
      if (customSetups[symbol]) {
        map[symbol] = customSetups[symbol];
        continue;
      }
      if (INITIAL_SCREENSHOT_TARGET_SETUPS[symbol]) {
        map[symbol] = INITIAL_SCREENSHOT_TARGET_SETUPS[symbol];
        continue;
      }
      // Dynamically derive automatic setup from current price or 24h ticker
      const coin = coins.find(c => c.symbol === symbol);
      const ticker = tickers[symbol];
      const baseAsset = coin?.baseAsset ?? symbol.replace('USDT', '');
      const name = coin?.name ?? baseAsset;
      const STANDARD_PRICES: Record<string, number> = {
        BTCUSDT: 68500,
        ETHUSDT: 2250,
        SOLUSDT: 90,
        BNBUSDT: 590,
        DOGEUSDT: 0.16,
        XRPUSDT: 1.25,
        HYPEUSDT: 78,
      };
      const price = ticker?.price ?? STANDARD_PRICES[symbol] ?? 10;
      const autoSetup = deriveAutomaticTargetSetup(symbol, baseAsset, name, price, 'SHORT', 2.5);
      if (autoSetup) {
        map[symbol] = autoSetup;
      }
    }

    return map;
  }, [allSymbols, customSetups, coins, tickers]);

  // Filtered symbols based on user selection
  const filteredSymbols = useMemo(() => {
    return allSymbols.filter(symbol => {
      // Scope filter
      if (scopeFilter === 'mainstream' && !mainstreamList.includes(symbol)) {
        return false;
      }
      if (scopeFilter === 'watchlist' && !watchlist.includes(symbol)) {
        return false;
      }

      const setup = setupsMap[symbol];
      if (!setup) return false;

      // Direction filter
      if (directionFilter !== 'all' && setup.side !== directionFilter) {
        return false;
      }

      // Search query
      if (searchQuery.trim()) {
        const query = searchQuery.trim().toLowerCase();
        const base = setup.baseAsset.toLowerCase();
        const name = setup.name.toLowerCase();
        const sym = symbol.toLowerCase();
        if (!base.includes(query) && !name.includes(query) && !sym.includes(query)) {
          return false;
        }
      }

      return true;
    });
  }, [allSymbols, scopeFilter, mainstreamList, watchlist, setupsMap, directionFilter, searchQuery]);

  // Summary statistics
  const stats = useMemo(() => {
    let total = 0;
    let tpCount = 0;
    let totalPnl = 0;

    for (const symbol of allSymbols) {
      const setup = setupsMap[symbol];
      if (!setup) continue;
      const livePrice = tickers[symbol]?.price ?? setup.initialPrice ?? setup.entryPrice;
      const progress = evaluateTargetProgress(setup, livePrice, {
        extremePrice: extremePrices[symbol],
        achievedMilestone: setup.achievedMilestone,
      });
      total++;
      if (progress.tp1Reached || progress.tp2Reached || progress.tp3Reached || progress.ftpReached) {
        tpCount++;
      }
      totalPnl += progress.pnlPercent;
    }

    return {
      total,
      tpCount,
      avgPnl: total > 0 ? totalPnl / total : 0,
    };
  }, [allSymbols, setupsMap, tickers, extremePrices]);

  const handleResetToMarket = (symbol: string) => {
    const coin = coins.find(c => c.symbol === symbol);
    const ticker = tickers[symbol];
    if (!ticker || !ticker.price) return;
    const baseAsset = coin?.baseAsset ?? symbol.replace('USDT', '');
    const name = coin?.name ?? baseAsset;
    const fresh = deriveAutomaticTargetSetup(symbol, baseAsset, name, ticker.price, 'SHORT', 2.5);
    if (fresh) {
      setCustomSetups(prev => ({ ...prev, [symbol]: fresh }));
    }
  };

  const handleSaveEditedSetup = (updated: TargetCardSetup) => {
    setCustomSetups(prev => ({ ...prev, [updated.symbol]: { ...updated, isCustom: true } }));
    setEditingSetup(null);
  };

  return (
    <div className={`signal-dashboard ${theme === 'dark' ? 'dark-theme' : ''}`}>
      {/* Top Header & Metrics */}
      <header className="signal-dashboard-header">
        <div className="signal-dashboard-title-row">
          <div className="signal-dashboard-title-left">
            <div className="signal-dashboard-title-icon">
              <Crosshair size={22} />
            </div>
            <div>
              <h2>主流與自選幣目標監控儀表板</h2>
              <p>即時追蹤進場、止損與分批止盈 (TP1 · TP2 · TP3 · FTP) 目標進度</p>
            </div>
          </div>

          <div className="signal-dashboard-metrics">
            <div className="signal-metric-pill">
              <span>監控標的</span>
              <strong>{stats.total} 幣種</strong>
            </div>
            <div className="signal-metric-pill">
              <span>已達標計畫</span>
              <strong style={{ color: '#1b7a4d' }}>{stats.tpCount} 組</strong>
            </div>
            <div className="signal-metric-pill">
              <span>平均盈虧</span>
              <strong style={{ color: stats.avgPnl >= 0 ? '#1b7a4d' : '#dc2626' }}>
                {stats.avgPnl >= 0 ? '+' : ''}{stats.avgPnl.toFixed(2)}%
              </strong>
            </div>
          </div>
        </div>

        {/* Filters and Controls */}
        <div className="signal-dashboard-toolbar">
          <div className="signal-filter-group">
            <div className="signal-filter-tabs" role="tablist" aria-label="幣種範圍">
              <button
                role="tab"
                aria-selected={scopeFilter === 'all'}
                className={`signal-filter-tab ${scopeFilter === 'all' ? 'active' : ''}`}
                onClick={() => setScopeFilter('all')}
              >
                全部 ({allSymbols.length})
              </button>
              <button
                role="tab"
                aria-selected={scopeFilter === 'mainstream'}
                className={`signal-filter-tab ${scopeFilter === 'mainstream' ? 'active' : ''}`}
                onClick={() => setScopeFilter('mainstream')}
              >
                主流幣 ({mainstreamList.length})
              </button>
              <button
                role="tab"
                aria-selected={scopeFilter === 'watchlist'}
                className={`signal-filter-tab ${scopeFilter === 'watchlist' ? 'active' : ''}`}
                onClick={() => setScopeFilter('watchlist')}
              >
                自選幣 ({watchlist.length})
              </button>
            </div>

            <div className="signal-filter-tabs" role="tablist" aria-label="方向篩選">
              <button
                role="tab"
                aria-selected={directionFilter === 'all'}
                className={`signal-filter-tab ${directionFilter === 'all' ? 'active' : ''}`}
                onClick={() => setDirectionFilter('all')}
              >
                全部方向
              </button>
              <button
                role="tab"
                aria-selected={directionFilter === 'LONG'}
                className={`signal-filter-tab ${directionFilter === 'LONG' ? 'active' : ''}`}
                onClick={() => setDirectionFilter('LONG')}
              >
                做多 LONG
              </button>
              <button
                role="tab"
                aria-selected={directionFilter === 'SHORT'}
                className={`signal-filter-tab ${directionFilter === 'SHORT' ? 'active' : ''}`}
                onClick={() => setDirectionFilter('SHORT')}
              >
                做空 SHORT
              </button>
            </div>
          </div>

          <div className="signal-filter-group">
            <div className="signal-search-wrap">
              <Search size={14} className="signal-search-icon" />
              <input
                type="text"
                placeholder="搜尋代幣..."
                className="signal-search-input"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
            </div>

            <div style={{ position: 'relative' }}>
              <button
                className="signal-add-coin-btn"
                onClick={() => setShowAddDropdown(prev => !prev)}
                title="加入自選標的"
              >
                <Plus size={14} />
                <span>加入代幣</span>
              </button>

              {showAddDropdown && (
                <div
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: '100%',
                    marginTop: '6px',
                    width: '220px',
                    maxHeight: '260px',
                    overflowY: 'auto',
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '8px',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
                    zIndex: 100,
                    padding: '4px',
                  }}
                >
                  {coins.map(coin => {
                    const isAdded = watchlist.includes(coin.symbol);
                    return (
                      <button
                        key={coin.symbol}
                        onClick={() => {
                          if (!isAdded) onToggleWatchlist(coin.symbol);
                          setShowAddDropdown(false);
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          width: '100%',
                          padding: '8px 12px',
                          border: 'none',
                          background: 'transparent',
                          color: 'var(--text-primary)',
                          borderRadius: '6px',
                          fontSize: '13px',
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-secondary)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      >
                        <span><strong>{coin.baseAsset}</strong> <small style={{ color: 'var(--text-secondary)' }}>{coin.name}</small></span>
                        {isAdded && <span style={{ fontSize: '11px', color: '#1b7a4d' }}>已關注</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Cards List */}
      <main className="signal-cards-list">
        {filteredSymbols.length === 0 ? (
          <div
            style={{
              padding: '60px 20px',
              textAlign: 'center',
              background: 'var(--bg-card)',
              border: '1px solid var(--border-color)',
              borderRadius: '14px',
              color: 'var(--text-secondary)',
            }}
          >
            無符合條件之標的，請更換篩選或點選「加入代幣」
          </div>
        ) : (
          filteredSymbols.map(symbol => {
            const setup = setupsMap[symbol];
            if (!setup) return null;
            const ticker = tickers[symbol];
            const livePrice = ticker?.price ?? setup.initialPrice ?? setup.entryPrice;
            const progress = evaluateTargetProgress(setup, livePrice, {
              extremePrice: extremePrices[symbol],
              achievedMilestone: setup.achievedMilestone,
            });

            const isWatchlisted = watchlist.includes(symbol);
            const levels = calculateTargetMilestones(setup.side, setup.entryPrice, setup.stopLoss);
            const slDistance = levels ? levels.slDistancePercent.toFixed(2) : '2.50';

            // Fill bar width and position
            const entryPos = TARGET_TRACK_ANCHORS.ENTRY; // 20%
            const currentPos = progress.positionPercent;
            const isProfit = progress.inProfit;

            const fillBarLeft = isProfit ? Math.min(entryPos, currentPos) : Math.min(entryPos, currentPos);
            const fillBarWidth = Math.abs(currentPos - entryPos);

            return (
              <article
                key={symbol}
                className="signal-target-card"
                aria-label={`${setup.baseAsset} 目標追蹤卡片`}
              >
                {/* Left Info Column */}
                <div className="signal-card-left">
                  <div className="signal-card-symbol-row">
                    <span className="signal-card-symbol">{setup.baseAsset}</span>
                    <button
                      className={`signal-card-star ${isWatchlisted ? 'active' : ''}`}
                      onClick={e => {
                        e.stopPropagation();
                        onToggleWatchlist(symbol);
                      }}
                      title={isWatchlisted ? '從關注移除' : '加入關注'}
                      aria-label="關注切換"
                    >
                      <Star size={16} fill={isWatchlisted ? '#eab308' : 'none'} />
                    </button>
                  </div>

                  <div className="signal-card-subline">
                    <span>{formatCardTimestamp(setup.timestamp, setup.displayTime)}</span>
                    <span className={`signal-card-badge ${setup.side === 'SHORT' ? 'short' : 'long'}`}>
                      {setup.side === 'SHORT' ? '做空' : '做多'}
                    </span>
                  </div>

                  <div className="signal-card-distance">
                    止損距離 {slDistance}%
                  </div>

                  <div className="signal-card-actions">
                    <button
                      className="signal-card-action-btn"
                      onClick={() => onSelectSymbol(symbol)}
                      title="在圖表中查看完整 K 線與指標"
                    >
                      <ExternalLink size={11} style={{ marginRight: '3px' }} />
                      K 線
                    </button>
                    <button
                      className="signal-card-action-btn"
                      onClick={() => setEditingSetup(setup)}
                      title="自訂調整點位與進出場計畫"
                    >
                      <Edit3 size={11} style={{ marginRight: '3px' }} />
                      自訂
                    </button>
                    <button
                      className="signal-card-action-btn"
                      onClick={() => handleResetToMarket(symbol)}
                      title="重設為市場最新計算點位"
                    >
                      <RotateCcw size={11} />
                    </button>
                    <button
                      className="signal-card-action-btn"
                      onClick={() => {
                        onOpenPaperTrade(
                          symbol,
                          setup.side,
                          livePrice,
                          setup.tp1,
                          setup.stopLoss,
                          setup.entryPrice
                        );
                      }}
                      title="立即以模擬帳戶開倉跟單"
                    >
                      <TrendingUp size={11} style={{ marginRight: '3px' }} />
                      開倉
                    </button>
                  </div>
                </div>

                {/* Center Milestone Progress Track */}
                <div className="signal-card-track-container">
                  {/* Top Row: Labels & Current Price Pin with Collision Prevention */}
                  <div className="signal-track-top-row">
                    {Math.abs(currentPos - TARGET_TRACK_ANCHORS.SL) >= 5 && (
                      <span className="signal-track-top-label" style={{ left: `${TARGET_TRACK_ANCHORS.SL}%` }}>止損</span>
                    )}
                    {Math.abs(currentPos - TARGET_TRACK_ANCHORS.ENTRY) >= 5 && (
                      <span className="signal-track-top-label" style={{ left: `${TARGET_TRACK_ANCHORS.ENTRY}%` }}>進場</span>
                    )}
                    {Math.abs(currentPos - TARGET_TRACK_ANCHORS.TP1) >= 5 && (
                      <span className="signal-track-top-label" style={{ left: `${TARGET_TRACK_ANCHORS.TP1}%` }}>TP1</span>
                    )}
                    {Math.abs(currentPos - TARGET_TRACK_ANCHORS.TP2) >= 5 && (
                      <span className="signal-track-top-label" style={{ left: `${TARGET_TRACK_ANCHORS.TP2}%` }}>TP2</span>
                    )}
                    {Math.abs(currentPos - TARGET_TRACK_ANCHORS.TP3) >= 5 && (
                      <span className="signal-track-top-label" style={{ left: `${TARGET_TRACK_ANCHORS.TP3}%` }}>TP3</span>
                    )}
                    {Math.abs(currentPos - TARGET_TRACK_ANCHORS.FTP) >= 5 && (
                      <span className="signal-track-top-label" style={{ left: `${TARGET_TRACK_ANCHORS.FTP}%` }}>FTP</span>
                    )}

                    {/* Current Price Pin Marker */}
                    <div
                      className="signal-track-pin"
                      style={{ left: `${currentPos}%` }}
                      title={`現價: $${formatTargetPrice(livePrice)}`}
                    >
                      <span className="signal-track-pin-label">現價</span>
                      <div className="signal-track-pin-line" />
                    </div>
                  </div>

                  {/* Middle Row: Track Line and Ticks */}
                  <div className="signal-track-bar-row">
                    {/* Base inactive line */}
                    <div className="signal-track-base-line" />

                    {/* Danger zone from SL to Entry (5% to 20%) */}
                    <div className="signal-track-danger-segment" />

                    {/* Active Fill Bar from Entry to Current Price */}
                    <div
                      className={`signal-track-fill-bar ${!isProfit ? 'drawdown' : ''}`}
                      style={{
                        left: `${fillBarLeft}%`,
                        width: `${fillBarWidth}%`,
                      }}
                    />

                    {/* Milestone Vertical Ticks */}
                    <div className="signal-track-tick sl" style={{ left: `${TARGET_TRACK_ANCHORS.SL}%` }} />
                    <div className="signal-track-tick entry" style={{ left: `${TARGET_TRACK_ANCHORS.ENTRY}%` }} />
                    <div className={`signal-track-tick tp ${progress.tp1Reached ? 'reached' : ''}`} style={{ left: `${TARGET_TRACK_ANCHORS.TP1}%` }} />
                    <div className={`signal-track-tick tp ${progress.tp2Reached ? 'reached' : ''}`} style={{ left: `${TARGET_TRACK_ANCHORS.TP2}%` }} />
                    <div className={`signal-track-tick tp ${progress.tp3Reached ? 'reached' : ''}`} style={{ left: `${TARGET_TRACK_ANCHORS.TP3}%` }} />
                    <div className={`signal-track-tick ftp ${progress.ftpReached ? 'reached' : ''}`} style={{ left: `${TARGET_TRACK_ANCHORS.FTP}%` }} />
                  </div>

                  {/* Bottom Row: Milestone Names and Prices */}
                  <div className="signal-track-bottom-row">
                    {/* SL */}
                    <div className="signal-track-bottom-item" style={{ left: `${TARGET_TRACK_ANCHORS.SL}%` }}>
                      <span className="signal-track-bottom-name">止損</span>
                      <span className="signal-track-bottom-price">{formatTargetPrice(setup.stopLoss)}</span>
                    </div>

                    {/* Entry */}
                    <div className="signal-track-bottom-item" style={{ left: `${TARGET_TRACK_ANCHORS.ENTRY}%` }}>
                      <span className="signal-track-bottom-name">進場</span>
                      <span className="signal-track-bottom-price">{formatTargetPrice(setup.entryPrice)}</span>
                    </div>

                    {/* TP1 */}
                    <div
                      className={`signal-track-bottom-item ${progress.tp1Reached ? 'reached' : ''}`}
                      style={{ left: `${TARGET_TRACK_ANCHORS.TP1}%` }}
                    >
                      <span className="signal-track-bottom-name">TP1{progress.tp1Reached ? ' ✓' : ''}</span>
                      <span className="signal-track-bottom-price">{formatTargetPrice(setup.tp1)}</span>
                    </div>

                    {/* TP2 */}
                    <div
                      className={`signal-track-bottom-item ${progress.tp2Reached ? 'reached' : ''}`}
                      style={{ left: `${TARGET_TRACK_ANCHORS.TP2}%` }}
                    >
                      <span className="signal-track-bottom-name">TP2{progress.tp2Reached ? ' ✓' : ''}</span>
                      <span className="signal-track-bottom-price">{formatTargetPrice(setup.tp2)}</span>
                    </div>

                    {/* TP3 */}
                    <div
                      className={`signal-track-bottom-item ${progress.tp3Reached ? 'reached' : ''}`}
                      style={{ left: `${TARGET_TRACK_ANCHORS.TP3}%` }}
                    >
                      <span className="signal-track-bottom-name">TP3{progress.tp3Reached ? ' ✓' : ''}</span>
                      <span className="signal-track-bottom-price">{formatTargetPrice(setup.tp3)}</span>
                    </div>

                    {/* FTP */}
                    <div
                      className={`signal-track-bottom-item ${progress.ftpReached ? 'reached' : ''}`}
                      style={{ left: `${TARGET_TRACK_ANCHORS.FTP}%` }}
                    >
                      <span className="signal-track-bottom-name">FTP{progress.ftpReached ? ' ✓' : ''}</span>
                      <span className="signal-track-bottom-price">{formatTargetPrice(setup.ftp)}</span>
                    </div>
                  </div>
                </div>

                {/* Right Info Column */}
                <div className="signal-card-right">
                  <div className={`signal-card-pnl ${progress.maxPnlPercent >= 0 ? 'positive' : 'negative'}`}>
                    {progress.maxPnlPercent >= 0 ? '+' : ''}{progress.maxPnlPercent.toFixed(2)}%
                  </div>

                  <div className="signal-card-status-label">
                    {progress.statusLabel}
                  </div>

                  <div className="signal-card-status-price">
                    {progress.priceDisplay}
                  </div>
                </div>
              </article>
            );
          })
        )}
      </main>

      {/* Edit Setup Modal */}
      {editingSetup && (
        <EditSetupModal
          setup={editingSetup}
          onSave={handleSaveEditedSetup}
          onClose={() => setEditingSetup(null)}
        />
      )}
    </div>
  );
}

function EditSetupModal({
  setup,
  onSave,
  onClose,
}: {
  setup: TargetCardSetup;
  onSave: (setup: TargetCardSetup) => void;
  onClose: () => void;
}) {
  const [side, setSide] = useState<TargetDirection>(setup.side);
  const [entryPrice, setEntryPrice] = useState<string>(setup.entryPrice.toString());
  const [stopLoss, setStopLoss] = useState<string>(setup.stopLoss.toString());

  const numEntry = parseFloat(entryPrice) || setup.entryPrice;
  const numSl = parseFloat(stopLoss) || setup.stopLoss;

  const previewLevels = useMemo(() => {
    return calculateTargetMilestones(side, numEntry, numSl);
  }, [side, numEntry, numSl]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!previewLevels) {
      alert('請確認止損與進場方向符合邏輯（做多時止損需低於進場；做空時止損需高於進場）');
      return;
    }

    onSave({
      ...setup,
      side,
      entryPrice: previewLevels.entryPrice,
      stopLoss: previewLevels.stopLoss,
      tp1: previewLevels.tp1,
      tp2: previewLevels.tp2,
      tp3: previewLevels.tp3,
      ftp: previewLevels.ftp,
      timestamp: Date.now(),
    });
  };

  return (
    <div className="signal-edit-modal-backdrop" onClick={onClose}>
      <div className="signal-edit-modal" onClick={e => e.stopPropagation()}>
        <div className="signal-edit-modal-header">
          <h3>自訂 {setup.baseAsset} 交易點位計畫</h3>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="signal-edit-modal-body">
          <div className="signal-edit-field">
            <label>交易方向</label>
            <select
              value={side}
              onChange={e => {
                const newSide = e.target.value as TargetDirection;
                setSide(newSide);
                // Adjust SL accordingly
                const risk = Math.abs(numEntry - numSl);
                if (newSide === 'SHORT' && numSl <= numEntry) {
                  setStopLoss((numEntry + risk).toFixed(4));
                } else if (newSide === 'LONG' && numSl >= numEntry) {
                  setStopLoss((numEntry - risk).toFixed(4));
                }
              }}
            >
              <option value="SHORT">做空 SHORT</option>
              <option value="LONG">做多 LONG</option>
            </select>
          </div>

          <div className="signal-edit-field">
            <label>進場參考價 (Entry)</label>
            <input
              type="number"
              step="any"
              value={entryPrice}
              onChange={e => setEntryPrice(e.target.value)}
              required
            />
          </div>

          <div className="signal-edit-field">
            <label>止損價 (Stop Loss)</label>
            <input
              type="number"
              step="any"
              value={stopLoss}
              onChange={e => setStopLoss(e.target.value)}
              required
            />
          </div>

          {previewLevels ? (
            <div
              style={{
                marginTop: '10px',
                padding: '12px',
                background: 'var(--bg-secondary)',
                borderRadius: '8px',
                fontSize: '12px',
                lineHeight: '1.6',
              }}
            >
              <div><strong>預估止損距離：</strong> {previewLevels.slDistancePercent.toFixed(2)}%</div>
              <div><strong>TP1 (1.0R)：</strong> ${formatCryptoPrice(previewLevels.tp1)}</div>
              <div><strong>TP2 (2.0R)：</strong> ${formatCryptoPrice(previewLevels.tp2)}</div>
              <div><strong>TP3 (5.0R)：</strong> ${formatCryptoPrice(previewLevels.tp3)}</div>
              <div><strong>FTP (10.0R)：</strong> ${formatCryptoPrice(previewLevels.ftp)}</div>
            </div>
          ) : (
            <div style={{ color: '#dc2626', fontSize: '12px', marginTop: '6px' }}>
              ⚠️ 點位不合法：{side === 'LONG' ? '做多時止損必須小於進場價' : '做空時止損必須大於進場價'}
            </div>
          )}

          <div className="signal-edit-modal-footer">
            <button type="button" className="signal-modal-btn secondary" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="signal-modal-btn primary" disabled={!previewLevels}>
              儲存點位
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
