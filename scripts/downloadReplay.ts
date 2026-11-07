import {writeFileSync} from 'node:fs';
import {parseKlines} from '../src/mexc/rest.js';
import {validateCandles} from '../src/research/replay.js';
import type {Candle} from '../src/types.js';
const [symbol='BTC_USDT',count='4000',file='candles.json']=process.argv.slice(2);
const bars=Number(count),end=Math.floor(Date.now()/60000)*60;
if(!/^[A-Z0-9]+_USDT$/.test(symbol)||!Number.isInteger(bars)||bars<1||bars>50000)throw Error('Usage: npm run replay:download -- BTC_USDT 4000 candles.json (1–50000 bars)');
const data=new Map<number,Candle>();
for(let start=end-bars*60;start<end;start+=1000*60){
 const stop=Math.min(end,start+1000*60);
 const url=new URL('https://contract.mexc.com/api/v1/contract/kline/'+encodeURIComponent(symbol));
 url.search=new URLSearchParams({interval:'Min1',start:String(start),end:String(stop)}).toString();
 const response=await fetch(url,{signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw Error('MEXC HTTP '+response.status);
 const body=await response.json() as {success?:boolean};
 if(body.success===false)throw Error('MEXC rejected historical request');
 const page=parseKlines(body).filter(c=>c.t>=start&&c.t<stop);
 if(!page.length)throw Error('No candles returned for '+new Date(start*1000).toISOString());
 for(const c of page)data.set(c.t,c);
 console.log('Downloaded '+data.size+' completed candles');
}
const candles=[...data.values()].sort((a,b)=>a.t-b.t);validateCandles(candles);
writeFileSync(file,JSON.stringify(candles)+'\n',{flag:'wx'});
console.log('Saved '+candles.length+' candles to '+file+'; requested '+bars+'. Review gaps in replay output.');
