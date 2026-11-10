import type { FastifyInstance } from 'fastify';

export function installValidation(app: FastifyInstance) {
  const market = { type: 'string', enum: ['spot', 'futures'] };
  const symbol = { type: 'string', pattern: '^[\\p{L}\\p{N}_]{2,60}$' };
  const time = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
  const paper = {
    type: 'object', required: ['balance', 'trades', 'history'], properties: {
      balance: { type: 'number' }, trades: { type: 'array' }, history: { type: 'array' },
    },
  };
  app.addHook('onRoute', (route) => {
    const properties: Record<string, any> = { market, token: { type: 'string' } };
    let body: any;
    if (['/api/trades', '/api/klines', '/api/replay'].includes(route.url)) {
      Object.assign(properties, { symbol, from: time, to: time,
        limit: { type: 'integer', minimum: 1, maximum: route.url === '/api/klines' ? 1000 : 100000 },
      });
      if (route.url === '/api/klines') properties.interval = {
        type: 'string', enum: ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '1d'],
      };
      if (route.url === '/api/replay') body = { type: 'object', properties: {
        ...properties,
        alertSettings: { type: 'object', properties: {
          priceMovePercent: { type: 'number', exclusiveMinimum: 0 },
          priceWindowMs: { type: 'number', exclusiveMinimum: 0 },
          whaleMultiplier: { type: 'number', exclusiveMinimum: 0 },
        } },
        autoConfig: { type: 'object', properties: {
          marketType: market, initialCapital: { type: 'number', exclusiveMinimum: 0 },
          riskPct: { type: 'number', exclusiveMinimum: 0, maximum: 100 },
          maxNotionalPct: { type: 'number', exclusiveMinimum: 0, maximum: 100 },
          maxPositions: { type: 'integer', minimum: 1, maximum: 3 },
          feeBps: { type: 'number', minimum: 0 }, slippageBps: { type: 'number', minimum: 0 },
          latencyMs: { type: 'number', minimum: 0 },
        } },
      } };
    }
    if (route.url === '/api/coverage') properties.symbol = symbol;
    if (route.method === 'PUT' && route.url === '/api/paper/:market') body = paper;
    if (route.method === 'PUT' && route.url === '/api/auto/batches') body = {
      type: 'object', required: ['id', 'snapshot'], properties: {
        id: { type: 'string', minLength: 1 }, market,
        status: { type: 'string', minLength: 1 }, snapshot: { type: 'object' },
      },
    };
    if (route.url === '/api/gaps/backfill') body = { type: 'object', properties: { gapId: { type: 'string', minLength: 1 } } };
    if (route.url === '/api/ai/history') properties.limit = { type: 'integer', minimum: 1, maximum: 200 };
    if (route.url === '/api/ai/status') {
      properties.symbols = { type: 'string', maxLength: 240 };
      properties.model = { type: 'string', minLength: 1, maxLength: 100 };
    }
    if (route.url === '/api/ai/trigger') body = {
      type: 'object', anyOf: [{ required: ['symbol'] }, { required: ['symbols'] }], properties: {
        symbol, symbols: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: symbol },
        market, model: { type: 'string', minLength: 1, maxLength: 100 }, isEventTrigger: { type: 'boolean' },
      },
    };
    if (route.url === '/api/ai/scope') body = {
      type: 'object', required: ['market', 'symbols', 'model'], properties: {
        market, symbols: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: symbol },
        model: { type: 'string', minLength: 1, maxLength: 100 },
      },
    };
    if (route.url === '/api/ai/scope/lock' || route.url === '/api/ai/scope/unlock') body = {
      type: 'object', required: ['owner'], properties: { owner: { type: 'string', minLength: 1, maxLength: 200 } },
    };
    if (route.url === '/api/ab/batches/:id/claim') body = { type: 'object', properties: {} };
    if (route.url === '/api/ab/batches/:id/lease') body = {
      type: 'object', required: ['ownerToken', 'generation'], properties: {
        ownerToken: { type: 'string', minLength: 1 }, generation: { type: 'string', minLength: 1 },
      },
    };
    if (route.method === 'PUT' && route.url === '/api/ab/batches') body = {
      type: 'object', required: ['id', 'batch', 'ownerToken', 'generation'], properties: {
        id: { type: 'string', minLength: 1 }, market,
        ownerToken: { type: 'string', minLength: 1 }, generation: { type: 'string', minLength: 1 },
        status: { type: 'string', minLength: 1 },
        revision: { type: 'integer', minimum: 0 },
        model: { type: 'string' },
        batch: { type: 'object' },
      },
    };
    if (route.url === '/api/migrate/browser') body = { type: 'object', properties: {
      paper: { type: 'object', additionalProperties: false, properties: { spot: paper, futures: paper } },
      batches: { type: 'array', items: { type: 'object', required: ['id'], properties: {
        id: { type: 'string', minLength: 1 }, marketType: market, market,
      } } },
    } };
    if (route.method === 'POST' && route.url === '/api/research/run') body = {
      type: 'object', additionalProperties: false, properties: {
        kronosModel: { type: 'string', enum: ['small', 'base'] },
        market: { type: 'string', enum: ['spot', 'futures'] },
        cutoffTime: time,
      },
    };
    route.schema = { ...route.schema, querystring: { type: 'object', properties },
      ...(route.url === '/api/paper/:market' ? { params: { type: 'object', required: ['market'], properties: { market } } } : {}),
      ...(route.url === '/api/ai/snapshots/:id' || route.url === '/api/ab/batches/:id' || route.url === '/api/ab/batches/:id/export.csv'
        || route.url === '/api/ab/batches/:id/claim' || route.url === '/api/ab/batches/:id/lease'
        || route.url === '/api/research/jobs/:id'
        ? { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1 } } } } : {}),
      ...(body ? { body } : {}),
    };
  });
  app.addHook('preHandler', async (req, reply) => {
    const params = (req.method === 'POST' ? req.body : req.query) as any;
    if (params?.from !== undefined && Number(params.from) > Number(params.to ?? Date.now())) {
      return reply.status(400).send({ error: 'from must not exceed to' });
    }
    if (params?.autoConfig?.marketType && params.autoConfig.marketType !== (params.market ?? 'futures')) {
      return reply.status(400).send({ error: 'autoConfig marketType must match market' });
    }
  });
}
