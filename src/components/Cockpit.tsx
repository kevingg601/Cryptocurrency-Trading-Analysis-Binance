import { useState } from 'react';
import { Clock, History, Plus, Wallet, X } from 'lucide-react';
import type { CoinMetadata, TickerData } from '../services/binance';
import { formatCryptoPrice } from '../services/utils';

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


export default function Cockpit({ coins, tickers, onSelectSymbol, paperTrades, paperBalance, paperHistory, reversalWarnings, onClosePaperTrade, onOpenPaperTrade, onCancelPendingOrder, onClearHistory }: CockpitProps) {
  const [tab, setTab] = useState<'positions' | 'pending' | 'history'>('positions');
  const [orderSymbol, setOrderSymbol] = useState('BTCUSDT');
  const positions = paperTrades.filter(trade => trade.status === 'OPEN');
  const pending = paperTrades.filter(trade => trade.status === 'PENDING');
  const pnlOf = (trade: PaperTrade) => {
    const price = tickers[trade.symbol]?.price;
    return price ? (price / trade.entryPrice - 1) * trade.size * (trade.side === 'LONG' ? 1 : -1) : null;
  };
  const unrealized = positions.reduce((sum, trade) => sum + (pnlOf(trade) ?? 0), 0);
  const realized = paperHistory.reduce((sum, trade) => sum + trade.pnl, 0);
  const winRate = paperHistory.length ? paperHistory.filter(trade => trade.pnl > 0).length / paperHistory.length * 100 : null;
  const money = (value: number) => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const selected = coins.some(coin => coin.symbol === orderSymbol) ? orderSymbol : coins[0]?.symbol;
  const exitLabels = { TP: '止盈', SL: '止損', LIQ: '強平', MANUAL: '手動平倉' };
  const count = tab === 'positions' ? positions.length : tab === 'pending' ? pending.length : paperHistory.length;
  return (
    <section className="paper-workspace">
      <div className="paper-header">
        <div><h2><Wallet size={20} />模擬交易帳戶</h2><span>紙上交易 · USDT</span></div>
        <div className="paper-order-controls">
          <select aria-label="模擬委託幣種" value={selected} onChange={event => setOrderSymbol(event.target.value)}>{coins.map(coin => <option key={coin.symbol} value={coin.symbol}>{coin.baseAsset}/USDT</option>)}</select>
          <button className="paper-new-order" disabled={!selected || !tickers[selected]?.price} onClick={() => { if (selected) onOpenPaperTrade(selected, 'LONG', tickers[selected]?.price); }}><Plus size={16} />新增模擬委託</button>
        </div>
      </div>
      <div className="paper-account-stats">
        <div><span>可用資金</span><strong>{money(paperBalance)}</strong></div>
        <div><span>未實現盈虧</span><strong className={unrealized >= 0 ? 'trend-up-text' : 'trend-down-text'}>{unrealized >= 0 ? '+' : ''}{money(unrealized)}</strong></div>
        <div><span>已實現盈虧</span><strong className={realized >= 0 ? 'trend-up-text' : 'trend-down-text'}>{realized >= 0 ? '+' : ''}{money(realized)}</strong></div>
        <div><span>歷史勝率 · {paperHistory.length} 筆</span><strong>{winRate === null ? '--' : winRate.toFixed(1) + '%'}</strong></div>
      </div>
      <div className="paper-tabs" role="tablist" aria-label="模擬交易紀錄">
        <button role="tab" aria-selected={tab === 'positions'} onClick={() => setTab('positions')}><Wallet size={16} />持倉 {positions.length}</button>
        <button role="tab" aria-selected={tab === 'pending'} onClick={() => setTab('pending')}><Clock size={16} />掛單 {pending.length}</button>
        <button role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}><History size={16} />成交紀錄 {paperHistory.length}</button>
      </div>
      <div className="paper-table-wrap" role="tabpanel">
        <table className="bot-trade-table paper-table">
          <thead><tr><th>交易對</th><th>方向</th><th>{tab === 'history' ? '進場 / 出場' : tab === 'pending' ? '委託價' : '進場 / 現價'}</th><th>保證金 / 槓桿</th><th>{tab === 'history' ? '已實現盈虧' : '止盈 / 止損'}</th><th>{tab === 'history' ? '成交原因' : '未實現盈虧'}</th><th>{tab === 'history' ? '台北時間' : '操作'}</th></tr></thead>
          <tbody>
            {tab === 'history' ? [...paperHistory].sort((a, b) => b.timestamp - a.timestamp).map(trade => <tr key={trade.id}>
              <td><button className="paper-symbol" onClick={() => onSelectSymbol(trade.symbol)}>{trade.symbol}</button></td>
              <td className={trade.side === 'LONG' ? 'trend-up-text' : 'trend-down-text'}>{trade.side === 'LONG' ? '做多' : '做空'}</td>
              <td>{formatCryptoPrice(trade.entryPrice)}<small>{formatCryptoPrice(trade.exitPrice)}</small></td>
              <td>{money(trade.size / trade.leverage)}<small>{trade.leverage}x</small></td>
              <td className={trade.pnl >= 0 ? 'trend-up-text' : 'trend-down-text'}>{trade.pnl >= 0 ? '+' : ''}{money(trade.pnl)}</td>
              <td>{exitLabels[trade.exitType]}</td>
              <td>{new Date(trade.timestamp).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
            </tr>) : (tab === 'positions' ? positions : pending).map(trade => {
              const pnl = pnlOf(trade);
              return <tr key={trade.id}>
                <td><button className="paper-symbol" onClick={() => onSelectSymbol(trade.symbol)}>{trade.symbol}</button>{reversalWarnings.some(warning => warning.startsWith(trade.symbol + ':')) && <small className="trend-down-text">風險提醒</small>}</td>
                <td className={trade.side === 'LONG' ? 'trend-up-text' : 'trend-down-text'}>{trade.side === 'LONG' ? '做多' : '做空'}</td>
                <td>{formatCryptoPrice(tab === 'pending' ? trade.limitPrice ?? trade.entryPrice : trade.entryPrice)}{tab === 'positions' && <small>{tickers[trade.symbol]?.price ? formatCryptoPrice(tickers[trade.symbol].price) : '--'}</small>}</td>
                <td>{money(trade.size / trade.leverage)}<small>{trade.leverage}x</small></td>
                <td>{trade.takeProfit ? formatCryptoPrice(trade.takeProfit) : '--'}<small>{trade.stopLoss ? formatCryptoPrice(trade.stopLoss) : '--'}</small></td>
                <td className={(pnl ?? 0) >= 0 ? 'trend-up-text' : 'trend-down-text'}>{tab === 'pending' || pnl === null ? '--' : (pnl >= 0 ? '+' : '') + money(pnl)}</td>
                <td><button className="utility-icon-button" disabled={tab === 'positions' && !tickers[trade.symbol]?.price} onClick={() => tab === 'pending' ? onCancelPendingOrder(trade.id) : onClosePaperTrade(trade.id)}><X size={14} />{tab === 'pending' ? '取消掛單' : '平倉'}</button></td>
              </tr>;
            })}
          </tbody>
        </table>
        {count === 0 && <div className="paper-empty"><Wallet size={32} /><strong>{tab === 'positions' ? '目前沒有持倉' : tab === 'pending' ? '目前沒有掛單' : '目前沒有成交紀錄'}</strong></div>}
      </div>
      {tab === 'history' && paperHistory.length > 0 && <button className="utility-icon-button" onClick={() => { if (window.confirm('清除所有模擬成交紀錄？')) onClearHistory(); }}>清除成交紀錄</button>}
    </section>
  );
}
