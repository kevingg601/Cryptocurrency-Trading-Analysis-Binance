import { useState, useEffect, useRef } from 'react';
import type { CoinMetadata, TickerData, MarketType } from '../services/binance';
import { Search, Star, ArrowUpRight, ArrowDownRight, Plus } from 'lucide-react';
import { formatCryptoPrice } from '../services/utils';

interface CryptoTableProps {
  coins: CoinMetadata[];
  tickers: Record<string, TickerData>;
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  watchlist: string[];
  onToggleWatchlist: (symbol: string) => void;
  marketType: MarketType;
  fundingRates?: Record<string, number>;
}

export default function CryptoTable({
  coins,
  tickers,
  selectedSymbol,
  onSelectSymbol,
  watchlist,
  onToggleWatchlist,
  marketType,
  fundingRates
}: CryptoTableProps) {
  const [search, setSearch] = useState('');
  const [pageSize, setPageSize] = useState(50);
  const [flashStates, setFlashStates] = useState<Record<string, 'up' | 'down' | null>>({});
  const prevPrices = useRef<Record<string, number>>({});

  // Reset page size when search query changes
  useEffect(() => {
    setPageSize(50);
  }, [search]);

  // Hook to track price changes and trigger flashes
  useEffect(() => {
    const newFlashes: Record<string, 'up' | 'down'> = {};
    let hasChanges = false;

    Object.keys(tickers).forEach((sym) => {
      const currentPrice = tickers[sym].price;
      const prevPrice = prevPrices.current[sym];

      if (prevPrice !== undefined && currentPrice !== prevPrice) {
        newFlashes[sym] = currentPrice > prevPrice ? 'up' : 'down';
        hasChanges = true;
      }
      prevPrices.current[sym] = currentPrice;
    });

    if (hasChanges) {
      setFlashStates((prev) => ({ ...prev, ...newFlashes }));
      
      // Clear flashes after 800ms
      const timer = setTimeout(() => {
        setFlashStates((prev) => {
          const cleared = { ...prev };
          Object.keys(newFlashes).forEach((sym) => {
            cleared[sym] = null;
          });
          return cleared;
        });
      }, 800);

      return () => clearTimeout(timer);
    }
  }, [tickers]);

  // 1. Sort all coins by 24h volume (quoteVolume) descending
  const sortedCoins = [...coins].sort((a, b) => {
    const volA = tickers[a.symbol]?.quoteVolume || 0;
    const volB = tickers[b.symbol]?.quoteVolume || 0;
    return volB - volA;
  });

  // 2. Filter by search query
  const filteredCoins = sortedCoins.filter(coin => 
    coin.name.toLowerCase().includes(search.toLowerCase()) ||
    coin.symbol.toLowerCase().includes(search.toLowerCase()) ||
    coin.baseAsset.toLowerCase().includes(search.toLowerCase())
  );

  // 3. Slice for pagination
  const displayedCoins = filteredCoins.slice(0, pageSize);

  const getFlashClass = (symbol: string) => {
    const flash = flashStates[symbol];
    if (flash === 'up') return 'flash-green';
    if (flash === 'down') return 'flash-red';
    return '';
  };

  const colCount = marketType === 'futures' ? 7 : 6;

  return (
    <div className="card">
      <div className="card-title">
        <span>加密貨幣即時行情</span>
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 'normal' }}>
          資料來源: Binance WebSocket (全市場批次同步)
        </div>
      </div>

      <div className="search-bar-container">
        <Search size={18} className="search-icon" />
        <input
          type="text"
          placeholder="搜尋代幣名稱或代號 (例如: BTC, PEPE, WIF...)"
          className="search-input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="crypto-table-container">
        <table className="crypto-table">
          <thead>
            <tr>
              <th style={{ width: '40px' }}>自訂</th>
              <th>幣種</th>
              <th style={{ textAlign: 'right' }}>最新價格 (USDT)</th>
              <th style={{ textAlign: 'right' }}>24h 漲跌</th>
              {marketType === 'futures' && <th style={{ textAlign: 'right' }}>資金費率</th>}
              <th style={{ textAlign: 'right' }}>24h 最高 / 最低</th>
              <th style={{ textAlign: 'right' }}>24h 成交額 (USDT)</th>
            </tr>
          </thead>
          <tbody>
            {displayedCoins.map((coin) => {
              const ticker = tickers[coin.symbol];
              const isWatch = watchlist.includes(coin.symbol);
              const isSelected = selectedSymbol === coin.symbol;
              const flashClass = getFlashClass(coin.symbol);

              if (!ticker) {
                return (
                  <tr key={coin.symbol} onClick={() => onSelectSymbol(coin.symbol)}>
                    <td onClick={(e) => {
                      e.stopPropagation();
                      onToggleWatchlist(coin.symbol);
                    }}>
                      <button className={`watchlist-btn ${isWatch ? 'active' : ''}`}>
                        <Star size={16} fill={isWatch ? 'currentColor' : 'transparent'} />
                      </button>
                    </td>
                    <td className="coin-info">
                      {coin.logo ? (
                        <img src={coin.logo} alt={coin.name} className="coin-logo" />
                      ) : (
                        <div style={{
                          width: '32px',
                          height: '32px',
                          borderRadius: '50%',
                          background: 'var(--accent-gradient)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '11px',
                          fontWeight: 700,
                          color: 'white',
                          fontFamily: 'var(--font-display)'
                        }}>
                          {coin.baseAsset.substring(0, 2)}
                        </div>
                      )}
                      <div>
                        <div className="coin-symbol">{coin.baseAsset}</div>
                        <div className="coin-name">{coin.name}</div>
                      </div>
                    </td>
                    <td colSpan={colCount - 2} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                      連線中...
                    </td>
                  </tr>
                );
              }

              const isUp = ticker.priceChangePercent >= 0;

              return (
                <tr
                  key={coin.symbol}
                  className={`${isSelected ? 'selected' : ''}`}
                  onClick={() => onSelectSymbol(coin.symbol)}
                >
                  <td onClick={(e) => {
                    e.stopPropagation();
                    onToggleWatchlist(coin.symbol);
                  }}>
                    <button className={`watchlist-btn ${isWatch ? 'active' : ''}`}>
                      <Star size={16} fill={isWatch ? 'currentColor' : 'transparent'} />
                    </button>
                  </td>
                  <td className="coin-info">
                    {coin.logo ? (
                      <img src={coin.logo} alt={coin.name} className="coin-logo" />
                    ) : (
                      <div style={{
                        width: '32px',
                        height: '32px',
                        borderRadius: '50%',
                        background: 'var(--accent-gradient)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '11px',
                        fontWeight: 700,
                        color: 'white',
                        fontFamily: 'var(--font-display)'
                      }}>
                        {coin.baseAsset.substring(0, 2)}
                      </div>
                    )}
                    <div>
                      <div className="coin-symbol">{coin.baseAsset}</div>
                      <div className="coin-name">{coin.name}</div>
                    </div>
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }} className={flashClass}>
                    ${formatCryptoPrice(ticker.price)}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span className={`trend-indicator ${isUp ? 'trend-up' : 'trend-down'}`}>
                      {isUp ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
                      {isUp ? '+' : ''}{ticker.priceChangePercent.toFixed(2)}%
                    </span>
                  </td>
                  {marketType === 'futures' && (
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>
                      {(() => {
                        const rate = fundingRates?.[coin.symbol];
                        if (rate === undefined) return <span style={{ color: 'var(--text-muted)' }}>--</span>;
                        const percent = rate * 100;
                        const isPos = rate >= 0;
                        return (
                          <span style={{ color: isPos ? 'var(--trend-down)' : 'var(--trend-up)', fontFamily: 'var(--font-display)' }}>
                            {isPos ? '+' : ''}{percent.toFixed(4)}%
                          </span>
                        );
                      })()}
                    </td>
                  )}
                  <td style={{ textAlign: 'right', fontSize: '13px', color: 'var(--text-secondary)' }}>
                    <div>H: ${formatCryptoPrice(ticker.high)}</div>
                    <div style={{ marginTop: '2px' }}>L: ${formatCryptoPrice(ticker.low)}</div>
                  </td>
                  <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>
                    ${Math.round(ticker.quoteVolume).toLocaleString()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        
        {filteredCoins.length === 0 && (
          <div className="empty-state">
            沒有找到相符的代幣。
          </div>
        )}

        {filteredCoins.length > displayedCoins.length && (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: '20px' }}>
            <button
              onClick={() => setPageSize(prev => prev + 50)}
              className="btn-primary"
              style={{
                width: 'auto',
                padding: '10px 24px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}
            >
              <Plus size={16} /> 載入更多代幣 (剩餘 {filteredCoins.length - displayedCoins.length} 個)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
