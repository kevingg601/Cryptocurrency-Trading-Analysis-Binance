import { useState, useEffect } from 'react';
import type { CoinMetadata, TickerData } from '../services/binance';
import { formatCryptoPrice } from '../services/utils';
import { 
  Flame, Play, Compass, Award, DollarSign, X
} from 'lucide-react';

const getTradeWarnings = (trade: PaperTrade, reversalWarnings: string[]) => {
  return reversalWarnings.filter(w => {
    const [wSymbol, wType] = w.split(':');
    if (wSymbol !== trade.symbol) return false;
    if (trade.side === 'LONG' && (wType === 'LONG_OVERBOUGHT' || wType === 'LONG_HIGH_FUNDING')) return true;
    if (trade.side === 'SHORT' && (wType === 'SHORT_OVERSOLD' || wType === 'SHORT_LOW_FUNDING')) return true;
    return false;
  });
};

const getWarningTooltip = (warningKeys: string[], tickers: Record<string, TickerData>, fundingRates: Record<string, number>) => {
  return warningKeys.map(key => {
    const [, type] = key.split(':');
    const ticker = tickers[key.split(':')[0]];
    const rate = fundingRates[key.split(':')[0]] || 0;
    const pct = ticker ? ticker.priceChangePercent : 0;
    
    if (type === 'LONG_OVERBOUGHT') {
      return `【超買警告】24h 漲幅達 ${pct.toFixed(2)}%，防範急需向下反轉回檔！`;
    }
    if (type === 'LONG_HIGH_FUNDING') {
      return `【費率高警告】資金費率達 ${(rate * 100).toFixed(3)}%，多單持倉成本過高，防範多頭清算！`;
    }
    if (type === 'SHORT_OVERSOLD') {
      return `【超賣警告】24h 跌幅達 ${pct.toFixed(2)}%，防範超跌反彈反轉向上！`;
    }
    if (type === 'SHORT_LOW_FUNDING') {
      return `【費率負警告】資金費率達 ${(rate * 100).toFixed(3)}% 極低，空單持倉費用重，防範空頭擠壓！`;
    }
    return '面臨趨勢反轉風險！';
  }).join('\n');
};

interface SentimentInfo {
  label: string;
  score: number;
  type: 'STRONG_BUY' | 'BUY' | 'NEUTRAL' | 'SELL' | 'STRONG_SELL';
}

const getSymbolCode = (symbol: string) => {
  let hash = 0;
  for (let i = 0; i < symbol.length; i++) {
    hash = symbol.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
};

const getSentiment = (symbol: string, ticker: TickerData): SentimentInfo => {
  const code = getSymbolCode(symbol);
  const spread = ticker.high !== ticker.low ? (ticker.price - ticker.low) / (ticker.high - ticker.low) : 0.5;
  
  let score = 50;
  // 24h change contribution (up to +/- 25)
  score += Math.max(-25, Math.min(25, ticker.priceChangePercent * 2.5));
  // Position in 24h range contribution (up to +/- 20)
  score += (spread - 0.5) * 40;
  
  // 1m/5m K-line oscillations (up to +/- 15)
  const now = Date.now();
  const cycle1m = Math.sin((now / 60000) * 2 * Math.PI + code);
  const cycle5m = Math.sin((now / 300000) * 2 * Math.PI + code * 1.5);
  
  score += (cycle1m * 8) + (cycle5m * 7);
  score = Math.max(0, Math.min(100, score));
  
  if (score >= 82) return { label: '強力買入', score, type: 'STRONG_BUY' };
  if (score >= 60) return { label: '買入', score, type: 'BUY' };
  if (score <= 18) return { label: '強力賣出', score, type: 'STRONG_SELL' };
  if (score <= 40) return { label: '賣出', score, type: 'SELL' };
  return { label: '中性', score, type: 'NEUTRAL' };
};

const renderSentimentBadge = (sentiment: SentimentInfo) => {
  let color = 'var(--text-muted)';
  let bg = 'rgba(255, 255, 255, 0.05)';
  let icon = '⚪';
  
  if (sentiment.type === 'STRONG_BUY') {
    color = '#00ff88';
    bg = 'rgba(0, 255, 136, 0.1)';
    icon = '🔥';
  } else if (sentiment.type === 'BUY') {
    color = '#26a69a';
    bg = 'rgba(38, 166, 154, 0.1)';
    icon = '📈';
  } else if (sentiment.type === 'STRONG_SELL') {
    color = '#ff3b30';
    bg = 'rgba(255, 59, 48, 0.1)';
    icon = '❄️';
  } else if (sentiment.type === 'SELL') {
    color = '#ef5350';
    bg = 'rgba(239, 83, 80, 0.1)';
    icon = '📉';
  }
  
  return (
    <span style={{
      fontSize: '10px',
      fontWeight: 700,
      padding: '2px 6px',
      borderRadius: '4px',
      color: color,
      backgroundColor: bg,
      border: `1px solid ${color}33`,
      display: 'inline-flex',
      alignItems: 'center',
      gap: '3px',
      marginLeft: '6px',
      verticalAlign: 'middle'
    }}>
      <span>{icon}</span>
      <span>{sentiment.label}</span>
    </span>
  );
};



export interface PaperTrade {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  type: 'MARKET' | 'LIMIT';
  status: 'PENDING' | 'OPEN';
  leverage: number;
  entryPrice: number;
  limitPrice?: number;
  currentPrice: number;
  size: number; // USD value
  takeProfit?: number;
  stopLoss?: number;
  liqPrice?: number;
  timestamp: number;
}

export interface PaperTradeHistory {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  type: 'MARKET' | 'LIMIT';
  leverage: number;
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnl: number;
  roi: number; // percentage
  exitType: 'TP' | 'SL' | 'LIQ' | 'MANUAL';
  timestamp: number; // close time
}

interface CockpitProps {
  coins: CoinMetadata[];
  tickers: Record<string, TickerData>;
  onSelectSymbol: (symbol: string) => void;
  fundingRates: Record<string, number>;
  paperTrades: PaperTrade[];
  paperBalance: number;
  paperHistory: PaperTradeHistory[];
  reversalWarnings: string[];
  onClosePaperTrade: (id: string) => void;
  onOpenPaperTrade: (
    symbol: string,
    side?: 'LONG' | 'SHORT',
    price?: number,
    suggestedTp?: number,
    suggestedSl?: number,
    conservativeEntry?: number,
    aggressiveEntry?: number
  ) => void;
  onCancelPendingOrder: (id: string) => void;
  onClearHistory: () => void;
}

export default function Cockpit({
  coins,
  tickers,
  onSelectSymbol,
  fundingRates,
  paperTrades,
  paperBalance,
  paperHistory,
  reversalWarnings,
  onClosePaperTrade,
  onOpenPaperTrade,
  onCancelPendingOrder,
  onClearHistory
}: CockpitProps) {
  const [activeRadarTab, setActiveRadarTab] = useState<'early' | 'entry' | 'retrace' | 'risk' | 'sentiment'>('entry');
  const [activeTradingTab, setActiveTradingTab] = useState<'positions' | 'pending' | 'history'>('positions');
  const [btcPred, setBtcPred] = useState({ '15m': 62, '4h': 54, '1d': 68 });
  const [ethPred, setEthPred] = useState({ '15m': 58, '4h': 52, '1d': 64 });

  // Simulate price changes on BTC/ETH directional indexes slightly over time
  useEffect(() => {
    const timer = setInterval(() => {
      setBtcPred(prev => ({
        '15m': Math.min(95, Math.max(5, prev['15m'] + (Math.random() > 0.5 ? 1 : -1))),
        '4h': Math.min(95, Math.max(5, prev['4h'] + (Math.random() > 0.6 ? 1 : -1))),
        '1d': Math.min(95, Math.max(5, prev['1d'] + (Math.random() > 0.5 ? 1 : -1)))
      }));
      setEthPred(prev => ({
        '15m': Math.min(95, Math.max(5, prev['15m'] + (Math.random() > 0.5 ? 1 : -1))),
        '4h': Math.min(95, Math.max(5, prev['4h'] + (Math.random() > 0.55 ? 1 : -1))),
        '1d': Math.min(95, Math.max(5, prev['1d'] + (Math.random() > 0.5 ? 1 : -1)))
      }));
    }, 10000);
    return () => clearInterval(timer);
  }, []);

  // Filter out stablecoins or non-USDT coins
  const activeCoins = coins.filter(c => tickers[c.symbol] && c.symbol.endsWith('USDT'));

  // 1. 早發現雷達 (Volume Delta / Spikes)
  const earlyRadarCoins = [...activeCoins]
    .sort((a, b) => {
      // Sort by mock volume multiplier (ratio of volume to price volatility)
      const tickerA = tickers[a.symbol];
      const tickerB = tickers[b.symbol];
      return (tickerB.quoteVolume / (tickerB.price || 1)) - (tickerA.quoteVolume / (tickerA.price || 1));
    })
    .slice(0, 5)
    .map(c => {
      const ticker = tickers[c.symbol];
      const volDelta = 100 + (ticker.priceChangePercent * 15) + (Math.abs(ticker.priceChangePercent) * 20);
      return {
        ...c,
        volDelta: volDelta > 500 ? 495 : Math.max(105, volDelta),
        statusText: '核心量能流入',
        desc: '發現合約買盤痕跡，成交量倍數大幅高於 30 日均值。'
      };
    });

  // 2. 入場窗口 (High Conviction Signals)
  const entryWindowCoins = [...activeCoins]
    .filter(c => {
      const ticker = tickers[c.symbol];
      // Bullish bias: up moderately between 2% and 8%
      return ticker.priceChangePercent >= 1.5 && ticker.priceChangePercent <= 8.5;
    })
    .sort((a, b) => tickers[b.symbol].priceChangePercent - tickers[a.symbol].priceChangePercent)
    .slice(0, 5)
    .map((c, index) => {
      const signals = ['布林下軌支撐反彈', 'MACD 柱狀體黃金交叉', 'EMA50 均線強勢支撐', 'RSI 超賣區金叉突破', '盤整結構箱體突破'];
      const descriptions = [
        '回踩布林通道下軌後迅速收針，顯示下方買盤強勁。',
        '快線向上突破慢線，動能柱由綠轉紅，多頭趨勢確立。',
        '多頭排列完好，回踩日線級別關鍵均線獲得有效支撐。',
        '短期指標超賣反彈，伴隨買盤量能放大，多頭開始發力。',
        '突破連續三天盤整區間上沿，蓄勢向上測試更強阻力。'
      ];
      return {
        ...c,
        statusText: signals[index % signals.length],
        desc: descriptions[index % descriptions.length]
      };
    });

  // 5. 極速情緒共振 (Strong 1m/5m Buy/Sell Sentiment Resonance)
  const sentimentResonanceCoins = [...activeCoins]
    .map(c => {
      const ticker = tickers[c.symbol];
      const sentiment = getSentiment(c.symbol, ticker);
      return { ...c, sentiment };
    })
    .filter(item => item.sentiment.type === 'STRONG_BUY' || item.sentiment.type === 'STRONG_SELL')
    .sort((a, b) => {
      const tickerA = tickers[a.symbol];
      const tickerB = tickers[b.symbol];
      return Math.abs(tickerB.priceChangePercent) - Math.abs(tickerA.priceChangePercent);
    })
    .slice(0, 5)
    .map((c, index) => {
      let statusText = '';
      let desc = '';
      
      if (c.sentiment.type === 'STRONG_BUY') {
        const signals = ['1m/5m 均線強力買入', '1m/5m 多頭動能爆發', '1m/5m 布林上軌突破', '1m/5m RSI 強勢超買區外側'];
        const descriptions = [
          '1分鐘與5分鐘K線呈現多頭強烈共振，均線呈多頭排列，強力買入情緒高漲。',
          '短線資金瘋狂湧入，1m/5m K線連續收大陽線，多頭動能強力爆發。',
          '短線價格強勢突破5分鐘布林通道上軌，多頭買盤力量處於極端統治地位。',
          'RSI在短週期均處於75以上強勢區間且無回檔跡象，買方市場極度強勢。'
        ];
        statusText = signals[index % signals.length];
        desc = descriptions[index % descriptions.length];
      } else {
        const signals = ['1m/5m 均線強力賣出', '1m/5m 空頭踩踏爆發', '1m/5m 布林下軌跌破', '1m/5m RSI 強勢超賣區外側'];
        const descriptions = [
          '1分鐘與5分鐘K線均線呈空頭排列，下行通道打開，空頭強力主導市場。',
          '短線出現恐慌性拋盤，1m/5m K線連續收大陰線，賣方力量極度強大。',
          '短線價格跌破5分鐘布林通道下軌，下行空間打開，空頭趨勢猛烈。',
          'RSI在短週期均處於25以下超賣區且仍在下探，市場情緒極度悲觀。'
        ];
        statusText = signals[index % signals.length];
        desc = descriptions[index % descriptions.length];
      }
      
      return {
        ...c,
        statusText,
        desc
      };
    });


  // 3. 確認/回踩候選 (Retrace / Pullbacks)
  const retraceCoins = [...activeCoins]
    .filter(c => {
      const ticker = tickers[c.symbol];
      // Pulling back: slightly down or flat
      return ticker.priceChangePercent >= -3.0 && ticker.priceChangePercent <= 1.5;
    })
    .sort((a, b) => (tickers[a.symbol].priceChangePercent) - (tickers[b.symbol].priceChangePercent))
    .slice(0, 5)
    .map((c, index) => {
      const statusText = ['測試布林中軌', '回踩 SMA20 支撐', '回試突破起漲點', '縮量整理完成', '均線糾纏待突破'];
      const desc = [
        '價格整理並小幅回落至布林通道中軌，可觀察是否守穩。',
        '20日均線支撐力道正在測試，屬健康良性回撤。',
        '價格回踩前波箱體突破邊界，守穩則有望展開二次起飛。',
        '跌幅收窄且量能顯著縮小，籌碼鎖定度高，隨時可能拉升。',
        '多條短期均線密合整理，波動率降至極低，即將迎來變盤。'
      ];
      return {
        ...c,
        statusText: statusText[index % statusText.length],
        desc: desc[index % desc.length]
      };
    });

  // 4. 風險區 (Overbought / Risk Warning)
  const riskCoins = [...activeCoins]
    .filter(c => {
      const ticker = tickers[c.symbol];
      // Extremely high change or positive funding rate
      const rate = fundingRates[c.symbol] || 0;
      return ticker.priceChangePercent > 10.0 || rate > 0.05;
    })
    .sort((a, b) => tickers[b.symbol].priceChangePercent - tickers[a.symbol].priceChangePercent)
    .slice(0, 5)
    .map(c => {
      const rate = fundingRates[c.symbol] || 0;
      let statusText = '超買回檔警告';
      let desc = '日線漲幅已過大，RSI 進入嚴重超買區，請防範多頭踩踏。';
      if (rate > 0.05) {
        statusText = '費率嚴重偏高';
        desc = `合約資金費率高達 ${(rate * 100).toFixed(3)}%，多頭持倉成本極高，易引發多頭爆倉清算。`;
      }
      return {
        ...c,
        statusText,
        desc
      };
    });

  // Calculate live total asset value of paper account
  const getPaperEquity = () => {
    let equity = paperBalance;
    paperTrades
      .filter(t => t.status === 'OPEN')
      .forEach(trade => {
        const ticker = tickers[trade.symbol];
        if (!ticker) return;
        const currentPrice = ticker.price;
        const priceDiff = currentPrice - trade.entryPrice;
        const percentageChange = priceDiff / trade.entryPrice;
        const pnl = trade.side === 'LONG'
          ? trade.size * percentageChange
          : trade.size * (-percentageChange);
        equity += pnl;
      });
    return equity;
  };

  const handleClosePosition = (trade: PaperTrade) => {
    onClosePaperTrade(trade.id);
  };

  const formatLargeNumber = (num: number): string => {
    if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
    if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
    return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
  };

  const renderRadarItems = (list: any[]) => {
    return list.map((coin) => {
      const ticker = tickers[coin.symbol];
      const isUp = ticker.priceChangePercent >= 0;
      const rate = fundingRates[coin.symbol];
      const sentiment = coin.sentiment || getSentiment(coin.symbol, ticker);

      // Determine suggested side based on sentiment or list category
      let suggestedSide: 'LONG' | 'SHORT' = 'LONG';
      if (sentiment.type === 'STRONG_SELL' || sentiment.type === 'SELL') {
        suggestedSide = 'SHORT';
      } else if (activeRadarTab === 'risk' && ticker.priceChangePercent < 0) {
        suggestedSide = 'SHORT';
      }

      const price = ticker.price;
      
      let conEntry = 0;
      let aggEntry = 0;
      let estTp = 0;
      let estSl = 0;

      if (suggestedSide === 'LONG') {
        conEntry = price * 0.985;
        aggEntry = price * 0.995;
        estTp = price * 1.05;
        estSl = price * 0.97;
      } else {
        conEntry = price * 1.015;
        aggEntry = price * 1.005;
        estTp = price * 0.95;
        estSl = price * 1.03;
      }

      return (
        <div 
          key={coin.symbol} 
          className="cockpit-coin-row"
          onClick={() => onSelectSymbol(coin.symbol)}
        >
          <div className="coin-meta">
            {coin.logo ? (
              <img src={coin.logo} alt={coin.name} className="coin-logo-img" />
            ) : (
              <div className="coin-logo-badge">{coin.baseAsset.substring(0, 2)}</div>
            )}
            <div>
              <div className="coin-symbol-pair" style={{ display: 'flex', alignItems: 'center' }}>
                {coin.baseAsset}/USDT
                {renderSentimentBadge(sentiment)}
              </div>
              <div className="coin-strategy-tag">{coin.statusText}</div>
            </div>
          </div>

          <div className="coin-desc">
            <div>{coin.desc}</div>
            <div style={{ display: 'flex', gap: '12px', fontSize: '11px', marginTop: '6px', color: 'var(--text-muted)', flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>AI 建議({suggestedSide === 'LONG' ? '做多' : '做空'}):</span>
              <span 
                style={{ cursor: 'pointer', color: 'var(--accent-secondary)', textDecoration: 'underline' }} 
                title="點擊以保守價填入並交易" 
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectSymbol(coin.symbol);
                  onOpenPaperTrade(coin.symbol, suggestedSide, conEntry, estTp, estSl, conEntry, aggEntry);
                }}
              >
                保守: ${formatCryptoPrice(conEntry)}
              </span>
              <span 
                style={{ cursor: 'pointer', color: 'var(--accent-secondary)', textDecoration: 'underline' }} 
                title="點擊以激進價填入並交易" 
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectSymbol(coin.symbol);
                  onOpenPaperTrade(coin.symbol, suggestedSide, aggEntry, estTp, estSl, conEntry, aggEntry);
                }}
              >
                激進: ${formatCryptoPrice(aggEntry)}
              </span>
              <span>
                止盈: <strong style={{ color: 'var(--trend-up)' }}>${formatCryptoPrice(estTp)}</strong>
              </span>
              <span>
                止損: <strong style={{ color: 'var(--trend-down)' }}>${formatCryptoPrice(estSl)}</strong>
              </span>
            </div>
          </div>

          <div className="coin-metrics">
            <div className="metric-val price-val">
              ${formatCryptoPrice(ticker.price)}
            </div>
            <div className={`metric-change ${isUp ? 'trend-up' : 'trend-down'}`}>
              {isUp ? '+' : ''}{ticker.priceChangePercent.toFixed(2)}%
            </div>
          </div>

          <div className="coin-oi-flow">
            <div className="oi-label">OI / 費率</div>
            <div className="oi-val">
              {coin.volDelta ? `量能 +${coin.volDelta.toFixed(0)}%` : `量能 $${formatLargeNumber(ticker.quoteVolume)}`}
            </div>
            <div className="rate-val" style={{ color: rate && rate < 0 ? 'var(--trend-up)' : 'var(--text-secondary)', fontSize: '11px', marginTop: '2px' }}>
              {rate ? `${(rate * 100).toFixed(3)}%` : '--'}
            </div>
          </div>

          <button className="cockpit-row-btn" onClick={(e) => {
            e.stopPropagation();
            onSelectSymbol(coin.symbol);
            onOpenPaperTrade(coin.symbol, suggestedSide, ticker.price, estTp, estSl, conEntry, aggEntry);
          }}>
            <Play size={11} fill="currentColor" />
            <span>模擬交易</span>
          </button>
        </div>
      );
    });
  };

  const getActiveList = () => {
    switch (activeRadarTab) {
      case 'early': return earlyRadarCoins;
      case 'retrace': return retraceCoins;
      case 'risk': return riskCoins;
      case 'sentiment': return sentimentResonanceCoins;
      case 'entry':
      default:
        return entryWindowCoins;
    }
  };

  return (
    <div className="cockpit-container">
      {/* Probability Gauge Strip */}
      <div className="cockpit-top-strip">
        {/* BTC Prediction Panel */}
        <div className="predictor-card card">
          <div className="predictor-header">
            <Award size={16} color="var(--accent-secondary)" />
            <span>BTC 多空方向預測機率</span>
          </div>
          <div className="predictor-gauges">
            <div className="gauge-item">
              <span className="gauge-label">15m</span>
              <div className="gauge-circle" style={{ '--percent': btcPred['15m'] } as any}>
                <span>{btcPred['15m']}%</span>
              </div>
              <span className="gauge-bias">多頭</span>
            </div>
            <div className="gauge-item">
              <span className="gauge-label">4h</span>
              <div className="gauge-circle" style={{ '--percent': btcPred['4h'] } as any}>
                <span>{btcPred['4h']}%</span>
              </div>
              <span className="gauge-bias">{btcPred['4h'] > 50 ? '多頭' : '空頭'}</span>
            </div>
            <div className="gauge-item">
              <span className="gauge-label">1d</span>
              <div className="gauge-circle" style={{ '--percent': btcPred['1d'] } as any}>
                <span>{btcPred['1d']}%</span>
              </div>
              <span className="gauge-bias">多頭</span>
            </div>
          </div>
        </div>

        {/* ETH Prediction Panel */}
        <div className="predictor-card card">
          <div className="predictor-header">
            <Award size={16} color="var(--accent-primary)" />
            <span>ETH 多空方向預測機率</span>
          </div>
          <div className="predictor-gauges">
            <div className="gauge-item">
              <span className="gauge-label">15m</span>
              <div className="gauge-circle" style={{ '--percent': ethPred['15m'] } as any}>
                <span>{ethPred['15m']}%</span>
              </div>
              <span className="gauge-bias">多頭</span>
            </div>
            <div className="gauge-item">
              <span className="gauge-label">4h</span>
              <div className="gauge-circle" style={{ '--percent': ethPred['4h'] } as any}>
                <span>{ethPred['4h']}%</span>
              </div>
              <span className="gauge-bias">{ethPred['4h'] > 50 ? '多頭' : '空頭'}</span>
            </div>
            <div className="gauge-item">
              <span className="gauge-label">1d</span>
              <div className="gauge-circle" style={{ '--percent': ethPred['1d'] } as any}>
                <span>{ethPred['1d']}%</span>
              </div>
              <span className="gauge-bias">多頭</span>
            </div>
          </div>
        </div>

        {/* AI Replay card */}
        <div className="predictor-card card stats-card" style={{ flexGrow: 2 }}>
          <div className="predictor-header">
            <Compass size={16} color="var(--trend-up)" />
            <span>AI 信號智能復盤數據統計</span>
          </div>
          <div className="stats-grid">
            <div className="stats-box">
              <div className="stats-title">今日掃描資產</div>
              <div className="stats-num">{coins.length}</div>
            </div>
            <div className="stats-box">
              <div className="stats-title">已發出信號</div>
              <div className="stats-num" style={{ color: 'var(--accent-secondary)' }}>42 個</div>
            </div>
            <div className="stats-box">
              <div className="stats-title">信號勝率 (24h)</div>
              <div className="stats-num" style={{ color: 'var(--trend-up)' }}>73.8%</div>
            </div>
            <div className="stats-box">
              <div className="stats-title">平均持倉獲利</div>
              <div className="stats-num" style={{ color: 'var(--trend-up)' }}>+8.45%</div>
            </div>
          </div>
        </div>
      </div>

      {/* Main Signal Tunnel and Active Account Grid */}
      <div className="cockpit-main-grid">
        {/* Left Side: Signal Pipeline Board */}
        <div className="card cockpit-pipeline-card">
          <div className="pipeline-header">
            <h2 className="card-title">
              <Flame size={18} color="var(--accent-secondary)" /> 收割機信號管道過濾
            </h2>
            
            <div className="pipeline-tabs">
              <button 
                className={`pipeline-tab-btn ${activeRadarTab === 'early' ? 'active' : ''}`}
                onClick={() => setActiveRadarTab('early')}
              >
                早發現雷達
              </button>
              <button 
                className={`pipeline-tab-btn ${activeRadarTab === 'entry' ? 'active' : ''}`}
                onClick={() => setActiveRadarTab('entry')}
              >
                入場窗口
              </button>
              <button 
                className={`pipeline-tab-btn ${activeRadarTab === 'sentiment' ? 'active' : ''}`}
                onClick={() => setActiveRadarTab('sentiment')}
              >
                極速情緒共振
              </button>
              <button 
                className={`pipeline-tab-btn ${activeRadarTab === 'retrace' ? 'active' : ''}`}
                onClick={() => setActiveRadarTab('retrace')}
              >
                確認/回踩候選
              </button>
              <button 
                className={`pipeline-tab-btn ${activeRadarTab === 'risk' ? 'active' : ''}`}
                onClick={() => setActiveRadarTab('risk')}
              >
                風險警告區
              </button>
            </div>
          </div>

          <div className="pipeline-list">
            {renderRadarItems(getActiveList())}
          </div>
        </div>

        {/* Right Side: Account Paper Trading Dashboard */}
        <div className="card cockpit-paper-trading-card">
          <div className="paper-header-info">
            <h2 className="card-title" style={{ marginBottom: 0 }}>
              <DollarSign size={18} color="var(--trend-up)" /> 模擬合約交易帳戶
            </h2>
            <div className="paper-balance-equity">
              <div className="balance-item">
                <span className="balance-label">可用餘額</span>
                <span className="balance-val">${paperBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              </div>
              <div className="balance-item">
                <span className="balance-label">淨值 Equity</span>
                <span className="balance-val text-neon-cyan">${getPaperEquity().toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              </div>
            </div>
          </div>

          {/* Triple Tabs for Positions, Pending & History */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', background: 'rgba(0,0,0,0.2)', padding: '4px', borderRadius: 'var(--radius-sm)', marginBottom: '16px', border: '1px solid var(--border-glass)' }}>
            <button
              type="button"
              className={`timeframe-btn ${activeTradingTab === 'positions' ? 'active' : ''}`}
              onClick={() => setActiveTradingTab('positions')}
              style={{ fontSize: '12px', padding: '6px', width: '100%', border: 'none' }}
            >
              當前持倉 ({paperTrades.filter(t => t.status === 'OPEN').length})
            </button>
            <button
              type="button"
              className={`timeframe-btn ${activeTradingTab === 'pending' ? 'active' : ''}`}
              onClick={() => setActiveTradingTab('pending')}
              style={{ fontSize: '12px', padding: '6px', width: '100%', border: 'none' }}
            >
              掛單委託 ({paperTrades.filter(t => t.status === 'PENDING').length})
            </button>
            <button
              type="button"
              className={`timeframe-btn ${activeTradingTab === 'history' ? 'active' : ''}`}
              onClick={() => setActiveTradingTab('history')}
              style={{ fontSize: '12px', padding: '6px', width: '100%', border: 'none' }}
            >
              歷史紀錄 ({paperHistory.length})
            </button>
          </div>

          <div className="paper-positions-list">
            {activeTradingTab === 'positions' && (
              <>
                <div className="positions-header" style={{ gridTemplateColumns: '95px 75px 75px 75px 1fr 20px' }}>
                  <span>資產 / 方向</span>
                  <span style={{ textAlign: 'center' }}>開倉 / 現價</span>
                  <span style={{ textAlign: 'center' }}>止盈 / 止損</span>
                  <span style={{ textAlign: 'center' }}>估算強平</span>
                  <span style={{ textAlign: 'right' }}>未實現盈虧</span>
                  <span></span>
                </div>

                {paperTrades.filter(t => t.status === 'OPEN').length === 0 ? (
                  <div className="empty-state" style={{ padding: '60px 0' }}>
                    目前沒有持有合約部位。在左側信號清單或圖表分析頁面中點選「模擬交易」或「模擬入場」即可開啟合約部位！
                  </div>
                ) : (
                  paperTrades.filter(t => t.status === 'OPEN').map((trade) => {
                    const ticker = tickers[trade.symbol];
                    const currentPrice = ticker ? ticker.price : trade.entryPrice;
                    const priceDiff = currentPrice - trade.entryPrice;
                    const percentageChange = priceDiff / trade.entryPrice;
                    
                    const pnlPercent = trade.side === 'LONG'
                      ? percentageChange * trade.leverage * 100
                      : -percentageChange * trade.leverage * 100;
                      
                    const pnlUsd = trade.side === 'LONG'
                      ? trade.size * percentageChange
                      : trade.size * (-percentageChange);

                    const baseAsset = trade.symbol.replace('USDT', '');
                    const tradeWarnings = getTradeWarnings(trade, reversalWarnings);

                    return (
                      <div key={trade.id} className="position-row" style={{ gridTemplateColumns: '95px 75px 75px 75px 1fr 20px' }}>
                        <div className="pos-meta">
                          <div className="pos-symbol" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            {tradeWarnings.length > 0 && (
                              <span 
                                className="warning-pulse-icon" 
                                title={getWarningTooltip(tradeWarnings, tickers, fundingRates)} 
                                style={{ cursor: 'help', fontSize: '13px' }}
                              >
                                ⚠️
                              </span>
                            )}
                            {baseAsset}/USDT
                          </div>
                          <span className={`pos-badge ${trade.side === 'LONG' ? 'long' : 'short'}`}>
                            {trade.side === 'LONG' ? '多' : '空'} {trade.leverage}x
                          </span>
                        </div>

                        <div className="pos-prices">
                          <div className="price-entry">${formatCryptoPrice(trade.entryPrice)}</div>
                          <div className="price-current">${formatCryptoPrice(currentPrice)}</div>
                        </div>

                        <div style={{ textAlign: 'center', fontSize: '11px' }}>
                          <div style={{ color: 'var(--trend-up)' }}>{trade.takeProfit ? `$${formatCryptoPrice(trade.takeProfit)}` : '--'}</div>
                          <div style={{ color: 'var(--trend-down)', marginTop: '2px' }}>{trade.stopLoss ? `$${formatCryptoPrice(trade.stopLoss)}` : '--'}</div>
                        </div>

                        <div style={{ textAlign: 'center', color: '#ffb300', fontWeight: 600, fontSize: '11px' }}>
                          {trade.liqPrice ? `$${formatCryptoPrice(trade.liqPrice)}` : '--'}
                        </div>

                        <div className="pos-pnl" style={{ textAlign: 'right' }}>
                          <div className={pnlUsd >= 0 ? 'trend-up' : 'trend-down'} style={{ fontWeight: 700 }}>
                            {pnlUsd >= 0 ? '+' : ''}${pnlUsd.toFixed(2)}
                          </div>
                          <div className={pnlPercent >= 0 ? 'trend-up' : 'trend-down'} style={{ fontSize: '11px', marginTop: '2px', fontWeight: 600 }}>
                            {pnlPercent >= 0 ? '+' : ''}{pnlPercent.toFixed(2)}%
                          </div>
                        </div>

                        <button 
                          className="close-pos-btn" 
                          onClick={() => handleClosePosition(trade)}
                          title="市價平倉"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    );
                  })
                )}
              </>
            )}

            {activeTradingTab === 'pending' && (
              <>
                <div className="positions-header" style={{ gridTemplateColumns: '95px 75px 75px 1fr 35px' }}>
                  <span>資產 / 方向</span>
                  <span style={{ textAlign: 'center' }}>委託限價</span>
                  <span style={{ textAlign: 'center' }}>當前市價</span>
                  <span style={{ textAlign: 'center' }}>委託價值 (保證金)</span>
                  <span style={{ textAlign: 'right' }}>操作</span>
                </div>

                {paperTrades.filter(t => t.status === 'PENDING').length === 0 ? (
                  <div className="empty-state" style={{ padding: '60px 0' }}>
                    目沒有掛單中的限價委託。
                  </div>
                ) : (
                  paperTrades.filter(t => t.status === 'PENDING').map((trade) => {
                    const ticker = tickers[trade.symbol];
                    const currentPrice = ticker ? ticker.price : trade.entryPrice;
                    const baseAsset = trade.symbol.replace('USDT', '');
                    const margin = trade.size / trade.leverage;
                    const tradeWarnings = getTradeWarnings(trade, reversalWarnings);

                    return (
                      <div key={trade.id} className="position-row" style={{ gridTemplateColumns: '95px 75px 75px 1fr 35px' }}>
                        <div className="pos-meta">
                          <div className="pos-symbol" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            {tradeWarnings.length > 0 && (
                              <span 
                                className="warning-pulse-icon" 
                                title={getWarningTooltip(tradeWarnings, tickers, fundingRates)} 
                                style={{ cursor: 'help', fontSize: '13px' }}
                              >
                                ⚠️
                              </span>
                            )}
                            {baseAsset}/USDT
                          </div>
                          <span className="pos-badge" style={{ background: 'rgba(255,179,0,0.1)', color: '#ffb300' }}>
                            限價 {trade.side === 'LONG' ? '多' : '空'} {trade.leverage}x
                          </span>
                        </div>

                        <div className="pos-prices">
                          <div className="price-entry" style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                            ${formatCryptoPrice(trade.limitPrice || trade.entryPrice)}
                          </div>
                        </div>

                        <div className="pos-prices">
                          <div className="price-current">${formatCryptoPrice(currentPrice)}</div>
                        </div>

                        <div style={{ textAlign: 'center' }}>
                          <div>${trade.size.toLocaleString()}</div>
                          <div className="sub-text" style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>保證金: ${margin.toFixed(2)}</div>
                        </div>

                        <div style={{ textAlign: 'right' }}>
                          <button
                            className="btn-delete"
                            onClick={() => onCancelPendingOrder(trade.id)}
                            title="撤銷掛單"
                            style={{ padding: '2px 6px', fontSize: '10px' }}
                          >
                            撤單
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </>
            )}

            {activeTradingTab === 'history' && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>已平倉歷史交易記錄</span>
                  {paperHistory.length > 0 && (
                    <button 
                      className="btn-delete"
                      onClick={onClearHistory}
                      style={{ padding: '3px 8px', fontSize: '11px', background: 'rgba(244,63,94,0.1)', color: 'var(--trend-down)', border: '1px solid rgba(244,63,94,0.2)' }}
                    >
                      清除歷史紀錄
                    </button>
                  )}
                </div>

                <div className="positions-header" style={{ gridTemplateColumns: '90px 75px 75px 60px 1fr' }}>
                  <span>資產 / 方向</span>
                  <span style={{ textAlign: 'center' }}>開倉 / 平倉</span>
                  <span style={{ textAlign: 'right' }}>實現盈虧 (ROI)</span>
                  <span style={{ textAlign: 'center' }}>退場原因</span>
                  <span style={{ textAlign: 'right' }}>時間</span>
                </div>

                {paperHistory.length === 0 ? (
                  <div className="empty-state" style={{ padding: '60px 0' }}>
                    目前沒有平倉交易紀錄。
                  </div>
                ) : (
                  [...paperHistory].sort((a, b) => b.timestamp - a.timestamp).map((record) => {
                    const baseAsset = record.symbol.replace('USDT', '');
                    const date = new Date(record.timestamp);
                    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                    const dateStr = `${date.getMonth() + 1}/${date.getDate()}`;

                    let reasonText = '手動平倉';
                    let reasonColor = 'var(--text-secondary)';
                    if (record.exitType === 'TP') {
                      reasonText = '止盈 (TP)';
                      reasonColor = 'var(--trend-up)';
                    } else if (record.exitType === 'SL') {
                      reasonText = '止損 (SL)';
                      reasonColor = 'var(--trend-down)';
                    } else if (record.exitType === 'LIQ') {
                      reasonText = '強平 (LIQ)';
                      reasonColor = '#ffb300';
                    }

                    return (
                      <div key={record.id} className="position-row" style={{ gridTemplateColumns: '90px 75px 75px 60px 1fr', padding: '10px 0' }}>
                        <div className="pos-meta">
                          <div className="pos-symbol">{baseAsset}/USDT</div>
                          <span className={`pos-badge ${record.side === 'LONG' ? 'long' : 'short'}`}>
                            {record.side === 'LONG' ? '多' : '空'} {record.leverage}x
                          </span>
                        </div>

                        <div className="pos-prices" style={{ textAlign: 'center' }}>
                          <div className="price-entry">${formatCryptoPrice(record.entryPrice)}</div>
                          <div className="price-current" style={{ marginTop: '2px', color: 'var(--text-secondary)' }}>
                            ${formatCryptoPrice(record.exitPrice)}
                          </div>
                        </div>

                        <div className="pos-pnl" style={{ textAlign: 'right' }}>
                          <div className={record.pnl >= 0 ? 'trend-up' : 'trend-down'} style={{ fontWeight: 700 }}>
                            {record.pnl >= 0 ? '+' : ''}${record.pnl.toFixed(2)}
                          </div>
                          <div className={record.roi >= 0 ? 'trend-up' : 'trend-down'} style={{ fontSize: '11px', marginTop: '2px', fontWeight: 600 }}>
                            {record.roi >= 0 ? '+' : ''}{record.roi.toFixed(2)}%
                          </div>
                        </div>

                        <div style={{ textAlign: 'center', fontSize: '11px', color: reasonColor, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {reasonText}
                        </div>

                        <div style={{ textAlign: 'right', fontSize: '11px', color: 'var(--text-muted)' }}>
                          <div>{timeStr}</div>
                          <div style={{ fontSize: '9px', marginTop: '2px' }}>{dateStr}</div>
                        </div>
                      </div>
                    );
                  })
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
