/**
 * Serialization utilities to safely preserve Infinity (e.g. order.expiresAt === Infinity)
 * across JSON serialization, prevent JSON from converting Infinity to null,
 * and provide bidirectional lossless transformation.
 */

const INFINITY_TOKEN = '@@INFINITY@@';
const NEG_INFINITY_TOKEN = '@@-INFINITY@@';

export function jsonReplacerWithInfinity(_key: string, value: unknown): unknown {
  if (value === Infinity) {
    return INFINITY_TOKEN;
  }
  if (value === -Infinity) {
    return NEG_INFINITY_TOKEN;
  }
  return value;
}

export function jsonReviverWithInfinity(_key: string, value: unknown): unknown {
  if (value === INFINITY_TOKEN) {
    return Infinity;
  }
  if (value === NEG_INFINITY_TOKEN) {
    return -Infinity;
  }
  return value;
}

export function stringifyWithInfinity(value: unknown, space?: number | string): string {
  return JSON.stringify(value, jsonReplacerWithInfinity, space);
}

export function parseWithInfinity<T = any>(text: string): T {
  return JSON.parse(text, jsonReviverWithInfinity) as T;
}

/**
 * Losslessly clone an object while preserving Infinity in pending exit orders
 */
export function cloneWithInfinity<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  return parseWithInfinity<T>(stringifyWithInfinity(value));
}

/**
 * Deeply restore any Infinity representations that might have come from raw JSON
 */
export function restoreInfinityInOrders<T>(obj: T): T {
  if (!obj || typeof obj !== 'object') return obj;
  const anyObj = obj as any;
  if (Array.isArray(anyObj)) {
    for (let i = 0; i < anyObj.length; i++) {
      anyObj[i] = restoreInfinityInOrders(anyObj[i]);
    }
  } else {
    for (const key of Object.keys(anyObj)) {
      if (key === 'expiresAt' && (anyObj[key] === INFINITY_TOKEN || (anyObj.kind === 'EXIT' && anyObj[key] === null))) {
        anyObj[key] = Infinity;
      } else if (typeof anyObj[key] === 'object' && anyObj[key] !== null) {
        anyObj[key] = restoreInfinityInOrders(anyObj[key]);
      }
    }
  }
  return obj;
}
