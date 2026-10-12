import 'server-only';
// Privilegierter OpenMage-Client: JSON-API des Lotse-Moduls (Lotse_Connector) unter <shop>/lotse-api/v1 (integrations/openmage/openapi.yaml).
// Bleibt im Adapter: nie in der Session, nie an die KI. Auth: Bearer-Token; Store-Scope über ?store=<code> (leer = global, Store 0).
// Schutz des Shops: Timeout je Anfrage, höchstens MAX_CONC Anfragen gleichzeitig, bei 429/503 (nur Lesen) kurz warten und höchstens 2× wiederholen.

export interface OmConfig { url: string; publicUrl?: string; storeCode?: string; token?: string }
export class OmError extends Error { constructor(msg: string, public status: number, public code = '') { super(msg); } }

/** Antwort von GET /v1/info (Auszug) */
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
/** Store-Code: Kleinbuchstaben, Ziffern, Unterstrich (keine Query-Injektion); '' = global */
export const STORE_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const isGlobal = (store: string | undefined) => !store || store === 'admin' || store === '0' || store === 'all';
export type Query = Record<string, string | number | boolean | undefined | null>;

/** Fehlertext der API ({ error: { code, message, details } }), ohne Stacktrace */
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
  /** Store-View aus den Einstellungen ('' = Standard-Store-View des Shops, siehe workStore()) */
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
  // Schreibende Aufrufe nacheinander: parallele Produkt-Saves lösen in OpenMage Deadlocks im Indexer aus (index_process)
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
        throw new OmError(e.name === 'TimeoutError' ? `OpenMage antwortet nicht (Timeout nach ${TIMEOUT_MS / 1000}s)` : `OpenMage nicht erreichbar: ${e.cause?.code || e.message}`, 0);
      });
      const retry = r.status === 429 || (r.status === 503 && (init.method ?? 'GET') === 'GET');
      if (!retry || attempt >= 2) return r;
      const ra = parseInt(r.headers.get('retry-after') ?? '', 10);
      await sleep(Math.min(Number.isFinite(ra) ? ra * 1000 : 1000 * 2 ** attempt, 10_000));
    }
  }

  /** Vollständige URL eines API-Pfads (/v1/…) mit Store und Query; path darf schon eine Query tragen (gespeicherte Rückgängig-Schritte) */
  url(path: string, o: { store?: string; query?: Query } = {}): string {
    if (!path.startsWith('/v1/')) throw new OmError(`Ungültiger OpenMage-Pfad ${path}`, 0);
    const [p, q = ''] = path.split('?'), params = new URLSearchParams(q);
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined && v !== null && v !== '') params.set(k, String(v === true ? 1 : v === false ? 0 : v));
    if (o.store !== undefined) { if (isGlobal(o.store)) params.delete('store'); else { if (!STORE_RE.test(o.store)) throw new OmError(`Ungültiger Store-Code „${o.store}“`, 0); params.set('store', o.store); } }
    const qs = params.toString();
    return `${this.base}/lotse-api${p}${qs ? `?${qs}` : ''}`;
  }

  /** API-Aufruf: liefert die vollständige Antwort ({ data, meta }); 404 bei GET mit nullOn404 → null */
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
  /** Nur die Daten einer Antwort */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async req(method: string, path: string, body?: unknown, o: { store?: string; query?: Query; nullOn404?: boolean } = {}): Promise<any> {
    const r = await this.call(method, path, body, o);
    return r === null ? null : r?.data ?? r;
  }
  /** Liste mit Paginierung (page ab 1, limit max. 200) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async list(path: string, query: Query = {}, store?: string): Promise<{ items: any[]; meta: OmListMeta }> {
    const r = await this.call('GET', path, undefined, { store, query: { ...query, limit: Math.max(1, Math.min(Number(query.limit ?? 50), 200)) } });
    const m = r?.meta ?? {};
    return { items: Array.isArray(r?.data) ? r.data : [], meta: { page: Number(m.page ?? 1), limit: Number(m.limit ?? 50), total: Number(m.total ?? (Array.isArray(r?.data) ? r.data.length : 0)), pages: Number(m.pages ?? 1) } };
  }

  /** Shop-Info (einmal je Prozess, nach reconfigure neu) */
  info(): Promise<OmInfo> {
    if (!this.#info) this.#info = this.req('GET', '/v1/info').catch(e => { this.#info = null; throw e; }) as Promise<OmInfo>;
    return this.#info;
  }
  resetInfo() { this.#info = null; }
  /** Haupt-Store-View des Shops (Standard-Store-View): deren geerbte Texte schreibt Lotse global */
  async mainStore(): Promise<string> { return (await this.info()).default_store_view || 'default'; }
  /** Store-View, in der Lotse liest und schreibt: Einstellung, sonst die Haupt-Store-View */
  async workStore(): Promise<string> { return this.storeCode || this.mainStore(); }
  /** Preisbasis der Katalogpreise aus der Steuerkonfiguration (tax/calculation/price_includes_tax) */
  async priceBasis(): Promise<'gross' | 'net'> { return (await this.info()).price_includes_tax ? 'gross' : 'net'; }

  /** Storefront-Abruf für die Vorschau (ohne Token) */
  storefrontFetch(url: string, init: RequestInit = {}): Promise<Response> { return this.#fetch(url, init); }
}

/** SKU sicher als Pfadsegment (SKUs mit „/“ sind über die API nicht adressierbar) */
export const skuPath = (sku: string) => encodeURIComponent(sku);
/** Produkt-ID als Pfadsegment („id:<n>“) */
export const idPath = (id: string | number) => `id:${Number(id)}`;
