import { useState, useEffect } from 'react';
import type { CoinMetadata, TickerData, MarketType } from '../services/binance';
import { Plus, Trash2, Wallet, TrendingUp, TrendingDown } from 'lucide-react';
import { formatCryptoPrice } from '../services/utils';

interface PortfolioItem {
  id: string;
  symbol: string;
  quantity: number;
  buyPrice: number;
  date: string;
}

interface PortfolioProps {
  tickers: Record<string, TickerData>;
  coins: CoinMetadata[];
  marketType: MarketType;
}

export default function Portfolio({ tickers, coins, marketType }: PortfolioProps) {
  const storageKey = `crypto_portfolio_items_${marketType}`;

  // State initialized dynamically via useEffect to handle market type switching
  const [items, setItems] = useState<PortfolioItem[]>([]);
  const [selectedCoin, setSelectedCoin] = useState('BTCUSDT');
  const [quantity, setQuantity] = useState('');
  const [buyPrice, setBuyPrice] = useState('');

  // Sync holdings from localStorage whenever marketType toggles
  useEffect(() => {
    const saved = localStorage.getItem(storageKey);
    setItems(saved ? JSON.parse(saved) : []);
    
    // Automatically select the first available coin or fallback to BTCUSDT
    if (coins.length > 0) {
      setSelectedCoin(coins[0].symbol);
    } else {
      setSelectedCoin('BTCUSDT');
    }
  }, [marketType, storageKey, coins]);

  const saveItems = (newItems: PortfolioItem[]) => {
    setItems(newItems);
    localStorage.setItem(storageKey, JSON.stringify(newItems));
  };

  const handleAddTransaction = (e: React.FormEvent) => {
    e.preventDefault();
    if (!quantity || !buyPrice) return;

    const newItem: PortfolioItem = {
      id: Math.random().toString(36).substring(2, 9),
      symbol: selectedCoin,
      quantity: parseFloat(quantity),
      buyPrice: parseFloat(buyPrice),
      date: new Date().toLocaleDateString(),
    };

    saveItems([...items, newItem]);
    setQuantity('');
    setBuyPrice('');
  };

  const handleDeleteItem = (id: string) => {
    const filtered = items.filter(item => item.id !== id);
    saveItems(filtered);
  };

  // Group portfolio items by symbol for consolidated holdings view
  const aggregatedHoldings = items.reduce((acc, item) => {
    const currentHolding = acc[item.symbol] || {
      symbol: item.symbol,
      totalQuantity: 0,
      totalCost: 0,
    };

    currentHolding.totalQuantity += item.quantity;
    currentHolding.totalCost += (item.quantity * item.buyPrice);
    
    acc[item.symbol] = currentHolding;
    return acc;
  }, {} as Record<string, { symbol: string; totalQuantity: number; totalCost: number }>);

  // Compute portfolio stats
  let totalCost = 0;
  let totalValue = 0;

  const holdingsList = Object.values(aggregatedHoldings).map((holding) => {
    const coin = coins.find(c => c.symbol === holding.symbol);
    const ticker = tickers[holding.symbol];
    const currentPrice = ticker ? ticker.price : 0;
    const currentVal = holding.totalQuantity * currentPrice;
    
    totalCost += holding.totalCost;
    totalValue += currentVal;

    const avgPrice = holding.totalCost / holding.totalQuantity;
    const pnl = currentVal - holding.totalCost;
    const pnlPercent = holding.totalCost > 0 ? (pnl / holding.totalCost) * 100 : 0;

    return {
      ...holding,
      coin,
      currentPrice,
      currentVal,
      avgPrice,
      pnl,
      pnlPercent,
    };
  });

  const totalPnL = totalValue - totalCost;
  const totalPnLPercent = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0;

  const marketTypeName = marketType === 'spot' ? '現貨資產' : '永續合約';

  return (
    <div className="portfolio-grid">
      {/* Transaction Entry Form */}
      <div className="sidebar-panel">
        <div className="card">
          <h2 className="card-title">新增交易紀錄 ({marketTypeName})</h2>
          <form onSubmit={handleAddTransaction}>
            <div className="form-group">
              <label>選擇代幣</label>
              <select
                className="form-select"
                value={selectedCoin}
                onChange={(e) => setSelectedCoin(e.target.value)}
              >
                {coins.map((coin) => (
                  <option key={coin.symbol} value={coin.symbol}>
                    {coin.baseAsset} - {coin.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label>購入數量</label>
              <input
                type="number"
                step="any"
                placeholder="例如: 0.25"
                className="form-input"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label>購入單價 (USDT)</label>
              <input
                type="number"
                step="any"
                placeholder="例如: 65000"
                className="form-input"
                value={buyPrice}
                onChange={(e) => setBuyPrice(e.target.value)}
                required
              />
            </div>

            <button type="submit" className="btn-primary" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
              <Plus size={16} /> 記錄到帳戶
            </button>
          </form>
        </div>

        {/* Transaction History Logs */}
        <div className="card" style={{ flexGrow: 1 }}>
          <h2 className="card-title">歷史交易明細</h2>
          <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
            {items.length === 0 ? (
              <div className="empty-state" style={{ padding: '20px' }}>無歷史紀錄</div>
            ) : (
              items.map((item) => {
                const coin = coins.find(c => c.symbol === item.symbol);
                return (
                  <div key={item.id} className="watchlist-item">
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '13px' }}>
                        {coin ? coin.baseAsset : item.symbol} 購入
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                        數量: {item.quantity} | 單價: ${formatCryptoPrice(item.buyPrice)} | {item.date}
                      </div>
                    </div>
                    <button
                      className="btn-delete"
                      onClick={() => handleDeleteItem(item.id)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Stats Summary & Holdings Grid */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        {/* Stats Panel */}
        <div className="portfolio-stats">
          <div className="stat-box">
            <div className="stat-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Wallet size={14} className="trend-up" /> 總投資市值
            </div>
            <div className="stat-value">
              ${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              USDT 等值
            </div>
          </div>

          <div className="stat-box">
            <div className="stat-label">投入本金</div>
            <div className="stat-value">
              ${totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              USDT 累計本金
            </div>
          </div>

          <div className="stat-box">
            <div className="stat-label">累積未實現損益</div>
            <div className={`stat-value ${totalPnL >= 0 ? 'trend-up' : 'trend-down'}`}>
              ${totalPnL.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            <div className={`trend-indicator ${totalPnL >= 0 ? 'trend-up' : 'trend-down'}`} style={{ marginTop: '4px', fontSize: '12px' }}>
              {totalPnL >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
              {totalPnL >= 0 ? '+' : ''}{totalPnLPercent.toFixed(2)}%
            </div>
          </div>
        </div>

        {/* Holdings Table */}
        <div className="card">
          <h2 className="card-title">資產持倉概覽 ({marketTypeName})</h2>
          {holdingsList.length === 0 ? (
            <div className="empty-state">
              目前無任何持倉。請在左側欄位新增交易紀錄以追蹤您的投資表現！
            </div>
          ) : (
            <div className="crypto-table-container">
              <table className="crypto-table">
                <thead>
                  <tr>
                    <th>資產</th>
                    <th style={{ textAlign: 'right' }}>持有數量</th>
                    <th style={{ textAlign: 'right' }}>平均持倉成本</th>
                    <th style={{ textAlign: 'right' }}>現價 (USDT)</th>
                    <th style={{ textAlign: 'right' }}>總市值</th>
                    <th style={{ textAlign: 'right' }}>持倉盈虧 (PnL)</th>
                  </tr>
                </thead>
                <tbody>
                  {holdingsList.map((holding) => {
                    const isUp = holding.pnl >= 0;
                    return (
                      <tr key={holding.symbol}>
                        <td className="coin-info">
                          {holding.coin?.logo ? (
                            <img src={holding.coin?.logo} alt={holding.coin?.name} className="coin-logo" />
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
                              {holding.coin?.baseAsset.substring(0, 2) || '??'}
                            </div>
                          )}
                          <div>
                            <div className="coin-symbol">{holding.coin?.baseAsset}</div>
                            <div className="coin-name">{holding.coin?.name}</div>
                          </div>
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 500 }}>
                          {holding.totalQuantity.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>
                          ${formatCryptoPrice(holding.avgPrice)}
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>
                          ${formatCryptoPrice(holding.currentPrice)}
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>
                          ${holding.currentVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <span className={`trend-indicator ${isUp ? 'trend-up' : 'trend-down'}`}>
                            {isUp ? '+' : ''}{holding.pnl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ({isUp ? '+' : ''}{holding.pnlPercent.toFixed(2)}%)
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
