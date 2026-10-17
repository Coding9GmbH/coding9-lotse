// Tests only: small fake of the Magento 2.4 REST API (/rest/<store>/V1/…) and the storefront GraphQL, data in memory.
// Mimics the level logic (global values + values per store view, null removes the level's value), gallery with roles,
// MSI sources, categories with assignment, cart price rules with codes. Checks the bearer token and rejects customers/orders.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

type Rec = Record<string, unknown>;
type Vals = Record<number, Rec>;
export interface FakeProduct { id: number; sku: string; type_id: string; attribute_set_id: number; vals: Vals; website_ids: number[]; media: { id: number; file: string; media_type: string; vals: Record<number, { label?: string | null; position?: number; disabled?: boolean }> }[]; children?: string[]; options?: Rec[] }
export interface FakeCategory { id: number; parent_id: number; level: number; path: string; vals: Vals; products: { sku: string; position: number }[] }
export interface FakeMagento {
  base: string; token: string;
  products: FakeProduct[]; categories: FakeCategory[]; sources: Rec[]; sourceItems: Rec[]; rules: Rec[]; coupons: Rec[];
  /** CMS pages and blocks (store_id: store views, 0 = all) */
  cmsPages: Rec[]; cmsBlocks: Rec[];
  /** Storefront URL rewrites: old path (without .html) → new URL key (GraphQL route responds with redirect_code 301) */
  rewrites: Record<string, string>;
  /** Orders for GET /V1/orders (sales sums): entity_id, created_at "YYYY-MM-DD HH:MM:SS", state, currency codes, items[] */
  orders: Rec[];
  /** true = the integration has no access to sales (GET /V1/orders → 403) */
  ordersDenied: boolean;
  log: { method: string; path: string; store: string; body?: unknown; query?: string }[];
  /** Controllable responses for client tests: the next REST requests fail with this status (Retry-After in seconds) */
  failNext: { status: number; retryAfter?: number }[];
  /** Invalidate the admin token (next request 401, new login required) */
  expireToken: () => void;
  /** Delay per response (ms) and measurement of concurrently open requests */
  delayMs: number; open: number; maxOpen: number;
  /** State as JSON (for deep-equal before/after undo) */
  snapshot: () => string;
  close: () => Promise<void>;
}

const STORES: Record<string, number> = { all: 0, admin: 0, default: 1, en: 2 };
const TOP = new Set(['name', 'price', 'status', 'visibility', 'weight', 'is_active', 'include_in_menu']);
const ROLES = ['image', 'small_image', 'thumbnail', 'swatch_image'];
const read = (req: http.IncomingMessage) => new Promise<string>(res => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => res(b)); });
const merged = (v: Vals, s: number) => ({ ...(v[0] ?? {}), ...(s ? v[s] ?? {} : {}) });
function setVals(v: Vals, s: number, data: Rec, opts: { noNull?: Set<string> } = {}) {
  v[s] ??= {};
  for (const [k, x] of Object.entries(data)) {
    if (x === null) { if (s && !opts.noNull?.has(k)) delete v[s][k]; else if (!s) delete v[s][k]; }
    else v[s][k] = x;
  }
  if (s && !Object.keys(v[s]).length) delete v[s];
}
const flat = (body: Rec): Rec => { const out: Rec = {}; for (const [k, x] of Object.entries(body)) if (k !== 'custom_attributes' && TOP.has(k)) out[k] = x; for (const a of (body.custom_attributes ?? []) as { attribute_code: string; value: unknown }[]) out[a.attribute_code] = a.value; return out; };

/** Read searchCriteria from the query string */
function criteria(q: URLSearchParams) {
  const groups: { field: string; value: string; condition_type: string }[][] = [];
  for (const [k, v] of q) { const m = /^searchCriteria\[filter_groups\]\[(\d+)\]\[filters\]\[(\d+)\]\[(\w+)\]$/.exec(k); if (!m) continue; const g = (groups[+m[1]] ??= []); (g[+m[2]] ??= { field: '', value: '', condition_type: 'eq' } as never)[m[3] as 'field'] = v; }
  return { groups: groups.filter(Boolean).map(g => g.filter(Boolean)), pageSize: Number(q.get('searchCriteria[pageSize]') ?? 20), page: Number(q.get('searchCriteria[currentPage]') ?? 1) };
}
const str = (x: unknown) => (x === true ? '1' : x === false ? '0' : String(x)); // Magento returns booleans as 1/0
function match(rec: Rec, f: { field: string; value: string; condition_type: string }) {
  const raw = rec[f.field], v = Array.isArray(raw) ? raw.map(str) : raw == null ? null : str(raw);
  const list = f.value.split(',');
  switch (f.condition_type) {
    case 'eq': return Array.isArray(v) ? v.includes(f.value) : v === f.value;
    case 'in': return Array.isArray(v) ? v.some(x => list.includes(x)) : v != null && list.includes(v);
    case 'like': { const re = new RegExp(`^${f.value.replace(/\\([%_\\])/g, '$1\u0000').split('%').map(p => p.replace(/\u0000/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i'); return v != null && re.test(String(v)); }
    case 'gt': return v != null && Number(v) > Number(f.value); // missing value (e.g. no special price) never matches
    case 'gteq': return v != null && Number(v) >= Number(f.value);
    case 'lteq': return v != null && Number(v) <= Number(f.value);
    default: return false;
  }
}
const page = <T>(rows: T[], c: { pageSize: number; page: number }) => ({ items: rows.slice((c.page - 1) * c.pageSize, c.page * c.pageSize), total_count: rows.length });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function startFakeMagento(seed: Partial<Pick<FakeMagento, 'products' | 'categories' | 'sources' | 'sourceItems' | 'rules' | 'coupons' | 'cmsPages' | 'cmsBlocks' | 'rewrites' | 'orders'>> = {}): Promise<FakeMagento> {
  const f = { token: 'fake-integration-token', products: [], categories: [], sources: [{ source_code: 'default', name: 'Default Source', enabled: true }], sourceItems: [], rules: [], coupons: [], cmsPages: [], cmsBlocks: [], rewrites: {}, orders: [], ordersDenied: false, log: [], failNext: [], delayMs: 0, open: 0, maxOpen: 0, ...seed } as unknown as FakeMagento;
  let nextId = 1000, nextMedia = 500, adminTokenValid = true;
  f.expireToken = () => { adminTokenValid = false; };
  const attrs: Rec[] = [
    { attribute_id: 93, attribute_code: 'color', default_frontend_label: 'Farbe', frontend_input: 'select', is_user_defined: true, scope: 'global', options: [{ label: ' ', value: '' }, { label: 'Sand', value: '11' }, { label: 'Salbei', value: '12' }] },
    { attribute_id: 83, attribute_code: 'manufacturer', default_frontend_label: 'Hersteller', frontend_input: 'select', is_user_defined: true, scope: 'global', options: [{ label: 'Haus Holm', value: '21' }] },
    { attribute_id: 132, attribute_code: 'tax_class_id', default_frontend_label: 'Steuerklasse', frontend_input: 'select', is_user_defined: false, scope: 'website', options: [{ label: 'None', value: '0' }, { label: 'Taxable Goods', value: '2' }] },
  ];
  const productOut = (p: FakeProduct, s: number) => {
    const v = merged(p.vals, s), top: Rec = {}, ca: { attribute_code: string; value: unknown }[] = [];
    for (const [k, x] of Object.entries(v)) { if (TOP.has(k)) top[k] = x; else ca.push({ attribute_code: k, value: x }); }
    const cats = f.categories.filter(c => c.products.some(l => l.sku === p.sku));
    const roles = (file: string) => ROLES.filter(r => v[r] === file);
    return { id: p.id, sku: p.sku, type_id: p.type_id, attribute_set_id: p.attribute_set_id, ...top, extension_attributes: { website_ids: p.website_ids, category_links: cats.map(c => ({ category_id: String(c.id), position: c.products.find(l => l.sku === p.sku)!.position })) },
      media_gallery_entries: p.media.map(m => { const mv = { ...m.vals[0], ...(s ? m.vals[s] ?? {} : {}) }; return { id: m.id, media_type: m.media_type, label: mv.label ?? null, position: mv.position ?? 0, disabled: !!mv.disabled, types: roles(m.file), file: m.file }; }),
      custom_attributes: [...ca, { attribute_code: 'category_ids', value: cats.map(c => String(c.id)) }] };
  };
  const productRow = (p: FakeProduct, s: number): Rec => ({ ...merged(p.vals, s), entity_id: String(p.id), sku: p.sku, type_id: p.type_id, category_id: f.categories.filter(c => c.products.some(l => l.sku === p.sku)).map(c => String(c.id)) });
  const catOut = (c: FakeCategory, s: number) => { const v = merged(c.vals, s), top: Rec = {}, ca: Rec[] = []; for (const [k, x] of Object.entries(v)) { if (TOP.has(k)) top[k] = x; else ca.push({ attribute_code: k, value: x }); } return { id: c.id, parent_id: c.parent_id, level: c.level, path: c.path, ...top, custom_attributes: ca }; };
  const tree = (c: FakeCategory, s: number): Rec => ({ ...catOut(c, s), product_count: c.products.length, children_data: f.categories.filter(x => x.parent_id === c.id).map(x => tree(x, s)) });

  const server = http.createServer(async (req, res) => {
    f.open++; f.maxOpen = Math.max(f.maxOpen, f.open); res.on('finish', () => { f.open--; });
    if (f.delayMs) await sleep(f.delayMs);
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const url = new URL(req.url ?? '/', 'http://x'), raw = await read(req), body = raw ? JSON.parse(raw) : undefined, method = req.method ?? 'GET';
    if (url.pathname === '/graphql') {
      const q = String(body?.query ?? ''), store = String(req.headers.store ?? 'default');
      f.log.push({ method, path: '/graphql', store, body });
      if (q.includes('storeConfig')) return send(200, { data: { storeConfig: { product_url_suffix: '.html', category_url_suffix: '.html', base_url: `${f.base}/`, base_media_url: `${f.base}/media/`, locale: store === 'en' ? 'en_US' : 'de_DE', store_code: store } } });
      const raw = String(body?.variables?.u ?? ''), u0 = raw.replace(/\.html$/, ''), rw = f.rewrites[u0], u = rw ?? u0, code = rw ? 301 : 0;
      const p = f.products.find(x => x.vals[0]?.url_key === u), c = f.categories.find(x => x.vals[0]?.url_key === u);
      const pg = f.cmsPages.find(x => x.identifier === raw && x.active && ((x.store_id as number[]) ?? [0]).some(id => id === 0 || id === STORES[store]));
      return send(200, { data: { route: p ? { type: 'PRODUCT', relative_url: `${u}.html`, redirect_code: code, id: p.id, sku: p.sku } : c ? { type: 'CATEGORY', relative_url: `${u}.html`, redirect_code: code, id: c.id } : pg ? { type: 'CMS_PAGE', relative_url: raw, redirect_code: 0, identifier: pg.identifier } : null } });
    }
    if (url.pathname.startsWith('/media/')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')); }
    const m = /^\/rest\/(?:([a-z][a-z0-9_]*)\/)?V1(\/.*)$/.exec(url.pathname);
    if (!m) return send(404, { message: 'Request does not match any route.' });
    const store = m[1] ?? 'default', s = STORES[store], p = m[2];
    f.log.push({ method, path: p, store, ...(body !== undefined ? { body } : {}), ...(p === '/orders' ? { query: url.search } : {}) });
    const fail = f.failNext.shift();
    if (fail) { res.writeHead(fail.status, { 'content-type': 'application/json', ...(fail.retryAfter != null ? { 'retry-after': String(fail.retryAfter) } : {}) }); return res.end(JSON.stringify({ message: `Fake: ${fail.status}` })); }
    if (p === '/integration/admin/token' && method === 'POST') { if (body?.username === 'admin' && body?.password === 'geheim') { adminTokenValid = true; return send(200, 'admin-jwt'); } return send(401, { message: 'The account sign-in was incorrect.' }); }
    const auth = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (auth !== f.token && !(auth === 'admin-jwt' && adminTokenValid)) return send(401, { message: 'The consumer isn\'t authorized to access %resources.', parameters: { resources: 'Magento_Catalog::products' } });
    if (s === undefined) return send(400, { message: 'Requested store is not found' });
    const c = criteria(url.searchParams);
    // ---- Orders (only the list, for sales sums): created_at range as string comparison, state neq, paging ----
    if (p === '/orders' && method === 'GET') {
      if (f.ordersDenied) return send(403, { message: 'The consumer isn\'t authorized to access %resources.', parameters: { resources: 'Magento_Sales::actions_view' } });
      const ok = (o: Rec, fl: { field: string; value: string; condition_type: string }) => {
        const v = String(o[fl.field] ?? '');
        return fl.condition_type === 'gteq' ? v >= fl.value : fl.condition_type === 'lteq' ? v <= fl.value : fl.condition_type === 'neq' ? v !== fl.value : fl.condition_type === 'eq' ? v === fl.value : false;
      };
      const rows = f.orders.filter(o => c.groups.every(g => g.some(fl => ok(o, fl)))).sort((a, b) => Number(a.entity_id) - Number(b.entity_id));
      return send(200, page(rows, c));
    }
    if (/^\/(customers|orders|invoices|carts|guest-carts|creditmemo|transactions)/.test(p)) return send(403, { message: 'Fake: gesperrt' });
    let mm: RegExpExecArray | null;
    // ---- Products ----
    if (p === '/products' && method === 'GET') {
      const rows = f.products.filter(x => c.groups.every(g => g.some(fl => match(productRow(x, s), fl)))), pg = page(rows, c);
      return send(200, { ...pg, items: pg.items.map(x => productOut(x, s)), search_criteria: {} });
    }
    if (p === '/products' && method === 'POST') {
      const b = body.product as Rec;
      if (f.products.some(x => x.sku === b.sku)) return send(400, { message: 'The product was unable to be saved. Please try again.' });
      const v = flat(b); delete v.category_ids;
      const pr: FakeProduct = { id: nextId++, sku: String(b.sku), type_id: String(b.type_id ?? 'simple'), attribute_set_id: Number(b.attribute_set_id ?? 4), vals: { 0: v }, website_ids: ((b.extension_attributes as Rec)?.website_ids as number[]) ?? [1], media: [] };
      for (const [i, e] of ((b.media_gallery_entries ?? []) as Rec[]).entries()) { const file = `/n/e/${(e.content as Rec).name}`; pr.media.push({ id: nextMedia++, file, media_type: 'image', vals: { 0: { label: e.label as string, position: Number(e.position ?? i), disabled: !!e.disabled } } }); for (const r of (e.types ?? []) as string[]) pr.vals[0][r] = file; }
      for (const l of ((b.extension_attributes as Rec)?.category_links ?? []) as Rec[]) f.categories.find(x => String(x.id) === String(l.category_id))?.products.push({ sku: pr.sku, position: Number(l.position ?? 0) });
      f.products.push(pr); return send(200, productOut(pr, 0));
    }
    if ((mm = /^\/products\/attributes\/([a-z_]+)$/.exec(p))) { const a = attrs.find(x => x.attribute_code === mm![1]); return a ? send(200, a) : send(404, { message: 'no attribute' }); }
    if (p === '/products/attributes') return send(200, page(attrs.filter(a => c.groups.every(g => g.some(fl => match(a, fl)))), c));
    if (p === '/products/attribute-sets/sets/list') return send(200, { items: [{ attribute_set_id: 4, attribute_set_name: 'Default', entity_type_id: 4 }], total_count: 1 });
    if ((mm = /^\/products\/([^/]+)$/.exec(p))) {
      const sku = decodeURIComponent(mm[1]), pr = f.products.find(x => x.sku === sku);
      if (!pr) return send(404, { message: 'The product that was requested doesn\'t exist. Verify the product and try again.' });
      if (method === 'GET') return send(200, productOut(pr, s));
      if (method === 'DELETE') { f.products = f.products.filter(x => x !== pr); for (const k of f.categories) k.products = k.products.filter(l => l.sku !== sku); for (const x of f.products) if (x.children) x.children = x.children.filter(k => k !== sku); return send(200, true); }
      if (method === 'PUT') { const v = flat(body.product); delete v.save_rewrites_history; if (s === 0 && 'name' in v && !v.name) return send(400, { message: 'The "Product Name" attribute value is empty. Set the attribute and try again.' }); setVals(pr.vals, s, v); return send(200, productOut(pr, s)); }
    }
    if ((mm = /^\/products\/([^/]+)\/media(?:\/(\d+))?$/.exec(p))) {
      const pr = f.products.find(x => x.sku === decodeURIComponent(mm![1]));
      if (!pr) return send(404, { message: 'no product' });
      if (method === 'POST') { const e = body.entry as Rec, file = `/f/${nextMedia}-${(e.content as Rec).name}`; const id = nextMedia++; pr.media.push({ id, file, media_type: 'image', vals: { 0: { label: e.label as string, position: Number(e.position), disabled: !!e.disabled } } }); for (const r of (e.types ?? []) as string[]) pr.vals[0][r] = file; return send(200, String(id)); }
      const me = pr.media.find(x => x.id === Number(mm![2])); if (!me) return send(404, { message: 'no entry' });
      if (method === 'DELETE') { pr.media = pr.media.filter(x => x !== me); return send(200, true); }
      if (method === 'PUT') {
        const e = body.entry as Rec; me.vals[s] = { label: e.label as string | null, position: Number(e.position), disabled: !!e.disabled };
        const types = (e.types ?? []) as string[];
        for (const r of ROLES) { const cur = merged(pr.vals, 0)[r]; if (types.includes(r)) pr.vals[0][r] = me.file; else if (cur === me.file) pr.vals[0][r] = 'no_selection'; }
        return send(200, true);
      }
    }
    if ((mm = /^\/configurable-products\/([^/]+)\/(children|options\/all|child)$/.exec(p))) {
      const pr = f.products.find(x => x.sku === decodeURIComponent(mm![1])); if (!pr) return send(404, { message: 'no product' });
      if (mm[2] === 'children') return send(200, (pr.children ?? []).map(k => f.products.find(x => x.sku === k)).filter(Boolean).map(x => productOut(x!, s)));
      if (mm[2] === 'options/all') return send(200, pr.options ?? []);
      (pr.children ??= []).push(String(body.childSku)); return send(200, true);
    }
    // ---- Stock (MSI) ----
    if (p === '/inventory/sources') return send(200, { items: f.sources, total_count: f.sources.length });
    if (p === '/inventory/source-items' && method === 'GET') return send(200, page(f.sourceItems.filter(x => c.groups.every(g => g.some(fl => match(x, fl)))), c));
    if (p === '/inventory/source-items' && method === 'POST') { for (const it of body.sourceItems as Rec[]) { const ex = f.sourceItems.find(x => x.sku === it.sku && x.source_code === it.source_code); if (ex) Object.assign(ex, it); else f.sourceItems.push({ ...it }); } return send(200, true); }
    if (p === '/inventory/source-items-delete' && method === 'POST') { f.sourceItems = f.sourceItems.filter(x => !(body.sourceItems as Rec[]).some(d => d.sku === x.sku && d.source_code === x.source_code)); return send(200, true); }
    // ---- Categories ----
    if (p === '/categories' && method === 'GET') return send(200, tree(f.categories.find(x => x.level === 1) ?? f.categories[0], s));
    if (p === '/categories/list') return send(200, page(f.categories.filter(x => c.groups.every(g => g.some(fl => match({ ...merged(x.vals, s), is_active: merged(x.vals, s).is_active ? '1' : '0', entity_id: String(x.id), parent_id: String(x.parent_id), level: x.level }, fl)))).map(x => catOut(x, s)), c));
    if ((mm = /^\/categories\/(\d+)$/.exec(p))) {
      const k = f.categories.find(x => x.id === Number(mm![1])); if (!k) return send(404, { message: 'No such entity with id = %1', parameters: [mm[1]] });
      if (method === 'GET') return send(200, catOut(k, s));
      if (method === 'PUT') { const v = flat(body.category); delete v.save_rewrites_history; setVals(k.vals, s, v, { noNull: new Set(['name', 'is_active']) }); return send(200, catOut(k, s)); } // Magento discards null for name/is_active
    }
    if ((mm = /^\/categories\/(\d+)\/products(?:\/([^/]+))?$/.exec(p))) {
      const k = f.categories.find(x => x.id === Number(mm![1])); if (!k) return send(404, { message: 'no category' });
      if (method === 'GET') return send(200, k.products.map(l => ({ ...l, category_id: String(k.id) })));
      if (method === 'POST') { const l = body.productLink as Rec; k.products = [...k.products.filter(x => x.sku !== l.sku), { sku: String(l.sku), position: Number(l.position ?? 0) }]; return send(200, true); }
      if (method === 'DELETE') { k.products = k.products.filter(x => x.sku !== decodeURIComponent(mm![2])); return send(200, true); }
    }
    // ---- Promotions ----
    if (p === '/salesRules/search') return send(200, page(f.rules.filter(r => c.groups.every(g => g.some(fl => match(r, fl)))), c));
    if (p === '/salesRules' && method === 'POST') { const r = { rule_id: nextId++, times_used: 0, uses_per_coupon: 0, sort_order: 0, store_labels: [], ...body.rule }; f.rules.push(r); return send(200, r); }
    if ((mm = /^\/salesRules\/(\d+)$/.exec(p))) {
      const r = f.rules.find(x => Number(x.rule_id) === Number(mm![1])); if (!r) return send(404, { message: 'Rule with specified ID "%1" not found.', parameters: [mm[1]] });
      if (method === 'GET') return send(200, r);
      if (method === 'PUT') { for (const [k, v] of Object.entries(body.rule as Rec)) if (k === 'store_labels') { // like Magento: [] and null change nothing, empty text deletes the label of this store view
          if (!Array.isArray(v)) continue;
          const cur = ((r.store_labels ?? []) as Rec[]).filter(x => !(v as Rec[]).some(l => Number(l.store_id) === Number(x.store_id)));
          for (const l of v as Rec[]) if (l.store_label) cur.push({ store_id: Number(l.store_id), store_label: l.store_label });
          if (cur.length || 'store_labels' in r) r.store_labels = cur.sort((x, y) => Number(x.store_id) - Number(y.store_id));
        } else if (v !== null) r[k] = (k === 'from_date' || k === 'to_date') && v === '' ? undefined : v; for (const k of ['from_date', 'to_date']) if (r[k] === undefined) delete r[k]; return send(200, r); }
      if (method === 'DELETE') { f.rules = f.rules.filter(x => x !== r); f.coupons = f.coupons.filter(x => Number(x.rule_id) !== Number(r.rule_id)); return send(200, true); }
    }
    if (p === '/coupons/search') return send(200, page(f.coupons.filter(x => c.groups.every(g => g.some(fl => match(x, fl)))), c));
    if (p === '/coupons' && method === 'POST') { const cp = { coupon_id: nextId++, times_used: 0, ...body.coupon }; f.coupons.push(cp); return send(200, cp); }
    if ((mm = /^\/coupons\/(\d+)$/.exec(p))) { const cp = f.coupons.find(x => Number(x.coupon_id) === Number(mm![1])); if (!cp) return send(404, { message: 'no coupon' }); if (method === 'PUT') Object.assign(cp, body.coupon); if (method === 'DELETE') f.coupons = f.coupons.filter(x => x !== cp); return send(200, method === 'DELETE' ? true : cp); }
    if (p === '/coupons/generate') { const spec = body.couponSpec as Rec, codes = Array.from({ length: Number(spec.quantity) }, (_, i) => `${spec.prefix ?? ''}C${nextId}${i}`); nextId++; for (const code of codes) f.coupons.push({ coupon_id: nextId++, rule_id: spec.rule_id, code, times_used: 0, type: 1 }); return send(200, codes); }
    if (p === '/coupons/deleteByCodes') { f.coupons = f.coupons.filter(x => !(body.codes as string[]).includes(String(x.code))); return send(200, { failed_items: [], missing_items: [] }); }
    if (p === '/customerGroups/search') return send(200, { items: [{ id: 0, code: 'NOT LOGGED IN' }, { id: 1, code: 'General' }], total_count: 2 });
    // ---- CMS pages and blocks (like Magento: saving takes over only sent fields, store from the URL on create) ----
    for (const [res, list, key] of [['cmsPage', f.cmsPages, 'page'], ['cmsBlock', f.cmsBlocks, 'block']] as const) {
      const out = (x: Rec) => { const { store_id: _s, ...rest } = x; void _s; return rest; };
      if (p === `/${res}/search`) return send(200, { ...page(list.filter(x => c.groups.every(g => g.some(fl => match({ ...x, [`${key}_id`]: String(x.id), is_active: x.active ? '1' : '0' }, fl)))).map(out), c), search_criteria: {} });
      if (p === `/${res}` && method === 'POST') {
        const d = body[key] as Rec;
        if (!d.identifier || !d.title) return send(400, { message: 'Required field "%1" is empty.', parameters: ['title'] });
        if (list.some(x => x.identifier === d.identifier && ((x.store_id as number[]) ?? [0]).some(id => id === 0 || id === s || s === 0))) return send(400, { message: `A ${key} URL key for specified store already exists.` });
        const rec = { id: nextId++, active: true, ...d, store_id: [s], creation_time: '2026-10-10 12:00:00', update_time: '2026-10-10 12:00:00' };
        list.push(rec); return send(200, out(rec));
      }
      if ((mm = new RegExp(`^/${res}/(\\d+)$`).exec(p))) {
        const x = list.find(r => Number(r.id) === Number(mm![1]));
        if (!x) return send(404, { message: `The CMS ${key} with the "%1" ID doesn't exist.`, parameters: [mm[1]] });
        if (method === 'GET') return send(200, out(x));
        if (method === 'DELETE') { list.splice(list.indexOf(x), 1); return send(200, true); }
        if (method === 'PUT') { // Magento stores NULL and omits it in responses; without identifier it rebuilds it from the title (pages)
          const d = body[key] as Rec;
          for (const [k2, v] of Object.entries(d)) if (k2 !== 'id') { if (v === null) delete x[k2]; else x[k2] = v; }
          if (key === 'page' && !('identifier' in d) && d.title) x.identifier = String(d.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          return send(200, out(x));
        }
      }
    }
    // ---- Shop ----
    if (p === '/store/storeViews') return send(200, [{ id: 1, code: 'default', name: 'Default Store View', website_id: 1, is_active: 1 }, { id: 0, code: 'admin', name: 'Admin', website_id: 0, is_active: 1 }, { id: 2, code: 'en', name: 'English', website_id: 1, is_active: 1 }]);
    if (p === '/store/storeConfigs') return send(200, [{ id: 1, code: 'default', locale: 'de_DE', base_currency_code: 'EUR', base_url: `${f.base}/`, base_link_url: `${f.base}/`, base_media_url: `${f.base}/media/` }, { id: 2, code: 'en', locale: 'en_US', base_currency_code: 'EUR', base_url: `${f.base}/`, base_link_url: `${f.base}/`, base_media_url: `${f.base}/media/` }]);
    if (p === '/store/websites') return send(200, [{ id: 1, code: 'base', name: 'Main Website', default_group_id: 1 }, { id: 0, code: 'admin', name: 'Admin', default_group_id: 0 }]);
    if (p === '/store/storeGroups') return send(200, [{ id: 0, website_id: 0, root_category_id: 0, default_store_id: 0, code: 'default' }, { id: 1, website_id: 1, root_category_id: 2, default_store_id: 1, code: 'main_website_store' }]);
    return send(404, { message: 'Request does not match any route.' });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  f.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  f.snapshot = () => JSON.stringify({ products: f.products, categories: f.categories, sourceItems: f.sourceItems, rules: f.rules, coupons: f.coupons, cmsPages: f.cmsPages, cmsBlocks: f.cmsBlocks });
  f.close = () => new Promise(r => server.close(() => r()));
  return f;
}
