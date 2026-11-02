import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { parseWsKline } from './rest.js';
import type { Candle } from '../types.js';

const URL = 'wss://contract.mexc.com/edge';

/** Reconnecting MEXC futures kline subscriber (Min1). Emits 'kline' (symbol, candle) and 'reconnect'. */
export class MexcWs extends EventEmitter {
  private ws: WebSocket | null = null;
  private symbols = new Set<string>();
  private ping: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private lastMsg = 0;
  private attempts = 0;
  private stopped = false;
  private everConnected = false;

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.cleanup();
    this.ws?.terminate();
  }

  subscribe(symbol: string) {
    if (this.symbols.has(symbol)) return;
    this.symbols.add(symbol);
    this.send({ method: 'sub.kline', param: { symbol, interval: 'Min1' } });
  }

  unsubscribe(symbol: string) {
    if (!this.symbols.delete(symbol)) return;
    this.send({ method: 'unsub.kline', param: { symbol, interval: 'Min1' } });
  }

  private send(obj: unknown) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private cleanup() {
    if (this.ping) clearInterval(this.ping);
    if (this.watchdog) clearInterval(this.watchdog);
    this.ping = this.watchdog = null;
  }

  private connect() {
    if (this.stopped) return;
    const ws = new WebSocket(URL);
    this.ws = ws;
    ws.on('open', () => {
      this.attempts = 0;
      this.lastMsg = Date.now();
      for (const s of this.symbols) this.send({ method: 'sub.kline', param: { symbol: s, interval: 'Min1' } });
      this.ping = setInterval(() => this.send({ method: 'ping' }), 15_000);
      this.watchdog = setInterval(() => {
        if (Date.now() - this.lastMsg > 60_000) ws.terminate();
      }, 10_000);
      if (this.everConnected) this.emit('reconnect');
      this.everConnected = true;
    });
    ws.on('message', raw => {
      this.lastMsg = Date.now();
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const k = parseWsKline(msg);
      if (k) this.emit('kline', k.symbol, k.candle as Candle);
    });
    const retry = () => {
      this.cleanup();
      if (this.stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.attempts++);
      setTimeout(() => this.connect(), delay);
    };
    ws.on('close', retry);
    ws.on('error', err => {
      this.emit('error_log', err);
      ws.terminate();
    });
  }
}
