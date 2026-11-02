/**
 * Replay MOD-01 on recent MEXC 1m history and print every entry signal, for side-by-side comparison
 * with the Pine strategy (phantom_smc_strategy.pine) on the same symbol / 1m chart.
 *
 * usage: npm run replay -- BTC_USDT [bars=1500] [killzone=on|off]
 */
import { fetchKlines } from '../src/mexc/rest.js';
import { scan } from '../src/strategy/mod01.js';
import { DEFAULT_CFG } from '../src/types.js';

const symbol = (process.argv[2] ?? 'BTC_USDT').toUpperCase();
const bars = Number(process.argv[3] ?? 1500);
const kz = (process.argv[4] ?? 'on') === 'on';

const candles = (await fetchKlines(symbol, 'Min1', bars)).slice(0, -1); // drop the forming candle
const r = scan(candles, { ...DEFAULT_CFG, useKillzone: kz });
console.log(`${symbol}: ${candles.length} bars, ${r.zones.length} POIs (${r.zones.filter(z => !z.invalidated).length} alive), killzone=${kz}`);
for (const z of r.zones) console.log(`  ${z.isDemand ? 'DEMAND' : 'SUPPLY'} ${z.bottom} - ${z.top} base=${new Date(z.startTime * 1000).toISOString()} ${z.invalidated ? '(invalidated)' : ''}`);
console.log(`signals: ${r.signals.length}`);
for (const s of r.signals) {
  console.log(`  ${new Date(s.time * 1000).toISOString()} ${s.direction} entry=${s.entry} sl=${s.sl} tp1=${s.tp1} tp2=${s.tp2}`);
}
