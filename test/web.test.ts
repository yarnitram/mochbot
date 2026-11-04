import { describe,it,expect } from 'vitest';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync,rmSync } from 'node:fs';
import { startWeb } from '../src/web/server.js';
import { Db } from '../src/db/index.js';
import { Runner } from '../src/engine/runner.js';
import { loadConfig } from '../src/config.js';
import { ACTIVE_STRATEGIES,encodeStrategies,resolveStrategies } from '../src/types.js';
import { PACK_DEFINITIONS } from '../src/strategy/strategyPack.js';

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
   expect(strategies.strategies.map((s:any)=>s.id)).toEqual(ACTIVE_STRATEGIES);
   for(const s of strategies.strategies){expect(s.recommended.summary).toBeTruthy();expect(Object.keys(s.recommended.config)).toEqual(Object.keys(s.config));}
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
   expect((await fetch(url+'/api/strategies/EMA-PULLBACK/settings',{method:'POST',headers,body:JSON.stringify({entryRatio:.382,orderExpiry:8})})).status).toBe(200);
   expect(runner.emaCfg().entryRatio).toBe(.382);expect(runner.emaCfg().orderExpiry).toBe(8);
   expect((await fetch(url+'/api/strategies/EMA-PULLBACK/settings',{method:'POST',headers,body:JSON.stringify({fastLength:60,slowLength:20})})).status).toBe(400);
   db.addWatch('BTC_USDT');
   expect((await fetch(url+'/api/strategies/settings',{method:'POST',headers,body:JSON.stringify({globalStrategy:'BOTH',applyToWatchlist:true})})).status).toBe(200);
   expect(db.getGlobalStrategy()).toBe('BOTH');expect(db.listWatch()[0].strategy).toBe('BOTH');
   expect((await fetch(url+'/api/watchlist/BTC_USDT',{method:'PATCH',headers,body:JSON.stringify({strategy:'EMA-PULLBACK'})})).status).toBe(200);
   expect(db.listWatch()[0].strategy).toBe('EMA-PULLBACK');
   expect((await fetch(url+'/api/watchlist/BTC_USDT',{method:'PATCH',headers,body:JSON.stringify({strategy:'INVALID'})})).status).toBe(400);
   snapshot=await(await fetch(url+'/api/state',{headers})).json() as any;
   expect(snapshot.watchlist[0].setups[0].strategyId).toBe('EMA-PULLBACK');
   expect(snapshot.strategyPerformance.map((s:any)=>s.id)).toEqual(ACTIVE_STRATEGIES);
   expect((await fetch(url+'/api/settings',{method:'POST',headers,body:JSON.stringify({max_open_risk:-1})})).status).toBe(400);
   expect((await fetch(url+'/api/strategies/EMA-PULLBACK/settings',{method:'POST',headers,body:JSON.stringify({timeframePreset:'4H/1H/15m'})})).status).toBe(200);
   expect(runner.emaCfg().timeframePreset).toBe('4H/1H/15m');
   expect((await fetch(url+'/api/strategies/EMA-PULLBACK/settings',{method:'POST',headers,body:JSON.stringify({timeframePreset:'1D/4H/1H'})})).status).toBe(400);
   expect((await fetch(url+'/api/strategies/EMA-PULLBACK/settings',{method:'POST',headers,body:JSON.stringify({timeframePreset:'1H/15m/5m'})})).status).toBe(200);
   expect(runner.emaCfg().timeframePreset).toBe('1H/15m/5m');
   expect((await fetch(url+'/api/settings',{method:'POST',headers,body:JSON.stringify({volume_limit:200,gainers_limit:100,max_active_coins:400})})).status).toBe(200);
   expect(runner.discoveryLimits.volume_limit).toBe(200);expect(runner.discoveryLimits.gainers_limit).toBe(100);expect(runner.maxActiveCoins).toBe(400);
   for(const bad of [0,501,1.5,'100',null]){
    expect((await fetch(url+'/api/settings',{method:'POST',headers,body:JSON.stringify({volume_limit:bad,auto_scanner:true})})).status).toBe(400);
    expect(runner.autoScannerEnabled).toBe(false);expect(runner.discoveryLimits.volume_limit).toBe(200);
   }
   expect((await fetch(url+'/api/settings',{method:'POST',headers,body:JSON.stringify({max_active_coins:1001})})).status).toBe(400);
   expect((await fetch(url+'/api/strategies/TURTLE-SOUP/settings',{method:'POST',headers,body:JSON.stringify({lookbackBars:25,timeframePreset:'4H/15m'})})).status).toBe(200);
   expect(runner.turtleCfg().lookbackBars).toBe(25);expect(runner.turtleCfg().timeframePreset).toBe('4H/15m');
   expect((await fetch(url+'/api/strategies/TURTLE-SOUP/settings',{method:'POST',headers,body:JSON.stringify({lookbackBars:0})})).status).toBe(400);
   expect((await fetch(url+'/api/strategies/settings',{method:'POST',headers,body:JSON.stringify({globalStrategy:'ALL',applyToWatchlist:true})})).status).toBe(200);
   expect(db.getGlobalStrategy()).toBe('ALL');expect(runner.strategyStates.get('BTC_USDT')?.size).toBe(8);
   expect((await fetch(url+'/api/watchlist/BTC_USDT',{method:'PATCH',headers,body:JSON.stringify({strategy:'TURTLE-SOUP'})})).status).toBe(200);
   expect(db.listWatch()[0].strategy).toBe('TURTLE-SOUP');
   for(const d of PACK_DEFINITIONS){
    const route=url+`/api/strategies/${d.id}/settings`;
    expect((await fetch(route,{method:'POST',headers,body:JSON.stringify({orderExpiry:8,timeframePreset:'4H/15m'})})).status).toBe(200);
    expect(runner.packCfg(d.id).orderExpiry).toBe(8);expect(runner.packCfg(d.id).timeframePreset).toBe('4H/15m');
    expect((await fetch(route,{method:'POST',headers,body:JSON.stringify({rrTP2:0})})).status).toBe(400);
    expect(runner.packCfg(d.id).rrTP2).toBe(d.defaults.rrTP2);
    expect((await fetch(url+'/api/strategies/settings',{method:'POST',headers,body:JSON.stringify({globalStrategy:d.id,applyToWatchlist:true})})).status).toBe(200);
    expect(db.getGlobalStrategy()).toBe(d.id);expect(db.listWatch()[0].strategy).toBe(d.id);
    snapshot=await(await fetch(url+'/api/state',{headers})).json() as any;
    expect(snapshot.watchlist[0].setups.map((s:any)=>s.strategyId)).toEqual([d.id]);
   }
   const chosen=['EMA-PULLBACK','TURTLE-SOUP','RSI-DIVERGENCE'];
   expect((await fetch(url+'/api/strategies/settings',{method:'POST',headers,body:JSON.stringify({globalStrategies:chosen,applyToWatchlist:true})})).status).toBe(200);
   const saved=db.getGlobalStrategy();expect(saved).toBe(encodeStrategies(chosen));expect(db.listWatch()[0].strategy).toBe(saved);
   snapshot=await(await fetch(url+'/api/state',{headers})).json() as any;
   expect(snapshot.globalStrategies).toEqual(chosen);expect(snapshot.watchlist[0].setups.map((s:any)=>s.strategyId)).toEqual(chosen);
   for(const invalid of [[],['UNKNOWN'],['EMA-PULLBACK','EMA-PULLBACK'],'ALL',null]){
    expect((await fetch(url+'/api/strategies/settings',{method:'POST',headers,body:JSON.stringify({globalStrategies:invalid,mod01e:{entryFib:.382},applyToWatchlist:true})})).status).toBe(400);
    expect(db.getGlobalStrategy()).toBe(saved);expect(runner.mod01eCfg('').entryFib).toBe(.5);
   }
   expect((await fetch(url+'/api/strategies/settings',{method:'POST',headers,body:JSON.stringify({globalStrategies:chosen,globalStrategy:'ALL'})})).status).toBe(400);
   expect((await fetch(url+'/api/strategies/settings',{method:'POST',headers,body:JSON.stringify({globalStrategies:['MOD-01E'],applyToWatchlist:false})})).status).toBe(200);
   expect(db.getGlobalStrategy()).toBe('MOD-01E');expect(db.listWatch()[0].strategy).toBe(saved);
   expect((await fetch(url+'/api/watchlist/BTC_USDT',{method:'PATCH',headers,body:JSON.stringify({strategy:encodeStrategies(['VWAP-RECLAIM','BOLLINGER-RANGE'])})})).status).toBe(200);
   expect(resolveStrategies(db.listWatch()[0].strategy)).toEqual(['VWAP-RECLAIM','BOLLINGER-RANGE']);
  }finally{runner.stop();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));db.close()}
 });
 it('retains SQLite order plans after reopening the database',()=>{
  const dir=mkdtempSync(join(tmpdir(),'mochbot-restart-'));
  const path=join(dir,'test.db');
  try{
   let db=new Db(path);
   const selection=encodeStrategies(['VWAP-RECLAIM','BOLLINGER-RANGE']);db.setGlobalStrategy(selection);db.addWatch('BTC_USDT');
   db.setStrategyCfg('VWAP-RECLAIM',{orderExpiry:8,timeframePreset:'4H/15m'});
   db.saveLimitOrder({symbol:'BTC_USDT',setupId:'01E:LONG:123',orderStatus:'PENDING',ts:100,entry:100,sl:99,tp1:103,tp2:105,expiresAt:500} as any);
   db.close();db=new Db(path);
   expect(db.getGlobalStrategy()).toBe(selection);expect(db.listWatch()[0].strategy).toBe(selection);
   expect(db.getStrategyCfg('VWAP-RECLAIM')).toEqual({orderExpiry:8,timeframePreset:'4H/15m'});
   expect(db.listLimitOrders()[0].status).toBe('PENDING');
   db.reconcileLimitOrders({symbol:'BTC_USDT',setupId:null,ts:600} as any);
   expect(db.listLimitOrders()[0].status).toBe('EXPIRED');
   expect(JSON.parse(db.listLimitOrders()[0].payload).entry).toBe(100);
   db.close();
  }finally{rmSync(dir,{recursive:true,force:true})}
 });
});
