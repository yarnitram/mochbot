import {ACTIVE_STRATEGIES,type ActiveStrategyId,type Candle} from '../types.js';
import {evaluateMod01e,validateMod01eConfig} from '../strategy/mod01e.js';
import {evaluateEmaPullback,validateEmaConfig} from '../strategy/emaPullback.js';
import {evaluateTurtleSoup,validateTurtleConfig} from '../strategy/turtleSoup.js';
import {evaluatePackStrategy,isPackStrategy,validatePackConfig,packDefaults} from '../strategy/strategyPack.js';
import {Db,type TradeRow} from '../db/index.js';
import {LifecycleManager} from '../engine/lifecycle.js';
import {computePositionSizing} from '../strategy/sizing.js';
import {aggregateClosed} from '../strategy/indicators.js';
import {STRATEGY_RECOMMENDATIONS} from '../strategy/recommendations.js';

function replayEvaluator(id:ActiveStrategyId,symbol:string,settings:Record<string,unknown>,hourly:Candle[],fourHourly:Candle[]) {
 if(isPackStrategy(id)){
  const cfg=validatePackConfig(id,{...packDefaults(id),...settings});
  return (history:Candle[])=>evaluatePackStrategy(id,symbol,history,null,cfg.timeframePreset==='4H/15m'?fourHourly:hourly,cfg);
 }
 if(id==='EMA-PULLBACK'){
  const cfg=validateEmaConfig(settings),slow=cfg.timeframePreset==='4H/1H/15m';
  return (history:Candle[])=>evaluateEmaPullback(symbol,history,null,slow?fourHourly:hourly,cfg,slow?hourly:undefined);
 }
 if(id==='TURTLE-SOUP'){
  const cfg=validateTurtleConfig(settings);
  return (history:Candle[])=>evaluateTurtleSoup(symbol,history,null,cfg.timeframePreset==='4H/15m'?fourHourly:hourly,cfg);
 }
 const cfg=validateMod01eConfig(settings);
 return (history:Candle[])=>evaluateMod01e(symbol,history,null,cfg.biasTfMinutes===240?fourHourly:hourly,cfg);
}
export function validateCandles(data:Candle[]) {
 if(!Array.isArray(data)||!data.length)throw Error('Expected nonempty completed 1m candle array');
 data.forEach((c,i)=>{if(!c||![c.t,c.o,c.h,c.l,c.c,c.v].every(Number.isFinite)||c.t%60||c.l<=0||c.v<0||c.l>Math.min(c.o,c.c)||c.h<Math.max(c.o,c.c)||(i>0&&c.t<=data[i-1].t))throw Error('Invalid or unordered candle at '+i);});
}
export interface ReplayOptions {capital?:number;risk?:number;feeBps?:number;slippageBps?:number;preset?:'default'|'recommended';warmupBars?:number;historyBars?:number}
export function replay(data:Candle[],symbol:string,ids:readonly ActiveStrategyId[]=ACTIVE_STRATEGIES,options:ReplayOptions={}) {
 validateCandles(data);
 const {capital=1000,risk=5,feeBps=6,slippageBps=1,preset='default',warmupBars=0,historyBars=data.length}=options;
 if(!['default','recommended'].includes(preset)||!Number.isInteger(warmupBars)||warmupBars<0||warmupBars>=data.length||!Number.isInteger(historyBars)||historyBars<1)throw Error('Invalid replay preset or history window');
 const hourly=aggregateClosed(data,60),fourHourly=aggregateClosed(data,240);
 if(![capital,risk,feeBps,slippageBps].every(Number.isFinite)||capital<=0||risk<0.1||feeBps<0||slippageBps<0)throw Error('Invalid capital, risk or cost assumptions');
 let gaps=0;for(let i=1;i<data.length;i++)if(data[i].t-data[i-1].t!==60)gaps++;
 if(!ids.length||ids.some(id=>!ACTIVE_STRATEGIES.includes(id)))throw Error('Unknown strategy');
 return [...new Set(ids)].map(id=>{
  const db=new Db(':memory:'),life=new LifecycleManager(db),seen=new Set<string>(),plans=new Map<string,string>(),trades:TradeRow[]=[];
  life.on('milestone',ev=>{if(ev.trade.closed_at!==null)trades.push({...ev.trade});});
  try{
   const evaluate=replayEvaluator(id,symbol,preset==='recommended'?STRATEGY_RECOMMENDATIONS[id].config:{},hourly,fourHourly);
   for(let i=Math.max(0,warmupBars-45);i<data.length;i++){
    const candle=data[i];
    life.onPrice(symbol,candle);
    // Each evaluator filters reference candles by their completed close time.
    const s=evaluate(data.slice(Math.max(0,i+1-historyBars),i+1));
    if(i<warmupBars){if(s.setupId)seen.add(s.setupId);continue;}
    if(s.setupId&&s.orderStatus)plans.set(s.setupId,s.orderStatus);
    if(s.stage!=='ENTRY_READY'||!s.setupId||seen.has(s.setupId))continue;
    seen.add(s.setupId);
    if(db.getActiveTrades().length||!s.entry||!s.sl||!s.tp1||!s.tp2||!s.direction)continue;
    s.sizing=computePositionSizing(s.entry,s.sl,s.tp1,s.tp2,s.direction,capital,risk,50,1);
    if(s.sizing&&s.sizing.margin<=capital)life.onEntryReady(s);
   }
   const results=trades.map(t=>{
    const notional=t.notional??0;
    // Gross signed return implies the weighted exit notional for both partial legs.
    const exitNotional=notional+(t.direction==='LONG'?1:-1)*(t.pnl_usd??0);
    const estimatedCostUsd=(notional+exitNotional)*(feeBps+slippageBps)/10000;
    return {...t,estimatedCostUsd,netUsd:(t.pnl_usd??0)-estimatedCostUsd};
   });
   let equity=0,peak=0,drawdown=0;
   for(const t of results){equity+=t.netUsd;peak=Math.max(peak,equity);drawdown=Math.max(drawdown,peak-equity);}
   const wins=results.reduce((s,t)=>s+Math.max(0,t.netUsd),0),losses=results.reduce((s,t)=>s+Math.max(0,-t.netUsd),0);
   return {schemaVersion:1,strategy:id,symbol,bars:data.length-warmupBars,start:data[warmupBars].t,end:data.at(-1)!.t+60,gaps,
    assumptions:{capital,risk,feeBps,slippageBps,preset,warmupBars,historyBars,independentModels:true,entryBarExitsDeferred:true,fundingIncluded:false},
    plans:plans.size,orderStatuses:Object.fromEntries(['PENDING','TOUCHED','EXPIRED','INVALIDATED'].map(status=>[status,[...plans.values()].filter(v=>v===status).length])),
    closed:results.length,open:db.getActiveTrades(),netUsd:equity,winRate:results.length?results.filter(t=>t.netUsd>0).length/results.length:null,profitFactor:losses?wins/losses:null,maxDrawdownUsd:drawdown,
    averageGrossR:results.length?results.reduce((sum,t)=>sum+(t.pnl_r??0),0)/results.length:null,trades:results};
  }finally{db.close();}
 });
}
