import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ListFilter, Radar, Star, X } from 'lucide-react';
import CryptoTable from './CryptoTable';
import MomentumRadar from './MomentumRadar';
import type { CoinMetadata, MarketType, TickerData } from '../services/binance';
import { formatCryptoPrice } from '../services/utils';

interface Props {
  coins: CoinMetadata[];
  tickers: Record<string, TickerData>;
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  watchlist: string[];
  onToggleWatchlist: (symbol: string) => void;
  marketType: MarketType;
  fundingRates: Record<string, number>;
  children: ReactNode;
}

export default function AnalysisWorkspace({ children, ...props }: Props) {
  const [drawer, setDrawer] = useState<'market' | 'radar' | null>(null);
  const [rightTab, setRightTab] = useState<'radar' | 'watchlist'>('radar');
  const marketPanel = useRef<HTMLElement>(null);
  const radarPanel = useRef<HTMLElement>(null);
  const marketTrigger = useRef<HTMLButtonElement>(null);
  const radarTrigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!drawer) return;
    const panel = drawer === 'market' ? marketPanel.current : radarPanel.current;
    const trigger = drawer === 'market' ? marketTrigger.current : radarTrigger.current;
    const focusable = () => Array.from(panel?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])
      .filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0);
    focusable()[0]?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setDrawer(null); }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0];
      const last = elements.at(-1);
      if (event.shiftKey && (document.activeElement === first || !panel?.contains(document.activeElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panel?.contains(document.activeElement))) {
        event.preventDefault(); first?.focus();
      }
    };
    const handleResize = () => {
      if (window.innerWidth >= (drawer === 'market' ? 1000 : 1200)) setDrawer(null);
    };
    document.addEventListener('keydown', handleKey);
    window.addEventListener('resize', handleResize);
    return () => {
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('resize', handleResize);
      if (trigger?.getClientRects().length) trigger.focus();
    };
  }, [drawer]);

  const selectSymbol = (symbol: string) => { props.onSelectSymbol(symbol); setDrawer(null); };

  const handleTabKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'radar' : event.key === 'End' ? 'watchlist' : rightTab === 'radar' ? 'watchlist' : 'radar';
    setRightTab(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`#${next === 'radar' ? 'radar' : 'watch'}-tab`)?.focus();
  };

  return <section className="analysis-workspace" aria-label="行情分析工作區">
    <div className="analysis-drawer-tools">
      <button ref={marketTrigger} className="utility-icon-button market-drawer-trigger" aria-expanded={drawer === 'market'} aria-controls="analysis-market" onClick={() => setDrawer('market')}><ListFilter size={16} />即時行情</button>
      <button ref={radarTrigger} className="utility-icon-button radar-drawer-trigger" aria-expanded={drawer === 'radar'} aria-controls="analysis-radar" onClick={() => setDrawer('radar')}><Radar size={16} />動能排行</button>
    </div>
    <div className="analysis-columns">
      {drawer && <button className="analysis-drawer-backdrop" tabIndex={-1} aria-label="關閉側欄" onClick={() => setDrawer(null)} />}
      <aside ref={marketPanel} id="analysis-market" className={`analysis-side analysis-market ${drawer === 'market' ? 'drawer-open' : ''}`} role={drawer === 'market' ? 'dialog' : undefined} aria-modal={drawer === 'market' || undefined} aria-label="加密貨幣即時行情" inert={drawer === 'radar'}>
        <button className="analysis-drawer-close" title="關閉即時行情" aria-label="關閉即時行情" onClick={() => setDrawer(null)}><X size={18} /></button>
        <CryptoTable {...props} onSelectSymbol={selectSymbol} variant="compact" />
      </aside>
      <div className="analysis-center" role="region" tabIndex={0} aria-label="主要 K 線與訊號分析" inert={drawer !== null}>{children}</div>
      <aside ref={radarPanel} id="analysis-radar" className={`analysis-side analysis-radar ${drawer === 'radar' ? 'drawer-open' : ''}`} role={drawer === 'radar' ? 'dialog' : undefined} aria-modal={drawer === 'radar' || undefined} aria-label="動能排行與關注清單">
        <div className="analysis-side-heading"><h2>市場動能</h2><button className="analysis-drawer-close" title="關閉動能排行" aria-label="關閉動能排行" onClick={() => setDrawer(null)}><X size={18} /></button></div>
        <div className="analysis-side-tabs" role="tablist" aria-label="市場動能清單" onKeyDown={handleTabKey}>
          <button id="radar-tab" role="tab" tabIndex={rightTab === 'radar' ? 0 : -1} aria-selected={rightTab === 'radar'} aria-controls="radar-content" onClick={() => setRightTab('radar')}><Radar size={14} />動能排行</button>
          <button id="watch-tab" role="tab" tabIndex={rightTab === 'watchlist' ? 0 : -1} aria-selected={rightTab === 'watchlist'} aria-controls="watch-content" onClick={() => setRightTab('watchlist')}><Star size={14} />關注清單</button>
        </div>
        <div id="radar-content" role="tabpanel" tabIndex={0} aria-labelledby="radar-tab" hidden={rightTab !== 'radar'} className="analysis-radar-content"><MomentumRadar coins={props.coins} tickers={props.tickers} selectedSymbol={props.selectedSymbol} onSelectSymbol={selectSymbol} /></div>
        <div id="watch-content" role="tabpanel" tabIndex={0} aria-labelledby="watch-tab" hidden={rightTab !== 'watchlist'} className="analysis-watch-content">
          {props.watchlist.length === 0 ? <div className="empty-state">尚無關注幣種</div> : props.watchlist.map(symbol => {
            const coin = props.coins.find(item => item.symbol === symbol);
            const ticker = props.tickers[symbol];
            if (!coin) return null;
            return <button key={symbol} className={`analysis-watch-row ${symbol === props.selectedSymbol ? 'selected' : ''}`} aria-pressed={symbol === props.selectedSymbol} onClick={() => selectSymbol(symbol)}><span><strong>{coin.baseAsset}</strong><small>{coin.name}</small></span><span><strong>{ticker ? formatCryptoPrice(ticker.price) : '--'}</strong><small className={(ticker?.priceChangePercent ?? 0) >= 0 ? 'trend-up-text' : 'trend-down-text'}>{ticker ? `${ticker.priceChangePercent >= 0 ? '+' : ''}${ticker.priceChangePercent.toFixed(2)}%` : '等待報價'}</small></span></button>;
          })}
        </div>
      </aside>
    </div>
  </section>;
}
