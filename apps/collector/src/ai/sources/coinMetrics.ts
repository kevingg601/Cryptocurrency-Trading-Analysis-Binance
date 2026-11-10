import type { AIDataSourceHealth } from './rssNews.ts';

export interface OnChainMetrics {
  asset: string;
  activeAddresses?: number;
  txCount?: number;
  date?: string;
  isDaily: true;
  note: string;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
function dailyDateTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) return null;
  return timestamp;
}
function finiteMetric(value: unknown): number | undefined {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}
interface CachedMetrics {
  data: OnChainMetrics;
  fetchedAt: number;
  health: AIDataSourceHealth;
}

export class CoinMetricsSource {
  private readonly cache = new Map<string, CachedMetrics>();
  private readonly fetcher: Fetcher;
  private readonly REFRESH_INTERVAL_MS = 60 * 60 * 1000;
  private readonly assetMap: Record<string, string> = {
    BTCUSDT: 'btc', ETHUSDT: 'eth', SOLUSDT: 'sol', ADAUSDT: 'ada', DOGEUSDT: 'doge',
    LTCUSDT: 'ltc', XRPUSDT: 'xrp', AVAXUSDT: 'avax', LINKUSDT: 'link',
  };

  constructor(fetcher: Fetcher = fetch) { this.fetcher = fetcher; }

  async getAssetMetrics(symbol: string): Promise<OnChainMetrics | null> {
    const asset = this.assetMap[symbol.toUpperCase()];
    if (!asset) return null;
    const now = Date.now();
    const cached = this.cache.get(asset);
    if (cached && now - cached.fetchedAt < this.REFRESH_INTERVAL_MS) {
      if (cached.health.status === 'error' || cached.health.status === 'missing') return null;
      return { ...cached.data };
    }
    const state: CachedMetrics = cached ?? {
      data: { asset, isDaily: true, note: 'Coin Metrics daily data; not real-time flow' },
      fetchedAt: 0,
      health: { status: 'missing' },
    };
    state.health = { ...state.health, status: cached ? 'stale' : 'missing', lastAttemptAt: now };
    try {
      const catalogUrl = `https://community-api.coinmetrics.io/v4/catalog/asset-metrics?assets=${encodeURIComponent(asset)}`;
      const catalogResponse = await this.fetcher(catalogUrl, { signal: AbortSignal.timeout(4000) });
      if (!catalogResponse.ok) throw new Error(`Coin Metrics catalog HTTP ${catalogResponse.status}`);
      const catalogBody = await catalogResponse.json();
      const catalogRows = Array.isArray(catalogBody?.data) ? catalogBody.data : [];
      const catalogEntry = catalogRows.find((item: any) => String(item.asset ?? asset).toLowerCase() === asset);
      const advertised = new Set(String(catalogEntry?.metrics ?? '').split(/[\s,]+/).filter(Boolean));
      const coverage = advertised.has('AdrActCnt') || advertised.has('TxCnt');
      if (!coverage) throw new Error(`Coin Metrics catalog has no supported metric coverage for ${asset}`);

      const metricsUrl = `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=${encodeURIComponent(asset)}&metrics=AdrActCnt,TxCnt&frequency=1d&limit_per_asset=1`;
      const response = await this.fetcher(metricsUrl, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error(`Coin Metrics data HTTP ${response.status}`);
      const body = await response.json();
      const row = Array.isArray(body?.data) ? body.data[0] : undefined;
      const activeAddresses = finiteMetric(row?.AdrActCnt);
      const txCount = finiteMetric(row?.TxCnt);
      const date = typeof row?.time === 'string' ? row.time.slice(0, 10) : undefined;
      const dataAsOf = dailyDateTimestamp(date);
      const validValues = activeAddresses !== undefined || txCount !== undefined;
      if (!row || !date || dataAsOf === null || dataAsOf > now || !validValues) {
        throw new Error('Coin Metrics returned no dated finite daily observations');
      }
      const data: OnChainMetrics = {
        asset,
        ...(activeAddresses !== undefined ? { activeAddresses } : {}),
        ...(txCount !== undefined ? { txCount } : {}),
        date,
        isDaily: true,
        note: `Coin Metrics daily data (${date}); not real-time flow`,
      };
      const isStale = now - dataAsOf > 48 * 60 * 60_000;
      this.cache.set(asset, {
        data, fetchedAt: now,
        health: { status: isStale ? 'stale' : 'healthy', lastSuccessAt: now, lastAttemptAt: now, dataAsOf },
      });
      return { ...data };
    } catch (error) {
      state.health = {
        ...state.health,
        status: cached ? 'stale' : 'error',
        lastAttemptAt: now,
        error: error instanceof Error ? error.message : String(error),
      };
      this.cache.set(asset, state);
      return null;
    }
  }

  async refresh(symbols: string[]): Promise<void> {
    await Promise.all([...new Set(symbols.map(symbol => symbol.toUpperCase()))].map(symbol => this.getAssetMetrics(symbol)));
  }

  getHealth(symbol: string, now = Date.now()): AIDataSourceHealth {
    const asset = this.assetMap[symbol.toUpperCase()];
    if (!asset) return { status: 'missing' };
    const cached = this.cache.get(asset);
    if (!cached) return { status: 'missing' };
    if (cached.health.status === 'healthy' && (now - cached.fetchedAt >= this.REFRESH_INTERVAL_MS
        || (cached.health.dataAsOf !== undefined && now - cached.health.dataAsOf > 48 * 60 * 60_000))) {
      return { ...cached.health, status: 'stale' };
    }
    return { ...cached.health };
  }

  injectFixtures(symbol: string, metrics: OnChainMetrics): void {
    const asset = this.assetMap[symbol.toUpperCase()] || symbol.toLowerCase();
    const now = Date.now();
    const hasValue = finiteMetric(metrics.activeAddresses) !== undefined || finiteMetric(metrics.txCount) !== undefined;
    const dataAsOf = dailyDateTimestamp(metrics.date);
    const validDate = dataAsOf !== null && dataAsOf <= now;
    const hasDatedMetrics = metrics.isDaily === true && hasValue && validDate;
    const isStale = hasDatedMetrics && now - dataAsOf! > 48 * 60 * 60_000;
    this.cache.set(asset, {
      data: hasDatedMetrics ? { ...metrics } : { asset, isDaily: true, note: metrics.note || 'Invalid or uncovered offline fixture' },
      fetchedAt: now,
      health: hasDatedMetrics
        ? { status: isStale ? 'stale' : 'healthy', lastSuccessAt: now, lastAttemptAt: now, dataAsOf: dataAsOf! }
        : { status: 'missing', lastAttemptAt: now, error: 'Fixture lacks dated finite daily metrics' },
    });
  }
}
