import type { Direction, PositionSizing } from '../types.js';

export function computePositionSizing(
  entry: number,
  sl: number,
  tp1: number,
  tp2: number,
  direction: Direction,
  capital: number = 1000,
  riskPerTrade: number = 5,
  maxLeverage: number = 50,
  contractSize: number = 1,
  alwaysMaxLeverage: boolean = false,
): PositionSizing {
  if (![entry,sl,tp1,tp2,capital,riskPerTrade,maxLeverage,contractSize].every(Number.isFinite) ||
      entry <= 0 || sl <= 0 || entry === sl || capital <= 0 || riskPerTrade <= 0 || maxLeverage < 1 || contractSize <= 0 ||
      (direction === 'LONG' ? sl >= entry : sl <= entry)) throw new Error('Invalid position sizing inputs');
  const safeEntry = entry;
  const slDistPct = Math.abs(safeEntry - sl) / safeEntry;
  const tp1DistPct = Math.abs(safeEntry - tp1) / safeEntry;
  const tp2DistPct = Math.abs(safeEntry - tp2) / safeEntry;

  // Heuristic leverage cap, not an exchange liquidation guarantee.
  const maxSafeLeverage = Math.max(1, Math.floor(0.85 / slDistPct));
  const leverage = alwaysMaxLeverage
    ? Math.max(1, Math.floor(maxLeverage))
    : Math.max(1, Math.min(Math.floor(maxLeverage), maxSafeLeverage));

  // Risk per trade: loss from entry to SL = notional * slDistPct = targetRisk
  // => notional = targetRisk / slDistPct
  // => margin = notional / leverage = targetRisk / (slDistPct * leverage)
  const targetRisk = Math.max(0.1, riskPerTrade);
  const rawMargin = targetRisk / (slDistPct * leverage);
  // Round down rather than increase margin beyond the configured stop-loss budget.
  const margin = Math.floor(Math.min(capital, rawMargin) * 10_000) / 10_000;
  const notional = margin * leverage;

  const qtyCoins = notional / safeEntry;
  const qtyContracts = Math.floor(qtyCoins / contractSize);

  const slRiskUsd = -(notional * slDistPct);
  // 50% closed at TP1
  const tp1ProfitUsd = notional * tp1DistPct * 0.5;
  // Remaining 50% closed at TP2 + 50% realized at TP1
  const tp2ProfitUsd = notional * tp2DistPct * 0.5 + tp1ProfitUsd;

  // Approximate isolated liquidation price
  const estLiqPrice = direction === 'LONG'
    ? safeEntry * Math.max(0, 1 - 1 / leverage)
    : safeEntry * (1 + 1 / leverage);

  return {
    accountCapital: capital,
    riskPerTrade: targetRisk,
    margin,
    leverage,
    notional,
    qtyCoins,
    qtyContracts,
    slRiskUsd,
    tp1ProfitUsd,
    tp2ProfitUsd,
    estLiqPrice,
  };
}
