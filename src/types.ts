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
export type StrategyId = 'MOD-01' | 'MOD-01D';

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
  ltfMinutes: 1,
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

export interface EntrySignal {
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
