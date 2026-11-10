import { describe, it, expect, vi, afterEach } from 'vitest';
import { Db } from '../src/db/index.js';
import { DiscordNotifier } from '../src/notify/discord.js';
import { startWeb } from '../src/web/server.js';
import { Runner } from '../src/engine/runner.js';
import { loadConfig } from '../src/config.js';
import { once } from 'node:events';
import { join } from 'node:path';

describe('MOCHEX and Discord Integrations Settings', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('Database Discord configuration', () => {
    it('defaults to disabled or env webhook if set', () => {
      const db = new Db(':memory:');
      const cfg1 = db.getDiscordConfig(null);
      expect(cfg1.webhookUrl).toBeNull();
      expect(cfg1.enabled).toBe(false);

      const cfg2 = db.getDiscordConfig('https://discord.com/api/webhooks/123/abc');
      expect(cfg2.webhookUrl).toBe('https://discord.com/api/webhooks/123/abc');
      expect(cfg2.enabled).toBe(true);
    });

    it('persists and updates Discord config in SQLite', () => {
      const db = new Db(':memory:');
      db.setDiscordConfig({ webhookUrl: 'https://discord.com/api/webhooks/456/def', enabled: true });
      let cfg = db.getDiscordConfig(null);
      expect(cfg.webhookUrl).toBe('https://discord.com/api/webhooks/456/def');
      expect(cfg.enabled).toBe(true);

      db.setDiscordConfig({ enabled: false });
      cfg = db.getDiscordConfig(null);
      expect(cfg.webhookUrl).toBe('https://discord.com/api/webhooks/456/def');
      expect(cfg.enabled).toBe(false);
    });
  });

  describe('DiscordNotifier testWebhook and sendText', () => {
    it('rejects invalid or non-discord webhook URLs', async () => {
      const r1 = await DiscordNotifier.testWebhook('');
      expect(r1.ok).toBe(false);
      expect(r1.error).toContain('Missing');

      const r2 = await DiscordNotifier.testWebhook('https://example.com/webhook');
      expect(r2.ok).toBe(false);
      expect(r2.error).toContain('Invalid Discord webhook URL');
    });

    it('successfully tests valid Discord webhook', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        statusText: 'No Content',
      }) as any;

      const res = await DiscordNotifier.testWebhook('https://discord.com/api/webhooks/123/test');
      expect(res.ok).toBe(true);
      expect(res.status).toBe(204);
    });

    it('dispatches milestone sendText', async () => {
      let sentBody = '';
      globalThis.fetch = vi.fn().mockImplementation((_url: string, opts: any) => {
        sentBody = opts.body;
        return Promise.resolve({ ok: true });
      }) as any;

      const notifier = new DiscordNotifier('https://discord.com/api/webhooks/123/test', true);
      await notifier.sendText('🎯 TAKE PROFIT 1 HIT: BTC_USDT\nSecured 50% profit');
      expect(sentBody).toContain('TAKE PROFIT 1 HIT');
      const parsed = JSON.parse(sentBody);
      expect(parsed.embeds[0].color).toBe(0x22c55e); // green for TP
    });
  });

  describe('Web Server Settings API integration', () => {
    it('provides endpoints to view, save, and test MOCHEX and Discord settings', async () => {
      const db = new Db(':memory:');
      const cfg = loadConfig({ PORT: '0', DASHBOARD_PASSWORD: 'pass', PAPER_MODE: 'true' });
      const runner = new Runner({
        cfg,
        db,
        feed: { subscribe() {}, unsubscribe() {} },
        fetchKlines: async () => [],
        fetchContracts: async () => [],
        notifiers: [],
      });
      const server = startWeb(runner, db, cfg, join(process.cwd(), 'web'));
      await once(server, 'listening');
      const address = server.address() as { port: number };
      const url = `http://127.0.0.1:${address.port}`;
      const headers = {
        authorization: `Basic ${Buffer.from('admin:pass').toString('base64')}`,
        'content-type': 'application/json',
      };

      try {
        // Check HTML contains MOCHEX and Discord forms
        const html = await (await fetch(url, { headers })).text();
        expect(html).toContain('id="mochex-form"');
        expect(html).toContain('id="discord-form"');
        expect(html).toContain('id="test-mochex-btn"');
        expect(html).toContain('id="test-discord-btn"');

        // Test Discord config API
        const discordGet = await (await fetch(`${url}/api/discord/config`, { headers })).json() as any;
        expect(discordGet.hasWebhook).toBe(false);

        const discordPost = await (await fetch(`${url}/api/discord/config`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ webhookUrl: 'https://discord.com/api/webhooks/999/tok', enabled: true }),
        })).json() as any;
        expect(discordPost.ok).toBe(true);
        expect(discordPost.hasWebhook).toBe(true);
        expect(discordPost.enabled).toBe(true);
        expect(db.getDiscordConfig().webhookUrl).toBe('https://discord.com/api/webhooks/999/tok');

        // Test MOCHEX config API
        const mochexGet = await (await fetch(`${url}/api/mochex/config`, { headers })).json() as any;
        expect(mochexGet.apiUrl).toBeTruthy();

        const mochexPost = await (await fetch(`${url}/api/mochex/config`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ apiUrl: 'https://staging.ymatt.online/api/trades/webhook', apiKey: 'sec_123456789', enabled: true, notify: true }),
        })).json() as any;
        expect(mochexPost.ok).toBe(true);
        expect(mochexPost.hasKey).toBe(true);
        expect(mochexPost.enabled).toBe(true);
        expect(runner.mochex.getConfig().apiKey).toBe('sec_123456789');

        // State snapshot channels reflect updated status
        const state = await (await fetch(`${url}/api/state`, { headers })).json() as any;
        expect(state.channels.discord).toBe(true);
        expect(state.channels.mochex).toBe(true);
      } finally {
        runner.stop();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        db.close();
      }
    });
  });
});
