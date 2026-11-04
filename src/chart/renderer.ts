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

export interface PositionBoxConfig {
  direction: 'LONG' | 'SHORT';
  entry: number;
  sl: number;
  tp1?: number | null;
  tp2?: number | null;
}

function renderPanelCandles(
  candles: Candle[],
  layout: PanelLayout,
  positionBox?: PositionBoxConfig | null,
  zone?: { top: number; bottom: number; isDemand: boolean; label?:string } | null,
  fallbackLevels: { price: number; color: string; label: string; dash?: string }[] = [],
): string {
  if (!candles.length) return '';
  const { x, y, w, h } = layout;

  const axisW = 90; // Dedicated right price axis column
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
  if (positionBox && positionBox.entry && positionBox.sl) {
    const boxLevels = [positionBox.entry, positionBox.sl, positionBox.tp1, positionBox.tp2].filter(
      (v): v is number => typeof v === 'number' && Number.isFinite(v),
    );
    for (const lvl of boxLevels) {
      if (lvl < minP) minP = lvl;
      if (lvl > maxP) maxP = lvl;
    }
  }
  for (const lvl of fallbackLevels) {
    if (lvl.price < minP) minP = lvl.price;
    if (lvl.price > maxP) maxP = lvl.price;
  }

  // 8% padding top and bottom for proper vertical breathing room
  const pDiff = maxP - minP || 1;
  const pad = pDiff * 0.08;
  minP -= pad;
  maxP += pad;
  const range = maxP - minP;

  const getY = (p: number) => y + h - ((p - minP) / range) * h;
  const step = chartW / candles.length;
  // Sleek, proportional TradingView candlestick width
  const candleW = Math.max(4, Math.min(12, step * 0.68));

  let svg = '';

  // Price axis background strip
  svg += `<rect x="${x + chartW}" y="${y}" width="${axisW}" height="${h}" fill="#12161c" stroke="#30363d" stroke-width="1"/>`;

  // Background grid lines (5 horizontal lines)
  for (let g = 1; g <= 5; g++) {
    const p = minP + (range * g) / 6;
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
    const zFill = zone.isDemand ? 'rgba(16, 185, 129, 0.14)' : 'rgba(244, 63, 94, 0.14)';
    svg += `<rect x="${x}" y="${zTopY.toFixed(1)}" width="${chartW}" height="${zHeight.toFixed(1)}" fill="${zFill}" stroke="${zColor}" stroke-width="1.2" stroke-dasharray="4,2"/>`;
  }

  // --- TRADINGVIEW LONG/SHORT POSITION DRAWING BOX (Layer 2: Shaded Zones) ---
  const hasPosBox = Boolean(positionBox && positionBox.entry && positionBox.sl);
  const isLong = positionBox?.direction === 'LONG';
  let boxX = x + Math.round(chartW * 0.48);
  let boxW = x + chartW - boxX;
  let entryY = 0;
  let slY = 0;
  let tp1Y: number | null = null;
  let tp2Y = 0;

  if (hasPosBox && positionBox) {
    entryY = getY(positionBox.entry);
    slY = getY(positionBox.sl);
    tp1Y = positionBox.tp1 ? getY(positionBox.tp1) : null;
    tp2Y = positionBox.tp2 ? getY(positionBox.tp2) : (tp1Y ?? entryY);

    const profitTopY = Math.min(entryY, tp2Y);
    const profitH = Math.max(2, Math.abs(tp2Y - entryY));
    const lossTopY = Math.min(entryY, slY);
    const lossH = Math.max(2, Math.abs(slY - entryY));

    // Green Profit Zone (TradingView style)
    svg += `<g class="tv-profit-zone">
      <rect x="${boxX}" y="${profitTopY.toFixed(1)}" width="${boxW}" height="${profitH.toFixed(1)}" fill="rgba(34, 197, 94, 0.20)" stroke="#22c55e" stroke-width="1.5"/>
      <line x1="${x}" y1="${tp2Y.toFixed(1)}" x2="${boxX}" y2="${tp2Y.toFixed(1)}" stroke="#22c55e" stroke-width="1" stroke-dasharray="3,3" opacity="0.6"/>
    </g>`;

    // Red Stop Loss Zone (TradingView style)
    svg += `<g class="tv-loss-zone">
      <rect x="${boxX}" y="${lossTopY.toFixed(1)}" width="${boxW}" height="${lossH.toFixed(1)}" fill="rgba(239, 68, 68, 0.20)" stroke="#ef4444" stroke-width="1.5"/>
      <line x1="${x}" y1="${slY.toFixed(1)}" x2="${boxX}" y2="${slY.toFixed(1)}" stroke="#ef4444" stroke-width="1" stroke-dasharray="3,3" opacity="0.6"/>
    </g>`;
  }

  // --- CANDLESTICKS (Layer 3: Rendered with bold width and crisp contrast) ---
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const cx = x + i * step + step / 2;
    const isUp = c.c >= c.o;
    const color = isUp ? '#26a69a' : '#ef5350';
    const wickHighY = getY(c.h);
    const wickLowY = getY(c.l);
    const bodyTop = getY(Math.max(c.o, c.c));
    const bodyBottom = getY(Math.min(c.o, c.c));
    const bodyH = Math.max(1.5, bodyBottom - bodyTop);

    // Clean TradingView wick
    svg += `<line x1="${cx.toFixed(1)}" y1="${wickHighY.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${wickLowY.toFixed(1)}" stroke="${color}" stroke-width="1.4"/>`;
    // Sleek TradingView candle body
    svg += `<rect x="${(cx - candleW / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${candleW.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${color}" rx="0.5"/>`;
  }

  // --- POI BADGE (Layer 4) ---
  if (zone) {
    const zTopY = Math.min(getY(zone.top), getY(zone.bottom));
    const zColor = zone.isDemand ? '#10b981' : '#f43f5e';
    const zLabel = zone.label ?? (zone.isDemand ? 'DEMAND POI' : 'SUPPLY POI');
    svg += `<rect x="${x + 6}" y="${(zTopY + 2).toFixed(1)}" width="84" height="15" rx="3" fill="#0d1117" opacity="0.92" stroke="${zColor}" stroke-width="0.8"/>`;
    svg += `<text x="${x + 48}" y="${(zTopY + 13).toFixed(1)}" fill="${zColor}" font-size="9" font-weight="bold" text-anchor="middle" font-family="'DejaVu Sans', sans-serif">${zLabel}</text>`;
  }

  // --- TRADINGVIEW POSITION TOOL OVERLAYS & BADGES (Layer 5: Solid lines & crisp labels) ---
  if (hasPosBox && positionBox) {
    const initialRisk=Math.abs(positionBox.entry-positionBox.sl);
    const rr=(target:number|null|undefined)=>target&&initialRisk>0?Number((Math.abs(target-positionBox.entry)/initialRisk).toFixed(2)):'-';
    // 1. Target TP2 Border & Badge
    svg += `<line x1="${boxX}" y1="${tp2Y.toFixed(1)}" x2="${x + chartW}" y2="${tp2Y.toFixed(1)}" stroke="#22c55e" stroke-width="2"/>`;
    const tp2BadgeY = isLong ? Math.min(y + h - 18, Math.max(y + 2, tp2Y + 4)) : Math.max(y + 2, tp2Y - 18);
    svg += `<rect x="${boxX + 6}" y="${tp2BadgeY.toFixed(1)}" width="118" height="16" rx="3" fill="#22c55e"/>`;
    svg += `<text x="${boxX + 11}" y="${(tp2BadgeY + 12).toFixed(1)}" fill="#0d1117" font-size="9.5" font-weight="bold" font-family="'DejaVu Sans', sans-serif">TP2 (1:${rr(positionBox.tp2)}) · TARGET</text>`;

    // 2. TP1 Milestone Line & Badge
    if (tp1Y !== null) {
      svg += `<line x1="${x}" y1="${tp1Y.toFixed(1)}" x2="${x + chartW}" y2="${tp1Y.toFixed(1)}" stroke="#4ade80" stroke-width="1.2" stroke-dasharray="4,3"/>`;
      svg += `<rect x="${boxX + 6}" y="${(tp1Y - 14).toFixed(1)}" width="88" height="14" rx="3" fill="#0d1117" opacity="0.92" stroke="#4ade80" stroke-width="0.8"/>`;
      svg += `<text x="${boxX + 10}" y="${(tp1Y - 3).toFixed(1)}" fill="#4ade80" font-size="9" font-weight="bold" font-family="'DejaVu Sans', sans-serif">TP1 (1:${rr(positionBox.tp1)})</text>`;
    }

    // 3. Stop Loss Border & Badge
    svg += `<line x1="${boxX}" y1="${slY.toFixed(1)}" x2="${x + chartW}" y2="${slY.toFixed(1)}" stroke="#ef4444" stroke-width="2"/>`;
    const slBadgeY = isLong ? Math.max(y + 2, slY - 18) : Math.min(y + h - 18, Math.max(y + 2, slY + 4));
    svg += `<rect x="${boxX + 6}" y="${slBadgeY.toFixed(1)}" width="96" height="16" rx="3" fill="#ef4444"/>`;
    svg += `<text x="${boxX + 11}" y="${(slBadgeY + 12).toFixed(1)}" fill="#0d1117" font-size="9.5" font-weight="bold" font-family="'DejaVu Sans', sans-serif">SL (-1R)</text>`;

    // 4. Entry Line & Badge
    svg += `<line x1="${x}" y1="${entryY.toFixed(1)}" x2="${x + chartW}" y2="${entryY.toFixed(1)}" stroke="#38bdf8" stroke-width="2"/>`;
    svg += `<rect x="${boxX + 6}" y="${(entryY - 8).toFixed(1)}" width="74" height="16" rx="3" fill="#38bdf8"/>`;
    svg += `<text x="${boxX + 11}" y="${(entryY + 4).toFixed(1)}" fill="#0d1117" font-size="9.5" font-weight="bold" font-family="'DejaVu Sans', sans-serif">ENTRY</text>`;

    // 5. TradingView R:R Badge
    svg += `<rect x="${boxX + boxW - 82}" y="${(entryY - 8).toFixed(1)}" width="76" height="16" rx="3" fill="#1c2128" stroke="#38bdf8" stroke-width="1"/>`;
    svg += `<text x="${boxX + boxW - 44}" y="${(entryY + 4).toFixed(1)}" fill="#38bdf8" font-size="9" font-weight="bold" text-anchor="middle" font-family="'DejaVu Sans Mono', monospace">R:R 1:${rr(positionBox.tp2)}</text>`;

    // 6. Right Price Axis Badges
    const axisBadges = [
      { price: positionBox.tp2, color: '#22c55e', text: '#0d1117' },
      ...(positionBox.tp1 ? [{ price: positionBox.tp1, color: '#4ade80', text: '#0d1117' }] : []),
      { price: positionBox.entry, color: '#38bdf8', text: '#0d1117' },
      { price: positionBox.sl, color: '#ef4444', text: '#ffffff' },
    ];
    for (const b of axisBadges) {
      if (!b.price) continue;
      const by = getY(b.price);
      const bH = 17;
      svg += `<rect x="${x + chartW + 2}" y="${(by - bH / 2).toFixed(1)}" width="${axisW - 4}" height="${bH}" rx="3" fill="${b.color}"/>`;
      svg += `<text x="${(x + chartW + axisW / 2).toFixed(1)}" y="${(by + 4).toFixed(1)}" fill="${b.text}" font-size="9.5" font-weight="bold" text-anchor="middle" font-family="'DejaVu Sans Mono', monospace">${fmt(b.price)}</text>`;
    }
  } else {
    // Fallback extra levels if no positionBox provided
    for (const lvl of fallbackLevels) {
      const ly = getY(lvl.price);
      const dash = lvl.dash ? `stroke-dasharray="${lvl.dash}"` : '';
      svg += `<line x1="${x}" y1="${ly.toFixed(1)}" x2="${x + chartW}" y2="${ly.toFixed(1)}" stroke="${lvl.color}" stroke-width="1.5" ${dash}/>`;
      const tagText = `${esc(lvl.label)}`;
      const tagW = tagText.length * 6.5 + 10;
      svg += `<rect x="${x + 6}" y="${(ly - 15).toFixed(1)}" width="${tagW.toFixed(0)}" height="15" rx="3" fill="#0d1117" opacity="0.92" stroke="${lvl.color}" stroke-width="0.8"/>`;
      svg += `<text x="${x + 11}" y="${(ly - 4).toFixed(1)}" fill="${lvl.color}" font-size="9.5" font-weight="bold" font-family="'DejaVu Sans', sans-serif">${tagText}</text>`;
      const badgeH = 17;
      const badgeY = ly - badgeH / 2;
      const badgeCenterX = x + chartW + axisW / 2;
      svg += `<rect x="${x + chartW + 2}" y="${badgeY.toFixed(1)}" width="${axisW - 4}" height="${badgeH}" rx="3" fill="${lvl.color}"/>`;
      svg += `<text x="${badgeCenterX.toFixed(1)}" y="${(ly + 4).toFixed(1)}" fill="#0d1117" font-size="9.5" font-weight="bold" text-anchor="middle" font-family="'DejaVu Sans Mono', monospace">${fmt(lvl.price)}</text>`;
    }
  }

  return svg;
}

/**
 * Generate a dual-view candlestick chart SVG string (15m HTF + 1m/3m/5m LTF) with TradingView Long/Short position boxes and enlarged candles.
 */
export function generateChartSvg(symbol: string, htfCandles: Candle[], ltfCandles: Candle[], setup: Setup, opts: ChartOptions = {}): string {
  const width = opts.width ?? 960;
  const height = opts.height ?? 700;

  const margin = 16;
  const headerHeight = 52;
  const panelGap = 16;
  const panelHeaderH = 24; // Dedicated panel title header bar (prevents title from overlapping price levels)
  const contentW = width - margin * 2;
  const availH = height - headerHeight - margin * 2 - panelGap;
  const htfH = Math.round(availH * 0.38);
  const ltfH = availH - htfH;

  const htfLayout: PanelLayout = { x: margin, y: margin + headerHeight + panelHeaderH, w: contentW, h: htfH - panelHeaderH };
  const ltfLayout: PanelLayout = { x: margin, y: margin + headerHeight + htfH + panelGap + panelHeaderH, w: contentW, h: ltfH - panelHeaderH };

  const isLong = setup.direction === 'LONG';
  const dirColor = isLong ? '#22c55e' : '#ef4444';
  const dirBg = isLong ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)';
  const dirBorder = isLong ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)';
  const dirLabel = isLong ? 'LONG 🟢' : setup.direction === 'SHORT' ? 'SHORT 🔴' : '';

  // 50 HTF candles & 60 LTF candles for proper structural view and TradingView proportions
  const htfSlice = htfCandles.slice(-50);
  const ltfSlice = ltfCandles.slice(-60);

  const zoneInfo = setup.zone ? { top: setup.zone.top, bottom: setup.zone.bottom, isDemand: isLong, label:setup.strategyId==='EMA-PULLBACK'?'EMA PULLBACK':undefined } : null;

  const positionBox: PositionBoxConfig | null = (setup.entry && setup.sl) ? {
    direction: isLong ? 'LONG' : 'SHORT',
    entry: setup.entry,
    sl: setup.sl,
    tp1: setup.tp1,
    tp2: setup.tp2,
  } : null;

  const dateStr = new Date(setup.ts * 1000).toUTCString();
  const htfTitle = setup.strategyId === 'EMA-PULLBACK' ? `${(setup.emaTimeframes?.trendMinutes??60)/60}H EMA Trend Context` : setup.strategyId === 'MOD-01D' ? '1H Higher Timeframe (POI Context)' : setup.strategyId === 'MOD-01E' ? '1H Bias & 15m Dealing Range' : '15m Higher Timeframe (POI Context)';
  const ltfTitle = setup.strategyId==='EMA-PULLBACK' ? `${setup.emaTimeframes?.confirmationMinutes??setup.ltfMinutes??5}m Execution Timeframe (TradingView Position & Levels)` : ['MOD-01D','MOD-01E'].includes(setup.strategyId??'') ? '5m Execution Timeframe (TradingView Position & Levels)' : `${setup.ltfMinutes ?? 3}m Execution Timeframe (TradingView Position & Levels)`;

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
    
    <line x1="0" y1="38" x2="${contentW}" y2="38" stroke="#30363d" stroke-width="1"/>
  </g>

  <!-- Panel 1: HTF POI Context -->
  <g>
    <!-- Card Frame -->
    <rect x="${margin}" y="${margin + headerHeight}" width="${contentW}" height="${htfH}" fill="#161b22" rx="6" stroke="#30363d" stroke-width="1"/>
    <!-- Dedicated Title Header Bar -->
    <rect x="${margin}" y="${margin + headerHeight}" width="${contentW}" height="${panelHeaderH}" fill="#12161c" rx="6"/>
    <text x="${margin + 12}" y="${margin + headerHeight + 16}" fill="#8b949e" font-size="11" font-weight="bold" font-family="'DejaVu Sans', sans-serif">${esc(htfTitle)}</text>
    <line x1="${margin}" y1="${margin + headerHeight + panelHeaderH}" x2="${margin + contentW}" y2="${margin + headerHeight + panelHeaderH}" stroke="#30363d" stroke-width="1"/>
    ${renderPanelCandles(htfSlice, htfLayout, null, zoneInfo)}
  </g>

  <!-- Panel 2: LTF CHoCH Execution with TradingView Position Drawing Box -->
  <g>
    <!-- Card Frame -->
    <rect x="${margin}" y="${margin + headerHeight + htfH + panelGap}" width="${contentW}" height="${ltfH}" fill="#161b22" rx="6" stroke="#30363d" stroke-width="1"/>
    <!-- Dedicated Title Header Bar -->
    <rect x="${margin}" y="${margin + headerHeight + htfH + panelGap}" width="${contentW}" height="${panelHeaderH}" fill="#12161c" rx="6"/>
    <text x="${margin + 12}" y="${margin + headerHeight + htfH + panelGap + 16}" fill="#8b949e" font-size="11" font-weight="bold" font-family="'DejaVu Sans', sans-serif">${esc(ltfTitle)}</text>
    <line x1="${margin}" y1="${margin + headerHeight + htfH + panelGap + panelHeaderH}" x2="${margin + contentW}" y2="${margin + headerHeight + htfH + panelGap + panelHeaderH}" stroke="#30363d" stroke-width="1"/>
    ${renderPanelCandles(ltfSlice, ltfLayout, positionBox, zoneInfo)}
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
    fitTo: { mode: 'width', value: opts?.width ?? 960 },
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
