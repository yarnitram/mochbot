import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Setup } from '../types.js';

export interface WatchRow {
  symbol: string;
  killzone: number | null; // null = use global
  sensitivity: string | null;
  watch_distance: number | null;
  added_at: number;
}

export interface AlertRow {
  id: number;
  ts: number;
  symbol: string;
  stage: string;
  direction: string | null;
  setup_id: string | null;
  delivered: number;
  payload: string;
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
        added_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        symbol TEXT NOT NULL,
        stage TEXT NOT NULL,
        direction TEXT,
        setup_id TEXT,
        delivered INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS alerts_ts ON alerts(ts DESC);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  listWatch(): WatchRow[] {
    return this.db.prepare('SELECT * FROM watchlist ORDER BY symbol').all() as unknown as WatchRow[];
  }
  addWatch(symbol: string): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO watchlist(symbol, added_at) VALUES (?, ?)').run(symbol, Math.floor(Date.now() / 1000));
    return Number(r.changes) > 0;
  }
  removeWatch(symbol: string): boolean {
    return Number(this.db.prepare('DELETE FROM watchlist WHERE symbol = ?').run(symbol).changes) > 0;
  }
  updateWatch(symbol: string, patch: { killzone?: boolean | null; sensitivity?: string | null; watch_distance?: number | null }): boolean {
    const cur = this.db.prepare('SELECT * FROM watchlist WHERE symbol = ?').get(symbol) as unknown as WatchRow | undefined;
    if (!cur) return false;
    const kz = patch.killzone === undefined ? cur.killzone : patch.killzone === null ? null : patch.killzone ? 1 : 0;
    const sens = patch.sensitivity === undefined ? cur.sensitivity : patch.sensitivity;
    const wd = patch.watch_distance === undefined ? cur.watch_distance : patch.watch_distance;
    this.db.prepare('UPDATE watchlist SET killzone=?, sensitivity=?, watch_distance=? WHERE symbol=?').run(kz, sens, wd, symbol);
    return true;
  }

  getSetting(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? r.value : null;
  }
  setSetting(key: string, value: string) {
    this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }

  insertAlert(setup: Setup, delivered: boolean): number {
    const r = this.db
      .prepare('INSERT INTO alerts(ts, symbol, stage, direction, setup_id, delivered, payload) VALUES (?,?,?,?,?,?,?)')
      .run(Math.floor(Date.now() / 1000), setup.symbol, setup.stage, setup.direction, setup.setupId, delivered ? 1 : 0, JSON.stringify(setup));
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

  close() {
    this.db.close();
  }
}
