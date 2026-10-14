import 'server-only';
// Shared shop protection for the shop clients (Shopware, Magento, OpenMage): timeout per request, optional concurrency limit,
// on overload (429, and 503 for reads) wait briefly and retry at most 2× (Retry-After is respected, capped at 10 s).
// Writes are retried only on 429 (certainly not processed). The discarded response body is cancelled before waiting (frees the socket).
import { log, urlForLog } from './log';
import { sleep } from './retry';

export type Slot = <T>(fn: () => Promise<T>) => Promise<T>;

/** At most `max` concurrent calls; a free slot is handed directly to the next waiter (no gap in which a newcomer can jump the queue) */
export function createLimiter(max: number): Slot {
  let active = 0;
  const queue: (() => void)[] = [];
  return async fn => {
    if (active >= max) await new Promise<void>(r => queue.push(r)); else active++;
    try { return await fn(); } finally { const next = queue.shift(); if (next) next(); else active--; }
  };
}

export interface ShopFetchOpts {
  /** Shop label for logs ('shopware', 'magento', …) */
  shop: string;
  /** Name in error messages ('Shop', 'Magento', …) */
  name: string;
  timeoutMs: number;
  slot?: Slot;
  /** Builds the thrown error for network errors/timeouts (default: plain Error) */
  toError?: (msg: string) => Error;
}

/** fetch with timeout, optional slot and retry on 429/503 (see above); the last response is returned, network errors throw `toError` */
export async function shopFetch(url: string, init: RequestInit, o: ShopFetchOpts): Promise<Response> {
  const method = init.method ?? 'GET', slot = o.slot ?? (<T>(fn: () => Promise<T>) => fn()), toError = o.toError ?? (m => new Error(m));
  for (let attempt = 0; ; attempt++) {
    const r = await slot(() => fetch(url, { ...init, signal: AbortSignal.timeout(o.timeoutMs) })).catch((e: Error & { cause?: { code?: string } }) => {
      log.warn('Shop nicht erreichbar', { shop: o.shop, url: urlForLog(url), error: e.name === 'TimeoutError' ? 'timeout' : e.cause?.code || e.message });
      throw toError(e.name === 'TimeoutError' ? `${o.name} antwortet nicht (Timeout nach ${o.timeoutMs / 1000}s)` : `${o.name} nicht erreichbar: ${e.cause?.code || e.message}`);
    });
    const retry = r.status === 429 || (r.status === 503 && method === 'GET');
    if (!retry || attempt >= 2) { if (r.status >= 500 || r.status === 429) log.warn('Shop-Anfrage fehlgeschlagen', { shop: o.shop, method, url: urlForLog(url), status: r.status, attempts: attempt + 1 }); return r; }
    const ra = parseInt(r.headers.get('retry-after') ?? '', 10), wait = Math.min(Number.isFinite(ra) ? ra * 1000 : 1000 * 2 ** attempt, 10_000);
    log.info('Shop-Anfrage wird wiederholt', { shop: o.shop, url: urlForLog(url), status: r.status, attempt: attempt + 1, waitMs: wait });
    await r.body?.cancel().catch(() => {});
    await sleep(wait);
  }
}
