import type { Direction, OrderType } from '../types.js';

export interface OrderSuggestion {
  type: OrderType;
  note: string;
}

/**
 * Heuristic order-type suggestion (NOT part of the Phantom playbook; thresholds are bot config).
 * distance = |price - entry| / ATR(1m)
 *  - <= 0.15 ATR: market (price is still at the CHoCH close)
 *  - <= 0.5 ATR with a fresh CHoCH: trigger-limit at the entry level
 *  - otherwise: limit, wait for a retest of the entry level
 */
export function suggestOrderType(dir: Direction, price: number, entry: number, atrLtf: number, freshChoch: boolean): OrderSuggestion {
  if (!Number.isFinite(atrLtf) || atrLtf <= 0) {
    return { type: 'LIMIT', note: `Limit at ${entry} (no ATR available).` };
  }
  const dist = Math.abs(price - entry) / atrLtf;
  const side = dir === 'LONG' ? 'buy' : 'sell';
  if (dist <= 0.15) return { type: 'MARKET', note: `Price is within ${dist.toFixed(2)} ATR of entry: market ${side} is reasonable.` };
  if (freshChoch && dist <= 0.5) return { type: 'TRIGGER_LIMIT', note: `Trigger-limit ${side} at ${entry} (price is ${dist.toFixed(2)} ATR away).` };
  return { type: 'LIMIT', note: `Price ran ${dist.toFixed(2)} ATR from entry: limit ${side} at ${entry} and wait for a retest.` };
}
