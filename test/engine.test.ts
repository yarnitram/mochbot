import { describe, it, expect, vi, afterEach } from 'vitest';
import { AlertGate } from '../src/engine/alertGate.js';
import { suggestOrderType } from '../src/engine/orderType.js';
import { CandleStore } from '../src/data/candleStore.js';
import { parseKlines, parseWsKline, parseContracts } from '../src/mexc/rest.js';
import { Db } from '../src/db/index.js';
import { Runner } from '../src/engine/runner.js';
import { loadConfig } from '../src/config.js';
import { formatAlert } from '../src/notify/format.js';
import type { Setup } from '../src/types.js';
import { longScenario, limitScenario } from './fixtures.js';
afterEach(() => vi.restoreAllMocks());

const setup = (o: Partial<Setup> = {}): Setup => ({
  symbol: 'BTC_USDT', stage: 'WATCH', direction: 'LONG', setupId: 'LONG:1', price: 100, zone: { top: 99, bottom: 98, startTime: 1 },
  distanceAtr: 0.5, needBreak: null, barsSinceTap: null, entry: null, sl: null, tp1: null, tp2: null, orderType: null, orderNote: null,
  killzone: true, atrHtf: 1, atrLtf: 0.1, ts: 0, ...o,
});

describe('AlertGate', () => {
  it('fires each (symbol, setup, stage) once', () => {
    const g = new AlertGate();
    expect(g.shouldAlert(setup(), 0)).toBe(true);
    expect(g.shouldAlert(setup(), 1000)).toBe(false);
  });
  it('escalating stages alert separately, ENTRY_READY ignores cooldown', () => {
    const g = new AlertGate();
    expect(g.shouldAlert(setup({ stage: 'WATCH' }), 0)).toBe(true);
    expect(g.shouldAlert(setup({ stage: 'ARMED' }), 1000)).toBe(true);
    expect(g.shouldAlert(setup({ stage: 'ENTRY_READY', setupId: 'LONG:1:99' }), 2000)).toBe(true);
  });
  it('cooldown suppresses a different WATCH on the same symbol', () => {
    const g = new AlertGate(15 * 60_000);
    expect(g.shouldAlert(setup({ setupId: 'LONG:1' }), 0)).toBe(true);
    expect(g.shouldAlert(setup({ setupId: 'SHORT:2' }), 60_000)).toBe(false);
    expect(g.shouldAlert(setup({ setupId: 'SHORT:2' }), 16 * 60_000)).toBe(true);
  });
  it('re-fires after the TTL and never for IDLE', () => {
    const g = new AlertGate(0);
    expect(g.shouldAlert(setup(), 0)).toBe(true);
    expect(g.shouldAlert(setup(), 7 * 3600_000)).toBe(true);
    expect(g.shouldAlert(setup({ stage: 'IDLE' }), 0)).toBe(false);
  });
  it('prime() prevents re-alerting after restart', () => {
    const g = new AlertGate();
    g.prime(setup(), 1000);
    expect(g.shouldAlert(setup(), 2000)).toBe(false);
  });
});

describe('order type suggestion', () => {
  it('market when at entry, trigger-limit when slightly away, limit when far', () => {
    expect(suggestOrderType('LONG', 100.01, 100, 0.1, true).type).toBe('MARKET');
    expect(suggestOrderType('LONG', 100.04, 100, 0.1, true).type).toBe('TRIGGER_LIMIT');
    expect(suggestOrderType('LONG', 100.3, 100, 0.1, true).type).toBe('LIMIT');
    expect(suggestOrderType('SHORT', 100, 100, NaN, true).type).toBe('LIMIT');
  });
});

describe('CandleStore', () => {
  const c = (t: number, p = 1) => ({ t, o: p, h: p, l: p, c: p, v: 1 });
  it('closes the previous candle when a newer one arrives', () => {
    const s = new CandleStore(10);
    expect(s.ingest('X', c(0))).toBe(false);
    expect(s.ingest('X', c(0, 2))).toBe(false);
    expect(s.ingest('X', c(60))).toBe(true);
    expect(s.closed('X')).toEqual([c(0, 2)]);
    expect(s.forming('X')!.t).toBe(60);
  });
  it('ignores stale candles and trims to max', () => {
    const s = new CandleStore(3);
    for (let i = 0; i < 10; i++) s.ingest('X', c(i * 60));
    expect(s.ingest('X', c(0))).toBe(false);
    expect(s.closed('X')).toHaveLength(3);
  });
  it('setHistory keeps the current minute as forming', () => {
    const s = new CandleStore(10);
    s.setHistory('X', [c(0), c(60), c(120)], 150);
    expect(s.closed('X').map(x => x.t)).toEqual([0, 60]);
    expect(s.forming('X')!.t).toBe(120);
  });
});

describe('MEXC parsing', () => {
  it('parses REST klines', () => {
    const r = parseKlines({ success: true, data: { time: [60, 0], open: [2, 1], high: [3, 2], low: [1, 0], close: [2.5, 1.5], vol: [5, 4] } });
    expect(r.map(x => x.t)).toEqual([0, 60]);
    expect(r[1]).toEqual({ t: 60, o: 2, h: 3, l: 1, c: 2.5, v: 5 });
    expect(parseKlines({})).toEqual([]);
  });
  it('parses WS push.kline and ignores others', () => {
    const k = parseWsKline({ channel: 'push.kline', symbol: 'BTC_USDT', data: { symbol: 'BTC_USDT', interval: 'Min1', t: 100, o: 1, c: 2, h: 3, l: 0.5, q: 7 } });
    expect(k).toEqual({ symbol: 'BTC_USDT', candle: { t: 100, o: 1, h: 3, l: 0.5, c: 2, v: 7 } });
    expect(parseWsKline({ channel: 'pong' })).toBeNull();
  });
  it('filters contracts to active USDT perpetuals', () => {
    const r = parseContracts({ data: [
      { symbol: 'BTC_USDT', baseCoin: 'BTC', quoteCoin: 'USDT', priceUnit: 0.1, state: 0 },
      { symbol: 'ETH_USD', baseCoin: 'ETH', quoteCoin: 'USD', state: 0 },
      { symbol: 'OLD_USDT', baseCoin: 'OLD', quoteCoin: 'USDT', state: 1 },
    ] });
    expect(r.map(x => x.symbol)).toEqual(['BTC_USDT']);
  });
});

describe('Db', () => {
  it('manages the watchlist and settings', () => {
    const db = new Db(':memory:');
    expect(db.addWatch('BTC_USDT')).toBe(true);
    expect(db.addWatch('BTC_USDT')).toBe(false);
    expect(db.updateWatch('BTC_USDT', { killzone: false })).toBe(true);
    expect(db.listWatch()[0].killzone).toBe(0);
    expect(db.updateWatch('BTC_USDT', { killzone: null })).toBe(true);
    expect(db.listWatch()[0].killzone).toBeNull();
    db.setSetting('mute', '1');
    expect(db.getSetting('mute')).toBe('1');
    expect(db.removeWatch('BTC_USDT')).toBe(true);
  });
  it('stores alerts', () => {
    const db = new Db(':memory:');
    const id = db.insertAlert(setup(), false);
    db.markDelivered(id);
    const a = db.recentAlerts(5);
    expect(a).toHaveLength(1);
    expect(a[0].delivered).toBe(1);
    expect(JSON.parse(a[0].payload).symbol).toBe('BTC_USDT');
  });
});

describe('formatAlert', () => {
  it('includes the trade plan for ENTRY_READY', () => {
    const t = formatAlert(setup({ stage: 'ENTRY_READY', entry: 100, sl: 99, tp1: 103, tp2: 105, orderType: 'LIMIT', orderNote: 'wait' }));
    expect(t).toContain('ENTRY READY');
    expect(t).toContain('TP1 (1:3)');
    expect(t).toContain('https://www.mexc.co/en-PH/futures/BTC_USDT?type=linear_swap');
  });
});

describe('Runner (integration with fakes)', () => {
  it('replays a scenario and emits WATCH -> ARMED -> ENTRY_READY alerts exactly once each (paper mode)', async () => {
    const db = new Db(':memory:');
    const { candles, bias, cfg: strategy } = limitScenario();
    db.setStrategyCfg('MOD-01E', strategy);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(candles[0].t * 1000);
    const cfg = loadConfig({ PAPER_MODE: 'true', USE_KILLZONE: 'false', EVAL_THROTTLE_SEC: '0', LTF_MINUTES: '1' } as any);
    const sent: string[] = [];
    const runner = new Runner({
      cfg, db,
      feed: { subscribe: () => {}, unsubscribe: () => {} },
      fetchKlines: async () => [],
      fetchContracts: async () => [{ symbol: 'TEST_USDT', baseCoin: 'TEST', quoteCoin: 'USDT', priceUnit: 0.0001, state: 0 }],
      notifiers: [{ name: 'fake', send: async s => { sent.push(s.stage); } }],
      log: () => {},
    });
    runner.on('alert', ({ setup }) => sent.push(setup.stage));
    await runner.start();
    expect((await runner.addSymbol('test')).ok).toBe(true);
    runner.htf1h.set('TEST_USDT', bias);
    expect((await runner.addSymbol('nope')).ok).toBe(false);
    // warm up with history, then stream the rest bar by bar
    const warm = 1770;
    for (const c of candles.slice(0, warm)) runner.store.ingest('TEST_USDT', c);
    for (const c of candles.slice(warm)) { clock.mockReturnValue(c.t*1000); runner.onKline('TEST_USDT', c); }
    // push one more candle so the last one closes
    const last = candles[candles.length - 1];
    runner.onKline('TEST_USDT', { ...last, t: last.t + 60 });
    const stages = sent.filter((s, i, a) => a.indexOf(s) === i);
    expect(stages).toContain('ARMED');
    expect(stages).toContain('ENTRY_READY');
    expect(sent.filter(s => s === 'ENTRY_READY')).toHaveLength(1);
    expect(db.recentAlerts(10).some(a => a.stage === 'ENTRY_READY')).toBe(true);
    runner.stop();
  });

  it('handles telegram commands', async () => {
    const db = new Db(':memory:');
    const cfg = loadConfig({} as any);
    const runner = new Runner({
      cfg, db, feed: { subscribe: () => {}, unsubscribe: () => {} }, fetchKlines: async () => [],
      fetchContracts: async () => [], notifiers: [], log: () => {},
    });
    expect(await runner.handleCommand('add', ['btc'])).toContain('BTC_USDT');
    expect(await runner.handleCommand('list', [])).toContain('BTC_USDT');
    expect(await runner.handleCommand('killzone', ['off'])).toContain('off');
    expect(runner.killzoneGlobal).toBe(false);
    expect(await runner.handleCommand('mute', [])).toContain('muted');
    expect(runner.muted).toBe(true);
    expect(await runner.handleCommand('remove', ['BTC_USDT'])).toContain('removed');
  });
  it('reEvaluateAll clears cached states and re-runs evaluation across all watched coins', async () => {
    const db = new Db(':memory:');
    db.addWatch('TEST_USDT');
    const { candles, bias, cfg: strategy } = limitScenario();
    db.setStrategyCfg('MOD-01E', strategy);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(candles[0].t * 1000);
    const cfg = loadConfig({ PAPER_MODE: 'true', USE_KILLZONE: 'false', EVAL_THROTTLE_SEC: '0', LTF_MINUTES: '1' } as any);
    const runner = new Runner({
      cfg, db,
      feed: { subscribe() {}, unsubscribe() {} },
      fetchKlines: async () => [],
      fetchContracts: async () => [],
      notifiers: [],
    });

    runner.htf1h.set('TEST_USDT', bias);
    for (const c of candles) { clock.mockReturnValue(c.t*1000); runner.onKline('TEST_USDT', c); }
    const before = runner.states.get('TEST_USDT')!;
    expect(before.strategyId).toBe('MOD-01E');

    const res = runner.reEvaluateAll();
    expect(res.reevaluated).toBe(1);
    expect(runner.states.get('TEST_USDT')?.stage).toBe(before.stage);
    expect(runner.states.get('TEST_USDT')?.setupId).toBe(before.setupId);
  });

  it('defaults to 3m LTF execution timeframe in loadConfig()', () => {
    const cfg = loadConfig({} as any);
    expect(cfg.strategy.ltfMinutes).toBe(3);
  });

  it('resetAll() purges all database records, clears cached states, and resets runner', async () => {
    const db = new Db(':memory:');
    db.addWatch('BTC_USDT');
    db.addWatch('SOL_USDT');
    db.insertAlert({
      symbol: 'BTC_USDT',
      stage: 'ENTRY_READY',
      direction: 'LONG',
      setupId: 'test-1',
      price: 100,
      zone: null,
      distanceAtr: null,
      needBreak: null,
      barsSinceTap: null,
      entry: 100,
      sl: 90,
      tp1: 130,
      tp2: 150,
      orderType: null,
      orderNote: null,
      killzone: false,
      atrHtf: null,
      atrLtf: null,
      strategyId: 'MOD-01',
      ts: 1000,
    });
    db.setSetting('auto_scanner', '1');
    db.setSetting('account_capital', '5000');

    const runner = new Runner({
      cfg: loadConfig({ PAPER_MODE: 'true' } as any),
      db,
      feed: { subscribe() {}, unsubscribe() {} },
      fetchKlines: async () => [],
      fetchContracts: async () => [],
      notifiers: [],
    });

    const res = runner.resetAll();
    expect(res.cleared.watchlist).toBe(2);
    expect(res.cleared.alerts).toBe(1);
    expect(res.cleared.settings).toBe(2);

    expect(db.listWatch().length).toBe(0);
    expect(db.recentAlerts(10).length).toBe(0);
    expect(runner.states.size).toBe(0);
    expect(runner.anyScannerActive).toBe(false);
  });
});

