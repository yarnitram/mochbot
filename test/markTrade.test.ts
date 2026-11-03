import { describe,it,expect } from 'vitest';
import { markTrade } from '../src/engine/markTrade.js';
import type { TradeRow } from '../src/db/index.js';

const trade=(patch:Partial<TradeRow>={}):TradeRow=>({id:1,symbol:'TEST_USDT',direction:'LONG',entry_price:100,
 sl_price:95,initial_sl_price:95,tp1_price:115,tp2_price:125,status:'OPEN',opened_at:1,closed_at:null,pnl_r:null,
 pnl_usd:null,margin:10,leverage:10,notional:100,strategy_id:'MOD-01E',setup_id:'test',chart_file:null,...patch});

describe('live simulated trade marks',()=>{
 it('shows long profit, return on entry margin and target progress',()=>{
  const mark=markTrade(trade(),110);
  expect(mark.currentPnlUsd).toBe(10);expect(mark.unrealizedPnlUsd).toBe(10);
  expect(mark.realizedPnlUsd).toBe(0);expect(mark.currentR).toBe(2);expect(mark.currentPnlPct).toBe(100);
  expect(mark.targetProgressPct).toBeCloseTo(66.67);expect(mark.nextTarget).toBe('TP1');
 });
 it('reverses the profit sign for short positions',()=>{
  const short=trade({direction:'SHORT',sl_price:105,initial_sl_price:105,tp1_price:85,tp2_price:75});
  expect(markTrade(short,90).currentPnlUsd).toBe(10);
  expect(markTrade(short,105).currentPnlUsd).toBe(-5);
  expect(markTrade(short,105).targetProgressPct).toBe(0);
 });
 it('counts secured TP1 profit once and only marks the remaining half',()=>{
  const mark=markTrade(trade({status:'TP1_HIT',sl_price:100}),120);
  expect(mark.realizedPnlUsd).toBe(7.5);expect(mark.unrealizedPnlUsd).toBe(10);
  expect(mark.currentPnlUsd).toBe(17.5);expect(mark.currentR).toBe(3.5);
  expect(mark.currentPnlPct).toBe(175);expect(mark.remainingPct).toBe(50);expect(mark.nextTarget).toBe('TP2');
  expect(markTrade(trade({status:'TP1_HIT',sl_price:100}),100).currentPnlUsd).toBe(7.5);
 });
 it('does not fabricate a flat P&L when a quote is unavailable',()=>{
  const mark=markTrade(trade({status:'TP1_HIT',sl_price:100}),null);
  expect(mark.currentPrice).toBeNull();expect(mark.currentPnlUsd).toBeNull();
  expect(mark.unrealizedPnlUsd).toBeNull();expect(mark.currentR).toBeNull();
  expect(mark.realizedPnlUsd).toBe(7.5);
  expect(markTrade(trade(),NaN).currentPnlUsd).toBeNull();
 });
});
