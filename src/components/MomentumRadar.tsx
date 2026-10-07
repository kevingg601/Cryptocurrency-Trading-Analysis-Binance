import { useState } from 'react';
import type { CoinMetadata, TickerData } from '../services/binance';
import { Flame, TrendingUp, AlertTriangle } from 'lucide-react';
import { formatCryptoPrice } from '../services/utils';

interface MomentumRadarProps {
  coins: CoinMetadata[];
  tickers: Record<string, TickerData>;
  onSelectSymbol: (symbol: string) => void;
  selectedSymbol: string;
}

type RadarTab = 'demon' | 'accumulating' | 'overbought';

export default function MomentumRadar({
  coins,
  tickers,
  onSelectSymbol,
  selectedSymbol
}: MomentumRadarProps) {
  const [activeTab, setActiveTab] = useState<RadarTab>('demon');

  // Filter and sort coins based on selected tab
  const getRadarList = () => {
    // Only analyze coins that have active ticker data
    const activeCoins = coins.filter(c => tickers[c.symbol]);

    if (activeTab === 'demon') {
      // Demon Coins: Highest 24h price percentage gainers
      return [...activeCoins]
        .sort((a, b) => {
          const changeA = tickers[a.symbol]?.priceChangePercent || 0;
          const changeB = tickers[b.symbol]?.priceChangePercent || 0;
          return changeB - changeA;
        })
        .slice(0, 5);
    } 
    
    if (activeTab === 'accumulating') {
      // Accumulating: Up moderately (1.5% to 5.0%) with high 24h volume
      return activeCoins
        .filter(c => {
          const change = tickers[c.symbol]?.priceChangePercent || 0;
          return change >= 1.5 && change <= 5.0;
        })
        .sort((a, b) => {
          const volA = tickers[a.symbol]?.quoteVolume || 0;
          const volB = tickers[b.symbol]?.quoteVolume || 0;
          return volB - volA; // Sort by volume descending
        })
        .slice(0, 5);
    }

    // Overbought / Risk: Up > 10%
    return [...activeCoins]
      .filter(c => {
        const change = tickers[c.symbol]?.priceChangePercent || 0;
        return change >= 10.0;
      })
      .sort((a, b) => {
        const changeA = tickers[a.symbol]?.priceChangePercent || 0;
        const changeB = tickers[b.symbol]?.priceChangePercent || 0;
        return changeB - changeA; // Sort by highest change
      })
      .slice(0, 5);
  };

  const list = getRadarList();

  return (
    <div>
      {/* Tab Selectors */}
      <div className="timeframe-selector" style={{ margin: '0 0 16px 0', display: 'flex', width: '100%', padding: '2px' }}>
        <button
          className={`timeframe-btn ${activeTab === 'demon' ? 'active' : ''}`}
          onClick={() => setActiveTab('demon')}
          style={{ flexGrow: 1, fontSize: '11px', padding: '6px 4px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
        >
          <Flame size={12} />
          <span>妖幣爆量</span>
        </button>
        <button
          className={`timeframe-btn ${activeTab === 'accumulating' ? 'active' : ''}`}
          onClick={() => setActiveTab('accumulating')}
          style={{ flexGrow: 1, fontSize: '11px', padding: '6px 4px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
        >
          <TrendingUp size={12} />
          <span>潛力蓄勢</span>
        </button>
        <button
          className={`timeframe-btn ${activeTab === 'overbought' ? 'active' : ''}`}
          onClick={() => setActiveTab('overbought')}
          style={{ flexGrow: 1, fontSize: '11px', padding: '6px 4px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
        >
          <AlertTriangle size={12} />
          <span>超買警示</span>
        </button>
      </div>

      {/* List Container */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {list.length === 0 ? (
          <div className="empty-state" style={{ padding: '20px 0', fontSize: '12px' }}>
            {activeTab === 'accumulating' && '目前無符合條件 (漲幅1.5%~5%且具交易量) 的代幣。'}
            {activeTab === 'overbought' && '目前無符合條件 (今日漲幅 > 10%) 的代幣。'}
            {activeTab === 'demon' && '連線中...'}
          </div>
        ) : (
          list.map((coin) => {
            const ticker = tickers[coin.symbol];
            if (!ticker) return null;
            
            const isSelected = selectedSymbol === coin.symbol;
            const isUp = ticker.priceChangePercent >= 0;

            return (
              <button
                type="button"
                aria-label={`查看 ${coin.baseAsset} 動能 K 線`}
                aria-pressed={isSelected}
                key={coin.symbol}
                className="watchlist-item"
                style={{
                  cursor: 'pointer',
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-sm)',
                  background: isSelected ? 'rgba(124, 77, 255, 0.08)' : 'transparent',
                  border: isSelected ? '1px solid rgba(124, 77, 255, 0.2)' : '1px solid transparent',
                  transition: 'all 0.15s ease'
                }}
                onClick={() => onSelectSymbol(coin.symbol)}
              >
                <div className="coin-info">
                  {coin.logo ? (
                    <img src={coin.logo} alt={coin.name} style={{ width: '22px', height: '22px', borderRadius: '50%' }} />
                  ) : (
                    <div style={{
                      width: '22px',
                      height: '22px',
                      borderRadius: '50%',
                      background: 'var(--accent-gradient)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '8px',
                      fontWeight: 700,
                      color: 'white'
                    }}>
                      {coin.baseAsset.substring(0, 2)}
                    </div>
                  )}
                  <div>
                    <span className="coin-symbol" style={{ fontSize: '12px', fontWeight: 700 }}>{coin.baseAsset}</span>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, fontFamily: 'var(--font-display)' }}>
                    ${formatCryptoPrice(ticker.price)}
                  </div>
                  <div className={isUp ? 'trend-up' : 'trend-down'} style={{ fontSize: '10px', marginTop: '2px', fontWeight: 600 }}>
                    {isUp ? '+' : ''}{ticker.priceChangePercent.toFixed(2)}%
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
