import type { Setup } from '../types.js';
import { formatAlert, mexcLink } from './format.js';
import type { Notifier } from './discord.js';

export type CommandHandler = (cmd: string, args: string[]) => Promise<string>;

/** Telegram via plain Bot API (no SDK). Sends alerts with optional chart photos and long-polls for commands. */
export class TelegramNotifier implements Notifier {
  name = 'telegram';
  private offset = 0;
  private stopped = false;

  constructor(private token: string, private chatId: string) {}

  private async api(method: string, body: unknown, timeoutMs = 40_000): Promise<any> {
    const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
    const headers: Record<string, string> = isFormData ? {} : { 'content-type': 'application/json' };
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers,
      body: isFormData ? (body as FormData) : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json: any = await res.json();
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
    return json.result;
  }

  async sendText(text: string) {
    await this.api('sendMessage', {
      chat_id: this.chatId,
      text,
      disable_web_page_preview: true,
    });
  }

  async send(s: Setup, imageBuffer?: Buffer | null) {
    const text = formatAlert(s);
    const replyMarkup = {
      inline_keyboard: [[{ text: '📈 Open MEXC Futures', url: mexcLink(s.symbol) }]],
    };

    if (imageBuffer && imageBuffer.length > 0) {
      const form = new FormData();
      form.append('chat_id', this.chatId);
      form.append('photo', new Blob([new Uint8Array(imageBuffer)], { type: 'image/png' }), 'chart.png');
      form.append('caption', text);
      form.append('reply_markup', JSON.stringify(replyMarkup));
      await this.api('sendPhoto', form);
      return;
    }

    await this.api('sendMessage', {
      chat_id: this.chatId,
      text,
      disable_web_page_preview: true,
      reply_markup: replyMarkup,
    });
  }

  /** Start command polling. Messages from other chats are ignored. */
  poll(handler: CommandHandler, onError: (e: unknown) => void) {
    const loop = async () => {
      while (!this.stopped) {
        try {
          const updates: any[] = await this.api('getUpdates', { offset: this.offset, timeout: 30, allowed_updates: ['message'] }, 45_000);
          for (const u of updates) {
            this.offset = u.update_id + 1;
            const m = u.message;
            if (!m?.text || String(m.chat?.id) !== this.chatId) continue;
            const [raw, ...args] = m.text.trim().split(/\s+/);
            if (!raw.startsWith('/')) continue;
            const cmd = raw.slice(1).split('@')[0].toLowerCase();
            const reply = await handler(cmd, args);
            if (reply) await this.sendText(reply);
          }
        } catch (e) {
          onError(e);
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    };
    void loop();
  }

  stop() {
    this.stopped = true;
  }
}
