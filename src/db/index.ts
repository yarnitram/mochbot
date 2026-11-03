import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Setup, StrategyId } from '../types.js';
import type { MochexConfig } from '../config.js';

export interface WatchRow {
  symbol: string;
  killzone: number | null; // null = use global
  sensitivity: string | null;
  watch_distance: number | null;
  is_auto: number; // 0 = manual/pinned, 1 = auto-scanned
  strategy: StrategyId;
  added_at: number;
}

export interface AlertRow {
  id: number;
  ts: number;
  symbol: string;
  stage: string;
  direction: string | null;
  setup_id: string | null;
  strategy_id: string;
  delivered: number;
  payload: string;
}

export type TradeStatus = 'OPEN' | 'TP1_HIT' | 'CLOSED_TP2' | 'CLOSED_SL' | 'CLOSED_BE' | 'CLOSED_MANUAL';

export interface TradeRow {
  id: number;
  symbol: string;
  direction: string;
  entry_price: number;
  sl_price: number;
  tp1_price: number;
  tp2_price: number;
  status: TradeStatus;
  opened_at: number;
  closed_at: number | null;
  pnl_r: number | null;
  pnl_usd: number | null;
  margin: number;
  leverage: number;
  notional: number;
  strategy_id: string;
  setup_id: string | null;
  chart_file: string | null;
  mochex_trade_id?: string | null;
}

export interface PerformanceSummary {
  totalTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalR: number;
  totalPnlUsd: number;
  accountCapital: number;
  currentEquity: number;
  returnPct: number;
  defaultMargin: number;
  riskPerTrade: number;
}

export interface CoinStats {
  symbol: string;
  totalTrades: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalR: number;
  avgR: number;
  totalPnlUsd: number;
  avgPnlUsd: number;
  activeTrades: number;
  totalAlerts: number;
  lastActive: number;
  isWatching: boolean;
  isAuto: boolean;
  autoType?: number;
  strategy?: StrategyId;
}

// loaded via require so bundlers/test runners that do not know node:sqlite do not choke on it
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export class Db {
  private db: DatabaseSyncT;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS watchlist (
        symbol TEXT PRIMARY KEY,
        killzone INTEGER,
        sensitivity TEXT,
        watch_distance REAL,
        is_auto INTEGER NOT NULL DEFAULT 0,
        strategy TEXT NOT NULL DEFAULT 'MOD-01',
        added_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        symbol TEXT NOT NULL,
        stage TEXT NOT NULL,
        direction TEXT,
        setup_id TEXT,
        strategy_id TEXT NOT NULL DEFAULT 'MOD-01',
        delivered INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS alerts_ts ON alerts(ts DESC);
      CREATE INDEX IF NOT EXISTS alerts_sym ON alerts(symbol);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry_price REAL NOT NULL,
        sl_price REAL NOT NULL,
        tp1_price REAL NOT NULL,
        tp2_price REAL NOT NULL,
        status TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER,
        pnl_r REAL,
        pnl_usd REAL,
        margin REAL DEFAULT 1.0,
        leverage REAL DEFAULT 50.0,
        notional REAL DEFAULT 50.0,
        strategy_id TEXT NOT NULL DEFAULT 'MOD-01',
        setup_id TEXT UNIQUE,
        chart_file TEXT,
        mochex_trade_id TEXT
      );
      CREATE INDEX IF NOT EXISTS trades_status ON trades(status);
      CREATE INDEX IF NOT EXISTS trades_symbol ON trades(symbol);
    `);

    // Safe migration for existing databases
    try {
      this.db.exec(`ALTER TABLE watchlist ADD COLUMN is_auto INTEGER NOT NULL DEFAULT 0;`);
    } catch {}
    try {
      this.db.exec(`ALTER TABLE trades ADD COLUMN chart_file TEXT;`);
    } catch {}
    try {
      this.db.exec(`ALTER TABLE trades ADD COLUMN margin REAL DEFAULT 1.0;`);
    } catch {}
    try {
      this.db.exec(`ALTER TABLE trades ADD COLUMN leverage REAL DEFAULT 50.0;`);
    } catch {}
    try {
      this.db.exec(`ALTER TABLE trades ADD COLUMN notional REAL DEFAULT 50.0;`);
    } catch {}
    try {
      this.db.exec(`ALTER TABLE trades ADD COLUMN pnl_usd REAL;`);
    } catch {}
    try {
      this.db.exec(`ALTER TABLE watchlist ADD COLUMN strategy TEXT NOT NULL DEFAULT 'MOD-01';`);
    } catch {}
    try {
      this.db.exec(`ALTER TABLE alerts ADD COLUMN strategy_id TEXT NOT NULL DEFAULT 'MOD-01';`);
    } catch {}
    try {
      this.db.exec(`ALTER TABLE trades ADD COLUMN strategy_id TEXT NOT NULL DEFAULT 'MOD-01';`);
    } catch {}
    try {
      this.db.exec(`ALTER TABLE trades ADD COLUMN mochex_trade_id TEXT;`);
    } catch {}
    try {
      const rawMod01 = this.getSetting('strategy_cfg_mod01');
      if (rawMod01) {
        const parsed = JSON.parse(rawMod01);
        if (parsed.ltfMinutes === 1) {
          parsed.ltfMinutes = 3;
          this.setSetting('strategy_cfg_mod01', JSON.stringify(parsed));
        }
      }
    } catch {}
  }

  // ---------- Watchlist ----------
  listWatch(): WatchRow[] {
    return this.db.prepare("SELECT symbol, killzone, sensitivity, watch_distance, COALESCE(is_auto, 0) as is_auto, COALESCE(strategy, 'MOD-01') as strategy, added_at FROM watchlist ORDER BY is_auto ASC, symbol ASC").all() as unknown as WatchRow[];
  }

  addWatch(symbol: string, isAuto: boolean | number = false, strategy: StrategyId = 'MOD-01'): boolean {
    const existing = this.db.prepare('SELECT symbol, is_auto, strategy FROM watchlist WHERE symbol = ?').get(symbol) as { symbol: string; is_auto: number; strategy: string } | undefined;
    const isAutoVal = typeof isAuto === 'number' ? isAuto : isAuto ? 1 : 0;
    if (existing) {
      if (isAutoVal === 0 && existing.is_auto > 0) {
        this.db.prepare('UPDATE watchlist SET is_auto = 0, strategy = ? WHERE symbol = ?').run(strategy, symbol);
        return true;
      }
      return false;
    }
    this.db.prepare('INSERT INTO watchlist(symbol, is_auto, strategy, added_at) VALUES (?, ?, ?, ?)').run(symbol, isAutoVal, strategy, Math.floor(Date.now() / 1000));
    return true;
  }

  resetAll(): { watchlist: number; trades: number; alerts: number; settings: number } {
    const w = this.db.prepare('DELETE FROM watchlist').run();
    const t = this.db.prepare('DELETE FROM trades').run();
    const a = this.db.prepare('DELETE FROM alerts').run();
    const s = this.db.prepare('DELETE FROM settings').run();
    return {
      watchlist: Number(w.changes),
      trades: Number(t.changes),
      alerts: Number(a.changes),
      settings: Number(s.changes),
    };
  }

  clearWatchlist(): number {
    const r = this.db.prepare('DELETE FROM watchlist').run();
    return Number(r.changes);
  }

  removeWatch(symbol: string): boolean {
    const r = this.db.prepare('DELETE FROM watchlist WHERE symbol = ?').run(symbol);
    return r.changes > 0;
  }

  removeAutoWatchesExcept(keepSymbols: Set<string>): string[] {
    const all = this.listWatch().filter(w => w.is_auto > 0);
    const toRemove: string[] = [];
    for (const w of all) {
      if (!keepSymbols.has(w.symbol)) {
        this.removeWatch(w.symbol);
        toRemove.push(w.symbol);
      }
    }
    return toRemove;
  }

  pruneAutoWatch(activeSymbols: string[]): number {
    if (activeSymbols.length === 0) return 0;
    const placeholders = activeSymbols.map(() => '?').join(',');
    const r = this.db.prepare(`DELETE FROM watchlist WHERE is_auto = 1 AND symbol NOT IN (${placeholders})`).run(...activeSymbols);
    return Number(r.changes);
  }

  updateWatch(
    symbol: string,
    patch: {
      killzone?: boolean | null;
      sensitivity?: string | null;
      watch_distance?: number | null;
      strategy?: StrategyId;
    }
  ): boolean {
    const cur = this.db.prepare("SELECT symbol, killzone, sensitivity, watch_distance, COALESCE(strategy, 'MOD-01') as strategy FROM watchlist WHERE symbol = ?").get(symbol) as any;
    if (!cur) return false;
    const kz = patch.killzone === undefined ? cur.killzone : patch.killzone === null ? null : patch.killzone ? 1 : 0;
    const sens = patch.sensitivity === undefined ? cur.sensitivity : patch.sensitivity;
    const wd = patch.watch_distance === undefined ? cur.watch_distance : patch.watch_distance;
    const strat = patch.strategy || cur.strategy || 'MOD-01';
    this.db.prepare('UPDATE watchlist SET killzone=?, sensitivity=?, watch_distance=?, strategy=? WHERE symbol=?').run(kz, sens, wd, strat, symbol);
    return true;
  }

  // ---------- Settings ----------
  getSetting(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? r.value : null;
  }
  setSetting(key: string, value: string) {
    this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }

  getAccountCapital(): number {
    const v = this.getSetting('account_capital');
    const n = v ? Number(v) : 1000;
    return Number.isFinite(n) && n > 0 ? n : 1000;
  }

  setAccountCapital(val: number): void {
    this.setSetting('account_capital', String(Math.max(1, val)));
  }

  getRiskPerTrade(): number {
    const v = this.getSetting('risk_per_trade');
    if (v) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 5.0;
  }

  setRiskPerTrade(val: number): void {
    this.setSetting('risk_per_trade', String(Math.max(0.1, val)));
  }

  getDefaultMargin(): number {
    const v = this.getSetting('default_margin');
    const n = v ? Number(v) : 1;
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  setDefaultMargin(val: number): void {
    this.setSetting('default_margin', String(Math.max(0.1, val)));
  }

  getGlobalStrategy(): StrategyId {
    const v = this.getSetting('global_strategy');
    return v === 'MOD-01D' ? 'MOD-01D' : v === 'MOD-01E' ? 'MOD-01E' : 'MOD-01';
  }

  setGlobalStrategy(strat: StrategyId): void {
    this.setSetting('global_strategy', strat);
  }

  getStrategyCfg<T = Record<string, any>>(strategyId: StrategyId, defaults?: T): T {
    const key = `strategy_cfg_${strategyId.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    const raw = this.getSetting(key);
    if (!raw) return (defaults ?? {}) as T;
    try {
      return { ...(defaults ?? {}), ...JSON.parse(raw) } as T;
    } catch {
      return (defaults ?? {}) as T;
    }
  }

  setStrategyCfg<T>(strategyId: StrategyId, cfg: T): void {
    const key = `strategy_cfg_${strategyId.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    this.setSetting(key, JSON.stringify(cfg));
  }

  // ---------- Alerts ----------
  insertAlert(setup: Setup, delivered: boolean): number {
    const stratId = setup.strategyId || 'MOD-01';
    const r = this.db
      .prepare('INSERT INTO alerts(ts, symbol, stage, direction, setup_id, delivered, payload, strategy_id) VALUES (?,?,?,?,?,?,?,?)')
      .run(Math.floor(Date.now() / 1000), setup.symbol, setup.stage, setup.direction, setup.setupId, delivered ? 1 : 0, JSON.stringify(setup), stratId);
    return Number(r.lastInsertRowid);
  }

  markDelivered(id: number) {
    this.db.prepare('UPDATE alerts SET delivered = 1 WHERE id = ?').run(id);
  }

  recentAlerts(limit = 100): AlertRow[] {
    return this.db.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT ?').all(limit) as unknown as AlertRow[];
  }

  alertsSince(tsSec: number): AlertRow[] {
    return this.db.prepare('SELECT * FROM alerts WHERE ts >= ? ORDER BY id').all(tsSec) as unknown as AlertRow[];
  }

  // ---------- Trade Lifecycle & Performance ----------
  createTrade(trade: {
    symbol: string;
    direction: string;
    entry_price: number;
    sl_price: number;
    tp1_price: number;
    tp2_price: number;
    setup_id?: string | null;
    chart_file?: string | null;
    opened_at?: number;
    margin?: number;
    leverage?: number;
    notional?: number;
    strategy_id?: string;
  }): number {
    const now = trade.opened_at ?? Math.floor(Date.now() / 1000);
    const margin = trade.margin ?? this.getDefaultMargin();
    const leverage = trade.leverage ?? 50;
    const notional = trade.notional ?? (margin * leverage);
    const strategyId = trade.strategy_id || 'MOD-01';
    const r = this.db
      .prepare(`INSERT INTO trades (symbol, direction, entry_price, sl_price, tp1_price, tp2_price, status, opened_at, setup_id, chart_file, margin, leverage, notional, strategy_id)
                VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        trade.symbol,
        trade.direction,
        trade.entry_price,
        trade.sl_price,
        trade.tp1_price,
        trade.tp2_price,
        now,
        trade.setup_id ?? null,
        trade.chart_file ?? null,
        margin,
        leverage,
        notional,
        strategyId
      );
    return Number(r.lastInsertRowid);
  }

  setTradeChart(id: number, chartFile: string): void {
    this.db.prepare('UPDATE trades SET chart_file = ? WHERE id = ?').run(chartFile, id);
  }

  updateTradeStatus(id: number, status: TradeStatus, pnlR?: number, closedAt?: number, pnlUsd?: number): void {
    const closed = closedAt ?? Math.floor(Date.now() / 1000);
    if (pnlR !== undefined) {
      if (pnlUsd !== undefined) {
        this.db.prepare('UPDATE trades SET status = ?, pnl_r = ?, pnl_usd = ?, closed_at = ? WHERE id = ?').run(status, pnlR, pnlUsd, closed, id);
      } else {
        this.db.prepare('UPDATE trades SET status = ?, pnl_r = ?, closed_at = ? WHERE id = ?').run(status, pnlR, closed, id);
      }
    } else {
      this.db.prepare('UPDATE trades SET status = ? WHERE id = ?').run(status, id);
    }
  }

  updateTradeSl(id: number, slPrice: number): void {
    this.db.prepare('UPDATE trades SET sl_price = ? WHERE id = ?').run(slPrice, id);
  }

  getActiveTrades(): TradeRow[] {
    return this.db.prepare("SELECT * FROM trades WHERE status IN ('OPEN', 'TP1_HIT') ORDER BY opened_at DESC").all() as unknown as TradeRow[];
  }

  deleteTrade(id: number): boolean {
    const r = this.db.prepare('DELETE FROM trades WHERE id = ?').run(id);
    return r.changes > 0;
  }

  deleteActiveTrades(): number {
    const r = this.db.prepare("DELETE FROM trades WHERE status IN ('OPEN', 'TP1_HIT')").run();
    return Number(r.changes);
  }

  getTrade(id: number): TradeRow | undefined {
    return this.db.prepare('SELECT * FROM trades WHERE id = ?').get(id) as unknown as TradeRow | undefined;
  }

  getTradeHistory(limit = 50): TradeRow[] {
    return this.db.prepare('SELECT * FROM trades ORDER BY id DESC LIMIT ?').all(limit) as unknown as TradeRow[];
  }

  getPerformanceSummary(strategyFilter?: string): PerformanceSummary {
    const sql = strategyFilter && strategyFilter !== 'ALL'
      ? "SELECT status, pnl_r, pnl_usd FROM trades WHERE COALESCE(strategy_id, 'MOD-01') = ?"
      : "SELECT status, pnl_r, pnl_usd FROM trades";
    const rows = (strategyFilter && strategyFilter !== 'ALL'
      ? this.db.prepare(sql).all(strategyFilter)
      : this.db.prepare(sql).all()) as unknown as { status: TradeStatus; pnl_r: number | null; pnl_usd: number | null }[];
    let openTrades = 0;
    let wins = 0;
    let losses = 0;
    let totalR = 0;
    let totalPnlUsd = 0;

    for (const r of rows) {
      if (r.status === 'OPEN' || r.status === 'TP1_HIT') {
        openTrades++;
      } else {
        const pnl = r.pnl_r ?? 0;
        totalR += pnl;
        totalPnlUsd += r.pnl_usd ?? 0;
        if (pnl > 0) wins++;
        else losses++;
      }
    }

    const totalClosed = wins + losses;
    const winRate = totalClosed > 0 ? (wins / totalClosed) * 100 : 0;
    const accountCapital = this.getAccountCapital();
    const defaultMargin = this.getDefaultMargin();
    const riskPerTrade = this.getRiskPerTrade();
    const currentEquity = accountCapital + totalPnlUsd;
    const returnPct = accountCapital > 0 ? (totalPnlUsd / accountCapital) * 100 : 0;

    return {
      totalTrades: rows.length,
      openTrades,
      wins,
      losses,
      winRate: Number(winRate.toFixed(1)),
      totalR: Number(totalR.toFixed(2)),
      totalPnlUsd: Number(totalPnlUsd.toFixed(2)),
      accountCapital,
      currentEquity: Number(currentEquity.toFixed(2)),
      returnPct: Number(returnPct.toFixed(2)),
      defaultMargin,
      riskPerTrade,
    };
  }

  // ---------- Coin Analytics & Journal ----------
  getCoinAnalytics(strategyFilter?: string): CoinStats[] {
    const symRows = this.db
      .prepare(
        `SELECT DISTINCT symbol FROM (
           SELECT symbol FROM watchlist
           UNION
           SELECT symbol FROM trades
           UNION
           SELECT symbol FROM alerts
         ) ORDER BY symbol ASC`
      )
      .all() as unknown as { symbol: string }[];

    const watchMap = new Map<string, { is_auto: number; strategy: StrategyId }>();
    for (const w of this.listWatch()) {
      watchMap.set(w.symbol, { is_auto: w.is_auto, strategy: w.strategy });
    }

    const out: CoinStats[] = [];

    for (const { symbol } of symRows) {
      const tradeSql = strategyFilter && strategyFilter !== 'ALL'
        ? "SELECT status, pnl_r, pnl_usd, opened_at FROM trades WHERE symbol = ? AND COALESCE(strategy_id, 'MOD-01') = ?"
        : "SELECT status, pnl_r, pnl_usd, opened_at FROM trades WHERE symbol = ?";
      const trades = (strategyFilter && strategyFilter !== 'ALL'
        ? this.db.prepare(tradeSql).all(symbol, strategyFilter)
        : this.db.prepare(tradeSql).all(symbol)) as unknown as {
        status: TradeStatus;
        pnl_r: number | null;
        pnl_usd: number | null;
        opened_at: number;
      }[];

      const alertSql = strategyFilter && strategyFilter !== 'ALL'
        ? "SELECT COUNT(*) as c, MAX(ts) as maxTs FROM alerts WHERE symbol = ? AND COALESCE(strategy_id, 'MOD-01') = ?"
        : "SELECT COUNT(*) as c, MAX(ts) as maxTs FROM alerts WHERE symbol = ?";
      const alertStats = (strategyFilter && strategyFilter !== 'ALL'
        ? this.db.prepare(alertSql).get(symbol, strategyFilter)
        : this.db.prepare(alertSql).get(symbol)) as unknown as {
        c: number;
        maxTs: number | null;
      };

      const coinStrat = watchMap.get(symbol)?.strategy;
      if (strategyFilter && strategyFilter !== 'ALL') {
        const hasStratActivity = trades.length > 0 || (alertStats?.c ?? 0) > 0 || coinStrat === strategyFilter;
        if (!hasStratActivity) continue;
      }

      let wins = 0;
      let losses = 0;
      let totalR = 0;
      let totalPnlUsd = 0;
      let activeTrades = 0;
      let maxTradeTs = 0;

      for (const t of trades) {
        if (t.opened_at > maxTradeTs) maxTradeTs = t.opened_at;
        if (t.status === 'OPEN' || t.status === 'TP1_HIT') {
          activeTrades++;
        } else {
          const pnl = t.pnl_r ?? 0;
          totalR += pnl;
          totalPnlUsd += t.pnl_usd ?? 0;
          if (pnl > 0) wins++;
          else losses++;
        }
      }

      const closedTrades = wins + losses;
      const winRate = closedTrades > 0 ? (wins / closedTrades) * 100 : 0;
      const avgR = closedTrades > 0 ? totalR / closedTrades : 0;
      const avgPnlUsd = closedTrades > 0 ? totalPnlUsd / closedTrades : 0;
      const lastActive = Math.max(maxTradeTs, alertStats?.maxTs ?? 0);
      const isWatching = watchMap.has(symbol);
      const isAuto = watchMap.get(symbol)?.is_auto === 1;

      out.push({
        symbol,
        totalTrades: trades.length,
        closedTrades,
        wins,
        losses,
        winRate: Number(winRate.toFixed(1)),
        totalR: Number(totalR.toFixed(2)),
        avgR: Number(avgR.toFixed(2)),
        totalPnlUsd: Number(totalPnlUsd.toFixed(2)),
        avgPnlUsd: Number(avgPnlUsd.toFixed(2)),
        activeTrades,
        totalAlerts: alertStats?.c ?? 0,
        lastActive,
        isWatching,
        isAuto,
        autoType: watchMap.get(symbol)?.is_auto ?? 0,
        strategy: watchMap.get(symbol)?.strategy || 'MOD-01',
      });
    }

    // Sort by totalTrades DESC, then totalR DESC, then symbol ASC
    return out.sort((a, b) => b.totalTrades - a.totalTrades || b.totalR - a.totalR || a.symbol.localeCompare(b.symbol));
  }

  getCoinJournal(symbol: string): {
    stats: CoinStats | null;
    trades: TradeRow[];
    alerts: AlertRow[];
  } {
    const analytics = this.getCoinAnalytics().find(c => c.symbol === symbol) ?? null;
    const trades = this.db.prepare('SELECT * FROM trades WHERE symbol = ? ORDER BY opened_at DESC, id DESC').all(symbol) as unknown as TradeRow[];
    const alerts = this.db.prepare('SELECT * FROM alerts WHERE symbol = ? ORDER BY ts DESC, id DESC LIMIT 200').all(symbol) as unknown as AlertRow[];

    return {
      stats: analytics,
      trades,
      alerts,
    };
  }

  close() {
    this.db.close();
  }
  setMochexTradeId(id: number, mochexTradeId: string): void {
    this.db.prepare('UPDATE trades SET mochex_trade_id = ? WHERE id = ?').run(mochexTradeId, id);
  }

  getMochexConfig(defaults: MochexConfig): MochexConfig {
    const url = this.getSetting('mochex_api_url');
    const key = this.getSetting('mochex_api_key');
    const enabled = this.getSetting('mochex_sync_enabled');
    const notify = this.getSetting('mochex_notify');
    return {
      apiUrl: url || defaults.apiUrl,
      apiKey: key !== null ? (key || null) : defaults.apiKey,
      enabled: enabled !== null ? enabled === '1' : defaults.enabled,
      notify: notify !== null ? notify === '1' : defaults.notify,
    };
  }

  setMochexConfig(cfg: Partial<MochexConfig>): void {
    if (cfg.apiUrl !== undefined) this.setSetting('mochex_api_url', cfg.apiUrl);
    if (cfg.apiKey !== undefined) this.setSetting('mochex_api_key', cfg.apiKey || '');
    if (cfg.enabled !== undefined) this.setSetting('mochex_sync_enabled', cfg.enabled ? '1' : '0');
    if (cfg.notify !== undefined) this.setSetting('mochex_notify', cfg.notify ? '1' : '0');
  }

}
