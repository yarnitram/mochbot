import { describe, it, expect } from 'vitest';
import { Db } from '../src/db/index.js';
import type { Setup } from '../src/types.js';

describe('Coin Analytics & Journal', () => {
  it('computes per-coin win rate, total R, and trade metrics correctly', () => {
    const db = new Db(':memory:');

    // Add BTC on watchlist
    db.addWatch('BTC_USDT', false);

    // Trade 1 (BTC): Win +4.0R
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
    });
    db.updateTradeStatus(t1, 'CLOSED_TP2', 4.0, 1100);

    // Trade 2 (BTC): Loss -1.0R
    const t2 = db.createTrade({
      symbol: 'BTC_USDT',
      direction: 'LONG',
      entry_price: 105,
      sl_price: 95,
      tp1_price: 135,
      tp2_price: 155,
      setup_id: 'btc-2',
      opened_at: 1200,
    });
    db.updateTradeStatus(t2, 'CLOSED_SL', -1.0, 1250);

    // Trade 3 (ETH): Win +1.5R (BE)
    const t3 = db.createTrade({
      symbol: 'ETH_USDT',
      direction: 'SHORT',
      entry_price: 2000,
      sl_price: 2100,
      tp1_price: 1700,
      tp2_price: 1500,
      setup_id: 'eth-1',
      opened_at: 1300,
    });
    db.updateTradeStatus(t3, 'CLOSED_BE', 1.5, 1400);

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
    expect(btc!.isWatching).toBe(true);

    const eth = analytics.find(c => c.symbol === 'ETH_USDT');
    expect(eth).toBeDefined();
    expect(eth!.totalTrades).toBe(1);
    expect(eth!.wins).toBe(1);
    expect(eth!.winRate).toBe(100.0);
    expect(eth!.totalR).toBe(1.5);
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
    });
    db.updateTradeStatus(tradeId, 'CLOSED_TP2', 4.0, 2500);

    const journal = db.getCoinJournal('SOL_USDT');
    expect(journal.stats).toBeDefined();
    expect(journal.stats!.symbol).toBe('SOL_USDT');
    expect(journal.trades).toHaveLength(1);
    expect(journal.trades[0].chart_file).toBe('sol_entry_1.png');
    expect(journal.trades[0].pnl_r).toBe(4.0);
  });
});
