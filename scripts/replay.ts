import {readFileSync,writeFileSync} from 'node:fs';
import {replay} from '../src/research/replay.js';
import {ACTIVE_STRATEGIES,type ActiveStrategyId,type Candle} from '../src/types.js';
const input = process.argv[2];
if (!input || /^[A-Za-z0-9]+_USDT$/i.test(input)) {
  await import('./replayLegacy.js');
} else {
  const [file,symbol='BTC_USDT',selection='ALL',output,settings]=process.argv.slice(2);
  const options=settings?JSON.parse(readFileSync(settings,'utf8')):{};
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['capital','risk','feeBps','slippageBps','preset','warmupBars','historyBars'].includes(k)))throw Error('Invalid options file');
  const reports=replay(JSON.parse(readFileSync(file!,'utf8')) as Candle[],symbol,selection==='ALL'?ACTIVE_STRATEGIES:[selection as ActiveStrategyId],options);
  console.table(reports.map(({strategy,closed,netUsd,winRate,profitFactor,maxDrawdownUsd})=>({strategy,closed,netUsd,winRate,profitFactor,maxDrawdownUsd})));
  if(output)writeFileSync(output,JSON.stringify(reports,null,2)+'\n');
}
