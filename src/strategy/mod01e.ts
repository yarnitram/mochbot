import type { Candle, Direction, EntrySignal, Mod01eCfg, Setup, Stage, Zone } from '../types.js';
import { DEFAULT_MOD01E_CFG } from '../types.js';
import { aggregate, atr, inKillzone } from './indicators.js';

export interface Mod01eScanResult {
  biasTrend: number;   // 1 = Bullish, -1 = Bearish, 0 = Neutral
  alignTrend: number;  // 1 = Bullish, -1 = Bearish, 0 = Neutral
  longAllowed: boolean;
  shortAllowed: boolean;
  pendingOrder: {
    direction: Direction;
    rangeZero: number;
    rangeOne: number;
    plannedEntry: number;
    plannedStop: number;
    plannedTp1: number;
    plannedTp2: number;
    chochTime: number;
    chochBarIndex: number;
    zoneTop: number;
    zoneBottom: number;
  } | null;
  signals: EntrySignal[];
  watchLevel: number | null;
  atrLtf: number;
  atr15m: number;
  atr1h: number;
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
export function computeStructure(candles: Candle[], pivotLen = 5): {
  trend: number;
  lastHigh: number | null;
  lastLow: number | null;
  lastHighTime: number | null;
  lastLowTime: number | null;
} {
  let swingHigh: number | null = null;
  let swingLow: number | null = null;
  let swingHighTime: number | null = null;
  let swingLowTime: number | null = null;
  let trend = 0;

  for (let i = 0; i < candles.length; i++) {
    const p = i - pivotLen;
    if (p >= pivotLen) {
      if (pivotHigh(candles, p, pivotLen)) {
        swingHigh = candles[p].h;
        swingHighTime = candles[p].t;
      }
      if (pivotLow(candles, p, pivotLen)) {
        swingLow = candles[p].l;
        swingLowTime = candles[p].t;
      }
    }
    const c = candles[i].c;
    if (swingHigh !== null && c > swingHigh) {
      trend = 1;
    } else if (swingLow !== null && c < swingLow) {
      trend = -1;
    }
  }

  return { trend, lastHigh: swingHigh, lastLow: swingLow, lastHighTime: swingHighTime, lastLowTime: swingLowTime };
}

/**
 * Calculate Fibonacci retracement level:
 * Long: 0 is broken high, 1 is impulse low. Retracement pulls back downward from 0 towards 1.
 * Short: 0 is broken low, 1 is impulse high. Retracement pulls back upward from 0 towards 1.
 */
export function calcFibLevel(isLong: boolean, zero: number, one: number, ratio: number): number {
  return isLong ? zero - (zero - one) * ratio : zero + (one - zero) * ratio;
}

/**
 * Scan candles for MOD-01E structure:
 * 1H Bias + 15m Alignment + 15m CHoCH Dealing Range + 5m Fib Limit Entry
 */
export function scanMod01e(
  ltf1m: Candle[],
  candles1h?: Candle[],
  cfg: Mod01eCfg = DEFAULT_MOD01E_CFG
): Mod01eScanResult {
  const tfEntry = aggregate(ltf1m, cfg.entryTfMinutes);
  const tfAlign = aggregate(ltf1m, cfg.alignTfMinutes);
  const tfBias = candles1h && candles1h.length >= 5 ? candles1h : aggregate(ltf1m, cfg.biasTfMinutes);

  const atrEntryArr = atr(tfEntry, 14);
  const atrAlignArr = atr(tfAlign, 14);
  const atrBiasArr = atr(tfBias, 14);

  const atrLtf = atrEntryArr[atrEntryArr.length - 1] || 0;
  const atr15m = atrAlignArr[atrAlignArr.length - 1] || 0;
  const atr1h = atrBiasArr[atrBiasArr.length - 1] || 0;

  // 1. Timeframe Alignment
  const biasStruct = computeStructure(tfBias, cfg.biasPivotLen);
  const alignStruct = computeStructure(tfAlign, cfg.alignPivotLen);

  const longAllowed = biasStruct.trend === 1 && (!cfg.requireAlignment || alignStruct.trend === 1);
  const shortAllowed = biasStruct.trend === -1 && (!cfg.requireAlignment || alignStruct.trend === -1);

  // 2. Track 15m CHoCH Swings & Breakouts
  const entryLen = cfg.entryPivotLen;
  let swingH: number | null = null;
  let swingL: number | null = null;
  let swingHTime: number | null = null;
  let swingLTime: number | null = null;
  let direction = 0; // 1 = broke high, -1 = broke low

  let activePending: Mod01eScanResult['pendingOrder'] = null;
  const signals: EntrySignal[] = [];

  for (let i = 0; i < tfAlign.length; i++) {
    const p = i - entryLen;
    if (p >= entryLen) {
      if (pivotHigh(tfAlign, p, entryLen)) {
        swingH = tfAlign[p].h;
        swingHTime = tfAlign[p].t;
      }
      if (pivotLow(tfAlign, p, entryLen)) {
        swingL = tfAlign[p].l;
        swingLTime = tfAlign[p].t;
      }
    }

    const bar = tfAlign[i];
    const checkPriceHigh = cfg.breakRule === 'Body close' ? bar.c : bar.h;
    const checkPriceLow = cfg.breakRule === 'Body close' ? bar.c : bar.l;

    const upBreak = swingH !== null && checkPriceHigh > swingH;
    const downBreak = swingL !== null && checkPriceLow < swingL;

    const chochUp = upBreak && direction === -1;
    const chochDown = downBreak && direction === 1;

    if (upBreak) direction = 1;
    else if (downBreak) direction = -1;

    // Check for valid CHoCH in alignment with 1H & 15m
    const isBullChoch = chochUp && longAllowed;
    const isBearChoch = chochDown && shortAllowed;

    if (isBullChoch || isBearChoch) {
      const isLong = isBullChoch;
      // Anchor impulse extreme from recent 15m bars
      const lookback = Math.max(entryLen * 3, 6);
      const startIdx = Math.max(0, i - lookback);
      const impulseSlice = tfAlign.slice(startIdx, i + 1);

      let impulseExtreme: number;
      if (isLong) {
        impulseExtreme = Math.min(...impulseSlice.map(c => c.l));
      } else {
        impulseExtreme = Math.max(...impulseSlice.map(c => c.h));
      }

      // Fib 0 anchors to the broken swing level; Fib 1 anchors to the impulse extreme
      const rangeZero = isLong ? (swingH ?? bar.h) : (swingL ?? bar.l);
      const rangeOne = impulseExtreme;
      const rangeSize = Math.abs(rangeZero - rangeOne);

      if (rangeSize > 0) {
        const plannedEntry = Number(calcFibLevel(isLong, rangeZero, rangeOne, cfg.entryFib).toFixed(8));
        const plannedStop = Number((isLong
          ? rangeOne - atr15m * cfg.stopBufferAtr
          : rangeOne + atr15m * cfg.stopBufferAtr
        ).toFixed(8));
        const risk = Math.abs(plannedEntry - plannedStop);

        if (risk > 0) {
          const plannedTp1 = Number((plannedEntry + (isLong ? 1 : -1) * risk * cfg.rrTP1).toFixed(8));
          const plannedTp2 = Number((plannedEntry + (isLong ? 1 : -1) * risk * cfg.rrTP2).toFixed(8));

          const zoneA = calcFibLevel(isLong, rangeZero, rangeOne, cfg.zoneNear);
          const zoneB = calcFibLevel(isLong, rangeZero, rangeOne, cfg.zoneFar);

          activePending = {
            direction: isLong ? 'LONG' : 'SHORT',
            rangeZero,
            rangeOne,
            plannedEntry,
            plannedStop,
            plannedTp1,
            plannedTp2,
            chochTime: bar.t,
            chochBarIndex: i,
            zoneTop: Math.max(zoneA, zoneB),
            zoneBottom: Math.min(zoneA, zoneB),
          };
        }
      }
    }
  }

  // 3. Evaluate Execution Bars for Pending Limit Order Fill or Expiry
  if (activePending) {
    // The limit order rests on execution bars strictly AFTER the 15m CHoCH bar has completed
    const barCompletionTime = activePending.chochTime + cfg.alignTfMinutes * 60;
    const pendingBars = tfEntry.filter(b => b.t >= barCompletionTime);
    let orderFilled = false;
    let orderCancelled = false;

    for (let j = 0; j < pendingBars.length; j++) {
      const b = pendingBars[j];

      // Expiry check
      if (j >= cfg.orderExpiry) {
        orderCancelled = true;
        break;
      }

      // Check violation of planned stop before filling
      if (activePending.direction === 'LONG' && b.l <= activePending.plannedStop) {
        orderCancelled = true;
        break;
      }
      if (activePending.direction === 'SHORT' && b.h >= activePending.plannedStop) {
        orderCancelled = true;
        break;
      }

      // Check fill of limit order
      const filled = activePending.direction === 'LONG'
        ? b.l <= activePending.plannedEntry
        : b.h >= activePending.plannedEntry;

      if (filled) {
        orderFilled = true;
        signals.push({
          direction: activePending.direction,
          barIndex: j,
          time: b.t,
          entry: activePending.plannedEntry,
          sl: activePending.plannedStop,
          tp1: activePending.plannedTp1,
          tp2: activePending.plannedTp2,
          zoneId: `01E:${activePending.direction}:${activePending.chochTime}`,
          zoneStartTime: activePending.chochTime,
          inKillzone: inKillzone(b.t),
        });
        break;
      }
    }

    if (orderFilled || orderCancelled) {
      activePending = null;
    }
  }

  const watchLevel = longAllowed ? swingH : shortAllowed ? swingL : null;

  return {
    biasTrend: biasStruct.trend,
    alignTrend: alignStruct.trend,
    longAllowed,
    shortAllowed,
    pendingOrder: activePending,
    signals,
    watchLevel,
    atrLtf,
    atr15m,
    atr1h,
  };
}

/** Evaluate live price against MOD-01E rules and emit Setup */
export function evaluateMod01e(
  symbol: string,
  closed1m: Candle[],
  forming1m: Candle | null,
  candles1h?: Candle[],
  cfg: Mod01eCfg = DEFAULT_MOD01E_CFG
): Setup {
  const live = forming1m && Number.isFinite(forming1m.c) ? forming1m : null;
  const lastClosed = closed1m[closed1m.length - 1];
  const price = live ? live.c : lastClosed ? lastClosed.c : NaN;
  const nowSec = live ? live.t : lastClosed ? lastClosed.t : Math.floor(Date.now() / 1000);
  const kzNow = cfg.useKillzone ? inKillzone(nowSec) : true;

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
    strategyId: 'MOD-01E',
    ts: nowSec,
  };

  if (closed1m.length < 20 || !Number.isFinite(price)) return base;

  const res = scanMod01e(closed1m, candles1h, cfg);
  base.atrHtf = f(res.atr1h) ? res.atr1h : null;
  base.atrLtf = f(res.atrLtf) ? res.atrLtf : null;

  // 1. Check if a recent limit order was filled on the execution timeframe
  if (res.signals.length > 0) {
    const sig = res.signals[res.signals.length - 1];
    const isRecent = nowSec - sig.time <= cfg.entryTfMinutes * 60 * 3; // within 3 entry bars
    if (isRecent) {
      return {
        ...base,
        stage: 'ENTRY_READY',
        direction: sig.direction,
        setupId: `01E:${sig.direction}:${sig.zoneStartTime}:${sig.time}`,
        zone: { top: Math.max(sig.entry, sig.sl), bottom: Math.min(sig.entry, sig.sl), startTime: sig.zoneStartTime },
        entry: sig.entry,
        sl: sig.sl,
        tp1: sig.tp1,
        tp2: sig.tp2,
        orderType: 'LIMIT',
        orderNote: `LIMIT RETEST FILLED (${cfg.entryFib} Fib OTE) · 1H & 15m aligned`,
      };
    }
  }

  // 2. Check if a limit order is currently resting (ARMED) or being tapped right now
  if (res.pendingOrder) {
    const o = res.pendingOrder;
    const isLong = o.direction === 'LONG';
    const completionTime = o.chochTime + cfg.alignTfMinutes * 60;
    const barsElapsed = Math.max(0, Math.floor((nowSec - completionTime) / (cfg.entryTfMinutes * 60)));

    // Check if live price fills the limit right now
    const liveFill = isLong ? price <= o.plannedEntry && price > o.plannedStop : price >= o.plannedEntry && price < o.plannedStop;
    if (liveFill && barsElapsed <= cfg.orderExpiry) {
      return {
        ...base,
        stage: 'ENTRY_READY',
        direction: o.direction,
        setupId: `01E:${o.direction}:${o.chochTime}:${nowSec}`,
        zone: { top: o.zoneTop, bottom: o.zoneBottom, startTime: o.chochTime },
        entry: o.plannedEntry,
        sl: o.plannedStop,
        tp1: o.plannedTp1,
        tp2: o.plannedTp2,
        orderType: 'LIMIT',
        orderNote: `LIMIT RETEST FILLED (${cfg.entryFib} Fib OTE) · 1H & 15m aligned`,
      };
    }

    // Limit order is actively resting within expiry window
    if (barsElapsed <= cfg.orderExpiry) {
      const distToLimit = Math.abs(price - o.plannedEntry);
      const distAtr = res.atrLtf > 0 ? distToLimit / res.atrLtf : 0;

      return {
        ...base,
        stage: 'ARMED',
        direction: o.direction,
        setupId: `01E:${o.direction}:${o.chochTime}`,
        zone: { top: o.zoneTop, bottom: o.zoneBottom, startTime: o.chochTime },
        distanceAtr: distAtr,
        needBreak: o.plannedEntry,
        barsSinceTap: barsElapsed,
        entry: o.plannedEntry,
        sl: o.plannedStop,
        tp1: o.plannedTp1,
        tp2: o.plannedTp2,
        orderType: 'LIMIT',
        orderNote: `15m CHoCH confirmed ✓. Resting ${cfg.entryFib} Fib ${isLong ? 'Buy' : 'Sell'} Limit at ${o.plannedEntry.toFixed(4)}. OTE zone ${cfg.zoneNear}–${cfg.zoneFar}.`,
      };
    }
  }

  // 3. WATCH: 1H & 15m alignment active, watching for 15m CHoCH break
  if ((res.longAllowed || res.shortAllowed) && res.watchLevel !== null) {
    const dir: Direction = res.longAllowed ? 'LONG' : 'SHORT';
    const dist = dir === 'LONG' ? res.watchLevel - price : price - res.watchLevel;
    const distAtr = res.atr15m > 0 ? dist / res.atr15m : null;

    if (distAtr !== null && distAtr >= 0 && distAtr <= cfg.watchDistanceAtr) {
      return {
        ...base,
        stage: 'WATCH',
        direction: dir,
        setupId: `01E:${dir}:WATCH`,
        distanceAtr: distAtr,
        needBreak: res.watchLevel,
        orderNote: `1H & 15m ${dir === 'LONG' ? 'Bullish' : 'Bearish'} alignment active. Watching for 15m CHoCH break ${dir === 'LONG' ? 'above' : 'below'} ${res.watchLevel.toFixed(4)}.`,
      };
    }
  }

  return base;
}
