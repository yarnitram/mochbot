# Mochbot 1.0 — MOD-01E Limit Desk

This version supports MOD-01E and EMA Trend Pullback Limit (`EMA-PULLBACK`). Existing SQLite trades, charts and historical strategy attribution remain available. Choose a default strategy or BOTH in Settings → Strategy selection, optionally applying it to existing coins, or override each coin in Market watch. MOD-01E remains the default. The previous dashboard is available at `/legacy.html` for journal analytics, manual trade management and MOCHEX controls; use the main dashboard to manage the new strategy.

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
