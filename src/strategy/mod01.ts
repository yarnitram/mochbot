import type { Candle, Direction, EntrySignal, Setup, Stage, StrategyCfg, Zone } from '../types.js';
import { aggregate, atr, inKillzone } from './indicators.js';
import { suggestOrderType } from '../engine/orderType.js';

/**
 * Phantom SMC MOD-01 (Pro-Trend Confirmation) ported from phantom_smc_strategy.pine.
 *
 * - HTF POIs come from 15m candles aggregated from the 1m stream. Only completed HTF bars are used
 *   (Pine's [1],[2],[3] offsets with lookahead_off), so POIs never repaint.
 * - Bar order per LTF bar matches Pine: POI creation (new HTF bar) -> tap/invalidation -> pivots -> CHoCH.
 * - Only POIs created inside the supplied LTF window are tracked.
 */

export interface ScanResult {
  zones: Zone[];
  lastDemandTapBar: number | null;
  lastSupplyTapBar: number | null;
  lastTappedDemand: Zone | null;
  lastTappedSupply: Zone | null;
  lastLtfHigh: number | null;
  lastLtfLow: number | null;
  signals: EntrySignal[];
  atrLtf: number;
  atrHtf: number;
  n: number;
}

const f = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

export function scan(ltf: Candle[], cfg: StrategyCfg): ScanResult {
  const n = ltf.length;
  const period = cfg.htfMinutes * 60;
  const htf = aggregate(ltf, cfg.htfMinutes);
  const htfAtr = atr(htf, 14);
  const ltfAtr = atr(ltf, 14);

  const demand: Zone[] = [];
  const supply: Zone[] = [];
  const signals: EntrySignal[] = [];

  let lastDemandTapBar: number | null = null;
  let lastSupplyTapBar: number | null = null;
  let tappedDemand: Zone | null = null;
  let tappedSupply: Zone | null = null;
  let lastHigh: number | null = null;
  let lastLow: number | null = null;
  let prevPeriod = -1;
  let htfPtr = 0; // number of HTF bars with start < current period

  for (let i = 0; i < n; i++) {
    const bar = ltf[i];
    const P = Math.floor(bar.t / period) * period;
    const prevClose = i > 0 ? ltf[i - 1].c : NaN;
    const prevLastHigh = lastHigh;
    const prevLastLow = lastLow;

    // 1. POI creation on a new HTF bar
    if (P !== prevPeriod) {
      if (prevPeriod !== -1) {
        while (htfPtr < htf.length && htf[htfPtr].t < P) htfPtr++;
        const k = htfPtr - 1;
        if (k >= 2) {
          const b1 = htf[k], b2 = htf[k - 1], b3 = htf[k - 2];
          const a1 = htfAtr[k];
          const created = createZones(b1, b2, b3, a1, cfg, bar.t);
          if (created.demand) pushCapped(demand, created.demand, cfg.maxActivePois);
          if (created.supply) pushCapped(supply, created.supply, cfg.maxActivePois);
        }
      }
      prevPeriod = P;
    }

    // 2. Tap + invalidation (iterate newest -> oldest like Pine, so oldest zone wins the "last tap")
    for (let z = demand.length - 1; z >= 0; z--) {
      const zone = demand[z];
      if (zone.invalidated) continue;
      if (bar.l <= zone.top && bar.h >= zone.bottom) {
        lastDemandTapBar = i;
        tappedDemand = zone;
        zone.mitigated = true;
      }
      if (bar.c < zone.bottom) zone.invalidated = true;
    }
    for (let z = supply.length - 1; z >= 0; z--) {
      const zone = supply[z];
      if (zone.invalidated) continue;
      if (bar.h >= zone.bottom && bar.l <= zone.top) {
        lastSupplyTapBar = i;
        tappedSupply = zone;
        zone.mitigated = true;
      }
      if (bar.c > zone.top) zone.invalidated = true;
    }

    // 3. LTF pivots (confirmed `len` bars later)
    const len = cfg.ltfSwingLen;
    const p = i - len;
    if (p >= len) {
      if (isPivotHigh(ltf, p, len)) lastHigh = ltf[p].h;
      if (isPivotLow(ltf, p, len)) lastLow = ltf[p].l;
    }

    // 4. CHoCH
    const brokeHigh = f(lastHigh) && f(prevLastHigh) && bar.c > lastHigh && prevClose <= prevLastHigh;
    const brokeLow = f(lastLow) && f(prevLastLow) && bar.c < lastLow && prevClose >= prevLastLow;
    const winDemand = lastDemandTapBar !== null && i - lastDemandTapBar <= cfg.maxBarsAfterTap;
    const winSupply = lastSupplyTapBar !== null && i - lastSupplyTapBar <= cfg.maxBarsAfterTap;
    const kz = !cfg.useKillzone || inKillzone(bar.t);
    const a = ltfAtr[i];
    const atrBuf = f(a) ? a * cfg.slBufferAtr : 0;

    if (brokeHigh && winDemand && kz) {
      let structLow = tappedDemand ? Math.min(tappedDemand.bottom, bar.l) : bar.l;
      if (f(lastLow)) structLow = Math.min(structLow, lastLow);
      const sl = structLow - atrBuf;
      const risk = Math.max(bar.c - sl, cfg.tickSize * 10);
      signals.push({
        direction: 'LONG', barIndex: i, time: bar.t, entry: bar.c, sl,
        tp1: bar.c + risk * cfg.rrTP1, tp2: bar.c + risk * cfg.rrTP2,
        zoneId: tappedDemand?.id ?? 'unknown', zoneStartTime: tappedDemand?.startTime ?? bar.t,
        inKillzone: inKillzone(bar.t),
      });
      lastDemandTapBar = null;
    }
    if (brokeLow && winSupply && kz) {
      let structHigh = tappedSupply ? Math.max(tappedSupply.top, bar.h) : bar.h;
      if (f(lastHigh)) structHigh = Math.max(structHigh, lastHigh);
      const sl = structHigh + atrBuf;
      const risk = Math.max(sl - bar.c, cfg.tickSize * 10);
      signals.push({
        direction: 'SHORT', barIndex: i, time: bar.t, entry: bar.c, sl,
        tp1: bar.c - risk * cfg.rrTP1, tp2: bar.c - risk * cfg.rrTP2,
        zoneId: tappedSupply?.id ?? 'unknown', zoneStartTime: tappedSupply?.startTime ?? bar.t,
        inKillzone: inKillzone(bar.t),
      });
      lastSupplyTapBar = null;
    }
  }

  return {
    zones: [...demand, ...supply],
    lastDemandTapBar, lastSupplyTapBar,
    lastTappedDemand: tappedDemand, lastTappedSupply: tappedSupply,
    lastLtfHigh: lastHigh, lastLtfLow: lastLow,
    signals,
    atrLtf: n ? ltfAtr[n - 1] : NaN,
    atrHtf: lastFinite(htfAtr),
    n,
  };
}

function lastFinite(a: number[]): number {
  for (let i = a.length - 1; i >= 0; i--) if (Number.isFinite(a[i])) return a[i];
  return NaN;
}

function pushCapped(arr: Zone[], z: Zone, cap: number) {
  if (arr.length >= cap) arr.shift();
  arr.push(z);
}

/** Pine ta.pivothigh: strictly higher than the `len` bars on the left, not lower than the `len` bars on the right. */
function isPivotHigh(c: Candle[], p: number, len: number): boolean {
  const h = c[p].h;
  for (let k = 1; k <= len; k++) {
    if (c[p - k].h >= h) return false;
    if (c[p + k].h > h) return false;
  }
  return true;
}
function isPivotLow(c: Candle[], p: number, len: number): boolean {
  const l = c[p].l;
  for (let k = 1; k <= len; k++) {
    if (c[p - k].l <= l) return false;
    if (c[p + k].l < l) return false;
  }
  return true;
}

export function createZones(b1: Candle, b2: Candle, b3: Candle, atr1: number, cfg: StrategyCfg, createdTime: number) {
  const mode = cfg.sensitivity;
  const tick5 = cfg.tickSize * 5;
  const range1 = b1.h - b1.l;
  const res: { demand?: Zone; supply?: Zone } = {};

  // Demand
  {
    const sweep = b1.l < b2.l || b2.l < b3.l;
    const body = b1.c > b1.o && b1.c - b1.o >= range1 * 0.35;
    const fvg = b1.l > b3.h || (f(atr1) && b1.c - b1.o > atr1 * cfg.fvgAtrMult);
    const bos = b1.c > b2.h;
    const ok = mode === 'strict' ? sweep && body && fvg && bos : mode === 'balanced' ? body && (fvg || bos) : body || b1.c > b2.h;
    if (ok) {
      const bottom = Math.min(b1.l, b2.l);
      let top = Math.max(b1.o, b2.c);
      if (top <= bottom || top - bottom < tick5) top = bottom + range1 * 0.35;
      const startTime = b2.l < b3.l ? b2.t : b1.t;
      res.demand = { id: `D${startTime}`, isDemand: true, top, bottom, startTime, createdTime, invalidated: false, mitigated: false };
    }
  }
  // Supply
  {
    const sweep = b1.h > b2.h || b2.h > b3.h;
    const body = b1.c < b1.o && b1.o - b1.c >= range1 * 0.35;
    const fvg = b1.h < b3.l || (f(atr1) && b1.o - b1.c > atr1 * cfg.fvgAtrMult);
    const bos = b1.c < b2.l;
    const ok = mode === 'strict' ? sweep && body && fvg && bos : mode === 'balanced' ? body && (fvg || bos) : body || b1.c < b2.l;
    if (ok) {
      const top = Math.max(b1.h, b2.h);
      let bottom = Math.min(b1.o, b2.c);
      if (bottom >= top || top - bottom < tick5) bottom = top - range1 * 0.35;
      const startTime = b2.h > b3.h ? b2.t : b1.t;
      res.supply = { id: `S${startTime}`, isDemand: false, top, bottom, startTime, createdTime, invalidated: false, mitigated: false };
    }
  }
  return res;
}

/**
 * Evaluate the current stage for a symbol.
 * @param closed closed 1m candles (oldest first)
 * @param live   the forming 1m candle, if any (used for tap / Watch only; CHoCH needs a closed bar)
 */
export function evaluate(symbol: string, closed: Candle[], live: Candle | null, cfg: StrategyCfg, nowSec = Math.floor(Date.now() / 1000)): Setup {
  const r = scan(closed, cfg);
  const n = r.n;
  const price = live?.c ?? (n ? closed[n - 1].c : NaN);
  const kzNow = inKillzone(nowSec);
  const base: Setup = {
    symbol, stage: 'IDLE', direction: null, setupId: null, price, zone: null, distanceAtr: null, needBreak: null,
    barsSinceTap: null, entry: null, sl: null, tp1: null, tp2: null, orderType: null, orderNote: null,
    killzone: kzNow, atrHtf: f(r.atrHtf) ? r.atrHtf : null, atrLtf: f(r.atrLtf) ? r.atrLtf : null, ts: nowSec,
  };
  if (n < 20 || !Number.isFinite(price)) return base;

  const candidates: Setup[] = [];

  // ENTRY_READY from a recent confirmed CHoCH
  const sig = r.signals[r.signals.length - 1];
  if (sig && n - 1 - sig.barIndex < cfg.entryValidBars) {
    const ot = suggestOrderType(sig.direction, price, sig.entry, r.atrLtf, true);
    candidates.push({
      ...base, stage: 'ENTRY_READY', direction: sig.direction,
      setupId: `${sig.direction}:${sig.zoneStartTime}:${sig.time}`,
      zone: zoneOf(r.zones.find(z => z.id === sig.zoneId)),
      entry: sig.entry, sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2,
      orderType: ot.type, orderNote: ot.note, barsSinceTap: null,
    });
  }

  // ARMED: tap window open (closed bars, or live bar tapping a live zone)
  for (const dir of ['LONG', 'SHORT'] as Direction[]) {
    const isLong = dir === 'LONG';
    const alive = r.zones.filter(z => z.isDemand === isLong && !z.invalidated);
    const tapBar = isLong ? r.lastDemandTapBar : r.lastSupplyTapBar;
    const tapped = isLong ? r.lastTappedDemand : r.lastTappedSupply;
    let zone: Zone | null = null;
    let since: number | null = null;
    if (tapBar !== null && n - tapBar <= cfg.maxBarsAfterTap && tapped && !tapped.invalidated) {
      zone = tapped;
      since = n - tapBar;
    }
    if (live) {
      const liveHit = alive.find(z => (isLong ? live.l <= z.top && live.h >= z.bottom : live.h >= z.bottom && live.l <= z.top));
      if (liveHit) { zone = liveHit; since = 0; }
    }
    if (zone && since !== null) {
      const level = isLong ? r.lastLtfHigh : r.lastLtfLow;
      candidates.push({
        ...base, stage: 'ARMED', direction: dir, setupId: `${dir}:${zone.startTime}`, zone: zoneOf(zone),
        distanceAtr: 0, needBreak: f(level) ? level : null, barsSinceTap: since,
        orderType: 'TRIGGER_LIMIT',
        orderNote: f(level) ? `Wait for a 1m close ${isLong ? 'above' : 'below'} ${level}; then trigger-limit at that level.` : 'Waiting for a 1m pivot.',
      });
    }

    // WATCH: closest alive zone within watchDistanceAtr (HTF ATR)
    if (f(r.atrHtf) && r.atrHtf > 0) {
      let best: { z: Zone; d: number } | null = null;
      for (const z of alive) {
        const d = isLong ? price - z.top : z.bottom - price; // >0 means approaching from the correct side
        if (d <= 0) continue;
        if (!best || d < best.d) best = { z, d };
      }
      if (best && best.d / r.atrHtf <= cfg.watchDistanceAtr) {
        candidates.push({
          ...base, stage: 'WATCH', direction: dir, setupId: `${dir}:${best.z.startTime}`, zone: zoneOf(best.z),
          distanceAtr: best.d / r.atrHtf,
        });
      }
    }
  }

  if (!candidates.length) return base;
  const rank: Record<Stage, number> = { IDLE: 0, WATCH: 1, ARMED: 2, ENTRY_READY: 3 };
  candidates.sort((a, b) => rank[b.stage] - rank[a.stage] || (a.distanceAtr ?? 0) - (b.distanceAtr ?? 0));
  return candidates[0];
}

function zoneOf(z: Zone | undefined | null) {
  return z ? { top: z.top, bottom: z.bottom, startTime: z.startTime } : null;
}
