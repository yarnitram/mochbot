# Five experimental strategy rules

These are testable strategy hypotheses, not established “high probability” systems. Synthetic tests verify chronology and implementation, not profitability or real fill probability. Indicator education does not validate this combination of rules. Keep the existing MOD-01E default until a strategy is deliberately selected.

Settings → Strategy settings edits each strategy independently. Settings → Strategy selection uses eight checkboxes: choose any nonempty combination, then Save selection. Select all and Clear selection help edit the form; clearing cannot be saved. Apply to existing watchlist copies your combination to current coins; leave it unchecked to affect only new coins. The Market watch selector still supports one-coin overrides and displays saved custom combinations. Existing ALL and BOTH selections remain compatible. Priority follows the displayed catalog order, regardless of click order. Changing a new strategy's settings invalidates its pending plans; active simulated trades retain their levels.

## Recommended starting settings

Every strategy editor shows its starting recommendation and all recommended field values. **Load recommended settings** fills the form only; **Save strategy** applies it. It does not change capital, risk per trade, leverage rules, or the shared exposure cap. No presets are silently applied to existing installations. These are product starting points for paper testing; the slower presets do not imply a higher win rate or a guaranteed larger stop/target distance.

| Strategy | Starting timeframe / entry | Targets / expiry |
| --- | --- | --- |
| MOD-01E | 1H / 15m / 5m; 0.618 Fib; existing strict alignment and UTC sessions | 3R / 5R; 18 × 5m (90 min) |
| EMA Pullback | 4H / 1H / 15m; EMA20/50; 50% candle entry | 2R / 3R; 6 × 15m (90 min) |
| Turtle Soup | 20 completed 4H bars / 15m; reclaimed-boundary entry | Midpoint ≥1R / opposite edge ≥2R; 90 min |
| Opening Range | 4H / 15m; 13:00 UTC session; first 30-minute range; later boundary retest | 2R / 3R; 90 min, capped at session end |
| Breakout Retest | 4H / 15m; previous 20 confirmation bars; later boundary retest | 2R / 3R; 90 min |
| VWAP Reclaim | 4H / 15m; complete UTC daily session; frozen VWAP limit | 2R / 3R; 90 min, capped at midnight |
| Bollinger Range | 4H / 15m; bands 20/2σ; RSI14; max efficiency 0.35; 50% entry | Mean ≥1R / opposite band ≥2R; 90 min |
| RSI Divergence | 4H / 15m; RSI14; pivots 2/2; ≥5-point divergence; neckline break; 50% entry | 2R / 3R; 90 min |

The five new presets retain 0.2 ATR stop buffer, 0.5–3 ATR stop-distance bounds and a minimum 0.15% price distance. Relative volume is 1.2× the prior 20-bar mean (1× for Bollinger). Turtle uses 0.1 ATR minimum sweep and 0.2 ATR stop buffer; EMA uses 0.2 ATR buffer; MOD-01E retains 0.15 ATR buffer. Actual structural levels determine margin/leverage under the existing risk model. [Fidelity's strategy-testing guide](https://www.fidelity.com/research/backtesting/about.html) explains historical testing; its educational material does not validate these presets.

## Shared defaults

- Preset: 1H context / 5m confirmation, or 4H context / 15m confirmation. Require 50 completed reference candles and at least 40 completed confirmation candles. Larger lookbacks require more history.
- For trend strategies, the completed context close must be above EMA20 > EMA50 with EMA20 rising (long); shorts mirror. Context must be recent. Reversal strategies instead use the specific conditions below.
- Confirmation volume must be at least 1.2 × the previous 20 confirmation-bar mean; Bollinger defaults to 1 ×. No signal when baseline volume is zero.
- Only completed contiguous minute buckets can confirm. Limits begin after the confirmation closes. A subsequent completed minute touching entry simulates a fill. A minute reaching both entry and stop invalidates the plan; missing minutes invalidate pending plans.
- Stop beyond the pattern's extreme plus 0.2 confirmation ATR14; stop distance must be 0.5–3 ATR and at least 0.15% of entry. Limits must rest on the retracement side of confirmation close. These filters do not guarantee fees/slippage are covered.
- Trend and divergence targets default to 2R / 3R. Bollinger targets are structural, with minimum 1R / 2R. Limits expire after six confirmation bars (30 or 90 minutes), or sooner at a session boundary. Existing lifecycle takes half at TP1 and moves the rest to break-even.
- Notes record the exact levels, rule, stop buffer, reward multiples, and deadline. Shared dollar risk, capital reservations, and one admitted pending/active trade per coin apply across all strategies. Leverage remains determined by the existing risk sizing model.

## 1. Opening Range Breakout Retest (`OPENING-RANGE`)

Define a fixed crypto session at **13:00 UTC** (21:00 UTC+8). Freeze its first 30 minutes, then accept signals until 16:00 UTC. This is a configurable daily UTC convention, not a stock-market opening bell, and does not shift with daylight-saving time. The entire opening range must be present.

Long: trend aligned; a later candle closes above the range high by at least 0.1 ATR, body ≥0.5 ATR, volume filter passes, and close is no more than 1.5 ATR beyond the level. Within six bars, a **subsequent** candle retests within 0.15 ATR of the frozen high and closes bullish above it. Place a buy limit exactly at that high. Stop below the retest low, with at least 0.5 ATR below the level before the buffer. Reject a pre-confirmation close more than 0.35 ATR below the level or a trend disagreement. Shorts mirror at the low. One breakout attempt per session and direction; expires no later than session end.

## 2. Trend Breakout Retest (`BREAKOUT-RETEST`)

Use the previous **20 completed confirmation candles** as a frozen range. Apply the same trend, breakout-volume, body, extension, subsequent retest, and stop rules as Opening Range. This operates throughout the day and does not depend on a session opening. The breakout candle cannot define its own reference range.

## 3. UTC Session VWAP Reclaim (`VWAP-RECLAIM`)

Calculate cumulative `sum(((high + low + close) / 3) × volume) / sum(volume)` from 00:00 UTC. Require the complete uninterrupted session start and at least 20 confirmation candles. A rolling history missing midnight cannot substitute for a session VWAP.

Long: trend aligned; previous close at/below its VWAP, then a bullish volume-supported candle closes more than 0.1 ATR above current VWAP. Freeze that VWAP as the buy-limit level. Stop below the two-candle low plus buffer. Shorts mirror. Cancel unfilled orders at the next UTC midnight or on context disagreement.

## 4. Bollinger Range Reversal (`BOLLINGER-RANGE`)

Use the prior 20 close prices for SMA and population standard deviation bands at 2σ; freeze these targets before the rejection candle. Require local efficiency `abs(last close − first close) / sum(abs(close changes)) ≤ 0.35` and context EMA20/50 separation ≤0.75 context ATR14. These are proposed range filters, not calibrated probabilities.

Long: wick below the lower band, bullish close back inside and below the mean, and current or previous RSI14 ≤40. Enter at 50% of that candle's full high/low range, stop below its low plus buffer. TP1 is the frozen mean; TP2 is the frozen upper band. Reject if they offer less than 1R / 2R. Shorts mirror at the upper band with RSI ≥60. A persistent trend is rejected rather than faded automatically.

## 5. Confirmed RSI Divergence Reversal (`RSI-DIVERGENCE`)

Use Wilder RSI14 and strict pivots with two candles on each side. A pivot becomes known only after both right-hand candles close. Compare consecutive same-side pivots separated by at least five and at most 40 candles.

Long: second pivot makes a lower low while RSI makes a higher low by at least five points, with first-pivot RSI ≤35. Require a new close crossing above the highest high **between the pivots**, with volume, within six bars after the second pivot is confirmed. Place a 50% confirmation-candle buy limit; stop below the second pivot plus buffer. A new lower low before entry confirmation invalidates the pattern. Shorts mirror with first-pivot RSI ≥65. Divergence alone is insufficient.

## Validation before assigning a win-rate label

Measure each strategy and preset separately on chronological unseen MEXC data, multiple liquid contracts, and trend/range/high-volatility periods. Include realistic spread, maker/taker fees, slippage, funding, rejected/unfilled limits, and conservative candle ambiguity. Separate tuning data from held-out tests; do not select the best of many variants on the same test period. Report trade count, confidence intervals, average net R, profit factor, drawdown, and fill rate alongside win rate. Then forward paper-test. No numeric win-rate promise is currently justified; existing dashboard simulated P&L excludes costs.

## Educational references

- [SMB Capital: opening range breakout](https://www.youtube.com/watch?v=dw9m0jV6PuY): opening range, volume, and breakout concept; the crypto retest rules above are our adaptation.
- [ATAS: breakout and retest signals](https://help.atas.net/en/support/solutions/articles/72000659579-breakout-and-retest-signals): breakout/retest terminology and contextual confirmation.
- [TradingView: VWAP](https://www.tradingview.com/support/solutions/43000502018-volume-weighted-average-price-vwap/): typical-price volume weighting and session anchoring.
- [Fidelity: Bollinger Bands](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/bollinger-bands): band calculation and interpretation.
- [Fidelity: RSI](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/RSI): momentum and divergence concept.

The exact thresholds, confirmations, limit entries, filters and targets are Mochbot design choices, not performance claims from those sources.
