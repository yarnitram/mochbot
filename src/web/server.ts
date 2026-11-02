import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { Runner } from '../engine/runner.js';
import type { Db } from '../db/index.js';
import type { AppConfig } from '../config.js';

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

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
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };
  runner.on('state', d => push('state', d));
  runner.on('alert', d => push('alert', d));

  const snapshot = () => ({
    mode: cfg.paperMode ? 'paper' : 'live',
    killzone: runner.killzoneGlobal,
    muted: runner.muted,
    channels: { telegram: !!cfg.telegramToken, discord: !!cfg.discordWebhook },
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
      if (path === '/api/alerts' && req.method === 'GET') {
        return json(res, 200, db.recentAlerts(100).map(a => ({ ...a, payload: JSON.parse(a.payload) })));
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
        });
        return json(res, ok ? 200 : 404, { ok });
      }
      if (path === '/api/settings' && req.method === 'POST') {
        const b = await readBody(req);
        if (typeof b.killzone === 'boolean') runner.setKillzone(b.killzone);
        if (typeof b.muted === 'boolean') runner.setMuted(b.muted);
        return json(res, 200, snapshot());
      }
      if (path === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write('retry: 3000\n\n');
        clients.add(res);
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
