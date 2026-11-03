import { describe, it, expect } from 'vitest';
import {
  parseTopVolumeTickers,
  parseTopMemeTickers,
  parseTopAiTickers,
  parseTopGameTickers,
  parseTopGainers,
  parseTopLosers,
} from '../src/mexc/rest.js';
import { Db } from '../src/db/index.js';
import { Runner } from '../src/engine/runner.js';
import { loadConfig } from '../src/config.js';
import { longScenario } from './fixtures.js';

describe('Auto-Scanner', () => {
  it('parseTopVolumeTickers sorts by amount24 and filters USDT perps', () => {
    const raw = {
      success: true,
      data: [
        { symbol: 'ETH_USDT', amount24: 500000 },
        { symbol: 'BTC_USDT', amount24: 1000000 },
        { symbol: 'SOL_USDT', amount24: 750000 },
        { symbol: 'DOGE_USD', amount24: 9000000 }, // non-USDT
        { symbol: 'LOW_USDT', amount24: 0 },
      ],
    };
    const top = parseTopVolumeTickers(raw, 2);
    expect(top).toEqual(['BTC_USDT', 'SOL_USDT']);
  });

  it('filters alert policy: auto coins skip WATCH, but fire ARMED and ENTRY_READY', async () => {
    const db = new Db(':memory:');
    const { candles } = longScenario();
    const cfg = loadConfig({ PAPER_MODE: 'true', USE_KILLZONE: 'false', EVAL_THROTTLE_SEC: '0', LTF_MINUTES: '1' } as any);
    const sentStages: string[] = [];

    const runner = new Runner({
      cfg,
      db,
      feed: { subscribe: () => {}, unsubscribe: () => {} },
      fetchKlines: async () => [],
      fetchContracts: async () => [
        { symbol: 'AUTO_USDT', baseCoin: 'AUTO', quoteCoin: 'USDT', priceUnit: 0.01, state: 0 },
        { symbol: 'PINNED_USDT', baseCoin: 'PINNED', quoteCoin: 'USDT', priceUnit: 0.01, state: 0 },
      ],
      fetchTopVolumePerps: async () => ['AUTO_USDT'],
      notifiers: [],
      log: () => {},
    });

    runner.on('alert', ({ setup }) => sentStages.push(`${setup.symbol}:${setup.stage}`));
    await runner.start();

    // 1. AUTO_USDT is added as auto
    expect(db.listWatch().some(w => w.symbol === 'AUTO_USDT' && w.is_auto === 1)).toBe(true);

    // Warm up history up to pullback start
    const warm = candles.findIndex(c => c.t === candles[0].t + 35 * 900);
    for (const c of candles.slice(0, warm)) runner.store.ingest('AUTO_USDT', c);

    // Ingest until WATCH stage
    // For AUTO_USDT, WATCH should be blocked!
    runner.evaluateSymbol('AUTO_USDT');
    expect(sentStages.some(s => s.startsWith('AUTO_USDT:WATCH'))).toBe(false);

    // Stream remaining bars (reaches ARMED then ENTRY_READY)
    for (const c of candles.slice(warm)) runner.onKline('AUTO_USDT', c);
    const last = candles[candles.length - 1];
    runner.onKline('AUTO_USDT', { ...last, t: last.t + 60 });

    // Verify AUTO_USDT alerted on ARMED and ENTRY_READY, but NOT WATCH
    expect(sentStages).toContain('AUTO_USDT:ARMED');
    expect(sentStages).toContain('AUTO_USDT:ENTRY_READY');
    expect(sentStages).not.toContain('AUTO_USDT:WATCH');
  });

  it('parseTopMemeTickers discovers meme contracts by conceptPlate and known bases, sorted by volume', () => {
    const contracts = {
      data: [
        { symbol: 'PEPE_USDT', baseCoin: 'PEPE', quoteCoin: 'USDT', state: 0, conceptPlate: ['mc-trade-zone-MEME'] },
        { symbol: 'DOGE_USDT', baseCoin: 'DOGE', quoteCoin: 'USDT', state: 0, conceptPlate: [] },
        { symbol: 'BTC_USDT', baseCoin: 'BTC', quoteCoin: 'USDT', state: 0, conceptPlate: ['mc-trade-zone-layer1'] },
        { symbol: 'SHIB_USDT', baseCoin: 'SHIB', quoteCoin: 'USDT', state: 0, conceptPlate: ['mc-trade-zone-MEME'] },
      ],
    };
    const tickers = {
      data: [
        { symbol: 'PEPE_USDT', amount24: 5000000 },
        { symbol: 'DOGE_USDT', amount24: 8000000 },
        { symbol: 'BTC_USDT', amount24: 50000000 },
        { symbol: 'SHIB_USDT', amount24: 1000000 },
      ],
    };
    const topMemes = parseTopMemeTickers(contracts, tickers, 2);
    expect(topMemes).toEqual(['DOGE_USDT', 'PEPE_USDT']);
  });

  it('parseTopAiTickers discovers AI contracts and ignores mainly/tradfi zones', () => {
    const contracts = {
      data: [
        { symbol: 'TAO_USDT', baseCoin: 'TAO', quoteCoin: 'USDT', state: 0, conceptPlate: ['mc-trade-zone-AI'] },
        { symbol: 'NEAR_USDT', baseCoin: 'NEAR', quoteCoin: 'USDT', state: 0, conceptPlate: ['mc-trade-zone-layer1'] }, // known AI
        { symbol: 'BTC_USDT', baseCoin: 'BTC', quoteCoin: 'USDT', state: 0, conceptPlate: ['mc-trade-zone-mainly'] }, // 'mainly' must NOT match 'ai'
        { symbol: 'AAPL_STOCK_USDT', baseCoin: 'AAPL', quoteCoin: 'USDT', state: 0, conceptPlate: ['mc-trade-zone-AI'] }, // stock excluded
      ],
    };
    const tickers = {
      data: [
        { symbol: 'TAO_USDT', amount24: 10000000 },
        { symbol: 'NEAR_USDT', amount24: 15000000 },
        { symbol: 'BTC_USDT', amount24: 100000000 },
        { symbol: 'AAPL_STOCK_USDT', amount24: 5000000 },
      ],
    };
    const topAi = parseTopAiTickers(contracts, tickers, 2);
    expect(topAi).toEqual(['NEAR_USDT', 'TAO_USDT']);
  });

  it('parseTopGameTickers discovers GameFi/metaverse contracts', () => {
    const contracts = {
      data: [
        { symbol: 'GALA_USDT', baseCoin: 'GALA', quoteCoin: 'USDT', state: 0, conceptPlate: ['mc-trade-zone-game'] },
        { symbol: 'AXS_USDT', baseCoin: 'AXS', quoteCoin: 'USDT', state: 0, conceptPlate: [] }, // known game base
        { symbol: 'ETH_USDT', baseCoin: 'ETH', quoteCoin: 'USDT', state: 0, conceptPlate: ['mc-trade-zone-layer1'] },
      ],
    };
    const tickers = {
      data: [
        { symbol: 'GALA_USDT', amount24: 4000000 },
        { symbol: 'AXS_USDT', amount24: 6000000 },
        { symbol: 'ETH_USDT', amount24: 50000000 },
      ],
    };
    const topGame = parseTopGameTickers(contracts, tickers, 2);
    expect(topGame).toEqual(['AXS_USDT', 'GALA_USDT']);
  });

  it('parseTopGainers sorts by riseFallRate descending and requires min volume', () => {
    const tickers = {
      data: [
        { symbol: 'PUMP_USDT', riseFallRate: 0.45, amount24: 8000000 },
        { symbol: 'MICRO_PUMP_USDT', riseFallRate: 0.90, amount24: 100000 }, // under min volume 5M
        { symbol: 'RUNNER_USDT', riseFallRate: 0.25, amount24: 12000000 },
        { symbol: 'DUMP_USDT', riseFallRate: -0.15, amount24: 10000000 },
      ],
    };
    const gainers = parseTopGainers(tickers, 5000000, 2);
    expect(gainers).toEqual(['PUMP_USDT', 'RUNNER_USDT']);
  });

  it('parseTopLosers sorts by riseFallRate ascending and requires min volume', () => {
    const tickers = {
      data: [
        { symbol: 'CRASH_USDT', riseFallRate: -0.35, amount24: 9000000 },
        { symbol: 'MICRO_DIP_USDT', riseFallRate: -0.60, amount24: 200000 }, // under 5M
        { symbol: 'SLIP_USDT', riseFallRate: -0.18, amount24: 15000000 },
        { symbol: 'GREEN_USDT', riseFallRate: 0.20, amount24: 10000000 },
      ],
    };
    const losers = parseTopLosers(tickers, 5000000, 2);
    expect(losers).toEqual(['CRASH_USDT', 'SLIP_USDT']);
  });

  it('runAutoScan syncs both volume pairs (is_auto=1) and meme pairs (is_auto=2)', async () => {
    const db = new Db(':memory:');
    const cfg = loadConfig({ PAPER_MODE: 'true', USE_KILLZONE: 'false' } as any);

    const runner = new Runner({
      cfg,
      db,
      feed: { subscribe: () => {}, unsubscribe: () => {} },
      fetchKlines: async () => [],
      fetchContracts: async () => [
        { symbol: 'BTC_USDT', baseCoin: 'BTC', quoteCoin: 'USDT', priceUnit: 0.1, state: 0 },
        { symbol: 'PEPE_USDT', baseCoin: 'PEPE', quoteCoin: 'USDT', priceUnit: 0.00001, state: 0 },
      ],
      fetchTopVolumePerps: async () => ['BTC_USDT'],
      fetchTopMemePerps: async () => ['PEPE_USDT'],
      notifiers: [],
      log: () => {},
    });

    await runner.runAutoScan();
    const rows = db.listWatch();
    const btc = rows.find(w => w.symbol === 'BTC_USDT');
    const pepe = rows.find(w => w.symbol === 'PEPE_USDT');

    expect(btc?.is_auto).toBe(1); // Volume leader
    expect(pepe?.is_auto).toBe(2); // Meme coin
  });

  it('runAutoScan supports multi-sector tagging, leverage filtering, and deduplication', async () => {
    const db = new Db(':memory:');
    const cfg = loadConfig({ PAPER_MODE: 'true', USE_KILLZONE: 'false' } as any);

    const runner = new Runner({
      cfg,
      db,
      feed: { subscribe: () => {}, unsubscribe: () => {} },
      fetchKlines: async () => [],
      fetchContracts: async () => [
        { symbol: 'BTC_USDT', baseCoin: 'BTC', quoteCoin: 'USDT', priceUnit: 0.1, state: 0, maxLeverage: 125 },
        { symbol: 'TAO_USDT', baseCoin: 'TAO', quoteCoin: 'USDT', priceUnit: 0.01, state: 0, maxLeverage: 50 },
        { symbol: 'GALA_USDT', baseCoin: 'GALA', quoteCoin: 'USDT', priceUnit: 0.0001, state: 0, maxLeverage: 50 },
        { symbol: 'PUMP_USDT', baseCoin: 'PUMP', quoteCoin: 'USDT', priceUnit: 0.01, state: 0, maxLeverage: 20 },
        { symbol: 'DUMP_USDT', baseCoin: 'DUMP', quoteCoin: 'USDT', priceUnit: 0.01, state: 0, maxLeverage: 20 },
        { symbol: 'PEPE_USDT', baseCoin: 'PEPE', quoteCoin: 'USDT', priceUnit: 0.00001, state: 0, maxLeverage: 200 },
        { symbol: 'LOWLEV_USDT', baseCoin: 'LOWLEV', quoteCoin: 'USDT', priceUnit: 0.01, state: 0, maxLeverage: 10 },
      ],
      fetchTopVolumePerps: async () => ['BTC_USDT', 'TAO_USDT'],
      fetchTopMemePerps: async () => ['PEPE_USDT'],
      fetchTopAiPerps: async () => ['TAO_USDT'],
      fetchTopGamePerps: async () => ['GALA_USDT'],
      fetchTopGainers: async () => ['PUMP_USDT', 'LOWLEV_USDT'],
      fetchTopLosers: async () => ['DUMP_USDT'],
      notifiers: [],
      log: () => {},
    });

    // Enable AI, Game, Gainers, Losers
    await runner.setAiScanner(true);
    await runner.setGameScanner(true);
    await runner.setGainersScanner(true);
    await runner.setLosersScanner(true);
    // Set minimum leverage requirement to 20x
    runner.setMinLeverage(20);

    // Initial contract load
    await runner.start();

    const rows = db.listWatch();
    const tao = rows.find(w => w.symbol === 'TAO_USDT');
    const gala = rows.find(w => w.symbol === 'GALA_USDT');
    const pump = rows.find(w => w.symbol === 'PUMP_USDT');
    const dump = rows.find(w => w.symbol === 'DUMP_USDT');
    const pepe = rows.find(w => w.symbol === 'PEPE_USDT');
    const lowlev = rows.find(w => w.symbol === 'LOWLEV_USDT');

    // LOWLEV_USDT has 10x max leverage, so it must be filtered out
    expect(lowlev).toBeUndefined();

    // Priority checks:
    // PUMP_USDT is in gainers -> tag 5
    expect(pump?.is_auto).toBe(5);
    // DUMP_USDT is in losers -> tag 6
    expect(dump?.is_auto).toBe(6);
    // PEPE_USDT is meme -> tag 2
    expect(pepe?.is_auto).toBe(2);
    // TAO_USDT is in AI and Volume -> specific sector (AI: 3) takes precedence
    expect(tao?.is_auto).toBe(3);
    // GALA_USDT is in Game -> tag 4
    expect(gala?.is_auto).toBe(4);
  });
});
