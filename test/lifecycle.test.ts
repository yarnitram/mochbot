import { describe, it, expect } from 'vitest';
import { Db } from '../src/db/index.js';
import { LifecycleManager } from '../src/engine/lifecycle.js';
import { computePositionSizing } from '../src/strategy/sizing.js';
import type { Setup } from '../src/types.js';

describe('Trade Lifecycle & Position Sizing', () => {
  const setupLong: Setup = {
    symbol: 'BTC_USDT',
    stage: 'ENTRY_READY',
    direction: 'LONG',
    setupId: 'LONG:100:200',
    price: 100,
    zone: { top: 99, bottom: 98, startTime: 100 },
    distanceAtr: 0,
    needBreak: null,
    barsSinceTap: null,
    entry: 100,
    sl: 95,
    tp1: 115, // 1:3 RR (risk 5 -> 15)
    tp2: 125, // 1:5 RR (risk 5 -> 25)
    orderType: 'MARKET',
    orderNote: null,
    killzone: true,
    atrHtf: 1,
    atrLtf: 0.2,
    ts: 1000,
  };

  it('computes position sizing accurately for $1000 capital and $1 margin at 50x leverage', () => {
    const sizing = computePositionSizing(
      100, // entry
      95,  // SL (5% distance)
      115, // TP1 (15% distance, 1:3 RR)
      125, // TP2 (25% distance, 1:5 RR)
      'LONG',
      1000, // capital
      1,    // margin
      50,   // max leverage
      0.01  // contract size
    );

    expect(sizing.accountCapital).toBe(1000);
    expect(sizing.margin).toBe(1);
    expect(sizing.leverage).toBe(50);
    expect(sizing.notional).toBe(50); // $1 * 50 = $50 notional
    expect(sizing.qtyCoins).toBe(0.5); // $50 / $100 = 0.5 coins
    expect(sizing.slRiskUsd).toBeCloseTo(-2.5, 2); // 5% of $50
    expect(sizing.tp1ProfitUsd).toBeCloseTo(3.75, 2); // 15% of $50 * 50% = $3.75
    expect(sizing.tp2ProfitUsd).toBeCloseTo(10.0, 2); // 25% of $50 * 50% ($6.25) + $3.75 = $10.00
    expect(sizing.estLiqPrice).toBe(98); // 100 * (1 - 1/50)
  });

  it('opens a trade on ENTRY_READY with margin and leverage', () => {
    const db = new Db(':memory:');
    const lm = new LifecycleManager(db);

    const setupWithSizing: Setup = {
      ...setupLong,
      sizing: computePositionSizing(100, 95, 115, 125, 'LONG', 1000, 1, 50, 0.01),
    };

    const t = lm.onEntryReady(setupWithSizing);
    expect(t).not.toBeNull();
    expect(t!.status).toBe('OPEN');
    expect(t!.margin).toBe(1);
    expect(t!.leverage).toBe(50);
    expect(t!.notional).toBe(50);
    expect(db.getActiveTrades()).toHaveLength(1);
  });

  it('long trade: opens -> hits TP1 (moves SL to BE) -> hits TP2 (closes +4.0R with dollar PnL)', () => {
    const db = new Db(':memory:');
    const lm = new LifecycleManager(db);
    const setupWithSizing: Setup = {
      ...setupLong,
      sizing: computePositionSizing(100, 95, 115, 125, 'LONG', 1000, 1, 50, 0.01),
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
    expect(ev2[0].trade.pnl_usd).toBe(10.0); // +$10.00 realized

    // Trade is now closed
    expect(db.getActiveTrades()).toHaveLength(0);
    const summary = db.getPerformanceSummary();
    expect(summary.wins).toBe(1);
    expect(summary.losses).toBe(0);
    expect(summary.winRate).toBe(100);
    expect(summary.totalR).toBe(4.0);
    expect(summary.totalPnlUsd).toBe(10.0);
    expect(summary.accountCapital).toBe(1000);
    expect(summary.currentEquity).toBe(1010.0);
    expect(summary.returnPct).toBe(1.0);
  });

  it('long trade: opens -> hits TP1 -> falls back to BE (+1.5R and +$3.75)', () => {
    const db = new Db(':memory:');
    const lm = new LifecycleManager(db);
    const setupWithSizing: Setup = {
      ...setupLong,
      sizing: computePositionSizing(100, 95, 115, 125, 'LONG', 1000, 1, 50, 0.01),
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
    expect(ev[0].trade.pnl_usd).toBe(3.75); // $3.75 secured from TP1
    expect(db.getActiveTrades()).toHaveLength(0);

    const summary = db.getPerformanceSummary();
    expect(summary.wins).toBe(1);
    expect(summary.totalR).toBe(1.5);
    expect(summary.totalPnlUsd).toBe(3.75);
    expect(summary.currentEquity).toBe(1003.75);
  });

  it('long trade: opens -> stopped out before TP1 (-1.0R and -$2.50)', () => {
    const db = new Db(':memory:');
    const lm = new LifecycleManager(db);
    const setupWithSizing: Setup = {
      ...setupLong,
      sizing: computePositionSizing(100, 95, 115, 125, 'LONG', 1000, 1, 50, 0.01),
    };
    lm.onEntryReady(setupWithSizing);

    // Drops straight to SL (95)
    const ev = lm.onPrice('BTC_USDT', { t: 1060, o: 98, h: 99, l: 94.5, c: 94.8, v: 10 });
    expect(ev).toHaveLength(1);
    expect(ev[0].type).toBe('sl_hit');
    expect(ev[0].trade.status).toBe('CLOSED_SL');
    expect(ev[0].trade.pnl_r).toBe(-1.0);
    expect(ev[0].trade.pnl_usd).toBe(-2.5); // -$2.50 loss
    expect(db.getActiveTrades()).toHaveLength(0);

    const summary = db.getPerformanceSummary();
    expect(summary.wins).toBe(0);
    expect(summary.losses).toBe(1);
    expect(summary.winRate).toBe(0);
    expect(summary.totalR).toBe(-1.0);
    expect(summary.totalPnlUsd).toBe(-2.5);
    expect(summary.currentEquity).toBe(997.5);
  });
});
