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
  contractSize: number = 1
): PositionSizing {
  const safeEntry = Math.max(1e-8, entry);
  const slDistPct = Math.max(0.0001, Math.abs(safeEntry - sl) / safeEntry);
  const tp1DistPct = Math.abs(safeEntry - tp1) / safeEntry;
  const tp2DistPct = Math.abs(safeEntry - tp2) / safeEntry;

  // Maximum safe leverage ensuring liquidation is beyond Stop Loss (with 15% buffer for maintenance margin)
  const maxSafeLeverage = Math.max(1, Math.floor(0.85 / slDistPct));
  const leverage = Math.max(1, Math.min(Math.max(1, maxLeverage), maxSafeLeverage));

  // Risk per trade: loss from entry to SL = notional * slDistPct = targetRisk
  // => notional = targetRisk / slDistPct
  // => margin = notional / leverage = targetRisk / (slDistPct * leverage)
  const targetRisk = Math.max(0.1, riskPerTrade);
  const rawMargin = targetRisk / (slDistPct * leverage);
  const margin = Math.max(0.1, Number(Math.min(capital, rawMargin).toFixed(2)));
  const notional = Number((margin * leverage).toFixed(2));

  const qtyCoins = notional / safeEntry;
  const qtyContracts = Math.max(1, Math.round(qtyCoins / Math.max(1e-8, contractSize)));

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
