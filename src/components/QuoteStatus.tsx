import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { TickerData } from '../services/binance';
import type { StreamStatus } from '../services/marketStream';

export default function QuoteStatus({ ticker, tickerStatus, tradeStatus, onReconnect }: { ticker?: TickerData; tickerStatus: StreamStatus; tradeStatus: StreamStatus; onReconnect: () => void }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, []);
  const age = ticker?.receivedAt ? Math.max(0, now - ticker.receivedAt) : null;
  const feedsConnected = tradeStatus === 'connected' && tickerStatus === 'connected';
  const fast = feedsConnected
    && ticker?.priceSource === 'trade' && age !== null && age < 3_000;
  const healthy = tickerStatus === 'connected' && age !== null && age < 5_000;
  const label = fast ? '即時成交' : feedsConnected ? '等待成交' : healthy ? '備援行情' : '資料延遲';
  return <div className={`ws-status-badge ${fast ? 'connected' : 'stale'}`} role="status" aria-label="行情連線狀態" title={`快速成交：${tradeStatus}；行情統計：${tickerStatus}。時間為接收間隔，並非端到端網路延遲；無新成交時價格不會持續跳動。`}>
    <span className="ws-status-dot" /><span className="ws-status-text">{label}{age !== null ? ` · ${(age / 1000).toFixed(1)}s` : ''}</span>
    {!feedsConnected && <button className="ws-reconnect-btn" title="重新連線行情" aria-label="重新連線行情" onClick={onReconnect}><RefreshCw size={13} /></button>}
  </div>;
}
