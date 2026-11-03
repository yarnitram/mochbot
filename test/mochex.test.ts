import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Db } from '../src/db/index.js';
import { MochexSync, normalizeMochexUrl } from '../src/notify/mochex.js';

describe('MOCHEX Integration', () => {
  describe('normalizeMochexUrl', () => {
    it('appends /api/trades/webhook to base origin without trailing slash', () => {
      expect(normalizeMochexUrl('https://staging.ymatt.online'))
        .toBe('https://staging.ymatt.online/api/trades/webhook');
    });

    it('appends /api/trades/webhook to base origin with trailing slash', () => {
      expect(normalizeMochexUrl('https://staging.ymatt.online/'))
        .toBe('https://staging.ymatt.online/api/trades/webhook');
    });

    it('preserves full webhook url unchanged (stripping trailing slash)', () => {
      expect(normalizeMochexUrl('https://staging.ymatt.online/api/trades/webhook/'))
        .toBe('https://staging.ymatt.online/api/trades/webhook');
      expect(normalizeMochexUrl('http://localhost:3000/api/trades/webhook'))
        .toBe('http://localhost:3000/api/trades/webhook');
    });

    it('preserves custom subpaths without double appending', () => {
      expect(normalizeMochexUrl('https://my-domain.com/custom/webhook'))
        .toBe('https://my-domain.com/custom/webhook');
    });
  });

  describe('MochexSync testConnection', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('returns error if url or apiKey is missing', async () => {
      const db = new Db(':memory:');
      const sync = new MochexSync(db, {
        apiUrl: 'https://staging.ymatt.online',
        apiKey: null,
        enabled: true,
        notify: true,
      });

      const res = await sync.testConnection('', '');
      expect(res.ok).toBe(false);
      expect(res.error).toBe('Missing MOCHEX API Key');
    });

    it('succeeds when MOCHEX returns 200 with authenticated: true', async () => {
      const db = new Db(':memory:');
      const sync = new MochexSync(db, {
        enabled: true,
        apiUrl: 'https://staging.ymatt.online',
        apiKey: 'tv_sec_test123',
        notify: true,
      });

      let capturedUrl = '';
      let capturedHeaders: Record<string, string> = {};

      globalThis.fetch = vi.fn(async (url: any, init: any) => {
        capturedUrl = String(url);
        capturedHeaders = init?.headers || {};
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, authenticated: true, active_count: 5 }),
        } as any;
      });

      const res = await sync.testConnection();
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      expect(res.active_count).toBe(5);
      expect(capturedUrl).toBe('https://staging.ymatt.online/api/trades/webhook');
      expect(capturedHeaders['X-API-Key']).toBe('tv_sec_test123');
    });

    it('handles authentication failure (401)', async () => {
      const db = new Db(':memory:');
      const sync = new MochexSync(db, {
        enabled: true,
        apiUrl: 'https://staging.ymatt.online',
        apiKey: 'invalid_key',
        notify: true,
      });

      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({ ok: false, error: 'Unauthorized: Invalid API key' }),
      } as any));

      const res = await sync.testConnection();
      expect(res.ok).toBe(false);
      expect(res.status).toBe(401);
      expect(res.error).toBe('Unauthorized: Invalid API key');
    });
  });

  describe('Trade Lifecycle Synchronization', () => {
    let originalFetch: typeof globalThis.fetch;
    let db: Db;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      db = new Db(':memory:');
      db.addWatch('KAIA_USDT', false);
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('syncs openTrade, updates mochex_trade_id in DB, then syncs updateTrade and closeTrade', async () => {
      const calls: { url: string; body: any }[] = [];

      globalThis.fetch = vi.fn(async (url: any, init: any) => {
        const body = JSON.parse(init.body);
        calls.push({ url: String(url), body });

        if (body.action === 'open') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, trade_id: 'mochex-uuid-999' }),
          } as any;
        }

        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        } as any;
      });

      const sync = new MochexSync(db, {
        enabled: true,
        apiUrl: 'https://staging.ymatt.online',
        apiKey: 'tv_sec_test123',
        notify: true,
      });

      // 1. Create a trade in Mochbot DB
      const tradeId = db.createTrade({
        symbol: 'KAIA_USDT',
        direction: 'LONG',
        entry_price: 0.125,
        sl_price: 0.120,
        tp1_price: 0.140,
        tp2_price: 0.150,
        setup_id: 'kaia-setup-1',
        opened_at: 1000,
        margin: 10.0,
        leverage: 20.0,
        notional: 200.0,
      });

      const initialTrade = db.getTrade(tradeId)!;
      expect(initialTrade).toBeDefined();

      // 2. Open trade sync
      const openRes = await sync.openTrade(initialTrade, 'MOD-01 (15m POI -> 3m CHoCH)');
      expect(openRes.ok).toBe(true);
      expect(openRes.tradeId).toBe('mochex-uuid-999');

      // Verify DB was updated with the remote MOCHEX trade id
      const updatedTrade = db.getTrade(tradeId)!;
      expect(updatedTrade.mochex_trade_id).toBe('mochex-uuid-999');

      // Verify open payload
      expect(calls.length).toBe(1);
      expect(calls[0].body).toEqual({
        action: 'open',
        symbol: 'KAIA_USDT',
        side: 'long',
        entry_price: 0.125,
        stop_loss: 0.120,
        take_profit: 0.140, // initial TP is TP1
        margin_usd: 10.0,
        leverage: 20.0,
        order_type: 'market',
        notes: 'MOD-01 (15m POI -> 3m CHoCH)',
        notify: true,
      });

      // 3. Update trade sync (TP1 hit -> Move SL to Break-Even & extend TP to TP2)
      const updateRes = await sync.updateTrade(updatedTrade, {
        stop_loss: updatedTrade.entry_price,
        take_profit: updatedTrade.tp2_price,
        notes: 'Mochbot: TP1 Hit! Moved SL to Break-Even (0.125), targeting TP2 Runner (0.15)',
      });
      expect(updateRes.ok).toBe(true);

      expect(calls.length).toBe(2);
      expect(calls[1].body).toEqual({
        action: 'update',
        symbol: 'KAIA_USDT',
        trade_id: 'mochex-uuid-999',
        stop_loss: 0.125,
        take_profit: 0.15,
        notes: 'Mochbot: TP1 Hit! Moved SL to Break-Even (0.125), targeting TP2 Runner (0.15)',
        notify: true,
      });

      // 4. Close trade sync (TP2 hit)
      const closeRes = await sync.closeTrade(updatedTrade, {
        type: 'tp2_hit',
        trade: updatedTrade,
        price: 0.15,
        message: 'Target 2 runner hit at 0.15',
        timestamp: 1200,
      } as any);
      expect(closeRes.ok).toBe(true);

      expect(calls.length).toBe(3);
      expect(calls[2].body).toEqual({
        action: 'close',
        symbol: 'KAIA_USDT',
        trade_id: 'mochex-uuid-999',
        exit_price: 0.15,
        closed_reason: 'tp_hit',
        notes: 'Target 2 runner hit at 0.15',
        notify: true,
      });
    });

    it('does not crash or throw if fetch fails or MOCHEX returns 500', async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error('Network timeout or DNS failure');
      });

      const sync = new MochexSync(db, {
        enabled: true,
        apiUrl: 'https://staging.ymatt.online',
        apiKey: 'tv_sec_test123',
        notify: true,
      });

      const tradeId = db.createTrade({
        symbol: 'KAIA_USDT',
        direction: 'SHORT',
        entry_price: 1.0,
        sl_price: 1.1,
        tp1_price: 0.8,
        tp2_price: 0.6,
        setup_id: 's-1',
        opened_at: 1000,
      });

      const trade = db.getTrade(tradeId)!;

      // None of these should throw
      const openRes = await sync.openTrade(trade);
      expect(openRes.ok).toBe(false);
      expect(openRes.error).toBe('Network timeout or DNS failure');

      const updateRes = await sync.updateTrade(trade, { stop_loss: 1.0 });
      expect(updateRes.ok).toBe(false);
      expect(updateRes.error).toBe('Network timeout or DNS failure');

      const closeRes = await sync.closeTrade(trade, {
        type: 'sl_hit',
        trade,
        price: 1.1,
        message: 'Stop loss hit',
        timestamp: 1050,
      } as any);
      expect(closeRes.ok).toBe(false);
      expect(closeRes.error).toBe('Network timeout or DNS failure');
    });
  });
});
