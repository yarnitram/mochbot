import { describe, it, expect } from 'vitest';
import { Db } from '../src/db/index.js';
import { LifecycleManager } from '../src/engine/lifecycle.js';
import { computePositionSizing } from '../src/strategy/sizing.js';
import type { Setup } from '../src/types.js';

describe('Trade Lifecycle & Milestones', () => {
  const setupLong: Setup = {
    symbol: 'BTC_USDT',
    stage: 'ENTRY_READY',
    direction: 'LONG',
    setupId: 'btc-entry-1',
    price: 100,
    entry: 100,
    sl: 95, // 5% risk
    tp1: 115, // 15% (1:3 RR)
    tp2: 125, // 25% (1:5 RR)
    orderType: 'LIMIT',
    orderNote: 'CHoCH break confirmation',
    zone: { top: 102, bottom: 98, startTime: 1000 },
    distanceAtr: 0,
    needBreak: null,
    barsSinceTap: 5,
    killzone: true,
    atrHtf: 1,
    atrLtf: 0.2,
    ts: 1000,
  };

  it('computes position sizing accurately for $1000 capital and $5 risk per trade', () => {
    const sizing = computePositionSizing(
      100, // entry
      95,  // SL (5% distance)
      115, // TP1 (15% distance, 1:3 RR)
      125, // TP2 (25% distance, 1:5 RR)
      'LONG',
      1000, // capital
      5,    // risk per trade ($5.00)
      50,   // max leverage
      0.01  // contract size
    );

    expect(sizing.accountCapital).toBe(1000);
    expect(sizing.riskPerTrade).toBe(5);
    // Leverage capped safely at floor(0.85 / 0.05) = 17 to prevent liquidation before SL
    expect(sizing.leverage).toBe(17);
    expect(sizing.margin).toBeCloseTo(5.88, 2);
    expect(sizing.notional).toBeCloseTo(99.96, 2);
    expect(sizing.slRiskUsd).toBeCloseTo(-5.0, 1); // Risks exactly ~$5.00
    expect(sizing.tp1ProfitUsd).toBeCloseTo(7.5, 1); // 1.5R = $7.50
    expect(sizing.tp2ProfitUsd).toBeCloseTo(20.0, 1); // 4.0R = $20.00
    expect(sizing.estLiqPrice).toBeLessThan(95); // Safely below SL of 95
  });

  it('opens a trade on ENTRY_READY with auto-computed margin and leverage', () => {
    const db = new Db(':memory:');
    const lm = new LifecycleManager(db);

    const setupWithSizing: Setup = {
      ...setupLong,
      sizing: computePositionSizing(100, 95, 115, 125, 'LONG', 1000, 5, 50, 0.01),
    };

    const t = lm.onEntryReady(setupWithSizing);
    expect(t).not.toBeNull();
    expect(t!.status).toBe('OPEN');
    expect(t!.margin).toBeCloseTo(5.88, 2);
    expect(t!.leverage).toBe(17);
    expect(t!.notional).toBeCloseTo(99.96, 2);
    expect(db.getActiveTrades()).toHaveLength(1);
  });

  it('long trade: opens -> hits TP1 (moves SL to BE) -> hits TP2 (closes +4.0R with dollar PnL)', () => {
    const db = new Db(':memory:');
    const lm = new LifecycleManager(db);
    const setupWithSizing: Setup = {
      ...setupLong,
      sizing: computePositionSizing(100, 95, 115, 125, 'LONG', 1000, 5, 50, 0.01),
    };
    lm.onEntryReady(setupWithSizing);

    // Candle rallies and touches TP1 (115)
    const ev1 = lm.onPrice('BTC_USDT', { t: 1060, o: 110, h: 116, l: 109, c: 115.5, v: 10 });
    expect(ev1).toHaveLength(1);
    expect(ev1[0].type).toBe('tp1_hit');
    expect(ev1[0].trade.status).toBe('TP1_HIT');
    expect(ev1[0].trade.sl_price).toBe(100); // SL moved to BE

    // Candle pushes to TP2 (125)
    const ev2 = lm.onPrice('BTC_USDT', { t: 1120, o: 120, h: 126, l: 119, c: 125.2, v: 10 });
    expect(ev2).toHaveLength(1);
    expect(ev2[0].type).toBe('tp2_hit');
    expect(ev2[0].trade.status).toBe('CLOSED_TP2');
    expect(ev2[0].trade.pnl_r).toBe(4.0);
    expect(ev2[0].trade.pnl_usd).toBeCloseTo(20.0, 1); // +$20.00 realized (4.0R * $5)

    // Trade is now closed
    expect(db.getActiveTrades()).toHaveLength(0);
    const summary = db.getPerformanceSummary();
    expect(summary.wins).toBe(1);
    expect(summary.losses).toBe(0);
    expect(summary.winRate).toBe(100);
    expect(summary.totalR).toBe(4.0);
    expect(summary.totalPnlUsd).toBeCloseTo(20.0, 1);
    expect(summary.accountCapital).toBe(1000);
    expect(summary.currentEquity).toBeCloseTo(1020.0, 1);
    expect(summary.returnPct).toBeCloseTo(2.0, 1);
  });

  it('long trade: opens -> hits TP1 -> falls back to BE (+1.5R and +$7.50)', () => {
    const db = new Db(':memory:');
    const lm = new LifecycleManager(db);
    const setupWithSizing: Setup = {
      ...setupLong,
      sizing: computePositionSizing(100, 95, 115, 125, 'LONG', 1000, 5, 50, 0.01),
    };
    lm.onEntryReady(setupWithSizing);

    // Hits TP1
    lm.onPrice('BTC_USDT', { t: 1060, o: 100, h: 116, l: 99, c: 115, v: 10 });

    // Falls back to entry price (100)
    const ev = lm.onPrice('BTC_USDT', { t: 1120, o: 105, h: 106, l: 99.5, c: 100, v: 10 });
    expect(ev).toHaveLength(1);
    expect(ev[0].type).toBe('be_hit');
    expect(ev[0].trade.status).toBe('CLOSED_BE');
    expect(ev[0].trade.pnl_r).toBe(1.5);
    expect(ev[0].trade.pnl_usd).toBeCloseTo(7.5, 1); // $7.50 secured from TP1 (1.5R * $5)
    expect(db.getActiveTrades()).toHaveLength(0);

    const summary = db.getPerformanceSummary();
    expect(summary.wins).toBe(1);
    expect(summary.totalR).toBe(1.5);
    expect(summary.totalPnlUsd).toBeCloseTo(7.5, 1);
    expect(summary.currentEquity).toBeCloseTo(1007.5, 1);
  });

  it('long trade: opens -> stopped out before TP1 (-1.0R and -$5.00)', () => {
    const db = new Db(':memory:');
    const lm = new LifecycleManager(db);
    const setupWithSizing: Setup = {
      ...setupLong,
      sizing: computePositionSizing(100, 95, 115, 125, 'LONG', 1000, 5, 50, 0.01),
    };
    lm.onEntryReady(setupWithSizing);

    // Drops straight to SL (95)
    const ev = lm.onPrice('BTC_USDT', { t: 1060, o: 98, h: 99, l: 94.5, c: 94.8, v: 10 });
    expect(ev).toHaveLength(1);
    expect(ev[0].type).toBe('sl_hit');
    expect(ev[0].trade.status).toBe('CLOSED_SL');
    expect(ev[0].trade.pnl_r).toBe(-1.0);
    expect(ev[0].trade.pnl_usd).toBeCloseTo(-5.0, 1); // -$5.00 loss (-1.0R * $5)
    expect(db.getActiveTrades()).toHaveLength(0);

    const summary = db.getPerformanceSummary();
    expect(summary.wins).toBe(0);
    expect(summary.losses).toBe(1);
    expect(summary.winRate).toBe(0);
    expect(summary.totalR).toBe(-1.0);
    expect(summary.totalPnlUsd).toBeCloseTo(-5.0, 1);
  });
});
