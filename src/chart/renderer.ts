import { Resvg } from '@resvg/resvg-js';
import type { Candle, Setup } from '../types.js';

export interface ChartOptions {
  width?: number;
  height?: number;
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  const a = Math.abs(n);
  return a >= 1000 ? n.toFixed(2) : a >= 1 ? n.toFixed(4) : n.toPrecision(5);
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
}

interface PanelLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

function renderPanelCandles(candles: Candle[], layout: PanelLayout, extraLevels: { price: number; color: string; label: string; dash?: string }[], zone?: { top: number; bottom: number; isDemand: boolean } | null): string {
  if (!candles.length) return '';
  const { x, y, w, h } = layout;

  let minP = Infinity;
  let maxP = -Infinity;
  for (const c of candles) {
    if (c.l < minP) minP = c.l;
    if (c.h > maxP) maxP = c.h;
  }
  if (zone) {
    if (zone.bottom < minP) minP = zone.bottom;
    if (zone.top > maxP) maxP = zone.top;
  }
  for (const lvl of extraLevels) {
    if (lvl.price < minP) minP = lvl.price;
    if (lvl.price > maxP) maxP = lvl.price;
  }

  // 6% padding top and bottom
  const pDiff = maxP - minP || 1;
  const pad = pDiff * 0.06;
  minP -= pad;
  maxP += pad;
  const range = maxP - minP;

  const getY = (p: number) => y + h - ((p - minP) / range) * h;
  const candleW = Math.max(2, Math.min(10, (w / candles.length) * 0.7));
  const step = w / candles.length;

  let svg = '';

  // Background grid lines (3 horizontal lines)
  for (let g = 1; g <= 3; g++) {
    const p = minP + (range * g) / 4;
    const gy = getY(p);
    svg += `<line x1="${x}" y1="${gy.toFixed(1)}" x2="${x + w}" y2="${gy.toFixed(1)}" stroke="#21262d" stroke-width="1" stroke-dasharray="3,3"/>`;
    svg += `<text x="${x + w - 4}" y="${(gy - 3).toFixed(1)}" fill="#6e7681" font-size="9" text-anchor="end" font-family="monospace">${fmt(p)}</text>`;
  }

  // Draw POI Zone box if present
  if (zone) {
    const zTopY = getY(zone.top);
    const zBottomY = getY(zone.bottom);
    const zHeight = Math.max(3, zBottomY - zTopY);
    const zColor = zone.isDemand ? '#00897b' : '#d81b60';
    const zFill = zone.isDemand ? 'rgba(0, 137, 123, 0.25)' : 'rgba(216, 27, 96, 0.25)';
    svg += `<rect x="${x}" y="${zTopY.toFixed(1)}" width="${w}" height="${zHeight.toFixed(1)}" fill="${zFill}" stroke="${zColor}" stroke-width="1"/>`;
    svg += `<text x="${x + 6}" y="${(zTopY + 12).toFixed(1)}" fill="${zColor}" font-size="10" font-weight="bold" font-family="sans-serif">${zone.isDemand ? 'DEMAND POI' : 'SUPPLY POI'}</text>`;
  }

  // Candlesticks
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const cx = x + i * step + step / 2;
    const isUp = c.c >= c.o;
    const color = isUp ? '#22c55e' : '#ef4444';
    const wickHighY = getY(c.h);
    const wickLowY = getY(c.l);
    const bodyTop = getY(Math.max(c.o, c.c));
    const bodyBottom = getY(Math.min(c.o, c.c));
    const bodyH = Math.max(1, bodyBottom - bodyTop);

    // Wick
    svg += `<line x1="${cx.toFixed(1)}" y1="${wickHighY.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${wickLowY.toFixed(1)}" stroke="${color}" stroke-width="1.2"/>`;
    // Body
    svg += `<rect x="${(cx - candleW / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${candleW.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${color}"/>`;
  }

  // Extra price levels (Entry, SL, TP1, TP2)
  for (const lvl of extraLevels) {
    const ly = getY(lvl.price);
    const dash = lvl.dash ? `stroke-dasharray="${lvl.dash}"` : '';
    svg += `<line x1="${x}" y1="${ly.toFixed(1)}" x2="${x + w}" y2="${ly.toFixed(1)}" stroke="${lvl.color}" stroke-width="1.5" ${dash}/>`;
    svg += `<text x="${x + 6}" y="${(ly - 4).toFixed(1)}" fill="${lvl.color}" font-size="10" font-weight="bold" font-family="sans-serif">${esc(lvl.label)}: ${fmt(lvl.price)}</text>`;
  }

  return svg;
}

/**
 * Generate a dual-view candlestick chart SVG string (15m HTF + 1m LTF) with POI box and SL/TP levels.
 */
export function generateChartSvg(symbol: string, htfCandles: Candle[], ltfCandles: Candle[], setup: Setup, opts: ChartOptions = {}): string {
  const width = opts.width ?? 860;
  const height = opts.height ?? 540;

  const margin = 16;
  const headerHeight = 44;
  const panelGap = 16;
  const contentW = width - margin * 2;
  const availH = height - headerHeight - margin * 2 - panelGap;
  const htfH = Math.round(availH * 0.40);
  const ltfH = availH - htfH;

  const htfLayout: PanelLayout = { x: margin, y: margin + headerHeight, w: contentW, h: htfH };
  const ltfLayout: PanelLayout = { x: margin, y: htfLayout.y + htfH + panelGap, w: contentW, h: ltfH };

  const dirColor = setup.direction === 'LONG' ? '#22c55e' : '#ef4444';
  const dirLabel = setup.direction === 'LONG' ? 'LONG 🟢' : setup.direction === 'SHORT' ? 'SHORT 🔴' : '';

  const htfSlice = htfCandles.slice(-40);
  const ltfSlice = ltfCandles.slice(-60);

  const zoneInfo = setup.zone ? { top: setup.zone.top, bottom: setup.zone.bottom, isDemand: setup.direction === 'LONG' } : null;

  const ltfLevels: { price: number; color: string; label: string; dash?: string }[] = [];
  if (setup.entry) ltfLevels.push({ price: setup.entry, color: '#38bdf8', label: 'ENTRY', dash: '4,4' });
  if (setup.sl) ltfLevels.push({ price: setup.sl, color: '#f87171', label: 'SL', dash: '2,2' });
  if (setup.tp1) ltfLevels.push({ price: setup.tp1, color: '#4ade80', label: 'TP1 (1:3)', dash: '4,2' });
  if (setup.tp2) ltfLevels.push({ price: setup.tp2, color: '#22c55e', label: 'TP2 (1:5)' });

  const dateStr = new Date(setup.ts * 1000).toUTCString();

  return `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="background:#0d1117;">
  <rect width="100%" height="100%" fill="#0d1117"/>

  <!-- Header -->
  <g transform="translate(${margin}, ${margin})">
    <text x="0" y="20" fill="#f0f6fc" font-size="18" font-weight="bold" font-family="sans-serif">${setup.strategyId ? `[${setup.strategyId}] ` : ''}${esc(symbol)}</text>
    <text x="140" y="20" fill="${dirColor}" font-size="15" font-weight="bold" font-family="sans-serif">${dirLabel}</text>
    <text x="250" y="20" fill="#8b949e" font-size="13" font-family="sans-serif">Price: <tspan fill="#f0f6fc" font-weight="bold">${fmt(setup.price)}</tspan></text>
    <text x="${contentW}" y="20" fill="#8b949e" font-size="11" text-anchor="end" font-family="sans-serif">${dateStr}</text>
    <line x1="0" y1="32" x2="${contentW}" y2="32" stroke="#30363d" stroke-width="1"/>
  </g>

  <!-- Panel 1: HTF POI Context -->
  <g>
    <rect x="${htfLayout.x}" y="${htfLayout.y}" width="${htfLayout.w}" height="${htfLayout.h}" fill="#161b22" rx="4" stroke="#30363d" stroke-width="1"/>
    <text x="${htfLayout.x + 8}" y="${htfLayout.y - 4}" fill="#8b949e" font-size="11" font-weight="bold" font-family="sans-serif">${setup.strategyId === 'MOD-01D' ? '1H Higher Timeframe (POI Context)' : '15m Higher Timeframe (POI Context)'}</text>
    ${renderPanelCandles(htfSlice, htfLayout, [], zoneInfo)}
  </g>

  <!-- Panel 2: LTF CHoCH Execution -->
  <g>
    <rect x="${ltfLayout.x}" y="${ltfLayout.y}" width="${ltfLayout.w}" height="${ltfLayout.h}" fill="#161b22" rx="4" stroke="#30363d" stroke-width="1"/>
    <text x="${ltfLayout.x + 8}" y="${ltfLayout.y - 4}" fill="#8b949e" font-size="11" font-weight="bold" font-family="sans-serif">${setup.strategyId === 'MOD-01D' ? '5m Execution Timeframe (CHoCH Break &amp; Trade Levels)' : `${setup.ltfMinutes ?? 1}m Lower Timeframe (CHoCH Break &amp; Trade Levels)`}</text>
    ${renderPanelCandles(ltfSlice, ltfLayout, ltfLevels, zoneInfo)}
  </g>
</svg>
`.trim();
}

/**
 * Render a dual-view chart PNG buffer for Discord/Telegram attachments.
 */
export function renderChartPng(symbol: string, htfCandles: Candle[], ltfCandles: Candle[], setup: Setup, opts?: ChartOptions): Buffer {
  const svg = generateChartSvg(symbol, htfCandles, ltfCandles, setup, opts);
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: opts?.width ?? 860 },
  });
  return resvg.render().asPng();
}
