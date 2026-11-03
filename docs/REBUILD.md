# Mochbot 1.0 — MOD-01E Limit Desk

This version runs one strategy: MOD-01E. Existing SQLite trades, charts and historical strategy attribution remain available. The scanner uses MOD-01E for all watched coins after startup. The previous dashboard is available at `/legacy.html` for journal analytics, manual trade management and MOCHEX controls.

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
