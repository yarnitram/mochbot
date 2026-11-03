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

export interface StrategyCfg {
  sensitivity: Sensitivity;
  htfMinutes: number;
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
  /** unix seconds of evaluation */
  ts: number;
}
