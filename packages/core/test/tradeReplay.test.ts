import test from 'node:test';
import assert from 'node:assert/strict';
import { runTradeReplay } from '../src/backtest/tradeReplay.ts';
import type { AggregateTradeData } from '../src/market/types.ts';

test('tradeReplay processes stream of aggregate trades and records alerts and plans', async () => {
  const epoch = 1_800_000_000_000;
  // Generate a pump scenario
  const trades: AggregateTradeData[] = [
    { symbol: 'BTCUSDT', price: 50000, quantity: 1, quoteValue: 50000, side: 'buy', timestamp: epoch, lastTradeId: 1 },
    { symbol: 'BTCUSDT', price: 50200, quantity: 2, quoteValue: 100400, side: 'buy', timestamp: epoch + 1000, lastTradeId: 2 },
    { symbol: 'BTCUSDT', price: 50800, quantity: 5, quoteValue: 254000, side: 'buy', timestamp: epoch + 2000, lastTradeId: 3 }, // 1.6% move -> alert
    // Pullback to ~50500
    { symbol: 'BTCUSDT', price: 50500, quantity: 1, quoteValue: 50500, side: 'sell', timestamp: epoch + 3500, lastTradeId: 4 },
    // Rebound
    { symbol: 'BTCUSDT', price: 50580, quantity: 1, quoteValue: 50580, side: 'buy', timestamp: epoch + 4000, lastTradeId: 5 },
    { symbol: 'BTCUSDT', price: 50590, quantity: 1, quoteValue: 50590, side: 'buy', timestamp: epoch + 7500, lastTradeId: 6 },
  ];

  const result = await runTradeReplay({
    market: 'futures',
    trades,
    alertSettings: { priceWindowMs: 5000, priceMovePercent: 1.5 },
  });

  assert.ok(result.totalTrades === 6);
  assert.ok(result.alerts.length >= 1);
  assert.equal(result.alerts[0].symbol, 'BTCUSDT');
  assert.equal(result.alerts[0].type, 'pump');
  assert.ok(result.plans.length >= 1);
  assert.equal(result.plans[0].symbol, 'BTCUSDT');
});

test('tradeReplay skips trades occurring inside gaps', async () => {
  const epoch = 1_800_000_000_000;
  const trades: AggregateTradeData[] = [
    { symbol: 'ETHUSDT', price: 3000, quantity: 1, quoteValue: 3000, side: 'buy', timestamp: epoch, lastTradeId: 1 },
    { symbol: 'ETHUSDT', price: 3050, quantity: 1, quoteValue: 3050, side: 'buy', timestamp: epoch + 1000, lastTradeId: 2 },
    { symbol: 'ETHUSDT', price: 3100, quantity: 1, quoteValue: 3100, side: 'buy', timestamp: epoch + 2000, lastTradeId: 3 },
  ];

  const result = await runTradeReplay({
    market: 'futures',
    trades,
    gaps: [{ symbol: 'ETHUSDT', from: epoch + 500, to: epoch + 1500 }],
  });

  assert.equal(result.totalTrades, 3);
  assert.equal(result.skippedByGap, 1); // epoch + 1000 skipped
});
