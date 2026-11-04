import {describe,it,expect,vi} from 'vitest';
import {evaluateEmaPullback,validateEmaConfig} from '../src/strategy/emaPullback.js';
import {ema} from '../src/strategy/indicators.js';
import {DEFAULT_EMA_CFG} from '../src/types.js';
import {emaScenario,T0} from './fixtures.js';
import {Db} from '../src/db/index.js';
import {Runner} from '../src/engine/runner.js';
import {loadConfig} from '../src/config.js';
import {formatAlert} from '../src/notify/format.js';

describe('EMA pullback chronological sequence',()=>{
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
