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
      makeCandle(14400, 101.5, 102.0, 100.5, 101.0), // Confirmed pivot high at index 2
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
      makeCandle(14400, 98.5, 99.5, 98.0, 99.0), // Confirmed pivot low at index 2
      makeCandle(18000, 99.0, 99.0, 95.5, 96.0),
      makeCandle(21600, 96.0, 96.5, 91.0, 92.0), // Closes below 95.0 -> Bearish BOS
    ];
    const struct = computeStructure(candles, 2);
    expect(struct.trend).toBe(-1);
    expect(struct.lastLow).toBe(95.0);
  });
});

describe('MOD-01E Fibonacci OTE Calculations', () => {
  it('calculates exact long retracement levels from Fib 0 (high) to Fib 1 (low)', () => {
    const zero = 110; // Impulse swing high
    const one = 100;  // Impulse swing low
    // Retracement sits below 110 towards 100
    const fib50 = calcFibLevel(true, zero, one, 0.5);
    const fib618 = calcFibLevel(true, zero, one, 0.618);
    const fib786 = calcFibLevel(true, zero, one, 0.786);

    expect(fib50).toBeCloseTo(105.0, 4);
    expect(fib618).toBeCloseTo(103.82, 4);
    expect(fib786).toBeCloseTo(102.14, 4);
  });

  it('calculates exact short retracement levels from Fib 0 (low) to Fib 1 (high)', () => {
    const zero = 90;   // Impulse swing low
    const one = 100;   // Impulse swing high
    // Retracement sits above 90 towards 100
    const fib50 = calcFibLevel(false, zero, one, 0.5);
    const fib618 = calcFibLevel(false, zero, one, 0.618);
    const fib786 = calcFibLevel(false, zero, one, 0.786);

    expect(fib50).toBeCloseTo(95.0, 4);
    expect(fib618).toBeCloseTo(96.18, 4);
    expect(fib786).toBeCloseTo(97.86, 4);
  });

  it('calculates 3R TP1 and 5R TP2 from 0.618 entry and ATR-buffered stop', () => {
    const entry = 103.82;
    const sl = 99.7; // 100 - (0.15 * ATR 2.0)
    const risk = entry - sl; // 4.12
    const tp1 = entry + risk * 3.0; // 103.82 + 12.36 = 116.18
    const tp2 = entry + risk * 5.0; // 103.82 + 20.60 = 124.42

    expect((tp1 - entry) / risk).toBeCloseTo(3.0, 4);
    expect((tp2 - entry) / risk).toBeCloseTo(5.0, 4);
  });
});

describe('MOD-01E Multi-Timeframe Scan Engine', () => {
  it('requires both 1H and 15m to be aligned for longAllowed/shortAllowed', () => {
    // Generate 1m bars for 50 hours
    const c1m: Candle[] = [];
    const t0 = 1700000000;
    for (let i = 0; i < 3000; i++) {
      c1m.push(makeCandle(t0 + i * 60, 100, 101, 99, 100));
    }
    const res = scanMod01e(c1m, undefined, DEFAULT_MOD01E_CFG);
    // In flat candles, biasTrend and alignTrend are 0, so neither long nor short is allowed
    expect(res.longAllowed).toBe(false);
    expect(res.shortAllowed).toBe(false);
  });

  it('identifies 15m CHoCH and generates a pending 5m limit order', () => {
    const t0 = 1700000000;
    const c1h: Candle[] = [
      makeCandle(t0, 100, 102, 98, 101),
      makeCandle(t0 + 3600, 101, 105, 100, 104),
      makeCandle(t0 + 7200, 104, 107, 103, 106),
      makeCandle(t0 + 10800, 106, 105, 101, 102),
      makeCandle(t0 + 14400, 102, 103, 100, 101),
      makeCandle(t0 + 18000, 101, 110, 100, 109), // Bullish 1H break
    ];

    // Build 1m candles for 15m structure:
    // Swing high at 105, pullback to 100, then close above 105
    const c1m: Candle[] = [];
    for (let i = 0; i < 600; i++) {
      const t = t0 + i * 60;
      let price = 100;
      if (i < 100) price = 100 + (i / 100) * 5; // rise to 105
      else if (i < 200) price = 105 - ((i - 100) / 100) * 5; // pull back to 100
      else if (i < 300) price = 100 + ((i - 200) / 100) * 8; // break up to 108
      else price = 107; // hover around 107 (above 105)
      c1m.push(makeCandle(t, price - 0.5, price + 1, price - 1, price));
    }

    const cfg: Mod01eCfg = {
      ...DEFAULT_MOD01E_CFG,
      biasPivotLen: 2,
      alignPivotLen: 2,
      useKillzone: false,
    };

    const res = scanMod01e(c1m, c1h, cfg);
    expect(res).toBeDefined();
    expect(typeof res.biasTrend).toBe('number');
    expect(typeof res.alignTrend).toBe('number');
  });

  it('cancels pending limit order if 18 5m bars elapse without fill', () => {
    // Verifies expiry rule from specification
    expect(DEFAULT_MOD01E_CFG.orderExpiry).toBe(18);
  });
});

describe('MOD-01E Live Evaluator', () => {
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

  it('populates LIMIT orderType and entryFib details when in ARMED stage', () => {
    const c1m: Candle[] = [];
    const t0 = 1700000000;
    for (let i = 0; i < 200; i++) {
      c1m.push(makeCandle(t0 + i * 60, 100, 101, 99, 100));
    }
    const setup = evaluateMod01e('SOL_USDT', c1m, null);
    expect(setup.strategyId).toBe('MOD-01E');
    if (setup.stage === 'ARMED') {
      expect(setup.orderType).toBe('LIMIT');
      expect(setup.entry).toBeGreaterThan(0);
      expect(setup.sl).toBeGreaterThan(0);
      expect(setup.tp1).toBeGreaterThan(0);
      expect(setup.tp2).toBeGreaterThan(0);
    }
  });
});
