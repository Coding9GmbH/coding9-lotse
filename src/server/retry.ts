import 'server-only';
// Limited retries for third-party APIs (Google, OpenAI): only 429 and 5xx, at most 3 attempts, Retry-After is honored.
// 4xx other than 429 are final and never retried. If the server demands a longer pause than the cap, there is no further attempt.

import { log } from './log';

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
export const RETRY_MAX_WAIT_MS = 10_000;

export const retryable = (status: number) => status === 429 || (status >= 500 && status <= 599);

/** Wait time from Retry-After (seconds or HTTP date) or, without the header, exponential backoff from `baseMs`; null = too long, don't wait */
export function retryDelay(r: Response, attempt: number, baseMs = 500, maxMs = RETRY_MAX_WAIT_MS): number | null {
  const h = r.headers.get('retry-after')?.trim();
  let ms = baseMs * 2 ** attempt;
  if (h) {
    const secs = /^\d+(\.\d+)?$/.test(h) ? parseFloat(h) : (Date.parse(h) - Date.now()) / 1000;
    if (Number.isFinite(secs)) ms = Math.max(0, secs * 1000);
  }
  return ms > maxMs ? null : ms;
}

/** `send` calls the API once; after 429/5xx it is sent up to `attempts` times with a pause, the last response is always returned. */
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
