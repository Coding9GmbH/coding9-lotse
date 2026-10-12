import 'server-only';
// Privilegierter Magento-2-Client (REST /rest/<store>/V1 + öffentliches GraphQL). Bleibt im Adapter: nie in der Session, nie an die KI.
// Auth: Integrations-Token (Bearer) oder Admin-Benutzer (Token über /V1/integration/admin/token, wird bei 401 erneuert).
// Schutz des Shops: Timeout je Anfrage, höchstens MAX_CONC Anfragen gleichzeitig, bei 429/503 kurz warten und höchstens 2× wiederholen.
import { criteriaQuery, type Criteria } from './criteria';
import { parseBasis, type PriceBasis } from './map';

export interface MagentoConfig { url: string; publicUrl?: string; storeCode?: string; accessToken?: string; user?: string; password?: string; priceBasis?: string }
export class MagentoError extends Error { constructor(msg: string, public status: number) { super(msg); } }

const TIMEOUT_MS = Math.max(5_000, parseInt(process.env.LOTSE_SHOP_TIMEOUT_MS ?? '', 10) || 60_000);
const MAX_CONC = Math.min(8, Math.max(1, parseInt(process.env.LOTSE_MAGENTO_CONCURRENCY ?? '', 10) || 4));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Store-Code für /rest/<store>/V1: Kleinbuchstaben, Ziffern, Unterstrich (keine Pfad-Injektion) */
export const STORE_RE = /^[a-z][a-z0-9_]{0,31}$/;

/** Magento-Fehlertext: „%1“/„%fieldName“ durch parameters ersetzen, Stacktrace weglassen */
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
  /** Preise im Admin brutto oder netto (Einstellung, Magento verrät es über die API nicht); null = unbekannt */
  priceBasis: PriceBasis | null = null;
  #adminToken: string | null = null;
  #adminExpires = 0;
  #adminLogin: Promise<string> | null = null;
  #active = 0;
  #queue: (() => void)[] = [];

  constructor(cfg: MagentoConfig) { this.configure(cfg); }
  configure(cfg: MagentoConfig) {
    this.cfg = cfg; this.base = (cfg.url || '').trim().replace(/\/+$/, ''); this.publicUrl = (cfg.publicUrl || cfg.url || '').trim().replace(/\/+$/, '');
    const sc = (cfg.storeCode || '').trim(); this.storeCode = STORE_RE.test(sc) ? sc : 'default';
    this.priceBasis = parseBasis(cfg.priceBasis);
    this.#adminToken = null; this.#adminExpires = 0; this.#adminLogin = null;
  }
  get configured() { return !!(this.base && (this.cfg.accessToken || (this.cfg.user && this.cfg.password))); }

  async #slot<T>(fn: () => Promise<T>): Promise<T> {
    // Freier Platz wird direkt an den nächsten Wartenden übergeben (kein Zwischenraum, in dem ein Neuer vordrängelt)
    if (this.#active >= MAX_CONC) await new Promise<void>(r => this.#queue.push(r)); else this.#active++;
    try { return await fn(); } finally { const next = this.#queue.shift(); if (next) next(); else this.#active--; }
  }

  async #fetch(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const r = await this.#slot(() => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })).catch((e: Error & { cause?: { code?: string } }) => {
        throw new MagentoError(e.name === 'TimeoutError' ? `Magento antwortet nicht (Timeout nach ${TIMEOUT_MS / 1000}s)` : `Magento nicht erreichbar: ${e.cause?.code || e.message}`, 0);
      });
      const retry = r.status === 429 || (r.status === 503 && (init.method ?? 'GET') === 'GET'); // Schreibzugriffe nur bei 429 (sicher nicht verarbeitet)
      if (!retry || attempt >= 2) return r;
      const ra = parseInt(r.headers.get('retry-after') ?? '', 10);
      await sleep(Math.min(Number.isFinite(ra) ? ra * 1000 : 1000 * 2 ** attempt, 10_000));
    }
  }

  /** Bearer-Token: Integrations-Token direkt, sonst Admin-Token (Magento-Standard: 1 h gültig, hier 50 min zwischengespeichert) */
  async token(force = false): Promise<string> {
    if (!this.base) throw new MagentoError('Magento ist noch nicht verbunden (Einstellungen).', 0);
    if (this.cfg.accessToken) return this.cfg.accessToken;
    if (!this.cfg.user || !this.cfg.password) throw new MagentoError('Magento-Zugang unvollständig (Token oder Admin-Benutzer + Passwort).', 0);
    if (!force && this.#adminToken && Date.now() < this.#adminExpires) return this.#adminToken;
    // parallele Erstanfragen teilen sich eine Anmeldung
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
   * REST-Aufruf. path beginnt mit /V1/… (Store aus o.store bzw. Einstellung) oder – für gespeicherte Rückgängig-Schritte – mit /<store>/V1/….
   * Liefert JSON; 404 bei GET mit o.nullOn404 → null.
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
      if (r.status === 401 && auth === 0 && !this.cfg.accessToken) continue; // Admin-Token abgelaufen → einmal neu anmelden
      const text = await r.text();
      let json: unknown; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      if (r.status === 404 && o.nullOn404 && method === 'GET') return null;
      if (!r.ok) throw new MagentoError(`Magento ${method} ${path.replace(/\?.*/, '')} → ${r.status}: ${magentoMessage(json, text)}`, r.status);
      return json;
    }
  }

  /** Suche mit searchCriteria (fields = Magento-Feldauswahl, z. B. „items[id,sku,name],total_count“) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  search(path: string, c: Criteria = {}, o: { store?: string; fields?: string } = {}): Promise<{ items: any[]; total_count: number }> {
    const q = [criteriaQuery(c), o.fields ? `fields=${encodeURIComponent(o.fields)}` : ''].filter(Boolean).join('&');
    return this.req('GET', path, undefined, { store: o.store, query: q }).then(r => ({ items: r?.items ?? [], total_count: r?.total_count ?? 0 }));
  }

  /** Öffentliches Storefront-GraphQL (ohne Token: nur öffentliche Daten), Header Store = Store-View */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async graphql(query: string, variables: Record<string, unknown> = {}, store = this.storeCode): Promise<any> {
    const r = await this.#fetch(`${this.base}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', store }, body: JSON.stringify({ query, variables }) });
    const j = await r.json().catch(() => null) as { data?: unknown; errors?: { message: string }[] } | null;
    if (!r.ok || !j || (j.errors?.length && !j.data)) throw new MagentoError(`Magento GraphQL → ${r.status}: ${j?.errors?.map(e => e.message).join('; ') ?? 'ungültige Antwort'}`, r.status);
    return j.data;
  }

  /** Storefront-Abruf für die Vorschau (ohne Token) */
  storefrontFetch(url: string, init: RequestInit = {}): Promise<Response> { return this.#fetch(url, init); }
}

/** SKU sicher in einen Pfad einsetzen */
export const skuPath = (sku: string) => encodeURIComponent(sku);
