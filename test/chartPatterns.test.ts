import {describe,it,expect} from 'vitest';
import {evaluatePackStrategy,packDefaults,validatePackConfig} from '../src/strategy/strategyPack.js';
import {confirmedPatternPivots,detectChartPattern,type ChartPatternId} from '../src/strategy/chartPatterns.js';
import {chartPatternScenario} from './chartPatternFixtures.js';
import {atr} from '../src/strategy/indicators.js';
import type {Candle} from '../src/types.js';
const ids:ChartPatternId[]=['ADAM-EVE','HEAD-SHOULDERS','QUASIMODO'];
const invert=(b:Candle):Candle=>({...b,o:200-b.o,c:200-b.c,h:200-b.l,l:200-b.h});
describe('confirmed chart-pattern limit strategies',()=>{
 for(const id of ids){
  it(id+' admits mirrored long/short limits after closed structure breaks',()=>{
   const f=chartPatternScenario(id),long=evaluatePackStrategy(id,'TEST',f.candles,null,f.history);
   expect(long.orderStatus,JSON.stringify(long)).toBe('PENDING');expect(long.direction).toBe('LONG');
   expect(long.entry!).toBeLessThan(long.price);expect(long.sl!).toBeLessThan(long.entry!);
   expect((long.tp1!-long.entry!)/(long.entry!-long.sl!)).toBeCloseTo(2);
   const short=evaluatePackStrategy(id,'TEST',f.candles.map(invert),null,f.history.map(invert));
   expect(short.orderStatus,JSON.stringify(short)).toBe('PENDING');expect(short.direction).toBe('SHORT');expect(short.entry).toBeCloseTo(200-long.entry!);
   const confirmed=long.packContext!.confirmedAt;
   const prior=f.candles.filter(c=>c.t+60<confirmed);
   expect(evaluatePackStrategy(id,'TEST',prior,f.candles.find(c=>c.t===confirmed-60)!,f.history).setupId).not.toBe(long.setupId);
  });
  it(id+' keeps stable setup IDs on touch and rejects ambiguous or missing minutes',()=>{
   const f=chartPatternScenario(id),p=evaluatePackStrategy(id,'TEST',f.candles,null,f.history),end=f.candles.at(-1)!.t+60;
   const touch={t:end,o:p.price,c:p.entry!+.1,h:p.price,l:p.entry!-.01,v:100};
   const touched=evaluatePackStrategy(id,'TEST',[...f.candles,touch],null,f.history);
   expect(touched.orderStatus).toBe('TOUCHED');expect(touched.setupId).toBe(p.setupId);
   expect(evaluatePackStrategy(id,'TEST',[...f.candles,{...touch,l:p.sl!-.01}],null,f.history).orderStatus).toBe('INVALIDATED');
   expect(evaluatePackStrategy(id,'TEST',[...f.candles,{...touch,t:end+60}],null,f.history).orderStatus).toBe('INVALIDATED');
   const quiet=Array.from({length:40},(_,i)=>({t:end+i*60,o:p.price,c:p.price,h:p.price,l:p.price,v:100}));
   const expired=evaluatePackStrategy(id,'TEST',[...f.candles,...quiet],null,f.history);
   expect(expired.orderStatus).not.toBe('PENDING');expect(expired.orderStatus).not.toBe('TOUCHED');
  });
  it(id+' rejects weak-volume breaks and invalid pattern settings',()=>{
   const f=chartPatternScenario(id);
   expect(evaluatePackStrategy(id,'TEST',f.candles.map(c=>({...c,v:100})),null,f.history).orderStatus).not.toBe('PENDING');
   expect(()=>validatePackConfig(id,{patternToleranceAtr:0})).toThrow();
   expect(()=>validatePackConfig(id,{minPatternAtr:6})).toThrow();
  });
 }
 it('only exposes pivots after right-bar confirmation and ignores ambiguous outside bars',()=>{
  const f=chartPatternScenario('HEAD-SHOULDERS'),p=84;
  expect(confirmedPatternPivots(f.bars,p+1,2,80).some(x=>x.index===p)).toBe(false);
  expect(confirmedPatternPivots(f.bars,p+2,2,80).some(x=>x.index===p)).toBe(true);
  const outside=f.bars.map((c,i)=>i===p?{...c,h:200,l:1}:c);
  expect(confirmedPatternPivots(outside,p+2,2,80).some(x=>x.index===p)).toBe(false);
 });
 it('rejects a narrow second Adam turn and an unequal right shoulder',()=>{
  const f=chartPatternScenario('ADAM-EVE'),a=atr(f.bars),cfg=packDefaults('ADAM-EVE');
  const v=f.bars.map((b,i)=>i>=100&&i<=108&&i!==104?{...b,l:100}:b);
  for(let i=110;i<v.length;i++)expect(detectChartPattern('ADAM-EVE',v,i,a[i],cfg)).toBeNull();
  const h=chartPatternScenario('HEAD-SHOULDERS');
  const hc=h.bars.map((b,i)=>i===116?{...b,l:92}:b);
  for(let i=120;i<hc.length;i++)expect(detectChartPattern('HEAD-SHOULDERS',hc,i,atr(hc)[i],packDefaults('HEAD-SHOULDERS'))).toBeNull();
 });
 it('evaluates a sloping neckline at the break and rejects patterns spanning missing candles',()=>{
  const f=chartPatternScenario('HEAD-SHOULDERS'),cfg=packDefaults('HEAD-SHOULDERS');
  const bars=f.bars.map((b,i)=>i===108?{...b,h:b.h+.5}:b),a=atr(bars);
  const found=bars.map((_,i)=>({i,c:detectChartPattern('HEAD-SHOULDERS',bars,i,a[i],cfg)})).find(x=>x.c);
  expect(found).toBeTruthy();expect(found!.c!.entry).toBeCloseTo(102+.5*(found!.i-92)/16);
  const gapped=bars.map((b,i)=>i>=100?{...b,t:b.t+300}:b);
  expect(detectChartPattern('HEAD-SHOULDERS',gapped,found!.i,a[found!.i],cfg)).toBeNull();
 });
});
