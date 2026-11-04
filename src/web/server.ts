import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { Runner } from '../engine/runner.js';
import type { Db } from '../db/index.js';
import type { AppConfig } from '../config.js';
import { validateMod01eConfig } from '../strategy/mod01e.js';
import { markTrade } from '../engine/markTrade.js';
import { validateEmaConfig } from '../strategy/emaPullback.js';
import type { StrategySelection } from '../types.js';
const validSelection=(s:unknown):s is StrategySelection=>['MOD-01E','EMA-PULLBACK','BOTH'].includes(s as string);

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
    version: '1.0.0',
    strategy: db.getGlobalStrategy(),
    maxOpenRisk:runner.maxOpenRisk,
    strategyPerformance:['MOD-01E','EMA-PULLBACK'].map(id=>({id,...db.getPerformanceSummary(id)})),
    serverTime: Date.now(),
    limitOrders: db.listLimitOrders().map(o => {
      const payload = JSON.parse(o.payload);
      // Pending suggestions follow today's risk settings; terminal records keep their saved sizing.
      if (o.status === 'PENDING') payload.sizing = runner.sizeSetup(payload);
      return { ...o, payload };
    }),
    mode: cfg.paperMode ? 'paper' : 'live',
    killzone: runner.killzoneGlobal,
    muted: runner.muted,
    autoScanner: runner.autoScannerEnabled,
    memeScanner: runner.memeScannerEnabled,
    aiScanner: runner.aiScannerEnabled,
    gameScanner: runner.gameScannerEnabled,
    gainersScanner: runner.gainersScannerEnabled,
    losersScanner: runner.losersScannerEnabled,
    ultraLevScanner: runner.ultraLevScannerEnabled,
    minGainerVolume: runner.minGainerVolume,
    maxActiveCoins: runner.maxActiveCoins,
    minLeverage: runner.minLeverage,
    globalStrategy: db.getGlobalStrategy(),
    channels: { telegram: !!cfg.telegramToken, discord: !!cfg.discordWebhook },
    performance: db.getPerformanceSummary(),
    activeTrades: db.getActiveTrades().map(t => {
      const state = runner.states.get(t.symbol);
      const lastTick = runner.lastTick.get(t.symbol);
      const candleTime = (runner.store.forming(t.symbol) ?? runner.store.closed(t.symbol).at(-1))?.t;
      const quoteStatus = !state || !Number.isFinite(state.price) ? 'UNAVAILABLE' :
        lastTick && Date.now()-lastTick<=90_000 && candleTime && Date.now()/1000-candleTime<=180 ? 'LIVE' : 'STALE';
      return {
        ...t,
        ...markTrade(t,state?.price ?? null),
        quoteStatus,
        lastTick:lastTick ?? null,
        chartUrl: t.chart_file ? `/api/charts/${t.chart_file}` : null,
      };
    }),
    watchlist: db.listWatch().map(w => {
      const contract = runner.contracts.find(c => c.symbol === w.symbol);
      return {
        ...w,
        maxLeverage: contract?.maxLeverage ?? 50,
        state: runner.states.get(w.symbol) ?? null,
        setups:[...(runner.strategyStates.get(w.symbol)?.values()??[])],
        feed: {
          lastTick: runner.lastTick.get(w.symbol) ?? null,
          candleTime: (runner.store.forming(w.symbol) ?? runner.store.closed(w.symbol).at(-1))?.t ?? null,
          closedBars: runner.store.closed(w.symbol).length,
          error: runner.feedErrors.get(w.symbol) ?? null,
          status: runner.feedErrors.has(w.symbol) ? 'ERROR' : !runner.lastTick.has(w.symbol) ? 'CONNECTING' :
            Date.now() - runner.lastTick.get(w.symbol)! > 90_000 ? 'STALE' : 'LIVE',
        },
      };
    }),
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
      if (path === '/api/health' && req.method === 'GET') {
        const rows = snapshot().watchlist;
        const stale = rows.filter(w => w.feed.status !== 'LIVE').length;
        return json(res, 200, { status: stale ? 'degraded' : 'ok', watched: rows.length, stale, uptime: process.uptime() });
      }
      if (path === '/api/orders' && req.method === 'GET') return json(res, 200, snapshot().limitOrders);
      if (path === '/api/scanner/resync' && req.method === 'POST') {
        await runner.resyncAll();
        push('state_full', snapshot());
        return json(res, 200, { ok: true });
      }
      if (path === '/api/strategies' && req.method === 'GET') {
        return json(res, 200, {
          globalStrategy: db.getGlobalStrategy(),
          strategies: [
            {
              id: 'MOD-01E',
              name: 'MOD-01E: 1H–15m Alignment & 5m Fib Limit',
              description: '1H Bias + 15m Alignment + 15m CHoCH Dealing Range → 5m Limit Retest at 0.618 Fib OTE.',
              config: runner.mod01eCfg(''),
            },
            {id:'EMA-PULLBACK',name:'EMA Trend Pullback Limit',description:'1H EMA trend → 15m EMA-zone pullback → 5m confirmation → confirmation-candle retracement limit.',config:runner.emaCfg()},
          ],
        });
      }

            if (path === '/api/scanner/reset' && req.method === 'POST') {
        const scanned = await runner.runAutoScan();
        const stats = runner.reEvaluateAll();
        push('state_full', snapshot());
        return json(res, 200, { ok: true, scannedCount: scanned.length, ...stats });
      }

      if (path === '/api/strategies/settings' && req.method === 'POST') {
        const b = await readBody(req);
        if (b.globalStrategy && !validSelection(b.globalStrategy)) return json(res, 400, { error: 'Unsupported strategy selection' });
        let validated,validatedEma;
        try {
          if(b.mod01e)validated = validateMod01eConfig({ ...runner.mod01eCfg(''), ...b.mod01e });
          if(b.ema)validatedEma=validateEmaConfig({...runner.emaCfg(),...b.ema});
        }
        catch (e) { return json(res, 400, { error: (e as Error).message }); }
        if(validated){db.setStrategyCfg('MOD-01E', validated);runner.setKillzone(validated.useKillzone)}
        if(validatedEma)db.setStrategyCfg('EMA-PULLBACK',validatedEma);
        if(b.globalStrategy) {
          db.setGlobalStrategy(b.globalStrategy);
          if(b.applyToWatchlist===true)for(const w of db.listWatch())db.updateWatch(w.symbol,{strategy:b.globalStrategy});
        }
        runner.reEvaluateAll();
        push('state_full', snapshot());
        return json(res, 200, { ok: true });
      }

      const stratMatch = path.match(/^\/api\/strategies\/([A-Za-z0-9_\-]+)\/settings$/);
      if (stratMatch && req.method === 'POST') {
        const id = stratMatch[1].toUpperCase() as any;
        const b = await readBody(req);
        if (!['MOD-01E','EMA-PULLBACK'].includes(id)) return json(res, 400, { error: 'Unsupported strategy' });
        let validated;
        try { validated = id==='EMA-PULLBACK'?validateEmaConfig({...runner.emaCfg(),...b}):validateMod01eConfig({ ...runner.mod01eCfg(''), ...b }); }
        catch (e) { return json(res, 400, { error: (e as Error).message }); }
        db.setStrategyCfg(id, validated);
        if('useKillzone' in validated)runner.setKillzone(validated.useKillzone);
        runner.reEvaluateAll();
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

      if (path === '/api/trades/clear' && req.method === 'POST') {
        const b = await readBody(req);
        const purge = b.mode === 'delete' || b.mode === 'purge';
        const result = await runner.clearAllActiveTrades(purge);
        push('state_full', snapshot());
        return json(res, 200, { ok: true, count: result.count });
      }

      const tradeActionMatch = path.match(/^\/api\/trades\/(\d+)(?:\/(close|delete))?$/);
      if (tradeActionMatch && (req.method === 'POST' || req.method === 'DELETE')) {
        const tradeId = Number(tradeActionMatch[1]);
        const subAction = tradeActionMatch[2];
        const isDelete = req.method === 'DELETE' || subAction === 'delete';
        const result = await runner.closeActiveTrade(tradeId, isDelete);
        push('state_full', snapshot());
        return json(res, result.ok ? 200 : 400, result);
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
      if (path === '/api/system/reset' && req.method === 'POST') {
        const out = runner.resetAll();
        push('state_full', snapshot());
        return json(res, 200, { ok: true, ...out });
      }
      if (path === '/api/watchlist/clear' && req.method === 'POST') {
        const out = runner.clearWatchlist();
        push('state_full', snapshot());
        return json(res, 200, out);
      }
      if (path === '/api/watchlist' && req.method === 'POST') {
        const b = await readBody(req);
        if (!b.symbol) return json(res, 400, { error: 'symbol required' });
        const r = await runner.addSymbol(String(b.symbol));
        return json(res, r.ok ? 200 : 400, r);
      }
      const m = path.match(/^\/api\/watchlist\/([A-Za-z0-9_\-]+)$/);
      if (m && req.method === 'DELETE') {
        const out = runner.removeSymbol(m[1]);
        push('state_full', snapshot());
        return json(res, out.ok ? 200 : 400, { ...out, error:out.ok ? undefined : out.msg });
      }
      if (m && req.method === 'PATCH') {
        const b = await readBody(req);
        if(b.strategy!==undefined&&!validSelection(b.strategy))return json(res,400,{error:'Unsupported strategy'});
        const sym = runner.normalize(m[1]);
        const ok = db.updateWatch(sym, {
          killzone: b.killzone === undefined ? undefined : b.killzone === null ? null : !!b.killzone,
          sensitivity: b.sensitivity,
          watch_distance: b.watch_distance === undefined ? undefined : b.watch_distance === null ? null : Number(b.watch_distance),
          strategy: b.strategy,
        });
        if(b.strategy)await runner.backfillHtf(sym);
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
        if(b.max_open_risk!==undefined&&(!Number.isFinite(b.max_open_risk)||b.max_open_risk<=0))return json(res,400,{error:'Shared risk cap must be positive'});
        if (typeof b.killzone === 'boolean') runner.setKillzone(b.killzone);
        if (typeof b.muted === 'boolean') runner.setMuted(b.muted);
        const discoveryKeys = ['auto_scanner','meme_scanner','ai_scanner','game_scanner','gainers_scanner','losers_scanner','ultra_lev_scanner'];
        for (const key of discoveryKeys) if (typeof b[key] === 'boolean') db.setSetting(key, b[key] ? '1' : '0');
        if (typeof b.min_gainer_volume === 'number' && b.min_gainer_volume >= 0) runner.setMinGainerVolume(b.min_gainer_volume);
        if (typeof b.max_active_coins === 'number' && b.max_active_coins >= 10) runner.setMaxActiveCoins(b.max_active_coins);
        if (typeof b.min_leverage === 'number' && b.min_leverage >= 1) runner.setMinLeverage(b.min_leverage);
        if (validSelection(b.global_strategy)) db.setGlobalStrategy(b.global_strategy);
        if(b.max_open_risk!==undefined)db.setSetting('max_open_risk',String(b.max_open_risk));
        if (typeof b.account_capital === 'number' && b.account_capital > 0) db.setAccountCapital(b.account_capital);
        if (typeof b.default_margin === 'number' && b.default_margin > 0) db.setDefaultMargin(b.default_margin);
        if (typeof b.risk_per_trade === 'number' && b.risk_per_trade > 0) db.setRiskPerTrade(b.risk_per_trade);
        if (discoveryKeys.some(key => typeof b[key] === 'boolean') || b.max_active_coins !== undefined || b.min_leverage !== undefined || b.min_gainer_volume !== undefined) {
          runner.ensureAutoScanTimer();
          await runner.runAutoScan();
        }
        if (typeof b.killzone === 'boolean' || b.account_capital !== undefined || b.risk_per_trade !== undefined || b.max_open_risk!==undefined) runner.reEvaluateAll();
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
