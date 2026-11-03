import type { Candle, Direction, EntrySignal, Mod01eCfg, Setup } from '../types.js';
import { DEFAULT_MOD01E_CFG } from '../types.js';
import { aggregateClosed, atr, inKillzone } from './indicators.js';

function pivot(c: Candle[], p: number, len: number, high: boolean): boolean {
  if (p < len || p + len >= c.length) return false;
  return c.slice(p - len, p + len + 1).every((b, j) => j === len || (high ? b.h < c[p].h : b.l > c[p].l));
}
export function computeStructure(c: Candle[], len = 5) {
  let lastHigh: number | null = null, lastLow: number | null = null;
  let lastHighTime: number | null = null, lastLowTime: number | null = null, trend = 0;
  for (let i = 0; i < c.length; i++) {
    const p = i - len;
    if (pivot(c, p, len, true)) { lastHigh = c[p].h; lastHighTime = c[p].t; }
    if (pivot(c, p, len, false)) { lastLow = c[p].l; lastLowTime = c[p].t; }
    if (lastHigh !== null && c[i].c > lastHigh) trend = 1;
    else if (lastLow !== null && c[i].c < lastLow) trend = -1;
  }
  return { trend, lastHigh, lastLow, lastHighTime, lastLowTime };
}
export function calcFibLevel(_long: boolean, zero: number, one: number, ratio: number) {
  return zero + (one - zero) * ratio;
}
export function validateMod01eConfig(input: Partial<Mod01eCfg>): Mod01eCfg {
  const cfg = { ...DEFAULT_MOD01E_CFG, ...input };
  for (const [key, value] of Object.entries(cfg)) {
    if (!(key in DEFAULT_MOD01E_CFG) || typeof value !== typeof DEFAULT_MOD01E_CFG[key as keyof Mod01eCfg] ||
        (typeof value === 'number' && !Number.isFinite(value))) throw new Error(`Invalid setting: ${key}`);
  }
  if (![60, 240].includes(cfg.biasTfMinutes) || ![5, 15, 30, 60].includes(cfg.alignTfMinutes) ||
      ![1, 3, 5, 15].includes(cfg.entryTfMinutes) || cfg.entryTfMinutes > cfg.alignTfMinutes || cfg.biasTfMinutes < cfg.alignTfMinutes) throw new Error('Unsupported timeframe combination');
  for (const k of ['biasPivotLen', 'alignPivotLen', 'entryPivotLen', 'orderExpiry'] as const) {
    if (!Number.isInteger(cfg[k]) || cfg[k] < 1 || cfg[k] > 100) throw new Error(`Invalid ${k}`);
  }
  if (cfg.entryFib <= 0 || cfg.entryFib >= 1 || cfg.zoneNear < 0 || cfg.zoneFar > 1 || cfg.zoneNear >= cfg.zoneFar ||
      cfg.stopBufferAtr < 0 || cfg.stopBufferAtr > 5 || cfg.rrTP1 <= 0 || cfg.rrTP2 <= cfg.rrTP1 || cfg.watchDistanceAtr < 0 ||
      !['Body close', 'Wick'].includes(cfg.breakRule)) throw new Error('Invalid entry, stop or target settings');
  return cfg;
}
export interface PendingLimit {
  direction: Direction; rangeZero: number; rangeOne: number; plannedEntry: number; plannedStop: number;
  plannedTp1: number; plannedTp2: number; chochTime: number; chochBarIndex: number;
  zoneTop: number; zoneBottom: number; expiresAt: number;
}
export interface Mod01eScanResult {
  biasTrend: number; alignTrend: number; longAllowed: boolean; shortAllowed: boolean;
  pendingOrder: PendingLimit | null; signals: EntrySignal[]; watchLevel: number | null;
  atrLtf: number; atr15m: number; atr1h: number; reason: string;
  terminalOrder: { order: PendingLimit; status: 'EXPIRED' | 'INVALIDATED'; time: number } | null;
}
/** Chronological replay: gates see only structure and ATR known at each candle close. */
export function scanMod01e(ltf1m: Candle[], candles1h?: Candle[], cfg = DEFAULT_MOD01E_CFG): Mod01eScanResult {
  const align = aggregateClosed(ltf1m, cfg.alignTfMinutes);
  const end = (ltf1m.at(-1)?.t ?? -60) + 60;
  const bias = (candles1h ?? aggregateClosed(ltf1m, cfg.biasTfMinutes)).filter(b => b.t + cfg.biasTfMinutes * 60 <= end);
  const atrAlign = atr(align);
  let pending: PendingLimit | null = null;
  let terminalOrder: Mod01eScanResult['terminalOrder'] = null;
  const signals: EntrySignal[] = [];
  let swingH: number | null = null, swingL: number | null = null, direction = 0, cursor = 0;
  let lastBias = 0, lastAlign = 0;
  const allowed = (dir: Direction) => dir === 'LONG' ? lastBias === 1 && (!cfg.requireAlignment || lastAlign === 1) : lastBias === -1 && (!cfg.requireAlignment || lastAlign === -1);
  const cancel = (status: 'EXPIRED' | 'INVALIDATED', time: number) => {
    if (pending) terminalOrder = { order: pending, status, time };
    pending = null;
  };
  const executeUntil = (time: number) => {
    while (cursor < ltf1m.length && ltf1m[cursor].t + 60 <= time) {
      const b = ltf1m[cursor++];
      if (!pending || b.t < pending.chochTime + cfg.alignTfMinutes * 60) continue;
      if (b.t >= pending.expiresAt) { cancel('EXPIRED', b.t); continue; }
      const long = pending.direction === 'LONG';
      // Ambiguous minute touching both stop and entry is conservatively invalidated.
      if (long ? b.l <= pending.plannedStop : b.h >= pending.plannedStop) { cancel('INVALIDATED', b.t); continue; }
      if (long ? b.l <= pending.plannedEntry : b.h >= pending.plannedEntry) {
        signals.push({ direction: pending.direction, barIndex: cursor - 1, time: b.t + 60,
          entry: pending.plannedEntry, sl: pending.plannedStop, tp1: pending.plannedTp1, tp2: pending.plannedTp2,
          zoneId: `01E:${pending.direction}:${pending.chochTime}`, zoneStartTime: pending.chochTime, inKillzone: inKillzone(b.t) });
        pending = null;
      }
    }
  };
  for (let i = 0; i < align.length; i++) {
    const bar = align[i], completion = bar.t + cfg.alignTfMinutes * 60;
    executeUntil(completion);
    lastBias = computeStructure(bias.filter(b => b.t + cfg.biasTfMinutes * 60 <= completion), cfg.biasPivotLen).trend;
    lastAlign = computeStructure(align.slice(0, i + 1), cfg.alignPivotLen).trend;
    if (pending && cfg.cancelBiasFlip && !allowed(pending.direction)) cancel('INVALIDATED', completion);
    const p = i - cfg.entryPivotLen, prefix = align.slice(0, i + 1);
    if (pivot(prefix, p, cfg.entryPivotLen, true)) swingH = align[p].h;
    if (pivot(prefix, p, cfg.entryPivotLen, false)) swingL = align[p].l;
    const up = swingH !== null && (cfg.breakRule === 'Body close' ? bar.c : bar.h) > swingH;
    const down = swingL !== null && (cfg.breakRule === 'Body close' ? bar.c : bar.l) < swingL;
    const chochUp = up && direction === -1, chochDown = down && direction === 1;
    if (up) direction = 1; else if (down) direction = -1;
    if (!chochUp && !chochDown) continue;
    if (pending && cfg.cancelNewChoch) cancel('INVALIDATED', completion);
    if (pending || (cfg.useKillzone && !inKillzone(completion))) continue;
    const dir: Direction = chochUp ? 'LONG' : 'SHORT';
    if (!allowed(dir) || !Number.isFinite(atrAlign[i])) continue;
    const long = dir === 'LONG', range = align.slice(Math.max(0, i - Math.max(cfg.entryPivotLen * 3, 6)), i + 1);
    const zero = (long ? swingH : swingL)!;
    const one = long ? Math.min(...range.map(b => b.l)) : Math.max(...range.map(b => b.h));
    const entry = calcFibLevel(long, zero, one, cfg.entryFib);
    const stop = one + (long ? -1 : 1) * atrAlign[i] * cfg.stopBufferAtr;
    const risk = long ? entry - stop : stop - entry;
    if (risk <= 0 || entry <= 0 || stop <= 0) continue;
    const tp1 = entry + (long ? 1 : -1) * risk * cfg.rrTP1, tp2 = entry + (long ? 1 : -1) * risk * cfg.rrTP2;
    if (tp1 <= 0 || tp2 <= 0) continue;
    const a = calcFibLevel(long, zero, one, cfg.zoneNear), b = calcFibLevel(long, zero, one, cfg.zoneFar);
    pending = { direction: dir, rangeZero: zero, rangeOne: one, plannedEntry: entry, plannedStop: stop,
      plannedTp1: tp1, plannedTp2: tp2, chochTime: bar.t, chochBarIndex: i, zoneTop: Math.max(a, b), zoneBottom: Math.min(a, b),
      expiresAt: completion + cfg.orderExpiry * cfg.entryTfMinutes * 60 };
  }
  executeUntil(end);
  if (pending && end >= (pending as PendingLimit).expiresAt) cancel('EXPIRED', end);
  const bs = computeStructure(bias, cfg.biasPivotLen), as = computeStructure(align, cfg.alignPivotLen);
  const longAllowed = bs.trend === 1 && (!cfg.requireAlignment || as.trend === 1);
  const shortAllowed = bs.trend === -1 && (!cfg.requireAlignment || as.trend === -1);
  const reason = bias.length < cfg.biasPivotLen * 2 + 1 || align.length < Math.max(14, cfg.alignPivotLen * 2 + 1)
    ? 'Warming up: insufficient completed structure candles' : bs.trend === 0 ? 'Waiting for confirmed higher timeframe bias'
    : !longAllowed && !shortAllowed ? 'Higher timeframe bias and alignment disagree'
    : cfg.useKillzone && !inKillzone(end) ? 'Outside configured UTC trading sessions' : 'Waiting for a new CHoCH and Fibonacci retest';
  return { biasTrend: bs.trend, alignTrend: as.trend, longAllowed, shortAllowed, pendingOrder: pending, signals,
    watchLevel: longAllowed ? swingH : shortAllowed ? swingL : null, atrLtf: atr(aggregateClosed(ltf1m, cfg.entryTfMinutes)).at(-1) || 0,
    atr15m: atrAlign.at(-1) || 0, atr1h: atr(bias).at(-1) || 0, reason, terminalOrder };
}
export function evaluateMod01e(symbol: string, closed1m: Candle[], forming1m: Candle | null, candles1h?: Candle[], cfg = DEFAULT_MOD01E_CFG): Setup {
  const last = forming1m ?? closed1m.at(-1), now = forming1m?.t ?? (last ? last.t + 60 : Math.floor(Date.now() / 1000));
  const base: Setup = { symbol, stage: 'IDLE', direction: null, setupId: null, price: last?.c ?? NaN,
    zone: null, distanceAtr: null, needBreak: null, barsSinceTap: null, entry: null, sl: null, tp1: null, tp2: null,
    orderType: null, orderNote: null, killzone: !cfg.useKillzone || inKillzone(now), atrHtf: null, atrLtf: null,
    strategyId: 'MOD-01E', ltfMinutes: cfg.entryTfMinutes, ts: now, reason: 'Waiting for candle history' };
  if (closed1m.length < 20) return base;
  const res = scanMod01e(closed1m, candles1h, cfg);
  base.reason = res.reason; base.atrHtf = res.atr1h; base.atrLtf = res.atrLtf;
  const sig = res.signals.at(-1);
  if (sig && now >= sig.time && now - sig.time < cfg.entryTfMinutes * 60 * 3) return { ...base, stage: 'ENTRY_READY',
    direction: sig.direction, setupId: `${symbol}:${sig.zoneId}`, entry: sig.entry, sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2,
    orderType: 'LIMIT', orderStatus: 'TOUCHED', reason: 'Limit touched in market data; simulated entry',
    orderNote: 'Simulated limit touch; exchange fill is not confirmed' };
  const o = res.pendingOrder;
  if (o) return { ...base, stage: 'ARMED', direction: o.direction, setupId: `${symbol}:01E:${o.direction}:${o.chochTime}`,
    zone: { top: o.zoneTop, bottom: o.zoneBottom, startTime: o.chochTime }, entry: o.plannedEntry, sl: o.plannedStop,
    tp1: o.plannedTp1, tp2: o.plannedTp2, orderType: 'LIMIT', orderStatus: 'PENDING', expiresAt: o.expiresAt, needBreak: o.plannedEntry,
    barsSinceTap: Math.max(0, Math.floor((now - o.chochTime - cfg.alignTfMinutes * 60) / (cfg.entryTfMinutes * 60))),
    reason: 'Confirmed CHoCH; waiting for limit retest', orderNote: `Pending ${cfg.entryFib} Fibonacci limit` };
  const terminal = res.terminalOrder;
  if (terminal && now - terminal.time < cfg.entryTfMinutes * 60) {
    base.orderStatus = terminal.status; base.setupId = `${symbol}:01E:${terminal.order.direction}:${terminal.order.chochTime}`;
    base.reason = terminal.status === 'EXPIRED' ? 'Limit expired without a touch' : 'Limit invalidated by structure or stop boundary';
  }
  if ((res.longAllowed || res.shortAllowed) && res.watchLevel !== null && res.atr15m > 0 && base.killzone) {
    const distance = Math.abs(base.price - res.watchLevel) / res.atr15m;
    if (distance <= cfg.watchDistanceAtr) return { ...base, stage: 'WATCH', direction: res.longAllowed ? 'LONG' : 'SHORT',
      setupId: `01E:WATCH:${res.longAllowed ? 'LONG' : 'SHORT'}:${res.watchLevel}`, distanceAtr: distance, needBreak: res.watchLevel,
      reason: 'Aligned structure; watching for CHoCH confirmation' };
  }
  return base;
}
