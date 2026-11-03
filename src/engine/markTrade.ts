import type { TradeRow } from '../db/index.js';

/** Mark simulated positions using entry sizing, retaining the 50% realized at TP1. */
export function markTrade(trade: TradeRow, price: number | null) {
  const initialStop = trade.initial_sl_price ?? trade.sl_price;
  const riskDistance = Math.abs(trade.entry_price - initialStop);
  const initialRiskUsd = trade.notional * riskDistance / trade.entry_price;
  const remainingFraction = trade.status === 'TP1_HIT' ? .5 : 1;
  const realizedPnlUsd = trade.status === 'TP1_HIT'
    ? trade.notional * Math.abs(trade.tp1_price-trade.entry_price) / trade.entry_price * .5 : 0;
  const available = price !== null && Number.isFinite(price) && price > 0;
  const signedMove = available ? (trade.direction === 'LONG' ? price!-trade.entry_price : trade.entry_price-price!) : null;
  const unrealized = signedMove === null ? null : trade.notional * signedMove / trade.entry_price * remainingFraction;
  const total = unrealized === null ? null : realizedPnlUsd + unrealized;
  const target = trade.status === 'TP1_HIT' ? trade.tp2_price : trade.tp1_price;
  const targetDistance = Math.abs(target-trade.entry_price);
  const round = (x:number) => Number(x.toFixed(2));
  return {
    currentPrice:available?price:null,
    currentPnlUsd:total===null?null:round(total),
    unrealizedPnlUsd:unrealized===null?null:round(unrealized),
    realizedPnlUsd:round(realizedPnlUsd),
    currentR:total===null||initialRiskUsd<=0?null:round(total/initialRiskUsd),
    currentPnlPct:total===null||trade.margin<=0?null:round(total/trade.margin*100),
    initialRiskUsd:round(initialRiskUsd),
    remainingPct:remainingFraction*100,
    nextTarget:trade.status==='TP1_HIT'?'TP2':'TP1',
    targetProgressPct:signedMove===null||targetDistance<=0?null:round(Math.max(0,Math.min(100,signedMove/targetDistance*100))),
  };
}
