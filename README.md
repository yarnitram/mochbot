# Phantom Alert Bot

Alert-only scanner for **MEXC USDT-perpetual futures** that runs **Phantom SMC MOD-01 (Pro-Trend Confirmation)** on a watchlist and notifies you on **Telegram** and **Discord**. A local **dashboard** shows each coin's stage live.

No trading API keys. The bot only reads public MEXC market data and never places orders.

## Stages

| Stage | Meaning |
|---|---|
| IDLE | No POI close enough |
| WATCH | Price is within `WATCH_DISTANCE_ATR` x ATR(15m) of an unmitigated 15m POI |
| ARMED | Price tapped a POI; the bot waits (up to 25 x 1m bars) for a 1m CHoCH. The alert shows the level that must be closed beyond. |
| ENTRY_READY | A 1m candle closed beyond the last LTF pivot. Alert has entry, SL (tap extreme +/- 0.2 ATR), TP1 (1:3), TP2 (1:5) and a market / limit / trigger-limit suggestion. |

Each (coin, setup, stage) alerts once. WATCH/ARMED additionally have a 15 min per-coin cooldown. Entry-ready stays "ready" for 3 closed bars.

## Logic source

Ported from the Pine strategy `phantom_smc_strategy.pine` and the MOD-01 playbook (vault: `01 - Business/Trading/Strategies/Phantom-SMC`). 15m POIs are aggregated from the 1m stream using completed bars only (no repaint). The 1m ATR(14) is used for the SL buffer. Entry only counts in London (07-11 UTC) / NY (13-17 UTC) killzones when the filter is on (default on, toggle globally or per coin).

The order-type suggestion is a bot heuristic, not part of the playbook (`src/engine/orderType.ts`).

## Run (dev)

```bash
npm install
cp .env.example .env     # fill in tokens; PAPER_MODE=true by default
npm run dev              # dashboard on http://localhost:8787
npm test
```

> **PAPER_MODE=true (default)**: alerts are recorded in the DB and shown in the dashboard but NOT sent to Telegram/Discord. Set `PAPER_MODE=false` to go live.

## Deploy (Proxmox / Docker)

```bash
docker compose up -d --build
```

SQLite lives in the `bot-data` volume. Run it in a Docker-capable LXC or VM. Set `DASHBOARD_PASSWORD` (HTTP basic auth, any username) if the LAN is not fully trusted.

## Telegram commands

`/add SYMBOL` `/remove SYMBOL` `/list` `/status [SYMBOL]` `/killzone on|off` `/mute` `/unmute`. Only the chat in `TELEGRAM_CHAT_ID` is obeyed.

## Compare with TradingView

```bash
npm run replay -- BTC_USDT 1500 off
```

Prints the POIs and every entry signal for the last 1500 1m bars so you can compare with the Pine strategy on the same 1m chart. Small differences can occur at the start of the window (HTF bars are rebuilt from the supplied 1m history and only POIs created inside it are tracked).

## Layout

```
src/strategy/mod01.ts      POI, tap, CHoCH, stage evaluation
src/engine/runner.ts       candles -> strategy -> gate -> notifiers
src/engine/alertGate.ts    dedupe + cooldown
src/mexc/{rest,ws}.ts      public MEXC futures REST + WebSocket
src/notify/*               Telegram (Bot API), Discord webhook
src/web/server.ts          HTTP API + SSE; web/index.html is the dashboard
```

Requires Node >= 22.13 (uses built-in `node:sqlite`).
