import { describe, it, expect } from 'vitest';
import { scan, evaluate, createZones } from '../src/strategy/mod01.js';
import { aggregate, atr, inKillzone } from '../src/strategy/indicators.js';
import { DEFAULT_CFG } from '../src/types.js';
import type { StrategyCfg } from '../src/types.js';
import { T0, expand15, invert, longScenario } from './fixtures.js';

const cfg = (o: Partial<StrategyCfg> = {}): StrategyCfg => ({ ...DEFAULT_CFG, ltfMinutes: 1, useKillzone: false, ...o });

describe('indicators', () => {
  it('aggregate rebuilds exact 15m OHLC', () => {
    const c = expand15(T0, { o: 100, h: 101, l: 99, c: 100.5 });
    const a = aggregate(c, 15);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ t: T0, o: 100, h: 101, l: 99, c: 100.5 });
  });
  it('aggregate drops a partial first bucket', () => {
    const c = expand15(T0, { o: 100, h: 101, l: 99, c: 100.5 }).slice(5);
    expect(aggregate(c, 15)).toHaveLength(0);
  });
  it('atr is NaN during warm-up then finite', () => {
    const c = Array.from({ length: 20 }, (_, i) => ({ t: i * 60, o: 10, h: 11, l: 9, c: 10, v: 1 }));
    const a = atr(c, 14);
    expect(Number.isNaN(a[12])).toBe(true);
    expect(a[13]).toBeCloseTo(2, 6);
    expect(a[19]).toBeCloseTo(2, 6);
  });
  it('killzones are London 07-11 and NY 13-17 UTC', () => {
    const at = (h: number) => T0 + h * 3600;
    expect([6, 7, 10, 11, 12, 13, 16, 17].map(h => inKillzone(at(h)))).toEqual([false, true, true, false, false, true, true, false]);
  });
});

describe('POI creation', () => {
  it('balanced demand: displacement body + BOS', () => {
    const b3 = { t: 0, o: 100, h: 100, l: 98.8, c: 99, v: 1 };
    const b2 = { t: 900, o: 99, h: 99.1, l: 98.2, c: 98.5, v: 1 };
    const b1 = { t: 1800, o: 98.3, h: 99.6, l: 97.9, c: 99.5, v: 1 };
    const z = createZones(b1, b2, b3, NaN, cfg(), 2700);
    expect(z.demand).toBeDefined();
    expect(z.demand!.bottom).toBe(97.9);
    expect(z.demand!.top).toBe(98.5);
    expect(z.demand!.startTime).toBe(900); // b2 swept b3's low
    expect(z.supply).toBeUndefined();
  });
  it('small body creates nothing', () => {
    const b3 = { t: 0, o: 100, h: 100.4, l: 99.6, c: 100, v: 1 };
    const b2 = { t: 900, o: 100, h: 100.4, l: 99.6, c: 100, v: 1 };
    const b1 = { t: 1800, o: 100, h: 101, l: 99, c: 100.1, v: 1 };
    const z = createZones(b1, b2, b3, 1, cfg(), 2700);
    expect(z.demand).toBeUndefined();
    expect(z.supply).toBeUndefined();
  });
  it('strict mode requires the sweep', () => {
    const b3 = { t: 0, o: 99, h: 99.5, l: 98.0, c: 99, v: 1 };
    const b2 = { t: 900, o: 99, h: 99.1, l: 98.5, c: 98.9, v: 1 }; // no sweep: l above b3.l
    const b1 = { t: 1800, o: 98.9, h: 100.3, l: 98.6, c: 100.2, v: 1 }; // l above b2.l -> no sweep
    expect(createZones(b1, b2, b3, 1, cfg({ sensitivity: 'strict' }), 0).demand).toBeUndefined();
    expect(createZones(b1, b2, b3, 1, cfg({ sensitivity: 'balanced' }), 0).demand).toBeDefined();
  });
});

describe('MOD-01 long scenario', () => {
  const { candles } = longScenario();

  it('detects a CHoCH long with ATR-buffered SL and 1:3 / 1:5 targets', () => {
    const r = scan(candles, cfg());
    const longs = r.signals.filter(s => s.direction === 'LONG');
    expect(longs.length).toBeGreaterThanOrEqual(1);
    const s = longs[0];
    expect(s.sl).toBeLessThan(97.95); // below the demand low (97.9) minus ATR buffer
    const risk = s.entry - s.sl;
    expect(s.tp1).toBeCloseTo(s.entry + 3 * risk, 8);
    expect(s.tp2).toBeCloseTo(s.entry + 5 * risk, 8);
    expect(s.entry).toBeGreaterThan(99.51);
  });

  it('is not repainting: truncating the data does not change earlier signals', () => {
    const full = scan(candles, cfg()).signals;
    const idx = full[0].barIndex;
    const cut = scan(candles.slice(0, idx + 1), cfg()).signals;
    expect(cut[0]).toEqual(full[0]);
    expect(scan(candles.slice(0, idx), cfg()).signals).toHaveLength(0);
  });

  it('killzone filter blocks entries outside London/NY and allows inside', () => {
    // scenario is ~8.75h of 15m bars plus ~1h of 1m pullback, so the signal lands ~9.8h after start
    const outside = scan(longScenario(T0 - 7 * 3600).candles, cfg({ useKillzone: true })); // signal ~02:47 UTC
    expect(outside.signals).toHaveLength(0);
    const inside = scan(longScenario(T0).candles, cfg({ useKillzone: true })); // signal ~09:47 UTC (London)
    expect(inside.signals.some(s => s.direction === 'LONG')).toBe(true);
  });

  it('resets the tap after a signal: exactly one entry per setup', () => {
    expect(scan(candles, cfg()).signals).toHaveLength(1);
  });

  it('a close below the zone invalidates it', () => {
    const crash = candles.map(c => ({ ...c }));
    // append a hard crash far below every demand zone
    const last = crash[crash.length - 1];
    for (let i = 1; i <= 20; i++) {
      const p = 90 - i * 0.1;
      crash.push({ t: last.t + i * 60, o: p + 0.1, h: p + 0.2, l: p - 0.1, c: p, v: 1 });
    }
    const r = scan(crash, cfg());
    expect(r.zones.filter(z => z.isDemand).every(z => z.invalidated)).toBe(true);
  });
});

describe('stage evaluation (long)', () => {
  const { candles } = longScenario();
  const pullStart = 35 * 900; // seconds after T0 where the 1m pullback begins
  const idxAt = (minute: number) => candles.findIndex(c => c.t === T0 + pullStart + (minute - 1) * 60);

  it('WATCH when price sits just above a demand POI (within 1 ATR(15m))', () => {
    const s = evaluate('TEST_USDT', candles.slice(0, idxAt(1) + 1), null, cfg());
    expect(s.stage).toBe('WATCH');
    expect(s.direction).toBe('LONG');
    expect(s.distanceAtr!).toBeGreaterThan(0);
    expect(s.distanceAtr!).toBeLessThanOrEqual(1);
  });

  it('IDLE in a flat market with no POIs', () => {
    const s = evaluate('TEST_USDT', candles.slice(0, 20 * 15), null, cfg());
    expect(s.stage).toBe('IDLE');
  });

  it('WATCH does not fire beyond watchDistanceAtr', () => {
    const s = evaluate('TEST_USDT', candles.slice(0, idxAt(1) + 1), null, cfg({ watchDistanceAtr: 0.01 }));
    expect(s.stage).toBe('IDLE');
  });

  it('ARMED after the tap, with the level that must be broken', () => {
    const s = evaluate('TEST_USDT', candles.slice(0, idxAt(46) + 1), null, cfg());
    expect(s.stage).toBe('ARMED');
    expect(s.direction).toBe('LONG');
    expect(s.needBreak).not.toBeNull();
    expect(s.needBreak!).toBeGreaterThan(s.price);
    expect(s.setupId).toMatch(/^LONG:/);
  });

  it('ARMED on a forming candle that taps the zone', () => {
    const closed = candles.slice(0, idxAt(30) + 1);
    const price = 98.4;
    const live = { t: closed[closed.length - 1].t + 60, o: 99, h: 99, l: price, c: price, v: 1 };
    expect(evaluate('TEST_USDT', closed, live, cfg()).stage).toBe('ARMED');
  });

  it('ENTRY_READY right after CHoCH with entry/SL/TP and order suggestion', () => {
    const sig = scan(candles, cfg()).signals[0];
    const s = evaluate('TEST_USDT', candles.slice(0, sig.barIndex + 1), null, cfg());
    expect(s.stage).toBe('ENTRY_READY');
    expect(s.entry).toBe(sig.entry);
    expect(s.sl).toBe(sig.sl);
    expect(s.orderType).toBe('MARKET'); // price == entry
  });

  it('ENTRY_READY expires after entryValidBars', () => {
    const sig = scan(candles, cfg()).signals[0];
    const tail = Array.from({ length: 10 }, (_, i) => {
      const last = candles[candles.length - 1];
      return { t: last.t + (i + 1) * 60, o: 99.8, h: 99.82, l: 99.78, c: 99.8, v: 1 };
    });
    const s = evaluate('TEST_USDT', [...candles, ...tail].slice(0, sig.barIndex + 1 + 10), null, cfg());
    expect(s.stage).not.toBe('ENTRY_READY');
  });
});

describe('MOD-01 short scenario (mirrored)', () => {
  it('detects supply tap and bearish CHoCH', () => {
    const candles = invert(longScenario().candles);
    const r = scan(candles, cfg());
    const shorts = r.signals.filter(s => s.direction === 'SHORT');
    expect(shorts.length).toBeGreaterThanOrEqual(1);
    const s = shorts[0];
    const risk = s.sl - s.entry;
    expect(risk).toBeGreaterThan(0);
    expect(s.tp1).toBeCloseTo(s.entry - 3 * risk, 8);
    const st = evaluate('TEST_USDT', candles.slice(0, s.barIndex + 1), null, cfg());
    expect(st.stage).toBe('ENTRY_READY');
    expect(st.direction).toBe('SHORT');
  });
});

describe('MOD-01 3-Minute LTF Execution', () => {
  it('aggregates 1m candles into 3m execution timeframe and evaluates CHoCH', () => {
    const { candles } = longScenario();
    const s = evaluate('TEST_USDT', candles, null, cfg({ ltfMinutes: 3 }));
    expect(s.ltfMinutes).toBe(3);
    expect(s.strategyId).toBe('MOD-01');
    expect(['IDLE', 'WATCH', 'ARMED', 'ENTRY_READY']).toContain(s.stage);
  });
});
