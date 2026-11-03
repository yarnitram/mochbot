import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { Runner } from '../engine/runner.js';
import type { Db } from '../db/index.js';
import type { AppConfig } from '../config.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

function authOk(req: IncomingMessage, password: string | null): boolean {
  if (!password) return true;
  const h = req.headers.authorization;
  if (!h?.startsWith('Basic ')) return false;
  const given = Buffer.from(h.slice(6), 'base64').toString();
  const pass = given.slice(given.indexOf(':') + 1);
  const a = Buffer.from(pass);
  const b = Buffer.from(password);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64_000) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString();
  return raw ? JSON.parse(raw) : {};
}

export function startWeb(runner: Runner, db: Db, cfg: AppConfig, webDir: string) {
  const clients = new Set<ServerResponse>();
  const push = (event: string, data: unknown) => {
    let msg: string;
    try {
      msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    } catch {
      return;
    }
    for (const c of clients) {
      try {
        if (!c.writableEnded && c.writable) {
          c.write(msg, err => {
            if (err) clients.delete(c);
          });
        } else {
          clients.delete(c);
        }
      } catch {
        clients.delete(c);
      }
    }
  };
  runner.on('state', d => push('state', d));
  runner.on('alert', d => push('alert', d));
  runner.on('milestone', d => push('milestone', d));
  runner.lifecycle.on('trade_opened', d => push('trade_opened', d));
  runner.on('watchlist_updated', () => push('state_full', snapshot()));

  const snapshot = () => ({
    mode: cfg.paperMode ? 'paper' : 'live',
    killzone: runner.killzoneGlobal,
    muted: runner.muted,
    autoScanner: runner.autoScannerEnabled,
    memeScanner: runner.memeScannerEnabled,
    globalStrategy: db.getGlobalStrategy(),
    channels: { telegram: !!cfg.telegramToken, discord: !!cfg.discordWebhook },
    performance: db.getPerformanceSummary(),
    activeTrades: db.getActiveTrades().map(t => {
      const state = runner.states.get(t.symbol);
      const currentPrice = state?.price ?? t.entry_price;
      const isLong = t.direction === 'LONG';
      const risk = Math.abs(t.entry_price - t.sl_price) || 1;
      const currentR = isLong ? (currentPrice - t.entry_price) / risk : (t.entry_price - currentPrice) / risk;
      const notional = t.notional ?? ((t.margin ?? 1) * (t.leverage ?? 50));
      const slDistPct = risk / Math.max(1e-8, t.entry_price);
      const currentPnlUsd = currentR * (notional * slDistPct);
      return {
        ...t,
        currentPrice,
        currentR: Number(currentR.toFixed(2)),
        currentPnlUsd: Number(currentPnlUsd.toFixed(2)),
        chartUrl: t.chart_file ? `/api/charts/${t.chart_file}` : null,
      };
    }),
    watchlist: db.listWatch().map(w => ({ ...w, state: runner.states.get(w.symbol) ?? null })),
  });

  const server = createServer(async (req, res) => {
    try {
      if (!authOk(req, cfg.dashboardPassword)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="Mochbot"' });
        return res.end('Auth required');
      }
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname;

      if (path === '/api/state' && req.method === 'GET') return json(res, 200, snapshot());
      if (path === '/api/strategies' && req.method === 'GET') {
        return json(res, 200, {
          globalStrategy: db.getGlobalStrategy(),
          strategies: [
            {
              id: 'MOD-01',
              name: 'MOD-01: 15m POI → 1m CHoCH',
              description: 'Single-timeframe POI with 1m lower-timeframe confirmation break and ATR safety buffers.',
              config: db.getStrategyCfg('MOD-01'),
            },
            {
              id: 'MOD-01D',
              name: 'MOD-01D: Strict Top-Down Confirmation',
              description: '4H Bias → 1H Strict POI (liquidity sweep + displacement) → 15m Reaction CHoCH → 5m Entry CHoCH.',
              config: db.getStrategyCfg('MOD-01D'),
            },
          ],
        });
      }

            if (path === '/api/scanner/reset' && req.method === 'POST') {
        const stats = runner.reEvaluateAll();
        push('state_full', snapshot());
        return json(res, 200, { ok: true, ...stats });
      }

      if (path === '/api/strategies/settings' && req.method === 'POST') {
        const b = await readBody(req);
        if (b.globalStrategy && (b.globalStrategy === 'MOD-01' || b.globalStrategy === 'MOD-01D')) {
          db.setGlobalStrategy(b.globalStrategy);
        }
        if (b.mod01 && typeof b.mod01 === 'object') {
          db.setStrategyCfg('MOD-01', b.mod01);
        }
        if (b.mod01d && typeof b.mod01d === 'object') {
          db.setStrategyCfg('MOD-01D', b.mod01d);
        }
        runner.reEvaluateAll();
        push('state_full', snapshot());
        return json(res, 200, { ok: true });
      }

      const stratMatch = path.match(/^\/api\/strategies\/([A-Za-z0-9_\-]+)\/settings$/);
      if (stratMatch && req.method === 'POST') {
        const id = stratMatch[1].toUpperCase() as any;
        const b = await readBody(req);
        db.setStrategyCfg(id, b);
        push('state_full', snapshot());
        return json(res, 200, { ok: true, config: db.getStrategyCfg(id) });
      }

      if (path === '/api/alerts' && req.method === 'GET') {
        return json(res, 200, db.recentAlerts(100).map(a => ({ ...a, payload: JSON.parse(a.payload) })));
      }
      if (path === '/api/trades' && req.method === 'GET') {
        return json(res, 200, {
          active: db.getActiveTrades().map(t => ({
            ...t,
            chartUrl: t.chart_file ? `/api/charts/${t.chart_file}` : null,
          })),
          history: db.getTradeHistory(50).map(t => ({
            ...t,
            chartUrl: t.chart_file ? `/api/charts/${t.chart_file}` : null,
          })),
          performance: db.getPerformanceSummary(),
        });
      }

      // Coin Analytics & Journal
      if (path === '/api/analytics/coins' && req.method === 'GET') {
        const stratFilter = (url.searchParams.get('strategy') ?? 'ALL') as any;
        const list = db.getCoinAnalytics(stratFilter).map(c => ({
          ...c,
          currentStage: runner.states.get(c.symbol)?.stage ?? 'IDLE',
          currentPrice: runner.states.get(c.symbol)?.price ?? null,
        }));
        return json(res, 200, list);
      }

      const journalMatch = path.match(/^\/api\/journal\/([A-Za-z0-9_\-]+)$/);
      if (journalMatch && req.method === 'GET') {
        const sym = runner.normalize(journalMatch[1]);
        const data = db.getCoinJournal(sym);
        const enrichedTrades = data.trades.map(t => ({
          ...t,
          chartUrl: t.chart_file ? `/api/charts/${t.chart_file}` : null,
        }));
        return json(res, 200, {
          symbol: sym,
          stats: data.stats
            ? {
                ...data.stats,
                currentStage: runner.states.get(sym)?.stage ?? 'IDLE',
                currentPrice: runner.states.get(sym)?.price ?? null,
              }
            : null,
          trades: enrichedTrades,
          alerts: data.alerts.map(a => ({ ...a, payload: JSON.parse(a.payload) })),
        });
      }

      // Chart image serving
      const chartMatch = path.match(/^\/api\/charts\/([A-Za-z0-9_\-\.]+\.png)$/);
      if (chartMatch && req.method === 'GET') {
        const filename = chartMatch[1];
        if (filename.includes('..') || !runner.chartsDir) return json(res, 400, { error: 'invalid chart path' });
        try {
          const img = await readFile(join(runner.chartsDir, filename));
          res.writeHead(200, {
            'content-type': 'image/png',
            'cache-control': 'public, max-age=86400',
          });
          return res.end(img);
        } catch {
          return json(res, 404, { error: 'chart not found' });
        }
      }

      if (path === '/api/symbols' && req.method === 'GET') {
        const q = (url.searchParams.get('q') ?? '').toUpperCase();
        const list = runner.contracts.filter(c => !q || c.symbol.includes(q)).slice(0, 30).map(c => c.symbol);
        return json(res, 200, list);
      }
      if (path === '/api/watchlist' && req.method === 'POST') {
        const b = await readBody(req);
        if (!b.symbol) return json(res, 400, { error: 'symbol required' });
        const r = await runner.addSymbol(String(b.symbol));
        return json(res, r.ok ? 200 : 400, r);
      }
      const m = path.match(/^\/api\/watchlist\/([A-Za-z0-9_\-]+)$/);
      if (m && req.method === 'DELETE') return json(res, 200, runner.removeSymbol(m[1]));
      if (m && req.method === 'PATCH') {
        const b = await readBody(req);
        const sym = runner.normalize(m[1]);
        const ok = db.updateWatch(sym, {
          killzone: b.killzone === undefined ? undefined : b.killzone === null ? null : !!b.killzone,
          sensitivity: b.sensitivity,
          watch_distance: b.watch_distance === undefined ? undefined : b.watch_distance === null ? null : Number(b.watch_distance),
          strategy: b.strategy,
        });
        if (b.strategy === 'MOD-01D') {
          void runner.backfillHtf(sym);
        }
        runner.evaluateSymbol(sym);
        push('state_full', snapshot());
        return json(res, ok ? 200 : 404, { ok });
      }

      // MOCHEX Trade Sync API
      if (path === '/api/mochex/config' && req.method === 'GET') {
        const c = runner.mochex.getConfig();
        const maskedKey = c.apiKey ? (c.apiKey.length > 8 ? `${c.apiKey.slice(0, 6)}...${c.apiKey.slice(-4)}` : '******') : null;
        return json(res, 200, {
          apiUrl: c.apiUrl,
          apiKey: maskedKey,
          hasKey: !!c.apiKey,
          enabled: c.enabled,
          notify: c.notify,
        });
      }

      if (path === '/api/mochex/config' && req.method === 'POST') {
        const b = await readBody(req);
        db.setMochexConfig({
          apiUrl: typeof b.apiUrl === 'string' ? b.apiUrl : undefined,
          apiKey: typeof b.apiKey === 'string' && b.apiKey !== '******' && !b.apiKey.includes('...') ? b.apiKey : undefined,
          enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
          notify: typeof b.notify === 'boolean' ? b.notify : undefined,
        });
        const updated = runner.mochex.getConfig();
        const maskedKey = updated.apiKey ? (updated.apiKey.length > 8 ? `${updated.apiKey.slice(0, 6)}...${updated.apiKey.slice(-4)}` : '******') : null;
        return json(res, 200, {
          ok: true,
          apiUrl: updated.apiUrl,
          apiKey: maskedKey,
          hasKey: !!updated.apiKey,
          enabled: updated.enabled,
          notify: updated.notify,
        });
      }

      if (path === '/api/mochex/test' && req.method === 'POST') {
        const b = await readBody(req);
        const testUrl = typeof b.apiUrl === 'string' ? b.apiUrl : undefined;
        let testKey = typeof b.apiKey === 'string' ? b.apiKey : undefined;
        if (testKey && (testKey === '******' || testKey.includes('...'))) {
          testKey = db.getMochexConfig(cfg.mochex).apiKey ?? undefined;
        }
        const result = await runner.mochex.testConnection(testUrl, testKey);
        return json(res, 200, result);
      }

      if (path === '/api/settings' && req.method === 'POST') {
        const b = await readBody(req);
        if (typeof b.killzone === 'boolean') runner.setKillzone(b.killzone);
        if (typeof b.muted === 'boolean') runner.setMuted(b.muted);
        if (typeof b.auto_scanner === 'boolean') runner.setAutoScanner(b.auto_scanner);
        if (typeof b.meme_scanner === 'boolean') runner.setMemeScanner(b.meme_scanner);
        if (b.global_strategy && (b.global_strategy === 'MOD-01' || b.global_strategy === 'MOD-01D')) db.setGlobalStrategy(b.global_strategy);
        if (typeof b.account_capital === 'number' && b.account_capital > 0) db.setAccountCapital(b.account_capital);
        if (typeof b.default_margin === 'number' && b.default_margin > 0) db.setDefaultMargin(b.default_margin);
        push('state_full', snapshot());
        return json(res, 200, snapshot());
      }
      if (path === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write('retry: 3000\n\n');
        clients.add(res);
        res.on('error', () => clients.delete(res));
        res.on('close', () => clients.delete(res));
        req.on('close', () => clients.delete(res));
        return;
      }

      // static
      const rel = path === '/' ? 'index.html' : normalize(path).replace(/^([/\\])+/, '');
      if (rel.includes('..')) return json(res, 400, { error: 'bad path' });
      try {
        const data = await readFile(join(webDir, rel));
        res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream' });
        return res.end(data);
      } catch {
        return json(res, 404, { error: 'not found' });
      }
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });

  const hb = setInterval(() => push('ping', Date.now()), 25_000);
  server.on('close', () => clearInterval(hb));
  server.listen(cfg.port, '0.0.0.0');
  return server;
}
