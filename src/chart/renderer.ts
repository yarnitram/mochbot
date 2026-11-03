import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs';
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

function renderPanelCandles(
  candles: Candle[],
  layout: PanelLayout,
  extraLevels: { price: number; color: string; label: string; dash?: string }[],
  zone?: { top: number; bottom: number; isDemand: boolean } | null,
): string {
  if (!candles.length) return '';
  const { x, y, w, h } = layout;

  const axisW = 86; // Dedicated right price axis column
  const chartW = w - axisW;

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
  const candleW = Math.max(3, Math.min(11, (chartW / candles.length) * 0.72));
  const step = chartW / candles.length;

  let svg = '';

  // Price axis background strip
  svg += `<rect x="${x + chartW}" y="${y}" width="${axisW}" height="${h}" fill="#12161c" stroke="#30363d" stroke-width="1"/>`;

  // Background grid lines (4 horizontal lines)
  for (let g = 1; g <= 4; g++) {
    const p = minP + (range * g) / 5;
    const gy = getY(p);
    svg += `<line x1="${x}" y1="${gy.toFixed(1)}" x2="${x + chartW}" y2="${gy.toFixed(1)}" stroke="#21262d" stroke-width="1" stroke-dasharray="3,3"/>`;
    svg += `<text x="${x + w - 6}" y="${(gy + 3.5).toFixed(1)}" fill="#6e7681" font-size="9.5" text-anchor="end" font-family="'DejaVu Sans Mono', monospace">${fmt(p)}</text>`;
  }

  // Draw POI Zone box if present
  if (zone) {
    const zTopY = Math.min(getY(zone.top), getY(zone.bottom));
    const zBottomY = Math.max(getY(zone.top), getY(zone.bottom));
    const zHeight = Math.max(4, zBottomY - zTopY);
    const zColor = zone.isDemand ? '#10b981' : '#f43f5e';
    const zFill = zone.isDemand ? 'rgba(16, 185, 129, 0.15)' : 'rgba(244, 63, 94, 0.15)';
    svg += `<rect x="${x}" y="${zTopY.toFixed(1)}" width="${chartW}" height="${zHeight.toFixed(1)}" fill="${zFill}" stroke="${zColor}" stroke-width="1.2" stroke-dasharray="4,2"/>`;
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
    const bodyH = Math.max(1.5, bodyBottom - bodyTop);

    // Wick
    svg += `<line x1="${cx.toFixed(1)}" y1="${wickHighY.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${wickLowY.toFixed(1)}" stroke="${color}" stroke-width="1.2"/>`;
    // Body
    svg += `<rect x="${(cx - candleW / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${candleW.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${color}" rx="0.5"/>`;
  }

  // POI Label Pill (rendered ON TOP of candles)
  if (zone) {
    const zTopY = Math.min(getY(zone.top), getY(zone.bottom));
    const zColor = zone.isDemand ? '#10b981' : '#f43f5e';
    const zLabel = zone.isDemand ? 'DEMAND POI' : 'SUPPLY POI';
    svg += `<rect x="${x + 8}" y="${(zTopY + 3).toFixed(1)}" width="86" height="17" rx="3" fill="#0d1117" opacity="0.9" stroke="${zColor}" stroke-width="0.8"/>`;
    svg += `<text x="${x + 51}" y="${(zTopY + 15).toFixed(1)}" fill="${zColor}" font-size="9.5" font-weight="bold" text-anchor="middle" font-family="'DejaVu Sans', sans-serif">${zLabel}</text>`;
  }

  // Extra price levels (Entry, SL, TP1, TP2)
  for (const lvl of extraLevels) {
    const ly = getY(lvl.price);
    const dash = lvl.dash ? `stroke-dasharray="${lvl.dash}"` : '';

    // Line across chart area
    svg += `<line x1="${x}" y1="${ly.toFixed(1)}" x2="${x + chartW}" y2="${ly.toFixed(1)}" stroke="${lvl.color}" stroke-width="1.5" ${dash}/>`;

    // Left label tag pill
    const tagText = `${esc(lvl.label)}`;
    const tagW = tagText.length * 6.5 + 10;
    svg += `<rect x="${x + 6}" y="${(ly - 15).toFixed(1)}" width="${tagW.toFixed(0)}" height="15" rx="3" fill="#0d1117" opacity="0.92" stroke="${lvl.color}" stroke-width="0.8"/>`;
    svg += `<text x="${x + 11}" y="${(ly - 4).toFixed(1)}" fill="${lvl.color}" font-size="9.5" font-weight="bold" font-family="'DejaVu Sans', sans-serif">${tagText}</text>`;

    // Right axis price badge (centered text)
    const badgeH = 17;
    const badgeY = ly - badgeH / 2;
    const badgeCenterX = x + chartW + axisW / 2;
    svg += `<rect x="${x + chartW + 2}" y="${badgeY.toFixed(1)}" width="${axisW - 4}" height="${badgeH}" rx="3" fill="${lvl.color}"/>`;
    svg += `<text x="${badgeCenterX.toFixed(1)}" y="${(ly + 4).toFixed(1)}" fill="#0d1117" font-size="9.5" font-weight="bold" text-anchor="middle" font-family="'DejaVu Sans Mono', monospace">${fmt(lvl.price)}</text>`;
  }

  return svg;
}

/**
 * Generate a dual-view candlestick chart SVG string (15m HTF + 1m/3m/5m LTF) with POI box and SL/TP levels.
 */
export function generateChartSvg(symbol: string, htfCandles: Candle[], ltfCandles: Candle[], setup: Setup, opts: ChartOptions = {}): string {
  const width = opts.width ?? 920;
  const height = opts.height ?? 640;

  const margin = 16;
  const headerHeight = 54;
  const panelGap = 20;
  const contentW = width - margin * 2;
  const availH = height - headerHeight - margin * 2 - panelGap;
  const htfH = Math.round(availH * 0.36);
  const ltfH = availH - htfH;

  const htfLayout: PanelLayout = { x: margin, y: margin + headerHeight, w: contentW, h: htfH };
  const ltfLayout: PanelLayout = { x: margin, y: htfLayout.y + htfH + panelGap, w: contentW, h: ltfH };

  const isLong = setup.direction === 'LONG';
  const dirColor = isLong ? '#22c55e' : '#ef4444';
  const dirBg = isLong ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)';
  const dirBorder = isLong ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)';
  const dirLabel = isLong ? 'LONG 🟢' : setup.direction === 'SHORT' ? 'SHORT 🔴' : '';

  const htfSlice = htfCandles.slice(-40);
  const ltfSlice = ltfCandles.slice(-60);

  const zoneInfo = setup.zone ? { top: setup.zone.top, bottom: setup.zone.bottom, isDemand: isLong } : null;

  const ltfLevels: { price: number; color: string; label: string; dash?: string }[] = [];
  if (setup.entry) ltfLevels.push({ price: setup.entry, color: '#38bdf8', label: 'ENTRY', dash: '4,4' });
  if (setup.sl) ltfLevels.push({ price: setup.sl, color: '#f87171', label: 'SL', dash: '2,2' });
  if (setup.tp1) ltfLevels.push({ price: setup.tp1, color: '#4ade80', label: 'TP1 (1:3)', dash: '4,2' });
  if (setup.tp2) ltfLevels.push({ price: setup.tp2, color: '#22c55e', label: 'TP2 (1:5)' });

  const dateStr = new Date(setup.ts * 1000).toUTCString();

  return `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="background:#0d1117;">
  <!-- Dark Background -->
  <rect width="100%" height="100%" fill="#0d1117"/>

  <!-- Header Section -->
  <g transform="translate(${margin}, ${margin})">
    <!-- Symbol & Strategy -->
    <text x="0" y="24" fill="#f0f6fc" font-size="20" font-weight="bold" font-family="'DejaVu Sans', sans-serif">${setup.strategyId ? `[${setup.strategyId}] ` : ''}${esc(symbol)}</text>
    
    <!-- Direction Badge -->
    <rect x="230" y="6" width="96" height="24" rx="4" fill="${dirBg}" stroke="${dirBorder}" stroke-width="1"/>
    <text x="278" y="22" fill="${dirColor}" font-size="12" font-weight="bold" text-anchor="middle" font-family="'DejaVu Sans', sans-serif">${dirLabel}</text>
    
    <!-- Current Price -->
    <text x="345" y="23" fill="#8b949e" font-size="13" font-family="'DejaVu Sans', sans-serif">Price: <tspan fill="#f0f6fc" font-weight="bold" font-family="'DejaVu Sans Mono', monospace">${fmt(setup.price)}</tspan></text>
    
    <!-- Date / Time -->
    <text x="${contentW}" y="23" fill="#8b949e" font-size="11" text-anchor="end" font-family="'DejaVu Sans Mono', monospace">${dateStr}</text>
    
    <line x1="0" y1="40" x2="${contentW}" y2="40" stroke="#30363d" stroke-width="1"/>
  </g>

  <!-- Panel 1: HTF POI Context -->
  <g>
    <rect x="${htfLayout.x}" y="${htfLayout.y}" width="${htfLayout.w}" height="${htfLayout.h}" fill="#161b22" rx="6" stroke="#30363d" stroke-width="1"/>
    ${renderPanelCandles(htfSlice, htfLayout, [], zoneInfo)}
    <!-- Panel Header Title Pill (drawn on top) -->
    <rect x="${htfLayout.x + 8}" y="${htfLayout.y + 6}" width="220" height="18" rx="3" fill="#0d1117" opacity="0.9" stroke="#30363d" stroke-width="0.8"/>
    <text x="${htfLayout.x + 14}" y="${htfLayout.y + 19}" fill="#8b949e" font-size="10" font-weight="bold" font-family="'DejaVu Sans', sans-serif">${setup.strategyId === 'MOD-01D' ? '1H Higher Timeframe (POI Context)' : '15m Higher Timeframe (POI Context)'}</text>
  </g>

  <!-- Panel 2: LTF CHoCH Execution -->
  <g>
    <rect x="${ltfLayout.x}" y="${ltfLayout.y}" width="${ltfLayout.w}" height="${ltfLayout.h}" fill="#161b22" rx="6" stroke="#30363d" stroke-width="1"/>
    ${renderPanelCandles(ltfSlice, ltfLayout, ltfLevels, zoneInfo)}
    <!-- Panel Header Title Pill (drawn on top) -->
    <rect x="${ltfLayout.x + 8}" y="${ltfLayout.y + 6}" width="290" height="18" rx="3" fill="#0d1117" opacity="0.9" stroke="#30363d" stroke-width="0.8"/>
    <text x="${ltfLayout.x + 14}" y="${ltfLayout.y + 19}" fill="#8b949e" font-size="10" font-weight="bold" font-family="'DejaVu Sans', sans-serif">${setup.strategyId === 'MOD-01D' ? '5m Execution Timeframe (CHoCH &amp; Levels)' : `${setup.ltfMinutes ?? 1}m Lower Timeframe (CHoCH &amp; Levels)`}</text>
  </g>
</svg>
`.trim();
}

const fontDirs: string[] = [];
if (fs.existsSync('/usr/share/fonts')) {
  fontDirs.push('/usr/share/fonts');
}

/**
 * Render a dual-view chart PNG buffer for Discord/Telegram attachments.
 */
export function renderChartPng(symbol: string, htfCandles: Candle[], ltfCandles: Candle[], setup: Setup, opts?: ChartOptions): Buffer {
  const svg = generateChartSvg(symbol, htfCandles, ltfCandles, setup, opts);
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: opts?.width ?? 920 },
    font: {
      loadSystemFonts: true,
      fontDirs: fontDirs.length ? fontDirs : undefined,
      defaultFontFamily: 'DejaVu Sans',
      sansSerifFamily: 'DejaVu Sans',
      monospaceFamily: 'DejaVu Sans Mono',
    },
  });
  return resvg.render().asPng();
}
