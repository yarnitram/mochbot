import type { StrategyCfg } from './types.js';
import { DEFAULT_CFG } from './types.js';

export interface AppConfig {
  paperMode: boolean;
  port: number;
  dbPath: string;
  dashboardPassword: string | null;
  telegramToken: string | null;
  telegramChatId: string | null;
  discordWebhook: string | null;
  accountCapital: number;
  defaultMargin: number;
  strategy: StrategyCfg;
  /** how many closed 1m candles to keep per symbol */
  historyBars: number;
  /** min seconds between evaluations of the same symbol on forming-candle ticks */
  evalThrottleSec: number;
}

function bool(v: string | undefined, d: boolean): boolean {
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}
function num(v: string | undefined, d: number): number {
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const sens = (env.SENSITIVITY ?? 'balanced').toLowerCase();
  return {
    paperMode: bool(env.PAPER_MODE, true),
    port: num(env.PORT, 8787),
    dbPath: env.DB_PATH || './data/bot.db',
    dashboardPassword: env.DASHBOARD_PASSWORD || null,
    telegramToken: env.TELEGRAM_BOT_TOKEN || null,
    telegramChatId: env.TELEGRAM_CHAT_ID || null,
    discordWebhook: env.DISCORD_WEBHOOK_URL || null,
    accountCapital: num(env.ACCOUNT_CAPITAL, 1000),
    defaultMargin: num(env.DEFAULT_MARGIN, 1),
    historyBars: num(env.HISTORY_BARS, 1500),
    evalThrottleSec: num(env.EVAL_THROTTLE_SEC, 2),
    strategy: {
      ...DEFAULT_CFG,
      ltfMinutes: num(env.LTF_MINUTES, 3),
      sensitivity: sens === 'strict' || sens === 'sensitive' ? sens : 'balanced',
      useKillzone: bool(env.USE_KILLZONE, DEFAULT_CFG.useKillzone),
      watchDistanceAtr: num(env.WATCH_DISTANCE_ATR, DEFAULT_CFG.watchDistanceAtr),
      maxBarsAfterTap: num(env.MAX_BARS_AFTER_TAP, DEFAULT_CFG.maxBarsAfterTap),
    },
  };
}
