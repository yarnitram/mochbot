import type {Candle,Direction} from '../types.js';
import type {PackCfg} from './strategyPack.js';

export type ChartPatternId='ADAM-EVE'|'HEAD-SHOULDERS'|'QUASIMODO';
export const isChartPattern=(id:string):id is ChartPatternId=>['ADAM-EVE','HEAD-SHOULDERS','QUASIMODO'].includes(id);
interface Pivot {index:number;price:number;low:boolean}
export interface PatternCandidate {direction:Direction;entry:number;stop:number;top:number;bottom:number;key:string;note:string}

/** Strict pivots are available only after their right-hand candles have closed. */
export function confirmedPatternPivots(bars:Candle[],end:number,p:number,lookback:number):Pivot[]{
 const out:Pivot[]=[];
 for(let j=Math.max(p,end-lookback);j+p<=end;j++){
  const window=bars.slice(j-p,j+p+1);
  const low=window.every((b,k)=>k===p||b.l>bars[j].l),high=window.every((b,k)=>k===p||b.h<bars[j].h);
  if(low===high)continue; // An outside candle has ambiguous swing order.
  const point={index:j,price:low?bars[j].l:bars[j].h,low},last=out.at(-1);
  if(last?.low===low){if(low?point.price<last.price:point.price>last.price)out[out.length-1]=point;}
  else out.push(point);
 }
 return out;
}

export function detectChartPattern(id:ChartPatternId,bars:Candle[],i:number,a:number,cfg:PackCfg):PatternCandidate|null {
 const p=cfg.pivotBars!,points=confirmedPatternPivots(bars,i,p,cfg.lookbackBars!),b=bars[i],prev=bars[i-1];
 if(!prev||!Number.isFinite(a)||a<=0)return null;
 const selected=points.slice(id==='HEAD-SHOULDERS'?-5:-3);
 if(selected.length!==(id==='HEAD-SHOULDERS'?5:3))return null;
 const first=selected[0],last=selected.at(-1)!,long=first.low,sign=long?1:-1;
 const secs=cfg.timeframePreset==='4H/15m'?900:300;
 const span=bars.slice(Math.max(0,first.index-5),i+1);
 if(span.some((bar,k)=>k>0&&bar.t!==span[k-1].t+secs))return null;
 if(i-last.index-p>cfg.confirmationWindowBars!||last.index-first.index<6)return null;
 const direction:Direction=long?'LONG':'SHORT';
 let level:number,extreme:number,note:string;
 if(id==='HEAD-SHOULDERS'){
  const [left,n1,head,n2,right]=selected;
  if(sign*(left.price-head.price)<cfg.minPatternAtr!*a||sign*(right.price-head.price)<cfg.minPatternAtr!*a||Math.abs(left.price-right.price)>cfg.patternToleranceAtr!*a)return null;
  const neckline=(at:number)=>n1.price+(n2.price-n1.price)*(at-n1.index)/(n2.index-n1.index);
  level=neckline(i);extreme=head.price;
  if(!(sign*(b.c-level)>cfg.breakoutBufferAtr!*a&&sign*(prev.c-neckline(i-1))<=cfg.breakoutBufferAtr!*a))return null;
  note=`${long?'Inverse':'Bearish'} Head & Shoulders; confirmed shoulders ${left.price} / ${right.price}, head ${head.price}; sloping neckline frozen at ${level} after close through it. Limit retests neckline; stop beyond head.`;
 }else{
  const [adam,neck,eve]=selected;
  level=neck.price;extreme=long?Math.min(adam.price,eve.price):Math.max(adam.price,eve.price);
  if(id==='QUASIMODO'){
   if(sign*(adam.price-eve.price)<cfg.minPatternAtr!*a)return null;
   note=`${long?'Bullish':'Bearish'} Quasimodo adaptation: prior swing ${adam.price}, intervening structure ${neck.price}, new extreme ${eve.price}, then completed structure-break close. QML limit at prior swing ${adam.price}; stop beyond new extreme.`;
  }else{
   const height=sign*(neck.price-adam.price);
   if(height<cfg.minPatternAtr!*a||Math.abs(adam.price-eve.price)>cfg.patternToleranceAtr!*a||eve.index+4>i)return null;
   const width=(point:Pivot)=>bars.slice(Math.max(0,point.index-4),point.index+5).filter(c=>sign*((long?c.l:c.h)-point.price)<=height*.35).length;
   if(width(adam)>2||width(eve)<3)return null;
   note=`${long?'Bullish double bottom':'Bearish double top'} Adam & Eve: narrow first turn ${adam.price}, broader second turn ${eve.price}; neckline ${neck.price} broken by completed close. Limit retests neckline; stop beyond both turns. Shape thresholds are Mochbot rules.`;
  }
  if(!(sign*(b.c-level)>cfg.breakoutBufferAtr!*a&&sign*(prev.c-level)<=cfg.breakoutBufferAtr!*a))return null;
  if(id==='QUASIMODO')level=adam.price;
 }
 // Require an approach into the first turn, and reject a broken head before confirmation.
 const approach=bars[Math.max(0,first.index-5)].c;
 if(sign*(approach-first.price)<cfg.minPatternAtr!*a)return null;
 const recent=bars.slice(last.index+1,i+1);
 if(recent.some(c=>long?c.l<extreme:c.h>extreme))return null;
 return {direction,entry:level,stop:extreme-sign*cfg.stopBufferAtr*a,top:Math.max(level,extreme),bottom:Math.min(level,extreme),
  key:selected.map(point=>bars[point.index].t).join(':')+':'+direction,note};
}
