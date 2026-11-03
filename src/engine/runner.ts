import { EventEmitter } from 'node:events';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { CandleStore } from '../data/candleStore.js';
import type { Candle, Setup, StrategyCfg } from '../types.js';
import { evaluate } from '../strategy/mod01.js';
import { aggregate } from '../strategy/indicators.js';
import { AlertGate } from './alertGate.js';
import { renderChartPng } from '../chart/renderer.js';
import { LifecycleManager, type LifecycleEvent } from './lifecycle.js';
import type { Notifier } from '../notify/discord.js';
import type { ContractInfo } from '../mexc/rest.js';
import { formatAlert } from '../notify/format.js';

export interface FeedLike {
  subscribe(symbol: string): void;
  unsubscribe(symbol: string): void;
}

export interface RunnerDeps {
  cfg: AppConfig;
  db: Db;
  feed: FeedLike;
  fetchKlines: (symbol: string, bars: number) => Promise<Candle[]>;
  fetchContracts: () => Promise<ContractInfo[]>;
  fetchTopVolumePerps?: (limit: number) => Promise<string[]>;
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
  readonly chartsDir: string;
  contracts: ContractInfo[] = [];
  private lastEval = new Map<string, number>();
  private log: (msg: string) => void;
  private autoScanTimer: NodeJS.Timeout | null = null;

  constructor(private d: RunnerDeps) {
    super();
    this.store = new CandleStore(d.cfg.historyBars);
    this.lifecycle = new LifecycleManager(d.db);
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

  setKillzone(on: boolean) {
    this.d.db.setSetting('killzone', on ? '1' : '0');
  }
  setMuted(m: boolean) {
    this.d.db.setSetting('mute', m ? '1' : '0');
  }
  setAutoScanner(on: boolean) {
    this.d.db.setSetting('auto_scanner', on ? '1' : '0');
    if (on) void this.runAutoScan();
  }

  strategyCfg(symbol: string): StrategyCfg {
    const row = this.d.db.listWatch().find(w => w.symbol === symbol);
    const c: StrategyCfg = { ...this.d.cfg.strategy, useKillzone: this.killzoneGlobal };
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

    // Run auto-scanner if enabled
    if (this.autoScannerEnabled && this.d.fetchTopVolumePerps) {
      void this.runAutoScan();
      this.autoScanTimer = setInterval(() => void this.runAutoScan(), 3600_000);
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
    const candles = await this.d.fetchKlines(symbol, this.d.cfg.historyBars);
    this.store.setHistory(symbol, candles);
  }

  async resyncAll() {
    for (const w of this.d.db.listWatch()) await this.backfill(w.symbol).catch(e => this.log(`resync ${w.symbol}: ${(e as Error).message}`));
  }

  // ---------- auto-scanner ----------
  async runAutoScan(limit = 50): Promise<string[]> {
    if (!this.d.fetchTopVolumePerps) return [];
    try {
      this.log(`auto-scanner: fetching top ${limit} volume pairs from MEXC...`);
      const topSymbols = await this.d.fetchTopVolumePerps(limit);
      const topSet = new Set(topSymbols);

      // Unsubscribe coins that fell off top 50 (unless user pinned them manually)
      const removed = this.d.db.removeAutoWatchesExcept(topSet);
      for (const s of removed) {
        this.d.feed.unsubscribe(s);
        this.store.drop(s);
        this.states.delete(s);
        this.emit('state', { symbol: s, removed: true });
      }

      // Add & activate new top volume coins
      for (const sym of topSymbols) {
        const added = this.d.db.addWatch(sym, true);
        if (added && !this.store.has(sym)) {
          await this.activate(sym).catch(e => this.log(`auto-scan activate ${sym}: ${(e as Error).message}`));
        }
      }

      this.log(`auto-scanner: synced ${topSymbols.length} active volume pairs (removed ${removed.length} expired)`);
      this.emit('watchlist_updated');
      return topSymbols;
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
    this.states.delete(symbol);
    this.emit('state', { symbol, removed: true });
    return { ok: removed, msg: removed ? `${symbol} removed` : `${symbol} was not on the watchlist` };
  }

  // ---------- data in ----------
  onKline(symbol: string, c: Candle) {
    if (!this.d.db.listWatch().some(w => w.symbol === symbol)) return;
    const closed = this.store.ingest(symbol, c);
    const now = Date.now();
    const last = this.lastEval.get(symbol) ?? 0;
    if (closed || now - last >= this.d.cfg.evalThrottleSec * 1000) this.evaluateSymbol(symbol);

    // Track active trades on price movement
    const milestones = this.lifecycle.onPrice(symbol, c);
    for (const m of milestones) {
      this.emit('milestone', m);
      void this.dispatchMilestone(m);
    }
  }

  evaluateSymbol(symbol: string): Setup | null {
    const closed = this.store.closed(symbol);
    if (closed.length < 20) return null;
    this.lastEval.set(symbol, Date.now());
    const setup = evaluate(symbol, closed, this.store.forming(symbol), this.strategyCfg(symbol));
    const prev = this.states.get(symbol);
    this.states.set(symbol, setup);
    if (!prev || prev.stage !== setup.stage || prev.setupId !== setup.setupId || Math.abs(prev.price - setup.price) > 0) this.emit('state', { symbol, setup });

    // Filter alert: auto-scanned coins only alert on ARMED & ENTRY_READY (skip WATCH)
    const watchRow = this.d.db.listWatch().find(w => w.symbol === symbol);
    const isAuto = watchRow?.is_auto === 1;
    if (isAuto && setup.stage === 'WATCH') {
      return setup;
    }

    if (!this.muted && this.gate.shouldAlert(setup)) {
      void this.dispatch(setup);
    }
    return setup;
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
        const htf = aggregate(ltf, this.strategyCfg(setup.symbol).htfMinutes);
        chartBuffer = renderChartPng(setup.symbol, htf, ltf, setup);

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
