import {describe,it,expect,vi} from 'vitest';
import {ACTIVE_STRATEGIES,encodeStrategies,resolveStrategies,isStrategySelection} from '../src/types.js';
import {STRATEGY_RECOMMENDATIONS} from '../src/strategy/recommendations.js';
import {validateMod01eConfig} from '../src/strategy/mod01e.js';
import {validateEmaConfig} from '../src/strategy/emaPullback.js';
import {validateTurtleConfig} from '../src/strategy/turtleSoup.js';
import {isPackStrategy,validatePackConfig} from '../src/strategy/strategyPack.js';
import {packScenario} from './packFixtures.js';
import {Runner} from '../src/engine/runner.js';
import {Db} from '../src/db/index.js';
import {loadConfig} from '../src/config.js';

describe('arbitrary strategy combinations and starting presets',()=>{
 it('round-trips every nonempty combination in deterministic priority order',()=>{
  for(let bits=1;bits<2**ACTIVE_STRATEGIES.length;bits++){
   const ids=ACTIVE_STRATEGIES.filter((_,i)=>bits&(1<<i));
   const selection=encodeStrategies([...ids].reverse());
   expect(isStrategySelection(selection)).toBe(true);expect(resolveStrategies(selection)).toEqual(ids);
  }
  expect(encodeStrategies(['EMA-PULLBACK','MOD-01E'])).toBe('BOTH');
  expect(encodeStrategies(ACTIVE_STRATEGIES)).toBe('ALL');
  expect(resolveStrategies('MOD-01')).toEqual(['MOD-01E']);
 });
 it('rejects empty, unknown, duplicate and malformed selections',()=>{
  for(const input of [[],null,'ALL',['BAD'],['EMA-PULLBACK','EMA-PULLBACK']])expect(()=>encodeStrategies(input)).toThrow();
  for(const input of ['CUSTOM:','CUSTOM:MOD-01E,BAD','CUSTOM:MOD-01E,MOD-01E','CUSTOM:MOD-01E',[],null])expect(isStrategySelection(input)).toBe(false);
 });
 it('provides a complete valid starting preset for each of the eight strategies',()=>{
  expect(Object.keys(STRATEGY_RECOMMENDATIONS)).toEqual(ACTIVE_STRATEGIES);
  for(const id of ACTIVE_STRATEGIES){
   const r=STRATEGY_RECOMMENDATIONS[id];expect(r.summary.length).toBeGreaterThan(50);
   const validated=isPackStrategy(id)?validatePackConfig(id,r.config):id==='MOD-01E'?validateMod01eConfig(r.config):id==='EMA-PULLBACK'?validateEmaConfig(r.config):validateTurtleConfig(r.config);
   expect(validated).toEqual(r.config);
  }
 });
 it('runs only the chosen strategies across startup and invalidates only removed pending plans',async()=>{
  const f=packScenario('OPENING-RANGE'),clock=vi.spyOn(Date,'now').mockReturnValue((f.candles.at(-1)!.t+60)*1000),db=new Db(':memory:');
  const selection=encodeStrategies(['RSI-DIVERGENCE','OPENING-RANGE']);db.setGlobalStrategy(selection);db.addWatch('X_USDT');
  const deps={cfg:loadConfig({PAPER_MODE:'true',DB_PATH:':memory:'}),db,feed:{subscribe(){},unsubscribe(){}},fetchKlines:async(_s:string,_n:number,tf?:string)=>tf==='Min60'?f.history:tf==='Hour4'?[]:f.candles,fetchContracts:async()=>[],notifiers:[],log:()=>{}};
  let runner=new Runner(deps);
  try{
   await runner.start();expect([...runner.strategyStates.get('X_USDT')!.keys()]).toEqual(['OPENING-RANGE','RSI-DIVERGENCE']);expect(db.listPendingLimitOrders()).toHaveLength(1);
   runner.stop();runner=new Runner(deps);await runner.start();
   expect(db.getGlobalStrategy()).toBe(selection);expect([...runner.strategyStates.get('X_USDT')!.keys()]).toEqual(['OPENING-RANGE','RSI-DIVERGENCE']);
   db.updateWatch('X_USDT',{strategy:'RSI-DIVERGENCE'});runner.reEvaluateAll();
   expect(db.listPendingLimitOrders()).toHaveLength(0);expect(db.listLimitOrders()[0].status).toBe('INVALIDATED');
   expect([...runner.strategyStates.get('X_USDT')!.keys()]).toEqual(['RSI-DIVERGENCE']);
  }finally{runner.stop();db.close();clock.mockRestore()}
 });
});
