# Historical strategy replay

Run saved completed one-minute candles through all active TypeScript strategy evaluators and the existing LifecycleManager. Each model runs independently in its own in-memory database. No alerts, exchange orders, production database writes or network requests occur.

Usage: `npm run replay -- candles.json BTC_USDT ALL report.json`

Replace ALL with a runtime strategy ID to test one model. Input is a JSON array of `{t,o,h,l,c,v}`; timestamps are Unix seconds aligned to minutes, ordered and unique. Include enough preceding history for higher-timeframe warmup. All higher timeframes derive only from the prefix available at each replay minute. Current implementation rescans prefixes and is intended for bounded research datasets; long histories can be slow.

Reports include closed setup records, open positions, net dollars, net win rate, profit factor and closed-trade drawdown. Empty/no-loss profit factor is null. Open positions are not forcibly closed or included in closed-trade metrics. Plan count includes distinct observed setup IDs, not every possible setup.

Assumptions: bot defaults, fixed $1,000 capital, $5 stop risk, 50x leverage cap, contract size 1. Cost estimate is 6 basis points commission plus 1 basis point slippage per side, charged against entry plus weighted exit notional. These are illustrative approximations, not exchange quotes; funding and depth are not modeled. Results do not compound or reproduce cross-symbol shared exposure. Only one position per model/symbol is admitted. Suppressed touches cannot enter later.

Position lifecycle starts on the minute after the completed touch candle, avoiding use of pre-entry extremes. Consequently entry-minute target hits are deferred. Existing lifecycle stop-first ambiguity and partial-target rules apply afterward. Minute gaps are retained for strategy invalidation, but active positions cannot be reconstructed during missing data. Do not interpret results as verified fills or profitability. Compare known trades against the bot and TradingView before drawing conclusions.

This replaces the old MOD-01-only live-fetch command. Save a reproducible candle dataset first; the CLI does not silently fetch a short recent window. A dashboard and integrated multi-symbol portfolio replay remain future work.


## Download and compare

To compare presets on the same saved dataset, run the replay twice with separate options files. Set `preset` to `"default"` or `"recommended"`. Use the same `warmupBars`, `historyBars` and cost settings in both files. For a 24,000-minute dataset, `{"preset":"recommended","warmupBars":12240,"historyBars":1500}` reserves enough completed history for the 50 four-hour reference bars and scores the remaining minutes. The rolling minute window limits execution history while reference candles are available only after their close. The scored period starts flat, excluding plans already observed during warmup. Import both reports to compare their preset labels and metrics.

1. `npm run replay:download -- BTC_USDT 4000 candles.json` downloads paginated completed public MEXC candles and refuses to overwrite an existing dataset.
2. `npm run replay -- candles.json BTC_USDT ALL report.json` produces an eleven-model report.
3. Open **Strategy research** from the Limit Desk navigation and import `report.json`. Filter by symbol/model and select a row to see trade details. Reports are read locally in the browser, never uploaded. Import multiple reports for separate runs; rows are not aggregated.

An optional fifth CLI argument is an options JSON file, for example `{"capital":1000,"risk":5,"feeBps":6,"slippageBps":1}`. Unknown fields and invalid values are rejected. Defaults and the exact cost assumptions are included in each report. Report periods describe the input dataset, including warmup. Drawdown is based on closed trades, excluding unrealized changes. Missing candles are counted; no-loss profit factor displays a dash rather than a finite score.

## Verification — 2026-11-07

Downloaded 4,000 completed BTC_USDT minute candles from the public MEXC endpoint in four pages. All eight models completed replay. EMA closed six setups, Turtle two, opening range one and VWAP three; the other four had no closed trades. Models with closed trades all had negative net results under the illustrative costs. This is a short integration sample, not strategy validation or a ranking. Raw data and the resulting report remain in the local temporary folder, outside version control.

Browser checks imported all eight reports, filtered EMA, displayed six trade details and cleared the reports. Mobile inspection at 390 pixels showed no document overflow; no browser errors occurred. A synthetic breakout/retest regression verifies confirmation, touch, stop, cost deduction and zero-cost accounting. Market performance, longer held-out periods, slower presets and a combined portfolio remain unverified.

## Chart-pattern extension verification — 2026-11-07

The local catalog now includes eleven models. On the same 4,000-minute BTC dataset, all eleven replayed successfully. H&S closed one losing setup (about -$6.80 net); Adam & Eve and Quasimodo had no closed setups. No market edge is established by this sample. All 185 repository tests across 22 files, typecheck/build and browser preset-save/report-import checks pass. The Pine file remains an eight-model port. See CHART-PATTERNS.md for the exact new strategy rules.
