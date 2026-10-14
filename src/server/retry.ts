import 'server-only';
// Begrenzte Wiederholung für Fremd-APIs (Google, OpenAI): nur 429 und 5xx, höchstens 3 Versuche, Retry-After wird beachtet.
// 4xx außer 429 sind endgültig und werden nie wiederholt. Verlangt der Server eine längere Pause als die Obergrenze, gibt es keinen weiteren Versuch.

import { log } from './log';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
export const RETRY_MAX_WAIT_MS = 10_000;

export const retryable = (status: number) => status === 429 || (status >= 500 && status <= 599);

/** Wartezeit aus Retry-After (Sekunden oder HTTP-Datum) oder, ohne Header, exponentieller Backoff ab `baseMs`; null = zu lang, nicht warten */
export function retryDelay(r: Response, attempt: number, baseMs = 500, maxMs = RETRY_MAX_WAIT_MS): number | null {
  const h = r.headers.get('retry-after')?.trim();
  let ms = baseMs * 2 ** attempt;
  if (h) {
    const secs = /^\d+(\.\d+)?$/.test(h) ? parseFloat(h) : (Date.parse(h) - Date.now()) / 1000;
    if (Number.isFinite(secs)) ms = Math.max(0, secs * 1000);
  }
  return ms > maxMs ? null : ms;
}

/** `send` ruft die API einmal auf; nach 429/5xx wird mit Pause bis zu `attempts`-mal gesendet, die letzte Antwort wird immer zurückgegeben. */
export async function fetchWithRetry(send: () => Promise<Response>, o: { attempts?: number; baseMs?: number; label?: string } = {}): Promise<Response> {
  const attempts = o.attempts ?? 3, api = o.label ?? 'api';
  for (let i = 0; ; i++) {
    const r = await send();
    if (!retryable(r.status)) return r;
    if (i >= attempts - 1) { log.warn('API-Anfrage endgültig fehlgeschlagen', { api, status: r.status, attempts: i + 1 }); return r; }
    const wait = retryDelay(r, i, o.baseMs);
    if (wait == null) { log.warn('API-Anfrage fehlgeschlagen, Retry-After zu lang', { api, status: r.status, attempt: i + 1 }); return r; }
    log.info('API-Anfrage wird wiederholt', { api, status: r.status, attempt: i + 1, waitMs: Math.round(wait) });
    await r.body?.cancel().catch(() => {});
    await sleep(wait);
  }
}
