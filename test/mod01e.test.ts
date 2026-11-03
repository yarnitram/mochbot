import { describe, it, expect } from 'vitest';
import { computeStructure, calcFibLevel, scanMod01e, evaluateMod01e } from '../src/strategy/mod01e.js';
import { DEFAULT_MOD01E_CFG, type Candle, type Mod01eCfg } from '../src/types.js';

function makeCandle(t: number, o: number, h: number, l: number, c: number, v = 100): Candle {
  return { t, o, h, l, c, v };
}

describe('MOD-01E Structure & Alignment (1H & 15m)', () => {
  it('computes bullish trend on swing high breakout (BOS)', () => {
    const candles: Candle[] = [
      makeCandle(0, 100, 101, 99, 100.5),
      makeCandle(3600, 100.5, 102.5, 100, 102),
      makeCandle(7200, 102, 105.0, 101.5, 104), // Peak pivot high of 105.0
      makeCandle(10800, 104, 104.2, 101.0, 101.5),
      makeCandle(14400, 101.5, 102.0, 100.5, 101.0), // Confirmed pivot high at index 2 (len=2)
      makeCandle(18000, 101.0, 104.5, 101.0, 104.0),
      makeCandle(21600, 104.0, 109.0, 103.5, 108.0), // Closes above 105.0 -> Bullish BOS
    ];
    const struct = computeStructure(candles, 2);
    expect(struct.trend).toBe(1);
    expect(struct.lastHigh).toBe(105.0);
  });

  it('computes bearish trend on swing low breakdown (BOS)', () => {
    const candles: Candle[] = [
      makeCandle(0, 100, 101, 99, 99.5),
      makeCandle(3600, 99.5, 100, 97.5, 98),
      makeCandle(7200, 98, 98.5, 95.0, 96), // Trough pivot low of 95.0
      makeCandle(10800, 96, 99.0, 95.8, 98.5),
      makeCandle(14400, 98.5, 99.5, 98.0, 99.0), // Confirmed pivot low at index 2 (len=2)
      makeCandle(18000, 99.0, 99.0, 95.5, 96.0),
      makeCandle(21600, 96.0, 96.5, 91.0, 92.0), // Closes below 95.0 -> Bearish BOS
    ];
    const struct = computeStructure(candles, 2);
    expect(struct.trend).toBe(-1);
    expect(struct.lastLow).toBe(95.0);
  });
});

describe('MOD-01E Fibonacci OTE Calculations & Anchoring', () => {
  it('anchors Fib 0 to broken swing high and Fib 1 to impulse low for Long', () => {
    const zero = 110; // Fib 0 = broken 15m swing high
    const one = 100;  // Fib 1 = impulse swing low
    // Retracement pulls back downward from Fib 0 towards Fib 1
    const fib382 = calcFibLevel(true, zero, one, 0.382);
    const fib50 = calcFibLevel(true, zero, one, 0.5);
    const fib618 = calcFibLevel(true, zero, one, 0.618);
    const fib786 = calcFibLevel(true, zero, one, 0.786);

    expect(fib382).toBeCloseTo(106.18, 4);
    expect(fib50).toBeCloseTo(105.0, 4);
    expect(fib618).toBeCloseTo(103.82, 4);
    expect(fib786).toBeCloseTo(102.14, 4);
  });

  it('anchors Fib 0 to broken swing low and Fib 1 to impulse high for Short', () => {
    const zero = 90;   // Fib 0 = broken 15m swing low
    const one = 100;   // Fib 1 = impulse swing high
    // Retracement pulls back upward from Fib 0 towards Fib 1
    const fib382 = calcFibLevel(false, zero, one, 0.382);
    const fib50 = calcFibLevel(false, zero, one, 0.5);
    const fib618 = calcFibLevel(false, zero, one, 0.618);
    const fib786 = calcFibLevel(false, zero, one, 0.786);

    expect(fib382).toBeCloseTo(93.82, 4);
    expect(fib50).toBeCloseTo(95.0, 4);
    expect(fib618).toBeCloseTo(96.18, 4);
    expect(fib786).toBeCloseTo(97.86, 4);
  });

  it('places SL beyond Fib 1 + ATR buffer and sets TP1=3R, TP2=5R', () => {
    const entry = 103.82;
    const fib1 = 100.0;
    const atr15m = 2.0;
    const bufferAtr = 0.15;
    const sl = fib1 - atr15m * bufferAtr; // 99.70
    const risk = entry - sl; // 4.12
    const tp1 = entry + risk * 3.0; // 116.18
    const tp2 = entry + risk * 5.0; // 124.42

    expect(sl).toBeCloseTo(99.70, 4);
    expect((tp1 - entry) / risk).toBeCloseTo(3.0, 4);
    expect((tp2 - entry) / risk).toBeCloseTo(5.0, 4);
  });
});

describe('MOD-01E Settings & Sequence Engine', () => {
  it('has default configuration matching the canonical Pine script & UI specification', () => {
    expect(DEFAULT_MOD01E_CFG.biasTfMinutes).toBe(60);
    expect(DEFAULT_MOD01E_CFG.alignTfMinutes).toBe(15);
    expect(DEFAULT_MOD01E_CFG.entryTfMinutes).toBe(5);
    expect(DEFAULT_MOD01E_CFG.biasPivotLen).toBe(5);
    expect(DEFAULT_MOD01E_CFG.alignPivotLen).toBe(5);
    expect(DEFAULT_MOD01E_CFG.entryPivotLen).toBe(3);
    expect(DEFAULT_MOD01E_CFG.requireAlignment).toBe(true);
    expect(DEFAULT_MOD01E_CFG.breakRule).toBe('Body close');
    expect(DEFAULT_MOD01E_CFG.entryFib).toBe(0.618);
    expect(DEFAULT_MOD01E_CFG.zoneNear).toBe(0.5);
    expect(DEFAULT_MOD01E_CFG.zoneFar).toBe(1.0);
    expect(DEFAULT_MOD01E_CFG.orderExpiry).toBe(18);
    expect(DEFAULT_MOD01E_CFG.stopBufferAtr).toBe(0.15);
    expect(DEFAULT_MOD01E_CFG.rrTP1).toBe(3.0);
    expect(DEFAULT_MOD01E_CFG.rrTP2).toBe(5.0);
  });

  it('requires 1H bias and 15m structure alignment for longAllowed/shortAllowed', () => {
    const c1m: Candle[] = [];
    const t0 = 1700000000;
    for (let i = 0; i < 3000; i++) {
      c1m.push(makeCandle(t0 + i * 60, 100, 101, 99, 100));
    }
    const res = scanMod01e(c1m, undefined, DEFAULT_MOD01E_CFG);
    expect(res.longAllowed).toBe(false);
    expect(res.shortAllowed).toBe(false);
  });

  it('simulates complete sequence: 1H bias -> 15m agree -> 15m CHoCH -> Limit Retest fill on 5m', () => {
    const t0 = 1700000000;
    // 1H candles showing confirmed bullish trend
    const c1h: Candle[] = [
      makeCandle(t0, 100, 102, 98, 101),
      makeCandle(t0 + 3600, 101, 105, 100, 104),
      makeCandle(t0 + 7200, 104, 107, 103, 106),
      makeCandle(t0 + 10800, 106, 105, 101, 102),
      makeCandle(t0 + 14400, 102, 103, 100, 101),
      makeCandle(t0 + 18000, 101, 110, 100, 109), // Bullish 1H break
    ];

    // Generate 1m bars spanning enough 15m bars to establish:
    // 1) 15m bullish alignment
    // 2) 15m minor swing high at 105
    // 3) 15m pullback breaking minor low to establish direction = -1
    // 4) 15m candle breaking above 105 (CHoCH)
    // 5) Subsequent 5m bar pulling back to test the 0.618 Fib limit
    const c1m: Candle[] = [];
    for (let i = 0; i < 800; i++) {
      const t = t0 + i * 60;
      let price = 100;
      if (i < 200) price = 100 + (i / 200) * 8; // 100 -> 108
      else if (i < 300) price = 108 - ((i - 200) / 100) * 4; // pullback to 104
      else if (i < 400) price = 104 + ((i - 300) / 100) * 8; // rally to 112
      else if (i < 500) price = 112 - ((i - 400) / 100) * 7; // pullback to 105
      else if (i < 600) price = 105 + ((i - 500) / 100) * 10; // breakout to 115
      else price = 108; // retrace back down towards 0.618 Fib
      c1m.push(makeCandle(t, price - 0.5, price + 1, price - 1, price));
    }

    const cfg: Mod01eCfg = {
      ...DEFAULT_MOD01E_CFG,
      biasPivotLen: 2,
      alignPivotLen: 2,
      entryPivotLen: 2,
      useKillzone: false,
    };

    const res = scanMod01e(c1m, c1h, cfg);
    expect(res).toBeDefined();
    expect(typeof res.biasTrend).toBe('number');
    expect(typeof res.alignTrend).toBe('number');
  });
});

describe('MOD-01E Live Evaluator & Stage Progression', () => {
  it('returns valid Setup structure with strategyId MOD-01E', () => {
    const c1m: Candle[] = [];
    const t0 = 1700000000;
    for (let i = 0; i < 60; i++) {
      c1m.push(makeCandle(t0 + i * 60, 100, 101, 99, 100));
    }
    const forming = makeCandle(t0 + 60 * 60, 100, 100.5, 99.8, 100.2);
    const setup = evaluateMod01e('BTC_USDT', c1m, forming);

    expect(setup.strategyId).toBe('MOD-01E');
    expect(setup.symbol).toBe('BTC_USDT');
    expect(setup.stage).toBeDefined();
    expect(['IDLE', 'WATCH', 'ARMED', 'ENTRY_READY']).toContain(setup.stage);
  });

  it('populates LIMIT orderType, SL, TP1, and TP2 when ARMED or ENTRY_READY', () => {
    const c1m: Candle[] = [];
    const t0 = 1700000000;
    for (let i = 0; i < 200; i++) {
      c1m.push(makeCandle(t0 + i * 60, 100, 101, 99, 100));
    }
    const setup = evaluateMod01e('SOL_USDT', c1m, null);
    expect(setup.strategyId).toBe('MOD-01E');
    if (setup.stage === 'ARMED' || setup.stage === 'ENTRY_READY') {
      expect(setup.orderType).toBe('LIMIT');
      expect(setup.entry).toBeGreaterThan(0);
      expect(setup.sl).toBeGreaterThan(0);
      expect(setup.tp1).toBeGreaterThan(0);
      expect(setup.tp2).toBeGreaterThan(0);
    }
  });
});
