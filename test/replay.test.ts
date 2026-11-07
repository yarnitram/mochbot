import {describe,it,expect} from 'vitest';
import {replay,validateCandles} from '../src/research/replay.js';
import {ACTIVE_STRATEGIES} from '../src/types.js';
import {emaScenario} from './fixtures.js';
import {packScenario} from './packFixtures.js';
const flat=Array.from({length:25},(_,i)=>({t:1704067200+i*60,o:100,h:101,l:99,c:100,v:10}));
describe('isolated eight-model replay',()=>{
 it('replays a confirmed limit through a stop and charges explicit costs',()=>{
  const f=packScenario('BREAKOUT-RETEST'),start=f.candles[0].t;
  const warm=Array.from({length:3000},(_,i)=>{const p=80+20*i/3000;return {t:start-(3000-i)*60,o:p,c:p,h:p+.01,l:p-.01,v:20};});
  const tail=Array.from({length:12},(_,i)=>({t:f.candles.at(-1)!.t+(i+1)*60,o:101,c:i<2?101:98,h:101.5,l:i<2?100.4:97,v:20}));
  const data=[...warm,...f.candles,...tail];
  const [r]=replay(data,'TEST_USDT',['BREAKOUT-RETEST']);
  expect(r.closed).toBe(1);expect(r.trades[0].pnl_r).toBe(-1);
  expect(r.trades[0].closed_at).toBeGreaterThan(r.trades[0].opened_at);
  expect(r.netUsd).toBeLessThan(-5);expect(r.maxDrawdownUsd).toBeCloseTo(-r.netUsd);
  const [free]=replay(data,'TEST_USDT',['BREAKOUT-RETEST'],{feeBps:0,slippageBps:0});
  expect(free.netUsd).toBe(-5);expect(free.trades[0].estimatedCostUsd).toBe(0);
 },20000);
 it('records gaps and rejects invalid cost settings',()=>{
  expect(replay([flat[0],flat[2]],'TEST_USDT',['MOD-01E'])[0].gaps).toBe(1);
  expect(()=>replay(flat,'TEST_USDT',ACTIVE_STRATEGIES,{feeBps:-1})).toThrow();
 });
 it('reports every active model deterministically without manufacturing warmup trades',()=>{
  const a=replay(flat,'TEST_USDT');expect(a.map(r=>r.strategy)).toEqual(ACTIVE_STRATEGIES);
  expect(a.every(r=>r.closed===0&&r.open.length===0&&r.winRate===null)).toBe(true);
  expect(replay(flat,'TEST_USDT')).toEqual(a);
 });
 it('rejects duplicates, reversed timestamps, malformed prices and unknown strategies',()=>{
  expect(()=>validateCandles([flat[0],flat[0]])).toThrow();
  expect(()=>validateCandles([...flat].reverse())).toThrow();
  expect(()=>validateCandles([{...flat[0],l:102}])).toThrow();
  expect(()=>replay(flat,'TEST_USDT',['INVALID' as never])).toThrow();
 });
 it('keeps future appended candles out of an earlier report',()=>{
  const data=emaScenario().candles;
  const before=replay(data.slice(0,100),'TEST_USDT',['EMA-PULLBACK']);
  replay(data.slice(0,120),'TEST_USDT',['EMA-PULLBACK']);
  expect(replay(data.slice(0,100),'TEST_USDT',['EMA-PULLBACK'])).toEqual(before);
 });
});
