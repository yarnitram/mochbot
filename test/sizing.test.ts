import { describe,it,expect,vi } from 'vitest';
import { computePositionSizing } from '../src/strategy/sizing.js';
import { Db } from '../src/db/index.js';
import { Runner } from '../src/engine/runner.js';
import { loadConfig } from '../src/config.js';
import { limitScenario } from './fixtures.js';

describe('risk-aligned pending limit sizing',()=>{
 it.each([['LONG',95],['SHORT',105]] as const)('keeps %s stop-loss exposure within the risk budget', (direction,sl)=>{
  const s=computePositionSizing(100,sl,direction==='LONG'?115:85,direction==='LONG'?125:75,direction,1000,5,50,.01);
  expect(s.leverage).toBe(17);
  expect(s.margin).toBe(5.8823);
  expect(s.notional).toBe(s.margin*s.leverage);
  expect(Math.abs(s.slRiskUsd)).toBeLessThanOrEqual(5);
  expect(Math.abs(s.slRiskUsd)).toBeGreaterThan(4.99);
 });
 it('uses full contract max leverage when alwaysMaxLeverage is enabled', () => {
  const clamped = computePositionSizing(100, 95, 115, 125, 'LONG', 1000, 5, 200, 0.01, false);
  expect(clamped.leverage).toBe(17);
  expect(clamped.margin).toBe(5.8823);

  const maxed = computePositionSizing(100, 95, 115, 125, 'LONG', 1000, 5, 200, 0.01, true);
  expect(maxed.leverage).toBe(200);
  expect(maxed.margin).toBe(0.5);
  expect(Math.abs(maxed.slRiskUsd)).toBeCloseTo(5, 2);
 });
 it('uses more margin at lower contract leverage without increasing stop-loss risk',()=>{
  const low=computePositionSizing(100,99,103,105,'LONG',1000,5,5);
  const high=computePositionSizing(100,99,103,105,'LONG',1000,5,50);
  expect(low.leverage).toBe(5);expect(high.leverage).toBe(50);
  expect(low.margin).toBeGreaterThan(high.margin);
  expect(low.slRiskUsd).toBeCloseTo(high.slRiskUsd,4);
 });
 it('caps margin at capital and reports the actual smaller risk',()=>{
  const s=computePositionSizing(100,99,103,105,'LONG',1,5,5);
  expect(s.margin).toBe(1);
  expect(s.riskPerTrade).toBe(5);
  expect(Math.abs(s.slRiskUsd)).toBeCloseTo(.05,8);
 });
 it('does not force a minimum margin that exceeds a small risk budget',()=>{
  const s=computePositionSizing(100,90,130,150,'LONG',1000,.1,50);
  expect(s.margin).toBeLessThan(.13);
  expect(Math.abs(s.slRiskUsd)).toBeLessThanOrEqual(.1);
  expect(()=>computePositionSizing(100,100,103,105,'LONG')).toThrow();
 });
 it('persists sizing before the limit touches and updates pending sizing after risk changes',()=>{
  const {candles,bias,cfg:strategy}=limitScenario();
  const clock=vi.spyOn(Date,'now').mockReturnValue(candles[1770].t*1000);
  const db=new Db(':memory:');
  const cfg=loadConfig({PAPER_MODE:'true',USE_KILLZONE:'false',DB_PATH:':memory:'});
  const runner=new Runner({cfg,db,feed:{subscribe(){},unsubscribe(){}},fetchKlines:async()=>[],fetchContracts:async()=>[],notifiers:[],log:()=>{}});
  try{
   db.addWatch('TEST_USDT');db.setStrategyCfg('MOD-01E',strategy);
   runner.contracts=[{symbol:'TEST_USDT',baseCoin:'TEST',quoteCoin:'USDT',priceUnit:.001,state:0,maxLeverage:10}];
   runner.htf1h.set('TEST_USDT',bias);
   runner.store.setHistory('TEST_USDT',candles.slice(0,1770));
   runner.store.ingest('TEST_USDT',candles[1770]);
   const initial=runner.evaluateSymbol('TEST_USDT')!;
   expect(initial.stage).toBe('ARMED');expect(initial.sizing?.leverage).toBeLessThanOrEqual(10);
   expect(Math.abs(initial.sizing!.slRiskUsd)).toBeLessThanOrEqual(5);
   const saved=JSON.parse(db.listLimitOrders()[0].payload);
   expect(saved.sizing).toEqual(initial.sizing);
   db.setRiskPerTrade(10);runner.reEvaluateAll();
   const updated=JSON.parse(db.listLimitOrders()[0].payload);
   expect(updated.sizing.riskPerTrade).toBe(10);
   expect(Math.abs(updated.sizing.slRiskUsd)).toBeLessThanOrEqual(10);
   expect(updated.sizing.margin).toBeCloseTo(initial.sizing!.margin*2,3);
  }finally{runner.stop();db.close();clock.mockRestore()}
 });
});
