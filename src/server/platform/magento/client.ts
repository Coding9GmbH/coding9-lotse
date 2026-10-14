import 'server-only';
// Privileged Magento 2 client (REST /rest/<store>/V1 + public GraphQL). Stays in the adapter: never in the session, never given to the AI.
// Auth: integration token (Bearer) or admin user (token via /V1/integration/admin/token, renewed on 401).
// Shop protection: timeout per request, at most MAX_CONC concurrent requests, on 429/503 wait briefly and retry at most 2×.
import { criteriaQuery, type Criteria } from './criteria';
import { parseBasis, type PriceBasis } from './map';
import { createLimiter, shopFetch } from '../../shop-http';

export interface MagentoConfig { url: string; publicUrl?: string; storeCode?: string; accessToken?: string; user?: string; password?: string; priceBasis?: string }
export class MagentoError extends Error { constructor(msg: string, public status: number) { super(msg); } }

const TIMEOUT_MS = Math.max(5_000, parseInt(process.env.LOTSE_SHOP_TIMEOUT_MS ?? '', 10) || 60_000);
const MAX_CONC = Math.min(8, Math.max(1, parseInt(process.env.LOTSE_MAGENTO_CONCURRENCY ?? '', 10) || 4));
/** Store code for /rest/<store>/V1: lowercase letters, digits, underscore (no path injection) */
export const STORE_RE = /^[a-z][a-z0-9_]{0,31}$/;

/** Magento error text: replace "%1"/"%fieldName" with parameters, omit the stack trace */
export function magentoMessage(json: unknown, fallback: string): string {
  const j = json as { message?: string; parameters?: Record<string, unknown> | unknown[]; errors?: { message?: string; parameters?: unknown }[] } | null;
  const fill = (m: string, p: unknown) => {
    if (!p) return m;
    if (Array.isArray(p)) return m.replace(/%(\d+)/g, (_, i) => String(p[Number(i) - 1] ?? `%${i}`));
    return m.replace(/%(\w+)/g, (x, k) => (k in (p as object) ? String((p as Record<string, unknown>)[k]) : x));
  };
  if (j && typeof j === 'object' && typeof j.message === 'string') {
    const extra = (j.errors ?? []).map(e => fill(String(e.message ?? ''), e.parameters)).filter(Boolean);
    return [fill(j.message, j.parameters), ...extra].join('; ');
  }
  return fallback.slice(0, 400);
}

export class MagentoClient {
  cfg!: MagentoConfig;
  base = '';
  publicUrl = '';
  storeCode = 'default';
  /** Prices in the admin gross or net (setting, Magento doesn't reveal it via the API); null = unknown */
  priceBasis: PriceBasis | null = null;
  #adminToken: string | null = null;
  #adminExpires = 0;
  #adminLogin: Promise<string> | null = null;
  #slot = createLimiter(MAX_CONC);

  constructor(cfg: MagentoConfig) { this.configure(cfg); }
  configure(cfg: MagentoConfig) {
    this.cfg = cfg; this.base = (cfg.url || '').trim().replace(/\/+$/, ''); this.publicUrl = (cfg.publicUrl || cfg.url || '').trim().replace(/\/+$/, '');
    const sc = (cfg.storeCode || '').trim(); this.storeCode = STORE_RE.test(sc) ? sc : 'default';
    this.priceBasis = parseBasis(cfg.priceBasis);
    this.#adminToken = null; this.#adminExpires = 0; this.#adminLogin = null;
  }
  get configured() { return !!(this.base && (this.cfg.accessToken || (this.cfg.user && this.cfg.password))); }

  #fetch(url: string, init: RequestInit): Promise<Response> {
    return shopFetch(url, init, { shop: 'magento', name: 'Magento', timeoutMs: TIMEOUT_MS, slot: this.#slot, toError: m => new MagentoError(m, 0) });
  }

  /** Bearer token: integration token directly, otherwise admin token (Magento default: valid 1 h, cached here for 50 min) */
  async token(force = false): Promise<string> {
    if (!this.base) throw new MagentoError('Magento ist noch nicht verbunden (Einstellungen).', 0);
    if (this.cfg.accessToken) return this.cfg.accessToken;
    if (!this.cfg.user || !this.cfg.password) throw new MagentoError('Magento-Zugang unvollständig (Token oder Admin-Benutzer + Passwort).', 0);
    if (!force && this.#adminToken && Date.now() < this.#adminExpires) return this.#adminToken;
    // parallel first requests share one login
    return (this.#adminLogin ??= this.#login().finally(() => { this.#adminLogin = null; }));
  }
  async #login(): Promise<string> {
    const r = await this.#fetch(`${this.base}/rest/V1/integration/admin/token`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ username: this.cfg.user, password: this.cfg.password }) });
    const text = await r.text();
    if (!r.ok) { let j: unknown = null; try { j = JSON.parse(text); } catch {} throw new MagentoError(`Magento-Anmeldung fehlgeschlagen (${r.status}): ${magentoMessage(j, text)}`, r.status); }
    this.#adminToken = JSON.parse(text) as string; this.#adminExpires = Date.now() + 50 * 60_000;
    return this.#adminToken;
  }

  /**
   * REST call. path starts with /V1/… (store from o.store or the setting) or (for stored undo steps) with /<store>/V1/….
   * Returns JSON; 404 on GET with o.nullOn404 → null.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async req(method: string, path: string, body?: unknown, o: { store?: string; query?: string; nullOn404?: boolean } = {}): Promise<any> {
    const scoped = /^\/[a-z][a-z0-9_]*\/V1\//.test(path);
    if (!scoped && !path.startsWith('/V1/')) throw new MagentoError(`Ungültiger Magento-Pfad ${path}`, 0);
    const store = o.store ?? this.storeCode;
    if (!scoped && !STORE_RE.test(store)) throw new MagentoError(`Ungültiger Store-Code „${store}“`, 0);
    const url = `${this.base}/rest${scoped ? '' : `/${store}`}${path}${o.query ? `?${o.query}` : ''}`;
    for (let auth = 0; ; auth++) {
      const r = await this.#fetch(url, { method, headers: { authorization: `Bearer ${await this.token(auth > 0)}`, 'content-type': 'application/json', accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (r.status === 401 && auth === 0 && !this.cfg.accessToken) continue; // admin token expired → log in again once
      const text = await r.text();
      let json: unknown; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      if (r.status === 404 && o.nullOn404 && method === 'GET') return null;
      if (!r.ok) throw new MagentoError(`Magento ${method} ${path.replace(/\?.*/, '')} → ${r.status}: ${magentoMessage(json, text)}`, r.status);
      return json;
    }
  }

  /** Search with searchCriteria (fields = Magento field selection, e.g. "items[id,sku,name],total_count") */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  search(path: string, c: Criteria = {}, o: { store?: string; fields?: string } = {}): Promise<{ items: any[]; total_count: number }> {
    const q = [criteriaQuery(c), o.fields ? `fields=${encodeURIComponent(o.fields)}` : ''].filter(Boolean).join('&');
    return this.req('GET', path, undefined, { store: o.store, query: q }).then(r => ({ items: r?.items ?? [], total_count: r?.total_count ?? 0 }));
  }

  /** Public storefront GraphQL (without token: public data only), header Store = store view */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async graphql(query: string, variables: Record<string, unknown> = {}, store = this.storeCode): Promise<any> {
    const r = await this.#fetch(`${this.base}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', store }, body: JSON.stringify({ query, variables }) });
    const j = await r.json().catch(() => null) as { data?: unknown; errors?: { message: string }[] } | null;
    if (!r.ok || !j || (j.errors?.length && !j.data)) throw new MagentoError(`Magento GraphQL → ${r.status}: ${j?.errors?.map(e => e.message).join('; ') ?? 'ungültige Antwort'}`, r.status);
    return j.data;
  }

  /** Storefront fetch for the preview (without token) */
  storefrontFetch(url: string, init: RequestInit = {}): Promise<Response> { return this.#fetch(url, init); }
}

/** Insert a SKU safely into a path */
export const skuPath = (sku: string) => encodeURIComponent(sku);
