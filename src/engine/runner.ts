import { EventEmitter } from 'node:events';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { CandleStore } from '../data/candleStore.js';
import type { Candle, Setup, StrategyCfg } from '../types.js';
import { evaluate } from '../strategy/mod01.js';
import { evaluateMod01d } from '../strategy/mod01d.js';
import { aggregate } from '../strategy/indicators.js';
import { StrategyId, Mod01dCfg, DEFAULT_MOD01D_CFG } from '../types.js';
import { AlertGate } from './alertGate.js';
import { renderChartPng } from '../chart/renderer.js';
import { LifecycleManager, type LifecycleEvent } from './lifecycle.js';
import { MochexSync } from '../notify/mochex.js';
import type { TradeRow } from '../db/index.js';
import type { Notifier } from '../notify/discord.js';
import type { ContractInfo } from '../mexc/rest.js';
import { formatAlert } from '../notify/format.js';
import { computePositionSizing } from '../strategy/sizing.js';

export interface FeedLike {
  subscribe(symbol: string): void;
  unsubscribe(symbol: string): void;
}

export interface RunnerDeps {
  cfg: AppConfig;
  db: Db;
  feed: FeedLike;
  fetchKlines: (symbol: string, bars: number, interval?: string) => Promise<Candle[]>;
  fetchContracts: () => Promise<ContractInfo[]>;
  fetchTopVolumePerps?: (limit: number) => Promise<string[]>;
  fetchTopMemePerps?: (limit: number) => Promise<string[]>;
  fetchTopAiPerps?: (limit: number) => Promise<string[]>;
  fetchTopGamePerps?: (limit: number) => Promise<string[]>;
  fetchTopGainers?: (minVolumeUsd: number, limit: number) => Promise<string[]>;
  fetchTopLosers?: (minVolumeUsd: number, limit: number) => Promise<string[]>;
  chartsDir?: string;
  notifiers: Notifier[];
  log?: (msg: string) => void;
}

/** Orchestrates candles -> strategy -> alert gate -> notifiers, and exposes live state for the dashboard. */
export class Runner extends EventEmitter {
  readonly store: CandleStore;
  readonly gate = new AlertGate();
  readonly states = new Map<string, Setup>();
  readonly lifecycle: LifecycleManager;
  readonly mochex: MochexSync;
  readonly chartsDir: string;
  readonly htf1h = new Map<string, Candle[]>();
  readonly htf4h = new Map<string, Candle[]>();
  contracts: ContractInfo[] = [];
  private lastEval = new Map<string, number>();
  private log: (msg: string) => void;
  private autoScanTimer: NodeJS.Timeout | null = null;

  constructor(private d: RunnerDeps) {
    super();
    this.store = new CandleStore(d.cfg.historyBars);
    this.lifecycle = new LifecycleManager(d.db);
    this.mochex = new MochexSync(d.db, d.cfg.mochex, m => this.log(m));
    this.lifecycle.on('trade_opened', (trade: TradeRow) => { void this.mochex.openTrade(trade); });
    this.log = d.log ?? (m => console.log(m));
    this.chartsDir = d.chartsDir ?? (d.cfg.dbPath === ':memory:' ? '' : join(dirname(d.cfg.dbPath), 'charts'));
    if (this.chartsDir) {
      try {
        mkdirSync(this.chartsDir, { recursive: true });
      } catch {}
    }
  }

  // ---------- settings ----------
  get killzoneGlobal(): boolean {
    const v = this.d.db.getSetting('killzone');
    return v === null ? this.d.cfg.strategy.useKillzone : v === '1';
  }
  get muted(): boolean {
    return this.d.db.getSetting('mute') === '1';
  }
  get autoScannerEnabled(): boolean {
    const v = this.d.db.getSetting('auto_scanner');
    return v === null ? true : v === '1';
  }
  get memeScannerEnabled(): boolean {
    const v = this.d.db.getSetting('meme_scanner');
    return v === null ? true : v === '1';
  }
  get aiScannerEnabled(): boolean {
    return this.d.db.getSetting('ai_scanner') === '1';
  }
  get gameScannerEnabled(): boolean {
    return this.d.db.getSetting('game_scanner') === '1';
  }
  get gainersScannerEnabled(): boolean {
    return this.d.db.getSetting('gainers_scanner') === '1';
  }
  get losersScannerEnabled(): boolean {
    return this.d.db.getSetting('losers_scanner') === '1';
  }
  get ultraLevScannerEnabled(): boolean {
    return this.d.db.getSetting('ultra_lev_scanner') === '1';
  }
  get minGainerVolume(): number {
    const v = this.d.db.getSetting('min_gainer_volume');
    return v ? Number(v) : 5_000_000;
  }
  get maxActiveCoins(): number {
    const v = this.d.db.getSetting('max_active_coins');
    return v ? Number(v) : 150;
  }
  get minLeverage(): number {
    const v = this.d.db.getSetting('min_leverage');
    return v ? Number(v) : 1;
  }

  get anyScannerActive(): boolean {
    return this.autoScannerEnabled || this.memeScannerEnabled || this.aiScannerEnabled ||
           this.gameScannerEnabled || this.gainersScannerEnabled || this.losersScannerEnabled ||
           this.ultraLevScannerEnabled;
  }

  ensureAutoScanTimer() {
    if (this.anyScannerActive && !this.autoScanTimer) {
      this.autoScanTimer = setInterval(() => void this.runAutoScan(), 3600_000);
    } else if (!this.anyScannerActive && this.autoScanTimer) {
      clearInterval(this.autoScanTimer);
      this.autoScanTimer = null;
    }
  }

  async setAutoScanner(on: boolean): Promise<string[]> {
    this.d.db.setSetting('auto_scanner', on ? '1' : '0');
    this.ensureAutoScanTimer();
    return await this.runAutoScan();
  }
  async setMemeScanner(on: boolean): Promise<string[]> {
    this.d.db.setSetting('meme_scanner', on ? '1' : '0');
    this.ensureAutoScanTimer();
    return await this.runAutoScan();
  }
  async setAiScanner(on: boolean): Promise<string[]> {
    this.d.db.setSetting('ai_scanner', on ? '1' : '0');
    this.ensureAutoScanTimer();
    return await this.runAutoScan();
  }
  async setGameScanner(on: boolean): Promise<string[]> {
    this.d.db.setSetting('game_scanner', on ? '1' : '0');
    this.ensureAutoScanTimer();
    return await this.runAutoScan();
  }
  async setGainersScanner(on: boolean): Promise<string[]> {
    this.d.db.setSetting('gainers_scanner', on ? '1' : '0');
    this.ensureAutoScanTimer();
    return await this.runAutoScan();
  }
  async setLosersScanner(on: boolean): Promise<string[]> {
    this.d.db.setSetting('losers_scanner', on ? '1' : '0');
    this.ensureAutoScanTimer();
    return await this.runAutoScan();
  }
  async setUltraLevScanner(on: boolean): Promise<string[]> {
    this.d.db.setSetting('ultra_lev_scanner', on ? '1' : '0');
    this.ensureAutoScanTimer();
    return await this.runAutoScan();
  }
  setMinGainerVolume(val: number) {
    this.d.db.setSetting('min_gainer_volume', String(val));
  }
  setMaxActiveCoins(val: number) {
    this.d.db.setSetting('max_active_coins', String(val));
  }
  setMinLeverage(val: number) {
    this.d.db.setSetting('min_leverage', String(val));
  }

  setKillzone(on: boolean) {
    this.d.db.setSetting('killzone', on ? '1' : '0');
  }
  setMuted(m: boolean) {
    this.d.db.setSetting('mute', m ? '1' : '0');
  }

  getStrategyForSymbol(symbol: string): StrategyId {
    const row = this.d.db.listWatch().find(w => w.symbol === symbol);
    return (row?.strategy as StrategyId) || this.d.db.getGlobalStrategy();
  }

  mod01dCfg(symbol: string): Mod01dCfg {
    const custom = this.d.db.getStrategyCfg('MOD-01D') as Partial<Mod01dCfg>;
    return { ...DEFAULT_MOD01D_CFG, ...custom };
  }

  strategyCfg(symbol: string): StrategyCfg {
    const row = this.d.db.listWatch().find(w => w.symbol === symbol);
    const savedMod01 = this.d.db.getStrategyCfg('MOD-01', {});
    const c: StrategyCfg = { ...this.d.cfg.strategy, ...savedMod01, useKillzone: this.killzoneGlobal };
    const info = this.contracts.find(x => x.symbol === symbol);
    if (info && info.priceUnit > 0) c.tickSize = info.priceUnit;
    if (row) {
      if (row.killzone !== null) c.useKillzone = row.killzone === 1;
      if (row.sensitivity === 'strict' || row.sensitivity === 'balanced' || row.sensitivity === 'sensitive') c.sensitivity = row.sensitivity;
      if (row.watch_distance !== null) c.watchDistanceAtr = row.watch_distance;
    }
    return c;
  }

  // ---------- lifecycle ----------
  async start() {
    try {
      this.contracts = await this.d.fetchContracts();
      this.log(`loaded ${this.contracts.length} USDT perpetual contracts`);
    } catch (e) {
      this.log(`contract list failed: ${(e as Error).message}`);
    }
    // prime the gate so restarts do not re-fire recent alerts
    for (const a of this.d.db.alertsSince(Math.floor(Date.now() / 1000) - 24 * 3600)) {
      this.gate.prime({ symbol: a.symbol, setupId: a.setup_id, stage: a.stage as Setup['stage'] }, a.ts * 1000);
    }
    for (const w of this.d.db.listWatch()) {
      await this.activate(w.symbol).catch(e => this.log(`activate ${w.symbol}: ${(e as Error).message}`));
    }

    // Run auto-scanner if any discovery feed is enabled
    if (this.anyScannerActive && this.d.fetchTopVolumePerps) {
      await this.runAutoScan();
      this.ensureAutoScanTimer();
    }
  }

  stop() {
    if (this.autoScanTimer) {
      clearInterval(this.autoScanTimer);
      this.autoScanTimer = null;
    }
  }

  private async activate(symbol: string) {
    await this.backfill(symbol);
    this.d.feed.subscribe(symbol);
    this.evaluateSymbol(symbol);
  }

  async backfill(symbol: string) {
    const candles = await this.d.fetchKlines(symbol, this.d.cfg.historyBars, 'Min1');
    this.store.setHistory(symbol, candles);
    const strat = this.getStrategyForSymbol(symbol);
    if (strat === 'MOD-01D') {
      await this.backfillHtf(symbol);
    }
  }

  async backfillHtf(symbol: string) {
    try {
      const [c1h, c4h] = await Promise.all([
        this.d.fetchKlines(symbol, 150, 'Hour1').catch(() => []),
        this.d.fetchKlines(symbol, 150, 'Hour4').catch(() => []),
      ]);
      if (c1h && c1h.length) this.htf1h.set(symbol, c1h);
      if (c4h && c4h.length) this.htf4h.set(symbol, c4h);
    } catch (e) {
      this.log(`HTF backfill failed for ${symbol}: ${(e as Error).message}`);
    }
  }

  async resyncAll() {
    for (const w of this.d.db.listWatch()) await this.backfill(w.symbol).catch(e => this.log(`resync ${w.symbol}: ${(e as Error).message}`));
  }

  // ---------- auto-scanner ----------
  async runAutoScan(limit = 50): Promise<string[]> {
    try {
      this.log(`auto-scanner: fetching multi-sector market feeds from MEXC...`);
      const [volumeSymbols, memeSymbols, aiSymbols, gameSymbols, gainersSymbols, losersSymbols] = await Promise.all([
        (this.autoScannerEnabled && this.d.fetchTopVolumePerps) ? this.d.fetchTopVolumePerps(limit) : Promise.resolve([]),
        (this.memeScannerEnabled && this.d.fetchTopMemePerps) ? this.d.fetchTopMemePerps(limit) : Promise.resolve([]),
        (this.aiScannerEnabled && this.d.fetchTopAiPerps) ? this.d.fetchTopAiPerps(35) : Promise.resolve([]),
        (this.gameScannerEnabled && this.d.fetchTopGamePerps) ? this.d.fetchTopGamePerps(35) : Promise.resolve([]),
        (this.gainersScannerEnabled && this.d.fetchTopGainers) ? this.d.fetchTopGainers(this.minGainerVolume, 25) : Promise.resolve([]),
        (this.losersScannerEnabled && this.d.fetchTopLosers) ? this.d.fetchTopLosers(this.minGainerVolume, 25) : Promise.resolve([]),
      ]);

      // Contract max leverage lookup map
      const contractLevMap = new Map(this.contracts.map(c => [c.symbol, c.maxLeverage ?? 50]));
      const minLev = this.minLeverage;

      // Ultra-high leverage candidates (>=200x) if enabled
      let ultraLevSymbols: string[] = [];
      if (this.ultraLevScannerEnabled) {
        ultraLevSymbols = this.contracts
          .filter(c => (c.maxLeverage ?? 0) >= 200 && !c.symbol.includes('STOCK_'))
          .map(c => c.symbol);
      }

      // Assign category tags: 5=Gain, 6=Dip, 2=Meme, 3=AI, 4=Game, 7=UltraLev, 1=Volume
      // Priority: Specific sectors over generic volume
      const tagMap = new Map<string, number>();
      const candidateList: string[] = [];

      const addCandidates = (symbols: string[], tag: number) => {
        for (const sym of symbols) {
          const lev = contractLevMap.get(sym) ?? 50;
          if (lev < minLev) continue;
          if (this.ultraLevScannerEnabled && lev < 200) continue;
          if (!tagMap.has(sym)) {
            tagMap.set(sym, tag);
            candidateList.push(sym);
          }
        }
      };

      addCandidates(gainersSymbols, 5); // GAIN
      addCandidates(losersSymbols, 6);  // DIP
      addCandidates(memeSymbols, 2);     // MEME
      addCandidates(aiSymbols, 3);       // AI
      addCandidates(gameSymbols, 4);     // GAME
      addCandidates(ultraLevSymbols, 7); // LEV (200x-500x)
      addCandidates(volumeSymbols, 1);   // VOL

      // Cap at maxActiveCoins (default 150)
      const cap = Math.max(10, this.maxActiveCoins);
      const keepSymbols = candidateList.slice(0, cap);
      const keepSet = new Set<string>(keepSymbols);

      const removed = this.d.db.removeAutoWatchesExcept(keepSet);
      for (const s of removed) {
        this.d.feed.unsubscribe(s);
        this.store.drop(s);
        this.htf1h.delete(s);
        this.htf4h.delete(s);
        this.states.delete(s);
        this.emit('state', { symbol: s, removed: true });
      }

      const globalStrat = this.d.db.getGlobalStrategy();
      for (const sym of keepSymbols) {
        const tag = tagMap.get(sym) ?? 1;
        const added = this.d.db.addWatch(sym, tag, globalStrat);
        if (added && !this.store.has(sym)) {
          await this.activate(sym).catch(e => this.log(`activate ${sym}: ${(e as Error).message}`));
        }
      }

      this.log(`auto-scanner: synced ${keepSet.size} active coins [Vol:${volumeSymbols.length}, Meme:${memeSymbols.length}, AI:${aiSymbols.length}, Game:${gameSymbols.length}, Gain:${gainersSymbols.length}, Dip:${losersSymbols.length}] (removed ${removed.length})`);
      this.emit('watchlist_updated');
      return Array.from(keepSet);
    } catch (e) {
      this.log(`auto-scanner error: ${(e as Error).message}`);
      return [];
    }
  }

  // ---------- watchlist ----------
  normalize(raw: string): string {
    let s = raw.trim().toUpperCase().replace('-', '_').replace('/', '_');
    if (!s.includes('_')) s = s.endsWith('USDT') ? `${s.slice(0, -4)}_USDT` : `${s}_USDT`;
    return s;
  }

  async addSymbol(raw: string): Promise<{ ok: boolean; msg: string; symbol: string }> {
    const symbol = this.normalize(raw);
    if (this.contracts.length && !this.contracts.some(c => c.symbol === symbol)) return { ok: false, msg: `${symbol} is not an active MEXC USDT perpetual`, symbol };
    const added = this.d.db.addWatch(symbol, false);
    try {
      await this.activate(symbol);
    } catch (e) {
      return { ok: true, msg: `${symbol} added but backfill failed: ${(e as Error).message}`, symbol };
    }
    return { ok: true, msg: added ? `${symbol} added` : `${symbol} pinned to watchlist`, symbol };
  }

  removeSymbol(raw: string): { ok: boolean; msg: string } {
    const symbol = this.normalize(raw);
    const removed = this.d.db.removeWatch(symbol);
    this.d.feed.unsubscribe(symbol);
    this.store.drop(symbol);
    this.htf1h.delete(symbol);
    this.htf4h.delete(symbol);
    this.states.delete(symbol);
    this.emit('state', { symbol, removed: true });
    return { ok: removed, msg: removed ? `${symbol} removed` : `${symbol} was not on the watchlist` };
  }

  // ---------- data in ----------
  private updateHtfBars(symbol: string, c: Candle) {
    const updateBar = (map: Map<string, Candle[]>, intervalSec: number) => {
      const arr = map.get(symbol);
      if (!arr || !arr.length) return;
      const barT = Math.floor(c.t / intervalSec) * intervalSec;
      const last = arr[arr.length - 1];
      if (last.t < barT) {
        arr.push({ t: barT, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
        if (arr.length > 300) arr.shift();
      } else if (last.t === barT) {
        last.h = Math.max(last.h, c.h);
        last.l = Math.min(last.l, c.l);
        last.c = c.c;
        last.v = (last.v ?? 0) + (c.v ?? 0);
      }
    };
    updateBar(this.htf1h, 3600);
    updateBar(this.htf4h, 14400);
  }

  onKline(symbol: string, c: Candle) {
    if (!this.d.db.listWatch().some(w => w.symbol === symbol)) return;
    const closed = this.store.ingest(symbol, c);
    this.updateHtfBars(symbol, c);
    const now = Date.now();
    const last = this.lastEval.get(symbol) ?? 0;
    if (closed || now - last >= this.d.cfg.evalThrottleSec * 1000) this.evaluateSymbol(symbol);

    // Track active trades on price movement
    const milestones = this.lifecycle.onPrice(symbol, c);
    for (const m of milestones) {
      this.emit('milestone', m);
      void this.dispatchMilestone(m);
      if (m.type === 'tp1_hit') {
        void this.mochex.updateTrade(m.trade, {
          stop_loss: m.trade.entry_price,
          take_profit: m.trade.tp2_price,
          notes: `🎯 TP1 Hit (+1.5R secured) - SL moved to Break-Even (${m.trade.entry_price}), runner to TP2 (${m.trade.tp2_price})`,
        });
      } else if (m.type === 'tp2_hit' || m.type === 'sl_hit' || m.type === 'be_hit') {
        void this.mochex.closeTrade(m.trade, m);
      }
    }
  }

  evaluateSymbol(symbol: string): Setup | null {
    const closed = this.store.closed(symbol);
    if (closed.length < 20) return null;
    this.lastEval.set(symbol, Date.now());

    const strategy = this.getStrategyForSymbol(symbol);
    let setup: Setup;

    if (strategy === 'MOD-01D') {
      let c1h = this.htf1h.get(symbol);
      let c4h = this.htf4h.get(symbol);
      if (!c1h || c1h.length < 10) c1h = aggregate(closed, 60);
      if (!c4h || c4h.length < 5) c4h = aggregate(closed, 240);
      setup = evaluateMod01d(symbol, closed, this.store.forming(symbol), c1h, c4h, this.mod01dCfg(symbol));
      setup.strategyId = 'MOD-01D';
    } else {
      setup = evaluate(symbol, closed, this.store.forming(symbol), this.strategyCfg(symbol));
      setup.strategyId = 'MOD-01';
    }
    if (setup.stage === 'ENTRY_READY' && setup.entry && setup.sl && setup.tp1 && setup.tp2 && setup.direction) {
      const contract = this.contracts.find(c => c.symbol === symbol);
      const capital = this.d.db.getAccountCapital();
      const riskPerTrade = this.d.db.getRiskPerTrade();
      const maxLev = contract?.maxLeverage ?? 50;
      const cSize = contract?.contractSize ?? 1;
      setup.sizing = computePositionSizing(setup.entry, setup.sl, setup.tp1, setup.tp2, setup.direction, capital, riskPerTrade, maxLev, cSize);
    }
    const prev = this.states.get(symbol);
    this.states.set(symbol, setup);
    if (!prev || prev.stage !== setup.stage || prev.setupId !== setup.setupId || Math.abs(prev.price - setup.price) > 0) this.emit('state', { symbol, setup });

    // Filter alert: auto-scanned coins only alert on ARMED & ENTRY_READY (skip WATCH)
    const watchRow = this.d.db.listWatch().find(w => w.symbol === symbol);
    const isAuto = (watchRow?.is_auto ?? 0) > 0;
    if (isAuto && setup.stage === 'WATCH') {
      return setup;
    }

    if (!this.muted && this.gate.shouldAlert(setup)) {
      void this.dispatch(setup);
    }
    return setup;
  }

  reEvaluateAll(): { reevaluated: number } {
    this.lastEval.clear();
    this.states.clear();
    const watched = this.d.db.listWatch();
    let count = 0;
    for (const w of watched) {
      const s = this.evaluateSymbol(w.symbol);
      if (s) count++;
    }
    this.emit('state_reset', { reevaluated: count, total: watched.length });
    this.log(`re-evaluated ${count}/${watched.length} watched symbols with active strategy settings`);
    return { reevaluated: count };
  }

  private async dispatch(setup: Setup) {
    const id = this.d.db.insertAlert(setup, false);
    this.emit('alert', { id, setup });

    // Generate dual-view chart PNG buffer only for ENTRY_READY
    let chartBuffer: Buffer | null = null;
    let chartFile: string | null = null;
    if (setup.stage === 'ENTRY_READY') {
      try {
        const ltf = this.store.closed(setup.symbol);
        let htfCandles: Candle[];
        let ltfCandles: Candle[];
        if (setup.strategyId === 'MOD-01D') {
          htfCandles = this.htf1h.get(setup.symbol) ?? aggregate(ltf, 60);
          ltfCandles = aggregate(ltf, 5); // 5m execution
          setup.ltfMinutes = 5;
        } else {
          const mod01Cfg = this.strategyCfg(setup.symbol);
          htfCandles = aggregate(ltf, mod01Cfg.htfMinutes);
          const ltfMin = mod01Cfg.ltfMinutes ?? 3;
          ltfCandles = ltfMin > 1 ? aggregate(ltf, ltfMin) : ltf; // 3m default or user-configured
          setup.ltfMinutes = ltfMin;
        }
        chartBuffer = renderChartPng(setup.symbol, htfCandles, ltfCandles, setup);

        // Save chart to persistent disk folder
        if (chartBuffer && this.chartsDir) {
          const safeId = (setup.setupId || 'entry').replace(/[^a-zA-Z0-9_\-]/g, '_');
          chartFile = `${setup.symbol}_${safeId}_${Date.now()}.png`;
          writeFileSync(join(this.chartsDir, chartFile), chartBuffer);
        }
      } catch (e) {
        this.log(`chart render failed for ${setup.symbol}: ${(e as Error).message}`);
      }

      // Automatically register open trade upon ENTRY_READY
      this.lifecycle.onEntryReady(setup, chartFile);
    }

    if (this.d.cfg.paperMode) {
      this.log(`[paper] ${setup.symbol} ${setup.stage} ${setup.direction}`);
      return;
    }

    const results = await Promise.allSettled(this.d.notifiers.map(n => n.send(setup, chartBuffer)));
    let ok = false;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') ok = true;
      else this.log(`${this.d.notifiers[i].name} send failed: ${(r.reason as Error).message}`);
    });
    if (ok) this.d.db.markDelivered(id);
  }

  private async dispatchMilestone(m: LifecycleEvent) {
    if (this.d.cfg.paperMode) {
      this.log(`[milestone:paper] ${m.message.split('\n')[0]}`);
      return;
    }
    for (const n of this.d.notifiers) {
      try {
        if ('sendText' in n && typeof (n as any).sendText === 'function') {
          await (n as any).sendText(m.message);
        } else {
          await n.send({
            symbol: m.trade.symbol,
            stage: 'ENTRY_READY',
            direction: m.trade.direction as any,
            setupId: m.trade.setup_id,
            price: m.price,
            zone: null,
            distanceAtr: null,
            needBreak: null,
            barsSinceTap: null,
            entry: m.trade.entry_price,
            sl: m.trade.sl_price,
            tp1: m.trade.tp1_price,
            tp2: m.trade.tp2_price,
            orderType: null,
            orderNote: m.message,
            killzone: true,
            atrHtf: null,
            atrLtf: null,
            ts: Math.floor(Date.now() / 1000),
          });
        }
      } catch (e) {
        this.log(`${n.name} milestone alert failed: ${(e as Error).message}`);
      }
    }
  }

  // ---------- telegram commands ----------
  async handleCommand(cmd: string, args: string[]): Promise<string> {
    switch (cmd) {
      case 'start':
      case 'help':
        return 'Commands:\n/add SYMBOL\n/remove SYMBOL\n/list\n/status [SYMBOL]\n/trades\n/scanner on|off\n/killzone on|off\n/mute\n/unmute';
      case 'add': {
        if (!args[0]) return 'Usage: /add BTC_USDT';
        return (await this.addSymbol(args[0])).msg;
      }
      case 'remove':
        if (!args[0]) return 'Usage: /remove BTC_USDT';
        return this.removeSymbol(args[0]).msg;
      case 'list': {
        const rows = this.d.db.listWatch();
        if (!rows.length) return 'Watchlist is empty. Use /add BTC_USDT';
        return rows.map(r => `${r.is_auto ? '🤖' : '📌'} ${r.symbol}  ${this.states.get(r.symbol)?.stage ?? 'IDLE'}`).join('\n');
      }
      case 'trades': {
        const active = this.d.db.getActiveTrades();
        const perf = this.d.db.getPerformanceSummary();
        const header = `📊 Performance: Win Rate ${perf.winRate}% (${perf.wins}W / ${perf.losses}L) | Total R: ${perf.totalR > 0 ? '+' : ''}${perf.totalR}R\n`;
        if (!active.length) return `${header}No currently active trades.`;
        const list = active.map(t => `${t.symbol} ${t.direction} @ ${t.entry_price} [${t.status}] (SL: ${t.sl_price})`).join('\n');
        return `${header}\nActive Trades:\n${list}`;
      }
      case 'scanner':
        if (args[0] !== 'on' && args[0] !== 'off') return 'Usage: /scanner on|off';
        this.setAutoScanner(args[0] === 'on');
        return `Auto-scanner ${args[0]}`;
      case 'status': {
        if (args[0]) {
          const s = this.states.get(this.normalize(args[0]));
          return s ? formatAlert(s).replace(/^.*\n/, `${s.symbol} ${s.stage}\n`) : 'No state yet for that symbol.';
        }
        return `Mode: ${this.d.cfg.paperMode ? 'PAPER (not sending)' : 'LIVE'}\nAuto-scanner: ${this.autoScannerEnabled ? 'on (top 50)' : 'off'}\nKillzone filter: ${this.killzoneGlobal ? 'on' : 'off'}\nMuted: ${this.muted ? 'yes' : 'no'}\nWatching ${this.d.db.listWatch().length} symbols`;
      }
      case 'killzone':
        if (args[0] !== 'on' && args[0] !== 'off') return 'Usage: /killzone on|off';
        this.setKillzone(args[0] === 'on');
        return `Killzone filter ${args[0]}`;
      case 'mute':
        this.setMuted(true);
        return 'Alerts muted';
      case 'unmute':
        this.setMuted(false);
        return 'Alerts unmuted';
      default:
        return '';
    }
  }
}
