import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Search, Star, X } from 'lucide-react';
import type { CoinMetadata, TickerData } from '../services/binance';
import { formatCryptoPrice } from '../services/utils';

interface Props {
  coins: CoinMetadata[];
  tickers: Record<string, TickerData>;
  symbol: string;
  watchlist: string[];
  onSelect: (symbol: string) => void;
}

export default function CoinPicker({ coins, tickers, symbol, watchlist, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);

  const text = query.trim().toLowerCase();
  const matches = coins.filter(coin => `${coin.symbol} ${coin.name}`.toLowerCase().includes(text))
    .sort((a, b) => Number(watchlist.includes(b.symbol)) - Number(watchlist.includes(a.symbol))
      || (tickers[b.symbol]?.quoteVolume ?? 0) - (tickers[a.symbol]?.quoteVolume ?? 0)).slice(0, 40);

  return (
    <div className="coin-picker" ref={container} onKeyDown={event => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
    }}>
      <button ref={trigger} className="coin-picker-trigger" aria-expanded={open} aria-controls="coin-picker-results" onClick={() => { setQuery(''); setOpen(value => !value); }} title="切換監控幣種">
        <h2>{symbol.replace('USDT', '')}/USDT</h2><ChevronDown size={18} />
      </button>
      {open && (
        <div className="coin-picker-panel" id="coin-picker-results">
          <div className="coin-picker-search"><Search size={16} /><input ref={search} aria-label="搜尋幣種" placeholder="搜尋幣種" value={query} onChange={event => setQuery(event.target.value)} /><button title="關閉幣種搜尋" aria-label="關閉幣種搜尋" onClick={() => { setOpen(false); trigger.current?.focus(); }}><X size={16} /></button></div>
          <div className="coin-picker-list">
            {matches.map(coin => {
              const ticker = tickers[coin.symbol];
              return <button key={coin.symbol} className="coin-picker-option" onClick={() => { onSelect(coin.symbol); setOpen(false); trigger.current?.focus(); }}>
                <span className="coin-picker-name"><strong>{coin.baseAsset}</strong><small>{coin.name}</small></span>
                {watchlist.includes(coin.symbol) && <Star size={12} className="coin-picker-star" />}
                <span className="coin-picker-price">{ticker ? `$${formatCryptoPrice(ticker.price)}` : '--'}<small className={(ticker?.priceChangePercent ?? 0) >= 0 ? 'trend-up-text' : 'trend-down-text'}>{ticker ? `${ticker.priceChangePercent >= 0 ? '+' : ''}${ticker.priceChangePercent.toFixed(2)}%` : ''}</small></span>
                <Check size={14} style={{ visibility: symbol === coin.symbol ? 'visible' : 'hidden' }} />
              </button>;
            })}
            {matches.length === 0 && <div className="empty-state">沒有符合的交易對</div>}
          </div>
        </div>
      )}
    </div>
  );
}
