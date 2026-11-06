# Validation record — Mochbot Pine Strategy Lab

Date: 2026-11-04 (UTC+8). Runtime source baseline: `e0cec1cdf74b7231c19f50c72868232449a517de`. Research branch: `feat/tradingview-strategy-suite`.

## Verified locally

- Existing TypeScript suite plus the new cross-language default-input contract: **168 tests passed in 20 files**.
- TypeScript typecheck and build: passed. Production runtime behavior was not modified.
- The new input-contract tests compare the selector's eight IDs and MOD, EMA, Turtle and five-pack starting fields with the actual TypeScript defaults. They do **not** execute Pine or prove strategy performance.
- The unofficial Pynescript 0.3.0 grammar parser accepted the final full script (807 lines; 114.55 seconds), with the source fingerprint below. This is not TradingView compiler/type validation.
- Eight playbooks and three routing/testing notes were checked for draft/internal metadata and internal wiki links: **11 notes checked, zero broken internal links**.
- Repository whitespace/diff check passed.
- Current Pine source SHA-256: `6c065afd76c5cd9469e85ab0a565785165c94ebd4df01f7b0fd4f3ff9d90e2ad`.
- File: `mochbot_strategy_lab.pine`, 43,223 bytes, 807 text lines (808 newline-delimited positions).

## Repository integration recheck — 2026-11-07

- Before merging into the default branch (`master`), all **168 tests in 20 files**, TypeScript typecheck and build passed again.
- Pine source SHA-256 remains `6c065afd76c5cd9469e85ab0a565785165c94ebd4df01f7b0fd4f3ff9d90e2ad`, matching the previously parsed source. No new TradingView compile or Strategy Tester run was performed.

## TradingView verification — pending user compile

The guest chart and Pine Editor opened, but TradingView requested sign-in before the compile/add-to-chart workflow could finish. No script was saved or published, no alert was created and no live order was placed. The user chose **“I’ll compile it myself.”**

Accordingly, this file is delivered as a **draft research port**, not a claimed successful TradingView compile. There is no verified Strategy Tester run, trade-count comparison, historical/realtime parity result or profitability estimate.

## Final local grammar recheck

**Passed:** Pynescript 0.3.0 parsed the complete final 807-line source in 114.55 seconds. Its SHA-256 matches the fingerprint above. TradingView compiler/type validation remains pending.

## Checks for the user's TradingView session

1. Add the complete file on standard 1m candles. Resolve any Pine Editor diagnostics before interpreting results.
2. Select each of the eight models individually. Test fast and slower presets; MOD-01E uses explicit timeframe inputs.
3. Compare a handful of known completed signal candles and entry/stop/target prices with Mochbot on the same feed, allowing documented initial-history differences.
4. Check UTC session edges, incomplete midnight VWAP, pivot right-bar timing, order expiry, TP1/runner exit quantities, and entry/stop ambiguity markers.
5. Confirm the quantity contract increment is suitable for the instrument and there is enough chart warm-up, especially 50 closed 1H pullback bars for slow EMA.
6. Set actual costs/fill assumptions; aggregate the two partial legs per setup. Keep tuning and held-out periods separate.

See [README](README.md) for all known execution differences. A local grammar pass and 168 TypeScript tests must not be presented as Pine execution approval or evidence of an edge.
