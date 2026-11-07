# Chart-pattern reversal strategies

Three experimental Mochbot adaptations join the existing eight models: `ADAM-EVE`, `HEAD-SHOULDERS`, `QUASIMODO`. They use the same pending-limit ledger, position sizing, shared-risk admission and live simulated lifecycle. Choose any of the eleven strategies in Settings. Priority preserves the original order, then Adam & Eve, Head & Shoulders, Quasimodo. An existing ALL selection now includes all eleven; individual/custom selections are unchanged.

## Common timing and recommended starting settings

- Default: completed 1H reference history / 5m pattern candles. Recommended starting preset: 4H history / 15m pattern candles. The reference must have 50 completed recent bars; there is no EMA direction filter on these reversal models.
- Strict swings: two candles left and two right; tied extrema are rejected, and a candle that is both a pivot high and low is ignored because intrabar ordering is unknown. Consecutive same-side swings retain the more extreme point.
- Pattern lookback 80 confirmation bars. First-to-last turn spans at least six bars. A break must occur within 12 bars after the last pivot's right-side confirmation. Pattern and approach candles must be continuous.
- Confirmation closes beyond the neckline/structure by 0.1 ATR14, crossing from the other side of that buffered threshold. Volume must be at least 1.2 times the prior 20-bar average. One attempt per pattern pivot sequence and direction; a weak-volume first break is consumed.
- Entry is a resting retracement limit, eligible only on subsequent completed minutes. Expiry six confirmation bars: 30 minutes fast, 90 minutes recommended.
- Stops include a 0.2 ATR buffer. Allowed stop distance 0.5–6 confirmation ATR and at least 0.15% of entry. Targets 2R and 3R; half at TP1, then the existing break-even runner lifecycle. These are risk-multiple targets, not measured-pattern-height targets.
- A minute containing both limit and stop invalidates pending orders. A missing minute invalidates pending orders; the ledger's shared capital/risk and same-coin exclusions remain enforced. Pattern reversal plans are not canceled solely by an EMA trend flip. Changing their settings invalidates pending plans; active positions retain their levels.

## Adam & Eve

Bullish: a narrow first trough (Adam), intervening high, then broader second trough (Eve), followed by the confirmed neckline close. Troughs differ by at most 0.75 ATR. Neckline height above Adam is at least 0.5 ATR. Within four candles on either side of each trough, count lows within 35% of pattern height from that trough: Adam permits at most two and Eve requires at least three. Four completed candles after Eve are required for this shape check. The approach five bars before Adam must be at least 0.5 ATR above it. Entry is the frozen intervening-high neckline; stop below the lower trough. Bearish double tops mirror all conditions. Broad-to-narrow Eve/Adam patterns are not included.

## Head & Shoulders

Bullish inverse: confirmed low / high / lower head / high / right low. Both shoulders must stand at least 0.5 ATR above the head and differ by at most 0.75 ATR. Neckline is the line through the two intervening highs, evaluated at the break candle. Entry freezes that value at confirmation; stop below the head. Bearish H&S mirrors the sequence and neckline. Require an approach into the left shoulder, a completed buffered neckline cross and volume. A shoulder sketch alone never admits an order.

## Quasimodo

Bullish adaptation: a confirmed low, intervening high, then a lower low by at least 0.5 ATR; a completed buffered close above the intervening high confirms the structure break. Place the QML limit at the **earlier low**, with stop beyond the new lower low. Bearish: high / low / higher high, structure break below the intervening low, then a sell limit at the earlier high. This explicitly chosen earlier-swing QML convention is one of several discretionary interpretations; it does not wait for a separate final shoulder pivot or add a Fibonacci rule.

## Validation and TradingView scope

Synthetic tests cover mirrored setups, right-bar confirmation, actual limits, stable touch IDs, stop ambiguity, minute gaps, expiry, weak volume and malformed shapes. Product settings expose all thresholds; recommendations are paper-test starting points. No high-probability or profitability claim is established. Historical replay uses independent single-model runs; see REPLAY.md for costs and fill limitations.

The Pine Strategy Lab still contains the original eight models. These three additions currently run in Mochbot and its replay engine; do not select an unrelated Pine model to approximate them.

## Background sources

General pattern definitions informed the design; the numeric filters and limit-entry adaptation above are Mochbot choices.

- [TradingView Head & Shoulders](https://www.tradingview.com/support/solutions/43000653213-chart-pattern-head-and-shoulders/)
- [Bulkowski Adam & Eve double bottom](https://thepatternsite.com/aedb.html)
- [Capital.com Quasimodo definitions and varying interpretations](https://capital.com/en-int/learn/trading-strategies/quasimodo-pattern)

Source authority: src/strategy/chartPatterns.ts and strategyPack.ts. These implement rules, not a statistically established edge.
