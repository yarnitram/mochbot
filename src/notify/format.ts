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
  return `https://www.mexc.co/en-PH/futures/${symbol}?type=linear_swap`;
}

export function formatAlert(s: Setup): string {
  const dir = s.direction === 'LONG' ? 'LONG 🟢' : 'SHORT 🔴';
  const stratBadge = s.strategyId ? `[${s.strategyId}] ` : '';
  const lines: string[] = [`${ICON[s.stage] ?? ''} ${stratBadge}${s.symbol} ${dir}`, LABEL[s.stage] ?? s.stage];
  if (s.strategyId === 'MOD-01E' || s.strategyId === 'EMA-PULLBACK') {
    lines[1] = s.stage === 'ARMED' ? 'PENDING LIMIT: ready to place' : s.stage === 'ENTRY_READY' ? 'SIMULATED LIMIT TOUCH' : s.reason ?? s.stage;
    if (s.reason) lines.push(s.reason);
    if (s.orderNote) lines.push(`Setup notes: ${s.orderNote}`);
  }
  if (s.zone) lines.push(`Zone: ${p(s.zone.bottom)} - ${p(s.zone.top)}`);
  lines.push(`Price: ${p(s.price)}`);
  if (s.stage === 'WATCH' && s.distanceAtr !== null) {
    const tfStr = s.strategyId === 'MOD-01D' ? '1H' : '15m';
    lines.push(`Distance to POI: ${s.distanceAtr.toFixed(2)} ATR(${tfStr})`);
  }
  if (s.stage === 'ARMED') {
    const tfBreak = (s.strategyId === 'MOD-01D' || s.strategyId === 'MOD-01E') ? '5m' : `${s.ltfMinutes ?? 1}m`;
    if (s.strategyId === 'MOD-01E' || s.strategyId === 'EMA-PULLBACK') {
      lines.push(`Limit entry: ${p(s.entry)}`, `SL: ${p(s.sl)}`, `TP1: ${p(s.tp1)}`, `TP2: ${p(s.tp2)}`);
      if (s.sizing) lines.push(`Suggested margin: $${s.sizing.margin.toFixed(4)} USDT | Leverage: ${s.sizing.leverage}x`,
        `Estimated SL loss: $${Math.abs(s.sizing.slRiskUsd).toFixed(2)} | Risk budget: $${s.sizing.riskPerTrade.toFixed(2)} (excludes fees/slippage)`);
      if (s.expiresAt) lines.push(`Expires: ${new Date(s.expiresAt * 1000).toISOString()}`);
    } else if (s.needBreak !== null) lines.push(`Need ${tfBreak} close ${s.direction === 'LONG' ? 'above' : 'below'}: ${p(s.needBreak)}`);
    lines.push(`Bars since tap: ${s.barsSinceTap ?? '-'} / window`);
  }
  if (s.stage === 'ENTRY_READY') {
    const risk=s.entry!==null&&s.sl!==null?Math.abs(s.entry-s.sl):0;
    const rr=(target:number|null,fallback:number)=>risk>0&&target!==null&&s.entry!==null?Number((Math.abs(target-s.entry)/risk).toFixed(2)):fallback;
    lines.push(`Entry: ${p(s.entry)}`, `SL: ${p(s.sl)}`, `TP1 (1:${rr(s.tp1,3)}): ${p(s.tp1)}`, `TP2 (1:${rr(s.tp2,5)}): ${p(s.tp2)}`);
    if (s.orderType) lines.push(`Order: ${s.orderType.replace('_', '-')}${['MOD-01E','EMA-PULLBACK'].includes(s.strategyId??'') ? '' : ' - ' + (s.orderNote ?? '')}`);
    if (s.sizing) {
      const qtyStr = s.sizing.qtyCoins < 0.01 ? s.sizing.qtyCoins.toPrecision(3) : s.sizing.qtyCoins.toFixed(4);
      lines.push(
        `💼 Account: $${s.sizing.accountCapital.toFixed(0)} | Margin: $${s.sizing.margin.toFixed(2)} USDT`,
        `⚡ Max Leverage: ${s.sizing.leverage}x | Pos: $${s.sizing.notional.toFixed(2)} (${qtyStr})`,
        `🛑 Est. Risk (SL): -$${Math.abs(s.sizing.slRiskUsd).toFixed(2)} (-1.0R)`,
        `🎯 Est. Gain (TP1): +$${s.sizing.tp1ProfitUsd.toFixed(2)} (+${rr(s.tp1,3)/2}R)`,
        `🚀 Est. Gain (TP2): +$${s.sizing.tp2ProfitUsd.toFixed(2)} (+${(rr(s.tp1,3)+rr(s.tp2,5))/2}R)`
      );
    }
  }
  lines.push(s.killzone ? 'Killzone: active' : 'Killzone: inactive');
  lines.push(mexcLink(s.symbol));
  return lines.join('\n');
}

export const STAGE_COLOR: Record<string, number> = { WATCH: 0x3b82f6, ARMED: 0xf59e0b, ENTRY_READY: 0x22c55e };
