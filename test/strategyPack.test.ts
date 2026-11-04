import {describe,it,expect,vi} from 'vitest';
import {PACK_DEFINITIONS,evaluatePackStrategy,packDefaults,validatePackConfig,rsi} from '../src/strategy/strategyPack.js';
import {ACTIVE_STRATEGIES,type Candle,type PackStrategyId} from '../src/types.js';
import {packScenario} from './packFixtures.js';
import {Db} from '../src/db/index.js';
import {Runner} from '../src/engine/runner.js';
import {loadConfig} from '../src/config.js';
import {formatAlert} from '../src/notify/format.js';

const ids=PACK_DEFINITIONS.map(d=>d.id);
const invert=(b:Candle):Candle=>({...b,o:200-b.o,c:200-b.c,h:200-b.l,l:200-b.h});
describe('five experimental strategy rule sets',()=>{
 for(const id of ids) {
  it(`${id}: confirms long and mirrored short resting limits without using forming candles`,()=>{
    const f=packScenario(id);
    const pending=evaluatePackStrategy(id,'X',f.candles,null,f.history);
    expect(pending.stage,JSON.stringify(pending)).toBe('ARMED');
    expect(pending.direction).toBe('LONG');expect(pending.entry!).toBeLessThan(pending.price);
    expect(pending.sl!).toBeLessThan(pending.entry!);expect(pending.tp1!).toBeGreaterThan(pending.entry!);expect(pending.tp2!).toBeGreaterThan(pending.tp1!);
    expect(pending.orderNote).toContain('win rate unverified');expect(formatAlert(pending)).toContain(`[${id}]`);
    const short=evaluatePackStrategy(id,'X',f.candles.map(invert),null,f.history.map(invert));
    expect(short.stage,JSON.stringify(short)).toBe('ARMED');expect(short.direction).toBe('SHORT');
    expect(short.entry!).toBeCloseTo(200-pending.entry!);expect(short.sl!).toBeGreaterThan(short.entry!);
    expect(short.tp2!).toBeLessThan(short.tp1!);
    const notClosed=evaluatePackStrategy(id,'X',f.candles.slice(0,-1),f.candles.at(-1)!,f.history);
    expect(notClosed.orderStatus).not.toBe('PENDING');expect(notClosed.orderStatus).not.toBe('TOUCHED');
  });
  it(`${id}: only touches after confirmation; invalidates stop ambiguity, gaps and expires untouched plans`,()=>{
    const f=packScenario(id),p=evaluatePackStrategy(id,'X',f.candles,null,f.history);
    expect(p.orderStatus,JSON.stringify(p)).toBe('PENDING');
    const end=f.candles.at(-1)!.t+60;
    const bar={t:end,o:p.price,h:p.price,l:p.entry!-.01,c:p.entry!+.05,v:100};
    const touched=evaluatePackStrategy(id,'X',[...f.candles,bar],null,f.history);
    expect(touched.orderStatus).toBe('TOUCHED');expect(touched.setupId).toBe(p.setupId);
    expect(evaluatePackStrategy(id,'X',[...f.candles,{...bar,l:p.sl!-.01}],null,f.history).orderStatus).toBe('INVALIDATED');
    expect(evaluatePackStrategy(id,'X',[...f.candles,{...bar,t:end+60}],null,f.history).orderStatus).toBe('INVALIDATED');
    const waiting=Array.from({length:31},(_,i)=>({t:end+i*60,o:p.price,h:p.price,l:p.price,c:p.price,v:1}));
    const expired=evaluatePackStrategy(id,'X',[...f.candles,...waiting],null,f.history);
    expect(expired.orderStatus,JSON.stringify(expired)).toBe('EXPIRED');
  });
  it(`${id}: enforces volume and stop filters, ignores future reference data and supports the slow preset`,()=>{
    const f=packScenario(id),cfg=packDefaults(id),p=evaluatePackStrategy(id,'X',f.candles,null,f.history);
    const future={t:f.candles.at(-1)!.t+3600,o:1,h:999,l:1,c:999,v:999};
    expect(evaluatePackStrategy(id,'X',f.candles,null,[...f.history,future])).toEqual(p);
    expect(evaluatePackStrategy(id,'X',f.candles,null,f.history,{...cfg,minVolumeRatio:10}).stage).not.toBe('ARMED');
    expect(evaluatePackStrategy(id,'X',f.candles,null,f.history,{...cfg,minStopPercent:10}).stage).not.toBe('ARMED');
    // Scale the complete timeline around midnight; ORB session/range settings scale too.
    const day=Math.floor(f.candles[0].t/86400)*86400;
    const slow=f.candles.flatMap(c=>Array.from({length:3},(_,j)=>({...c,t:day+(c.t-day)*3+j*60})));
    const history=f.history.map(c=>({...c,t:day+(c.t-day)*4}));
    const slowCfg={...cfg,timeframePreset:'4H/15m' as const,...(id==='OPENING-RANGE'?{sessionStartHourUTC:15,openingRangeMinutes:90,sessionWindowMinutes:540}:{})};
    if(id==='OPENING-RANGE') {
      // Preserve a valid 15:00 session inside the day: the fixture's first range starts 3h later than its first bar.
      const offset=-24*3600;
      for(const c of slow)c.t+=offset;
      for(const c of history)c.t+=offset;
    }
    const slowSetup=evaluatePackStrategy(id,'X',slow,null,history,slowCfg);
    expect(slowSetup.ltfMinutes).toBe(15);
    expect(slowSetup.orderStatus,JSON.stringify(slowSetup)).toBe('PENDING');
  });
 }
 it('requires a subsequent retest after breakouts and complete UTC history for VWAP',()=>{
   for(const id of ['OPENING-RANGE','BREAKOUT-RETEST'] as PackStrategyId[]) {
     const f=packScenario(id),s=evaluatePackStrategy(id,'X',f.candles.slice(0,-5),null,f.history);
     expect(s.stage).toBe('WATCH');expect(s.entry).toBeNull();
   }
   const f=packScenario('VWAP-RECLAIM');
   expect(evaluatePackStrategy('VWAP-RECLAIM','X',f.candles.slice(5),null,f.history).reason).toContain('00:00 UTC');
 });
 it('validates per-strategy fields, risk relationships and UTC session boundaries',()=>{
   for(const id of ids) {
     expect(validatePackConfig(id,{})).toEqual(packDefaults(id));
     for(const input of [{orderExpiry:0},{minStopAtr:4},{rrTP2:0},{minVolumeRatio:'2'},{unknown:1},{timeframePreset:'1D/1H'}])
       expect(()=>validatePackConfig(id,input as any)).toThrow();
   }
   expect(()=>validatePackConfig('OPENING-RANGE',{sessionStartHourUTC:23})).toThrow();
   expect(()=>validatePackConfig('OPENING-RANGE',{openingRangeMinutes:20})).toThrow();
   expect(()=>validatePackConfig('VWAP-RECLAIM',{lookbackBars:20})).toThrow();
   expect(()=>validatePackConfig('VWAP-RECLAIM',JSON.parse('{"constructor":1}'))).toThrow();
 });
 it('requires a neckline break for divergence and rejects fading a strong Bollinger context',()=>{
   const f=packScenario('RSI-DIVERGENCE');
   const noBreak=f.candles.map((b,i)=>i>=200?{...b,o:100.8,c:100.8,h:101,l:Math.min(b.l,100.8)}:b);
   expect(evaluatePackStrategy('RSI-DIVERGENCE','X',noBreak,null,f.history).stage).toBe('WATCH');
   const range=packScenario('BOLLINGER-RANGE'),trend=packScenario('BREAKOUT-RETEST').history;
   expect(evaluatePackStrategy('BOLLINGER-RANGE','X',range.candles,null,trend).reason).toContain('directional market');
 });
 it('uses neutral RSI for flat prices and Wilder extremes for monotone series',()=>{
   const f=packScenario('VWAP-RECLAIM').bars;
   expect(rsi(f.slice(0,20)).at(-1)).toBe(50);
   expect(rsi(f.slice(0,20).map((c,i)=>({...c,c:i+1}))).at(-1)).toBe(100);
   expect(rsi(f.slice(0,20).map((c,i)=>({...c,c:100-i}))).at(-1)).toBe(0);
 });
 it('runs all eight strategies and reserves one shared same-coin order across new strategies',async()=>{
   const f=packScenario('OPENING-RANGE'),now=f.candles.at(-1)!.t+60;
   const clock=vi.spyOn(Date,'now').mockReturnValue(now*1000),db=new Db(':memory:');
   db.setGlobalStrategy('ALL');db.addWatch('X_USDT');
   const runner=new Runner({cfg:loadConfig({PAPER_MODE:'true',DB_PATH:':memory:'}),db,feed:{subscribe(){},unsubscribe(){}},
     fetchKlines:async(_s,_n,tf)=>tf==='Min60'?f.history:tf==='Hour4'?[]:f.candles,fetchContracts:async()=>[],notifiers:[],log:()=>{}});
   try {
     await runner.start();expect([...runner.strategyStates.get('X_USDT')!.keys()]).toEqual(ACTIVE_STRATEGIES);
     expect(db.listPendingLimitOrders()).toHaveLength(1);
     expect(JSON.parse(db.listPendingLimitOrders()[0].payload).strategyId).toBe('OPENING-RANGE');
     expect(runner.strategyStates.get('X_USDT')?.get('BREAKOUT-RETEST')?.orderStatus).toBe('BLOCKED');
     const p=runner.strategyStates.get('X_USDT')!.get('OPENING-RANGE')!;
     clock.mockReturnValue((now+60)*1000);
     runner.onKline('X_USDT',{t:now,o:p.price,h:p.price,l:p.entry!-.01,c:p.entry!+.05,v:10});
     runner.onKline('X_USDT',{t:now+60,o:p.entry!+.05,h:p.entry!+.05,l:p.entry!+.05,c:p.entry!+.05,v:1});
     expect(db.getActiveTrades()).toHaveLength(1);expect(db.getActiveTrades()[0].strategy_id).toBe('OPENING-RANGE');
     expect(db.getPerformanceSummary('OPENING-RANGE').openTrades).toBe(1);
   }finally {runner.stop();db.close();clock.mockRestore()}
 });
 it('invalidates changed settings and preserves the strategy selection without reviving that plan on restart',async()=>{
   const f=packScenario('OPENING-RANGE'),now=f.candles.at(-1)!.t+60;
   const clock=vi.spyOn(Date,'now').mockReturnValue(now*1000),db=new Db(':memory:');
   db.setGlobalStrategy('OPENING-RANGE');db.addWatch('X_USDT');
   const deps={cfg:loadConfig({PAPER_MODE:'true',DB_PATH:':memory:'}),db,feed:{subscribe(){},unsubscribe(){}},
     fetchKlines:async(_s:string,_n:number,tf?:string)=>tf==='Min60'?f.history:tf==='Hour4'?[]:f.candles,fetchContracts:async()=>[],notifiers:[],log:()=>{}};
   let runner=new Runner(deps);
   try {
     await runner.start();expect(db.listPendingLimitOrders()).toHaveLength(1);
     db.setStrategyCfg('OPENING-RANGE',{...packDefaults('OPENING-RANGE'),orderExpiry:8});
     runner.reEvaluateAll();expect(db.listLimitOrders()[0].status).toBe('INVALIDATED');expect(db.listPendingLimitOrders()).toHaveLength(0);
     expect(runner.states.get('X_USDT')?.orderStatus).toBe('BLOCKED');
     runner.stop();runner=new Runner(deps);await runner.start();
     expect(db.listWatch()[0].strategy).toBe('OPENING-RANGE');expect(runner.packCfg('OPENING-RANGE').orderExpiry).toBe(8);
     expect(db.getActiveTrades()).toHaveLength(0);expect(db.listPendingLimitOrders()).toHaveLength(0);
   }finally{runner.stop();db.close();clock.mockRestore()}
 });
});
