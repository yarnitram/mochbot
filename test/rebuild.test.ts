import { describe, it, expect } from 'vitest';
import { aggregateClosed } from '../src/strategy/indicators.js';
import { scanMod01e, evaluateMod01e, validateMod01eConfig } from '../src/strategy/mod01e.js';
import { Db } from '../src/db/index.js';
import { LifecycleManager } from '../src/engine/lifecycle.js';
import { limitScenario } from './fixtures.js';
import type { Setup } from '../src/types.js';

describe('MOD-01E chronological rebuild', () => {
  it('excludes incomplete and gapped higher timeframe buckets', () => {
    const { candles } = limitScenario();
    expect(aggregateClosed(candles.slice(0,14),15)).toHaveLength(0);
    expect(aggregateClosed(candles.slice(0,15),15)).toHaveLength(1);
    expect(aggregateClosed(candles.slice(0,15).filter((_,i)=>i!==7),15)).toHaveLength(0);
  });
  it('produces real pending plans before touches, with stable identity across evaluations', () => {
    const { candles,bias,cfg } = limitScenario();
    const closed = candles.slice(0,1789);
    const result = scanMod01e(closed,bias,cfg);
    expect(result.signals).toHaveLength(1);
    const sig = result.signals[0];
    const pendingPrefix = candles.filter(c => c.t < sig.zoneStartTime+900);
    const pending = evaluateMod01e('TEST_USDT',pendingPrefix,candles[pendingPrefix.length],bias,cfg);
    expect(pending.stage).toBe('ARMED');
    expect(pending.orderStatus).toBe('PENDING');
    const a = evaluateMod01e('TEST_USDT',closed,candles[1789],bias,cfg);
    const b = evaluateMod01e('TEST_USDT',candles.slice(0,1790),candles[1790],bias,cfg);
    expect(a.orderStatus).toBe('TOUCHED');
    expect(a.setupId).toBe(pending.setupId);
    expect(b.setupId).toBe(a.setupId);
  });
  it('future bias candles cannot rewrite earlier signals', () => {
    const { candles,bias,cfg } = limitScenario();
    const prefix = candles.slice(0,1789);
    const baseline = scanMod01e(prefix,bias,cfg);
    expect(baseline.signals.length).toBeGreaterThan(0);
    const end = prefix.at(-1)!.t+60;
    const future = [...bias,{t:end+3600,o:1,h:2,l:.1,c:.2,v:1}];
    expect(scanMod01e(prefix,future,cfg).signals).toEqual(baseline.signals);
    expect(scanMod01e(candles,bias,cfg).signals.filter(s=>s.time<=end)).toEqual(baseline.signals);
  });
  it('expires a pending limit exactly at its configured deadline', () => {
    const { candles,bias,cfg } = limitScenario();
    const full = scanMod01e(candles,bias,cfg);
    expect(full.terminalOrder?.status).toBe('EXPIRED');
    const terminal=full.terminalOrder!;
    expect(terminal.time).toBe(terminal.order.expiresAt);
  });
  it('rejects malformed strategy settings', () => {
    expect(()=>validateMod01eConfig({entryFib:2})).toThrow();
    expect(()=>validateMod01eConfig({entryTfMinutes:240})).toThrow();
    expect(()=>validateMod01eConfig({orderExpiry:0})).toThrow();
    expect(()=>validateMod01eConfig({useKillzone:'false' as any})).toThrow();
    expect(()=>validateMod01eConfig({surprise:true} as any)).toThrow();
  });
});

describe('persistent order and trade identity', () => {
  const plan = (): Setup => ({symbol:'TEST_USDT',stage:'ARMED',direction:'LONG',setupId:'01E:LONG:1',price:101,
    zone:null,distanceAtr:null,needBreak:100,barsSinceTap:0,entry:100,sl:99,tp1:102,tp2:104,
    orderType:'LIMIT',orderNote:null,killzone:true,atrHtf:1,atrLtf:1,strategyId:'MOD-01E',ts:100,
    orderStatus:'PENDING',expiresAt:500});
  it('keeps terminal orders terminal across replay and cannot reopen a closed trade', () => {
    const db=new Db(':memory:'), s=plan();
    db.saveLimitOrder(s);
    db.saveLimitOrder({...s,stage:'ENTRY_READY',orderStatus:'TOUCHED'});
    db.saveLimitOrder(s);
    expect(db.listLimitOrders()[0].status).toBe('TOUCHED');
    const lifecycle=new LifecycleManager(db);
    const trade=lifecycle.onEntryReady({...s,stage:'ENTRY_READY'})!;
    db.updateTradeStatus(trade.id,'CLOSED_SL',-1,200,-5);
    expect(lifecycle.onEntryReady({...s,stage:'ENTRY_READY'})).toBeNull();
    db.close();
  });
  it('calculates realized R from configured targets after moving SL to BE', () => {
    const db=new Db(':memory:'), lifecycle=new LifecycleManager(db);
    lifecycle.onEntryReady({...plan(),stage:'ENTRY_READY'});
    lifecycle.onPrice('TEST_USDT',{t:101,o:102,h:102,l:102,c:102,v:1});
    lifecycle.onPrice('TEST_USDT',{t:102,o:104,h:104,l:104,c:104,v:1});
    expect(db.getTradeHistory()[0].pnl_r).toBe(3);
    db.close();
  });
});
