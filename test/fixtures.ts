import type { Candle } from '../src/types.js';

/** 2024-01-01 00:00:00 UTC */
export const T0 = 1704067200;

export interface Bar15 { o: number; h: number; l: number; c: number }

/** Expand a 15m OHLC bar into 15 one-minute candles that aggregate back to exactly that OHLC. */
export function expand15(t: number, b: Bar15): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < 15; i++) {
    const o = b.o + ((b.c - b.o) * i) / 15;
    const c = b.o + ((b.c - b.o) * (i + 1)) / 15;
    let h = Math.max(o, c);
    let l = Math.min(o, c);
    if (i === 0) h = Math.max(h, b.o);
    if (i === 13) l = Math.min(l, b.l);
    if (i === 14) h = Math.max(h, b.h);
    if (i === 0) l = Math.min(l, b.o);
    // make sure the true extreme is carried by one candle each
    if (i === 3) l = Math.min(l, b.l);
    if (i === 5) h = Math.max(h, b.h);
    out.push({ t: t + i * 60, o, h, l, c, v: 1 });
  }
  return out;
}

/** Piecewise-linear 1m path through waypoints [[minute, price], ...]. */
export function path1m(t: number, pts: [number, number][]): Candle[] {
  const out: Candle[] = [];
  let prev = pts[0][1];
  for (let s = 0; s < pts.length - 1; s++) {
    const [m0, p0] = pts[s];
    const [m1, p1] = pts[s + 1];
    for (let m = m0 + 1; m <= m1; m++) {
      const c = p0 + ((p1 - p0) * (m - m0)) / (m1 - m0);
      out.push({ t: t + (m - 1) * 60, o: prev, h: Math.max(prev, c) + 0.01, l: Math.min(prev, c) - 0.01, c, v: 1 });
      prev = c;
    }
  }
  return out;
}

const flat: Bar15 = { o: 100, h: 100.5, l: 99.5, c: 100 };

/**
 * Bullish scenario: flat market, a demand POI (sweep + displacement + BOS), a rally, then a pullback
 * into the zone and a 1m CHoCH. Start time shifts the wall clock (for killzone tests).
 */
export function longScenario(start = T0): { candles: Candle[]; tapMinute: number } {
  const candles: Candle[] = [];
  let t = start;
  const push15 = (b: Bar15) => { candles.push(...expand15(t, b)); t += 900; };
  for (let i = 0; i < 30; i++) push15(flat);
  push15({ o: 100, h: 100, l: 98.8, c: 99 }); // b3
  push15({ o: 99, h: 99.1, l: 98.2, c: 98.5 }); // b2 (sweeps b3 low)
  push15({ o: 98.3, h: 99.6, l: 97.9, c: 99.5 }); // b1 displacement, breaks b2 high
  push15({ o: 99.5, h: 101.2, l: 99.4, c: 101 }); // rally
  push15({ o: 101, h: 101.6, l: 100.9, c: 101.5 });
  const pullStart = t;
  candles.push(
    ...path1m(pullStart, [
      [0, 101.5], [30, 99.0], [34, 99.5], [44, 98.3], [50, 98.0], [64, 99.8],
    ]),
  );
  return { candles, tapMinute: 34 };
}

/** Mirror prices around 200 to turn a long scenario into a short one. */
export function invert(candles: Candle[]): Candle[] {
  return candles.map(c => ({ t: c.t, o: 200 - c.o, h: 200 - c.l, l: 200 - c.h, c: 200 - c.c, v: c.v }));
}
