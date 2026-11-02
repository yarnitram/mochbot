import { EventEmitter } from 'node:events';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { CandleStore } from '../data/candleStore.js';
import type { Candle, Setup, StrategyCfg } from '../types.js';
import { evaluate } from '../strategy/mod01.js';
import { AlertGate } from './alertGate.js';
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
  notifiers: Notifier[];
  log?: (msg: string) => void;
}

/** Orchestrates candles -> strategy -> alert gate -> notifiers, and exposes live state for the dashboard. */
export class Runner extends EventEmitter {
  readonly store: CandleStore;
  readonly gate = new AlertGate();
  readonly states = new Map<string, Setup>();
  contracts: ContractInfo[] = [];
  private lastEval = new Map<string, number>();
  private log: (msg: string) => void;

  constructor(private d: RunnerDeps) {
    super();
    this.store = new CandleStore(d.cfg.historyBars);
    this.log = d.log ?? (m => console.log(m));
  }

  // ---------- settings ----------
  get killzoneGlobal(): boolean {
    const v = this.d.db.getSetting('killzone');
    return v === null ? this.d.cfg.strategy.useKillzone : v === '1';
  }
  get muted(): boolean {
    return this.d.db.getSetting('mute') === '1';
  }
  setKillzone(on: boolean) {
    this.d.db.setSetting('killzone', on ? '1' : '0');
  }
  setMuted(m: boolean) {
    this.d.db.setSetting('mute', m ? '1' : '0');
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
    for (const w of this.d.db.listWatch()) await this.activate(w.symbol).catch(e => this.log(`activate ${w.symbol}: ${(e as Error).message}`));
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

  // ---------- watchlist ----------
  normalize(raw: string): string {
    let s = raw.trim().toUpperCase().replace('-', '_').replace('/', '_');
    if (!s.includes('_')) s = s.endsWith('USDT') ? `${s.slice(0, -4)}_USDT` : `${s}_USDT`;
    return s;
  }

  async addSymbol(raw: string): Promise<{ ok: boolean; msg: string; symbol: string }> {
    const symbol = this.normalize(raw);
    if (this.contracts.length && !this.contracts.some(c => c.symbol === symbol)) return { ok: false, msg: `${symbol} is not an active MEXC USDT perpetual`, symbol };
    const added = this.d.db.addWatch(symbol);
    try {
      await this.activate(symbol);
    } catch (e) {
      return { ok: true, msg: `${symbol} added but backfill failed: ${(e as Error).message}`, symbol };
    }
    return { ok: true, msg: added ? `${symbol} added` : `${symbol} already on watchlist`, symbol };
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
  }

  evaluateSymbol(symbol: string): Setup | null {
    const closed = this.store.closed(symbol);
    if (closed.length < 20) return null;
    this.lastEval.set(symbol, Date.now());
    const setup = evaluate(symbol, closed, this.store.forming(symbol), this.strategyCfg(symbol));
    const prev = this.states.get(symbol);
    this.states.set(symbol, setup);
    if (!prev || prev.stage !== setup.stage || prev.setupId !== setup.setupId || Math.abs(prev.price - setup.price) > 0) this.emit('state', { symbol, setup });
    // muted: gate is not consulted, so stages reached while muted can still alert after /unmute
    if (!this.muted && this.gate.shouldAlert(setup)) void this.dispatch(setup);
    return setup;
  }

  private async dispatch(setup: Setup) {
    const id = this.d.db.insertAlert(setup, false);
    this.emit('alert', { id, setup });
    if (this.d.cfg.paperMode) {
      this.log(`[paper] ${setup.symbol} ${setup.stage} ${setup.direction}`);
      return;
    }
    const results = await Promise.allSettled(this.d.notifiers.map(n => n.send(setup)));
    let ok = false;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') ok = true;
      else this.log(`${this.d.notifiers[i].name} send failed: ${(r.reason as Error).message}`);
    });
    if (ok) this.d.db.markDelivered(id);
  }

  // ---------- telegram commands ----------
  async handleCommand(cmd: string, args: string[]): Promise<string> {
    switch (cmd) {
      case 'start':
      case 'help':
        return 'Commands:\n/add SYMBOL\n/remove SYMBOL\n/list\n/status [SYMBOL]\n/killzone on|off\n/mute\n/unmute';
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
        return rows.map(r => `${r.symbol}  ${this.states.get(r.symbol)?.stage ?? 'IDLE'}`).join('\n');
      }
      case 'status': {
        if (args[0]) {
          const s = this.states.get(this.normalize(args[0]));
          return s ? formatAlert(s).replace(/^.*\n/, `${s.symbol} ${s.stage}\n`) : 'No state yet for that symbol.';
        }
        return `Mode: ${this.d.cfg.paperMode ? 'PAPER (not sending)' : 'LIVE'}\nKillzone filter: ${this.killzoneGlobal ? 'on' : 'off'}\nMuted: ${this.muted ? 'yes' : 'no'}\nWatching ${this.d.db.listWatch().length} symbols`;
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
