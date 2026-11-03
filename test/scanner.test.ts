import { describe, it, expect } from 'vitest';
import { parseTopVolumeTickers, parseTopMemeTickers } from '../src/mexc/rest.js';
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
    const cfg = loadConfig({ PAPER_MODE: 'true', USE_KILLZONE: 'false', EVAL_THROTTLE_SEC: '0' } as any);
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

});
