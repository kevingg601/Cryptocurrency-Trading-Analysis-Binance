export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  link: string;
  source: string;
  publishedAt: number;
  receivedAt: number;
}

export interface AIDataSourceHealth {
  status: 'healthy' | 'stale' | 'missing' | 'error';
  lastSuccessAt?: number;
  lastAttemptAt?: number;
  dataAsOf?: number;
  error?: string;
}

type FeedFetcher = (url: string, init: RequestInit) => Promise<Response>;

function stripHtml(text: string): string {
  return text
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function parseRssXml(xml: string, source: string, now: number): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemBlock = match[1];

    const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(itemBlock);
    const linkMatch = /<link>([\s\S]*?)<\/link>/i.exec(itemBlock);
    const descMatch = /<description>([\s\S]*?)<\/description>/i.exec(itemBlock);
    const pubDateMatch = /<pubDate>([\s\S]*?)<\/pubDate>/i.exec(itemBlock);

    const title = titleMatch ? stripHtml(titleMatch[1]) : '';
    const link = linkMatch ? stripHtml(linkMatch[1]) : '';
    const summary = descMatch ? stripHtml(descMatch[1]).slice(0, 500) : '';

    let publishedAt = now;
    if (pubDateMatch) {
      const parsedDate = Date.parse(pubDateMatch[1].trim());
      if (!Number.isNaN(parsedDate)) {
        publishedAt = parsedDate;
      }
    }

    if (title && link) {
      items.push({
        id: `news-${Buffer.from(link).toString('base64url').slice(0, 24)}`,
        title,
        summary,
        link,
        source,
        publishedAt,
        receivedAt: now,
      });
    }
  }

  return items;
}

export class RSSNewsSource {
  private cache: NewsItem[] = [];
  private lastFetchTime = 0;
  private isFetching = false;
  private lastAttemptTime = 0;
  private lastError?: string;
  private readonly fetcher: FeedFetcher;

  private feeds = [
    { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
    { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
  ];

  constructor(fetcher: FeedFetcher = fetch) {
    this.fetcher = fetcher;
  }

  async getLatestNews(maxAgeMs = 5 * 60 * 1000): Promise<NewsItem[]> {
    const now = Date.now();
    if (this.cache.length && now - this.lastFetchTime < maxAgeMs) {
      return this.getHealth(now).status === 'healthy' ? [...this.cache] : [];
    }

    if (this.isFetching) {
      return this.getHealth(now).status === 'healthy' ? [...this.cache] : [];
    }

    this.isFetching = true;
    try {
      await this.refreshFeeds();
    } finally {
      this.isFetching = false;
    }

    return this.getHealth(Date.now()).status === 'healthy' ? [...this.cache] : [];
  }

  async refreshFeeds(): Promise<NewsItem[]> {
    const now = Date.now();
    this.lastAttemptTime = now;
    const allFetched: NewsItem[] = [];
    let successCount = 0;

    for (const feed of this.feeds) {
      try {
        const res = await this.fetcher(feed.url, {
          signal: AbortSignal.timeout(4000),
          headers: { 'User-Agent': 'FadachiNews/1.0' },
        });
        if (!res.ok) { this.lastError = `HTTP ${res.status}`; continue; }
        const xml = await res.text();
        const items = parseRssXml(xml, feed.name, now);
        allFetched.push(...items);
        successCount++;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    }

    const oldIds = new Set(this.cache.map(item => item.id));
    if (successCount) {
      // Deduplicate by link
      const map = new Map<string, NewsItem>();
      // Preserve existing cache items that are still fresh (within 24 hours)
      const freshCutoff = now - 24 * 3600_000;
      for (const item of this.cache) {
        if (item.publishedAt >= freshCutoff) map.set(item.link, item);
      }
      for (const item of allFetched) {
        map.set(item.link, item);
      }
      this.cache = Array.from(map.values()).sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 50);
      this.lastFetchTime = now;
      this.lastError = undefined;
    }
    return [...new Map(allFetched.filter(item => !oldIds.has(item.id)).map(item => [item.id, item])).values()];
  }

  async refresh(): Promise<NewsItem[]> { return this.refreshFeeds(); }

  getHealth(now = Date.now()): AIDataSourceHealth {
    if (!this.lastFetchTime) return { status: this.lastError ? 'error' : 'missing', lastAttemptAt: this.lastAttemptTime || undefined, error: this.lastError };
    const status = now - this.lastFetchTime > 5 * 60_000 ? 'stale' : this.lastError ? 'stale' : 'healthy';
    return { status, lastSuccessAt: this.lastFetchTime, lastAttemptAt: this.lastAttemptTime, dataAsOf: this.lastFetchTime, error: this.lastError };
  }

  isMajorNews(item: NewsItem): boolean {
    return /sec|etf|hack|exploit|bankrupt|lawsuit|approval|ban|liquidat|exchange|fed|rate cut|rate hike/i.test(`${item.title} ${item.summary}`);
  }

  // Inject items for offline / test fixture verification
  injectFixtures(items: NewsItem[]) {
    this.cache = [...items];
    this.lastFetchTime = Date.now();
    this.lastAttemptTime = this.lastFetchTime;
    this.lastError = undefined;
  }
}
