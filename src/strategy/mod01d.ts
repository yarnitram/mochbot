import type { Candle, Direction, EntrySignal, Mod01dCfg, Setup, Stage, Zone } from '../types.js';
import { DEFAULT_MOD01D_CFG } from '../types.js';
import { aggregate, atr, inKillzone } from './indicators.js';
import { suggestOrderType } from '../engine/orderType.js';

export interface Mod01dScanResult {
  biasTrend: number; // 1 = Bullish, -1 = Bearish, 0 = Neutral
  locationTrend: number;
  demandZones: Zone[];
  supplyZones: Zone[];
  lastDemandTapTime: number | null;
  lastSupplyTapTime: number | null;
  reactionChoched: boolean;
  reactionExtreme: number | null;
  entryBreakLevel: number | null;
  signals: EntrySignal[];
  atrLtf: number;
  atr1h: number;
  atr15m: number;
}

const f = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

function pivotHigh(candles: Candle[], p: number, len: number): boolean {
  if (p < len || p + len >= candles.length) return false;
  const v = candles[p].h;
  for (let j = p - len; j <= p + len; j++) {
    if (j !== p && candles[j].h >= v) return false;
  }
  return true;
}

function pivotLow(candles: Candle[], p: number, len: number): boolean {
  if (p < len || p + len >= candles.length) return false;
  const v = candles[p].l;
  for (let j = p - len; j <= p + len; j++) {
    if (j !== p && candles[j].l <= v) return false;
  }
  return true;
}

/** Compute swing pivots and trend breaks on a candle series */
export function computeStructure(candles: Candle[], pivotLen = 3): { trend: number; lastHigh: number | null; lastLow: number | null } {
  let lastH: number | null = null;
  let lastL: number | null = null;
  let trend = 0;

  for (let i = 0; i < candles.length; i++) {
    const p = i - pivotLen;
    if (p >= pivotLen) {
      if (pivotHigh(candles, p, pivotLen)) lastH = candles[p].h;
      if (pivotLow(candles, p, pivotLen)) lastL = candles[p].l;
    }
    const c = candles[i].c;
    if (lastH !== null && c > lastH) {
      trend = 1;
    } else if (lastL !== null && c < lastL) {
      trend = -1;
    }
  }

  return { trend, lastHigh: lastH, lastLow: lastL };
}

/**
 * Scan candles for MOD-01D structure:
 * 4H Bias -> 1H POI -> 15m Reaction CHoCH -> 5m Entry CHoCH
 */
export function scanMod01d(
  ltf1m: Candle[],
  candles1h?: Candle[],
  candles4h?: Candle[],
  cfg: Mod01dCfg = DEFAULT_MOD01D_CFG
): Mod01dScanResult {
  // Aggregate if HTF candle sets were not provided
  const tf5m = aggregate(ltf1m, cfg.entryTfMinutes);
  const tf15m = aggregate(ltf1m, cfg.reactionTfMinutes);
  const tf1h = candles1h && candles1h.length >= 5 ? candles1h : aggregate(ltf1m, cfg.locationTfMinutes);
  const tf4h = candles4h && candles4h.length >= 5 ? candles4h : aggregate(ltf1m, cfg.biasTfMinutes);

  const atr5mArr = atr(tf5m, 14);
  const atr15mArr = atr(tf15m, 14);
  const atr1hArr = atr(tf1h, 14);

  const atrLtf = atr5mArr[atr5mArr.length - 1] || 0;
  const atr15m = atr15mArr[atr15mArr.length - 1] || 0;
  const atr1h = atr1hArr[atr1hArr.length - 1] || 0;

  // Gate 1: 4H Bias & 1H Location Structure
  const biasStruct = computeStructure(tf4h, cfg.biasPivotLen);
  const locStruct = computeStructure(tf1h, cfg.locationPivotLen);

  const longBias = biasStruct.trend === 1 && (!cfg.requireOneHourAlign || locStruct.trend === 1);
  const shortBias = biasStruct.trend === -1 && (!cfg.requireOneHourAlign || locStruct.trend === -1);

  // Gate 2: 1H Strict POI Detection
  const demandZones: Zone[] = [];
  const supplyZones: Zone[] = [];

  for (let k = 2; k < tf1h.length; k++) {
    const b1 = tf1h[k];     // displacement candle
    const b2 = tf1h[k - 1]; // zone base candle
    const b3 = tf1h[k - 2]; // preceding candle
    const a1 = atr1hArr[k] || (b1.h - b1.l);

    const bullDisplace = b1.c > b1.o && b1.c > b2.h && (b1.c - b1.o) >= a1 * cfg.bodyAtr;
    const bearDisplace = b1.c < b1.o && b1.c < b2.l && (b1.o - b1.c) >= a1 * cfg.bodyAtr;

    const bullSweep = b2.l < b3.l;
    const bearSweep = b2.h > b3.h;

    const bullFvg = b1.l > b3.h;
    const bearFvg = b1.h < b3.l;

    // Strict 1H Demand
    if (b2.o > b2.c && bullDisplace && (!cfg.strictPoi || (bullSweep && (bullFvg || b1.c > b2.h)))) {
      const top = Math.max(b2.o, b2.c);
      const bottom = b2.l;
      if (top > bottom) {
        demandZones.push({
          id: `D:${b2.t}`,
          isDemand: true,
          top,
          bottom,
          startTime: b2.t,
          createdTime: b1.t,
          invalidated: false,
          mitigated: false,
        });
      }
    }

    // Strict 1H Supply
    if (b2.c > b2.o && bearDisplace && (!cfg.strictPoi || (bearSweep && (bearFvg || b1.c < b2.l)))) {
      const top = b2.h;
      const bottom = Math.min(b2.o, b2.c);
      if (top > bottom) {
        supplyZones.push({
          id: `S:${b2.t}`,
          isDemand: false,
          top,
          bottom,
          startTime: b2.t,
          createdTime: b1.t,
          invalidated: false,
          mitigated: false,
        });
      }
    }
  }

  // Check invalidation against recent 1m candles
  for (const bar of ltf1m) {
    for (const z of demandZones) {
      if (bar.c < z.bottom) z.invalidated = true;
    }
    for (const z of supplyZones) {
      if (bar.c > z.top) z.invalidated = true;
    }
  }

  // Gate 3 & 4: Tap, 15m Reaction CHoCH, and 5m Entry CHoCH
  let lastDemandTapTime: number | null = null;
  let lastSupplyTapTime: number | null = null;
  let activeDemand: Zone | null = null;
  let activeSupply: Zone | null = null;
  let reactionExtreme: number | null = null;
  let reactionChoched = false;
  let entryBreakLevel: number | null = null;
  const signals: EntrySignal[] = [];

  // Find recent active zone taps
  if (longBias) {
    for (let i = demandZones.length - 1; i >= 0; i--) {
      const z = demandZones[i];
      if (z.invalidated) continue;
      // check if any 1m bar tapped the zone
      for (const bar of ltf1m) {
        if (bar.t >= z.createdTime && bar.l <= z.top && bar.h >= z.bottom) {
          lastDemandTapTime = bar.t;
          activeDemand = z;
          z.mitigated = true;
          break;
        }
      }
      if (activeDemand) break;
    }
  }

  if (shortBias) {
    for (let i = supplyZones.length - 1; i >= 0; i--) {
      const z = supplyZones[i];
      if (z.invalidated) continue;
      for (const bar of ltf1m) {
        if (bar.t >= z.createdTime && bar.h >= z.bottom && bar.l <= z.top) {
          lastSupplyTapTime = bar.t;
          activeSupply = z;
          z.mitigated = true;
          break;
        }
      }
      if (activeSupply) break;
    }
  }

  // If long tap active: check 15m reaction CHoCH
  if (longBias && activeDemand && lastDemandTapTime !== null) {
    // 15m bars after tap
    const postTap15m = tf15m.filter(b => b.t >= lastDemandTapTime!);
    if (postTap15m.length <= cfg.maxReactionBars) {
      // Find lowest low after tap
      reactionExtreme = Math.min(...postTap15m.map(b => b.l), activeDemand.bottom);

      // Check 15m swing high break
      const struct15m = computeStructure(tf15m, cfg.reactionPivotLen);
      const choched = postTap15m.some(b => struct15m.lastHigh !== null && b.c > struct15m.lastHigh);

      if (choched) {
        reactionChoched = true;
        // Freeze 5m swing high as entryBreakLevel
        const struct5m = computeStructure(tf5m, cfg.entryPivotLen);
        entryBreakLevel = struct5m.lastHigh;

        // Check 5m entry breakout
        if (entryBreakLevel !== null) {
          const recent5m = tf5m.slice(-cfg.maxEntryBars);
          const trig = recent5m.find(b => b.c > entryBreakLevel!);
          if (trig) {
            const reactionStop = reactionExtreme - atr5mArr[atr5mArr.length - 1] * cfg.slBufferAtr;
            const poiStop = activeDemand.bottom - atr5mArr[atr5mArr.length - 1] * cfg.slBufferAtr;
            const sl = cfg.stopMode === 'Reaction swing only' ? reactionStop : Math.min(reactionStop, poiStop);
            const entry = trig.c;
            const risk = Math.abs(entry - sl);
            if (risk > 0 && sl < entry) {
              signals.push({
                direction: 'LONG',
                barIndex: tf5m.indexOf(trig),
                time: trig.t,
                entry,
                sl,
                tp1: entry + risk * cfg.rrTP1,
                tp2: entry + risk * cfg.rrTP2,
                zoneId: activeDemand.id,
                zoneStartTime: activeDemand.startTime,
                inKillzone: inKillzone(trig.t),
              });
            }
          }
        }
      }
    }
  }

  // If short tap active: check 15m reaction CHoCH
  if (shortBias && activeSupply && lastSupplyTapTime !== null) {
    const postTap15m = tf15m.filter(b => b.t >= lastSupplyTapTime!);
    if (postTap15m.length <= cfg.maxReactionBars) {
      reactionExtreme = Math.max(...postTap15m.map(b => b.h), activeSupply.top);

      const struct15m = computeStructure(tf15m, cfg.reactionPivotLen);
      const choched = postTap15m.some(b => struct15m.lastLow !== null && b.c < struct15m.lastLow);

      if (choched) {
        reactionChoched = true;
        const struct5m = computeStructure(tf5m, cfg.entryPivotLen);
        entryBreakLevel = struct5m.lastLow;

        if (entryBreakLevel !== null) {
          const recent5m = tf5m.slice(-cfg.maxEntryBars);
          const trig = recent5m.find(b => b.c < entryBreakLevel!);
          if (trig) {
            const reactionStop = reactionExtreme + atr5mArr[atr5mArr.length - 1] * cfg.slBufferAtr;
            const poiStop = activeSupply.top + atr5mArr[atr5mArr.length - 1] * cfg.slBufferAtr;
            const sl = cfg.stopMode === 'Reaction swing only' ? reactionStop : Math.max(reactionStop, poiStop);
            const entry = trig.c;
            const risk = Math.abs(entry - sl);
            if (risk > 0 && sl > entry) {
              signals.push({
                direction: 'SHORT',
                barIndex: tf5m.indexOf(trig),
                time: trig.t,
                entry,
                sl,
                tp1: entry - risk * cfg.rrTP1,
                tp2: entry - risk * cfg.rrTP2,
                zoneId: activeSupply.id,
                zoneStartTime: activeSupply.startTime,
                inKillzone: inKillzone(trig.t),
              });
            }
          }
        }
      }
    }
  }

  return {
    biasTrend: biasStruct.trend,
    locationTrend: locStruct.trend,
    demandZones,
    supplyZones,
    lastDemandTapTime,
    lastSupplyTapTime,
    reactionChoched,
    reactionExtreme,
    entryBreakLevel,
    signals,
    atrLtf,
    atr1h,
    atr15m,
  };
}

/** Evaluate live price against MOD-01D rules and emit Setup */
export function evaluateMod01d(
  symbol: string,
  closed1m: Candle[],
  forming1m: Candle | null,
  candles1h?: Candle[],
  candles4h?: Candle[],
  cfg: Mod01dCfg = DEFAULT_MOD01D_CFG
): Setup {
  const live = forming1m && Number.isFinite(forming1m.c) ? forming1m : null;
  const lastClosed = closed1m[closed1m.length - 1];
  const price = live ? live.c : lastClosed ? lastClosed.c : NaN;
  const nowSec = live ? live.t : lastClosed ? lastClosed.t : Math.floor(Date.now() / 1000);
  const kzNow = inKillzone(nowSec);

  const base: Setup = {
    symbol,
    stage: 'IDLE',
    direction: null,
    setupId: null,
    price,
    zone: null,
    distanceAtr: null,
    needBreak: null,
    barsSinceTap: null,
    entry: null,
    sl: null,
    tp1: null,
    tp2: null,
    orderType: null,
    orderNote: null,
    killzone: kzNow,
    atrHtf: null,
    atrLtf: null,
    strategyId: 'MOD-01D',
    ts: nowSec,
  };

  if (closed1m.length < 20 || !Number.isFinite(price)) return base;

  const res = scanMod01d(closed1m, candles1h, candles4h, cfg);
  base.atrHtf = f(res.atr1h) ? res.atr1h : null;
  base.atrLtf = f(res.atrLtf) ? res.atrLtf : null;

  // 1. ENTRY_READY
  if (res.signals.length > 0) {
    const sig = res.signals[res.signals.length - 1];
    const isRecent = nowSec - sig.time <= cfg.entryTfMinutes * 60 * 3; // within 3 entry bars
    if (isRecent) {
      const ot = suggestOrderType(sig.direction, price, sig.entry, res.atrLtf, true);
      const zone = sig.direction === 'LONG'
        ? res.demandZones.find(z => z.id === sig.zoneId)
        : res.supplyZones.find(z => z.id === sig.zoneId);

      return {
        ...base,
        stage: 'ENTRY_READY',
        direction: sig.direction,
        setupId: `01D:${sig.direction}:${sig.zoneStartTime}:${sig.time}`,
        zone: zone ? { top: zone.top, bottom: zone.bottom, startTime: zone.startTime } : null,
        entry: sig.entry,
        sl: sig.sl,
        tp1: sig.tp1,
        tp2: sig.tp2,
        orderType: ot.type,
        orderNote: `${ot.note} (MOD-01D: 4H bias + 1H POI + 15m/5m CHoCH confirmed)`,
      };
    }
  }

  // 2. ARMED: 1H POI tapped, waiting for 15m reaction CHoCH or 5m breakout
  if (res.lastDemandTapTime !== null && res.demandZones.length > 0) {
    const z = res.demandZones[res.demandZones.length - 1];
    if (!z.invalidated) {
      return {
        ...base,
        stage: 'ARMED',
        direction: 'LONG',
        setupId: `01D:LONG:${z.startTime}`,
        zone: { top: z.top, bottom: z.bottom, startTime: z.startTime },
        distanceAtr: 0,
        needBreak: res.entryBreakLevel,
        barsSinceTap: Math.floor((nowSec - res.lastDemandTapTime) / 900),
        orderType: 'TRIGGER_LIMIT',
        orderNote: res.reactionChoched
          ? `15m CHoCH confirmed ✓. Waiting for 5m close above ${res.entryBreakLevel ? res.entryBreakLevel.toFixed(2) : 'pivot'}.`
          : '1H Demand tapped. Waiting for 15m reaction CHoCH.',
      };
    }
  }

  if (res.lastSupplyTapTime !== null && res.supplyZones.length > 0) {
    const z = res.supplyZones[res.supplyZones.length - 1];
    if (!z.invalidated) {
      return {
        ...base,
        stage: 'ARMED',
        direction: 'SHORT',
        setupId: `01D:SHORT:${z.startTime}`,
        zone: { top: z.top, bottom: z.bottom, startTime: z.startTime },
        distanceAtr: 0,
        needBreak: res.entryBreakLevel,
        barsSinceTap: Math.floor((nowSec - res.lastSupplyTapTime) / 900),
        orderType: 'TRIGGER_LIMIT',
        orderNote: res.reactionChoched
          ? `15m CHoCH confirmed ✓. Waiting for 5m close below ${res.entryBreakLevel ? res.entryBreakLevel.toFixed(2) : 'pivot'}.`
          : '1H Supply tapped. Waiting for 15m reaction CHoCH.',
      };
    }
  }

  // 3. WATCH: Bias confirmed and price approaching active 1H POI
  if (res.biasTrend === 1 && res.demandZones.length > 0 && f(res.atr1h) && res.atr1h > 0) {
    const alive = res.demandZones.filter(z => !z.invalidated);
    for (const z of alive) {
      const d = price - z.top;
      if (d > 0 && d / res.atr1h <= cfg.watchDistanceAtr) {
        return {
          ...base,
          stage: 'WATCH',
          direction: 'LONG',
          setupId: `01D:LONG:${z.startTime}`,
          zone: { top: z.top, bottom: z.bottom, startTime: z.startTime },
          distanceAtr: d / res.atr1h,
          orderNote: `4H Bullish bias active. Approaching 1H Demand zone (${(d / res.atr1h).toFixed(2)} ATR).`,
        };
      }
    }
  }

  if (res.biasTrend === -1 && res.supplyZones.length > 0 && f(res.atr1h) && res.atr1h > 0) {
    const alive = res.supplyZones.filter(z => !z.invalidated);
    for (const z of alive) {
      const d = z.bottom - price;
      if (d > 0 && d / res.atr1h <= cfg.watchDistanceAtr) {
        return {
          ...base,
          stage: 'WATCH',
          direction: 'SHORT',
          setupId: `01D:SHORT:${z.startTime}`,
          zone: { top: z.top, bottom: z.bottom, startTime: z.startTime },
          distanceAtr: d / res.atr1h,
          orderNote: `4H Bearish bias active. Approaching 1H Supply zone (${(d / res.atr1h).toFixed(2)} ATR).`,
        };
      }
    }
  }

  return base;
}
