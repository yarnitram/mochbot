import type { Db, TradeRow } from '../db/index.js';
import type { LifecycleEvent } from '../engine/lifecycle.js';
import type { MochexConfig } from '../config.js';

export function normalizeMochexUrl(inputUrl: string): string {
  let url = (inputUrl || '').trim();
  if (!url) return 'https://staging.ymatt.online/api/trades/webhook';
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://${url}`;
  }
  try {
    const u = new URL(url);
    if (!u.pathname || u.pathname === '/' || u.pathname === '') {
      u.pathname = '/api/trades/webhook';
    } else if (!u.pathname.endsWith('/webhook') && !u.pathname.includes('/trades/webhook') && !u.pathname.includes('/tradingview')) {
      u.pathname = u.pathname.replace(/\/+$/, '') + '/api/trades/webhook';
    } else {
      u.pathname = u.pathname.replace(/\/+$/, '');
    }
    return u.toString().replace(/\/+$/, '');
  } catch {
    return 'https://staging.ymatt.online/api/trades/webhook';
  }
}

export interface MochexTestResult {
  ok: boolean;
  authenticated: boolean;
  status?: number;
  active_count?: number;
  endpoint?: string;
  error?: string;
}

export class MochexSync {
  private log: (msg: string) => void;

  constructor(
    private db: Db,
    private defaultCfg: MochexConfig,
    log?: (msg: string) => void,
  ) {
    this.log = log ?? (m => console.log(`[mochex-sync] ${m}`));
  }

  getConfig(): MochexConfig {
    return this.db.getMochexConfig(this.defaultCfg);
  }

  async testConnection(testUrl?: string, testApiKey?: string): Promise<MochexTestResult> {
    const cfg = this.getConfig();
    const url = normalizeMochexUrl(testUrl || cfg.apiUrl);
    const key = testApiKey !== undefined ? testApiKey : cfg.apiKey;

    if (!key || !key.trim()) {
      return { ok: false, authenticated: false, error: 'Missing MOCHEX API Key' };
    }

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'X-API-Key': key.trim(),
          'Accept': 'application/json',
        },
      });

      if (!res.ok) {
        let errMsg = `HTTP ${res.status}: ${res.statusText}`;
        try {
          const errData = await res.json() as any;
          if (errData && errData.error) errMsg = errData.error;
        } catch {}
        return {
          ok: false,
          authenticated: false,
          status: res.status,
          error: errMsg,
        };
      }

      const data = await res.json() as any;
      return {
        ok: !!data.ok,
        authenticated: !!data.authenticated,
        status: res.status,
        active_count: typeof data.active_count === 'number' ? data.active_count : 0,
        endpoint: data.endpoint,
        error: data.authenticated ? undefined : 'Invalid API key or unauthorized',
      };
    } catch (err: any) {
      return {
        ok: false,
        authenticated: false,
        error: err.message || 'Network connection failed',
      };
    }
  }

  async openTrade(trade: TradeRow, customNotes?: string): Promise<{ ok: boolean; tradeId?: string; error?: string }> {
    const cfg = this.getConfig();
    if (!cfg.enabled || !cfg.apiKey) return { ok: false, error: 'Sync disabled or missing API key' };

    const url = normalizeMochexUrl(cfg.apiUrl);
    const side = trade.direction.toLowerCase() === 'short' ? 'short' : 'long';
    const risk=Math.abs(trade.entry_price-(trade.initial_sl_price??trade.sl_price));
    const rr=(target:number)=>risk>0?Number((Math.abs(target-trade.entry_price)/risk).toFixed(2)):'-';
    const notes = customNotes ?? `[${trade.strategy_id}] Entry: ${trade.entry_price} | TP1 (1:${rr(trade.tp1_price)}): ${trade.tp1_price} | TP2 (1:${rr(trade.tp2_price)}): ${trade.tp2_price}`;

    const payload = {
      action: 'open',
      symbol: trade.symbol,
      side,
      entry_price: trade.entry_price,
      stop_loss: trade.sl_price,
      take_profit: trade.tp1_price, // Initial 1:3 RR target
      margin_usd: trade.margin,
      leverage: trade.leverage,
      order_type: 'market',
      notes,
      notify: cfg.notify,
    };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': cfg.apiKey.trim(),
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json() as any;
      if (res.ok && data.ok) {
        const tradeId = data.trade_id || data.id;
        if (tradeId) {
          this.db.setMochexTradeId(trade.id, String(tradeId));
          trade.mochex_trade_id = String(tradeId);
        }
        this.log(`synced OPEN trade for ${trade.symbol} to MOCHEX (id=${tradeId ?? 'ok'})`);
        return { ok: true, tradeId };
      } else {
        const err = data.error || `HTTP ${res.status}`;
        this.log(`failed to sync OPEN trade for ${trade.symbol}: ${err}`);
        return { ok: false, error: err };
      }
    } catch (err: any) {
      this.log(`error syncing OPEN trade for ${trade.symbol}: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  async updateTrade(trade: TradeRow, updates: { stop_loss?: number; take_profit?: number; notes?: string }): Promise<{ ok: boolean; error?: string }> {
    const cfg = this.getConfig();
    if (!cfg.enabled || !cfg.apiKey) return { ok: false, error: 'Sync disabled or missing API key' };

    const url = normalizeMochexUrl(cfg.apiUrl);
    const payload: Record<string, any> = {
      action: 'update',
      symbol: trade.symbol,
      trade_id: trade.mochex_trade_id || undefined,
      notify: cfg.notify,
    };

    if (updates.stop_loss !== undefined) payload.stop_loss = updates.stop_loss;
    if (updates.take_profit !== undefined) payload.take_profit = updates.take_profit;
    if (updates.notes !== undefined) payload.notes = updates.notes;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': cfg.apiKey.trim(),
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json() as any;
      if (res.ok && data.ok) {
        this.log(`synced UPDATE for ${trade.symbol} to MOCHEX (SL=${updates.stop_loss}, TP=${updates.take_profit})`);
        return { ok: true };
      } else {
        const err = data.error || `HTTP ${res.status}`;
        this.log(`failed to sync UPDATE for ${trade.symbol}: ${err}`);
        return { ok: false, error: err };
      }
    } catch (err: any) {
      this.log(`error syncing UPDATE for ${trade.symbol}: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  async closeTrade(trade: TradeRow, event: LifecycleEvent): Promise<{ ok: boolean; error?: string }> {
    const cfg = this.getConfig();
    if (!cfg.enabled || !cfg.apiKey) return { ok: false, error: 'Sync disabled or missing API key' };

    const url = normalizeMochexUrl(cfg.apiUrl);
    const reason = event.type === 'tp2_hit' ? 'tp_hit' : event.type === 'sl_hit' ? 'sl_hit' : 'manual_close';

    const payload = {
      action: 'close',
      symbol: trade.symbol,
      trade_id: trade.mochex_trade_id || undefined,
      exit_price: event.price,
      closed_reason: reason,
      notes: event.message.split('\n')[0] || `Closed ${event.type}`,
      notify: cfg.notify,
    };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': cfg.apiKey.trim(),
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json() as any;
      if (res.ok && data.ok) {
        this.log(`synced CLOSE for ${trade.symbol} (${reason}) to MOCHEX at price ${event.price}`);
        return { ok: true };
      } else {
        const err = data.error || `HTTP ${res.status}`;
        this.log(`failed to sync CLOSE for ${trade.symbol}: ${err}`);
        return { ok: false, error: err };
      }
    } catch (err: any) {
      this.log(`error syncing CLOSE for ${trade.symbol}: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }
}
