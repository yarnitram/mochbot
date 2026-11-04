import type { Candle } from '../types.js';

/** EMA seeded with an SMA; no values before enough closed candles exist. */
export function ema(candles: Candle[], length: number): number[] {
  const values = new Array<number>(candles.length).fill(NaN);
  let sum=0, previous=NaN;
  for(let i=0;i<candles.length;i++) {
    if(i<length) { sum+=candles[i].c; if(i===length-1) values[i]=previous=sum/length; }
    else values[i]=previous=candles[i].c*2/(length+1)+previous*(1-2/(length+1));
  }
  return values;
}

/** Only complete, contiguous buckets can confirm structure. Input is closed 1m bars. */
export function aggregateClosed(candles: Candle[], minutes: number): Candle[] {
  const counts = new Map<number, Set<number>>();
  for (const c of candles) {
    const t = Math.floor(c.t / (minutes * 60)) * minutes * 60;
    if (!counts.has(t)) counts.set(t, new Set());
    counts.get(t)!.add(c.t);
  }
  const end = (candles.at(-1)?.t ?? -60) + 60;
  return aggregate(candles, minutes).filter(c => counts.get(c.t)?.size === minutes && c.t + minutes * 60 <= end);
}

/** Wilder ATR, same seeding as Pine ta.atr (SMA of first `len` TRs, then RMA). NaN before warm-up. */
export function atr(candles: Candle[], len = 14): number[] {
  const out: number[] = new Array(candles.length).fill(NaN);
  let sum = 0;
  let prev = NaN;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tr = i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - candles[i - 1].c), Math.abs(c.l - candles[i - 1].c));
    if (i < len) {
      sum += tr;
      if (i === len - 1) {
        prev = sum / len;
        out[i] = prev;
      }
    } else {
      prev = (prev * (len - 1) + tr) / len;
      out[i] = prev;
    }
  }
  return out;
}

/** Aggregate LTF candles into HTF buckets. The first bucket is dropped when it is partial. */
export function aggregate(ltf: Candle[], minutes: number): Candle[] {
  if (ltf.length === 0) return [];
  const period = minutes * 60;
  const out: Candle[] = [];
  for (const c of ltf) {
    const start = Math.floor(c.t / period) * period;
    const last = out[out.length - 1];
    if (last && last.t === start) {
      last.h = Math.max(last.h, c.h);
      last.l = Math.min(last.l, c.l);
      last.c = c.c;
      last.v += c.v;
    } else {
      out.push({ t: start, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
    }
  }
  if (ltf[0].t > out[0].t) out.shift();
  return out;
}

/** UTC London 07-11 / New York 13-17 killzones. */
export function inKillzone(timeSec: number): boolean {
  const h = new Date(timeSec * 1000).getUTCHours();
  return (h >= 7 && h < 11) || (h >= 13 && h < 17);
}
