import type { Setup, Stage } from '../types.js';

/**
 * Decides whether a setup's current stage should produce a new alert.
 * Key = symbol|setupId|stage. Each key fires once per TTL (WATCH/ARMED 6h, ENTRY_READY 24h),
 * plus a per-(symbol, stage) cooldown for WATCH/ARMED to avoid spam across many POIs.
 */
export class AlertGate {
  private seen = new Map<string, number>();
  private cool = new Map<string, number>();

  constructor(
    private cooldownMs = 15 * 60_000,
    private ttlMs: Record<Exclude<Stage, 'IDLE'>, number> = { WATCH: 6 * 3600_000, ARMED: 6 * 3600_000, ENTRY_READY: 24 * 3600_000 },
  ) {}

  static key(s: Pick<Setup, 'symbol' | 'setupId' | 'stage'>) {
    return `${s.symbol}|${s.setupId}|${s.stage}`;
  }
  private cooldownKey(s:Pick<Setup,'symbol'|'setupId'|'stage'>) {
    const scope=s.setupId?.includes(':TURTLE:')?'TURTLE':s.setupId?.includes(':EMA:')?'EMA':s.setupId?.includes('01E:')?'MOD-01E':'legacy';
    return `${s.symbol}|${scope}|${s.stage}`;
  }

  /** Hydrate from persisted alerts so restarts do not re-fire. */
  prime(s: Pick<Setup, 'symbol' | 'setupId' | 'stage'>, atMs: number) {
    if (s.stage === 'IDLE' || !s.setupId) return;
    this.seen.set(AlertGate.key(s), atMs);
    this.cool.set(this.cooldownKey(s), atMs);
  }

  shouldAlert(s: Setup, nowMs = Date.now()): boolean {
    if (s.stage === 'IDLE' || !s.setupId) return false;
    const key = AlertGate.key(s);
    const at = this.seen.get(key);
    if (at !== undefined && nowMs - at < this.ttlMs[s.stage]) return false;
    if (s.stage !== 'ENTRY_READY') {
      const c = this.cool.get(this.cooldownKey(s));
      if (c !== undefined && nowMs - c < this.cooldownMs) return false;
    }
    this.seen.set(key, nowMs);
    this.cool.set(this.cooldownKey(s), nowMs);
    return true;
  }
}
