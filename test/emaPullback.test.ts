import {describe,it,expect,vi} from 'vitest';
import {evaluateEmaPullback,validateEmaConfig} from '../src/strategy/emaPullback.js';
import {ema,aggregateClosed} from '../src/strategy/indicators.js';
import {DEFAULT_EMA_CFG} from '../src/types.js';
import {emaScenario,slowEmaScenario,T0} from './fixtures.js';
import {Db} from '../src/db/index.js';
import {Runner} from '../src/engine/runner.js';
import {loadConfig} from '../src/config.js';
import {formatAlert} from '../src/notify/format.js';

describe('EMA pullback chronological sequence',()=>{
 it('uses the slower preset for 4H trend, 1H pullback, 15m confirmation and 90-minute expiry',()=>{
  const f=slowEmaScenario(),cfg={...DEFAULT_EMA_CFG,timeframePreset:'4H/1H/15m' as const};
  const pullbacks=aggregateClosed(f.candles,60);
  const before=evaluateEmaPullback('X',f.candles.slice(0,3674),f.candles[3674],f.bias,cfg,pullbacks);
  expect(before.stage).toBe('WATCH');
  const pending=evaluateEmaPullback('X',f.candles.slice(0,3675),f.candles[3675],f.bias,cfg,pullbacks);
  expect(pending.stage).toBe('ARMED');expect(pending.entry).toBe(111);
  expect(pending.ltfMinutes).toBe(15);expect(pending.expiresAt!-pending.ts).toBe(90*60);
  expect(pending.orderNote).toContain('4H EMA');expect(pending.orderNote).toContain('1H EMA-zone pullback → 15m close');
  expect(pending.orderNote).toContain('6 × 15m bars (90 minutes)');
  const touch=evaluateEmaPullback('X',f.candles,null,f.bias,cfg,pullbacks);
  expect(touch.stage).toBe('ENTRY_READY');expect(touch.setupId).toBe(pending.setupId);
  expect(touch.emaTimeframes?.trendMinutes).toBe(240);
  const future=[...f.bias,{t:f.candles.at(-1)!.t+3600,o:1,h:2,l:.5,c:1,v:1}];
  expect(evaluateEmaPullback('X',f.candles,null,future,cfg,pullbacks).setupId).toBe(touch.setupId);
 });
 it('runs the slower preset using HTF backfills despite the 1500-minute rolling buffer',async()=>{
  const f=slowEmaScenario(),time=f.candles[3675].t;
  const clock=vi.spyOn(Date,'now').mockReturnValue(time*1000),db=new Db(':memory:');
  db.setGlobalStrategy('EMA-PULLBACK');db.addWatch('SLOW_USDT');
  db.setStrategyCfg('EMA-PULLBACK',{...DEFAULT_EMA_CFG,timeframePreset:'4H/1H/15m'});
  const fast=emaScenario();
  const previous=evaluateEmaPullback('SLOW_USDT',fast.candles.slice(0,920),fast.candles[920],fast.bias);
  db.saveLimitOrder({...previous,expiresAt:time+600});
  const runner=new Runner({cfg:loadConfig({PAPER_MODE:'true',DB_PATH:':memory:'}),db,feed:{subscribe(){},unsubscribe(){}},
    fetchKlines:async(_s,_n,interval)=>interval==='Hour4'?f.bias:interval==='Min60'?aggregateClosed(f.candles,60):f.candles.slice(0,3675),
    fetchContracts:async()=>[],notifiers:[],log:()=>{}});
  try{
   await runner.start();
   expect(runner.store.closed('SLOW_USDT')).toHaveLength(1500);
   expect(runner.states.get('SLOW_USDT')?.stage).toBe('ARMED');
   expect(runner.states.get('SLOW_USDT')?.emaTimeframes?.preset).toBe('4H/1H/15m');
   expect(db.listLimitOrders().find(o=>o.setup_id===previous.setupId)?.status).toBe('INVALIDATED');
   expect(db.listPendingLimitOrders()).toHaveLength(1);
  }finally{runner.stop();db.close();clock.mockRestore()}
 });
 it('requires enough completed EMA history and ignores a forming confirmation candle',()=>{
  const f=emaScenario();
  expect(evaluateEmaPullback('X',f.candles.slice(0,200),null,f.bias).stage).toBe('IDLE');
  expect(evaluateEmaPullback('X',f.candles.slice(0,919),f.candles[919],f.bias).stage).toBe('WATCH');
  expect(evaluateEmaPullback('X',f.candles.slice(0,920),f.candles[920],f.bias).stage).toBe('ARMED');
 });
 it('freezes a 50% confirmation retracement, subsequent touch, and 2R/3R targets',()=>{
  const f=emaScenario();
  const pending=evaluateEmaPullback('X',f.candles.slice(0,920),f.candles[920],f.bias);
  expect(pending.entry).toBe(111);
  expect(pending.orderStatus).toBe('PENDING');
  expect(pending.expiresAt!-pending.ts).toBe(1800);
  expect((pending.tp1!-pending.entry!)/(pending.entry!-pending.sl!)).toBeCloseTo(2);
  expect((pending.tp2!-pending.entry!)/(pending.entry!-pending.sl!)).toBeCloseTo(3);
  const touched=evaluateEmaPullback('X',f.candles,null,f.bias);
  expect(touched.stage).toBe('ENTRY_READY');expect(touched.setupId).toBe(pending.setupId);
  expect(touched.entry).toBe(pending.entry);expect(touched.sl).toBe(pending.sl);
  expect(formatAlert(pending)).toContain('50%');expect(formatAlert(touched)).toContain('TP1 (1:2)');
 });
 it('mirrors the setup for shorts',()=>{
  const f=emaScenario(),invert=(c:typeof f.candles[number])=>({...c,o:250-c.o,h:250-c.l,l:250-c.h,c:250-c.c});
  const short=evaluateEmaPullback('X',f.candles.map(invert),null,f.bias.map(invert));
  expect(short.stage).toBe('ENTRY_READY');expect(short.direction).toBe('SHORT');expect(short.entry).toBe(139);
  expect(short.sl!).toBeGreaterThan(short.entry!);expect(short.tp1!).toBeLessThan(short.entry!);
 });
 it('expires a limit after six bars and invalidates an ambiguous stop/entry minute',()=>{
  const f=emaScenario(),prefix=f.candles.slice(0,920);
  const flat=Array.from({length:31},(_,i)=>({t:T0+(920+i)*60,o:112,h:112,l:112,c:112,v:1}));
  expect(evaluateEmaPullback('X',[...prefix,...flat],null,f.bias).orderStatus).toBe('EXPIRED');
  const invalid={t:T0+920*60,o:112,h:113,l:100,c:110,v:1};
  expect(evaluateEmaPullback('X',[...prefix,invalid],null,f.bias).orderStatus).toBe('INVALIDATED');
 });
 it('cannot use future hourly candles to rewrite an earlier pending plan',()=>{
  const f=emaScenario(),prefix=f.candles.slice(0,920);
  const before=evaluateEmaPullback('X',prefix,f.candles[920],f.bias);
  const future=[...f.bias,{t:T0+920*60,o:10,h:11,l:9,c:10,v:1}];
  expect(evaluateEmaPullback('X',prefix,f.candles[920],future)).toEqual(before);
 });
 it('seeds EMA from completed closes and rejects invalid configuration',()=>{
  const c=[1,2,3,4].map((v,i)=>({t:i*60,o:v,h:v,l:v,c:v,v:1}));
  const values=ema(c,3);expect(Number.isNaN(values[1])).toBe(true);expect(values[2]).toBe(2);expect(values[3]).toBe(3);
  expect(()=>validateEmaConfig({fastLength:50,slowLength:20})).toThrow();
  expect(()=>validateEmaConfig({entryRatio:1})).toThrow();
  expect(()=>validateEmaConfig({orderExpiry:0})).toThrow();
  expect(()=>validateEmaConfig({timeframePreset:'1D/4H/1H' as any})).toThrow();
  expect(validateEmaConfig({})).toEqual(DEFAULT_EMA_CFG);
 });
 it('runs both strategies, preserves selection at startup, and tracks EMA separately',async()=>{
  const f=emaScenario(),now=f.candles[920].t;
  const clock=vi.spyOn(Date,'now').mockReturnValue(now*1000),db=new Db(':memory:');
  const cfg=loadConfig({PAPER_MODE:'true',DB_PATH:':memory:',USE_KILLZONE:'false'});
  db.setGlobalStrategy('BOTH');db.addWatch('X_USDT');
  const runner=new Runner({cfg,db,feed:{subscribe(){},unsubscribe(){}},fetchKlines:async(_s,_n,interval)=>interval==='Min60'?f.bias:interval==='Hour4'?[]:f.candles.slice(0,920),fetchContracts:async()=>[],notifiers:[],log:()=>{}});
  try{
   await runner.start();expect(db.getGlobalStrategy()).toBe('BOTH');expect(db.listWatch()[0].strategy).toBe('BOTH');
   expect(runner.strategyStates.get('X_USDT')?.size).toBe(2);
   expect(runner.strategyStates.get('X_USDT')?.get('EMA-PULLBACK')?.stage).toBe('ARMED');
   for(const c of f.candles.slice(920)){clock.mockReturnValue((c.t+60)*1000);runner.onKline('X_USDT',c)}
   runner.onKline('X_USDT',{...f.candles.at(-1)!,t:f.candles.at(-1)!.t+60});
   expect(db.getActiveTrades()).toHaveLength(1);expect(db.getActiveTrades()[0].strategy_id).toBe('EMA-PULLBACK');
   expect(db.getPerformanceSummary('EMA-PULLBACK').openTrades).toBe(1);
   expect(db.getPerformanceSummary('MOD-01E').openTrades).toBe(0);
   runner.evaluateSymbol('X_USDT');expect(db.getActiveTrades()).toHaveLength(1);
  }finally{runner.stop();db.close();clock.mockRestore()}
 });
});
