import {describe,it,expect,vi} from 'vitest';
import {Db} from '../src/db/index.js';
import {Runner} from '../src/engine/runner.js';
import {loadConfig} from '../src/config.js';
import {DISCOVERY_DEFAULTS} from '../src/discovery.js';

describe('adjustable category discovery sizes',()=>{
 it('requests the expanded defaults and respects saved per-category values',async()=>{
  const db=new Db(':memory:');
  const volume=vi.fn(async(_limit:number)=>[]),memes=vi.fn(async(_limit:number)=>[]),ai=vi.fn(async(_limit:number)=>[]),gaming=vi.fn(async(_limit:number)=>[]);
  const gainers=vi.fn(async(_min:number,_limit:number)=>[]),losers=vi.fn(async(_min:number,_limit:number)=>[]);
  const runner=new Runner({cfg:loadConfig({PAPER_MODE:'true',DB_PATH:':memory:'}),db,feed:{subscribe(){},unsubscribe(){}},fetchKlines:async()=>[],fetchContracts:async()=>[],notifiers:[],log:()=>{},
    fetchTopVolumePerps:volume,fetchTopMemePerps:memes,fetchTopAiPerps:ai,fetchTopGamePerps:gaming,fetchTopGainers:gainers,fetchTopLosers:losers});
  try{
   expect(runner.maxActiveCoins).toBe(300);expect(runner.discoveryLimits).toEqual(DISCOVERY_DEFAULTS);
   for(const key of ['auto_scanner','meme_scanner','ai_scanner','game_scanner','gainers_scanner','losers_scanner'])db.setSetting(key,'1');
   await runner.runAutoScan();
   expect(volume).toHaveBeenLastCalledWith(100);expect(memes).toHaveBeenLastCalledWith(100);
   expect(ai).toHaveBeenLastCalledWith(70);expect(gaming).toHaveBeenLastCalledWith(70);
   expect(gainers).toHaveBeenLastCalledWith(5_000_000,50);expect(losers).toHaveBeenLastCalledWith(5_000_000,50);
   db.setSetting('volume_limit','200');db.setSetting('gainers_limit','100');db.setSetting('max_active_coins','150');
   await runner.runAutoScan();expect(volume).toHaveBeenLastCalledWith(200);expect(gainers).toHaveBeenLastCalledWith(5_000_000,100);
   expect(runner.maxActiveCoins).toBe(150);
   db.setSetting('ai_limit','NaN');expect(runner.discoveryLimits.ai_limit).toBe(70);
  }finally{runner.stop();db.close()}
 });
});
