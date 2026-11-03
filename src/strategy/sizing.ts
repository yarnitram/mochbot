import type { Direction, PositionSizing } from '../types.js';

export function computePositionSizing(
  entry: number,
  sl: number,
  tp1: number,
  tp2: number,
  direction: Direction,
  capital: number = 1000,
  margin: number = 1,
  maxLeverage: number = 50,
  contractSize: number = 1
): PositionSizing {
  const safeEntry = Math.max(1e-8, entry);
  const leverage = Math.max(1, maxLeverage);
  const notional = margin * leverage;
  const qtyCoins = notional / safeEntry;
  const qtyContracts = Math.max(1, Math.round(qtyCoins / Math.max(1e-8, contractSize)));

  const slDistPct = Math.abs(safeEntry - sl) / safeEntry;
  const tp1DistPct = Math.abs(safeEntry - tp1) / safeEntry;
  const tp2DistPct = Math.abs(safeEntry - tp2) / safeEntry;

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
