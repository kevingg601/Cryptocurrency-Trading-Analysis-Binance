import { lazy, Suspense, useState, useEffect, useMemo } from 'react';
import { fetchSupportedCoins, fetchTickers, fetchFundingRates, FALLBACK_COINS } from './services/binance';
import type { TickerData, CoinMetadata, MarketType } from './services/binance';
import { formatCryptoPrice } from './services/utils';
import AnalysisWorkspace from './components/AnalysisWorkspace';
import ChartContainer from './components/ChartContainer';
import type { PaperTrade, PaperTradeHistory } from './components/Cockpit';
import TradingModal from './components/TradingModal';
import MarketAlertCenter from './components/MarketAlertCenter';
import CoinPicker from './components/CoinPicker';
import { useMarketAlerts } from './hooks/useMarketAlerts';
import { useRealtimeQuotes } from './hooks/useRealtimeQuotes';
import { useAutoTrading } from './hooks/useAutoTrading';
import QuoteStatus from './components/QuoteStatus';
import { paperLimitFillPrice, validatePaperOrder } from './services/orderValidation';
import { LayoutDashboard, Wallet, Clock, Sun, Moon } from 'lucide-react';
import './App.css';

const Portfolio = lazy(() => import('./components/Portfolio'));
const Cockpit = lazy(() => import('./components/Cockpit'));
const AutoBotLab = lazy(() => import('./components/AutoBotLab'));
const AutoTrading = lazy(() => import('./components/AutoTrading'));

export default function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'portfolio'>(() => {
    const saved = localStorage.getItem('crypto_active_tab');
    return (saved === 'dashboard' || saved === 'portfolio') ? saved : 'dashboard';
  });
  const [marketType, setMarketType] = useState<MarketType>(() => {
    const saved = localStorage.getItem('crypto_market_type');
    return (saved === 'spot' || saved === 'futures') ? saved : 'spot';
  });
  const [viewMode, setViewMode] = useState<'analysis' | 'cockpit' | 'bot' | 'auto'>(() => {
    const saved = localStorage.getItem('crypto_view_mode');
    return (saved === 'analysis' || saved === 'cockpit' || saved === 'bot' || saved === 'auto') ? saved : 'analysis';
  });

  // Persist tab selections
  useEffect(() => {
    localStorage.setItem('crypto_active_tab', activeTab);
  }, [activeTab]);

  useEffect(() => {
    localStorage.setItem('crypto_market_type', marketType);
  }, [marketType]);

  useEffect(() => {
    localStorage.setItem('crypto_view_mode', viewMode);
  }, [viewMode]);
  
  const [coins, setCoins] = useState<CoinMetadata[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState<string>('BTCUSDT');
  const [selectedFollowPlanId, setSelectedFollowPlanId] = useState<string | null>(null);
  const [hiddenFollowPlanId, setHiddenFollowPlanId] = useState<string | null>(null);
  const [tickers, setTickers] = useState<Record<string, TickerData>>({});
  const [fundingRates, setFundingRates] = useState<Record<string, number>>({});
  
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [paperTrades, setPaperTrades] = useState<PaperTrade[]>([]);
  const [paperBalance, setPaperBalance] = useState<number>(100000);
  const [paperHistory, setPaperHistory] = useState<PaperTradeHistory[]>([]);
  const [reversalWarnings, setReversalWarnings] = useState<string[]>([]);

  const [tradingModal, setTradingModal] = useState<{
    isOpen: boolean;
    symbol: string;
    suggestedSide: 'LONG' | 'SHORT';
    suggestedPrice: number;
    suggestedTp?: number;
    suggestedSl?: number;
    conservativeEntry?: number;
    aggressiveEntry?: number;
  }>({ isOpen: false, symbol: 'BTCUSDT', suggestedSide: 'LONG', suggestedPrice: 0 });

  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('crypto_theme');
    return saved === 'light' ? 'light' : 'dark';
  });

  const autoTrading = useAutoTrading(marketType);
  const { registerNotifications, setSignalSettings } = autoTrading;
  const {
    alerts: marketAlerts,
    unreadCount: marketAlertUnreadCount,
    activeToast: activeMarketAlert,
    followPlans,
    followEvents,
    notificationPermission,
    settings: marketAlertSettings,
    processTickerBatch,
    processAggregateTrade,
    enableDesktopAlerts,
    setAlertSettings: setMarketAlertSettings,
    markAllRead: markMarketAlertsRead,
    clearAlerts: clearMarketAlerts,
    dismissToast: dismissMarketAlert,
    publishExternalNotification,
  } = useMarketAlerts(marketType, autoTrading.processFrame);
  useEffect(() => {
    registerNotifications(publishExternalNotification);
    return () => registerNotifications(null);
  }, [registerNotifications, publishExternalNotification]);
  useEffect(() => {
    setSignalSettings({ ...marketAlertSettings });
  }, [setSignalSettings, marketAlertSettings]);
  const selectedFollowPlan = followPlans.find(plan => plan.id === selectedFollowPlanId && plan.symbol === selectedSymbol && plan.marketType === marketType)
    ?? autoTrading.history.flatMap(batch => batch.plans).find(plan => plan.id === selectedFollowPlanId && plan.symbol === selectedSymbol && plan.marketType === marketType)
    ?? followPlans.find(plan => plan.symbol === selectedSymbol && plan.marketType === marketType);
  const visibleFollowPlan = selectedFollowPlan?.id !== hiddenFollowPlanId ? selectedFollowPlan : undefined;

  // Merge and deduplicate subscription symbols
  const subSymbolsKey = Array.from(new Set([...coins.map(coin => coin.symbol), ...autoTrading.universeSymbols, selectedSymbol, ...watchlist])).sort().join(',');
  const liveQuotes = useRealtimeQuotes(marketType, subSymbolsKey, selectedSymbol, setTickers, processTickerBatch, processAggregateTrade, autoTrading.onTradeStatus);

  // Apply theme class to document body
  useEffect(() => {
    document.body.className = theme === 'light' ? 'light-theme' : 'dark-theme';
    localStorage.setItem('crypto_theme', theme);
  }, [theme]);

  // Sync watchlist when marketType changes
  useEffect(() => {
    const key = `crypto_watchlist_${marketType}`;
    const saved = localStorage.getItem(key);
    setWatchlist(saved ? JSON.parse(saved) : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  }, [marketType]);

  // Sync paper trades, balance, and history when marketType changes
  useEffect(() => {
    const tradesKey = `crypto_paper_trades_${marketType}`;
    const balanceKey = `crypto_paper_balance_${marketType}`;
    const historyKey = `crypto_paper_history_${marketType}`;
    
    const savedTrades = localStorage.getItem(tradesKey);
    setPaperTrades(savedTrades ? JSON.parse(savedTrades) : []);
    
    const savedBalance = localStorage.getItem(balanceKey);
    setPaperBalance(savedBalance ? parseFloat(savedBalance) : 100000);

    const savedHistory = localStorage.getItem(historyKey);
    setPaperHistory(savedHistory ? JSON.parse(savedHistory) : []);
  }, [marketType]);

  // Fetch initial coins list, tickers, funding rates, and connect WebSocket
  useEffect(() => {
    let active = true;

    // Reset layout states on market toggle to show loading
    setCoins([]);
    setTickers({});
    setFundingRates({});

    // 1. Fetch dynamic coins list from exchange info
    fetchSupportedCoins(marketType)
      .then((loadedCoins) => {
        if (!active) return;
        setCoins(loadedCoins);

        // Ensure selectedSymbol exists in the newly loaded market
        setSelectedSymbol(current => loadedCoins.length > 0 && !loadedCoins.some(c => c.symbol === current) ? loadedCoins[0].symbol : current);

        // 2. Fetch initial 24h ticker snapshot for all symbols
        return fetchTickers(marketType);
      })
      .then((tickerData) => {
        if (!active || !tickerData) return;
        const initialTickers: Record<string, TickerData> = {};
        tickerData.forEach((t) => {
          initialTickers[t.symbol] = t;
        });
        setTickers((prev) => ({ ...initialTickers, ...prev }));

        // 3. Fetch Funding Rates (Futures only)
        if (marketType === 'futures') {
          return fetchFundingRates();
        }
        return null;
      })
      .then((rates) => {
        if (!active || !rates) return;
        setFundingRates(rates);
      })
      .catch((err) => {
        console.error(`Failed to load initial Binance ${marketType} data:`, err);
        if (active) {
          setCoins(FALLBACK_COINS);
        }
      });

    return () => { active = false; };
  }, [marketType]);

  useEffect(() => {
    let active = true;

    // Set up interval to poll funding rates every 30 seconds (Futures only)
    let ratesInterval: any = null;
    if (marketType === 'futures') {
      ratesInterval = setInterval(() => {
        fetchFundingRates()
          .then((rates) => {
            if (active) setFundingRates(rates);
          })
          .catch(err => console.error('Failed to update funding rates:', err));
      }, 30000);
    }

    return () => {
      active = false;
      if (ratesInterval) {
        clearInterval(ratesInterval);
      }
    };
  }, [marketType]);

  const handleToggleWatchlist = (symbol: string) => {
    const key = `crypto_watchlist_${marketType}`;
    const updated = watchlist.includes(symbol)
      ? watchlist.filter(s => s !== symbol)
      : [...watchlist, symbol];
    setWatchlist(updated);
    localStorage.setItem(key, JSON.stringify(updated));
  };

  // Check and process Take Profit, Stop Loss, and Limit Orders when tickers update
  useEffect(() => {
    if (paperTrades.length === 0) return;

    let hasChanges = false;
    const updatedTrades = [...paperTrades];
    let balanceChange = 0;
    const logs: string[] = [];
    const newHistoryEntries: PaperTradeHistory[] = [];

    for (let i = 0; i < updatedTrades.length; i++) {
      const trade = updatedTrades[i];
      const ticker = tickers[trade.symbol];
      if (!ticker) continue;

      const currentPrice = ticker.price;

      if (trade.status === 'PENDING') {
        // Check if LIMIT order is filled
        const filledPrice = paperLimitFillPrice(trade.side, trade.limitPrice ?? trade.entryPrice, currentPrice);

        if (filledPrice !== null) {
          const liq = trade.side === 'LONG'
            ? filledPrice * (1 - 1 / trade.leverage + 0.004)
            : filledPrice * (1 + 1 / trade.leverage - 0.004);

          updatedTrades[i] = {
            ...trade,
            status: 'OPEN',
            entryPrice: filledPrice,
            currentPrice: currentPrice,
            liqPrice: liq,
            timestamp: Date.now()
          };
          hasChanges = true;
          logs.push(`【掛單成交】${trade.symbol} 已在 $${formatCryptoPrice(filledPrice)} 成交開${trade.side === 'LONG' ? '多' : '空'}！`);
        }
      } else if (trade.status === 'OPEN') {
        // Check TP / SL / Liquidation
        let triggerType: 'TP' | 'SL' | 'LIQ' | null = null;

        // 1. Take Profit
        if (trade.takeProfit) {
          if (trade.side === 'LONG' && currentPrice >= trade.takeProfit) {
            triggerType = 'TP';
          } else if (trade.side === 'SHORT' && currentPrice <= trade.takeProfit) {
            triggerType = 'TP';
          }
        }

        // 2. Stop Loss
        if (trade.stopLoss && !triggerType) {
          if (trade.side === 'LONG' && currentPrice <= trade.stopLoss) {
            triggerType = 'SL';
          } else if (trade.side === 'SHORT' && currentPrice >= trade.stopLoss) {
            triggerType = 'SL';
          }
        }

        // 3. Liquidation check
        if (trade.liqPrice && !triggerType) {
          if (trade.side === 'LONG' && currentPrice <= trade.liqPrice) {
            triggerType = 'LIQ';
          } else if (trade.side === 'SHORT' && currentPrice >= trade.liqPrice) {
            triggerType = 'LIQ';
          }
        }

        if (triggerType) {
          const margin = trade.size / trade.leverage;
          let pnl = 0;
          let triggerPrice = currentPrice;

          if (triggerType === 'TP') {
            triggerPrice = trade.takeProfit || currentPrice;
            const diff = triggerPrice - trade.entryPrice;
            const pctChg = diff / trade.entryPrice;
            pnl = trade.side === 'LONG'
              ? trade.size * pctChg
              : trade.size * (-pctChg);
            logs.push(`【止盈觸發 🟢】${trade.symbol} 已在 $${formatCryptoPrice(triggerPrice)} 止盈平倉，獲利 +$${pnl.toFixed(2)} USDT！`);
          } else if (triggerType === 'SL') {
            triggerPrice = trade.stopLoss || currentPrice;
            const diff = triggerPrice - trade.entryPrice;
            const pctChg = diff / trade.entryPrice;
            pnl = trade.side === 'LONG'
              ? trade.size * pctChg
              : trade.size * (-pctChg);
            logs.push(`【止損觸發 🔴】${trade.symbol} 已在 $${formatCryptoPrice(triggerPrice)} 止損退場，虧損 -$${Math.abs(pnl).toFixed(2)} USDT！`);
          } else if (triggerType === 'LIQ') {
            pnl = -margin; // Lose all margin
            triggerPrice = trade.liqPrice || currentPrice;
            logs.push(`【爆倉強平 💥】${trade.symbol} 觸及強平價 $${formatCryptoPrice(triggerPrice)}，保證金 $${margin.toFixed(2)} 已歸零！`);
          }

          // Create a history entry
          const historyEntry: PaperTradeHistory = {
            id: trade.id + '_' + Date.now(),
            symbol: trade.symbol,
            side: trade.side,
            type: trade.type,
            leverage: trade.leverage,
            entryPrice: trade.entryPrice,
            exitPrice: triggerPrice,
            size: trade.size,
            pnl: pnl,
            roi: (pnl / margin) * 100,
            exitType: triggerType,
            timestamp: Date.now()
          };
          newHistoryEntries.push(historyEntry);

          balanceChange += (margin + pnl);
          updatedTrades.splice(i, 1);
          i--; // Adjust index
          hasChanges = true;
        } else {
          // Just update price
          if (trade.currentPrice !== currentPrice) {
            updatedTrades[i] = {
              ...trade,
              currentPrice: currentPrice
            };
            hasChanges = true;
          }
        }
      }
    }

    if (hasChanges) {
      setPaperTrades(updatedTrades);
      localStorage.setItem(`crypto_paper_trades_${marketType}`, JSON.stringify(updatedTrades));

      if (newHistoryEntries.length > 0) {
        setPaperHistory((prev) => {
          const next = [...prev, ...newHistoryEntries];
          localStorage.setItem(`crypto_paper_history_${marketType}`, JSON.stringify(next));
          return next;
        });
      }

      if (balanceChange !== 0) {
        setPaperBalance((prev) => {
          const next = Math.max(0, prev + balanceChange);
          localStorage.setItem(`crypto_paper_balance_${marketType}`, next.toString());
          return next;
        });
      }

      if (logs.length > 0) {
        alert(logs.join('\n'));
      }
    }
  }, [tickers, paperTrades, marketType]);

  // Reversal Warning Scanner
  useEffect(() => {
    const warnings: string[] = [];
    paperTrades.forEach((trade) => {
      if (trade.status !== 'OPEN' && trade.status !== 'PENDING') return;

      const ticker = tickers[trade.symbol];
      if (!ticker) return;

      const rate = fundingRates[trade.symbol] || 0;
      const pct = ticker.priceChangePercent;

      if (trade.side === 'LONG') {
        if (pct > 10) {
          warnings.push(`${trade.symbol}:LONG_OVERBOUGHT`);
        }
        if (rate > 0.001) {
          warnings.push(`${trade.symbol}:LONG_HIGH_FUNDING`);
        }
      } else if (trade.side === 'SHORT') {
        if (pct < -10) {
          warnings.push(`${trade.symbol}:SHORT_OVERSOLD`);
        }
        if (rate < -0.001) {
          warnings.push(`${trade.symbol}:SHORT_LOW_FUNDING`);
        }
      }
    });

    const sorted = Array.from(new Set(warnings)).sort();
    const serialized = JSON.stringify(sorted);

    setReversalWarnings((prev) => {
      if (JSON.stringify(prev) !== serialized) {
        return sorted;
      }
      return prev;
    });
  }, [paperTrades, tickers, fundingRates]);

  const handleOpenPaperTrade = (
    symbol: string,
    side: 'LONG' | 'SHORT',
    type: 'MARKET' | 'LIMIT',
    leverage: number,
    price: number,
    size: number,
    takeProfit?: number,
    stopLoss?: number
  ) => {
    const livePrice = tickers[symbol]?.price ?? 0;
    const orderError = validatePaperOrder(side, type, price, livePrice, takeProfit, stopLoss);
    if (orderError) {
      alert(orderError);
      return false;
    }
    if (![size, leverage].every(Number.isFinite) || size <= 0 || leverage < 1 || leverage > 125) {
      alert('倉位大小或槓桿無效。');
      return false;
    }
    const entryPrice = type === 'MARKET' ? livePrice : price;
    const margin = size / leverage;
    if (marketType === 'spot' && (side !== 'LONG' || leverage !== 1)) {
      alert('現貨模擬僅支援買入與 1 倍資金。');
      return false;
    }
    if (paperBalance < margin) {
      alert('可用餘額不足以支付此部位保證金！');
      return false;
    }

    const liq = marketType === 'spot' ? undefined : side === 'LONG'
      ? entryPrice * (1 - 1 / leverage + 0.004)
      : entryPrice * (1 + 1 / leverage - 0.004);

    const newTrade: PaperTrade = {
      id: Date.now().toString(),
      symbol,
      side,
      type,
      status: type === 'MARKET' ? 'OPEN' : 'PENDING',
      leverage,
      entryPrice,
      limitPrice: type === 'LIMIT' ? entryPrice : undefined,
      currentPrice: livePrice,
      size,
      takeProfit: takeProfit || undefined,
      stopLoss: stopLoss || undefined,
      liqPrice: liq,
      timestamp: Date.now()
    };

    const tradesKey = `crypto_paper_trades_${marketType}`;
    const balanceKey = `crypto_paper_balance_${marketType}`;
    
    const updatedTrades = [...paperTrades, newTrade];
    const updatedBalance = paperBalance - margin;
    
    setPaperTrades(updatedTrades);
    setPaperBalance(updatedBalance);
    
    localStorage.setItem(tradesKey, JSON.stringify(updatedTrades));
    localStorage.setItem(balanceKey, updatedBalance.toString());

    if (type === 'MARKET') {
      alert(`成功市價開倉！\n代幣: ${symbol.replace('USDT', '')}\n方向: ${side === 'LONG' ? '做多 LONG' : '做空 SHORT'}\n價格: $${formatCryptoPrice(entryPrice)}\n槓桿: ${leverage}x\n名義價值: $${size}\n占用保證金: $${margin.toFixed(2)} USDT`);
    } else {
      alert(`限價委託已送出！\n代幣: ${symbol.replace('USDT', '')}\n方向: ${side === 'LONG' ? '做多 LONG' : '做空 SHORT'}\n委託限價: $${formatCryptoPrice(price)}\n槓桿: ${leverage}x\n名義價值: $${size}\n凍結保證金: $${margin.toFixed(2)} USDT`);
    }
    return true;
  };

  const handleCancelPendingOrder = (id: string) => {
    const order = paperTrades.find(t => t.id === id);
    if (!order) return;

    const margin = order.size / order.leverage;
    const updatedTrades = paperTrades.filter(t => t.id !== id);
    const updatedBalance = paperBalance + margin;

    setPaperTrades(updatedTrades);
    setPaperBalance(updatedBalance);

    localStorage.setItem(`crypto_paper_trades_${marketType}`, JSON.stringify(updatedTrades));
    localStorage.setItem(`crypto_paper_balance_${marketType}`, updatedBalance.toString());

    alert('限價掛單已成功撤銷，凍結之保證金已退回可用餘額。');
  };

  const handleClosePaperTrade = (id: string) => {
    const trade = paperTrades.find(t => t.id === id);
    if (!trade) return;

    const ticker = tickers[trade.symbol];
    const currentPrice = ticker ? ticker.price : trade.entryPrice;
    const priceDiff = currentPrice - trade.entryPrice;
    const percentageChange = priceDiff / trade.entryPrice;
    
    const pnl = trade.side === 'LONG'
      ? trade.size * percentageChange
      : trade.size * (-percentageChange);

    const margin = trade.size / trade.leverage;
    const returnAmount = margin + pnl;

    const updatedTrades = paperTrades.filter(t => t.id !== id);
    const updatedBalance = Math.max(0, paperBalance + returnAmount);

    const historyEntry: PaperTradeHistory = {
      id: trade.id + '_' + Date.now(),
      symbol: trade.symbol,
      side: trade.side,
      type: trade.type,
      leverage: trade.leverage,
      entryPrice: trade.entryPrice,
      exitPrice: currentPrice,
      size: trade.size,
      pnl: pnl,
      roi: (pnl / margin) * 100,
      exitType: 'MANUAL',
      timestamp: Date.now()
    };

    setPaperTrades(updatedTrades);
    setPaperBalance(updatedBalance);
    setPaperHistory(prev => {
      const next = [...prev, historyEntry];
      localStorage.setItem(`crypto_paper_history_${marketType}`, JSON.stringify(next));
      return next;
    });

    localStorage.setItem(`crypto_paper_trades_${marketType}`, JSON.stringify(updatedTrades));
    localStorage.setItem(`crypto_paper_balance_${marketType}`, updatedBalance.toString());

    alert(`成功平倉部位！\n實現盈虧: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${(pnl / margin * 100).toFixed(2)}%)`);
  };

  const handleClearPaperHistory = () => {
    if (window.confirm('確定要清除所有平倉歷史交易紀錄嗎？')) {
      setPaperHistory([]);
      localStorage.removeItem(`crypto_paper_history_${marketType}`);
    }
  };

  const handleQuickFollowTrade = (
    symbol: string,
    side: 'LONG' | 'SHORT',
    entryPrice: number,
    type: 'MARKET' | 'LIMIT',
    takeProfitPrice?: number,
    stopLossPrice?: number
  ) => {
    const defaultLeverage = 20;
    // 5% margin allocation of available balance
    const defaultMargin = Math.max(10, Math.floor(paperBalance * 0.05));
    const size = defaultMargin * defaultLeverage;

    if (paperBalance < defaultMargin) {
      alert(`餘額不足以支付跟單保證金！最低需要 $${defaultMargin.toFixed(2)} USDT。`);
      return;
    }

    handleOpenPaperTrade(
      symbol,
      side,
      type,
      defaultLeverage,
      entryPrice,
      size,
      takeProfitPrice,
      stopLossPrice
    );
  };

  const handleTriggerOpenTradeModal = (
    symbol: string,
    side?: 'LONG' | 'SHORT',
    price?: number,
    suggestedTp?: number,
    suggestedSl?: number,
    conservativeEntry?: number,
    aggressiveEntry?: number
  ) => {
    setTradingModal({
      isOpen: true,
      symbol,
      suggestedSide: marketType === 'spot' ? 'LONG' : side || 'LONG',
      suggestedPrice: price || tickers[symbol]?.price || 0,
      suggestedTp: marketType === 'spot' && side === 'SHORT' ? undefined : suggestedTp,
      suggestedSl: marketType === 'spot' && side === 'SHORT' ? undefined : suggestedSl,
      conservativeEntry,
      aggressiveEntry
    });
  };

  const defaultCard: CoinMetadata = {
    symbol: 'BTCUSDT',
    name: 'Bitcoin',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    logo: 'https://assets.coingecko.com/coins/images/1/large/bitcoin.png'
  };

  const selectedCard = coins.find(c => c.symbol === selectedSymbol) || defaultCard;
  const selectedTicker = tickers[selectedSymbol];
  const selectedMarketAlerts = useMemo(
    () => marketAlerts.filter((alert) => alert.symbol === selectedSymbol),
    [marketAlerts, selectedSymbol]
  );
  const selectedChange = selectedTicker?.priceChangePercent ?? 0;
  const selectedIsUp = selectedChange >= 0;


  // Select banner coins
  const bannerSymbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
  const bannerCoins = coins.filter(c => bannerSymbols.includes(c.symbol));

  if (coins.length === 0) {
    return (
      <div style={{
        height: '100vh',
        background: 'var(--bg-primary)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'white',
        fontFamily: 'var(--font-display)'
      }}>
        <div style={{ fontSize: '24px', fontWeight: 700, marginBottom: '12px' }}>
          連線至 Binance {marketType === 'spot' ? '現貨市場' : '合約市場'}...
        </div>
        <div style={{ color: 'var(--text-secondary)' }}>正在載入全市場交易對資訊</div>
      </div>
    );
  }

  const coinSymbol = selectedCard.symbol.replace('USDT', '');
  const isAnalysis = activeTab === 'dashboard' && viewMode === 'analysis';

  return (
    <div className={`app-container ${isAnalysis ? 'analysis-mode' : ''}`}>
      {/* Sidebar Section */}
      <aside className="sidebar">
        <div>
          <div className="logo-section">
            <div className="logo-icon">AG</div>
            <div className="logo-text">Antigravity<span>Crypto</span></div>
          </div>
          
          <nav className="nav-links">
            <button
              type="button"
              aria-current={activeTab === 'dashboard' ? 'page' : undefined}
              title="即時行情儀表板"
              aria-label="即時行情儀表板"
              className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`}
              onClick={() => setActiveTab('dashboard')}
            >
              <LayoutDashboard size={18} />
              <span>即時行情儀表板</span>
            </button>
            
            <button
              type="button"
              aria-current={activeTab === 'portfolio' ? 'page' : undefined}
              title="虛擬資產帳戶"
              aria-label="虛擬資產帳戶"
              className={`nav-item ${activeTab === 'portfolio' ? 'active' : ''}`}
              onClick={() => setActiveTab('portfolio')}
            >
              <Wallet size={18} />
              <span>虛擬資產帳戶</span>
            </button>
          </nav>
        </div>

        <div className="sidebar-footer">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', marginBottom: '4px' }}>
            <Clock size={12} />
            <span>台北時間 (UTC+8)</span>
          </div>
          <div>v1.1.0 Stable</div>
        </div>
      </aside>

      {/* Main Panel Section */}
      <main className="main-content">
        <div className="workspace-topbar">
          <div className="workspace-title-block">
            <span className="workspace-kicker">
              {marketType === 'spot' ? 'Spot Market' : 'USDT Perpetual'}
            </span>
            <h1>{activeTab === 'dashboard' ? '交易監控工作台' : '虛擬資產帳戶'}</h1>
          </div>

          <div className="workspace-actions">
            <div className="control-group">
              <MarketAlertCenter
                alerts={marketAlerts}
                unreadCount={marketAlertUnreadCount}
                activeToast={activeMarketAlert}
                followPlans={followPlans}
                followEvents={followEvents}
                notificationPermission={notificationPermission}
                settings={marketAlertSettings}
                settingsLocked={autoTrading.marketLocked}
                tickers={tickers}
                monitoredCount={coins.length}
                onEnableDesktopAlerts={enableDesktopAlerts}
                onSettingsChange={settings => { if (!autoTrading.marketLocked) setMarketAlertSettings(settings); }}
                onMarkAllRead={markMarketAlertsRead}
                onClearAlerts={clearMarketAlerts}
                onDismissToast={dismissMarketAlert}
                onSelectSymbol={(symbol, planId) => {
                  setActiveTab('dashboard');
                  setSelectedSymbol(symbol);
                  setViewMode('analysis');
                  setSelectedFollowPlanId(planId ?? null);
                  setHiddenFollowPlanId(null);
                }}
              />

              <QuoteStatus ticker={selectedTicker} tickerStatus={liveQuotes.tickerStatus} tradeStatus={liveQuotes.tradeStatus} onReconnect={liveQuotes.reconnect} />

              <button
                className="utility-icon-button"
                onClick={() => setTheme(prev => prev === 'light' ? 'dark' : 'light')}
                title={theme === 'light' ? '切換至深色模式' : '切換至日間模式'}
              >
                {theme === 'light' ? <Moon size={15} /> : <Sun size={15} />}
                <span>{theme === 'light' ? '深色' : '日間'}</span>
              </button>
            </div>

            {activeTab === 'dashboard' && (
              <div className="segmented-control">
                <button
                  className={viewMode === 'analysis' ? 'active' : ''}
                  onClick={() => setViewMode('analysis')}
                >
                  行情分析
                </button>
                <button
                  className={viewMode === 'cockpit' ? 'active' : ''}
                  onClick={() => setViewMode('cockpit')}
                >
                  模擬交易
                </button>
                <button
                  className={viewMode === 'bot' ? 'active' : ''}
                  onClick={() => setViewMode('bot')}
                >
                  策略回測
                </button>
                <button className={viewMode === 'auto' ? 'active' : ''} onClick={() => setViewMode('auto')}>自動交易</button>
              </div>
            )}

            <div className="segmented-control">
              <button
                disabled={autoTrading.marketLocked && marketType !== 'spot'}
                title={autoTrading.marketLocked ? '請先結束自動交易評估再切換市場' : undefined}
                className={marketType === 'spot' ? 'active' : ''}
                onClick={() => {
                  if (!autoTrading.marketLocked && marketType !== 'spot') setMarketType('spot');
                }}
              >
                現貨
              </button>
              <button
                disabled={autoTrading.marketLocked && marketType !== 'futures'}
                title={autoTrading.marketLocked ? '請先結束自動交易評估再切換市場' : undefined}
                className={marketType === 'futures' ? 'active' : ''}
                onClick={() => {
                  if (!autoTrading.marketLocked && marketType !== 'futures') setMarketType('futures');
                }}
              >
                合約
              </button>
            </div>
          </div>
        </div>

        {/* Top Scrolling Banner */}
        {!isAnalysis && viewMode !== 'auto' && <div className="market-banner">
          {bannerCoins.map((coin) => {
            const ticker = tickers[coin.symbol];
            if (!ticker) return null;
            const isUp = ticker.priceChangePercent >= 0;
            return (
              <div
                key={coin.symbol}
                className="banner-item"
                style={{ cursor: 'pointer', borderLeft: `3px solid ${isUp ? 'var(--trend-up)' : 'var(--trend-down)'}` }}
                onClick={() => {
                  setActiveTab('dashboard');
                  setSelectedSymbol(coin.symbol);
                  setViewMode('analysis');
                }}
              >
                <div>
                  <div style={{ fontWeight: 700, fontSize: '13px' }}>{coin.baseAsset}/USDT</div>
                  <div style={{ fontSize: '12px', marginTop: '2px', fontFamily: 'var(--font-display)', fontWeight: 600 }}>
                    ${formatCryptoPrice(ticker.price)}
                  </div>
                </div>
                <div className={isUp ? 'trend-up' : 'trend-down'} style={{ fontSize: '11px', fontWeight: 600 }}>
                  {isUp ? '+' : ''}{ticker.priceChangePercent.toFixed(2)}%
                </div>
              </div>
            );
          })}
        </div>}

        {/* Global Trend Reversal Warning Banner */}
        {viewMode !== 'auto' && reversalWarnings.length > 0 && (
          <div className="reversal-warning-banner">
            <div className="reversal-warning-header">
              <span className="warning-pulse-icon">⚠️</span>
              <span>檢測到持倉或掛單幣種存在急需反轉風險警告：</span>
            </div>
            <div className="reversal-warning-list">
              {reversalWarnings.map((key) => {
                const [symbol, type] = key.split(':');
                const base = symbol.replace('USDT', '');
                const ticker = tickers[symbol];
                const rate = fundingRates[symbol] || 0;
                const pct = ticker ? ticker.priceChangePercent : 0;
                let msg = '';
                if (type === 'LONG_OVERBOUGHT') {
                  msg = `${base} 多頭部位/掛單：24h 漲幅達 ${pct.toFixed(2)}% 已嚴重超買，隨時可能向下反轉回檔！`;
                } else if (type === 'LONG_HIGH_FUNDING') {
                  msg = `${base} 多頭部位/掛單：資金費率達 ${(rate * 100).toFixed(3)}% 偏高，持倉資金成本過重，防範多頭清算！`;
                } else if (type === 'SHORT_OVERSOLD') {
                  msg = `${base} 空頭部位/掛單：24h 跌幅達 ${pct.toFixed(2)}% 已嚴重超賣，防範空頭踩踏或超跌反彈反轉！`;
                } else if (type === 'SHORT_LOW_FUNDING') {
                  msg = `${base} 空頭部位/掛單：資金費率達 ${(rate * 100).toFixed(3)}% 極低，空單需支付高額費用，防範空頭擠壓 (Short Squeeze)！`;
                }
                return (
                  <div key={key} className="reversal-warning-item">
                    <span className="reversal-warning-item-dot"></span>
                    <span>{msg}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {activeTab === 'dashboard' && viewMode !== 'auto' && (
          <section className="focus-strip">
            <div className="focus-asset">
              {selectedCard.logo ? (
                <img src={selectedCard.logo} alt={selectedCard.name} />
              ) : (
                <div className="focus-logo-fallback">{coinSymbol.substring(0, 2)}</div>
              )}
              <div>
                <span className="focus-label">目前監控</span>
                <CoinPicker coins={coins} tickers={tickers} symbol={selectedSymbol} watchlist={watchlist} onSelect={setSelectedSymbol} />
                <small>{selectedCard.name}</small>
              </div>
            </div>

            <div className="focus-metric primary">
              <span>最新價格</span>
              <strong>{selectedTicker ? `$${formatCryptoPrice(selectedTicker.price)}` : '--'}</strong>
            </div>
            <div className="focus-metric">
              <span>24h 漲跌</span>
              <strong className={selectedIsUp ? 'trend-up-text' : 'trend-down-text'}>
                {selectedTicker ? `${selectedIsUp ? '+' : ''}${selectedChange.toFixed(2)}%` : '--'}
              </strong>
            </div>
            <div className="focus-metric">
              <span>24h 區間</span>
              <strong>
                {selectedTicker
                  ? `$${formatCryptoPrice(selectedTicker.low)} - $${formatCryptoPrice(selectedTicker.high)}`
                  : '--'}
              </strong>
            </div>
            <div className="focus-metric">
              <span>目前警報</span>
              <strong>{selectedMarketAlerts.length}</strong>
            </div>
          </section>
        )}

        <Suspense fallback={<div className="empty-state" role="status">載入工作區...</div>}>
        {/* Dashboard View */}
        {activeTab === 'dashboard' && (
          viewMode === 'analysis' ? (
            <AnalysisWorkspace
              coins={coins}
              tickers={tickers}
              selectedSymbol={selectedSymbol}
              onSelectSymbol={setSelectedSymbol}
              watchlist={watchlist}
              onToggleWatchlist={handleToggleWatchlist}
              marketType={marketType}
              fundingRates={fundingRates}
            >
              <ChartContainer
                symbol={selectedSymbol}
                coinName={selectedCard.name}
                logo={selectedCard.logo}
                currentPrice={selectedTicker ? selectedTicker.price : null}
                liveTicker={selectedTicker}
                marketType={marketType}
                alerts={selectedMarketAlerts}
                followPlan={visibleFollowPlan}
                onHideFollowPlan={() => setHiddenFollowPlanId(visibleFollowPlan?.id ?? null)}
                onOpenPaperTrade={handleTriggerOpenTradeModal}
                onQuickFollowTrade={marketType === 'futures' ? handleQuickFollowTrade : undefined}
                theme={theme}
              />
            </AnalysisWorkspace>
          ) : viewMode === 'auto' ? (
            <AutoTrading snapshot={autoTrading.snapshot} history={autoTrading.history}
              storageError={autoTrading.storageError} ready={autoTrading.ready} statusMessage={autoTrading.statusMessage}
              onStart={autoTrading.start} onPause={autoTrading.pause} onResume={autoTrading.resume}
              onDrain={autoTrading.drain} onCloseAll={autoTrading.closeAll} theme={theme}
              onSelectSymbol={(symbol, planId) => {
                const plan = autoTrading.history.flatMap(batch => batch.plans).find(item => item.id === planId);
                if (plan && plan.marketType !== marketType) {
                  if (autoTrading.marketLocked) return;
                  setMarketType(plan.marketType);
                }
                setSelectedSymbol(symbol); setSelectedFollowPlanId(planId ?? null);
                setViewMode('analysis'); setHiddenFollowPlanId(null);
              }} />
          ) : viewMode === 'bot' ? (
            <AutoBotLab
              symbol={selectedSymbol}
              marketType={marketType}
              currentPrice={selectedTicker ? selectedTicker.price : null}
              theme={theme}
            />
          ) : (
            <Cockpit
              coins={coins}
              tickers={tickers}
              onSelectSymbol={(sym) => {
                setSelectedSymbol(sym);
                setViewMode('analysis');
              }}
              fundingRates={fundingRates}
              paperTrades={paperTrades}
              paperBalance={paperBalance}
              paperHistory={paperHistory}
              reversalWarnings={reversalWarnings}
              onClosePaperTrade={handleClosePaperTrade}
              onOpenPaperTrade={handleTriggerOpenTradeModal}
              onCancelPendingOrder={handleCancelPendingOrder}
              onClearHistory={handleClearPaperHistory}
            />
          )
        )}

        {/* Portfolio View */}
        {activeTab === 'portfolio' && (
          <Portfolio tickers={tickers} coins={coins} marketType={marketType} />
        )}
        </Suspense>
      </main>

      {/* Trading Modal Overlay */}
      {tradingModal.isOpen && <TradingModal
        marketType={marketType}
        marketPrice={tickers[tradingModal.symbol]?.price ?? null}
        isOpen={tradingModal.isOpen}
        symbol={tradingModal.symbol}
        suggestedSide={tradingModal.suggestedSide}
        suggestedPrice={tradingModal.suggestedPrice}
        suggestedTp={tradingModal.suggestedTp}
        suggestedSl={tradingModal.suggestedSl}
        conservativeEntry={tradingModal.conservativeEntry}
        aggressiveEntry={tradingModal.aggressiveEntry}
        availableBalance={paperBalance}
        onClose={() => setTradingModal(prev => ({ ...prev, isOpen: false }))}
        onSubmit={handleOpenPaperTrade}
      />}
    </div>
  );
}
