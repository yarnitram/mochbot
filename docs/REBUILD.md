# Mochbot 1.0 — MOD-01E Limit Desk

This version supports eight strategies: MOD-01E, EMA Trend Pullback Limit (`EMA-PULLBACK`), Turtle Soup-inspired Range Reversal (`TURTLE-SOUP`), and the [five experimental strategy rules and recommended starting presets](STRATEGY-PACK.md). Existing SQLite trades, charts and historical strategy attribution remain available. Choose any nonempty combination using Settings → Strategy selection checkboxes, optionally applying it to existing coins, or override each coin in Market watch. Saved combinations survive restarts without a database migration; legacy BOTH retains MOD-01E + EMA and ALL evaluates all eight. Recommended presets load into the editor for review and require Save strategy to apply. MOD-01E remains the default. The previous dashboard is available at `/legacy.html` for journal analytics, manual trade management and MOCHEX controls; use the main dashboard to manage new strategies.

## Turtle Soup-inspired range reversal

This is an explicit intraday adaptation, not a reproduction of Raschke/Connors' original 20-day Turtle Soup stop-entry rules. Default preset: prior 20 completed 1H bars define a frozen high/low range; completed 5m candles provide sweep/reclaim confirmation. Optional preset: 20 completed 4H bars with 15m confirmation. Reference bars must have closed before the sweep candle opens; the sweep candle cannot define its own range.

For a long: a completed confirmation candle sweeps below the reference low by at least 0.1 × confirmation ATR(14). That candle or either of the next two confirmation candles must close strictly inside the frozen range. Shorts mirror these rules. Both-side sweeps, crossing the opposite boundary before reclaim, insufficient history and expired reclaim windows are rejected. At most one sweep attempt per reference range end-time and direction is admitted.

Default limit entry is the reclaimed range boundary. An optional 50% reclaim-candle midpoint entry is available, provided it remains inside the original range and on the retracement side of the reclaim close. Stop is beyond the full sweep extreme plus 0.2 × confirmation ATR. TP1 is the frozen range midpoint and TP2 its opposite boundary. Minimum reward filters default to 1R at TP1 and 2R at TP2. Target prices and R multiples therefore vary with the actual range; they are not fixed 2R/3R targets.

Orders start only after reclaim confirmation closes and expire after six confirmation bars (30 minutes on 1H/5m, 90 minutes on 4H/15m). Subsequent completed one-minute candles detect simulated touches; stop/entry ambiguity is conservatively invalidated. A completed trade closes 50% at TP1 and moves the remaining stop to entry using existing lifecycle rules. The strategy operates without EMA trend or MOD-01E session filters. Notes show the range, sweep, entry rule, targets, reward multiples and expiry.

ALL mode has deterministic simultaneous priority MOD-01E → EMA → Turtle Soup → Opening Range → Breakout Retest → VWAP → Bollinger Range → RSI Divergence. Existing shared dollar risk/margin limits and single pending/active trade per coin apply across all eight; increasing discovery counts does not increase trade-risk limits. An explicitly chosen strategy or ALL can be applied to the existing watchlist. Disabling a strategy retains management of already active trades. All tests/previews use synthetic data; these rules have no demonstrated live-market edge or profitability claim.

## EMA Pullback Limit

Select one of two timeframe presets in Settings → Strategy settings → EMA Pullback Limit → EMA timeframe preset:

- `1H/15m/5m` (default): 1H trend, 15m pullback, 5m confirmation, default 30-minute order expiry.
- `4H/1H/15m`: 4H trend, 1H pullback, 15m confirmation, default 90-minute order expiry.

Both default to a 50% confirmation-candle retracement. EMA lengths, target multiples, and dollar-risk settings are shared. Expiry and confirmation-window counts are measured in the selected confirmation bars. The slower preset uses dedicated 4H and hourly backfills to warm its EMAs beyond the rolling minute history. Changing presets invalidates previous pending EMA plans during re-evaluation; active simulated trades retain their entry, stop, targets and sizing. Notes, setup identity and chart labels carry the selected preset. Existing configurations without a saved preset keep `1H/15m/5m`.

For the default preset, the long sequence requires a completed 1H close above EMA 20, with EMA 20 above EMA 50; reverse this for shorts. A completed 15m candle must intersect its own EMA 20–50 zone. A subsequent completed 5m candle must close above the preceding 5m high (below the preceding low for shorts). Confirmation must occur within six 5m bars of the pullback by default. The slower preset applies the same rules to 4H, 1H and 15m respectively.

The default limit is 50% of that confirmation candle's full high-to-low range, on the retracement side of its close. The stop is beyond the pullback/confirmation extreme plus 0.2 × 5m ATR(14). Targets default to 2R / 3R. The order starts after confirmation closes, expires after six further 5m bars (30 minutes), and cancels on a neutral/reversed 1H EMA trend or a breached stop. Only subsequent completed one-minute data can register a simulated touch. A minute that touches both the entry and stop is invalidated conservatively. EMA does not use MOD-01E's UTC session filter.

Both mode evaluates both strategies independently using the same market feed. The scanner exposes both statuses, alerts and ledgers carry strategy attribution, and the journal shows separate strategy statistics. There is at most one admitted pending or active trade per coin across strategies; MOD-01E wins a simultaneous evaluation tie. A shared stop-risk budget reserves risk for active trades and unexpired pending limits, defaulting to three times risk per trade (USDT 15 with a USDT 5 risk budget). Adjust it under Capital & alerts. Capital also limits combined entry-margin reservations. Positions already past TP1 reserve zero remaining stop-loss risk after BE, but keep their coin reservation.

Blocked setups are recorded as BLOCKED without sending entry alerts or opening trades, and cannot be admitted retrospectively after their historical touch; a new confirmation is required. Disabling a strategy invalidates its pending plans but retains active trade management and historical records. These calculations model simultaneous stops before fees/slippage and do not account for price gaps or exchange liquidation mechanics. Results require paper/replay validation; no profitability assumption is built into these rules.

## Sequence

Completed bias candles establish direction. Completed alignment candles establish structure and CHoCH. At confirmation, the bot freezes the broken swing (Fib 0), recent impulse extreme (Fib 1), entry, ATR-buffered stop and two targets. It records and alerts an ARMED pending limit before the retest. Defaults remain 1H bias, 15m alignment, 5m expiry units, 0.618 entry, 18 entry bars expiry, 3R / 5R targets.

Pending limits are evaluated against subsequent completed one-minute candles. This adds up to one minute of confirmation delay. A price touch is simulated, not an exchange fill. If a minute touches both the planned stop and limit, the plan is invalidated conservatively. New CHoCH and bias-disagreement cancellation settings are enforced. UTC session filtering gates creation of new plans; existing pending plans continue until touch, invalidation or expiry.

Structure and ATR gates use only candles closed at that point in the replay. Incomplete or gapped aggregate buckets are excluded. Setup IDs remain identical from pending through touch. The SQLite limit ledger survives restarts. Strategy reconstruction uses the available rolling history and current settings; plans no longer reconstructable are explicitly invalidated rather than assumed filled. During offline periods, actual price order and fills cannot be established. This is an alert system with simulated trade tracking and does not send exchange orders.

Trade milestones use observed tick close prices, rather than cumulative candle extremes that may predate entry. A closed setup cannot open twice. Original SL is retained so configurable target R remains correct after moving the stop to break-even. For legacy trades already past TP1 without an original SL, migration assumes the former 3R TP1 default. Historical P&L excludes fees, funding, slippage and order-book fill effects.

## Operations

Coin discovery defaults are Top 100 volume, Top 100 memes, Top 70 AI, Top 70 gaming, Top 50 gainers and Top 50 losers. Each category has an independent Top N setting (integer 1–500) under Settings → Coin discovery. Counts are limited by matching contracts available on MEXC. The default combined discovery cap is 300; an explicitly saved cap is retained and can be edited (10–1000). Duplicate contracts count once. Existing high-leverage mode includes all eligible 200×+ contracts within the combined cap and restricts all enabled category feeds to that leverage threshold. Discovery capacity does not increase the separate shared trade-risk budget.

The Live trades tab automatically lists touched limits registered as OPEN/TP1_HIT simulated positions. It shows current price, net/secured/unrealized P&L, R, return on entry margin, entry sizing, current stop, both targets and progress toward the next target. After TP1, 50% is secured and only the remaining half contributes unrealized P&L. Stale quotes are labeled and unavailable prices show no fabricated zero P&L. Closed positions move to the journal. These are simulated positions, not verified exchange fills.

The limit ledger shows suggested margin, leverage, position notional and estimated stop loss alongside the configured risk budget. Pending plans recalculate using current capital/risk settings; terminal records retain their recorded sizing. Position notional is risk divided by relative entry-to-stop distance. Margin is notional divided by suggested leverage, capped at capital and rounded down to four decimals to avoid increasing the risk budget. Leverage is limited by contract maximum and a stop-distance heuristic, not a guarantee of liquidation safety. Estimates exclude fees, funding, slippage and exchange quantity rounding.

Pending and touched setups include notes on the dashboard and in Telegram/Discord alerts: configured bias/CHoCH timeframes, break rule, entry Fibonacci ratio and percentage, actual Fib 0/1 prices, confirmation time, and expiry duration. The default entry ratio is 0.618; Settings → MOD-01E strategy → Entry Fibonacci ratio accepts alternatives such as 0.382 or 0.5. This is one configured entry level per setup, not multiple staggered orders. Historical ledger payloads retain their recorded notes; older records without this metadata are not relabeled with current settings.

- `npm ci`, `npm run typecheck`, `npm test`, `npm run build`
- `npm start` serves the application on `PORT` (default 8787).
- `npm run preview` serves isolated synthetic data on port 8788. It uses no production database, credentials or exchange requests.
- `/api/health` reports process uptime, watched count and feed degradation; it uses the same authentication as the dashboard.
- The scanner shows connection status separately from strategy IDLE and explains warming history, neutral bias, disagreement, sessions and retest waiting.
- Empty watchlists and disabled discovery remain the default. Enable feeds or add symbols explicitly.
- PAPER_MODE=true disables external alerts and MOCHEX writes. Both modes track simulated trades locally.
- Discovery refresh is serialized. Symbols with open tracked trades survive discovery rotation. Manual pins can exceed the discovery cap.

## Proxmox deployment

The Docker Compose service and `bot-data:/data` volume remain compatible. Back up the SQLite database and charts before deploying a new application version. Stop the service before taking a raw SQLite file backup, or use SQLite's backup mechanism. Preserve `.env` on the server.

After the reviewed source is available on the Proxmox host:

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 mochbot
```

Do not use `docker compose down -v` during upgrade: it removes the persistent database volume. First start in paper mode, inspect feed freshness and pending plans, then enable external alerts through the container environment when ready. Source changes are prepared locally; production deployment is a separate action.
