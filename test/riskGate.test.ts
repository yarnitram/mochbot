import {describe,it,expect} from 'vitest';
import {Db} from '../src/db/index.js';
import {assessSharedRisk} from '../src/engine/riskGate.js';
import {computePositionSizing} from '../src/strategy/sizing.js';
import type {Setup} from '../src/types.js';
import {AlertGate} from '../src/engine/alertGate.js';

const plan=(symbol:string,id:string,strategy:Setup['strategyId']='MOD-01E'):Setup=>({symbol,setupId:id,strategyId:strategy,stage:'ARMED',orderStatus:'PENDING',direction:'LONG',
 entry:100,sl:99,tp1:102,tp2:103,price:101,zone:null,distanceAtr:null,needBreak:null,barsSinceTap:null,orderType:'LIMIT',
 orderNote:null,killzone:true,atrHtf:1,atrLtf:1,ts:Math.floor(Date.now()/1000),expiresAt:Math.floor(Date.now()/1000)+600,
 sizing:computePositionSizing(100,99,102,103,'LONG',1000,5,50)});

describe('shared strategy exposure',()=>{
 it('does not let one strategy suppress the other strategy watch alert cooldown',()=>{
  const gate=new AlertGate();
  expect(gate.shouldAlert({...plan('X','X:01E:WATCH:1'),stage:'WATCH'},0)).toBe(true);
  expect(gate.shouldAlert({...plan('X','X:EMA:WATCH:1','EMA-PULLBACK'),stage:'WATCH'},1)).toBe(true);
  expect(gate.shouldAlert({...plan('X','X:EMA:WATCH:2','EMA-PULLBACK'),stage:'WATCH'},2)).toBe(false);
 });
 it('blocks another strategy on a reserved coin, but not its own pending setup',()=>{
  const db=new Db(':memory:');try{
   const first=plan('BTC_USDT','one');db.saveLimitOrder(first);
   expect(assessSharedRisk(db,first,15)).toBeNull();
   const second=plan('BTC_USDT','two','EMA-PULLBACK');
   expect(assessSharedRisk(db,second,15)).toContain('Another strategy');
  }finally{db.close()}
 });
 it('counts all pending/active stop risk and prevents retrospective entry of blocked setups',()=>{
  const db=new Db(':memory:');try{
   db.saveLimitOrder(plan('BTC_USDT','one'));
   const second=plan('ETH_USDT','two','EMA-PULLBACK');
   expect(assessSharedRisk(db,second,5)).toContain('risk cap');
   expect(assessSharedRisk(db,second,10)).toBeNull();
   db.saveLimitOrder({...second,stage:'IDLE',orderStatus:'BLOCKED'});
   expect(assessSharedRisk(db,{...second,stage:'ENTRY_READY',orderStatus:'TOUCHED'},100)).toContain('blocked');
  }finally{db.close()}
 });
 it('keeps active same-coin exposure protected and ignores expired pending reservations',()=>{
  const db=new Db(':memory:');try{
   db.saveLimitOrder({...plan('ETH_USDT','expired'),expiresAt:1});
   expect(assessSharedRisk(db,plan('SOL_USDT','new'),5)).toBeNull();
   db.createTrade({symbol:'BTC_USDT',direction:'LONG',entry_price:100,sl_price:99,tp1_price:102,tp2_price:103,notional:500,margin:10,leverage:50,setup_id:'active'});
   expect(assessSharedRisk(db,plan('BTC_USDT','new','EMA-PULLBACK'),100)).toContain('active trade');
   expect(assessSharedRisk(db,plan('SOL_USDT','new'),5)).toContain('risk cap');
  }finally{db.close()}
 });
 it('does not invalidate the other strategy ledger during reconciliation',()=>{
  const db=new Db(':memory:');try{
   db.saveLimitOrder(plan('BTC_USDT','one'));
   db.reconcileLimitOrders({...plan('BTC_USDT','ema','EMA-PULLBACK'),stage:'IDLE',orderStatus:undefined});
   expect(db.listLimitOrders()[0].status).toBe('PENDING');
  }finally{db.close()}
 });
});
