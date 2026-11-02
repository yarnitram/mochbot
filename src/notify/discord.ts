import type { Setup } from '../types.js';
import { STAGE_COLOR, formatAlert, mexcLink } from './format.js';

export interface Notifier {
  name: string;
  send(setup: Setup): Promise<void>;
}

export class DiscordNotifier implements Notifier {
  name = 'discord';
  constructor(private url: string) {}
  async send(s: Setup) {
    const text = formatAlert(s).split('\n');
    const body = {
      embeds: [
        {
          title: text[0],
          description: text.slice(1, -1).join('\n'),
          url: mexcLink(s.symbol),
          color: STAGE_COLOR[s.stage] ?? 0x888888,
          timestamp: new Date().toISOString(),
        },
      ],
    };
    const res = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Discord webhook HTTP ${res.status}`);
  }
}
