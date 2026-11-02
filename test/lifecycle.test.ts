import { describe, it, expect } from 'vitest';
import { Db } from '../src/db/index.js';
import { LifecycleManager } from '../src/engine/lifecycle.js';
import type { Setup } from '../src/types.js';

describe('Trade Lifecycle Manager', () => {
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

  it('opens a trade on ENTRY_READY', () => {
    const db = new Db(':memory:');
    const lm = new LifecycleManager(db);

    const t = lm.onEntryReady(setupLong);
    expect(t).not.toBeNull();
    expect(t!.status).toBe('OPEN');
    expect(db.getActiveTrades()).toHaveLength(1);
  });

  it('long trade: opens -> hits TP1 (moves SL to BE) -> hits TP2 (closes +4.0R)', () => {
    const db = new Db(':memory:');
    const lm = new LifecycleManager(db);
    lm.onEntryReady(setupLong);

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

    // Trade is now closed
    expect(db.getActiveTrades()).toHaveLength(0);
    const summary = db.getPerformanceSummary();
    expect(summary.wins).toBe(1);
    expect(summary.losses).toBe(0);
    expect(summary.winRate).toBe(100);
    expect(summary.totalR).toBe(4.0);
  });

  it('long trade: opens -> hits TP1 -> falls back to BE (+1.5R)', () => {
    const db = new Db(':memory:');
    const lm = new LifecycleManager(db);
    lm.onEntryReady(setupLong);

    // Hits TP1
    lm.onPrice('BTC_USDT', { t: 1060, o: 100, h: 116, l: 99, c: 115, v: 10 });

    // Falls back to entry price (100)
    const ev = lm.onPrice('BTC_USDT', { t: 1120, o: 105, h: 106, l: 99.5, c: 100, v: 10 });
    expect(ev).toHaveLength(1);
    expect(ev[0].type).toBe('be_hit');
    expect(ev[0].trade.status).toBe('CLOSED_BE');
    expect(ev[0].trade.pnl_r).toBe(1.5);
    expect(db.getActiveTrades()).toHaveLength(0);

    const summary = db.getPerformanceSummary();
    expect(summary.wins).toBe(1);
    expect(summary.totalR).toBe(1.5);
  });

  it('long trade: opens -> stopped out before TP1 (-1.0R)', () => {
    const db = new Db(':memory:');
    const lm = new LifecycleManager(db);
    lm.onEntryReady(setupLong);

    // Drops straight to SL (95)
    const ev = lm.onPrice('BTC_USDT', { t: 1060, o: 98, h: 99, l: 94.5, c: 94.8, v: 10 });
    expect(ev).toHaveLength(1);
    expect(ev[0].type).toBe('sl_hit');
    expect(ev[0].trade.status).toBe('CLOSED_SL');
    expect(ev[0].trade.pnl_r).toBe(-1.0);
    expect(db.getActiveTrades()).toHaveLength(0);

    const summary = db.getPerformanceSummary();
    expect(summary.wins).toBe(0);
    expect(summary.losses).toBe(1);
    expect(summary.winRate).toBe(0);
    expect(summary.totalR).toBe(-1.0);
  });
});
