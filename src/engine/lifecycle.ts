import { EventEmitter } from 'node:events';
import type { Db, TradeRow, TradeStatus } from '../db/index.js';
import type { Candle, Setup } from '../types.js';
import { mexcLink } from '../notify/format.js';

export interface LifecycleEvent {
  type: 'tp1_hit' | 'tp2_hit' | 'sl_hit' | 'be_hit' | 'manual_close';
  trade: TradeRow;
  price: number;
  message: string;
}

function fmt(n: number): string {
  const a = Math.abs(n);
  return a >= 1000 ? n.toFixed(2) : a >= 1 ? n.toFixed(4) : n.toPrecision(5);
}

/**
 * Tracks open trades through their lifecycle:
 * OPEN -> TP1_HIT (SL moved to BE) -> CLOSED_TP2 / CLOSED_BE / CLOSED_SL.
 */
export class LifecycleManager extends EventEmitter {
  constructor(private db: Db) {
    super();
  }

  /**
   * Called when an ENTRY_READY alert fires to create a tracked trade in the database.
   */
  onEntryReady(setup: Setup, chartFile?: string | null): TradeRow | null {
    if (!setup.entry || !setup.sl || !setup.tp1 || !setup.tp2 || !setup.direction) return null;
    const existing = this.db.getActiveTrades().find(t => t.symbol === setup.symbol && t.setup_id === setup.setupId);
    if (existing) {
      if (chartFile && !existing.chart_file) {
        this.db.setTradeChart(existing.id, chartFile);
        existing.chart_file = chartFile;
      }
      return existing;
    }

    const margin = setup.sizing?.margin ?? this.db.getDefaultMargin();
    const leverage = setup.sizing?.leverage ?? 50;
    const notional = setup.sizing?.notional ?? (margin * leverage);
    const strategyId = setup.strategyId || 'MOD-01';

    const id = this.db.createTrade({
      symbol: setup.symbol,
      direction: setup.direction,
      entry_price: setup.entry,
      sl_price: setup.sl,
      tp1_price: setup.tp1,
      tp2_price: setup.tp2,
      setup_id: setup.setupId,
      chart_file: chartFile ?? null,
      opened_at: setup.ts,
      margin,
      leverage,
      notional,
      strategy_id: strategyId,
    });

    const trade: TradeRow = {
      id,
      symbol: setup.symbol,
      direction: setup.direction,
      entry_price: setup.entry,
      sl_price: setup.sl,
      tp1_price: setup.tp1,
      tp2_price: setup.tp2,
      status: 'OPEN',
      opened_at: setup.ts,
      closed_at: null,
      pnl_r: null,
      pnl_usd: null,
      margin,
      leverage,
      notional,
      strategy_id: strategyId,
      setup_id: setup.setupId,
      chart_file: chartFile ?? null,
    };

    this.emit('trade_opened', trade);
    return trade;
  }

  /**
   * Evaluates active trades on incoming candle/price ticks.
   */
  onPrice(symbol: string, candle: Candle): LifecycleEvent[] {
    const active = this.db.getActiveTrades().filter(t => t.symbol === symbol);
    if (!active.length) return [];

    const events: LifecycleEvent[] = [];

    for (const trade of active) {
      const isLong = trade.direction === 'LONG';
      const ev = this.evaluateTrade(trade, candle, isLong);
      if (ev) {
        events.push(ev);
        this.emit('milestone', ev);
      }
    }

    return events;
  }

  private evaluateTrade(trade: TradeRow, candle: Candle, isLong: boolean): LifecycleEvent | null {
    const notional = trade.notional ?? ((trade.margin ?? 1) * (trade.leverage ?? 50));
    const entry = Math.max(1e-8, trade.entry_price);
    const slDistPct = Math.abs(entry - trade.sl_price) / entry;
    const tp1DistPct = Math.abs(entry - trade.tp1_price) / entry;
    const tp2DistPct = Math.abs(entry - trade.tp2_price) / entry;

    if (trade.status === 'OPEN') {
      const hitTp1 = isLong ? candle.h >= trade.tp1_price : candle.l <= trade.tp1_price;
      const hitSl = isLong ? candle.l <= trade.sl_price : candle.h >= trade.sl_price;

      if (hitTp1) {
        // TP1 Hit -> Move SL to Break-Even (entry price)
        this.db.updateTradeStatus(trade.id, 'TP1_HIT');
        this.db.updateTradeSl(trade.id, trade.entry_price);
        trade.status = 'TP1_HIT';
        trade.sl_price = trade.entry_price;

        const tp1Usd = notional * tp1DistPct * 0.5;

        const msg = [
          `🎯 TP1 (1:3 RR) HIT: ${trade.symbol} ${trade.direction} 🟢`,
          `Target reached at ${fmt(trade.tp1_price)} (+1.5R | +$${tp1Usd.toFixed(2)} USDT secured)!`,
          `👉 MOVE STOP LOSS TO BREAK-EVEN (${fmt(trade.entry_price)})`,
          `50% position secured for +1.5R. Runner active towards TP2 (${fmt(trade.tp2_price)}).`,
          mexcLink(trade.symbol),
        ].join('\n');

        return { type: 'tp1_hit', trade, price: trade.tp1_price, message: msg };
      }

      if (hitSl) {
        // Stopped out before TP1
        const slUsd = -(notional * slDistPct);
        const pnlUsd = Number(slUsd.toFixed(2));
        this.db.updateTradeStatus(trade.id, 'CLOSED_SL', -1.0, candle.t, pnlUsd);
        trade.status = 'CLOSED_SL';
        trade.pnl_r = -1.0;
        trade.pnl_usd = pnlUsd;
        trade.closed_at = candle.t;

        const msg = [
          `❌ STOP LOSS HIT: ${trade.symbol} ${trade.direction} 🔴`,
          `Stopped out at ${fmt(trade.sl_price)} (-1.0R | -$${Math.abs(slUsd).toFixed(2)} USDT loss).`,
          mexcLink(trade.symbol),
        ].join('\n');

        return { type: 'sl_hit', trade, price: trade.sl_price, message: msg };
      }
    }

    if (trade.status === 'TP1_HIT') {
      const hitTp2 = isLong ? candle.h >= trade.tp2_price : candle.l <= trade.tp2_price;
      const hitBe = isLong ? candle.l <= trade.sl_price : candle.h >= trade.sl_price;

      if (hitTp2) {
        // TP2 runner target achieved (+4.0R blended)
        const tp2Usd = notional * (tp2DistPct * 0.5 + tp1DistPct * 0.5);
        const pnlUsd = Number(tp2Usd.toFixed(2));
        this.db.updateTradeStatus(trade.id, 'CLOSED_TP2', 4.0, candle.t, pnlUsd);
        trade.status = 'CLOSED_TP2';
        trade.pnl_r = 4.0;
        trade.pnl_usd = pnlUsd;
        trade.closed_at = candle.t;

        const msg = [
          `🚀 TP2 (1:5 RR) HIT: ${trade.symbol} ${trade.direction} 🏆`,
          `Full runner target reached at ${fmt(trade.tp2_price)}!`,
          `Trade completed with +4.0R (+$${tp2Usd.toFixed(2)} USDT) total profit! 🎉`,
          mexcLink(trade.symbol),
        ].join('\n');

        return { type: 'tp2_hit', trade, price: trade.tp2_price, message: msg };
      }

      if (hitBe) {
        // Runner stopped out at Break-Even (+1.5R captured at TP1)
        const beUsd = notional * (tp1DistPct * 0.5);
        const pnlUsd = Number(beUsd.toFixed(2));
        this.db.updateTradeStatus(trade.id, 'CLOSED_BE', 1.5, candle.t, pnlUsd);
        trade.status = 'CLOSED_BE';
        trade.pnl_r = 1.5;
        trade.pnl_usd = pnlUsd;
        trade.closed_at = candle.t;

        const msg = [
          `🛡️ BREAK-EVEN HIT: ${trade.symbol} ${trade.direction}`,
          `Runner closed at Break-Even (${fmt(trade.sl_price)}).`,
          `Trade secured +1.5R (+$${beUsd.toFixed(2)} USDT) profit from TP1.`,
          mexcLink(trade.symbol),
        ].join('\n');

        return { type: 'be_hit', trade, price: trade.sl_price, message: msg };
      }
    }

    return null;
  }
}
