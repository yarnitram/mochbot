import { describe, it, expect } from 'vitest';
import { generateChartSvg, renderChartPng } from '../src/chart/renderer.js';
import type { Candle, Setup } from '../src/types.js';

describe('Chart Renderer', () => {
  const htf: Candle[] = Array.from({ length: 30 }, (_, i) => ({
    t: 1700000000 + i * 900,
    o: 100 + i * 0.2,
    h: 101 + i * 0.2,
    l: 99.5 + i * 0.2,
    c: 100.8 + i * 0.2,
    v: 10,
  }));

  const ltf: Candle[] = Array.from({ length: 50 }, (_, i) => ({
    t: 1700027000 + i * 60,
    o: 105 + i * 0.05,
    h: 105.5 + i * 0.05,
    l: 104.8 + i * 0.05,
    c: 105.3 + i * 0.05,
    v: 5,
  }));

  const setup: Setup = {
    symbol: 'BTC_USDT',
    stage: 'ENTRY_READY',
    direction: 'LONG',
    setupId: 'LONG:1:2',
    price: 107.5,
    zone: { top: 106, bottom: 104, startTime: 1700000000 },
    distanceAtr: 0,
    needBreak: 107,
    barsSinceTap: 5,
    entry: 107.5,
    sl: 103.8,
    tp1: 118.6,
    tp2: 126.0,
    orderType: 'MARKET',
    orderNote: 'market buy',
    killzone: true,
    atrHtf: 1.2,
    atrLtf: 0.2,
    ts: 1700030000,
  };

  it('generates well-formed SVG string with dual panels and price lines', () => {
    const svg = generateChartSvg('BTC_USDT', htf, ltf, setup);
    expect(svg).toContain('<svg');
    expect(svg).toContain('BTC_USDT');
    expect(svg).toContain('DEMAND POI');
    expect(svg).toContain('ENTRY');
    expect(svg).toContain('SL');
    expect(svg).toContain('TP1 (1:3)');
    expect(svg).toContain('TP2 (1:5)');
  });

  it('renders a valid PNG buffer with PNG signature (0x89504E47)', () => {
    const png = renderChartPng('BTC_USDT', htf, ltf, setup);
    expect(png).toBeInstanceOf(Buffer);
    expect(png.length).toBeGreaterThan(1000);
    // Magic bytes for PNG
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50); // P
    expect(png[2]).toBe(0x4e); // N
    expect(png[3]).toBe(0x47); // G
  });
  it('labels EMA context and its actual 2R/3R targets instead of SMC defaults',()=>{
    const svg=generateChartSvg('BTC_USDT',htf,ltf,{...setup,strategyId:'EMA-PULLBACK',entry:100,sl:95,tp1:110,tp2:115});
    expect(svg).toContain('EMA PULLBACK');expect(svg).toContain('TP1 (1:2)');expect(svg).toContain('TP2 (1:3)');
    expect(svg).not.toContain('TP2 (1:5)');
  });
  it('labels slow EMA charts with 4H trend and 15m execution',()=>{
    const svg=generateChartSvg('BTC_USDT',htf,ltf,{...setup,strategyId:'EMA-PULLBACK',emaTimeframes:{trendMinutes:240,pullbackMinutes:60,confirmationMinutes:15,preset:'4H/1H/15m'}});
    expect(svg).toContain('4H EMA Trend Context');expect(svg).toContain('15m Execution Timeframe');
    expect(svg).not.toContain('>5m Execution Timeframe');
  });
  it('labels Turtle Soup charts as range and sweep/reclaim context',()=>{
    const svg=generateChartSvg('BTC_USDT',htf,ltf,{...setup,strategyId:'TURTLE-SOUP',turtleContext:{rangeMinutes:240,confirmationMinutes:15,referenceHigh:110,referenceLow:100,rangeEnd:0,sweepExtreme:99,reclaimedAt:1}});
    expect(svg).toContain('4H Turtle Soup Reference Range');expect(svg).toContain('15m Sweep / Reclaim Execution');
    expect(svg).toContain('REF RANGE');expect(svg).not.toContain('DEMAND POI');
  });
});
