import 'server-only';
// Geschützter OpenMage-Lese-Client der KI: feste Lese-Methoden statt freier Abfragen, Freigabeliste der API-Pfade je Bereich,
// erlaubte Query-Parameter je Ressource, Bereinigung sensibler Felder und Zugriffsprotokoll. Das Lotse-Modul kennt keine Kunden-,
// Bestell-, Warenkorb-, Rechnungs-, Benutzer- oder Zahlungs-Endpunkte (404); der Reader weist solche Pfade zusätzlich vorab ab.
import type { ScopeKey } from '@/lib/protocol';
import { DeniedError, DENIED_TERMS, DEFAULT_SCOPES, isSensitiveKey, SCOPES, scrubSensitive, type AccessEvent, type Scopes } from '../../policy';
import { idPath, isGlobal, OmClient, skuPath, STORE_RE, type OmInfo, type OmListMeta, type OmStoreView, type Query } from './client';
import { categoryPath, parseTarget, productPath, type OmCategory, type OmImage, type OmProduct, type OmRecord, type OmStock, type PriceBasis } from './map';

/** Freigabeliste: GET-Pfad (/v1/…) → Bereich. Alles andere wird abgewiesen. */
export const ALLOW: { re: RegExp; scope: ScopeKey; entity: string }[] = [
  { re: /^\/v1\/info$/, scope: 'shop', entity: 'shop' },
  { re: /^\/v1\/products$/, scope: 'products', entity: 'product' },
  { re: /^\/v1\/products\/attributes$/, scope: 'products', entity: 'product-attribute' },
  { re: /^\/v1\/products\/[^/]+$/, scope: 'products', entity: 'product' },
  { re: /^\/v1\/products\/[^/]+\/stock$/, scope: 'products', entity: 'stock' },
  { re: /^\/v1\/products\/[^/]+\/categories$/, scope: 'products', entity: 'category-product' },
  { re: /^\/v1\/(products\/[^/]+\/images|media\/[^/]+)$/, scope: 'media', entity: 'product-image' },
  { re: /^\/v1\/categories$/, scope: 'categories', entity: 'category' },
  { re: /^\/v1\/categories\/\d+$/, scope: 'categories', entity: 'category' },
  { re: /^\/v1\/cms\/pages(\/\d+)?$/, scope: 'cms', entity: 'cms-page' },
  { re: /^\/v1\/cms\/blocks(\/\d+)?$/, scope: 'cms', entity: 'cms-block' },
  { re: /^\/v1\/salesrules(\/\d+)?$/, scope: 'marketing', entity: 'sales-rule' },
  { re: /^\/v1\/salesrules\/\d+\/coupons$/, scope: 'marketing', entity: 'coupon' },
  { re: /^\/v1\/urlrewrites(\/\d+)?$/, scope: 'shop', entity: 'url-rewrite' },
];
/** Erlaubte Query-Parameter je Ressource */
const COMMON = ['store', 'page', 'limit', 'sort', 'dir'];
const QUERY_FIELDS: Record<string, string[]> = {
  product: [...COMMON, 'sku', 'skus', 'ids', 'name', 'term', 'category_id', 'status', 'visibility', 'type', 'attribute_set_id', 'price_from', 'price_to', 'updated_from', 'website_id', 'fields', 'with'],
  'product-attribute': ['store', 'options'], category: [...COMMON, 'root', 'depth', 'flat'],
  'cms-page': [...COMMON, 'identifier', 'title', 'term', 'is_active'], 'cms-block': [...COMMON, 'identifier', 'title', 'term', 'is_active'],
  'sales-rule': [...COMMON, 'is_active', 'name', 'coupon_code', 'website_id'], coupon: COMMON,
  'url-rewrite': [...COMMON, 'sku', 'product_id', 'category_id', 'request_path', 'id_path', 'is_system', 'all'],
};
/** Produktattribute, die die Liste zusätzlich liefern darf (?fields=): nur Inhalts- und SEO-Felder */
export const LIST_FIELDS = ['description', 'short_description', 'meta_title', 'meta_description', 'meta_keyword', 'url_path', 'small_image', 'thumbnail', 'manufacturer', 'cost'];
// Pfade mit Kunden-, Bestell-, Benutzer- oder Zugangsbezug: vor der Freigabeliste hart abweisen (verständliche Meldung)
const DENY_PATH = /(customer|order|invoice|creditmemo|shipment|transaction|carts?\b|quote|checkout|admin|user|token|payment|giftcard|gift-card|newsletter|password|api_user|roles?\b|config)/i;

/** Attributwerte mit sensiblen Schlüsseln (E-Mail, Telefon, Kunden-/Bestellbezug) aus attributes-Objekten entfernen */
export function scrubAttributes(data: unknown): number {
  let n = 0;
  const walk = (x: unknown) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      for (const k of ['attributes', 'attribute_labels']) if (o[k] && typeof o[k] === 'object') for (const code of Object.keys(o[k] as object)) if (isSensitiveKey(code) || DENIED_TERMS.test(code)) { delete (o[k] as Record<string, unknown>)[code]; n++; }
      for (const v of Object.values(o)) walk(v);
    }
  };
  walk(data); return n;
}

export interface OmGuard {
  scopes: () => Scopes;
  /** prüft Pfad und Query-Parameter; liefert die Ressource (für das Protokoll) */
  check(path: string, query?: Query): string;
  after<T>(op: string, entity: string, res: T, n?: number): T;
  deny(entity: string, msg: string): DeniedError;
}
export function createOmGuard({ getScopes = () => DEFAULT_SCOPES, onAccess = () => {} }: { getScopes?: () => Scopes; onAccess?: (a: AccessEvent) => void } = {}): OmGuard {
  const deny = (entity: string, msg: string) => { const e = new DeniedError('ZUGRIFF VERWEIGERT: ' + msg); try { onAccess({ op: 'deny', entity, n: 0, denied: msg.slice(0, 160) }); } catch {} return e; };
  return {
    scopes: getScopes, deny,
    check(path, query = {}) {
      const p = path.replace(/\?.*$/, '');
      if (DENY_PATH.test(p.replace(/^(\/v1\/(?:products|media)\/)[^/]+/, '$1x'))) throw deny('http', `„${p}“ ist für die KI gesperrt (Kunden-, Bestell-, Rechnungs-, Warenkorb-, Benutzer-, Zahlungs- und Zugangsdaten sind grundsätzlich ausgeschlossen).`);
      const hit = ALLOW.find(a => a.re.test(p));
      if (!hit) throw deny('http', `Direkter API-Zugriff GET ${p} ist für die KI nicht erlaubt.`);
      if (!getScopes()[hit.scope]) throw deny(hit.entity, `Zugriff auf „${SCOPES[hit.scope].label}“ ist vom Betreiber nicht freigegeben (Einstellungen → KI-Zugriff).`);
      const allowed = QUERY_FIELDS[hit.entity] ?? ['store'];
      const bad = Object.entries(query).filter(([k, v]) => v !== undefined && v !== null && (!allowed.includes(k) || DENIED_TERMS.test(k) || (k === 'fields' && String(v).split(',').some(f => !LIST_FIELDS.includes(f.trim()))))).map(([k]) => k);
      if (bad.length) throw deny(hit.entity, `Filter ${bad.join(', ')} ist nicht freigegeben.`);
      return hit.entity;
    },
    after(op, entity, res, n) {
      const scrubbed = scrubAttributes(res) + scrubSensitive(res);
      const items = (res as { items?: unknown[] } | null)?.items;
      onAccess({ op, entity, n: n ?? (Array.isArray(items) ? items.length : Array.isArray(res) ? res.length : res ? 1 : 0), scrubbed });
      return res;
    },
  };
}

export interface ProductQuery extends Query { store?: string; sku?: string; skus?: string; ids?: string; name?: string; term?: string; category_id?: string | number; status?: number; visibility?: string; type?: string; price_from?: number; price_to?: number; page?: number; limit?: number; sort?: string; dir?: 'asc' | 'desc'; fields?: string; with?: string }
export interface Resolved { type: 'PRODUCT' | 'CATEGORY' | 'CMS_PAGE' | 'HOME' | 'REDIRECT'; id?: number; sku?: string; identifier?: string; redirect_code?: number; relative_url?: string }

/** Modulversion, ab der der Suchfilter ?term= (Name ODER SKU bzw. Titel ODER identifier) existiert; ältere Module ignorieren ihn stillschweigend */
export const MODULE_TERM_FILTER = '1.2.0';
const versionAtLeast = (v: unknown, min: string) => { const a = String(v ?? '0').split('.').map(Number), b = min.split('.').map(Number); for (let i = 0; i < b.length; i++) { const d = (a[i] || 0) - b[i]; if (d) return d > 0; } return true; };
export const infoHasTermFilter = (info: Pick<OmInfo, 'module_version'>) => versionAtLeast(info.module_version, MODULE_TERM_FILTER);
/**
 * Produkt-Referenz der Werkzeuge: „id:12“ oder „sku:4711“ sind eindeutig; eine reine Zahl kann Entitäts-ID ODER (numerische) SKU sein
 * und wird auf beides geprüft (zwei verschiedene Treffer = Fehler), alles andere ist eine SKU.
 */
export function parseRef(ref: string): { id?: string; sku?: string } {
  const r = String(ref ?? '').trim();
  if (/^id:\d+$/i.test(r)) return { id: r.slice(3) };
  if (/^sku:/i.test(r)) return r.slice(4).trim() ? { sku: r.slice(4).trim() } : {};
  if (!r) return {};
  return /^\d+$/.test(r) ? { id: r, sku: r } : { sku: r };
}
export const ambiguousRef = (ref: string, byId: OmRecord, bySku: OmRecord) => new Error(`Mehrdeutig: „${ref}“ ist Produkt-ID (${byId.name ?? ''}, SKU ${byId.sku}) und zugleich SKU (${bySku.name ?? ''}, ID ${bySku.id}). Bitte als „id:${ref}“ oder „sku:${ref}“ angeben.`);
/** Treffer einer Referenz aus ID- und SKU-Suche: beide verschieden = mehrdeutig */
export function pickRef<T extends OmRecord>(ref: string, byId: T | null | undefined, bySku: T | null | undefined): T | null {
  if (byId && bySku && Number(byId.id) !== Number(bySku.id)) throw ambiguousRef(ref, byId, bySku);
  return byId ?? bySku ?? null;
}

/**
 * Lese-Client der KI (OpenMage). Nur feste Methoden; der privilegierte Client ist privat (#c) und von außen nicht erreichbar.
 * Ergebnisse werden bereinigt und protokolliert. store: Store-View-Code ('' = Haupt-Store-View der Einstellungen, 'admin' = globale Werte).
 */
export class OmReader {
  readonly #c: OmClient;
  readonly #g: OmGuard;
  readonly #cache = new Map<string, Promise<unknown>>();
  constructor(c: OmClient, g?: OmGuard) { this.#c = c; this.#g = g ?? createOmGuard(); }
  get platform() { return 'openmage' as const; }
  get base() { return this.#c.base; }
  get publicUrl() { return this.#c.publicUrl; }
  scopes() { return this.#g.scopes(); }
  allowed(scope: ScopeKey) { return !!this.#g.scopes()[scope]; }

  #once<T>(key: string, fn: () => Promise<T>): Promise<T> { if (!this.#cache.has(key)) this.#cache.set(key, fn().catch(e => { this.#cache.delete(key); throw e; })); return this.#cache.get(key) as Promise<T>; }
  async #store(s?: string): Promise<string> {
    const st = s === undefined || s === '' ? await this.#c.workStore() : s;
    if (!isGlobal(st) && !STORE_RE.test(st)) throw this.#g.deny('store', `Ungültiger Store-Code „${String(s).slice(0, 40)}“.`);
    return isGlobal(st) ? 'admin' : st;
  }
  async #get<T>(path: string, o: { query?: Query; store?: string; op?: string; nullOn404?: boolean } = {}): Promise<T> {
    const entity = this.#g.check(path, o.query);
    const store = await this.#store(o.store);
    const r = await this.#c.req('GET', path, undefined, { store, query: o.query, nullOn404: o.nullOn404 });
    return this.#g.after(o.op ?? 'get', entity, r) as T;
  }
  async #list<T>(path: string, query: Query, store?: string): Promise<{ items: T[]; meta: OmListMeta }> {
    const entity = this.#g.check(path, query);
    const r = await this.#c.list(path, query, await this.#store(store));
    this.#g.after('search', entity, r.items, r.items.length);
    return r;
  }

  // ---- Shop ----
  info(): Promise<OmInfo> { return this.#once('info', () => this.#get<OmInfo>('/v1/info', { store: 'admin' })); }
  /** Store-View, in der Lotse liest und schreibt (Einstellung bzw. Standard-Store-View des Shops) */
  store(): Promise<string> { return this.#c.workStore(); }
  async storeViews(): Promise<OmStoreView[]> { return (await this.info()).store_views.filter(v => v.id > 0); }
  async storeView(code?: string): Promise<OmStoreView | undefined> { const c = code ?? await this.store(); const views = await this.storeViews(); return views.find(v => v.code === c || String(v.id) === c || (v.locale && v.locale.toLowerCase().replace('_', '-') === String(c).toLowerCase().replace('_', '-'))); }
  async priceBasis(): Promise<PriceBasis> { return (await this.info()).price_includes_tax ? 'gross' : 'net'; }
  async suffixes(): Promise<{ product: string; category: string }> { const i = await this.info(); return { product: i.product_url_suffix ?? '', category: i.category_url_suffix ?? '' }; }
  /** interne Basis-URL (Docker) → öffentliche URL des Browsers */
  rebase(u: string) { const { base, publicUrl } = this.#c; return base && publicUrl && base !== publicUrl && u.startsWith(base) ? publicUrl + u.slice(base.length) : u; }
  /** Storefront-Basis einer Store-View (öffentlich, ohne Schrägstrich am Ende) */
  async storefrontBase(store?: string): Promise<string> { const v = await this.storeView(store).catch(() => undefined); return this.rebase(String(v?.link_url ?? v?.base_url ?? `${this.#c.publicUrl || this.#c.base}/`)).replace(/\/+$/, ''); }
  async mediaBase(store?: string): Promise<string> { const v = await this.storeView(store).catch(() => undefined); return this.rebase(String(v?.media_url ?? `${this.#c.publicUrl || this.#c.base}/media/`)).replace(/\/?$/, '/'); }
  /** Bild-URL einer Galerie-Datei (/v/a/x.jpg) */
  async mediaUrl(file: string | null | undefined, store?: string): Promise<string | undefined> {
    if (!file || file === 'no_selection') return undefined;
    if (/^https?:\/\//.test(file)) return this.rebase(file);
    return `${await this.mediaBase(store)}catalog/product${file.startsWith('/') ? '' : '/'}${file}`;
  }
  async productUrl(p: OmRecord, store?: string): Promise<string | null> { if (Number(p.visibility) === 1) return null; const path = productPath(p, (await this.suffixes()).product); return path ? `${await this.storefrontBase(store)}/${path}` : null; }
  async categoryUrl(c: OmRecord, store?: string): Promise<string | null> { const path = categoryPath(c, (await this.suffixes()).category); return path ? `${await this.storefrontBase(store)}/${path}` : null; }

  // ---- Produkte ----
  products(q: ProductQuery = {}): Promise<{ items: OmProduct[]; meta: OmListMeta }> { const { store, ...query } = q; return this.#list<OmProduct>('/v1/products', query, store); }
  product(sku: string, store?: string): Promise<OmProduct | null> { return this.#get(`/v1/products/${skuPath(sku)}`, { store, nullOn404: true }); }
  productById(id: string | number, store?: string): Promise<OmProduct | null> { if (!/^\d+$/.test(String(id))) return Promise.resolve(null); return this.#get(`/v1/products/${idPath(id)}`, { store, nullOn404: true }); }
  /** Produkt per Referenz der Werkzeuge (id:…, sku:…, Zahl = ID oder SKU, sonst SKU) als Detail; Zahl mit zwei verschiedenen Treffern wirft „Mehrdeutig“ */
  async productByRef(ref: string, store?: string): Promise<OmProduct | null> {
    const { id, sku } = parseRef(ref);
    if (!id && !sku) return null;
    const [a, b] = await Promise.all([id ? this.productById(id, store) : null, sku ? this.product(sku, store) : null]);
    return pickRef(ref, a, b);
  }
  /** Kennt das Modul im Shop den Suchfilter ?term=? (ältere Module würden ihn ignorieren und alles liefern) */
  async hasTermFilter(): Promise<boolean> { return infoHasTermFilter(await this.info()); }
  /** Listeneinträge per SKU (exakt, in Blöcken), optional mit weiteren Feldern/Galerie */
  async productsBySkus(skus: string[], o: { store?: string; fields?: string[]; images?: boolean } = {}): Promise<OmProduct[]> {
    const list = [...new Set(skus.map(s => String(s ?? '').trim()).filter(s => s && !s.includes(',')))]; if (!list.length) return [];
    const out: OmProduct[] = [];
    for (let i = 0; i < list.length; i += 50) out.push(...(await this.products({ skus: list.slice(i, i + 50).join(','), limit: 50, store: o.store, ...(o.fields?.length ? { fields: o.fields.join(',') } : {}), ...(o.images ? { with: 'images' } : {}) })).items);
    return out;
  }
  async productsByIds(ids: (string | number)[], o: { store?: string; fields?: string[]; images?: boolean } = {}): Promise<OmProduct[]> {
    const list = [...new Set(ids.map(String).filter(i => /^\d+$/.test(i)))]; if (!list.length) return [];
    const out: OmProduct[] = [];
    for (let i = 0; i < list.length; i += 50) out.push(...(await this.products({ ids: list.slice(i, i + 50).join(','), limit: 50, store: o.store, ...(o.fields?.length ? { fields: o.fields.join(',') } : {}), ...(o.images ? { with: 'images' } : {}) })).items);
    return out;
  }
  /** Attributsets und Produktattribute (einmal je Lese-Client) */
  attributes(): Promise<{ attribute_sets: { id: number; name: string; is_default: boolean; attribute_codes: string[] }[]; attributes: OmRecord[] }> { return this.#once('attributes', () => this.#get('/v1/products/attributes', { store: 'admin' })); }
  async attribute(code: string): Promise<OmRecord | null> { if (!/^[a-z][a-z0-9_]{0,59}$/.test(code)) return null; return (await this.attributes()).attributes.find(a => a.code === code) ?? null; }
  stock(sku: string): Promise<OmStock | null> { return this.#get(`/v1/products/${skuPath(sku)}/stock`, { store: 'admin', nullOn404: true }); }
  images(sku: string, store?: string): Promise<OmImage[]> { return this.#get(`/v1/products/${skuPath(sku)}/images`, { store }); }
  productCategories(sku: string): Promise<{ id: number; position: number; name?: string | null }[]> { return this.#get(`/v1/products/${skuPath(sku)}/categories`, { store: 'admin' }); }

  // ---- Kategorien ----
  /** Kategoriebaum ab der Wurzel der Store-View (einmal je Lese-Client und Store) */
  categoryTree(store?: string): Promise<OmCategory[]> { return this.#once(`tree:${store ?? ''}`, () => this.#get<OmCategory[]>('/v1/categories', { store, op: 'tree' })); }
  /** Alle Kategorien flach (mit Pfad-Angaben) */
  categoriesFlat(store?: string): Promise<OmCategory[]> { return this.#once(`flat:${store ?? ''}`, () => this.#get<OmCategory[]>('/v1/categories', { store, query: { flat: 1 }, op: 'list' })); }
  category(id: string | number, store?: string): Promise<OmCategory | null> { if (!/^\d+$/.test(String(id))) return Promise.resolve(null); return this.#get(`/v1/categories/${Number(id)}`, { store, nullOn404: true }); }

  // ---- Inhalte, Marketing, Rewrites ----
  cmsPages(q: Query = {}, store?: string): Promise<{ items: OmRecord[]; meta: OmListMeta }> { return this.#list('/v1/cms/pages', q, store ?? 'admin'); }
  cmsPage(id: string | number): Promise<OmRecord | null> { if (!/^\d+$/.test(String(id))) return Promise.resolve(null); return this.#get(`/v1/cms/pages/${Number(id)}`, { store: 'admin', nullOn404: true }); }
  cmsBlocks(q: Query = {}, store?: string): Promise<{ items: OmRecord[]; meta: OmListMeta }> { return this.#list('/v1/cms/blocks', q, store ?? 'admin'); }
  cmsBlock(id: string | number): Promise<OmRecord | null> { if (!/^\d+$/.test(String(id))) return Promise.resolve(null); return this.#get(`/v1/cms/blocks/${Number(id)}`, { store: 'admin', nullOn404: true }); }
  /** CMS-Seite per identifier (exakt) */
  async cmsPageByIdentifier(identifier: string): Promise<OmRecord | null> { const r = await this.cmsPages({ identifier, limit: 20 }); return r.items.find(p => p.identifier === identifier) ?? null; }
  salesRules(q: Query = {}): Promise<{ items: OmRecord[]; meta: OmListMeta }> { return this.#list('/v1/salesrules', q, 'admin'); }
  salesRule(id: string | number): Promise<OmRecord | null> { if (!/^\d+$/.test(String(id))) return Promise.resolve(null); return this.#get(`/v1/salesrules/${Number(id)}`, { store: 'admin', nullOn404: true }); }
  coupons(ruleId: string | number, q: Query = {}): Promise<{ items: OmRecord[]; meta: OmListMeta }> { return this.#list(`/v1/salesrules/${Number(ruleId)}/coupons`, q, 'admin'); }
  urlRewrites(q: Query, store?: string): Promise<{ items: OmRecord[]; meta: OmListMeta }> { return this.#list('/v1/urlrewrites', q, store); }

  /**
   * Storefront-Pfad → Entität: URL-Rewrites der Store-View (Produkt, Kategorie, Weiterleitung), sonst CMS-Seite per identifier.
   * null = nichts gefunden. Bereichsschalter wirken (gesperrter Bereich → null). Eigene Rewrites, die aufeinander zeigen
   * (a → b → a), oder Ketten über 5 Schritte enden mit null statt endlos.
   */
  async resolveUrl(path: string, store?: string, depth = 0): Promise<Resolved | null> {
    const p = String(path ?? '').replace(/^\/+/, '').replace(/[?#].*$/, '').slice(0, 400);
    if (!p || p === 'index.php') return { type: 'HOME' };
    if (depth >= 5) return null;
    const sc = this.#g.scopes();
    if (sc.shop) {
      const rw = (await this.urlRewrites({ request_path: p, limit: 5 }, store).catch(() => ({ items: [] as OmRecord[] }))).items[0];
      if (rw) {
        const t = parseTarget(rw.target_path);
        if (t) {
          if (t.type === 'PRODUCT' && !sc.products) return null;
          if (t.type === 'CATEGORY' && !sc.categories) return null;
          return { type: t.type, id: t.id };
        }
        // Weiterleitung oder eigener Rewrite auf einen anderen Pfad
        const to = String(rw.target_path ?? '').replace(/^\/+/, '');
        if (rw.options === 'RP' || rw.options === 'R') { const target = await this.resolveUrl(to, store, depth + 1).catch(() => null); return { ...(target ?? { type: 'REDIRECT' as const }), redirect_code: rw.options === 'RP' ? 301 : 302, relative_url: to }; }
        if (to && to !== p) return this.resolveUrl(to, store, depth + 1);
      }
    }
    if (sc.cms) {
      const pg = await this.cmsPageByIdentifier(p.replace(/\/+$/, '')).catch(() => null);
      if (pg && pg.is_active !== false) return { type: 'CMS_PAGE', id: Number(pg.id), identifier: String(pg.identifier) };
    }
    return null;
  }
}
