import type { Setup } from '../types.js';
import { STAGE_COLOR, formatAlert, mexcLink } from './format.js';

export interface Notifier {
  name: string;
  send(setup: Setup, imageBuffer?: Buffer | null): Promise<void>;
}

export class DiscordNotifier implements Notifier {
  name = 'discord';
  constructor(private url: string) {}

  async send(s: Setup, imageBuffer?: Buffer | null) {
    const text = formatAlert(s).split('\n');
    const embed: Record<string, any> = {
      title: text[0],
      description: text.slice(1, -1).join('\n'),
      url: mexcLink(s.symbol),
      color: STAGE_COLOR[s.stage] ?? 0x888888,
      timestamp: new Date().toISOString(),
    };

    if (imageBuffer && imageBuffer.length > 0) {
      embed.image = { url: 'attachment://chart.png' };
      const form = new FormData();
      form.append('payload_json', JSON.stringify({ embeds: [embed] }));
      form.append('files[0]', new Blob([new Uint8Array(imageBuffer)], { type: 'image/png' }), 'chart.png');
      const res = await fetch(this.url, { method: 'POST', body: form });
      if (!res.ok) throw new Error(`Discord webhook HTTP ${res.status}`);
      return;
    }

    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!res.ok) throw new Error(`Discord webhook HTTP ${res.status}`);
  }
}
