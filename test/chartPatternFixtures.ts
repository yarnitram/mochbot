import type {Candle} from '../src/types.js';
import type {ChartPatternId} from '../src/strategy/chartPatterns.js';
import {expandPack} from './packFixtures.js';
import {T0} from './fixtures.js';
export function chartPatternScenario(id:ChartPatternId){
 const anchors=id==='HEAD-SHOULDERS'?[[0,100],[4,96],[12,101],[20,92],[28,101],[36,96],[40,100],[44,100.2],[48,105]]:
 id==='ADAM-EVE'?[[0,100],[3,98],[4,94],[5,98],[12,102],[20,96],[22,94.8],[24,94.2],[26,94.8],[32,100],[36,105]]:
 [[0,100],[4,96],[12,101],[20,92],[24,98],[28,105]];
 const bars:Candle[]=Array.from({length:80},(_,i)=>({t:T0+i*300,o:100,c:100,h:100.2,l:99.8,v:100}));
 for(let i=0;i<=anchors.at(-1)![0];i++){
  const right=anchors.findIndex(a=>a[0]>=i),r=anchors[right],l=anchors[Math.max(0,right-1)],c=r[0]===l[0]?r[1]:l[1]+(r[1]-l[1])*(i-l[0])/(r[0]-l[0]);
  bars.push({t:T0+bars.length*300,o:c-.05,c,h:c+1,l:c-1,v:i>=anchors.at(-1)![0]-3?800:200});
 }
 const history=Array.from({length:100},(_,i)=>({t:T0-(90-i)*3600,o:100,c:100,h:101,l:99,v:100}));
 return {bars,candles:expandPack(bars),history};
}
