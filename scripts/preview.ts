/** Isolated dashboard preview: synthetic candles, in-memory database, no exchange or notification calls. */
import { startWeb } from '../src/web/server.js';
import { Db } from '../src/db/index.js';
import { Runner } from '../src/engine/runner.js';
import { loadConfig } from '../src/config.js';
import { limitScenario,emaScenario,turtleScenario } from '../test/fixtures.js';
import { join } from 'node:path';
const cfg=loadConfig({PORT:process.env.PORT??'8788',DB_PATH:':memory:',PAPER_MODE:'true',USE_KILLZONE:'false'});
const db=new Db(':memory:');
const runner=new Runner({cfg,db,feed:{subscribe(){},unsubscribe(){}},fetchKlines:async()=>[],fetchContracts:async()=>[],notifiers:[],chartsDir:''});
const fixture=limitScenario();db.setStrategyCfg('MOD-01E',fixture.cfg);
for(const [symbol,count] of [['DEMO_PENDING_USDT',1770],['DEMO_TOUCH_USDT',1789],['DEMO_IDLE_USDT',100]] as const){
 const currentMinute=Math.floor(Date.now()/60000)*60;
 const offset=Math.floor((currentMinute-fixture.candles[count].t)/900)*900;
 const shift=(c:typeof fixture.candles[number])=>({...c,t:c.t+offset});
 db.addWatch(symbol);runner.htf1h.set(symbol,fixture.bias.map(shift));
 const history=fixture.candles.slice(0,count).map(shift);
 const head=shift(fixture.candles[count]);
 for(let t=head.t;t<currentMinute;t+=60)history.push({...head,t,o:head.c,h:head.c,l:head.c});
 runner.store.setHistory(symbol,history);
 runner.store.ingest(symbol,{...head,t:currentMinute,o:head.c,h:head.c,l:head.c});runner.lastTick.set(symbol,Date.now());runner.evaluateSymbol(symbol);
}
const emaFixture=emaScenario();
for(const [symbol,count] of [['DEMO_EMA_PENDING_USDT',920],['DEMO_EMA_TOUCH_USDT',925]] as const){
 const now=Math.floor(Date.now()/60000)*60;
 const offset=Math.floor((now-(emaFixture.candles[count]?.t??emaFixture.candles.at(-1)!.t+60))/900)*900;
 const shift=(c:typeof emaFixture.candles[number])=>({...c,t:c.t+offset});
 db.addWatch(symbol,false,'EMA-PULLBACK');runner.htf1h.set(symbol,emaFixture.bias.map(shift));
 const history=emaFixture.candles.slice(0,count).map(shift),last=history.at(-1)!;
 for(let t=last.t+60;t<now;t+=60)history.push({...last,t,o:last.c,h:last.c,l:last.c});
 runner.store.setHistory(symbol,history);runner.store.ingest(symbol,{...last,t:now,o:last.c,h:last.c,l:last.c});
 runner.lastTick.set(symbol,Date.now());runner.evaluateSymbol(symbol);
}
// Extra exposure allowance applies only to this isolated synthetic showcase.
db.setSetting('max_open_risk','50');
const turtleFixture=turtleScenario();
for(const [symbol,count] of [['DEMO_TURTLE_PENDING_USDT',75],['DEMO_TURTLE_TOUCH_USDT',80]]as const){
 const now=Math.floor(Date.now()/60000)*60;
 const sourceTime=turtleFixture.candles[count]?.t??turtleFixture.candles.at(-1)!.t+60;
 const offset=Math.floor((now-sourceTime)/300)*300;
 const shift=(c:typeof turtleFixture.candles[number])=>({...c,t:c.t+offset});
 db.addWatch(symbol,false,'TURTLE-SOUP');runner.htf1h.set(symbol,turtleFixture.history.map(shift));
 const history=turtleFixture.candles.slice(0,count).map(shift),last=history.at(-1)!;
 for(let t=last.t+60;t<now;t+=60)history.push({...last,t,o:last.c,h:last.c,l:last.c});
 runner.store.setHistory(symbol,history);runner.store.ingest(symbol,{...last,t:now,o:last.c,h:last.c,l:last.c});
 runner.lastTick.set(symbol,Date.now());runner.evaluateSymbol(symbol);
}
startWeb(runner,db,cfg,join(process.cwd(),'web'));
console.log(`Synthetic preview: http://localhost:${cfg.port}`);
