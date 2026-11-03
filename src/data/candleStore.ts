import type { Candle } from '../types.js';

interface Series {
  closed: Candle[];
  forming: Candle | null;
}

/** Rolling 1m candle buffers. A candle is "closed" once a newer candle arrives. */
export class CandleStore {
  private m = new Map<string, Series>();
  constructor(private maxBars = 1500) {}

  has(symbol: string) {
    return this.m.has(symbol);
  }
  drop(symbol: string) {
    this.m.delete(symbol);
  }

  /** Replace history (REST backfill). Candles at or after the current minute stay "forming". */
  setHistory(symbol: string, candles: Candle[], nowSec = Math.floor(Date.now() / 1000)) {
    const cutoff = Math.floor(nowSec / 60) * 60;
    const valid = [...new Map(candles.filter(c => [c.t,c.o,c.h,c.l,c.c,c.v].every(Number.isFinite) && c.t % 60 === 0 && c.l <= Math.min(c.o,c.c) && c.h >= Math.max(c.o,c.c)).map(c => [c.t,c])).values()].sort((a,b) => a.t-b.t);
    const closed = valid.filter(c => c.t < cutoff);
    const forming = valid.filter(c => c.t === cutoff).pop() ?? null;
    this.m.set(symbol, { closed: closed.slice(-this.maxBars), forming });
  }

  /** @returns true if ingesting this candle closed the previous one */
  ingest(symbol: string, c: Candle): boolean {
    let s = this.m.get(symbol);
    if (!s) {
      s = { closed: [], forming: null };
      this.m.set(symbol, s);
    }
    if (!s.forming) {
      s.forming = c;
      return false;
    }
    if (c.t === s.forming.t) {
      s.forming = c;
      return false;
    }
    if (c.t > s.forming.t) {
      const lastClosed = s.closed[s.closed.length - 1];
      if (!lastClosed || s.forming.t > lastClosed.t) s.closed.push(s.forming);
      if (s.closed.length > this.maxBars) s.closed.splice(0, s.closed.length - this.maxBars);
      s.forming = c;
      return true;
    }
    return false; // stale / out-of-order
  }

  closed(symbol: string): Candle[] {
    return this.m.get(symbol)?.closed ?? [];
  }
  forming(symbol: string): Candle | null {
    return this.m.get(symbol)?.forming ?? null;
  }
}
