import {describe,it,expect,vi} from 'vitest';
import {evaluateTurtleSoup,validateTurtleConfig} from '../src/strategy/turtleSoup.js';
import {DEFAULT_TURTLE_CFG} from '../src/types.js';
import {turtleScenario,T0} from './fixtures.js';
import {Db} from '../src/db/index.js';
import {Runner} from '../src/engine/runner.js';
import {loadConfig} from '../src/config.js';
import {formatAlert} from '../src/notify/format.js';

describe('intraday Turtle Soup-inspired reversal',()=>{
 it('confirms a low sweep/reclaim before admitting a later boundary retest',()=>{
  const f=turtleScenario();
  const forming=evaluateTurtleSoup('X',f.candles.slice(0,74),f.candles[74],f.history);
  expect(forming.orderStatus).toBeUndefined();
  const pending=evaluateTurtleSoup('X',f.candles.slice(0,75),f.candles[75],f.history);
  expect(pending.stage).toBe('ARMED');expect(pending.direction).toBe('LONG');expect(pending.entry).toBe(100);
  expect(pending.sl!).toBeLessThan(99);expect(pending.tp1).toBe(105);expect(pending.tp2).toBe(110);
  expect(pending.expiresAt!-pending.ts).toBe(1800);expect(pending.orderNote).toContain('prior 20 completed 1H range');
  const touched=evaluateTurtleSoup('X',f.candles,null,f.history);
  expect(touched.stage).toBe('ENTRY_READY');expect(touched.setupId).toBe(pending.setupId);
  expect(formatAlert(pending)).toContain('PENDING LIMIT');expect(formatAlert(pending)).toContain('[TURTLE-SOUP]');
 });
 it('mirrors the pattern for shorts and rejects ambiguous two-sided sweeps',()=>{
  const f=turtleScenario(),invert=(c:typeof f.candles[number])=>({...c,o:210-c.o,h:210-c.l,l:210-c.h,c:210-c.c});
  const short=evaluateTurtleSoup('X',f.candles.map(invert),null,f.history.map(invert));
  expect(short.stage).toBe('ENTRY_READY');expect(short.direction).toBe('SHORT');expect(short.entry).toBe(110);
  expect(short.tp1).toBe(105);expect(short.tp2).toBe(100);
  const ambiguous=f.candles.slice(0,75).map(c=>c.t===T0+120?{...c,h:111}:c);
  expect(evaluateTurtleSoup('X',ambiguous,null,f.history).stage).not.toBe('ARMED');
 });
 it('expires orders, rejects stop/entry ambiguity and enforces reward filters',()=>{
  const f=turtleScenario(),prefix=f.candles.slice(0,75);
  const waiting=Array.from({length:31},(_,i)=>({t:T0+(5+i)*60,o:101,h:101,l:101,c:101,v:1}));
  expect(evaluateTurtleSoup('X',[...prefix,...waiting],null,f.history).orderStatus).toBe('EXPIRED');
  const invalid={t:T0+300,o:101,h:101,l:98,c:100,v:1};
  expect(evaluateTurtleSoup('X',[...prefix,invalid],null,f.history).orderStatus).toBe('INVALIDATED');
  expect(evaluateTurtleSoup('X',prefix,null,f.history,{...DEFAULT_TURTLE_CFG,minTp2R:100}).stage).not.toBe('ARMED');
 });
 it('freezes reference levels before the sweep and excludes future HTF candles',()=>{
  const f=turtleScenario(),prefix=f.candles.slice(0,75);
  const pending=evaluateTurtleSoup('X',prefix,null,f.history);
  const future=[...f.history,{t:T0,o:105,h:999,l:1,c:105,v:1}];
  expect(evaluateTurtleSoup('X',prefix,null,future)).toEqual(pending);
  expect(pending.turtleContext?.referenceLow).toBe(100);
  expect(evaluateTurtleSoup('X',prefix,null,f.history.slice(0,10)).reason).toContain('Warming up');
 });
 it('supports optional 50% reclaim-candle entry and validates configuration',()=>{
  const f=turtleScenario(),cfg={...DEFAULT_TURTLE_CFG,entryMode:'50% reclaim candle' as const};
  const pending=evaluateTurtleSoup('X',f.candles.slice(0,75),null,f.history,cfg);
  expect(pending.entry).toBe(100.5);expect(pending.orderNote).toContain('50% reclaim candle');
  expect(()=>validateTurtleConfig({lookbackBars:1})).toThrow();
  expect(()=>validateTurtleConfig({entryMode:'market' as any})).toThrow();
  expect(()=>validateTurtleConfig({timeframePreset:'1D/1H' as any})).toThrow();
  expect(()=>validateTurtleConfig({minTp2R:-1})).toThrow();
 });
 it('waits for a reclaim close and respects its configured deadline',()=>{
  const f=turtleScenario();
  const sweep=f.candles.slice(70,75).map(c=>({...c,c:99.5,l:Math.min(c.l,99.4)}));
  const prefix=[...f.candles.slice(0,70),...sweep];
  expect(evaluateTurtleSoup('X',prefix,null,f.history).stage).toBe('WATCH');
  const reclaim=f.candles.slice(75).map(c=>({...c,c:101,h:Math.max(c.h,101)}));
  expect(evaluateTurtleSoup('X',[...prefix,...reclaim],null,f.history).stage).toBe('ARMED');
  expect(evaluateTurtleSoup('X',[...prefix,...reclaim],null,f.history,{...DEFAULT_TURTLE_CFG,reclaimWindowBars:1}).stage).not.toBe('ARMED');
 });
 it('uses 4H reference bars and 15m confirmations for the slower preset',()=>{
  const f=turtleScenario(),candles=f.candles.flatMap(c=>Array.from({length:3},(_,i)=>({...c,t:T0+(c.t-T0)*3+i*60})));
  const history=f.history.map(c=>({...c,t:T0+(c.t-T0)*4}));
  const cfg={...DEFAULT_TURTLE_CFG,timeframePreset:'4H/15m' as const};
  const pending=evaluateTurtleSoup('X',candles.slice(0,225),candles[225],history,cfg);
  expect(pending.stage).toBe('ARMED');expect(pending.expiresAt!-pending.ts).toBe(90*60);
  expect(pending.orderNote).toContain('20 completed 4H range');expect(pending.ltfMinutes).toBe(15);
  expect(evaluateTurtleSoup('X',candles,null,history,cfg).stage).toBe('ENTRY_READY');
 });
 it('runs in ALL mode with a shared ledger and separate Turtle Soup trade statistics',async()=>{
  const f=turtleScenario(),clock=vi.spyOn(Date,'now').mockReturnValue((T0+300)*1000),db=new Db(':memory:');
  db.setGlobalStrategy('ALL');db.addWatch('X_USDT');
  const runner=new Runner({cfg:loadConfig({PAPER_MODE:'true',DB_PATH:':memory:'}),db,feed:{subscribe(){},unsubscribe(){}},
   fetchKlines:async(_s,_n,interval)=>interval==='Min60'?f.history:interval==='Hour4'?[]:f.candles.slice(0,75),fetchContracts:async()=>[],notifiers:[],log:()=>{}});
  try{
   await runner.start();expect(runner.strategyStates.get('X_USDT')?.size).toBe(8);
   expect(runner.strategyStates.get('X_USDT')?.get('TURTLE-SOUP')?.stage).toBe('ARMED');
   expect(db.listPendingLimitOrders()).toHaveLength(1);
   for(const c of f.candles.slice(75)){clock.mockReturnValue((c.t+60)*1000);runner.onKline('X_USDT',c)}
   const last=f.candles.at(-1)!;runner.onKline('X_USDT',{...last,t:last.t+60});
   expect(db.getActiveTrades()).toHaveLength(1);expect(db.getActiveTrades()[0].strategy_id).toBe('TURTLE-SOUP');
   expect(db.getPerformanceSummary('TURTLE-SOUP').openTrades).toBe(1);
   expect(db.listWatch()[0].strategy).toBe('ALL');
  }finally{runner.stop();db.close();clock.mockRestore()}
 });
});
