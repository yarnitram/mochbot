import type { Candle } from '../types.js';

const BASE = 'https://contract.mexc.com';

export interface ContractInfo {
  symbol: string;
  baseCoin: string;
  quoteCoin: string;
  priceUnit: number;
  state: number;
  maxLeverage?: number;
  contractSize?: number;
  minVol?: number;
}

export interface TickerInfo {
  symbol: string;
  amount24: number;
  volume24: number;
  lastPrice: number;
}

/** Parse MEXC kline response `{ data: { time:[], open:[], high:[], low:[], close:[], vol:[] } }` into candles. */
export function parseKlines(json: any): Candle[] {
  const d = json?.data;
  if (!d || !Array.isArray(d.time)) return [];
  const out: Candle[] = [];
  for (let i = 0; i < d.time.length; i++) {
    out.push({ t: Number(d.time[i]), o: Number(d.open[i]), h: Number(d.high[i]), l: Number(d.low[i]), c: Number(d.close[i]), v: Number(d.vol?.[i] ?? 0) });
  }
  return out.filter(c => [c.t, c.o, c.h, c.l, c.c].every(Number.isFinite)).sort((a, b) => a.t - b.t);
}

/** Parse a WS `push.kline` message. Returns null for other channels. */
export function parseWsKline(msg: any): { symbol: string; candle: Candle } | null {
  if (msg?.channel !== 'push.kline' || !msg.data) return null;
  const d = msg.data;
  const candle: Candle = { t: Number(d.t), o: Number(d.o), h: Number(d.h), l: Number(d.l), c: Number(d.c), v: Number(d.q ?? d.v ?? 0) };
  if (![candle.t, candle.o, candle.h, candle.l, candle.c].every(Number.isFinite)) return null;
  return { symbol: String(msg.symbol ?? d.symbol), candle };
}

export function parseContracts(json: any): ContractInfo[] {
  const arr = Array.isArray(json?.data) ? json.data : [];
  return arr
    .filter((c: any) => c && c.quoteCoin === 'USDT' && String(c.symbol).endsWith('_USDT') && c.state === 0)
    .map((c: any) => ({ symbol: c.symbol, baseCoin: c.baseCoin, quoteCoin: c.quoteCoin, priceUnit: Number(c.priceUnit) || 0, state: c.state, maxLeverage: Number(c.maxLeverage) || 50, contractSize: Number(c.contractSize) || 1, minVol: Number(c.minVol) || 1 }));
}

export function parseTopVolumeTickers(json: any, limit = 50): string[] {
  const arr: any[] = Array.isArray(json?.data) ? json.data : [];
  return arr
    .filter(t => t && typeof t.symbol === 'string' && t.symbol.endsWith('_USDT') && Number(t.amount24) > 0)
    .sort((a, b) => Number(b.amount24) - Number(a.amount24))
    .slice(0, limit)
    .map(t => String(t.symbol));
}

/** Simple serial rate limiter: at most `max` requests per `windowMs`. */
class Limiter {
  private stamps: number[] = [];
  constructor(private max: number, private windowMs: number) {}
  async take() {
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter(s => now - s < this.windowMs);
      if (this.stamps.length < this.max) {
        this.stamps.push(now);
        return;
      }
      await new Promise(r => setTimeout(r, this.windowMs - (now - this.stamps[0]) + 5));
    }
  }
}

const limiter = new Limiter(8, 2000); // MEXC allows 20 / 2s; stay well below

async function getJson(path: string): Promise<any> {
  await limiter.take();
  const res = await fetch(BASE + path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`MEXC ${path} -> HTTP ${res.status}`);
  const json: any = await res.json();
  if (json && json.success === false) throw new Error(`MEXC ${path} -> ${json.code} ${json.message ?? ''}`);
  return json;
}

const STEP_MAP: Record<string, number> = {
  Min1: 60,
  Min5: 300,
  Min15: 900,
  Min30: 1800,
  Min60: 3600,
  Hour1: 3600,
  Hour4: 14400,
  Hour8: 28800,
  Day1: 86400,
};

export async function fetchKlines(symbol: string, interval = 'Min1', bars = 1500): Promise<Candle[]> {
  const end = Math.floor(Date.now() / 1000);
  const step = STEP_MAP[interval] ?? 60;
  const start = end - bars * step;
  return parseKlines(await getJson(`/api/v1/contract/kline/${encodeURIComponent(symbol)}?interval=${interval}&start=${start}&end=${end}`));
}

export async function fetchContracts(): Promise<ContractInfo[]> {
  return parseContracts(await getJson('/api/v1/contract/detail'));
}

export async function fetchTopVolumePerps(limit = 50): Promise<string[]> {
  return parseTopVolumeTickers(await getJson('/api/v1/contract/ticker'), limit);
}

export const KNOWN_MEME_BASES = new Set([
  'DOGE', 'SHIB', 'PEPE', 'FLOKI', 'BONK', '1000BONK', 'WIF', 'BOME', 'MEME',
  'POPCAT', 'MEW', 'BRETT', 'NEIRO', 'TURBO', 'SUNDOG', 'MOODENG', 'GOAT',
  'PNUT', 'ACT', 'LUCE', 'CHILLGUY', 'FARTCOIN', 'PENGU', 'SPX', 'CAT', 'USELESS',
  'KIMCHI', 'CASHCAT', 'GIGGLE', 'STONK', 'TUT', 'SI', 'PEOPLE', 'ANSEM', 'RT'
]);

export function parseTopMemeTickers(contractJson: any, tickerJson: any, limit = 50): string[] {
  const contracts: any[] = Array.isArray(contractJson?.data) ? contractJson.data : [];
  const tickers: any[] = Array.isArray(tickerJson?.data) ? tickerJson.data : [];

  const memeSymbols = new Set<string>();
  for (const c of contracts) {
    if (!c || c.quoteCoin !== 'USDT' || c.state !== 0 || !String(c.symbol).endsWith('_USDT')) continue;
    const plates: string[] = Array.isArray(c.conceptPlate) ? c.conceptPlate : [];
    const isMemePlate = plates.some(p => typeof p === 'string' && p.toLowerCase().includes('meme'));
    const base = String(c.baseCoin || '').toUpperCase();
    const sym = String(c.symbol || '').toUpperCase();
    const isKnownMeme = KNOWN_MEME_BASES.has(base) || sym.includes('DOGE') || sym.includes('PEPE') || sym.includes('SHIB');
    if (isMemePlate || isKnownMeme) {
      memeSymbols.add(c.symbol);
    }
  }

  const tickerMap = new Map<string, number>();
  for (const t of tickers) {
    if (t?.symbol && Number(t.amount24) > 0) {
      tickerMap.set(t.symbol, Number(t.amount24));
    }
  }

  return Array.from(memeSymbols)
    .sort((a, b) => (tickerMap.get(b) ?? 0) - (tickerMap.get(a) ?? 0))
    .slice(0, limit);
}

export async function fetchTopMemePerps(limit = 50): Promise<string[]> {
  const [detailJson, tickerJson] = await Promise.all([
    getJson('/api/v1/contract/detail'),
    getJson('/api/v1/contract/ticker'),
  ]);
  return parseTopMemeTickers(detailJson, tickerJson, limit);
}

export const KNOWN_AI_BASES = new Set([
  'FET', 'NEAR', 'RENDER', 'TAO', 'GRT', 'WLD', 'ICP', 'IO', 'ATH', 'ARKM',
  'TURBO', 'AI', 'AGIX', 'OCEAN', 'RNDR', 'SPEC', 'GLM', 'NMR', 'AIOZ', 'AKT',
  'NOS', 'VIRTUAL', 'LPT', 'RSS3', 'TRAC', 'ALI', 'PHB', 'DEAI', 'ORAI', 'COOKIE'
]);

export const KNOWN_GAME_BASES = new Set([
  'GALA', 'AXS', 'SAND', 'MANA', 'BEAM', 'ILV', 'PIXEL', 'PORTAL', 'RON', 'YGG',
  'NOT', 'BIGTIME', 'ALICE', 'ENJ', 'APE', 'PRIME', 'SUPER', 'MAGIC', 'XAI',
  'HERO', 'ACE', 'MAVIA', 'DAR', 'SLP', 'TLM', 'FLOW', 'CHZ', 'WAXP'
]);

export function isAiPlate(p: string): boolean {
  if (typeof p !== 'string') return false;
  const s = p.toLowerCase();
  if (s.includes('mainly') || s.includes('tradfi')) return false;
  return s.includes('aiagent') || s.includes('aicompute') || s.includes('aistorage') ||
         s.includes('aicomputing') || s.includes('aisemi') || s.includes('aiapp') ||
         s.includes('aipower') || s === 'mc-trade-zone-ai' || s.endsWith('-ai') || s.includes('-ai-');
}

export function isGamePlate(p: string): boolean {
  if (typeof p !== 'string') return false;
  const s = p.toLowerCase();
  return s.includes('game') || s.includes('metaverse') || s.includes('play');
}

export function parseTopAiTickers(contractJson: any, tickerJson: any, limit = 50): string[] {
  const contracts: any[] = Array.isArray(contractJson?.data) ? contractJson.data : [];
  const tickers: any[] = Array.isArray(tickerJson?.data) ? tickerJson.data : [];

  const symbols = new Set<string>();
  for (const c of contracts) {
    if (!c || c.quoteCoin !== 'USDT' || c.state !== 0 || !String(c.symbol).endsWith('_USDT')) continue;
    // Exclude stock synthetics from crypto AI
    if (String(c.symbol).includes('STOCK_')) continue;
    const plates: string[] = Array.isArray(c.conceptPlate) ? c.conceptPlate : [];
    const isPlate = plates.some(isAiPlate);
    const base = String(c.baseCoin || '').toUpperCase();
    const isKnown = KNOWN_AI_BASES.has(base);
    if (isPlate || isKnown) symbols.add(c.symbol);
  }

  const tickerMap = new Map<string, number>();
  for (const t of tickers) {
    if (t?.symbol && Number(t.amount24) > 0) tickerMap.set(t.symbol, Number(t.amount24));
  }

  return Array.from(symbols)
    .sort((a, b) => (tickerMap.get(b) ?? 0) - (tickerMap.get(a) ?? 0))
    .slice(0, limit);
}

export function parseTopGameTickers(contractJson: any, tickerJson: any, limit = 50): string[] {
  const contracts: any[] = Array.isArray(contractJson?.data) ? contractJson.data : [];
  const tickers: any[] = Array.isArray(tickerJson?.data) ? tickerJson.data : [];

  const symbols = new Set<string>();
  for (const c of contracts) {
    if (!c || c.quoteCoin !== 'USDT' || c.state !== 0 || !String(c.symbol).endsWith('_USDT')) continue;
    if (String(c.symbol).includes('STOCK_')) continue;
    const plates: string[] = Array.isArray(c.conceptPlate) ? c.conceptPlate : [];
    const isPlate = plates.some(isGamePlate);
    const base = String(c.baseCoin || '').toUpperCase();
    const isKnown = KNOWN_GAME_BASES.has(base);
    if (isPlate || isKnown) symbols.add(c.symbol);
  }

  const tickerMap = new Map<string, number>();
  for (const t of tickers) {
    if (t?.symbol && Number(t.amount24) > 0) tickerMap.set(t.symbol, Number(t.amount24));
  }

  return Array.from(symbols)
    .sort((a, b) => (tickerMap.get(b) ?? 0) - (tickerMap.get(a) ?? 0))
    .slice(0, limit);
}

export function parseTopGainers(tickerJson: any, minVolumeUsd = 5_000_000, limit = 25): string[] {
  const tickers: any[] = Array.isArray(tickerJson?.data) ? tickerJson.data : [];
  return tickers
    .filter(t => t && typeof t.symbol === 'string' && t.symbol.endsWith('_USDT') && !t.symbol.includes('STOCK_') && Number(t.amount24) >= minVolumeUsd && Number(t.riseFallRate) > 0)
    .sort((a, b) => Number(b.riseFallRate) - Number(a.riseFallRate))
    .slice(0, limit)
    .map(t => String(t.symbol));
}

export function parseTopLosers(tickerJson: any, minVolumeUsd = 5_000_000, limit = 25): string[] {
  const tickers: any[] = Array.isArray(tickerJson?.data) ? tickerJson.data : [];
  return tickers
    .filter(t => t && typeof t.symbol === 'string' && t.symbol.endsWith('_USDT') && !t.symbol.includes('STOCK_') && Number(t.amount24) >= minVolumeUsd && Number(t.riseFallRate) < 0)
    .sort((a, b) => Number(a.riseFallRate) - Number(b.riseFallRate))
    .slice(0, limit)
    .map(t => String(t.symbol));
}

export async function fetchTopAiPerps(limit = 50): Promise<string[]> {
  const [detailJson, tickerJson] = await Promise.all([
    getJson('/api/v1/contract/detail'),
    getJson('/api/v1/contract/ticker'),
  ]);
  return parseTopAiTickers(detailJson, tickerJson, limit);
}

export async function fetchTopGamePerps(limit = 50): Promise<string[]> {
  const [detailJson, tickerJson] = await Promise.all([
    getJson('/api/v1/contract/detail'),
    getJson('/api/v1/contract/ticker'),
  ]);
  return parseTopGameTickers(detailJson, tickerJson, limit);
}

export async function fetchTopGainers(minVolumeUsd = 5_000_000, limit = 25): Promise<string[]> {
  const tickerJson = await getJson('/api/v1/contract/ticker');
  return parseTopGainers(tickerJson, minVolumeUsd, limit);
}

export async function fetchTopLosers(minVolumeUsd = 5_000_000, limit = 25): Promise<string[]> {
  const tickerJson = await getJson('/api/v1/contract/ticker');
  return parseTopLosers(tickerJson, minVolumeUsd, limit);
}
