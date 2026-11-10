import type { Setup } from '../types.js';
import { STAGE_COLOR, formatAlert, mexcLink } from './format.js';

export interface Notifier {
  name: string;
  send(setup: Setup, imageBuffer?: Buffer | null): Promise<void>;
  sendText?(text: string): Promise<void>;
}

export class DiscordNotifier implements Notifier {
  name = 'discord';
  private getUrl: () => string | null;
  private getEnabled: () => boolean;

  constructor(
    urlOrGetter: string | null | (() => string | null),
    enabledOrGetter: boolean | (() => boolean) = true,
  ) {
    this.getUrl = typeof urlOrGetter === 'function' ? urlOrGetter : () => (urlOrGetter || null);
    this.getEnabled = typeof enabledOrGetter === 'function' ? enabledOrGetter : () => Boolean(enabledOrGetter);
  }

  async send(s: Setup, imageBuffer?: Buffer | null): Promise<void> {
    const url = this.getUrl();
    if (!url || !this.getEnabled()) return;

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
      const res = await fetch(url, { method: 'POST', body: form });
      if (!res.ok) throw new Error(`Discord webhook HTTP ${res.status}`);
      return;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!res.ok) throw new Error(`Discord webhook HTTP ${res.status}`);
  }

  async sendText(text: string): Promise<void> {
    const url = this.getUrl();
    if (!url || !this.getEnabled()) return;

    const lines = text.split('\n');
    const title = lines[0] || 'Mochbot Trade Milestone';
    const description = lines.slice(1).join('\n');
    const isSl = title.includes('STOP LOSS');
    const isTp = title.includes('TAKE PROFIT') || title.includes('TP1') || title.includes('TP2');
    const embed: Record<string, any> = {
      title,
      description: description || undefined,
      color: isSl ? 0xef4444 : isTp ? 0x22c55e : 0x38bdf8,
      timestamp: new Date().toISOString(),
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!res.ok) throw new Error(`Discord webhook HTTP ${res.status}`);
  }

  static async testWebhook(rawUrl?: string | null): Promise<{ ok: boolean; status?: number; error?: string }> {
    const url = (rawUrl || '').trim();
    if (!url) return { ok: false, error: 'Missing Discord Webhook URL' };
    if (!url.startsWith('https://discord.com/api/webhooks/') && !url.startsWith('https://discordapp.com/api/webhooks/')) {
      return { ok: false, error: 'Invalid Discord webhook URL (must start with https://discord.com/api/webhooks/)' };
    }
    try {
      const embed = {
        title: '🤖 Mochbot Discord Alert Connected!',
        description: 'Your Discord webhook is configured and ready to receive real-time trading signals and trade milestone updates.',
        color: 0x22c55e,
        timestamp: new Date().toISOString(),
        footer: { text: 'Mochbot · Limit Desk' },
      };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }),
      });
      if (!res.ok) {
        return { ok: false, status: res.status, error: `Discord HTTP ${res.status}: ${res.statusText}` };
      }
      return { ok: true, status: res.status };
    } catch (err: any) {
      return { ok: false, error: err.message || 'Network connection failed' };
    }
  }
}
