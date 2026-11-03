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
