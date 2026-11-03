import { loadConfig } from './config.js';
import { Db } from './db/index.js';
import { Runner } from './engine/runner.js';
import { MexcWs } from './mexc/ws.js';
import { fetchContracts, fetchKlines, fetchTopVolumePerps, fetchTopMemePerps, fetchTopAiPerps, fetchTopGamePerps, fetchTopGainers, fetchTopLosers } from './mexc/rest.js';
import { DiscordNotifier, type Notifier } from './notify/discord.js';
import { TelegramNotifier } from './notify/telegram.js';
import { startWeb } from './web/server.js';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const cfg = loadConfig();
const db = new Db(cfg.dbPath);
const ws = new MexcWs();

const notifiers: Notifier[] = [];
let telegram: TelegramNotifier | null = null;
if (cfg.telegramToken && cfg.telegramChatId) {
  telegram = new TelegramNotifier(cfg.telegramToken, cfg.telegramChatId);
  notifiers.push(telegram);
}
if (cfg.discordWebhook) notifiers.push(new DiscordNotifier(cfg.discordWebhook));

const runner = new Runner({
  cfg,
  db,
  feed: ws,
  fetchKlines: (s, bars, interval = 'Min1') => fetchKlines(s, interval, bars),
  fetchContracts,
  fetchTopVolumePerps,
  fetchTopMemePerps,
  fetchTopAiPerps,
  fetchTopGamePerps,
  fetchTopGainers,
  fetchTopLosers,
  notifiers,
});

ws.on('kline', (symbol, c) => runner.onKline(symbol, c));
ws.on('reconnect', () => {
  console.log('ws reconnected: resyncing history');
  void runner.resyncAll();
});
ws.on('error_log', e => console.log('ws error:', (e as Error).message));

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..', 'web');
startWeb(runner, db, cfg, webDir);

ws.start();
await runner.start();

if (telegram) telegram.poll((cmd, args) => runner.handleCommand(cmd, args), e => console.log('telegram poll error:', (e as Error).message));

console.log(
  `mochbot up | mode=${cfg.paperMode ? 'PAPER (alerts logged, not sent)' : 'LIVE'} | channels=${notifiers.map(n => n.name).join(',') || 'none'} | dashboard :${cfg.port}`,
);

const shutdown = () => {
  runner.stop();
  ws.stop();
  telegram?.stop();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('uncaughtException', err => {
  console.error('[FATAL] uncaughtException:', err);
});
process.on('unhandledRejection', err => {
  console.error('[FATAL] unhandledRejection:', err);
});
