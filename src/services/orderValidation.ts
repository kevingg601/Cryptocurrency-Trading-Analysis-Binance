export type TradeSide = 'LONG' | 'SHORT';
export type PaperOrderType = 'MARKET' | 'LIMIT';

export interface EntryObservation {
  price: number;
  mode: 'LIMIT' | 'WAIT_CONFIRMATION' | 'MARKETABLE';
  label: string;
}

export function describeEntry(side: TradeSide, price: number, currentPrice: number): EntryObservation {
  if (Math.abs(price - currentPrice) <= Math.max(price, currentPrice) * 1e-10) {
    return { price, mode: 'MARKETABLE', label: '接近現價，非等待限價' };
  }
  const passive = side === 'LONG' ? price < currentPrice : price > currentPrice;
  return passive
    ? { price, mode: 'LIMIT', label: side === 'LONG' ? '回踩限價觀察' : '反彈限價觀察' }
    : { price, mode: 'WAIT_CONFIRMATION', label: side === 'LONG' ? '等待收復，不可直接買入限價' : '等待跌破，不可直接賣出限價' };
}

export function validateProtection(side: TradeSide, entryPrice: number, takeProfit?: number, stopLoss?: number): string | null {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return '請輸入有效的入場價格。';
  if (takeProfit !== undefined) {
    if (!Number.isFinite(takeProfit) || takeProfit <= 0) return '請輸入有效的止盈價格。';
    if (side === 'LONG' ? takeProfit <= entryPrice : takeProfit >= entryPrice) return side === 'LONG' ? '做多止盈必須高於實際入場參考價。' : '做空止盈必須低於實際入場參考價。';
  }
  if (stopLoss !== undefined) {
    if (!Number.isFinite(stopLoss) || stopLoss <= 0) return '請輸入有效的止損價格。';
    if (side === 'LONG' ? stopLoss >= entryPrice : stopLoss <= entryPrice) return side === 'LONG' ? '做多止損必須低於實際入場參考價。' : '做空止損必須高於實際入場參考價。';
  }
  return null;
}

export function validatePaperOrder(side: TradeSide, type: PaperOrderType, requestedPrice: number, currentPrice: number, takeProfit?: number, stopLoss?: number): string | null {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return '尚無有效即時價格，不能送出模擬委託。';
  if (!Number.isFinite(requestedPrice) || requestedPrice <= 0) return '請輸入有效的委託價格。';
  // This simulator supports passive limits, not stop/trigger entry orders.
  if (type === 'LIMIT' && describeEntry(side, requestedPrice, currentPrice).mode !== 'LIMIT') {
    return side === 'LONG'
      ? '買入限價必須低於現價，否則可能立即成交。等待上漲收復需要觸發單，目前不支援。'
      : '賣出限價必須高於現價，否則可能立即成交。等待下跌跌破需要觸發單，目前不支援。';
  }
  return validateProtection(side, type === 'MARKET' ? currentPrice : requestedPrice, takeProfit, stopLoss);
}

export function paperLimitFillPrice(side: TradeSide, limitPrice: number, currentPrice: number): number | null {
  if (![limitPrice, currentPrice].every(value => Number.isFinite(value) && value > 0)) return null;
  // A limit is a price boundary, not a promise to fill at the limit itself.
  return (side === 'LONG' ? currentPrice <= limitPrice : currentPrice >= limitPrice) ? currentPrice : null;
}
