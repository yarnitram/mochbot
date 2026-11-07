import type { Candle, Direction, PackStrategyId, Setup } from '../types.js';
import { aggregateClosed, atr, ema } from './indicators.js';
import {detectChartPattern,isChartPattern} from './chartPatterns.js';

export interface PackCfg {
  timeframePreset: '1H/5m' | '4H/15m';
  orderExpiry: number;
  stopBufferAtr: number;
  minStopAtr: number;
  maxStopAtr: number;
  minStopPercent: number;
  rrTP1: number;
  rrTP2: number;
  minVolumeRatio: number;
  lookbackBars?: number;
  retestWindowBars?: number;
  breakoutBufferAtr?: number;
  sessionStartHourUTC?: number;
  openingRangeMinutes?: number;
  sessionWindowMinutes?: number;
  bandDeviation?: number;
  maxRangeEfficiency?: number;
  rsiPeriod?: number;
  pivotBars?: number;
  minRsiDivergence?: number;
  confirmationWindowBars?: number;
  patternToleranceAtr?:number;
  minPatternAtr?:number;
}

const common: PackCfg = {timeframePreset:'1H/5m',orderExpiry:6,stopBufferAtr:.2,minStopAtr:.5,
  maxStopAtr:3,minStopPercent:.15,rrTP1:2,rrTP2:3,minVolumeRatio:1.2};
export const PACK_DEFINITIONS: {id:PackStrategyId;name:string;description:string;defaults:PackCfg}[] = [
  {id:'OPENING-RANGE',name:'Opening Range Breakout Retest',description:'Fixed UTC daily session → completed opening range → trend-aligned volume breakout → later retest and boundary limit. Crypto session convention; not an exchange opening auction.',
    defaults:{...common,sessionStartHourUTC:13,openingRangeMinutes:30,sessionWindowMinutes:180,retestWindowBars:6,breakoutBufferAtr:.1}},
  {id:'BREAKOUT-RETEST',name:'Trend Breakout Retest',description:'Higher-timeframe EMA20/50 trend → prior 20 confirmation-bar range breakout on volume → later level retest → boundary limit.',
    defaults:{...common,lookbackBars:20,retestWindowBars:6,breakoutBufferAtr:.1}},
  {id:'VWAP-RECLAIM',name:'UTC Session VWAP Reclaim',description:'Higher-timeframe trend → volume-supported close back across UTC daily VWAP → frozen VWAP retest limit. Requires complete session history from 00:00 UTC.',
    defaults:{...common}},
  {id:'BOLLINGER-RANGE',name:'Bollinger Range Reversal',description:'Low-efficiency sideways market → wick beyond prior 20-bar / 2σ band and close back inside → RSI filter → 50% candle limit. Targets frozen mean and opposite band; minimum 1R / 2R.',
    defaults:{...common,minVolumeRatio:1,lookbackBars:20,bandDeviation:2,maxRangeEfficiency:.35,rsiPeriod:14,rrTP1:1,rrTP2:2}},
  {id:'RSI-DIVERGENCE',name:'Confirmed RSI Divergence Reversal',description:'Two confirmed price pivots with regular RSI divergence → neckline close with volume → 50% confirmation-candle limit. Pivots are known only after right-hand candles close.',
    defaults:{...common,lookbackBars:40,rsiPeriod:14,pivotBars:2,minRsiDivergence:5,confirmationWindowBars:6}},
  ...(['ADAM-EVE','HEAD-SHOULDERS','QUASIMODO'] as const).map(id=>({id,name:({ 'ADAM-EVE':'Adam & Eve Reversal','HEAD-SHOULDERS':'Head & Shoulders Reversal','QUASIMODO':'Quasimodo Structure Reversal'})[id],
   description:'Confirmed swing-pattern reversal → completed neckline/structure break with volume → resting retest limit. Includes mirrored bullish and bearish setups; experimental Mochbot rules.',
   defaults:{...common,lookbackBars:80,pivotBars:2,confirmationWindowBars:12,patternToleranceAtr:.75,minPatternAtr:.5,breakoutBufferAtr:.1,maxStopAtr:6}})),
];
export const isPackStrategy = (id:unknown):id is PackStrategyId => PACK_DEFINITIONS.some(d=>d.id===id);
export const packDefaults = (id:PackStrategyId):PackCfg => ({...PACK_DEFINITIONS.find(d=>d.id===id)!.defaults});
export const packTimeframes = (cfg:PackCfg) => cfg.timeframePreset==='4H/15m'
  ? {referenceMinutes:240,confirmationMinutes:15} : {referenceMinutes:60,confirmationMinutes:5};
export const packConfigKey = (cfg:PackCfg) => JSON.stringify(Object.entries(cfg).sort(([a],[b])=>a.localeCompare(b)));

export function validatePackConfig(id:PackStrategyId,input:Partial<PackCfg>):PackCfg {
  if(!input || typeof input!=='object' || Array.isArray(input))throw Error('Strategy settings must be an object');
  const defaults=packDefaults(id),cfg={...defaults,...input};
  for(const [key,v] of Object.entries(cfg)) {
    if(!Object.hasOwn(defaults,key))throw Error(`Unknown ${id} setting: ${key}`);
    if(key==='timeframePreset') {if(v!=='1H/5m'&&v!=='4H/15m')throw Error('Unsupported timeframe preset');continue}
    if(typeof v!=='number'||!Number.isFinite(v)||v<0)throw Error(`Invalid ${key}`);
  }
  const integers:{[key:string]:[number,number]}={orderExpiry:[1,100],lookbackBars:[10,100],retestWindowBars:[1,30],
    sessionStartHourUTC:[0,23],openingRangeMinutes:[15,120],sessionWindowMinutes:[30,720],rsiPeriod:[2,50],pivotBars:[1,5],confirmationWindowBars:[1,30]};
  for(const [key,[min,max]] of Object.entries(integers)) {
    const v=cfg[key as keyof PackCfg];
    if(v!==undefined && (typeof v!=='number'||!Number.isInteger(v)||v<min||v>max))throw Error(`Invalid ${key}: ${min}–${max}`);
  }
  if(cfg.stopBufferAtr>5||cfg.minStopAtr<=0||cfg.minStopAtr>=cfg.maxStopAtr||cfg.maxStopAtr>10||cfg.minStopPercent>10||
    cfg.rrTP1<=0||cfg.rrTP2<=cfg.rrTP1||cfg.rrTP2>20||cfg.minVolumeRatio>10)throw Error('Invalid risk, target or volume filters');
  if(cfg.breakoutBufferAtr!==undefined&&cfg.breakoutBufferAtr>2)throw Error('Breakout buffer must be 0–2 ATR');
  if(cfg.bandDeviation!==undefined&&(cfg.bandDeviation<1||cfg.bandDeviation>4))throw Error('Band deviation must be 1–4');
  if(cfg.maxRangeEfficiency!==undefined&&(cfg.maxRangeEfficiency<=0||cfg.maxRangeEfficiency>1))throw Error('Range efficiency must be above 0 and at most 1');
  if(cfg.minRsiDivergence!==undefined&&(cfg.minRsiDivergence<1||cfg.minRsiDivergence>30))throw Error('RSI divergence must be 1–30');
  if(cfg.patternToleranceAtr!==undefined&&(cfg.patternToleranceAtr<=0||cfg.patternToleranceAtr>5))throw Error('Pattern tolerance must be above 0 and at most 5 ATR');
  if(cfg.minPatternAtr!==undefined&&(cfg.minPatternAtr<=0||cfg.minPatternAtr>5))throw Error('Pattern prominence must be above 0 and at most 5 ATR');
  if(id==='OPENING-RANGE'&&(cfg.openingRangeMinutes!%15!==0||cfg.sessionWindowMinutes!<=cfg.openingRangeMinutes!||
    cfg.sessionStartHourUTC!*60+cfg.sessionWindowMinutes!>1440))throw Error('UTC session must fit within one day; opening range must use 15-minute increments');
  return cfg;
}

/** Wilder RSI: a flat sequence is neutral (50), and zero loss with gains is 100. */
export function rsi(bars:Candle[],period=14):number[] {
  const out=Array<number>(bars.length).fill(NaN);let gain=0,loss=0;
  for(let i=1;i<bars.length;i++) {
    const change=bars[i].c-bars[i-1].c,g=Math.max(0,change),l=Math.max(0,-change);
    if(i<=period){gain+=g;loss+=l;if(i<period)continue;gain/=period;loss/=period}
    else {gain=(gain*(period-1)+g)/period;loss=(loss*(period-1)+l)/period}
    out[i]=gain===0&&loss===0?50:loss===0?100:100-100/(1+gain/loss);
  }
  return out;
}

interface Candidate {direction:Direction;entry:number;stop:number;top:number;bottom:number;note:string;key:string;tp1?:number;tp2?:number;deadline?:number}
interface Order extends Candidate {id:string;confirmedAt:number;expiresAt:number;tp1:number;tp2:number}
interface Breakout {direction:Direction;level:number;high:number;low:number;index:number;deadline:number;key:string}
interface Pivot {index:number;price:number;strength:number}
interface Divergence {direction:Direction;extreme:number;neckline:number;expires:number;key:string}

/** Five experimental rule sets, sharing only their completed-bar order simulation and risk filters. */
export function evaluatePackStrategy(id:PackStrategyId,symbol:string,closed:Candle[],forming:Candle|null,referenceHistory?:Candle[],cfg=packDefaults(id)):Setup {
  const tf=packTimeframes(cfg),secs=tf.confirmationMinutes*60,refSecs=tf.referenceMinutes*60;
  const end=(closed.at(-1)?.t??-60)+60,now=forming?.t??end;
  const base:Setup={symbol,stage:'IDLE',direction:null,setupId:null,price:(forming??closed.at(-1))?.c??NaN,
    zone:null,distanceAtr:null,needBreak:null,barsSinceTap:null,entry:null,sl:null,tp1:null,tp2:null,orderType:null,
    orderNote:null,killzone:true,atrHtf:null,atrLtf:null,strategyId:id,ltfMinutes:tf.confirmationMinutes,ts:now,
    reason:`Warming up: need 50 completed ${tf.referenceMinutes/60}H reference bars and 40 completed ${tf.confirmationMinutes}m bars`};
  const bars=aggregateClosed(closed,tf.confirmationMinutes);
  const refs=(referenceHistory??aggregateClosed(closed,tf.referenceMinutes)).filter(c=>c.t+refSecs<=end);
  if(bars.length<40||refs.length<50)return base;
  const volatility=atr(bars),refAtr=atr(refs),fast=ema(refs,20),slow=ema(refs,50),strength=rsi(bars,cfg.rsiPeriod??14);
  const configKey=packConfigKey(cfg);
  let refIndex=-1,cursor=0,pending:Order|null=null,event:{order:Order;status:'TOUCHED'|'EXPIRED'|'INVALIDATED';time:number}|null=null;
  let breakout:Breakout|null=null,divergence:Divergence|null=null;
  const lows:Pivot[]=[],highs:Pivot[]=[],used=new Set<string>();
  let reason='Waiting for a fresh confirmed setup',watchDirection:Direction|null=null;
  let sessionDay=-1,sessionValid=false,sessionCount=0,pv=0,volume=0,previousVwap=NaN,contiguous=0;
  const finish=(status:'TOUCHED'|'EXPIRED'|'INVALIDATED',time:number)=>{if(pending)event={order:pending,status,time};pending=null};
  const execute=(time:number)=>{
    while(cursor<closed.length&&closed[cursor].t+60<=time){
      const b=closed[cursor++],o=pending as Order|null;
      if(!o||b.t<o.confirmedAt)continue;
      if(cursor>1&&closed[cursor-2].t+60!==b.t){finish('INVALIDATED',b.t);continue}
      if(b.t>=o.expiresAt){finish('EXPIRED',b.t);continue}
      // Stop has priority if the same completed minute contains both entry and stop.
      if(o.direction==='LONG'?b.l<=o.stop:b.h>=o.stop){finish('INVALIDATED',b.t+60);continue}
      if(o.direction==='LONG'?b.l<=o.entry:b.h>=o.entry)finish('TOUCHED',b.t+60);
    }
  };
  for(let i=0;i<bars.length;i++) {
    const b=bars[i],time=b.t+secs,prev=bars[i-1],a=volatility[i];
    execute(time);
    while(refIndex+1<refs.length&&refs[refIndex+1].t+refSecs<=time)refIndex++;
    const ref=refs[refIndex];
    const freshRef=ref&&time-(ref.t+refSecs)<refSecs*2;
    const trend:Direction|null=freshRef&&refIndex>0&&Number.isFinite(slow[refIndex])
      ? ref.c>fast[refIndex]&&fast[refIndex]>slow[refIndex]&&fast[refIndex]>fast[refIndex-1]?'LONG'
      :ref.c<fast[refIndex]&&fast[refIndex]<slow[refIndex]&&fast[refIndex]<fast[refIndex-1]?'SHORT':null:null;
    const day=Math.floor(b.t/86400)*86400;
    if(day!==sessionDay){sessionDay=day;sessionValid=b.t===day;sessionCount=0;pv=0;volume=0;previousVwap=NaN}
    if(prev&&prev.t+secs!==b.t){sessionValid=false;breakout=null;divergence=null;lows.length=0;highs.length=0;contiguous=0;if(pending)finish('INVALIDATED',b.t)}
    contiguous++;
    const oldVwap=previousVwap;
    pv+=(b.h+b.l+b.c)/3*b.v;volume+=b.v;sessionCount++;
    const vwap=volume>0?pv/volume:NaN;previousVwap=vwap;
    if(id==='RSI-DIVERGENCE') {
      const p=cfg.pivotBars!,j=i-p;
      if(contiguous>=2*p+1&&j>=p&&Number.isFinite(strength[j])) {
        for(const direction of ['LONG','SHORT'] as const) {
          const low=direction==='LONG',price=low?bars[j].l:bars[j].h;
          const confirmed=bars.slice(j-p,j+p+1).every((c,k)=>k===p||(low?c.l>price:c.h<price));
          if(!confirmed)continue;
          const points=low?lows:highs,previous=points.at(-1),point={index:j,price,strength:strength[j]};points.push(point);
          if(previous&&j-previous.index>=p*2+1&&j-previous.index<=cfg.lookbackBars!) {
            const diverges=low?price<previous.price&&point.strength>=previous.strength+cfg.minRsiDivergence!&&previous.strength<=35
              :price>previous.price&&point.strength<=previous.strength-cfg.minRsiDivergence!&&previous.strength>=65;
            if(diverges) {
              const between=bars.slice(previous.index+1,j);
              divergence={direction,extreme:price,neckline:low?Math.max(...between.map(c=>c.h)):Math.min(...between.map(c=>c.l)),
                expires:i+cfg.confirmationWindowBars!,key:`${direction}:${bars[j].t}`};
            }
          }
        }
      }
    }
    if(contiguous<Math.max(40,cfg.lookbackBars??0,cfg.rsiPeriod??0)){reason='Warming up continuous confirmation history after startup or a candle gap';continue}
    if(refIndex<49||!Number.isFinite(a)||a<=0||!freshRef){reason='Waiting for valid ATR and 50 recent completed higher-timeframe context candles';continue}
    const prior=bars.slice(i-20,i),avgVolume=prior.reduce((sum,c)=>sum+c.v,0)/prior.length;
    const volumeOK=avgVolume>0&&Number.isFinite(b.v)&&b.v>=avgVolume*cfg.minVolumeRatio;
    let candidate:Candidate|null=null;watchDirection=null;
    if(pending) {
      if(['OPENING-RANGE','BREAKOUT-RETEST','VWAP-RECLAIM'].includes(id)&&trend!==pending.direction)finish('INVALIDATED',time);
      else continue;
    }
    if(isChartPattern(id)) {
      reason='Waiting for confirmed swing pattern, completed structure break and relative volume';
      const pattern=detectChartPattern(id,bars,i,a,cfg);
      if(pattern&&!used.has(pattern.key)){
        used.add(pattern.key);
        if(volumeOK)candidate=pattern;
        else reason='Pattern break rejected: confirmation volume below threshold';
      }
    } else if(id==='OPENING-RANGE'||id==='BREAKOUT-RETEST') {
      const orb=id==='OPENING-RANGE',start=day+(cfg.sessionStartHourUTC??0)*3600;
      const rangeEnd=start+(cfg.openingRangeMinutes??0)*60,deadline=start+(cfg.sessionWindowMinutes??0)*60;
      let range:Candle[]=[];
      if(orb) {
        range=bars.filter(c=>c.t>=start&&c.t<rangeEnd&&c.t+secs<=b.t);
        if(b.t<rangeEnd||time>deadline||range.length!==cfg.openingRangeMinutes!/tf.confirmationMinutes){breakout=null;reason='Outside the UTC session or opening range history is incomplete';continue}
      } else range=bars.slice(i-cfg.lookbackBars!,i);
      if(range.length<(orb?1:cfg.lookbackBars!)){reason='Waiting for a complete prior breakout range';continue}
      const active=breakout as Breakout|null;
      if(active) {
        const long=active.direction==='LONG';
        if(i>active.index+cfg.retestWindowBars!||time>active.deadline||trend!==active.direction||
          (long?b.c<active.level-.35*a:b.c>active.level+.35*a))breakout=null;
        else if(i>active.index&&b.l<=active.level+.15*a&&b.h>=active.level-.15*a&&
          (long?b.c>active.level&&b.c>b.o:b.c<active.level&&b.c<b.o)) {
          candidate={direction:active.direction,entry:active.level,stop:long?Math.min(b.l,active.level-.5*a)-cfg.stopBufferAtr*a:Math.max(b.h,active.level+.5*a)+cfg.stopBufferAtr*a,
            top:active.high,bottom:active.low,key:active.key,deadline:active.deadline,
            note:`${orb?`UTC ${cfg.sessionStartHourUTC}:00 opening ${cfg.openingRangeMinutes}m range`:`Prior ${cfg.lookbackBars} × ${tf.confirmationMinutes}m range`} ${active.low}–${active.high}; EMA20/50 trend and breakout volume confirmed, then a later closed-bar retest; limit at frozen boundary ${active.level}.`};
          breakout=null;
        }
      }
      if(!breakout&&!candidate&&trend&&volumeOK&&Math.abs(b.c-b.o)>=.5*a) {
        const high=Math.max(...range.map(c=>c.h)),low=Math.min(...range.map(c=>c.l)),long=trend==='LONG',level=long?high:low;
        const breaks=long?b.c>high+cfg.breakoutBufferAtr!*a&&prev.c<=high:b.c<low-cfg.breakoutBufferAtr!*a&&prev.c>=low;
        const key=orb?`${day}:${trend}`:`${b.t}:${trend}`;
        if(breaks&&Math.abs(b.c-level)<=1.5*a&&!used.has(key)){
          breakout={direction:trend,level,high,low,index:i,deadline:orb?deadline:Infinity,key};used.add(key);
        }
      }
      const waiting=breakout as Breakout|null;watchDirection=waiting?.direction??null;
      reason=waiting?'Volume breakout confirmed; waiting for a later candle to retest and hold the frozen level':!trend?'Higher-timeframe EMA20/50 trend is neutral or misaligned':'Waiting for a fresh volume-supported range breakout';
    } else if(id==='VWAP-RECLAIM') {
      reason=!sessionValid?'VWAP requires continuous completed candles from 00:00 UTC':!trend?'Higher-timeframe EMA20/50 trend is neutral or misaligned':'Waiting for a volume-supported close back across UTC session VWAP';
      if(sessionValid&&sessionCount>=20&&trend&&volumeOK&&Number.isFinite(oldVwap)) {
        const long:boolean=trend==='LONG',cross:boolean=long?prev.c<=oldVwap&&b.c>vwap+.1*a&&b.c>b.o:prev.c>=oldVwap&&b.c<vwap-.1*a&&b.c<b.o;
        if(cross)candidate={direction:trend,entry:vwap,stop:long?Math.min(b.l,prev.l)-cfg.stopBufferAtr*a:Math.max(b.h,prev.h)+cfg.stopBufferAtr*a,
          top:Math.max(vwap,b.c),bottom:Math.min(vwap,b.c),key:`${b.t}:${trend}`,deadline:day+86400,
          note:`UTC daily typical-price × volume VWAP reclaim ${vwap}; EMA20/50 trend and relative volume confirmed. VWAP frozen at confirmation for a resting limit; stop beyond two-candle extreme.`};
      }
    } else if(id==='BOLLINGER-RANGE') {
      const range=bars.slice(i-cfg.lookbackBars!,i);
      if(range.length<cfg.lookbackBars!)continue;
      const mean=range.reduce((s,c)=>s+c.c,0)/range.length;
      const sd=Math.sqrt(range.reduce((s,c)=>s+(c.c-mean)**2,0)/range.length);
      const upper=mean+cfg.bandDeviation!*sd,lower=mean-cfg.bandDeviation!*sd;
      const path=range.slice(1).reduce((s,c,k)=>s+Math.abs(c.c-range[k].c),0);
      const efficiency=path>0?Math.abs(range.at(-1)!.c-range[0].c)/path:0;
      const ranging=efficiency<=cfg.maxRangeEfficiency!&&Math.abs(fast[refIndex]-slow[refIndex])<=.75*refAtr[refIndex];
      reason=!ranging?'Range filter rejected: directional market; no mean-reversion entry':'Waiting for a band rejection with RSI confirmation and enough target distance';
      const long=b.l<lower&&b.c>lower&&b.c<mean&&b.c>b.o&&Math.min(strength[i],strength[i-1])<=40;
      const short=b.h>upper&&b.c<upper&&b.c>mean&&b.c<b.o&&Math.max(strength[i],strength[i-1])>=60;
      if(ranging&&sd>0&&volumeOK&&long!==short&&(long||short))candidate={direction:long?'LONG':'SHORT',entry:(b.h+b.l)/2,
        stop:(long?b.l-cfg.stopBufferAtr*a:b.h+cfg.stopBufferAtr*a),tp1:mean,tp2:long?upper:lower,
        top:upper,bottom:lower,key:`${b.t}:${long?'LONG':'SHORT'}`,
        note:`Sideways filter efficiency ${efficiency.toFixed(3)}; prior ${cfg.lookbackBars}-bar bands (${cfg.bandDeviation}σ) ${lower}–${upper}; wick outside and close inside with RSI filter. 50% candle limit; frozen mean / opposite-band targets.`};
    } else {
      const d=divergence as Divergence|null;
      if(d&&(i>d.expires||(d.direction==='LONG'?b.l<d.extreme:b.h>d.extreme)))divergence=null;
      const active=divergence as Divergence|null;
      watchDirection=active?.direction??null;
      reason=active?'Confirmed RSI divergence; waiting for a volume-supported close through the neckline':'Waiting for two confirmed pivots with regular RSI divergence';
      if(active&&volumeOK&&(active.direction==='LONG'?b.c>active.neckline&&prev.c<=active.neckline:b.c<active.neckline&&prev.c>=active.neckline)){
        const long=active.direction==='LONG';
        candidate={direction:active.direction,entry:(b.h+b.l)/2,stop:long?active.extreme-cfg.stopBufferAtr*a:active.extreme+cfg.stopBufferAtr*a,
          top:Math.max(active.neckline,active.extreme),bottom:Math.min(active.neckline,active.extreme),key:active.key,
          note:`Regular RSI(${cfg.rsiPeriod}) divergence ≥ ${cfg.minRsiDivergence} points between two confirmed pivots (${cfg.pivotBars} right-hand bars each); neckline ${active.neckline} close and relative volume confirmed. 50% confirmation-candle limit; stop beyond second pivot.`};
        divergence=null;
      }
    }
    if(!candidate)continue;
    const long:boolean=candidate.direction==='LONG';
    const sign:number=long?1:-1,risk:number=sign*(candidate.entry-candidate.stop);
    const tp1:number=candidate.tp1??candidate.entry+sign*risk*cfg.rrTP1,tp2:number=candidate.tp2??candidate.entry+sign*risk*cfg.rrTP2;
    const rr1:number=sign*(tp1-candidate.entry)/risk,rr2:number=sign*(tp2-candidate.entry)/risk;
    if(![candidate.entry,candidate.stop,tp1,tp2].every(x=>Number.isFinite(x)&&x>0)||risk<cfg.minStopAtr*a||risk>cfg.maxStopAtr*a||
      risk/candidate.entry*100<cfg.minStopPercent||(long?candidate.entry>=b.c:candidate.entry<=b.c)||rr1+1e-9<cfg.rrTP1||rr2+1e-9<cfg.rrTP2){
      reason='Setup rejected: resting limit, stop-distance or reward filters failed';continue;
    }
    const expiresAt=Math.min(time+cfg.orderExpiry*secs,candidate.deadline??Infinity);
    if(expiresAt<=time)continue;
    pending={...candidate,tp1,tp2,id:`${symbol}:${id}:${cfg.timeframePreset}:${candidate.key}`,confirmedAt:time,expiresAt,
      note:`${tf.referenceMinutes/60}H context / ${tf.confirmationMinutes}m confirmation. ${candidate.note} Stop buffer ${cfg.stopBufferAtr} ATR; TP1 ${rr1.toFixed(2)}R / TP2 ${rr2.toFixed(2)}R. Expiry ${new Date(expiresAt*1000).toISOString()}. Experimental rules; win rate unverified.`};
  }
  execute(end);
  if(pending&&end>=(pending as Order).expiresAt)finish('EXPIRED',end);
  base.atrHtf=refAtr[refIndex]||null;base.atrLtf=volatility.at(-1)||null;
  const asSetup=(o:Order):Setup=>({...base,setupId:o.id,direction:o.direction,entry:o.entry,sl:o.stop,tp1:o.tp1,tp2:o.tp2,
    zone:{top:o.top,bottom:o.bottom,startTime:o.confirmedAt},orderType:'LIMIT',expiresAt:o.expiresAt,orderNote:o.note,
    packContext:{...tf,configKey,confirmedAt:o.confirmedAt}});
  const last=event as {order:Order;status:'TOUCHED'|'EXPIRED'|'INVALIDATED';time:number}|null;
  if(last?.status==='TOUCHED'&&now>=last.time&&now-last.time<secs*3)return {...asSetup(last.order),stage:'ENTRY_READY',orderStatus:'TOUCHED',reason:'Limit touched after confirmation in completed candles; simulated entry'};
  if(pending)return {...asSetup(pending),stage:'ARMED',orderStatus:'PENDING',reason:'All setup filters passed; waiting for the resting limit retest'};
  if(last&&now-last.time<secs)return {...asSetup(last.order),orderStatus:last.status,reason:last.status==='EXPIRED'?'Limit expired without a touch':'Plan invalidated by stop, missing candles or trend disagreement'};
  return {...base,stage:watchDirection?'WATCH':'IDLE',direction:watchDirection,reason,
    setupId:watchDirection?`${symbol}:${id}:WATCH:${(breakout as Breakout|null)?.key??(divergence as Divergence|null)?.key}`:null};
}
