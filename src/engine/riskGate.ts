import type { Db } from '../db/index.js';
import type { Setup } from '../types.js';

export function assessSharedRisk(db:Db,setup:Setup,totalCap:number):string|null {
  if(!setup.setupId||!setup.sizing||!['PENDING','TOUCHED'].includes(setup.orderStatus??''))return null;
  const orders=db.listPendingLimitOrders(),active=db.getActiveTrades();
  if(active.some(t=>t.symbol===setup.symbol&&t.setup_id===setup.setupId))return null;
  if(db.isBlockedLimit(setup.symbol,setup.setupId))return 'This setup was blocked when it formed; wait for a new confirmation';
  if(active.some(t=>t.symbol===setup.symbol))return 'An active trade already reserves this coin across strategies';
  const otherOrders=orders.filter(o=>!(o.symbol===setup.symbol&&o.setup_id===setup.setupId));
  if(otherOrders.some(o=>o.symbol===setup.symbol))return 'Another strategy already reserves a pending limit on this coin';
  const activeRisk=active.reduce((sum,t)=>sum+(t.status==='TP1_HIT'?0:t.notional*Math.abs(t.entry_price-t.sl_price)/t.entry_price),0);
  const pendingRisk=otherOrders.reduce((sum,o)=>sum+Math.abs((JSON.parse(o.payload) as Setup).sizing?.slRiskUsd??db.getRiskPerTrade()),0);
  if(activeRisk+pendingRisk+Math.abs(setup.sizing.slRiskUsd)>totalCap+1e-8)return 'Shared open-risk cap reached across active trades and pending limits';
  const margin=active.reduce((sum,t)=>sum+t.margin,0)+otherOrders.reduce((sum,o)=>sum+((JSON.parse(o.payload) as Setup).sizing?.margin??0),0);
  if(margin+setup.sizing.margin>db.getAccountCapital()+1e-8)return 'Shared margin reservations exceed configured capital';
  return null;
}
