import { describe, it, expect } from 'vitest';
import { Db } from '../src/db/index.js';
import type { Setup } from '../src/types.js';

describe('Coin Analytics & Journal', () => {
  it('computes per-coin win rate, total R, dollar PnL, and trade metrics correctly', () => {
    const db = new Db(':memory:');

    // Add BTC on watchlist
    db.addWatch('BTC_USDT', false);

    // Trade 1 (BTC): Win +4.0R, +$20.00
    const t1 = db.createTrade({
      symbol: 'BTC_USDT',
      direction: 'LONG',
      entry_price: 100,
      sl_price: 90,
      tp1_price: 130,
      tp2_price: 150,
      setup_id: 'btc-1',
      chart_file: 'btc_chart_1.png',
      opened_at: 1000,
      margin: 1.0,
      leverage: 50.0,
      notional: 50.0,
    });
    db.updateTradeStatus(t1, 'CLOSED_TP2', 4.0, 1100, 20.0);

    // Trade 2 (BTC): Loss -1.0R, -$5.00
    const t2 = db.createTrade({
      symbol: 'BTC_USDT',
      direction: 'LONG',
      entry_price: 105,
      sl_price: 95,
      tp1_price: 135,
      tp2_price: 155,
      setup_id: 'btc-2',
      opened_at: 1200,
      margin: 1.0,
      leverage: 50.0,
      notional: 50.0,
    });
    db.updateTradeStatus(t2, 'CLOSED_SL', -1.0, 1250, -5.0);

    // Trade 3 (ETH): Win +1.5R (BE), +$7.50
    const t3 = db.createTrade({
      symbol: 'ETH_USDT',
      direction: 'SHORT',
      entry_price: 2000,
      sl_price: 2100,
      tp1_price: 1700,
      tp2_price: 1500,
      setup_id: 'eth-1',
      opened_at: 1300,
      margin: 1.0,
      leverage: 50.0,
      notional: 50.0,
    });
    db.updateTradeStatus(t3, 'CLOSED_BE', 1.5, 1400, 7.5);

    // Insert dummy alerts
    const setup: Setup = {
      symbol: 'BTC_USDT',
      stage: 'ENTRY_READY',
      direction: 'LONG',
      setupId: 'btc-1',
      price: 100,
      zone: null,
      distanceAtr: null,
      needBreak: null,
      barsSinceTap: null,
      entry: 100,
      sl: 90,
      tp1: 130,
      tp2: 150,
      orderType: 'MARKET',
      orderNote: 'buy',
      killzone: true,
      atrHtf: 1,
      atrLtf: 0.1,
      ts: 1000,
    };
    db.insertAlert(setup, true);

    const analytics = db.getCoinAnalytics();
    expect(analytics).toHaveLength(2);

    const btc = analytics.find(c => c.symbol === 'BTC_USDT');
    expect(btc).toBeDefined();
    expect(btc!.totalTrades).toBe(2);
    expect(btc!.closedTrades).toBe(2);
    expect(btc!.wins).toBe(1);
    expect(btc!.losses).toBe(1);
    expect(btc!.winRate).toBe(50.0);
    expect(btc!.totalR).toBe(3.0); // +4.0 - 1.0
    expect(btc!.avgR).toBe(1.5);
    expect(btc!.totalPnlUsd).toBe(15.0); // +20.0 - 5.0
    expect(btc!.avgPnlUsd).toBe(7.5);
    expect(btc!.isWatching).toBe(true);

    const eth = analytics.find(c => c.symbol === 'ETH_USDT');
    expect(eth).toBeDefined();
    expect(eth!.totalTrades).toBe(1);
    expect(eth!.wins).toBe(1);
    expect(eth!.winRate).toBe(100.0);
    expect(eth!.totalR).toBe(1.5);
    expect(eth!.totalPnlUsd).toBe(7.5);
    expect(eth!.isWatching).toBe(false); // not on watchlist
  });

  it('retrieves detailed coin journal with trades, chart files, and alert history', () => {
    const db = new Db(':memory:');

    const tradeId = db.createTrade({
      symbol: 'SOL_USDT',
      direction: 'LONG',
      entry_price: 150,
      sl_price: 140,
      tp1_price: 180,
      tp2_price: 200,
      setup_id: 'sol-1',
      chart_file: 'sol_entry_1.png',
      opened_at: 2000,
      margin: 1.0,
      leverage: 300.0,
      notional: 300.0,
    });
    db.updateTradeStatus(tradeId, 'CLOSED_TP2', 4.0, 2500, 80.0);

    const journal = db.getCoinJournal('SOL_USDT');
    expect(journal.stats).toBeDefined();
    expect(journal.stats!.symbol).toBe('SOL_USDT');
    expect(journal.trades).toHaveLength(1);
    expect(journal.trades[0].chart_file).toBe('sol_entry_1.png');
    expect(journal.trades[0].pnl_r).toBe(4.0);
    expect(journal.trades[0].pnl_usd).toBe(80.0);
    expect(journal.trades[0].margin).toBe(1.0);
    expect(journal.trades[0].leverage).toBe(300.0);
  });

  it('manages account capital and default margin settings with defaults ($1000 capital, $1 margin)', () => {
    const db = new Db(':memory:');
    expect(db.getAccountCapital()).toBe(1000);
    expect(db.getDefaultMargin()).toBe(1);

    db.setAccountCapital(5000);
    db.setDefaultMargin(5);

    expect(db.getAccountCapital()).toBe(5000);
    expect(db.getDefaultMargin()).toBe(5);
  });
});
