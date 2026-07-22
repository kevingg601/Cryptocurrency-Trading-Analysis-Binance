export function formatCryptoPrice(price: number | null | undefined): string {
  if (price === null || price === undefined) return '--';
  if (price === 0) return '0.00';
  const absPrice = Math.abs(price);
  if (absPrice < 0.0001) {
    return price.toLocaleString(undefined, { minimumFractionDigits: 8, maximumFractionDigits: 8 });
  }
  if (absPrice < 0.01) {
    return price.toLocaleString(undefined, { minimumFractionDigits: 6, maximumFractionDigits: 6 });
  }
  if (absPrice < 1) {
    return price.toLocaleString(undefined, { minimumFractionDigits: 5, maximumFractionDigits: 5 });
  }
  if (absPrice < 100) {
    return price.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  }
  return price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function getPricePrecision(price: number): number {
  if (price === 0) return 2;
  const absPrice = Math.abs(price);
  if (absPrice < 0.0001) return 8;
  if (absPrice < 0.01) return 6;
  if (absPrice < 1) return 5;
  if (absPrice < 100) return 4;
  return 2;
}

