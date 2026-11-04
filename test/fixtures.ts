import type { Candle } from '../src/types.js';
import { DEFAULT_MOD01E_CFG } from '../src/types.js';

/** Deterministic ranging market, bullish historical bias, and a later CHoCH/retest. */
export function limitScenario() {
  const candles: Candle[] = [];
  let price = 100, seed = 42;
  for (let i = 0; i < 120; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const next = price + (seed / 4294967296 - .5) * 10;
    candles.push(...expand15(T0 + i * 900, { o: price, h: Math.max(price, next) + .1 + i * .001,
      l: Math.min(price, next) - .2 - i * .002, c: next }));
    price = next;
  }
  const bias = [100,102,105,102,101,104,108].map((p,i) => ({t:T0-(7-i)*3600,o:p,h:p+1,l:p-1,c:p,v:1}));
  const cfg = { ...DEFAULT_MOD01E_CFG, biasPivotLen:1, alignPivotLen:1, entryPivotLen:1, requireAlignment:false, useKillzone:false };
  return { candles, bias, cfg };
}

/** 2024-01-01 00:00:00 UTC */
export const T0 = 1704067200;

/** Fully completed trend/pullback/confirmation sequence with a later limit touch. */
export function emaScenario() {
  const candles:Candle[]=[];
  for(let i=0;i<60;i++) {
    const price=100+i*.2;
    candles.push(...expand15(T0+i*900,{o:price,h:price+.1,l:price-.1,c:price}));
  }
  // EMA zone around 107–110. Pullback completes at minute 915.
  candles.push(...expand15(T0+60*900,{o:111.8,h:112,l:108,c:109}));
  const append5=(minute:number,o:number,h:number,l:number,c:number)=>{
    for(let i=0;i<5;i++)candles.push({t:T0+(minute+i)*60,o:i===0?o:c,h:i===2?h:Math.max(o,c),l:i===3?l:Math.min(o,c),c,v:1});
  };
  append5(915,109,113,109,112.5); // closes above preceding 5m high; limit 111
  append5(920,112.5,112.6,110.5,111.2); // subsequent retest
  const bias=Array.from({length:60},(_,i)=>({t:T0-(60-i)*3600,o:100+i*.2,h:100.1+i*.2,l:99.9+i*.2,c:100+i*.2,v:1}));
  return {candles,bias,pendingCount:920,touchedCount:925};
}

export function slowEmaScenario() {
  const fast=emaScenario(),candles:Candle[]=[];
  for(let i=0;i<915;i++)for(let j=0;j<4;j++)candles.push({...fast.candles[i],t:T0+(i*4+j)*60});
  for(let i=915;i<925;i++)for(let j=0;j<3;j++)candles.push({...fast.candles[i],t:T0+(3660+(i-915)*3+j)*60});
  const bias=fast.bias.map(c=>({...c,t:T0+(c.t-T0)*4}));
  return {candles,bias,pendingCount:3675,touchedCount:3690};
}

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
