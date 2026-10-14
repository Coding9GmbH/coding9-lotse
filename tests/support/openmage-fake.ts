// Nur für Tests: kleiner Fake der Lotse_Connector-API (OpenMage-Modul, integrations/openmage/openapi.yaml), Daten im Speicher.
// Bildet die Ebenen-Logik nach (globale Werte + Werte je Store-View, null im Store-Scope entfernt den Wert, im globalen Scope 400),
// store_overrides, Galerie mit Rollen, Bestand, Kategorien mit Zuordnung, CMS-Seiten/-Blöcke, Preisregeln, URL-Rewrites (auch
// „Save Rewrites History“ mit rewrites_added). Prüft das Bearer-Token; Kunden-/Bestell-Pfade gibt es nicht (404 not_found).
import http from 'node:http';
import type { AddressInfo } from 'node:net';

type Rec = Record<string, unknown>;
type Vals = Record<number, Rec>;
export interface FakeImage { id: number; file: string; vals: Record<number, { label?: string | null; position?: number | null; disabled?: boolean }> }
export interface FakeProduct { id: number; sku: string; type_id: string; attribute_set_id: number; vals: Vals; website_ids: number[]; stock: { qty: number; is_in_stock: boolean; manage_stock: boolean }; images: FakeImage[]; categories: { id: number; position: number }[]; children?: string[]; axes?: string[] }
export interface FakeCategory { id: number; parent_id: number; level: number; path: string; position: number; vals: Vals }
export interface FakeOpenmage {
  base: string; token: string;
  products: FakeProduct[]; categories: FakeCategory[]; cmsPages: Rec[]; cmsBlocks: Rec[]; rules: Rec[]; rewrites: Rec[];
  info: Rec;
  log: { method: string; path: string; store: string; body?: unknown }[];
  snapshot: () => string;
  close: () => Promise<void>;
}

const STORES: Record<string, number> = { admin: 0, default: 1, en: 2 };
const STORE_VIEWS = [
  { id: 1, code: 'default', name: 'Deutsch', website_id: 1, group_id: 1, is_active: true, is_default: true, locale: 'de_DE', currency: 'EUR', base_currency: 'EUR', root_category_id: 2, store_in_url: false, title_prefix: '', title_suffix: ' | Haus Holm' },
  { id: 2, code: 'en', name: 'English', website_id: 1, group_id: 1, is_active: true, is_default: false, locale: 'en_US', currency: 'EUR', base_currency: 'EUR', root_category_id: 2, store_in_url: false, title_prefix: '', title_suffix: ' | Haus Holm' },
];
const ROLES = ['image', 'small_image', 'thumbnail'];
const PRODUCT_ATTRS: Rec[] = [
  { id: 71, code: 'name', label: 'Name', input: 'text', scope: 'store', is_user_defined: false, writable: true }, { id: 72, code: 'description', label: 'Beschreibung', input: 'textarea', scope: 'store', is_user_defined: false, writable: true },
  { id: 75, code: 'price', label: 'Preis', input: 'price', scope: 'website', is_user_defined: false, writable: true }, { id: 76, code: 'special_price', label: 'Sonderpreis', input: 'price', scope: 'website', is_user_defined: false, writable: true },
  { id: 80, code: 'weight', label: 'Gewicht', input: 'weight', scope: 'global', is_user_defined: false, writable: true }, { id: 96, code: 'status', label: 'Status', input: 'select', scope: 'website', is_user_defined: false, writable: true },
  { id: 94, code: 'color', label: 'Farbe', input: 'select', scope: 'global', is_user_defined: true, is_configurable: true, writable: true, options: [{ value: 3, label: 'Sand' }, { value: 4, label: 'Salbei' }] },
  { id: 83, code: 'manufacturer', label: 'Hersteller', input: 'select', scope: 'global', is_user_defined: true, writable: true, options: [{ value: 21, label: 'Haus Holm' }] },
  { id: 122, code: 'tax_class_id', label: 'Steuerklasse', input: 'select', scope: 'website', is_user_defined: false, writable: true, options: [{ value: 0, label: 'None' }, { value: 2, label: 'Taxable Goods' }] },
  { id: 97, code: 'contact_email', label: 'Kontakt', input: 'text', scope: 'global', is_user_defined: true, writable: true },
];
const read = (req: http.IncomingMessage) => new Promise<string>(res => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => res(b)); });
const merged = (v: Vals, s: number) => ({ ...(v[0] ?? {}), ...(s ? v[s] ?? {} : {}) });
const urlKey = (s: string) => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const like = (hay: unknown, needle: string) => String(hay ?? '').toLowerCase().includes(needle.toLowerCase());
const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message, details: [] } } });

export async function startFakeOpenmage(seed: Partial<Pick<FakeOpenmage, 'products' | 'categories' | 'cmsPages' | 'cmsBlocks' | 'rules' | 'rewrites' | 'info'>> = {}): Promise<FakeOpenmage> {
  const f = { token: 'fixtoken_0123456789abcdef', products: [], categories: [], cmsPages: [], cmsBlocks: [], rules: [], rewrites: [], info: {}, log: [], ...seed } as unknown as FakeOpenmage;
  let nextId = 1000;
  const mediaUrl = (file: string) => `${f.base}/media/catalog/product${file}`;
  const info = () => ({ platform: 'openmage', version: '20.18.0', magento_version: '1.9.4.5', edition: 'Community', php_version: '8.2', module_version: '1.2.0', shop_name: 'Haus Holm', default_store_view: 'default', price_includes_tax: true, catalog_price_scope: 'global', save_rewrites_history: true, product_url_suffix: '.html', category_url_suffix: '.html', indexers: [],
    websites: [{ id: 1, code: 'base', name: 'Main Website', is_default: true, default_group_id: 1, base_currency: 'EUR', groups: [{ id: 1, name: 'Main Website Store', root_category_id: 2, default_store_id: 1, store_views: views() }] }], store_views: views(), ...f.info });
  const views = () => STORE_VIEWS.map(v => ({ ...v, base_url: `${f.base}/`, link_url: `${f.base}/`, media_url: `${f.base}/media/` }));
  // ---- Rewrites: System-Rewrites je Store aus url_key, eigene bleiben ----
  const sysRewrites = () => {
    f.rewrites = f.rewrites.filter(r => !r.is_system);
    for (const p of f.products) for (const s of [1, 2]) { const k = merged(p.vals, s).url_key; if (k && Number(merged(p.vals, s).visibility) !== 1) f.rewrites.push({ id: 100000 + p.id * 10 + s, store_id: s, id_path: `product/${p.id}`, request_path: `${k}.html`, target_path: `catalog/product/view/id/${p.id}`, is_system: true, options: null, description: null, category_id: null, product_id: p.id }); }
    for (const c of f.categories) for (const s of [1, 2]) { const k = merged(c.vals, s).url_key; if (k && c.level >= 2) f.rewrites.push({ id: 200000 + c.id * 10 + s, store_id: s, id_path: `category/${c.id}`, request_path: `${k}.html`, target_path: `catalog/category/view/id/${c.id}`, is_system: true, options: null, description: null, category_id: c.id, product_id: null }); }
  };
  sysRewrites();
  // ---- Formatierung ----
  const overrides = (v: Vals, s: number) => (s ? Object.keys(v[s] ?? {}) : []);
  const listItem = (p: FakeProduct, s: number) => { const v = merged(p.vals, s); return { id: p.id, sku: p.sku, type_id: p.type_id, attribute_set_id: p.attribute_set_id, name: v.name ?? null, status: Number(v.status ?? 1), visibility: Number(v.visibility ?? 4), price: v.price == null ? null : Number(v.price), special_price: v.special_price == null || v.special_price === '' ? null : Number(v.special_price), special_from_date: v.special_from_date ?? null, special_to_date: v.special_to_date ?? null, tax_class_id: v.tax_class_id == null ? null : Number(v.tax_class_id), weight: v.weight == null ? null : Number(v.weight), url_key: v.url_key ?? null, image: v.image ?? null, qty: p.stock.qty, is_in_stock: p.stock.is_in_stock, category_ids: p.categories.map(c => c.id), website_ids: p.website_ids, created_at: '2026-10-10 20:16:08', updated_at: '2026-10-10 21:26:41' }; };
  const images = (p: FakeProduct, s: number) => { const roles = merged(p.vals, s); return p.images.map(im => { const g = im.vals[0] ?? {}, st = s ? im.vals[s] : undefined, label = st?.label ?? g.label ?? '', position = st?.position ?? g.position ?? 0; return { id: im.id, file: im.file, url: mediaUrl(im.file), label, position, disabled: !!(st?.disabled ?? g.disabled), types: ROLES.filter(r => roles[r] === im.file), label_use_default: !st || st.label == null, position_use_default: !st || st.position == null, has_store_values: !!st }; }).sort((a, b) => a.position - b.position || a.id - b.id); };
  const detail = (p: FakeProduct, s: number) => { const v = merged(p.vals, s), attrs: Rec = {}; for (const [k, x] of Object.entries(v)) attrs[k] = x; const kids = (p.children ?? []).map(k => f.products.find(x => x.sku === k)!).filter(Boolean);
    return { ...listItem(p, s), store_id: s, url_path: v.url_key ? `${v.url_key}.html` : null, url: v.url_key ? `${f.base}/${v.url_key}.html` : null, attributes: attrs, attribute_labels: {}, store_overrides: overrides(p.vals, s), stock: { item_id: p.id, ...p.stock, use_config_manage_stock: true }, categories: p.categories.map(c => ({ ...c, name: merged(f.categories.find(x => x.id === c.id)?.vals ?? {}, s).name ?? null, path: f.categories.find(x => x.id === c.id)?.path ?? null })), images: images(p, s), tier_prices: [],
      ...(p.type_id === 'configurable' ? { configurable: { attributes: (p.axes ?? []).map((code, i) => { const a = PRODUCT_ATTRS.find(x => x.code === code)!; return { id: i + 1, attribute_id: a.id, code, label: a.label, position: i, options: a.options }; }), children: kids.map(k => ({ id: k.id, sku: k.sku, name: merged(k.vals, s).name ?? null, status: Number(merged(k.vals, s).status ?? 1), price: merged(k.vals, 0).price ?? null, attributes: Object.fromEntries((p.axes ?? []).map(code => [code, merged(k.vals, 0)[code] ?? null])), qty: k.stock.qty, is_in_stock: k.stock.is_in_stock })) } } : {}),
      ...(p.type_id === 'simple' ? { parent_ids: f.products.filter(x => x.children?.includes(p.sku)).map(x => x.id) } : {}) }; };
  const catNode = (c: FakeCategory, s: number): Rec => { const v = merged(c.vals, s); return { id: c.id, parent_id: c.parent_id, path: c.path, level: c.level, position: c.position, name: v.name ?? null, is_active: !!v.is_active, include_in_menu: v.include_in_menu !== false, is_anchor: !!v.is_anchor, url_key: v.url_key ?? null, url_path: v.url_key ? `${v.url_key}.html` : null, display_mode: v.display_mode ?? null, landing_page: v.landing_page == null ? null : Number(v.landing_page), product_count: f.products.filter(p => p.categories.some(x => x.id === c.id)).length, children_count: f.categories.filter(x => x.parent_id === c.id).length, updated_at: null }; };
  const catTree = (c: FakeCategory, s: number): Rec => ({ ...catNode(c, s), children: f.categories.filter(x => x.parent_id === c.id).map(x => catTree(x, s)) });
  const catDetail = (c: FakeCategory, s: number) => { const v = merged(c.vals, s), blk = v.landing_page ? f.cmsBlocks.find(b => Number(b.id) === Number(v.landing_page)) : null; return { ...catNode(c, s), store_id: s, description: v.description ?? null, meta_title: v.meta_title ?? null, meta_keywords: v.meta_keywords ?? null, meta_description: v.meta_description ?? null, image_url: null, url: v.url_key ? `${f.base}/${v.url_key}.html` : null, landing_page_block: blk ? { id: blk.id, identifier: blk.identifier, title: blk.title, is_active: !!blk.is_active } : null, attributes: { ...v }, store_overrides: overrides(c.vals, s), child_ids: f.categories.filter(x => x.parent_id === c.id).map(x => x.id) }; };
  const storesOf = (ids: number[]) => ids.map(id => (id === 0 ? { id: 0, code: 'admin', name: 'Alle Store-Views' } : { id, code: STORE_VIEWS.find(v => v.id === id)?.code ?? null, name: STORE_VIEWS.find(v => v.id === id)?.name ?? null }));
  const cmsOut = (x: Rec, full: boolean) => { const { content, store_ids, ...rest } = x; const ids = (store_ids as number[]) ?? [0]; return { ...rest, stores: storesOf(ids), store_ids: ids, ...(full ? { content } : {}), ...('identifier' in x && 'root_template' in x ? { url: `${f.base}/${x.identifier}` } : {}) }; };
  const storeIds = (input: unknown): number[] => (Array.isArray(input) ? input : [0]).map(s => (s === 'admin' || s === 0 || s === '0' ? 0 : typeof s === 'number' ? s : STORES[String(s)] ?? -1)).filter(n => n >= 0);
  const ruleOut = (r: Rec, full: boolean) => { const { conditions, actions, ...rest } = r; return { ...rest, primary_coupon: r.coupon_code ? { id: r.id, code: r.coupon_code, usage_limit: r.uses_per_coupon ?? null, usage_per_customer: r.uses_per_customer ?? 0, times_used: r.times_used ?? 0, expiration_date: null, is_primary: true, type: 0 } : null, coupon_count: r.coupon_code ? 1 : 0, ...(full ? { conditions, actions } : {}) }; };
  const page = (rows: Rec[], q: URLSearchParams) => { const limit = Math.max(1, Math.min(Number(q.get('limit') ?? 50), 200)), pg = Math.max(1, Number(q.get('page') ?? 1)); return { data: rows.slice((pg - 1) * limit, pg * limit), meta: { page: pg, limit, total: rows.length, pages: Math.max(1, Math.ceil(rows.length / limit)) } }; };
  const sortRows = (rows: Rec[], q: URLSearchParams, allowed: string[], def: string) => { const s = q.get('sort') ?? def, dir = q.get('dir') === 'desc' ? -1 : 1; if (!allowed.includes(s)) throw err(400, 'validation', `Unbekanntes Sortierfeld ${s}`); return [...rows].sort((a, b) => (a[s] == null ? '' : String(a[s])).localeCompare(b[s] == null ? '' : String(b[s]), undefined, { numeric: true }) * dir); };
  const findProduct = (ref: string) => { ref = decodeURIComponent(ref); return ref.startsWith('id:') ? f.products.find(p => p.id === Number(ref.slice(3))) : f.products.find(p => p.sku === ref); };
  /** Attribut-Schreiben wie das Modul: Store-Scope null = Override löschen; global null = 400; url_key formatiert + Rewrite-Historie (Produkt und Kategorie) */
  const writeAttrs = (vals: Vals, s: number, attrs: Rec, opts: { product?: FakeProduct; category?: FakeCategory } = {}) => {
    const added: number[] = [];
    for (const [k, x] of Object.entries(attrs)) {
      if (x === null) { if (!s) throw err(400, 'validation', `null ist im globalen Scope nicht erlaubt: ${k}`); if (vals[s]) delete vals[s][k]; continue; }
      if (x === '' && !s) { delete (vals[0] ??= {})[k]; continue; } // leeren = Wert entfernen (OpenMage löscht leere Attributwerte, Antwort null)
      let v: unknown = x;
      if (k === 'url_key') v = urlKey(String(x));
      if (k === 'status' || k === 'visibility') v = Number(x);
      if (k === 'landing_page' && Number(v) && !f.cmsBlocks.some(b => Number(b.id) === Number(v))) throw err(400, 'validation', 'landing_page: Block nicht gefunden');
      if (k === 'display_mode' && !['PRODUCTS', 'PAGE', 'PRODUCTS_AND_PAGE'].includes(String(v))) throw err(400, 'validation', 'display_mode ungültig');
      const before = merged(vals, s)[k];
      (vals[s] ??= {})[k] = v;
      if (k === 'url_key' && (opts.product || opts.category) && before && before !== v) for (const st of s ? [s] : [1, 2]) { const id = nextId++; f.rewrites.push({ id, store_id: st, id_path: `${before}_${id}`, request_path: `${before}.html`, target_path: `${v}.html`, is_system: false, options: 'RP', description: null, category_id: opts.category?.id ?? null, product_id: opts.product?.id ?? null }); added.push(id); }
    }
    if (s && vals[s] && !Object.keys(vals[s]).length) delete vals[s];
    sysRewrites();
    return added;
  };

  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const url = new URL(req.url ?? '/', 'http://x'), raw = await read(req), body = raw ? JSON.parse(raw) : undefined, method = req.method ?? 'GET', q = url.searchParams;
    if (url.pathname.startsWith('/media/')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')); }
    if (!url.pathname.startsWith('/lotse-api/')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<html><head><title>Haus Holm</title></head><body><h1>Storefront</h1><a href="/vase.html">Vase</a></body></html>`); }
    const auth = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (auth !== f.token) return send(401, { error: { code: 'unauthorized', message: 'Ungültiger oder fehlender API-Token.', details: [] } });
    const storeCode = q.get('store') ?? String(req.headers['x-lotse-store'] ?? '') ?? '', p = url.pathname.slice('/lotse-api'.length);
    const s = storeCode === '' || storeCode === 'admin' || storeCode === '0' ? 0 : STORES[storeCode];
    f.log.push({ method, path: p, store: storeCode || 'admin', ...(body !== undefined ? { body } : {}) });
    if (s === undefined) return send(400, { error: { code: 'validation', message: `Unbekannter Store ${storeCode}`, details: [] } });
    const meta = { store: storeCode || 'admin', store_id: s, duration_ms: 1 };
    const data = (d: unknown, status = 200) => send(status, { data: d, meta });
    const lst = (rows: Rec[]) => { const r = page(rows, q); send(200, { data: r.data, meta: { ...meta, ...r.meta } }); };
    let mm: RegExpExecArray | null;
    try {
      if (p === '/v1/info' && method === 'GET') return data(info());
      // ---- Produkte ----
      if (p === '/v1/products/attributes' && method === 'GET') return data({ attribute_sets: [{ id: 4, name: 'Default', is_default: true, attribute_codes: PRODUCT_ATTRS.map(a => a.code) }], attributes: PRODUCT_ATTRS.map(a => ({ ...a, options: q.get('options') === '0' ? undefined : a.options })) });
      if (p === '/v1/products' && method === 'GET') {
        let rows: Rec[] = f.products.filter(x => { const v = merged(x.vals, s);
          return (!q.get('sku') || like(x.sku, q.get('sku')!)) && (!q.get('skus') || q.get('skus')!.split(',').map(t => t.trim()).includes(x.sku)) && (!q.get('ids') || q.get('ids')!.split(',').map(Number).includes(x.id)) && (!q.get('name') || like(v.name, q.get('name')!)) && (!q.get('term') || like(v.name, q.get('term')!) || like(x.sku, q.get('term')!))
            && (!q.get('category_id') || x.categories.some(c => c.id === Number(q.get('category_id')))) && (!q.get('status') || Number(v.status ?? 1) === Number(q.get('status'))) && (!q.get('visibility') || q.get('visibility')!.split(',').map(Number).includes(Number(v.visibility ?? 4)))
            && (!q.get('type') || q.get('type')!.split(',').includes(x.type_id)) && (!q.get('price_from') || Number(v.price) >= Number(q.get('price_from'))) && (!q.get('price_to') || Number(v.price) <= Number(q.get('price_to'))); }).map(x => ({ ...listItem(x, s), _p: x }));
        rows = sortRows(rows, q, ['entity_id', 'sku', 'name', 'price', 'updated_at', 'created_at', 'status'], 'entity_id').map(r => { const x = r._p as FakeProduct, { _p, ...rest } = r; void _p; const out: Rec = rest;
          if (q.get('fields')) { const codes = q.get('fields')!.split(',').map(t => t.trim()).filter(Boolean); for (const c of codes) if (['media_gallery', 'gallery', 'tier_price', 'group_price'].includes(c)) throw err(400, 'validation', `fields: Attribut nicht erlaubt: ${c}`); out.attributes = Object.fromEntries(codes.map(c => [c, merged(x.vals, s)[c] ?? null])); }
          if ((q.get('with') ?? '').split(',').includes('images')) out.images = images(x, s);
          return out; });
        return lst(rows);
      }
      if (p === '/v1/products' && method === 'POST') {
        const b = body as Rec, attrs = (b.attributes ?? {}) as Rec;
        if (!b.sku || !attrs.name) throw err(400, 'validation', 'sku und attributes.name sind Pflicht');
        if (f.products.some(x => x.sku === b.sku)) throw err(409, 'conflict', 'SKU schon vorhanden');
        for (const v of Object.values(attrs)) if (v === null) throw err(400, 'validation', 'null beim Anlegen nicht erlaubt');
        const pr: FakeProduct = { id: nextId++, sku: String(b.sku), type_id: String(b.type_id ?? 'simple'), attribute_set_id: Number(b.attribute_set_id ?? 4), vals: { 0: { status: 1, visibility: 4, tax_class_id: 0, ...attrs, url_key: urlKey(String(attrs.url_key ?? attrs.name)) } }, website_ids: (b.website_ids as number[]) ?? [1], stock: { qty: Number((b.stock as Rec)?.qty ?? 0), is_in_stock: !!(b.stock as Rec)?.is_in_stock, manage_stock: true }, images: [], categories: ((b.categories ?? []) as (number | Rec)[]).map(c => (typeof c === 'number' ? { id: c, position: 0 } : { id: Number(c.id), position: Number(c.position ?? 0) })) };
        f.products.push(pr); sysRewrites(); return data(detail(pr, 0), 201);
      }
      if ((mm = /^\/v1\/products\/([^/]+)$/.exec(p))) {
        const pr = findProduct(mm[1]); if (!pr) throw err(404, 'not_found', 'Produkt nicht gefunden');
        if (method === 'GET') return data(detail(pr, s));
        if (method === 'DELETE') { const before = detail(pr, 0); f.products = f.products.filter(x => x !== pr); for (const x of f.products) if (x.children) x.children = x.children.filter(k => k !== pr.sku); sysRewrites(); return data({ deleted: true, id: pr.id, sku: pr.sku, before }); }
        if (method === 'PATCH' || method === 'PUT') { const added = writeAttrs(pr.vals, s, (body.attributes ?? {}) as Rec, { product: pr }); return data({ ...detail(pr, s), _write: { updated: Object.keys(body.attributes ?? {}), reverted: [], reindexed: [], rewrites_added: added } }); }
      }
      if ((mm = /^\/v1\/products\/([^/]+)\/stock$/.exec(p))) {
        const pr = findProduct(mm[1]); if (!pr) throw err(404, 'not_found', 'Produkt nicht gefunden');
        if (method === 'PUT') { if (body.qty !== undefined) pr.stock.qty = Number(body.qty); if (body.is_in_stock !== undefined) pr.stock.is_in_stock = !!body.is_in_stock; if (body.manage_stock !== undefined && body.manage_stock !== null) pr.stock.manage_stock = !!body.manage_stock; }
        return data({ item_id: pr.id, ...pr.stock, use_config_manage_stock: true });
      }
      if ((mm = /^\/v1\/products\/([^/]+)\/categories$/.exec(p))) {
        const pr = findProduct(mm[1]); if (!pr) throw err(404, 'not_found', 'Produkt nicht gefunden');
        if (method === 'PUT') {
          for (const a of (body.add ?? []) as (number | Rec)[]) { const id = typeof a === 'number' ? a : Number(a.id), pos = typeof a === 'number' ? 0 : Number(a.position ?? 0); if (!f.categories.some(c => c.id === id)) throw err(404, 'not_found', 'Kategorie nicht gefunden'); if (!pr.categories.some(c => c.id === id)) pr.categories.push({ id, position: pos }); }
          for (const id of (body.remove ?? []) as number[]) pr.categories = pr.categories.filter(c => c.id !== Number(id));
          for (const x of (body.set_position ?? []) as Rec[]) { const c = pr.categories.find(y => y.id === Number(x.id)); if (c) c.position = Number(x.position); }
          pr.categories.sort((a, b) => a.id - b.id);
        }
        return data(pr.categories.map(c => ({ ...c, name: merged(f.categories.find(x => x.id === c.id)?.vals ?? {}, s).name ?? null, path: f.categories.find(x => x.id === c.id)?.path ?? null })));
      }
      if ((mm = /^\/v1\/(?:products\/([^/]+)\/images|media\/([^/]+))$/.exec(p))) {
        const pr = findProduct(mm[1] ?? mm[2]); if (!pr) throw err(404, 'not_found', 'Produkt nicht gefunden');
        if (method === 'GET') return data(images(pr, s));
        if (method === 'POST') {
          if (!body.base64 && !body.url) throw err(400, 'validation', 'base64 oder url nötig');
          if (body.url && /^https?:\/\/(127\.|localhost|10\.|192\.168\.)/.test(String(body.url))) throw err(400, 'validation', 'Nur öffentliche Adressen');
          const id = nextId++, file = `/f/${id}-${String(body.filename ?? 'bild.jpg').replace(/[^a-z0-9._-]/gi, '-')}`;
          pr.images.push({ id, file, vals: { 0: { label: String(body.label ?? ''), position: Number(body.position ?? pr.images.length + 1), disabled: !!body.disabled } } });
          for (const r of (body.types ?? []) as string[]) if (ROLES.includes(r)) (pr.vals[0] ??= {})[r] = file;
          return data({ image: images(pr, 0).find(i => i.id === id), images: images(pr, 0) }, 201);
        }
      }
      if ((mm = /^\/v1\/products\/([^/]+)\/images\/(\d+)$/.exec(p))) {
        const pr = findProduct(mm[1]); if (!pr) throw err(404, 'not_found', 'Produkt nicht gefunden');
        const im = pr.images.find(x => x.id === Number(mm![2])); if (!im) throw err(404, 'not_found', 'Bild nicht gefunden');
        if (method === 'PATCH') {
          const b = body as Rec, tgt = (im.vals[s] ??= {});
          if ('label' in b) { if (b.label === null) { if (!s) throw err(400, 'validation', 'null nur im Store-Scope'); delete tgt.label; } else tgt.label = String(b.label); }
          if ('position' in b) { if (b.position === null) { if (!s) throw err(400, 'validation', 'null nur im Store-Scope'); delete tgt.position; } else tgt.position = Number(b.position); }
          if ('disabled' in b) tgt.disabled = !!b.disabled;
          // Rollen wie das Modul: nur geänderte Rollen im Scope schreiben, geerbte unveränderte bleiben geerbt
          if (Array.isArray(b.types)) { const cur = merged(pr.vals, s); for (const r of ROLES) { const want = (b.types as string[]).includes(r) ? im.file : cur[r] === im.file ? 'no_selection' : null; if (want !== null && want !== cur[r]) (pr.vals[s] ??= {})[r] = want; } }
          if (s && !Object.keys(tgt).length) delete im.vals[s];
          if (s && im.vals[s] && im.vals[s].label == null && im.vals[s].position == null && !!im.vals[s].disabled === !!im.vals[0]?.disabled) delete im.vals[s];
          return data({ image: images(pr, s).find(i => i.id === im.id), images: images(pr, s), _write: { changed: Object.keys(b) } });
        }
        if (method === 'DELETE') {
          const before = images(pr, s).find(i => i.id === im.id);
          if (q.get('mode') === 'delete') { pr.images = pr.images.filter(x => x !== im); for (const st of Object.keys(pr.vals)) for (const r of ROLES) if (pr.vals[Number(st)][r] === im.file) pr.vals[Number(st)][r] = 'no_selection'; return data({ mode: 'delete', before, file_deleted: true, images: images(pr, s) }); }
          (im.vals[s] ??= {}).disabled = true; return data({ mode: 'disable', before, file_deleted: false, images: images(pr, s) });
        }
      }
      // ---- Kategorien ----
      if (p === '/v1/categories' && method === 'GET') {
        if (q.get('flat') === '1') return data(f.categories.filter(c => c.level >= 1).map(c => catNode(c, s)));
        const roots = f.categories.filter(c => (q.get('root') ? c.id === Number(q.get('root')) : s ? c.id === 2 : c.parent_id === 1));
        return data(roots.map(c => catTree(c, s)));
      }
      if ((mm = /^\/v1\/categories\/(\d+)$/.exec(p))) {
        const c = f.categories.find(x => x.id === Number(mm![1])); if (!c) throw err(404, 'not_found', 'Kategorie nicht gefunden');
        if (method === 'GET') return data(catDetail(c, s));
        if (method === 'PATCH' || method === 'PUT') { const attrs = { ...(body.attributes ?? {}) } as Rec; for (const k of ['parent_id', 'path', 'level', 'position', 'url_path']) if (k in attrs) throw err(400, 'validation', `${k} ist nicht schreibbar`); if ('is_active' in attrs && attrs.is_active !== null) attrs.is_active = Number(attrs.is_active) === 1 || attrs.is_active === true; const added = writeAttrs(c.vals, s, attrs, { category: c }); return data({ ...catDetail(c, s), _write: { updated: Object.keys(attrs), reverted: [], rewrites_added: added } }); }
      }
      // ---- CMS ----
      for (const [res, list, idKey] of [['pages', f.cmsPages, 'page_id'], ['blocks', f.cmsBlocks, 'block_id']] as const) {
        if (p === `/v1/cms/${res}` && method === 'GET') {
          let rows = list.filter(x => (!s || ((x.store_ids as number[]) ?? [0]).some(id => id === 0 || id === s)) && (!q.get('identifier') || like(x.identifier, q.get('identifier')!)) && (!q.get('title') || like(x.title, q.get('title')!)) && (!q.get('term') || like(x.title, q.get('term')!) || like(x.identifier, q.get('term')!)) && (!q.get('is_active') || Number(!!x.is_active) === Number(q.get('is_active'))));
          rows = sortRows(rows.map(x => ({ ...x, [idKey]: x.id })), q, [idKey, 'identifier', 'title', 'update_time', 'creation_time', 'sort_order'], idKey);
          return lst(rows.map(x => { const { [idKey]: _k, ...rest } = x; void _k; return cmsOut(rest, false); }));
        }
        if (p === `/v1/cms/${res}` && method === 'POST') {
          const b = body as Rec; if (!b.title || !b.identifier) throw err(400, 'validation', 'title und identifier sind Pflicht');
          if (!/^[a-z0-9_./-]+$/i.test(String(b.identifier))) throw err(400, 'validation', 'identifier ungültig');
          const ids = storeIds(b.stores);
          if (list.some(x => x.identifier === b.identifier && ((x.store_ids as number[]) ?? [0]).some(id => id === 0 || ids.includes(0) || ids.includes(id)))) throw err(422, 'magento', 'Identifier im Store schon vergeben');
          const rec: Rec = { id: nextId++, is_active: true, ...(res === 'pages' ? { root_template: 'one_column', content_heading: null, meta_keywords: null, meta_description: null, sort_order: 0, layout_update_xml: null, custom_theme: null, custom_root_template: null, custom_layout_update_xml: null, custom_theme_from: null, custom_theme_to: null } : {}), content: '', ...Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'stores')), store_ids: ids, creation_time: '2026-10-10 12:00:00', update_time: '2026-10-10 12:00:00' };
          list.push(rec); return data(cmsOut(rec, true), 201);
        }
        if ((mm = new RegExp(`^/v1/cms/${res}/(\\d+)$`).exec(p))) {
          const x = list.find(r => Number(r.id) === Number(mm![1])); if (!x) throw err(404, 'not_found', 'Nicht gefunden');
          if (method === 'GET') return data(cmsOut(x, true));
          if (method === 'DELETE') { list.splice(list.indexOf(x), 1); return data({ deleted: true, id: x.id, before: cmsOut(x, true) }); }
          if (method === 'PATCH' || method === 'PUT') { const b = body as Rec; for (const [k, v] of Object.entries(b)) { if (k === 'stores') x.store_ids = storeIds(v); else if (k !== 'id') x[k] = k === 'is_active' ? !!v : v; } return data(cmsOut(x, true)); }
        }
      }
      // ---- Preisregeln ----
      if (p === '/v1/salesrules' && method === 'GET') {
        let rows = f.rules.filter(r => (!q.get('is_active') || Number(!!r.is_active) === Number(q.get('is_active'))) && (!q.get('name') || like(r.name, q.get('name')!)) && (!q.get('coupon_code') || String(r.coupon_code ?? '').toLowerCase() === q.get('coupon_code')!.toLowerCase()));
        rows = sortRows(rows.map(r => ({ ...r, rule_id: r.id })), q, ['rule_id', 'name', 'sort_order', 'from_date', 'to_date', 'is_active'], 'rule_id');
        return lst(rows.map(r => { const { rule_id: _r, ...rest } = r; void _r; return ruleOut(rest, false); }));
      }
      if (p === '/v1/salesrules' && method === 'POST') {
        const b = body as Rec; if (!b.name) throw err(400, 'validation', 'name ist Pflicht');
        const r: Rec = { id: nextId++, description: null, is_active: true, from_date: null, to_date: null, coupon_type: b.coupon_code ? 2 : 1, coupon_code: null, uses_per_coupon: null, uses_per_customer: 0, times_used: 0, simple_action: 'by_percent', discount_amount: 0, discount_qty: null, discount_step: 0, apply_to_shipping: false, simple_free_shipping: 0, stop_rules_processing: false, sort_order: 0, website_ids: [1], customer_group_ids: [0, 1, 2, 3], conditions: { type: 'salesrule/rule_condition_combine', attribute: null, operator: null, value: true, aggregator: 'all' }, actions: { type: 'salesrule/rule_condition_product_combine', attribute: null, operator: null, value: true, aggregator: 'all' }, ...b };
        f.rules.push(r); return data(ruleOut(r, true), 201);
      }
      if ((mm = /^\/v1\/salesrules\/(\d+)(\/coupons)?$/.exec(p))) {
        const r = f.rules.find(x => Number(x.id) === Number(mm![1])); if (!r) throw err(404, 'not_found', 'Regel nicht gefunden');
        if (mm[2]) return lst(r.coupon_code ? [{ id: r.id, code: r.coupon_code, usage_limit: r.uses_per_coupon ?? null, usage_per_customer: r.uses_per_customer ?? 0, times_used: r.times_used ?? 0, expiration_date: null, is_primary: true, type: 0 }] : []);
        if (method === 'GET') return data(ruleOut(r, true));
        if (method === 'DELETE') { f.rules = f.rules.filter(x => x !== r); return data({ deleted: true, id: r.id, before: ruleOut(r, true) }); }
        if (method === 'PATCH' || method === 'PUT') { for (const [k, v] of Object.entries(body as Rec)) { if (k === 'id') continue; if (k === 'coupon_code' && v && r.coupon_type === 1) r.coupon_type = 2; r[k] = v === '' && (k === 'from_date' || k === 'to_date' || k === 'coupon_code') ? null : v; } return data(ruleOut(r, true)); }
      }
      // ---- URL-Rewrites ----
      if (p === '/v1/urlrewrites' && method === 'GET') {
        if (!['sku', 'product_id', 'category_id', 'request_path', 'id_path'].some(k => q.get(k)) && q.get('all') !== '1') throw err(400, 'validation', 'Filter nötig');
        const pid = q.get('sku') ? findProduct(q.get('sku')!)?.id : q.get('product_id') ? Number(q.get('product_id')) : null;
        return lst(f.rewrites.filter(r => (!s || r.store_id === s) && (pid == null || r.product_id === pid) && (!q.get('category_id') || r.category_id === Number(q.get('category_id'))) && (!q.get('request_path') || r.request_path === q.get('request_path')) && (!q.get('is_system') || Number(!!r.is_system) === Number(q.get('is_system')))));
      }
      if (p === '/v1/urlrewrites' && method === 'POST') { const b = body as Rec, st = b.store_id ? Number(b.store_id) : STORES[String(b.store)]; if (!st) throw err(400, 'validation', 'Store-View nötig'); if (f.rewrites.some(r => r.store_id === st && r.request_path === b.request_path)) throw err(409, 'conflict', 'request_path belegt'); const pr = b.sku ? findProduct(String(b.sku)) : null; const r: Rec = { id: nextId++, store_id: st, id_path: b.id_path ?? `custom_${nextId}`, request_path: b.request_path, target_path: pr ? `catalog/product/view/id/${pr.id}` : b.category_id ? `catalog/category/view/id/${b.category_id}` : b.target_path, is_system: false, options: b.options ?? null, description: b.description ?? null, category_id: b.category_id ?? null, product_id: pr?.id ?? null }; f.rewrites.push(r); return data(r, 201); }
      if ((mm = /^\/v1\/urlrewrites\/(\d+)$/.exec(p))) { const r = f.rewrites.find(x => Number(x.id) === Number(mm![1])); if (!r) throw err(404, 'not_found', 'Rewrite nicht gefunden'); if (method === 'GET') return data(r); if (method === 'DELETE') { if (r.is_system && q.get('force') !== '1') throw err(400, 'validation', 'System-Rewrite'); f.rewrites = f.rewrites.filter(x => x !== r); return data({ deleted: true, id: r.id, before: r }); } }
      throw err(404, 'not_found', 'Unbekannter Endpunkt.');
    } catch (e) {
      const x = e as { status?: number; body?: unknown };
      if (x.status && x.body) return send(x.status, x.body);
      return send(500, { error: { code: 'internal', message: 'Interner Fehler', details: [] } });
    }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  f.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  f.snapshot = () => JSON.stringify({ products: f.products, categories: f.categories, cmsPages: f.cmsPages, cmsBlocks: f.cmsBlocks, rules: f.rules, rewrites: f.rewrites });
  f.close = () => new Promise(r => server.close(() => r()));
  return f;
}
