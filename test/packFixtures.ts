import type {Candle,PackStrategyId} from '../src/types.js';
import {T0} from './fixtures.js';

/** OHLC fixtures expand to contiguous minutes while preserving exact five-minute extremes. */
export function expandPack(bars:Candle[]):Candle[] {
  return bars.flatMap(b=>Array.from({length:5},(_,i)=>{
    const o=b.o+(b.c-b.o)*i/5,c=b.o+(b.c-b.o)*(i+1)/5;
    return {t:b.t+i*60,o,c,h:i===2?b.h:Math.max(o,c),l:i===3?b.l:Math.min(o,c),v:b.v/5};
  }));
}
export function packScenario(id:PackStrategyId) {
  const start=T0+(id==='OPENING-RANGE'?10*3600+10*60:0);
  const bars:Candle[]=Array.from({length:40},(_,i)=>({t:start+i*300,o:100,h:100.5,l:99.5,c:100,v:100}));
  const add=(o:number,h:number,l:number,c:number,v=200)=>bars.push({t:start+bars.length*300,o,h,l,c,v});
  let neutral=false;
  if(id==='OPENING-RANGE'||id==='BREAKOUT-RETEST') {
    add(100,102,100,101.8); // volume breakout, not an entry yet
    add(100.6,102,100.4,101.5,100); // bullish hold of frozen level 100.5; boundary limit
  } else if(id==='VWAP-RECLAIM') {
    bars[39]={...bars[39],o:100,c:99.6,l:99.5};
    add(99.6,101.2,99.5,101);
  } else if(id==='BOLLINGER-RANGE') {
    neutral=true;
    // Choppy reference range with an oversold final leg and a bullish snapback.
    for(let i=0;i<40;i++) {
      const c=i<32?100+(i%2?.8:-.8):100-(i-31)*.6;
      bars[i]={...bars[i],o:c,h:c+.1,l:c-.1,c};
    }
    add(95.2,96,94.8,95.8,200);
  } else {
    neutral=true;
    // First oversold pivot, recovery, lower low on less downside momentum, then neckline break.
    const prices=[...Array.from({length:20},(_,i)=>110-i*.5),100.5,100,99.5,99,98,99,100,101,100.5,100,99.5,99,98.5,98,97.8,98.3,98.8,99.5,100.5,100.8];
    for(let i=0;i<40;i++)bars[i]={...bars[i],o:prices[i],h:prices[i]+.1,l:prices[i]-.1,c:prices[i]};
    add(100.8,102,97.8,101.8,200);
  }
  const history=Array.from({length:85},(_,i)=>{
    const p=neutral?100:80+i*.25;
    return {t:Math.floor(start/3600)*3600-(80-i)*3600,o:p,c:p,h:p+1,l:p-1,v:100};
  });
  return {bars,candles:expandPack(bars),history};
}
