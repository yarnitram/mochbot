import type {Candle,Direction,Setup,TurtleSoupCfg} from '../types.js';
import {DEFAULT_TURTLE_CFG} from '../types.js';
import {aggregateClosed,atr} from './indicators.js';

export function turtleTimeframes(cfg:TurtleSoupCfg){return cfg.timeframePreset==='4H/15m'?{rangeMinutes:240,confirmationMinutes:15}:{rangeMinutes:60,confirmationMinutes:5}}
const tf=(m:number)=>m%60===0?`${m/60}H`:`${m}m`;
export function validateTurtleConfig(input:Partial<TurtleSoupCfg>):TurtleSoupCfg{
 const cfg={...DEFAULT_TURTLE_CFG,...input};
 for(const [key,value]of Object.entries(cfg)){
  if(!(key in DEFAULT_TURTLE_CFG))throw Error(`Unknown Turtle Soup setting: ${key}`);
  if(key==='timeframePreset'){if(!['1H/5m','4H/15m'].includes(value as string))throw Error('Unsupported Turtle Soup preset');continue}
  if(key==='entryMode'){if(!['Reclaimed level','50% reclaim candle'].includes(value as string))throw Error('Unsupported Turtle Soup entry mode');continue}
  if(typeof value!=='number'||!Number.isFinite(value))throw Error(`Invalid Turtle Soup setting: ${key}`);
 }
 if(!Number.isInteger(cfg.lookbackBars)||cfg.lookbackBars<2||cfg.lookbackBars>100)throw Error('Range lookback must be 2–100 completed bars');
 for(const k of ['reclaimWindowBars','orderExpiry']as const)if(!Number.isInteger(cfg[k])||cfg[k]<1||cfg[k]>100)throw Error(`Invalid ${k}`);
 if(cfg.minSweepAtr<0||cfg.minSweepAtr>5||cfg.stopBufferAtr<0||cfg.stopBufferAtr>5||cfg.minTp1R<0||cfg.minTp2R<=0||cfg.minTp2R<cfg.minTp1R||cfg.watchDistanceAtr<0)throw Error('Invalid sweep, stop or reward filters');
 return cfg;
}
interface Range{high:number;low:number;end:number}
interface Sweep{direction:Direction;range:Range;extreme:number;time:number;expires:number;key:string}
interface Order{direction:Direction;range:Range;sweepExtreme:number;confirmedAt:number;expires:number;entry:number;stop:number;tp1:number;tp2:number;id:string;note:string}
interface Event{order:Order;status:'TOUCHED'|'EXPIRED'|'INVALIDATED';time:number}

/** Intraday Turtle Soup-inspired adaptation, not the original 20-day stop-entry strategy. */
export function evaluateTurtleSoup(symbol:string,closed:Candle[],forming:Candle|null,rangeHistory?:Candle[],cfg=DEFAULT_TURTLE_CFG):Setup{
 const {rangeMinutes,confirmationMinutes}=turtleTimeframes(cfg),rangeSecs=rangeMinutes*60,confirmationSecs=confirmationMinutes*60;
 const end=(closed.at(-1)?.t??-60)+60,now=forming?.t??end;
 const base:Setup={symbol,stage:'IDLE',direction:null,setupId:null,price:(forming??closed.at(-1))?.c??NaN,
  zone:null,distanceAtr:null,needBreak:null,barsSinceTap:null,entry:null,sl:null,tp1:null,tp2:null,orderType:null,orderNote:null,
  killzone:true,atrHtf:null,atrLtf:null,strategyId:'TURTLE-SOUP',ltfMinutes:confirmationMinutes,ts:now,
  reason:`Warming up: need ${cfg.lookbackBars} completed ${tf(rangeMinutes)} range candles and 14 ${tf(confirmationMinutes)} ATR candles`};
 const history=(rangeHistory??aggregateClosed(closed,rangeMinutes)).filter(c=>c.t+rangeSecs<=end);
 const confirmations=aggregateClosed(closed,confirmationMinutes),volatility=atr(confirmations);
 if(history.length<cfg.lookbackBars||confirmations.length<14)return base;
 const rangeAt=(time:number):Range|null=>{
  const available=history.filter(c=>c.t+rangeSecs<=time).slice(-cfg.lookbackBars);
  if(available.length<cfg.lookbackBars)return null;
  return {high:Math.max(...available.map(c=>c.h)),low:Math.min(...available.map(c=>c.l)),end:available.at(-1)!.t+rangeSecs};
 };
 let sweep:Sweep|null=null,pending:Order|null=null,lastEvent:Event|null=null,cursor=0,lastReason='Waiting for a failed breakout and a confirmed close back inside the range';
 const used=new Set<string>();
 const finish=(status:Event['status'],time:number)=>{if(pending)lastEvent={order:pending,status,time};pending=null};
 const execute=(time:number)=>{
  while(cursor<closed.length&&closed[cursor].t+60<=time){
   const bar=closed[cursor++];if(!pending||bar.t<pending.confirmedAt)continue;
   if(bar.t>=pending.expires){finish('EXPIRED',bar.t);continue}
   if(pending.direction==='LONG'?bar.l<=pending.stop:bar.h>=pending.stop){finish('INVALIDATED',bar.t);continue}
   if(pending.direction==='LONG'?bar.l<=pending.entry:bar.h>=pending.entry)finish('TOUCHED',bar.t+60);
  }
 };
 for(let i=0;i<confirmations.length;i++){
  const bar=confirmations[i],time=bar.t+confirmationSecs;
  execute(time);
  if(pending||!Number.isFinite(volatility[i])||volatility[i]<=0)continue;
  const previous=sweep as Sweep|null;
  if(previous&&time>previous.expires){sweep=null;lastReason='Sweep expired without a reclaim close'}
  if(!sweep){
   // Reference range is frozen before the sweep candle opens, never using its own HTF candle.
   const range=rangeAt(bar.t);if(!range)continue;
   const low=bar.l<range.low-volatility[i]*cfg.minSweepAtr,high=bar.h>range.high+volatility[i]*cfg.minSweepAtr;
   if(low&&high){lastReason='Both range boundaries swept in one candle; ambiguous setup skipped';continue}
   if(!low&&!high)continue;
   const direction:Direction=low?'LONG':'SHORT',key=`${range.end}:${direction}`;
   if(used.has(key))continue;
   used.add(key);
   sweep={direction,range,extreme:low?bar.l:bar.h,time:bar.t,expires:time+(cfg.reclaimWindowBars-1)*confirmationSecs,key};
  }
  const s=sweep as Sweep;
  s.extreme=s.direction==='LONG'?Math.min(s.extreme,bar.l):Math.max(s.extreme,bar.h);
  if(s.direction==='LONG'?bar.h>s.range.high:bar.l<s.range.low){sweep=null;lastReason='Sweep crossed the opposite range boundary before confirmation';continue}
  const reclaimed=bar.c>s.range.low&&bar.c<s.range.high;
  if(!reclaimed)continue;
  const long=s.direction==='LONG';
  const entry=cfg.entryMode==='Reclaimed level'?(long?s.range.low:s.range.high):long?bar.h-(bar.h-bar.l)*.5:bar.l+(bar.h-bar.l)*.5;
  const stop=s.extreme+(long?-1:1)*volatility[i]*cfg.stopBufferAtr;
  const tp1=(s.range.low+s.range.high)/2,tp2=long?s.range.high:s.range.low;
  const risk=long?entry-stop:stop-entry,rr1=(long?tp1-entry:entry-tp1)/risk,rr2=(long?tp2-entry:entry-tp2)/risk;
  if(entry<=0||stop<=0||risk<=0||(long?entry>=bar.c:entry<=bar.c)||entry<s.range.low||entry>s.range.high||rr1<=0||rr2<=rr1||rr1<cfg.minTp1R||rr2<cfg.minTp2R){sweep=null;lastReason='Reclaim rejected: limit placement or midpoint/opposite-range reward filters failed';continue}
  const note=`Turtle Soup-inspired: prior ${cfg.lookbackBars} completed ${tf(rangeMinutes)} range (${s.range.low}–${s.range.high}) → ${tf(confirmationMinutes)} ${long?'low':'high'} sweep to ${s.extreme} → close back inside → ${cfg.entryMode.toLowerCase()} ${long?'buy':'sell'} limit. Entry ${entry}; stop beyond sweep + ${cfg.stopBufferAtr} ATR. TP1 range midpoint ${tp1} (${rr1.toFixed(2)}R); TP2 opposite boundary ${tp2} (${rr2.toFixed(2)}R). Expiry ${cfg.orderExpiry} × ${tf(confirmationMinutes)} bars (${cfg.orderExpiry*confirmationMinutes} minutes).`;
  pending={direction:s.direction,range:s.range,sweepExtreme:s.extreme,confirmedAt:time,expires:time+cfg.orderExpiry*confirmationSecs,
   entry,stop,tp1,tp2,id:`${symbol}:TURTLE:${cfg.timeframePreset}:${s.direction}:${s.time}`,note};sweep=null;
 }
 execute(end);
 if(pending&&end>=(pending as Order).expires)finish('EXPIRED',end);
 base.atrLtf=volatility.at(-1)||null;
 const asSetup=(o:Order):Setup=>({...base,setupId:o.id,direction:o.direction,entry:o.entry,sl:o.stop,tp1:o.tp1,tp2:o.tp2,
  orderType:'LIMIT',expiresAt:o.expires,orderNote:o.note,zone:{top:o.range.high,bottom:o.range.low,startTime:o.range.end-rangeSecs},
  turtleContext:{rangeMinutes,confirmationMinutes,referenceHigh:o.range.high,referenceLow:o.range.low,rangeEnd:o.range.end,sweepExtreme:o.sweepExtreme,reclaimedAt:o.confirmedAt}});
 const event=lastEvent as Event|null;
 if(event?.status==='TOUCHED'&&now>=event.time&&now-event.time<confirmationSecs*3)return {...asSetup(event.order),stage:'ENTRY_READY',orderStatus:'TOUCHED',reason:'Turtle Soup limit touched in completed market data; simulated entry'};
 if(pending)return {...asSetup(pending),stage:'ARMED',orderStatus:'PENDING',reason:'Sweep and reclaim confirmed; waiting for limit retest'};
 if(event&&now-event.time<confirmationSecs)return {...asSetup(event.order),orderStatus:event.status,reason:event.status==='EXPIRED'?'Turtle Soup limit expired':'Sweep extreme/stop breached before an unambiguous touch'};
 const current=sweep as Sweep|null;
 if(current)return {...base,stage:'WATCH',direction:current.direction,setupId:`${symbol}:TURTLE:WATCH:${current.time}`,needBreak:current.direction==='LONG'?current.range.low:current.range.high,reason:`${tf(confirmationMinutes)} sweep detected; waiting for a close back inside the frozen range`};
 const range=rangeAt(end);
 if(range&&lastReason.startsWith('Waiting')&&Number.isFinite(base.price)&&base.atrLtf){
  const lowDistance=Math.abs(base.price-range.low)/base.atrLtf,highDistance=Math.abs(base.price-range.high)/base.atrLtf;
  if(Math.min(lowDistance,highDistance)<=cfg.watchDistanceAtr)return {...base,stage:'WATCH',direction:lowDistance<highDistance?'LONG':'SHORT',setupId:`${symbol}:TURTLE:NEAR:${range.end}`,reason:`Near ${tf(rangeMinutes)} range boundary; waiting for a sweep and reclaim`,orderNote:`Reference range: ${range.low}–${range.high}; completed lookback ${cfg.lookbackBars}.`};
 }
 return {...base,reason:lastReason};
}
