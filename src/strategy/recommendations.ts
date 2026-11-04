import {DEFAULT_MOD01E_CFG,DEFAULT_EMA_CFG,DEFAULT_TURTLE_CFG,type ActiveStrategyId,type PackStrategyId} from '../types.js';
import {packDefaults} from './strategyPack.js';

const PACK_TIPS:Record<PackStrategyId,string>={
  'OPENING-RANGE':'UTC session starts 13:00 (21:00 UTC+8); opening range 30 minutes; session lasts 180 minutes. Volume ≥1.2× average; retest within six bars; 2R / 3R targets. This fixed UTC session does not shift with daylight saving.',
  'BREAKOUT-RETEST':'Use the prior 20 confirmation bars, volume ≥1.2× average, 0.1 ATR breakout buffer and a six-bar retest window; 2R / 3R targets.',
  'VWAP-RECLAIM':'Use the complete UTC daily VWAP session from 00:00, volume ≥1.2× average, and 2R / 3R targets. Orders expire no later than UTC midnight.',
  'BOLLINGER-RANGE':'Use 20-bar bands at 2σ, maximum range efficiency 0.35, RSI14 and volume ≥1× average. Mean / opposite-band targets must offer at least 1R / 2R.',
  'RSI-DIVERGENCE':'Use RSI14, two bars on each side of a confirmed pivot, ≥5 RSI-point divergence, 40-bar pivot lookback, six-bar neckline deadline and volume ≥1.2× average; 2R / 3R targets.'
};
function packRecommendation(id:PackStrategyId){return {
  summary:'Start with 4H context / 15m confirmation; six-bar (90-minute) expiry, 0.2 ATR stop buffer, 0.5–3 ATR stop distance and minimum 0.15% price distance. '+PACK_TIPS[id],
  config:{...packDefaults(id),timeframePreset:'4H/15m'}
}}

/** Product starting presets for paper testing; these are not optimized or validated market results. */
export const STRATEGY_RECOMMENDATIONS:Record<ActiveStrategyId,{summary:string;config:Record<string,unknown>}>= {
  'MOD-01E':{summary:'Start with 1H bias / 15m alignment and CHoCH / 5m execution, 0.618 Fib, 0.15 ATR stop buffer, 3R / 5R targets, and an 18 × 5m (90-minute) expiry. UTC session filter on. Structural stops still determine the actual price distance.',config:{...DEFAULT_MOD01E_CFG}},
  'EMA-PULLBACK':{summary:'Slower starting preset: 4H trend → 1H EMA20/50 pullback → 15m confirmation → 50% candle limit. Stop buffer 0.2 ATR; TP1 2R / TP2 3R; six confirmation bars (90 minutes) expiry.',config:{...DEFAULT_EMA_CFG,timeframePreset:'4H/1H/15m'}},
  'TURTLE-SOUP':{summary:'Slower starting preset: prior 20 completed 4H bars / 15m sweep and reclaim, boundary retest entry, minimum 0.1 ATR sweep, 0.2 ATR stop buffer. TP1 midpoint ≥1R; TP2 opposite edge ≥2R. Six-bar (90-minute) expiry.',config:{...DEFAULT_TURTLE_CFG,timeframePreset:'4H/15m'}},
  'OPENING-RANGE':packRecommendation('OPENING-RANGE'),
  'BREAKOUT-RETEST':packRecommendation('BREAKOUT-RETEST'),
  'VWAP-RECLAIM':packRecommendation('VWAP-RECLAIM'),
  'BOLLINGER-RANGE':packRecommendation('BOLLINGER-RANGE'),
  'RSI-DIVERGENCE':packRecommendation('RSI-DIVERGENCE'),
};
