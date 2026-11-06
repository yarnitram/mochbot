import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ACTIVE_STRATEGIES,DEFAULT_MOD01E_CFG,DEFAULT_EMA_CFG,DEFAULT_TURTLE_CFG} from '../src/types.js';
import {packDefaults} from '../src/strategy/strategyPack.js';

const source=readFileSync(join(process.cwd(),'pine/mochbot_strategy_lab.pine'),'utf8');
const input=(name:string)=>{
 const match=source.match(new RegExp('^(?:string|int|float|bool) '+name+' = input\\.(?:string|int|float|bool|timeframe)\\(([^,\\n]+),','m'));
 if(!match)throw Error('Missing Pine input '+name);
 return JSON.parse(match[1]);
};
// A cross-language settings contract: changing TS defaults must not silently leave Pine behind.
describe('Pine port settings contract (not a Pine compiler or strategy-performance test)',()=>{
 it('exposes every active model in the selector and uses standard 1m execution',()=>{
  const models=source.match(/string model = input\.string\([^\n]*options=(\[[^\]]+\])/);
  expect(JSON.parse(models![1])).toEqual(ACTIVE_STRATEGIES);
  expect(source.startsWith('//@version=6')).toBe(true);
  expect(source).toContain('timeframe.multiplier != 1');
  expect(source).toContain('not chart.is_standard');
  expect(source).toContain('calc_on_order_fills=false');
 });
 it('keeps MOD structure, Fibonacci, stop and expiry defaults aligned with the source',()=>{
  const expected={mBiasTf:String(DEFAULT_MOD01E_CFG.biasTfMinutes),mAlign:DEFAULT_MOD01E_CFG.alignTfMinutes,mEntry:DEFAULT_MOD01E_CFG.entryTfMinutes,
   mBiasPivot:DEFAULT_MOD01E_CFG.biasPivotLen,mAlignPivot:DEFAULT_MOD01E_CFG.alignPivotLen,mEntryPivot:DEFAULT_MOD01E_CFG.entryPivotLen,
   mRequireAlign:DEFAULT_MOD01E_CFG.requireAlignment,mBreak:DEFAULT_MOD01E_CFG.breakRule,mFib:DEFAULT_MOD01E_CFG.entryFib,
   mExpiry:DEFAULT_MOD01E_CFG.orderExpiry,mCancelBias:DEFAULT_MOD01E_CFG.cancelBiasFlip,mCancelChoch:DEFAULT_MOD01E_CFG.cancelNewChoch,
   mSessions:DEFAULT_MOD01E_CFG.useKillzone,mBuffer:DEFAULT_MOD01E_CFG.stopBufferAtr,mR1:DEFAULT_MOD01E_CFG.rrTP1,mR2:DEFAULT_MOD01E_CFG.rrTP2};
  for(const [name,value]of Object.entries(expected))expect(input(name),name).toEqual(value);
 });
 it('keeps EMA and Turtle configuration fields aligned with their bot defaults',()=>{
  const expected={eFast:DEFAULT_EMA_CFG.fastLength,eSlow:DEFAULT_EMA_CFG.slowLength,eWindow:DEFAULT_EMA_CFG.pullbackWindowBars,
   eRatio:DEFAULT_EMA_CFG.entryRatio,eExpiry:DEFAULT_EMA_CFG.orderExpiry,eBuffer:DEFAULT_EMA_CFG.stopBufferAtr,eR1:DEFAULT_EMA_CFG.rrTP1,eR2:DEFAULT_EMA_CFG.rrTP2,
   tLookback:DEFAULT_TURTLE_CFG.lookbackBars,tWindow:DEFAULT_TURTLE_CFG.reclaimWindowBars,tEntryMode:DEFAULT_TURTLE_CFG.entryMode,
   tSweep:DEFAULT_TURTLE_CFG.minSweepAtr,tBuffer:DEFAULT_TURTLE_CFG.stopBufferAtr,tR1:DEFAULT_TURTLE_CFG.minTp1R,tR2:DEFAULT_TURTLE_CFG.minTp2R,tExpiry:DEFAULT_TURTLE_CFG.orderExpiry};
  for(const [name,value]of Object.entries(expected))expect(input(name),name).toEqual(value);
 });
 it('keeps all five pack filters and model-specific starting values aligned',()=>{
  for(const id of ['OPENING-RANGE','BREAKOUT-RETEST','VWAP-RECLAIM','BOLLINGER-RANGE','RSI-DIVERGENCE']as const){
   const cfg=packDefaults(id),expected={pExpiry:cfg.orderExpiry,pBuffer:cfg.stopBufferAtr,pMinStop:cfg.minStopAtr,pMaxStop:cfg.maxStopAtr,pMinPct:cfg.minStopPercent};
   for(const [name,value]of Object.entries(expected))expect(input(name),id+':'+name).toEqual(value);
   expect(input(id==='BOLLINGER-RANGE'?'bbVolume':'pVolume')).toBe(cfg.minVolumeRatio);
   expect(input(id==='BOLLINGER-RANGE'?'bbR1':'pR1')).toBe(cfg.rrTP1);
   expect(input(id==='BOLLINGER-RANGE'?'bbR2':'pR2')).toBe(cfg.rrTP2);
  }
  const orb=packDefaults('OPENING-RANGE'),bb=packDefaults('BOLLINGER-RANGE'),rsi=packDefaults('RSI-DIVERGENCE'),b=packDefaults('BREAKOUT-RETEST');
  const expected={oHour:orb.sessionStartHourUTC,oOpening:orb.openingRangeMinutes,oSession:orb.sessionWindowMinutes,bWindow:b.retestWindowBars,bLookback:b.lookbackBars,bBuffer:b.breakoutBufferAtr,
   bbLength:bb.lookbackBars,bbDeviation:bb.bandDeviation,bbEfficiency:bb.maxRangeEfficiency,rPeriod:rsi.rsiPeriod,rPivot:rsi.pivotBars,rLookback:rsi.lookbackBars,rDifference:rsi.minRsiDivergence,rWindow:rsi.confirmationWindowBars};
  for(const [name,value]of Object.entries(expected))expect(input(name),name).toEqual(value);
 });
});
