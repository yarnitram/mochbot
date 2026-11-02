import type { Setup } from '../types.js';

const ICON: Record<string, string> = { WATCH: '👀', ARMED: '🎯', ENTRY_READY: '🚨' };
const LABEL: Record<string, string> = { WATCH: 'WATCH: approaching POI', ARMED: 'ARMED: inside POI, waiting for CHoCH', ENTRY_READY: 'ENTRY READY: CHoCH confirmed' };

function p(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  const a = Math.abs(n);
  const d = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return n.toFixed(d);
}

export function mexcLink(symbol: string) {
  return `https://futures.mexc.com/exchange/${symbol}`;
}

export function formatAlert(s: Setup): string {
  const dir = s.direction === 'LONG' ? 'LONG 🟢' : 'SHORT 🔴';
  const lines: string[] = [`${ICON[s.stage] ?? ''} ${s.symbol} ${dir}`, LABEL[s.stage] ?? s.stage];
  if (s.zone) lines.push(`Zone: ${p(s.zone.bottom)} - ${p(s.zone.top)}`);
  lines.push(`Price: ${p(s.price)}`);
  if (s.stage === 'WATCH' && s.distanceAtr !== null) lines.push(`Distance to POI: ${s.distanceAtr.toFixed(2)} ATR(15m)`);
  if (s.stage === 'ARMED') {
    if (s.needBreak !== null) lines.push(`Need 1m close ${s.direction === 'LONG' ? 'above' : 'below'}: ${p(s.needBreak)}`);
    lines.push(`Bars since tap: ${s.barsSinceTap ?? '-'} / window`);
  }
  if (s.stage === 'ENTRY_READY') {
    lines.push(`Entry: ${p(s.entry)}`, `SL: ${p(s.sl)}`, `TP1 (1:3): ${p(s.tp1)}`, `TP2 (1:5): ${p(s.tp2)}`);
    if (s.orderType) lines.push(`Order: ${s.orderType.replace('_', '-')} - ${s.orderNote ?? ''}`);
  }
  lines.push(s.killzone ? 'Killzone: active' : 'Killzone: inactive');
  lines.push(mexcLink(s.symbol));
  return lines.join('\n');
}

export const STAGE_COLOR: Record<string, number> = { WATCH: 0x3b82f6, ARMED: 0xf59e0b, ENTRY_READY: 0x22c55e };
