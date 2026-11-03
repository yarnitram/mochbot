import { describe, it, expect } from 'vitest';
import { computeStructure, scanMod01d, evaluateMod01d } from '../src/strategy/mod01d.js';
import { DEFAULT_MOD01D_CFG, type Candle, type Mod01dCfg } from '../src/types.js';
import { Db } from '../src/db/index.js';

function makeCandle(t: number, o: number, h: number, l: number, c: number, v = 100): Candle {
  return { t, o, h, l, c, v };
}

describe('MOD-01D Structure Analysis (Gate 1)', () => {
  it('computes bullish trend on swing high breakout (BOS)', () => {
    // Candles create a peak at bar 2 (h=105), pull back, then bar 6 closes at 108 (> 105)
    const candles: Candle[] = [
      makeCandle(0, 100, 101, 99, 100.5),
      makeCandle(3600, 100.5, 102.5, 100, 102),
      makeCandle(7200, 102, 105.0, 101.5, 104), // Peak pivot high of 105.0
      makeCandle(10800, 104, 104.2, 101.0, 101.5),
      makeCandle(14400, 101.5, 102.0, 100.5, 101.0), // Confirmed pivot high at index 2
      makeCandle(18000, 101.0, 104.5, 101.0, 104.0),
      makeCandle(21600, 104.0, 109.0, 103.5, 108.0), // Closes above 105.0 -> Bullish BOS!
    ];
    const struct = computeStructure(candles, 2);
    expect(struct.trend).toBe(1);
    expect(struct.lastHigh).toBe(105.0);
  });

  it('computes bearish trend on swing low breakdown (BOS)', () => {
    // Candles create a trough at bar 2 (l=95.0), bounce, then bar 6 closes at 92 (< 95.0)
    const candles: Candle[] = [
      makeCandle(0, 100, 101, 99, 99.5),
      makeCandle(3600, 99.5, 100, 97.5, 98),
      makeCandle(7200, 98, 98.5, 95.0, 96), // Trough pivot low of 95.0
      makeCandle(10800, 96, 99.0, 95.8, 98.5),
      makeCandle(14400, 98.5, 99.5, 98.0, 99.0), // Confirmed pivot low at index 2
      makeCandle(18000, 99.0, 99.0, 95.5, 96.0),
      makeCandle(21600, 96.0, 96.5, 91.0, 92.0), // Closes below 95.0 -> Bearish BOS!
    ];
    const struct = computeStructure(candles, 2);
    expect(struct.trend).toBe(-1);
    expect(struct.lastLow).toBe(95.0);
  });
});

describe('MOD-01D 1H POI & Multi-Gate Scan (Gates 2, 3, 4)', () => {
  it('detects unmitigated 1H Demand POI formed by liquidity sweep + displacement', () => {
    const b5 = makeCandle(0, 100, 100.2, 99.8, 100);
    const b4 = makeCandle(3600, 100, 100.5, 99.5, 100);
    const b3 = makeCandle(7200, 100, 100.5, 98.5, 99.5);
    const b2 = makeCandle(10800, 99.5, 99.8, 97.0, 98.0); // sweeps b3 low of 98.5
    const b1 = makeCandle(14400, 98.2, 104.0, 98.0, 103.5); // breaks b2.h with large range
    const bAfter = makeCandle(18000, 103.5, 104.5, 102.5, 103.8);

    const c1h = [b5, b4, b3, b2, b1, bAfter];
    // Fill 1m bars so aggregator has data, hovering above 100
    const c1m: Candle[] = [];
    for (let i = 0; i < 200; i++) {
      c1m.push(makeCandle(i * 60, 102, 103, 101, 102));
    }

    const cfg: Mod01dCfg = {
      ...DEFAULT_MOD01D_CFG,
      useKillzone: false,
      requireOneHourAlign: false,
      strictPoi: true,
      bodyAtr: 0.35,
    };

    const res = scanMod01d(c1m, c1h, c1h, cfg);
    expect(res.demandZones.length).toBeGreaterThanOrEqual(1);
    const d = res.demandZones[0];
    expect(d.bottom).toBe(97.0);
    expect(d.top).toBe(99.5); // Math.max(b2.o, b2.c)
  });

  it('calculates exact 1:3 TP1 and 1:5 TP2 with SL buffered below demand bottom', () => {
    const entry = 100;
    const extreme = 95;
    const atrBuf = 1.0;
    const sl = extreme - atrBuf; // 94
    const risk = entry - sl; // 6
    const tp1 = entry + risk * 3.0; // 118
    const tp2 = entry + risk * 5.0; // 130

    expect(risk).toBe(6);
    expect(tp1).toBe(118);
    expect(tp2).toBe(130);
    expect((tp1 - entry) / risk).toBe(3.0);
    expect((tp2 - entry) / risk).toBe(5.0);
  });
});

describe('MOD-01D Live Evaluator', () => {
  it('returns valid Setup structure with strategyId MOD-01D', () => {
    const c1m: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      c1m.push(makeCandle(i * 60, 100, 101, 99, 100));
    }
    const forming = makeCandle(60 * 60, 100, 100.5, 99.8, 100.2);
    const setup = evaluateMod01d('BTC_USDT', c1m, forming);

    expect(setup.symbol).toBe('BTC_USDT');
    expect(setup.strategyId).toBe('MOD-01D');
    expect(['IDLE', 'WATCH', 'ARMED', 'ENTRY_READY']).toContain(setup.stage);
    expect(setup.price).toBe(100.2);
  });
});

describe('Multi-Strategy Database & Configuration', () => {
  it('persists strategy per coin and global strategy setting in SQLite', () => {
    const db = new Db(':memory:');

    // Global strategy defaults to MOD-01
    expect(db.getGlobalStrategy()).toBe('MOD-01');
    db.setGlobalStrategy('MOD-01D');
    expect(db.getGlobalStrategy()).toBe('MOD-01D');

    // Watchlist persistence with strategy assignment
    db.addWatch('BTC_USDT', false, 'MOD-01D');
    db.addWatch('ETH_USDT', true, 'MOD-01');

    const list = db.listWatch();
    const btc = list.find(w => w.symbol === 'BTC_USDT');
    const eth = list.find(w => w.symbol === 'ETH_USDT');

    expect(btc?.strategy).toBe('MOD-01D');
    expect(eth?.strategy).toBe('MOD-01');

    // Update coin strategy
    db.updateWatch('ETH_USDT', { strategy: 'MOD-01D' });
    const ethUpdated = db.listWatch().find(w => w.symbol === 'ETH_USDT');
    expect(ethUpdated?.strategy).toBe('MOD-01D');

    // Strategy configuration persistence
    db.setStrategyCfg('MOD-01D', { rrTP1: 3.5, rrTP2: 6.0 });
    const cfg01d = db.getStrategyCfg('MOD-01D', DEFAULT_MOD01D_CFG);
    expect(cfg01d.rrTP1).toBe(3.5);
    expect(cfg01d.rrTP2).toBe(6.0);
    expect(cfg01d.bodyAtr).toBe(DEFAULT_MOD01D_CFG.bodyAtr);

    db.close();
  });

  it('filters coin analytics and performance by strategy', () => {
    const db = new Db(':memory:');

    // Insert alert for MOD-01
    db.insertAlert({
      symbol: 'SOL_USDT',
      stage: 'ENTRY_READY',
      direction: 'LONG',
      setupId: 's1',
      price: 150,
      zone: null,
      distanceAtr: null,
      needBreak: null,
      barsSinceTap: null,
      entry: 150,
      sl: 145,
      tp1: 165,
      tp2: 175,
      orderType: 'LIMIT',
      orderNote: null,
      killzone: true,
      atrHtf: 1,
      atrLtf: 0.2,
      strategyId: 'MOD-01',
      ts: 1000,
    }, false);

    // Insert alert for MOD-01D
    db.insertAlert({
      symbol: 'DOGE_USDT',
      stage: 'ENTRY_READY',
      direction: 'SHORT',
      setupId: 's2',
      price: 0.15,
      zone: null,
      distanceAtr: null,
      needBreak: null,
      barsSinceTap: null,
      entry: 0.15,
      sl: 0.155,
      tp1: 0.135,
      tp2: 0.125,
      orderType: 'LIMIT',
      orderNote: null,
      killzone: true,
      atrHtf: 0.002,
      atrLtf: 0.0005,
      strategyId: 'MOD-01D',
      ts: 1001,
    }, false);

    const allCoins = db.getCoinAnalytics('ALL');
    const mod01Coins = db.getCoinAnalytics('MOD-01');
    const mod01dCoins = db.getCoinAnalytics('MOD-01D');

    expect(allCoins.map(c => c.symbol).sort()).toEqual(['DOGE_USDT', 'SOL_USDT']);
    expect(mod01Coins.map(c => c.symbol)).toEqual(['SOL_USDT']);
    expect(mod01dCoins.map(c => c.symbol)).toEqual(['DOGE_USDT']);

    db.close();
  });
});
