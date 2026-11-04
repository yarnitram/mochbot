export const DISCOVERY_DEFAULTS={volume_limit:100,meme_limit:100,ai_limit:70,game_limit:70,gainers_limit:50,losers_limit:50} as const;
export type DiscoveryLimitKey=keyof typeof DISCOVERY_DEFAULTS;
export function validDiscoveryCount(value:unknown):value is number {
  return typeof value==='number'&&Number.isInteger(value)&&value>=1&&value<=500;
}
