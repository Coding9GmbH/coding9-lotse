import 'server-only';
// Privileged OpenMage client: JSON API of the Lotse module (Lotse_Connector) at <shop>/lotse-api/v1 (integrations/openmage/openapi.yaml).
// Stays in the adapter: never in the session, never given to the AI. Auth: bearer token; store scope via ?store=<code> (empty = global, store 0).
// Protecting the shop: timeout per request, at most MAX_CONC concurrent requests, on 429/503 (reads only) wait briefly and retry at most 2×.
import { log, urlForLog } from '../../log';

export interface OmConfig { url: string; publicUrl?: string; storeCode?: string; token?: string }
export class OmError extends Error { constructor(msg: string, public status: number, public code = '') { super(msg); } }

/** Response of GET /v1/info (excerpt) */
export interface OmStoreView { id: number; code: string; name: string; website_id: number; group_id: number; is_active: boolean; is_default: boolean; locale: string; currency: string; base_url: string; link_url: string; media_url: string; root_category_id: number; store_in_url: boolean; title_prefix?: string; title_suffix?: string }
export interface OmInfo {
  platform: string; version: string; magento_version: string; edition: string; module_version: string; shop_name: string; default_store_view: string;
  price_includes_tax: boolean; catalog_price_scope: 'global' | 'website'; save_rewrites_history: boolean; product_url_suffix: string; category_url_suffix: string;
  indexers: { code: string; mode: string; status: string }[]; websites: { id: number; code: string; name: string; is_default: boolean; default_group_id: number; groups: { id: number; name: string; root_category_id: number; default_store_id: number; store_views: OmStoreView[] }[] }[];
  store_views: OmStoreView[];
}
export interface OmListMeta { page: number; limit: number; total: number; pages: number }

const TIMEOUT_MS = Math.max(5_000, parseInt(process.env.LOTSE_SHOP_TIMEOUT_MS ?? '', 10) || 60_000);
const MAX_CONC = Math.min(8, Math.max(1, parseInt(process.env.LOTSE_OPENMAGE_CONCURRENCY ?? '', 10) || 4));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Store code: lowercase letters, digits, underscore (no query injection); '' = global */
export const STORE_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const isGlobal = (store: string | undefined) => !store || store === 'admin' || store === '0' || store === 'all';
export type Query = Record<string, string | number | boolean | undefined | null>;

/** Error text of the API ({ error: { code, message, details } }), without stack trace */
export function omMessage(json: unknown, fallback: string): { message: string; code: string } {
  const e = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
  if (e && typeof e.message === 'string') {
    const msgs = (e.details as { messages?: unknown[] } | null)?.messages;
    return { message: [e.message, ...(Array.isArray(msgs) ? msgs.map(String) : [])].join('; ').slice(0, 600), code: String(e.code ?? '') };
  }
  return { message: fallback.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300), code: '' };
}

export class OmClient {
  cfg!: OmConfig;
  base = '';
  publicUrl = '';
  /** Store view from the settings ('' = the shop's default store view, see workStore()) */
  storeCode = '';
  #info: Promise<OmInfo> | null = null;
  #active = 0;
  #queue: (() => void)[] = [];

  constructor(cfg: OmConfig) { this.configure(cfg); }
  configure(cfg: OmConfig) {
    this.cfg = cfg; this.base = (cfg.url || '').trim().replace(/\/+$/, ''); this.publicUrl = (cfg.publicUrl || cfg.url || '').trim().replace(/\/+$/, '');
    const sc = (cfg.storeCode || '').trim(); this.storeCode = STORE_RE.test(sc) ? sc : '';
    this.#info = null;
  }
  get configured() { return !!(this.base && this.cfg.token); }

  async #slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#active >= MAX_CONC) await new Promise<void>(r => this.#queue.push(r)); else this.#active++;
    try { return await fn(); } finally { const next = this.#queue.shift(); if (next) next(); else this.#active--; }
  }
  // Writing calls one after another: parallel product saves cause deadlocks in the OpenMage indexer (index_process)
  #writes: Promise<unknown> = Promise.resolve();
  async #fetch(url: string, init: RequestInit): Promise<Response> {
    if ((init.method ?? 'GET') === 'GET') return this.#fetchRetry(url, init);
    const run = this.#writes.then(() => this.#fetchRetry(url, init));
    this.#writes = run.catch(() => undefined);
    return run;
  }
  async #fetchRetry(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const r = await this.#slot(() => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })).catch((e: Error & { cause?: { code?: string } }) => {
        log.warn('Shop nicht erreichbar', { shop: 'openmage', url: urlForLog(url), error: e.name === 'TimeoutError' ? 'timeout' : e.cause?.code || e.message });
        throw new OmError(e.name === 'TimeoutError' ? `OpenMage antwortet nicht (Timeout nach ${TIMEOUT_MS / 1000}s)` : `OpenMage nicht erreichbar: ${e.cause?.code || e.message}`, 0);
      });
      const retry = r.status === 429 || (r.status === 503 && (init.method ?? 'GET') === 'GET');
      if (!retry || attempt >= 2) { if (r.status >= 500 || r.status === 429) log.warn('Shop-Anfrage fehlgeschlagen', { shop: 'openmage', method: init.method ?? 'GET', url: urlForLog(url), status: r.status, attempts: attempt + 1 }); return r; }
      const ra = parseInt(r.headers.get('retry-after') ?? '', 10), wait = Math.min(Number.isFinite(ra) ? ra * 1000 : 1000 * 2 ** attempt, 10_000);
      log.info('Shop-Anfrage wird wiederholt', { shop: 'openmage', url: urlForLog(url), status: r.status, attempt: attempt + 1, waitMs: wait });
      await sleep(wait);
    }
  }

  /** Full URL of an API path (/v1/…) with store and query; path may already carry a query (stored undo steps) */
  url(path: string, o: { store?: string; query?: Query } = {}): string {
    if (!path.startsWith('/v1/')) throw new OmError(`Ungültiger OpenMage-Pfad ${path}`, 0);
    const [p, q = ''] = path.split('?'), params = new URLSearchParams(q);
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined && v !== null && v !== '') params.set(k, String(v === true ? 1 : v === false ? 0 : v));
    if (o.store !== undefined) { if (isGlobal(o.store)) params.delete('store'); else { if (!STORE_RE.test(o.store)) throw new OmError(`Ungültiger Store-Code „${o.store}“`, 0); params.set('store', o.store); } }
    const qs = params.toString();
    return `${this.base}/lotse-api${p}${qs ? `?${qs}` : ''}`;
  }

  /** API call: returns the full response ({ data, meta }); 404 on GET with nullOn404 → null */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async call(method: string, path: string, body?: unknown, o: { store?: string; query?: Query; nullOn404?: boolean } = {}): Promise<any> {
    if (!this.base) throw new OmError('OpenMage ist noch nicht verbunden (Einstellungen).', 0);
    if (!this.cfg.token) throw new OmError('OpenMage-Zugang unvollständig: API-Token fehlt (Einstellungen).', 0);
    const r = await this.#fetch(this.url(path, o), { method, headers: { authorization: `Bearer ${this.cfg.token}`, 'content-type': 'application/json', accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: unknown; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (r.status === 404 && o.nullOn404 && method === 'GET') return null;
    if (!r.ok) {
      const { message, code } = omMessage(json, text);
      const hint = r.status === 404 && code === 'disabled' ? ' (Lotse-Modul im OpenMage-Admin aktivieren: System → Konfiguration → Lotse → API)' : r.status === 404 && !code && /^\/v1\/info/.test(path) ? ' (Lotse-Modul Lotse_Connector im Shop nicht installiert?)' : '';
      throw new OmError(`OpenMage ${method} ${path.replace(/\?.*/, '')} → ${r.status}: ${message}${hint}`, r.status, code);
    }
    return json;
  }
  /** Only the data of a response */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async req(method: string, path: string, body?: unknown, o: { store?: string; query?: Query; nullOn404?: boolean } = {}): Promise<any> {
    const r = await this.call(method, path, body, o);
    return r === null ? null : r?.data ?? r;
  }
  /** List with pagination (page from 1, limit max. 200) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async list(path: string, query: Query = {}, store?: string): Promise<{ items: any[]; meta: OmListMeta }> {
    const r = await this.call('GET', path, undefined, { store, query: { ...query, limit: Math.max(1, Math.min(Number(query.limit ?? 50), 200)) } });
    const m = r?.meta ?? {};
    return { items: Array.isArray(r?.data) ? r.data : [], meta: { page: Number(m.page ?? 1), limit: Number(m.limit ?? 50), total: Number(m.total ?? (Array.isArray(r?.data) ? r.data.length : 0)), pages: Number(m.pages ?? 1) } };
  }

  /** Shop info (once per process, refreshed after reconfigure) */
  info(): Promise<OmInfo> {
    if (!this.#info) this.#info = this.req('GET', '/v1/info').catch(e => { this.#info = null; throw e; }) as Promise<OmInfo>;
    return this.#info;
  }
  resetInfo() { this.#info = null; }
  /** Main store view of the shop (default store view): Lotse writes its inherited texts globally */
  async mainStore(): Promise<string> { return (await this.info()).default_store_view || 'default'; }
  /** Store view in which Lotse reads and writes: the setting, otherwise the main store view */
  async workStore(): Promise<string> { return this.storeCode || this.mainStore(); }
  /** Price basis of catalog prices from the tax config (tax/calculation/price_includes_tax) */
  async priceBasis(): Promise<'gross' | 'net'> { return (await this.info()).price_includes_tax ? 'gross' : 'net'; }

  /** Storefront fetch for the preview (without token) */
  storefrontFetch(url: string, init: RequestInit = {}): Promise<Response> { return this.#fetch(url, init); }
}

/** SKU safely as a path segment (SKUs with "/" are not addressable via the API) */
export const skuPath = (sku: string) => encodeURIComponent(sku);
/** Product ID as a path segment ("id:<n>") */
export const idPath = (id: string | number) => `id:${Number(id)}`;
