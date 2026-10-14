import 'server-only';
// Guarded Magento read client for the AI: fixed read methods instead of free queries, allow-list of REST paths per scope,
// allowed filter fields per resource, scrubbing of sensitive fields and access log. Customers, orders, invoices,
// carts, admin users, integrations and tokens are never readable, no matter what the prompt says.
import type { ScopeKey } from '@/lib/protocol';
import { DeniedError, DENIED_TERMS, isSensitiveKey, SCOPES, scrubSensitive, type AccessEvent, type Scopes } from '../../policy';
import { DEFAULT_SCOPES } from '../../policy';
import { MagentoClient, STORE_RE, skuPath } from './client';
import { criteriaFields, type Criteria, type Filter } from './criteria';
import type { MProduct, MCategory, MRecord } from './map';

/** Allow-list: method + path (without /rest/<store>) → scope. Everything else is rejected. */
export const ALLOW: { re: RegExp; scope: ScopeKey; entity: string; method?: 'GET' | 'POST' }[] = [
  { re: /^\/V1\/products$/, scope: 'products', entity: 'product' },
  { re: /^\/V1\/products\/attributes\/[a-z][a-z0-9_]{0,59}$/, scope: 'products', entity: 'product-attribute' },
  { re: /^\/V1\/products\/attributes$/, scope: 'products', entity: 'product-attribute' },
  { re: /^\/V1\/products\/[^/]+$/, scope: 'products', entity: 'product' },
  { re: /^\/V1\/products\/attribute-sets\/sets\/list$/, scope: 'products', entity: 'attribute-set' },
  { re: /^\/V1\/configurable-products\/[^/]+\/(children|options\/all)$/, scope: 'products', entity: 'configurable' },
  { re: /^\/V1\/inventory\/source-items$/, scope: 'products', entity: 'source-item' },
  { re: /^\/V1\/inventory\/sources$/, scope: 'products', entity: 'source' },
  { re: /^\/V1\/products\/(base-prices|special-price)-information$/, scope: 'products', entity: 'price', method: 'POST' },
  { re: /^\/V1\/categories$/, scope: 'categories', entity: 'category' },
  { re: /^\/V1\/categories\/list$/, scope: 'categories', entity: 'category' },
  { re: /^\/V1\/categories\/\d+$/, scope: 'categories', entity: 'category' },
  { re: /^\/V1\/categories\/\d+\/products$/, scope: 'categories', entity: 'category-product' },
  { re: /^\/V1\/cmsPage\/search$/, scope: 'cms', entity: 'cms-page' },
  { re: /^\/V1\/cmsPage\/\d+$/, scope: 'cms', entity: 'cms-page' },
  { re: /^\/V1\/cmsBlock\/search$/, scope: 'cms', entity: 'cms-block' },
  { re: /^\/V1\/cmsBlock\/\d+$/, scope: 'cms', entity: 'cms-block' },
  { re: /^\/V1\/salesRules\/search$/, scope: 'marketing', entity: 'sales-rule' },
  { re: /^\/V1\/salesRules\/\d+$/, scope: 'marketing', entity: 'sales-rule' },
  { re: /^\/V1\/coupons\/search$/, scope: 'marketing', entity: 'coupon' },
  { re: /^\/V1\/store\/(storeViews|storeConfigs|websites|storeGroups)$/, scope: 'shop', entity: 'store' },
];
/** Allowed filter/sort fields per resource (searchCriteria) */
const FILTER_FIELDS: Record<string, string[]> = {
  product: ['entity_id', 'sku', 'name', 'type_id', 'status', 'visibility', 'price', 'special_price', 'category_id', 'attribute_set_id', 'url_key', 'updated_at', 'created_at', 'meta_title', 'meta_description', 'manufacturer', 'color', 'news_from_date'],
  category: ['entity_id', 'name', 'parent_id', 'is_active', 'level', 'url_key', 'path', 'position'],
  'cms-page': ['page_id', 'identifier', 'title', 'is_active', 'store_id'],
  'cms-block': ['block_id', 'identifier', 'title', 'is_active', 'store_id'],
  'sales-rule': ['rule_id', 'name', 'is_active', 'coupon_type', 'from_date', 'to_date', 'sort_order', 'simple_action'],
  coupon: ['rule_id', 'code', 'is_primary', 'type', 'times_used'],
  'source-item': ['sku', 'source_code'],
  source: ['source_code', 'enabled'],
  'product-attribute': ['attribute_id', 'attribute_code', 'is_user_defined', 'frontend_input', 'is_visible_on_front'],
  'attribute-set': ['entity_type_id', 'attribute_set_name'],
};
// Paths related to customers, orders, users or access: reject hard before the allow-list (clear message)
const DENY_PATH = /(customer|order|invoice|creditmemo|shipment|transaction|carts?\b|guest-carts|quote|integration|admin|tfa|token|payment|giftcard|gift-card|negotiable|company|requisition|returns?\b|rma|newsletter|user|password|bulk)/i;

/** Magento field names containing harmless word parts like "order"/"user" (sorting, attribute metadata) */
const SAFE_FIELDS = new Set(['sort_order', 'is_user_defined']);

/** Magento attributes as a list {attribute_code, value}: remove sensitive attributes (email, phone, customer/order related …) */
export function scrubAttributes(data: unknown): number {
  let n = 0;
  const walk = (x: unknown) => {
    if (Array.isArray(x)) {
      for (let i = x.length - 1; i >= 0; i--) {
        const a = x[i] as { attribute_code?: unknown } | null;
        if (a && typeof a === 'object' && typeof a.attribute_code === 'string' && (isSensitiveKey(a.attribute_code) || DENIED_TERMS.test(a.attribute_code))) { x.splice(i, 1); n++; }
        else walk(a);
      }
    } else if (x && typeof x === 'object') for (const v of Object.values(x)) walk(v);
  };
  walk(data); return n;
}

export interface MagentoGuard {
  scopes: () => Scopes;
  /** checks method, path, filter fields and field selection; returns the resource (for the log) */
  check(method: string, path: string, c?: Criteria, fields?: string): string;
  after<T>(op: string, entity: string, res: T, n?: number): T;
  deny(entity: string, msg: string): DeniedError;
}

export function createMagentoGuard({ getScopes = () => DEFAULT_SCOPES, onAccess = () => {} }: { getScopes?: () => Scopes; onAccess?: (a: AccessEvent) => void } = {}): MagentoGuard {
  const deny = (entity: string, msg: string) => { const e = new DeniedError('ZUGRIFF VERWEIGERT: ' + msg); try { onAccess({ op: 'deny', entity, n: 0, denied: msg.slice(0, 160) }); } catch {} return e; };
  return {
    scopes: getScopes,
    deny,
    check(method, path, c, fields) {
      const p = path.replace(/\?.*$/, '');
      if (DENY_PATH.test(p.replace(/^(\/V1\/(?:products|configurable-products)\/)[^/]+/, '$1x').replace(/^(\/V1\/products\/attributes\/)[^/]+/, '$1x'))) throw deny('http', `„${p}“ ist für die KI gesperrt (Kunden-, Bestell-, Rechnungs-, Warenkorb-, Benutzer-, Zahlungs- und Zugangsdaten sind grundsätzlich ausgeschlossen).`);
      const hit = ALLOW.find(a => a.re.test(p) && (a.method ?? 'GET') === method);
      if (!hit) throw deny('http', `Direkter API-Zugriff ${method} ${p} ist für die KI nicht erlaubt.`);
      if (!getScopes()[hit.scope]) throw deny(hit.entity, `Zugriff auf „${SCOPES[hit.scope].label}“ ist vom Betreiber nicht freigegeben (Einstellungen → KI-Zugriff).`);
      const allowed = FILTER_FIELDS[hit.entity] ?? [];
      const bad = criteriaFields(c).filter(f => !allowed.includes(f) || DENIED_TERMS.test(SAFE_FIELDS.has(f) ? '' : f));
      if (bad.length) throw deny(hit.entity, `Filter/Sortierung nach ${bad.join(', ')} ist nicht freigegeben.`);
      if (fields && DENIED_TERMS.test(fields)) throw deny(hit.entity, 'Feldauswahl mit Kunden-, Bestell- oder Zugangsbezug ist gesperrt.');
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

export interface ProductQuery extends Criteria { store?: string; fields?: string }

/**
 * Read client for the AI (Magento). Fixed methods only; the privileged client is private (#c) and not reachable from outside.
 * Results are scrubbed and logged. store: store view code (default from the settings; 'all' = global values).
 */
export class MagentoReader {
  readonly #c: MagentoClient;
  readonly #g: MagentoGuard;
  readonly #cache = new Map<string, Promise<unknown>>();
  constructor(c: MagentoClient, g?: MagentoGuard) { this.#c = c; this.#g = g ?? createMagentoGuard(); }
  get platform() { return 'magento' as const; }
  get base() { return this.#c.base; }
  get publicUrl() { return this.#c.publicUrl; }
  get storeCode() { return this.#c.storeCode; }
  get priceBasis() { return this.#c.priceBasis; }
  scopes() { return this.#g.scopes(); }
  /** Scope enabled? (tools hide e.g. images when "Medienbibliothek" (media library) is off) */
  allowed(scope: ScopeKey) { return !!this.#g.scopes()[scope]; }

  #store(s?: string) { const st = s ?? this.#c.storeCode; if (st !== 'all' && !STORE_RE.test(st)) throw this.#g.deny('store', `Ungültiger Store-Code „${String(s).slice(0, 40)}“.`); return st; }
  async #get<T>(path: string, o: { c?: Criteria; store?: string; fields?: string; op?: string; nullOn404?: boolean } = {}): Promise<T> {
    const entity = this.#g.check('GET', path, o.c, o.fields);
    const store = this.#store(o.store);
    const r = o.c ? await this.#c.search(path, o.c, { store, fields: o.fields }) : await this.#c.req('GET', path, undefined, { store, nullOn404: o.nullOn404 });
    return this.#g.after(o.op ?? (o.c ? 'search' : 'get'), entity, r) as T;
  }
  #once<T>(key: string, fn: () => Promise<T>): Promise<T> { if (!this.#cache.has(key)) this.#cache.set(key, fn().catch(e => { this.#cache.delete(key); throw e; })); return this.#cache.get(key) as Promise<T>; }

  // ---- Products ----
  products(q: ProductQuery = {}): Promise<{ items: MProduct[]; total_count: number }> { const { store, fields, ...c } = q; return this.#get('/V1/products', { c, store, fields }); }
  product(sku: string, store?: string): Promise<MProduct | null> { return this.#get(`/V1/products/${skuPath(sku)}`, { store, nullOn404: true }); }
  async productsByIds(ids: (string | number)[], store?: string): Promise<MProduct[]> {
    const list = [...new Set(ids.map(String).filter(i => /^\d+$/.test(i)))]; if (!list.length) return [];
    const out: MProduct[] = [];
    for (let i = 0; i < list.length; i += 100) out.push(...(await this.products({ filters: [[{ field: 'entity_id', value: list.slice(i, i + 100), condition_type: 'in' }]], pageSize: 100, store })).items);
    return out;
  }
  async productsBySkus(skus: string[], store?: string): Promise<MProduct[]> {
    const list = [...new Set(skus.filter(Boolean))]; if (!list.length) return [];
    // Magento splits in-values at commas: read SKUs containing a comma individually
    const plain = list.filter(s => !s.includes(',')), out: MProduct[] = [];
    for (let i = 0; i < plain.length; i += 100) out.push(...(await this.products({ filters: [[{ field: 'sku', value: plain.slice(i, i + 100), condition_type: 'in' }]], pageSize: 100, store })).items);
    for (const s of list.filter(x => x.includes(','))) { const p = await this.product(s, store); if (p) out.push(p); }
    return out;
  }
  /** Product by entity ID (as in the tools) or SKU */
  async productByRef(ref: string, store?: string): Promise<MProduct | null> {
    if (/^\d+$/.test(ref)) { const [p] = await this.productsByIds([ref], store); if (p) return p; }
    return this.product(ref, store);
  }
  attribute(code: string): Promise<MRecord | null> { return this.#once(`attr:${code}`, () => this.#get<MRecord | null>(`/V1/products/attributes/${code}`, { store: 'all', nullOn404: true })); }
  attributes(c: Criteria): Promise<{ items: MRecord[]; total_count: number }> { return this.#get('/V1/products/attributes', { c, store: 'all' }); }
  /** Custom (user-defined) attributes once per read client: basis for displaying attributes instead of one GET per attribute code */
  userAttributes(): Promise<MRecord[]> { return this.#once('userattrs', async () => (await this.attributes({ filters: [[{ field: 'is_user_defined', value: 1 }]], pageSize: 500 })).items); }
  attributeSets(): Promise<{ items: MRecord[]; total_count: number }> { return this.#once('sets', () => this.#get('/V1/products/attribute-sets/sets/list', { c: { pageSize: 100 }, store: 'all' })); }
  configurableChildren(sku: string): Promise<MProduct[]> { return this.#get(`/V1/configurable-products/${skuPath(sku)}/children`, { op: 'children' }); }
  configurableOptions(sku: string): Promise<MRecord[]> { return this.#get(`/V1/configurable-products/${skuPath(sku)}/options/all`, { op: 'options' }); }
  /** MSI sources; null = inventory modules not present (legacy system) */
  sources(): Promise<MRecord[] | null> { return this.#once('sources', async () => { try { return (await this.#get<{ items: MRecord[] }>('/V1/inventory/sources', { c: { pageSize: 50 }, store: 'all' })).items; } catch (e) { if ((e as { status?: number }).status === 404) return null; throw e; } }); }
  async sourceItems(skus: string[]): Promise<MRecord[]> {
    const out: MRecord[] = [], plain = skus.filter(s => !s.includes(','));
    const get = (filters: Filter[][]) => this.#get<{ items: MRecord[] }>('/V1/inventory/source-items', { c: { filters, pageSize: 500 }, store: 'all' }).then(r => r.items);
    for (let i = 0; i < plain.length; i += 100) out.push(...await get([[{ field: 'sku', value: plain.slice(i, i + 100), condition_type: 'in' }]]));
    for (const s of skus.filter(x => x.includes(','))) out.push(...await get([[{ field: 'sku', value: s }]])); // comma = separator of the in-filter
    return out;
  }

  // ---- Categories ----
  categoryTree(rootId?: number, depth?: number): Promise<MCategory> {
    const q = [rootId != null ? `rootCategoryId=${Number(rootId)}` : '', depth != null ? `depth=${Number(depth)}` : ''].filter(Boolean).join('&');
    const entity = this.#g.check('GET', '/V1/categories');
    return this.#once(`tree:${q}`, async () => this.#g.after('tree', entity, await this.#c.req('GET', '/V1/categories', undefined, { store: this.#c.storeCode, query: q })));
  }
  category(id: string | number, store?: string): Promise<MCategory | null> { if (!/^\d+$/.test(String(id))) return Promise.resolve(null); return this.#get(`/V1/categories/${id}`, { store, nullOn404: true }); }
  categories(c: Criteria, store?: string): Promise<{ items: MCategory[]; total_count: number }> { return this.#get('/V1/categories/list', { c, store }); }
  categoryProducts(id: string | number): Promise<{ sku: string; position: number; category_id: string }[]> { if (!/^\d+$/.test(String(id))) return Promise.resolve([]); return this.#get(`/V1/categories/${id}/products`, { op: 'links', store: 'all' }); }

  // ---- Content, marketing, shop ----
  cmsPages(c: Criteria, store?: string): Promise<{ items: MRecord[]; total_count: number }> { return this.#get('/V1/cmsPage/search', { c, store }); }
  cmsBlocks(c: Criteria, store?: string): Promise<{ items: MRecord[]; total_count: number }> { return this.#get('/V1/cmsBlock/search', { c, store }); }
  salesRules(c: Criteria): Promise<{ items: MRecord[]; total_count: number }> { return this.#get('/V1/salesRules/search', { c, store: 'all' }); }
  salesRule(id: string | number): Promise<MRecord | null> { if (!/^\d+$/.test(String(id))) return Promise.resolve(null); return this.#get(`/V1/salesRules/${id}`, { store: 'all', nullOn404: true }); }
  coupons(c: Criteria): Promise<{ items: MRecord[]; total_count: number }> { return this.#get('/V1/coupons/search', { c, store: 'all' }); }
  storeViews(): Promise<MRecord[]> { return this.#once('views', () => this.#get('/V1/store/storeViews', { store: 'all' })); }
  storeConfigs(): Promise<MRecord[]> { return this.#once('configs', () => this.#get('/V1/store/storeConfigs', { store: 'all' })); }
  websites(): Promise<MRecord[]> { return this.#once('websites', () => this.#get('/V1/store/websites', { store: 'all' })); }
  storeGroups(): Promise<MRecord[]> { return this.#once('groups', () => this.#get('/V1/store/storeGroups', { store: 'all' })); }

  /** Store view config of the storefront (public GraphQL): URL suffixes, base URL, locale */
  storefrontConfig(store?: string): Promise<{ product_url_suffix?: string | null; category_url_suffix?: string | null; base_url?: string; base_media_url?: string; locale?: string; store_code?: string }> {
    const st = this.#store(store);
    return this.#once(`sfc:${st}`, async () => {
      if (!this.#g.scopes().shop) throw this.#g.deny('store', `Zugriff auf „${SCOPES.shop.label}“ ist vom Betreiber nicht freigegeben (Einstellungen → KI-Zugriff).`);
      const d = await this.#c.graphql('{ storeConfig { product_url_suffix category_url_suffix base_url base_media_url locale store_code } }', {}, st);
      return this.#g.after('storefront-config', 'store', d?.storeConfig ?? {});
    });
  }
  /** Storefront URL (path) → entity via the public GraphQL (urlResolver/route) */
  async resolveUrl(path: string, store?: string): Promise<{ type: string; id?: number; sku?: string; identifier?: string; relative_url?: string; redirect_code?: number } | null> {
    const st = this.#store(store), url = path.replace(/^\/+/, '').slice(0, 400);
    const d = await this.#c.graphql('query($u:String!){ route(url:$u){ type relative_url redirect_code ... on ProductInterface { id sku } ... on CategoryInterface { id } ... on CmsPage { identifier } } }', { u: url }, st).catch(() => null);
    const r = d?.route as MRecord | null | undefined;
    if (!r) return null;
    const scope: ScopeKey = r.type === 'PRODUCT' ? 'products' : r.type === 'CATEGORY' ? 'categories' : 'cms';
    if (!this.#g.scopes()[scope]) return null;
    this.#g.after('route', String(r.type ?? 'url').toLowerCase(), r);
    return { type: r.type, id: r.id, sku: r.sku, identifier: r.identifier, relative_url: r.relative_url, redirect_code: r.redirect_code };
  }
  /** Image URL of a gallery file (/p/r/x.jpg) */
  async mediaUrl(file: string | null | undefined): Promise<string | undefined> {
    if (!file || file === 'no_selection') return undefined;
    if (/^https?:\/\//.test(file)) return file;
    const cfg = (await this.storeConfigs().catch(() => [])).find(s => s.code === this.#c.storeCode) ?? {};
    const base = String(cfg.base_media_url ?? `${this.#c.publicUrl || this.#c.base}/media/`).replace(/\/?$/, '/');
    return `${this.#rebase(base)}catalog/product${file.startsWith('/') ? '' : '/'}${file}`;
  }
  /** internal base URL (Docker) → public URL for the browser */
  #rebase(u: string) { const { base, publicUrl } = this.#c; return base && publicUrl && base !== publicUrl && u.startsWith(base) ? publicUrl + u.slice(base.length) : u; }
  /** Storefront base of the store view (public) */
  async storefrontBase(store?: string): Promise<string> {
    const st = store ?? this.#c.storeCode;
    const cfg = (await this.storeConfigs().catch(() => [])).find(s => s.code === st);
    return this.#rebase(String(cfg?.base_link_url ?? cfg?.base_url ?? `${this.#c.publicUrl || this.#c.base}/`)).replace(/\/+$/, '');
  }
}
