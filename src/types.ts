export interface Candle {
  /** candle open time, unix seconds */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Stage = 'IDLE' | 'WATCH' | 'ARMED' | 'ENTRY_READY';
export type Direction = 'LONG' | 'SHORT';
export type Sensitivity = 'strict' | 'balanced' | 'sensitive';
export type OrderType = 'MARKET' | 'LIMIT' | 'TRIGGER_LIMIT';
export type PackStrategyId = 'OPENING-RANGE' | 'BREAKOUT-RETEST' | 'VWAP-RECLAIM' | 'BOLLINGER-RANGE' | 'RSI-DIVERGENCE' | 'ADAM-EVE' | 'HEAD-SHOULDERS' | 'QUASIMODO';
export type ActiveStrategyId = 'MOD-01E' | 'EMA-PULLBACK' | 'TURTLE-SOUP' | PackStrategyId;
export const ACTIVE_STRATEGIES: ActiveStrategyId[] = ['MOD-01E','EMA-PULLBACK','TURTLE-SOUP','OPENING-RANGE','BREAKOUT-RETEST','VWAP-RECLAIM','BOLLINGER-RANGE','RSI-DIVERGENCE','ADAM-EVE','HEAD-SHOULDERS','QUASIMODO'];
export const isActiveStrategy = (id: unknown): id is ActiveStrategyId => ACTIVE_STRATEGIES.includes(id as ActiveStrategyId);
export const isStrategySelection = (id: unknown): id is StrategySelection => {
  if(isActiveStrategy(id)||id==='BOTH'||id==='ALL')return true;
  if(typeof id!=='string'||!id.startsWith('CUSTOM:'))return false;
  const ids=id.slice(7).split(',');
  return ids.length>1&&ids.length<=ACTIVE_STRATEGIES.length&&new Set(ids).size===ids.length&&ids.every(isActiveStrategy);
};
export type StrategyId = 'MOD-01' | 'MOD-01D' | ActiveStrategyId;
export type StrategySelection = StrategyId | 'BOTH' | 'ALL' | `CUSTOM:${string}`;

/** Canonical catalog order also defines priority for simultaneous signals. */
export function resolveStrategies(selection:StrategySelection):ActiveStrategyId[] {
  if(selection==='ALL')return [...ACTIVE_STRATEGIES];
  if(selection==='BOTH')return ['MOD-01E','EMA-PULLBACK'];
  if(isActiveStrategy(selection))return [selection];
  if(isStrategySelection(selection)&&selection.startsWith('CUSTOM:')){
    const chosen=selection.slice(7).split(',');return ACTIVE_STRATEGIES.filter(id=>chosen.includes(id));
  }
  return ['MOD-01E'];
}
export function encodeStrategies(input:unknown):StrategySelection {
  if(!Array.isArray(input)||!input.length||input.length>ACTIVE_STRATEGIES.length||!input.every(isActiveStrategy)||new Set(input).size!==input.length)
    throw Error('Choose at least one valid strategy, without duplicates');
  const ids=ACTIVE_STRATEGIES.filter(id=>input.includes(id));
  if(ids.length===1)return ids[0];
  if(ids.length===ACTIVE_STRATEGIES.length)return 'ALL';
  if(ids.length===2&&ids[0]==='MOD-01E'&&ids[1]==='EMA-PULLBACK')return 'BOTH';
  return `CUSTOM:${ids.join(',')}`;
}

export interface TurtleSoupCfg {
  timeframePreset:'1H/5m'|'4H/15m';
  lookbackBars:number;
  reclaimWindowBars:number;
  entryMode:'Reclaimed level'|'50% reclaim candle';
  orderExpiry:number;
  minSweepAtr:number;
  stopBufferAtr:number;
  minTp1R:number;
  minTp2R:number;
  watchDistanceAtr:number;
}
export const DEFAULT_TURTLE_CFG:TurtleSoupCfg={timeframePreset:'1H/5m',lookbackBars:20,reclaimWindowBars:3,
  entryMode:'Reclaimed level',orderExpiry:6,minSweepAtr:.1,stopBufferAtr:.2,minTp1R:1,minTp2R:2,watchDistanceAtr:1};

export interface EmaPullbackCfg {
  timeframePreset: '1H/15m/5m' | '4H/1H/15m';
  fastLength: number;
  slowLength: number;
  pullbackWindowBars: number;
  orderExpiry: number;
  entryRatio: number;
  stopBufferAtr: number;
  rrTP1: number;
  rrTP2: number;
}
export const DEFAULT_EMA_CFG: EmaPullbackCfg = {
  timeframePreset:'1H/15m/5m',
  fastLength:20, slowLength:50, pullbackWindowBars:6, orderExpiry:6,
  entryRatio:.5, stopBufferAtr:.2, rrTP1:2, rrTP2:3,
};

export interface Mod01dCfg {
  biasTfMinutes: number;
  locationTfMinutes: number;
  reactionTfMinutes: number;
  entryTfMinutes: number;
  biasPivotLen: number;
  locationPivotLen: number;
  reactionPivotLen: number;
  entryPivotLen: number;
  requireOneHourAlign: boolean;
  strictPoi: boolean;
  bodyAtr: number;
  maxReactionBars: number;
  maxEntryBars: number;
  useKillzone: boolean;
  stopMode: 'Reaction + POI boundary' | 'Reaction swing only';
  slBufferAtr: number;
  rrTP1: number;
  rrTP2: number;
  watchDistanceAtr: number;
}


export interface Mod01eCfg {
  biasTfMinutes: number;
  alignTfMinutes: number;
  entryTfMinutes: number;
  biasPivotLen: number;
  alignPivotLen: number;
  entryPivotLen: number;
  requireAlignment: boolean;
  breakRule: 'Body close' | 'Wick';
  entryFib: number;
  zoneNear: number;
  zoneFar: number;
  orderExpiry: number;
  cancelBiasFlip: boolean;
  cancelNewChoch: boolean;
  useKillzone: boolean;
  stopBufferAtr: number;
  rrTP1: number;
  rrTP2: number;
  watchDistanceAtr: number;
}

export const DEFAULT_MOD01E_CFG: Mod01eCfg = {
  biasTfMinutes: 60,
  alignTfMinutes: 15,
  entryTfMinutes: 5,
  biasPivotLen: 5,
  alignPivotLen: 5,
  entryPivotLen: 3,
  requireAlignment: true,
  breakRule: 'Body close',
  entryFib: 0.618,
  zoneNear: 0.5,
  zoneFar: 1.0,
  orderExpiry: 18,
  cancelBiasFlip: true,
  cancelNewChoch: true,
  useKillzone: true,
  stopBufferAtr: 0.15,
  rrTP1: 3.0,
  rrTP2: 5.0,
  watchDistanceAtr: 1.0,
};

export const DEFAULT_MOD01D_CFG: Mod01dCfg = {
  biasTfMinutes: 240,
  locationTfMinutes: 60,
  reactionTfMinutes: 15,
  entryTfMinutes: 5,
  biasPivotLen: 3,
  locationPivotLen: 3,
  reactionPivotLen: 2,
  entryPivotLen: 3,
  requireOneHourAlign: true,
  strictPoi: true,
  bodyAtr: 0.35,
  maxReactionBars: 12,
  maxEntryBars: 30,
  useKillzone: false,
  stopMode: 'Reaction + POI boundary',
  slBufferAtr: 0.20,
  rrTP1: 3.0,
  rrTP2: 5.0,
  watchDistanceAtr: 1.0,
};

export interface StrategyCfg {
  sensitivity: Sensitivity;
  htfMinutes: number;
  ltfMinutes?: number;
  ltfSwingLen: number;
  maxBarsAfterTap: number;
  fvgAtrMult: number;
  slBufferAtr: number;
  rrTP1: number;
  rrTP2: number;
  maxActivePois: number;
  useKillzone: boolean;
  /** Watch stage fires when price is within this many HTF ATRs of a POI */
  watchDistanceAtr: number;
  /** An Entry-ready setup stays "ready" for this many closed LTF bars */
  entryValidBars: number;
  tickSize: number;
}

export const DEFAULT_CFG: StrategyCfg = {
  sensitivity: 'balanced',
  htfMinutes: 15,
  ltfMinutes: 3,
  ltfSwingLen: 3,
  maxBarsAfterTap: 25,
  fvgAtrMult: 0.3,
  slBufferAtr: 0.2,
  rrTP1: 3,
  rrTP2: 5,
  maxActivePois: 6,
  useKillzone: true,
  watchDistanceAtr: 1.0,
  entryValidBars: 3,
  tickSize: 1e-8,
};

export interface Zone {
  id: string;
  isDemand: boolean;
  top: number;
  bottom: number;
  /** time (sec) of the exact base candle */
  startTime: number;
  /** time (sec) the zone became known (new HTF bar) */
  createdTime: number;
  invalidated: boolean;
  mitigated: boolean;
}

export interface LimitContext {
  biasMinutes: number;
  chochMinutes: number;
  expiryBarMinutes: number;
  expiryBars: number;
  fibRatio: number;
  fibZero: number;
  fibOne: number;
  confirmedAt: number;
  breakRule: Mod01eCfg['breakRule'];
}

export interface EntrySignal {
  limitContext?: LimitContext;
  direction: Direction;
  barIndex: number;
  time: number;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  zoneId: string;
  zoneStartTime: number;
  inKillzone: boolean;
}

export interface PositionSizing {
  accountCapital: number;
  riskPerTrade: number;
  margin: number;
  leverage: number;
  notional: number;
  qtyCoins: number;
  qtyContracts: number;
  slRiskUsd: number;
  tp1ProfitUsd: number;
  tp2ProfitUsd: number;
  estLiqPrice: number;
}

export interface Setup {
  packContext?: {referenceMinutes:number;confirmationMinutes:number;configKey:string;confirmedAt:number};
  turtleContext?:{rangeMinutes:number;confirmationMinutes:number;referenceHigh:number;referenceLow:number;rangeEnd:number;sweepExtreme:number;reclaimedAt:number};
  emaTimeframes?: {trendMinutes:number;pullbackMinutes:number;confirmationMinutes:number;preset:EmaPullbackCfg['timeframePreset']};
  limitContext?: LimitContext;
  reason?: string;
  orderStatus?: 'PENDING' | 'TOUCHED' | 'EXPIRED' | 'INVALIDATED' | 'BLOCKED';
  expiresAt?: number;
  symbol: string;
  stage: Stage;
  direction: Direction | null;
  setupId: string | null;
  price: number;
  zone: { top: number; bottom: number; startTime: number } | null;
  /** distance from price to zone in HTF ATRs (0 when inside) */
  distanceAtr: number | null;
  /** level a LTF candle must CLOSE beyond for CHoCH (ARMED stage) */
  needBreak: number | null;
  barsSinceTap: number | null;
  entry: number | null;
  sl: number | null;
  tp1: number | null;
  tp2: number | null;
  orderType: OrderType | null;
  orderNote: string | null;
  killzone: boolean;
  atrHtf: number | null;
  atrLtf: number | null;
  sizing?: PositionSizing | null;
  strategyId?: StrategyId;
  ltfMinutes?: number;
  /** unix seconds of evaluation */
  ts: number;
}
