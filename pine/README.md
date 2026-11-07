# Mochbot Pine v6 Strategy Lab

[Open the script](mochbot_strategy_lab.pine). This is one self-contained TradingView `strategy()` with eight selectable models. The bot now also supports Adam & Eve, Head & Shoulders and Quasimodo; those three models are not yet part of this Pine file. Runtime source baseline: Mochbot `e0cec1cdf74b7231c19f50c72868232449a517de`. The lab adds research files without changing the production scanner.

## Use it on TradingView

1. Open the matching **MEXC USDT perpetual** chart if TradingView provides it; spot and other exchanges can have different candles/volume.
2. Choose **standard candles, 1 minute**. The script rejects other chart types/timeframes rather than silently missing lower-timeframe confirmations.
3. Open Pine Editor, replace its content with the entire `mochbot_strategy_lab.pine` file, and Add to chart. The file declares Pine v6.
4. In Settings → Inputs, select a **Strategy**. Run one model at a time to keep attribution clear. This is not the bot's eight-checkbox portfolio.
5. For all models except MOD-01E, choose **Bot defaults (fast)** or **Recommended (slower)**. Recommended is a paper-test starting point, not an optimized setting. MOD-01E uses its own explicit timeframe inputs.
6. Review every model's input group, dates, dollar risk and capital cap. Irrelevant groups do not change the selected model.
7. In Strategy Properties, set your actual commission, slippage, margin, limit-fill assumptions and available Bar Magnifier settings. The script's 0.06% per execution and one-tick slippage are **illustrative assumptions**, not current MEXC fee quotes. Default margin is 2% (50×); the notional-sizing cap cannot exceed 50× in this port.
8. Open Strategy Tester, inspect the trade list and the plotted levels. Record your exact test configuration before changing parameters.

No exchange API key or live order routing is included. Order-fill alerts remain TradingView simulations.

## Model/preset mapping

| Model | Bot default | Recommended starting preset | Entry / targets |
| --- | --- | --- | --- |
| MOD-01E | 1H bias / 15m alignment-CHoCH / 5m expiry units | Same explicit MOD inputs | Fib 0.618; 3R / 5R |
| EMA-PULLBACK | 1H / 15m / 5m | 4H / 1H / 15m | 50% confirmation candle; 2R / 3R |
| TURTLE-SOUP | Prior 20 × 1H / 5m | Prior 20 × 4H / 15m | Reclaimed boundary; midpoint ≥1R / opposite edge ≥2R |
| OPENING-RANGE | 1H / 5m | 4H / 15m | Fixed 13:00 UTC / 30-minute opening range; retest; 2R / 3R |
| BREAKOUT-RETEST | 1H / 5m | 4H / 15m | Prior 20 confirmation-bar channel; retest; 2R / 3R |
| VWAP-RECLAIM | 1H / 5m | 4H / 15m | UTC confirmation-bar session VWAP; 2R / 3R |
| BOLLINGER-RANGE | 1H / 5m | 4H / 15m | Rejection-candle midpoint; mean ≥1R / opposite band ≥2R |
| RSI-DIVERGENCE | 1H / 5m | 4H / 15m | Confirmed pivots then neckline break; 50% candle; 2R / 3R |

MOD-01E expiry is 18 × 5m = 90 minutes by default; the 5m input is **not** another CHoCH gate. Other models default to six confirmation bars, 30 minutes fast or 90 minutes slow, capped at a relevant session boundary.

## Implementation and timing

- Complete contiguous 1m candles are aggregated into confirmation and EMA-pullback buckets aligned to UTC. Partial initial buckets do not confirm anything. Histories are bounded to 1,000 buckets each.
- EMA uses an SMA seed, matching Mochbot rather than assuming Pine's built-in EMA seed is identical. RSI uses Wilder smoothing with neutral 50 for a flat series.
- Higher-timeframe reference requests use no future lookahead: an unoffset value can be selected only at/after its requested close time on a confirmed minute; otherwise the prior value is obtained with the documented offset + `lookahead_on` pattern. Turtle range selection additionally requires reference completion before the sweep candle opens. Verify history/realtime boundary behavior when comparing feeds.
- Strict pivot confirmation requires both sides and rejects tied extrema. RSI necklines exclude the two pivot candles.
- Signals are evaluated at the confirmation close. Native resting limits are submitted then and are eligible on later emulator ticks; `process_orders_on_close=false`.
- Half/runner exit brackets are attached with the entry. Actual TP1 fill records enable a runner break-even update. Intrabar recalculation is deliberately off to avoid fill-triggered calculations reading a historical bar's complete OHLC as if already known.
- A missing minute invalidates pending pack orders; missing confirmation buckets reset pack continuity. VWAP requires an uninterrupted session from 00:00 UTC. Warm-up time and reference seeds affect the first eligible signal.

## Material differences from the bot

1. **Fill ambiguity:** Mochbot conservatively invalidates a minute containing both the limit and stop. TradingView may already fill the resting limit and bracket before the script can inspect that completed minute. The lab does not rewrite the resulting trade. Orange crosses and an ambiguity counter flag these minutes for review.
2. **Break-even latency:** with close-only calculations, TP1's actual fill is recognized at the end of its one-minute bar; the runner stop update is effective afterward. A same-minute reversal may therefore differ from the bot's live tick lifecycle. Bar Magnifier refines fills but does not make close-only stop updates tick-by-tick.
3. **Single model/symbol:** the lab holds one pending/open position. It does not share capital across symbols or reproduce the scanner's blocked historical ledger. New setup admission while a native position is open is suppressed; initial pattern state and subsequent opportunities can differ from Mochbot's rescans.
4. **Prices/quantities:** levels round to the chart tick. Quantity uses `syminfo.pointvalue` and rounds down to two executable half-size legs using `syminfo.mincontract`. The bot sizes MEXC contract metadata; instruments with indivisible/small quantities can reject more entries here.
5. **Sizing/liquidation:** stop-based risk is before costs. The 0.85/stop-distance leverage rule is the bot's heuristic, not a liquidation guarantee. TradingView's margin model is configured in Properties and does not dynamically reproduce MEXC isolated/cross liquidation.
6. **Costs:** bot journal P&L excludes fees/funding; this script includes the chosen commission/slippage, but not funding or spread/depth impact. No identical P&L is promised.
7. **History/feed:** Pine's available chart history and reference requests differ from the bot's retained 1m and 150-bar HTF backfills. SMA seeds, starting structure state, volume units, and timestamp gaps can differ. The recommended EMA preset needs at least 50 completed **1H pullback** candles in the chart-derived history (about 3,000 continuous minutes), plus context warm-up.
8. **Partial-exit statistics:** Strategy Tester can show separate exit-leg records for the same entry. Do not compare that raw win-rate count directly with Mochbot's one-setup journal; aggregate both halves per entry.

## Validation record

The real TradingView compile/run result and local checks are recorded in `VALIDATION.md`. Synthetic bot tests do not establish a profitable strategy. Before live use, compare selected signal timestamps/levels on the same feed, replay confirmation boundaries, and test held-out periods with realistic costs. A compiler pass alone is not a backtest.

## Official platform references

- [TradingView Pine strategies and broker emulator](https://www.tradingview.com/pine-script-docs/concepts/strategies/)
- [TradingView higher-timeframe data and repainting](https://www.tradingview.com/pine-script-docs/concepts/other-timeframes-and-data/)
- [TradingView strategy properties](https://www.tradingview.com/support/solutions/43000628599-strategy-properties/)
- [TradingView objects and mutable fields](https://www.tradingview.com/pine-script-docs/language/objects/)

The strategy hypotheses and thresholds are Mochbot design choices; TradingView documents platform behavior, not the performance of these models.
