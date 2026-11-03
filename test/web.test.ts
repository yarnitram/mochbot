import { describe,it,expect } from 'vitest';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync,rmSync } from 'node:fs';
import { startWeb } from '../src/web/server.js';
import { Db } from '../src/db/index.js';
import { Runner } from '../src/engine/runner.js';
import { loadConfig } from '../src/config.js';

describe('Limit Desk HTTP integration',()=>{
 it('serves the new dashboard, enforces authentication and validates strategy settings',async()=>{
  const db=new Db(':memory:');
  const cfg=loadConfig({PORT:'0',DASHBOARD_PASSWORD:'test-only',PAPER_MODE:'true'});
  const runner=new Runner({cfg,db,feed:{subscribe(){},unsubscribe(){}},fetchKlines:async()=>[],fetchContracts:async()=>[],notifiers:[]});
  const server=startWeb(runner,db,cfg,join(process.cwd(),'web'));
  await once(server,'listening');
  const address=server.address() as {port:number};
  const url=`http://127.0.0.1:${address.port}`;
  const headers={authorization:`Basic ${Buffer.from('user:test-only').toString('base64')}`,'content-type':'application/json'};
  try{
   expect((await fetch(url+'/api/state')).status).toBe(401);
   const html=await(await fetch(url,{headers})).text();
   expect(html).toContain('Mochbot · Limit Desk');
   for(const path of ['/desk.js','/desk.css','/legacy.html','/api/health','/api/orders']) expect((await fetch(url+path,{headers})).status).toBe(200);
   const strategies=await(await fetch(url+'/api/strategies',{headers})).json() as any;
   expect(strategies.strategies.map((s:any)=>s.id)).toEqual(['MOD-01E']);
   expect((await fetch(url+'/api/strategies/settings',{method:'POST',headers,body:JSON.stringify({mod01e:{entryFib:2}})})).status).toBe(400);
   expect((await fetch(url+'/api/strategies/settings',{method:'POST',headers,body:JSON.stringify({mod01e:{entryFib:.5,useKillzone:false}})})).status).toBe(200);
   expect(runner.mod01eCfg('').entryFib).toBe(.5);
   expect(runner.killzoneGlobal).toBe(false);
   expect((await fetch(url+'/api/strategies/MOD-01/settings',{method:'POST',headers,body:'{}'})).status).toBe(400);
   const plan={symbol:'BTC_USDT',setupId:'pending',orderStatus:'PENDING',stage:'ARMED',direction:'LONG',ts:100,
     entry:100,sl:95,tp1:115,tp2:125,expiresAt:9999999999};
   db.saveLimitOrder({...plan} as any);
   db.saveLimitOrder({...plan,setupId:'completed',orderStatus:'TOUCHED',sizing:runner.sizeSetup(plan as any)} as any);
   const settings=await fetch(url+'/api/settings',{method:'POST',headers,body:JSON.stringify({risk_per_trade:10})});
   expect(settings.status).toBe(200);
   const orders=await(await fetch(url+'/api/orders',{headers})).json() as any[];
   const pending=orders.find(o=>o.setup_id==='pending').payload;
   const completed=orders.find(o=>o.setup_id==='completed').payload;
   expect(pending.sizing.riskPerTrade).toBe(10);
   expect(Math.abs(pending.sizing.slRiskUsd)).toBeLessThanOrEqual(10);
   expect(completed.sizing.riskPerTrade).toBe(5);
   const id=db.createTrade({symbol:'LIVE_USDT',direction:'LONG',entry_price:100,sl_price:95,tp1_price:115,tp2_price:125,
     setup_id:'live-setup',margin:10,leverage:10,notional:100,strategy_id:'MOD-01E'});
   let snapshot=await(await fetch(url+'/api/state',{headers})).json() as any;
   expect(snapshot.activeTrades[0].currentPnlUsd).toBeNull();
   expect(snapshot.activeTrades[0].quoteStatus).toBe('UNAVAILABLE');
   runner.states.set('LIVE_USDT',{price:110} as any);
   const now=Math.floor(Date.now()/60000)*60;
   runner.store.ingest('LIVE_USDT',{t:now,o:110,h:110,l:110,c:110,v:1});
   runner.lastTick.set('LIVE_USDT',Date.now());
   snapshot=await(await fetch(url+'/api/state',{headers})).json() as any;
   expect(snapshot.activeTrades[0].id).toBe(id);
   expect(snapshot.activeTrades[0].quoteStatus).toBe('LIVE');
   expect(snapshot.activeTrades[0].currentPnlUsd).toBe(10);
   runner.lifecycle.onPrice('LIVE_USDT',{t:now,o:115,h:115,l:115,c:115,v:1});
   runner.states.set('LIVE_USDT',{price:120} as any);
   snapshot=await(await fetch(url+'/api/state',{headers})).json() as any;
   expect(snapshot.activeTrades[0].realizedPnlUsd).toBe(7.5);
   expect(snapshot.activeTrades[0].currentPnlUsd).toBe(17.5);
   runner.lastTick.set('LIVE_USDT',Date.now()-100_000);
   snapshot=await(await fetch(url+'/api/state',{headers})).json() as any;
   expect(snapshot.activeTrades[0].quoteStatus).toBe('STALE');
   runner.lifecycle.onPrice('LIVE_USDT',{t:now+60,o:125,h:125,l:125,c:125,v:1});
   snapshot=await(await fetch(url+'/api/state',{headers})).json() as any;
   expect(snapshot.activeTrades).toHaveLength(0);
   const journal=await(await fetch(url+'/api/trades',{headers})).json() as any;
   expect(journal.history[0].id).toBe(id);
   expect(journal.history[0].pnl_usd).toBe(20);
  }finally{runner.stop();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));db.close()}
 });
 it('retains SQLite order plans after reopening the database',()=>{
  const dir=mkdtempSync(join(tmpdir(),'mochbot-restart-'));
  const path=join(dir,'test.db');
  try{
   let db=new Db(path);
   db.saveLimitOrder({symbol:'BTC_USDT',setupId:'01E:LONG:123',orderStatus:'PENDING',ts:100,entry:100,sl:99,tp1:103,tp2:105,expiresAt:500} as any);
   db.close();db=new Db(path);
   expect(db.listLimitOrders()[0].status).toBe('PENDING');
   db.reconcileLimitOrders({symbol:'BTC_USDT',setupId:null,ts:600} as any);
   expect(db.listLimitOrders()[0].status).toBe('EXPIRED');
   expect(JSON.parse(db.listLimitOrders()[0].payload).entry).toBe(100);
   db.close();
  }finally{rmSync(dir,{recursive:true,force:true})}
 });
});
