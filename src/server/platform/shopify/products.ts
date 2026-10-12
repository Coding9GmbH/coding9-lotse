import 'server-only';
// Shopify: Änderungssets für Produkte (Felder, neue Produkte, Varianten, Stapel) + Executor mit exakten Rückgängig-Schritten.
// Preise liegen bei Shopify an den Varianten: ein Produktpreis gilt für alle Varianten, Regeln ({percent, add, set, round}) rechnet der Server je Variante.
import type { ChangeAsset, ChangeItem, ChangeSet, UndoOp } from '@/lib/protocol';
import { MAX_ITEMS, WRITE_CONCURRENCY, errMsg, faqHtml, normFaq, pool, resolvePrice, trackedUndo, type ApplyCtx, type ApplyResult, type PriceSpec, type RawFaq } from '../../changes';
import { stagedMeta } from '../../media';
import { newId } from '../../shopware';
import { shortId, toGid, type Json, type ShopifyClient } from './client';
import { allVariants, collectionsByIds, fmtMoney, idsWhere, mediaByIds, money, moneyRaw, productQuery, productsByIds, qField, searchProducts, stripHtml, toNum, type ProductFilter, type Q } from './data';
import { deleteOp, isUserError, M, reqOp, run, runCreating, runRecording } from './ops';
import { uploadStagedImage } from './upload';

export type FieldKind = 'str' | 'html' | 'price' | 'bool' | 'status' | 'tags' | 'faq' | 'variantStr';
export const PRODUCT_FIELDS: Record<string, { label: string; kind: FieldKind }> = {
  name: { label: 'Name', kind: 'str' }, description: { label: 'Beschreibung', kind: 'html' },
  metaTitle: { label: 'Meta-Title (SEO)', kind: 'str' }, metaDescription: { label: 'Meta-Description (SEO)', kind: 'str' },
  price: { label: 'Preis', kind: 'price' }, listPrice: { label: 'Streichpreis (Vergleichspreis)', kind: 'price' },
  active: { label: 'Aktiv', kind: 'bool' }, status: { label: 'Status', kind: 'status' },
  vendor: { label: 'Hersteller (Vendor)', kind: 'str' }, productType: { label: 'Produkttyp', kind: 'str' }, tags: { label: 'Tags', kind: 'tags' },
  sku: { label: 'Artikelnummer (SKU)', kind: 'variantStr' }, barcode: { label: 'Barcode (EAN/GTIN)', kind: 'variantStr' },
  faq: { label: 'FAQ (Metafeld lotse.faq)', kind: 'faq' },
};
/** Shopware-Namen, die auf Shopify anders heißen */
const ALIAS: Record<string, string> = { ean: 'barcode', manufacturer: 'vendor', productNumber: 'sku', compareAtPrice: 'listPrice', title: 'name', descriptionHtml: 'description' };
const NOT_HERE: Record<string, string> = {
  stock: 'Bestand ist in Lotse für Shopify nur lesbar (Lagerbestände je Standort pflegst du im Shopify-Admin)',
  keywords: 'Shopify hat kein Keyword-Feld (Suchbegriffe über tags)',
  manufacturerNumber: 'gibt es bei Shopify nicht (SKU/Barcode nutzen)',
};
const STATUS = ['ACTIVE', 'DRAFT', 'ARCHIVED'] as const;
const STATUS_DE: Record<string, string> = { ACTIVE: 'aktiv', DRAFT: 'Entwurf', ARCHIVED: 'archiviert', UNLISTED: 'nicht gelistet' };
const cut = (t: unknown, n = 220) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s || '–'; };
export const productLabel = (p: Json) => `${p.title}${p.variants?.nodes?.[0]?.sku ? ` (${p.variants.nodes[0].sku})` : ''}`;
export const normTags = (t: unknown): string[] => [...new Set((Array.isArray(t) ? t : String(t ?? '').split(',')).map(x => String(x).trim()).filter(Boolean))];
const tagsAfter = (cur: string[], raw: unknown): string[] => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as { add?: unknown; remove?: unknown }, rm = new Set(normTags(r.remove ?? []).map(t => t.toLowerCase()));
    return normTags([...cur.filter(t => !rm.has(t.toLowerCase())), ...normTags(r.add ?? [])]);
  }
  return normTags(raw);
};
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Werte-Spanne als Text, z. B. „18,00 € – 22,00 € (4 Varianten)“ */
export function priceRange(vals: (number | null)[], currency: string, n = vals.length): string {
  const nums = vals.filter((v): v is number => v != null);
  const txt = !nums.length ? '–' : Math.min(...nums) === Math.max(...nums) ? fmtMoney(nums[0], currency)! : `${fmtMoney(Math.min(...nums), currency)} bis ${fmtMoney(Math.max(...nums), currency)}`;
  return `${txt}${nums.length && nums.length < vals.length ? ' / ohne' : ''}${n > 1 ? ` (${n} Varianten)` : ''}`;
}

/** Preise je Variante nach Regel (rein, testbar). field: price | listPrice; newPrices: neue Preise je Variante (für Streichpreis-Warnung) */
export function planPrices(variants: Json[], field: 'price' | 'listPrice', spec: PriceSpec, newPrices?: Map<string, number>) {
  const out: { id: string; before: number | null; after: number | null }[] = [], warn = new Set<string>();
  for (const v of variants) {
    const cur = toNum(field === 'price' ? v.price : v.compareAtPrice);
    let next: number | null;
    if (field === 'listPrice' && cur == null && spec !== null && typeof spec === 'object' && spec.set == null) next = null; // Regel ohne Streichpreis: nichts zu tun
    else next = resolvePrice(cur, spec);
    if (field === 'price' && next === null) throw new Error('Preis kann bei Shopify nicht entfernt werden');
    if (next !== null && (!Number.isFinite(next) || next < 0)) throw new Error(`ungültiger Wert ${next}`);
    if (next === cur) continue;
    out.push({ id: v.id, before: cur, after: next });
    const price = newPrices?.get(v.id) ?? toNum(v.price);
    if (field === 'price') {
      if (next === 0) warn.add('Preis 0');
      if (cur && next != null && Math.abs((next - cur) / cur) >= 0.3) warn.add(`Preisänderung ${next > cur ? '+' : '−'}${Math.abs(((next - cur) / cur) * 100).toFixed(0)} %`);
    } else if (next != null && price != null && next <= price) warn.add('Streichpreis ≤ Preis');
  }
  return { changes: out, warn: [...warn] };
}

export interface ProposeArgs { title: string; reason: string; changes: { id: string; fields: Record<string, unknown> }[] }

/** Produktfelder-Änderungsset (liest über den geschützten Reader) */
export async function buildProductChangeSet(q: Q, a: ProposeArgs, currency: string): Promise<ChangeSet> {
  if (!a.changes?.length) throw new Error('changes ist leer');
  if (a.changes.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} Produkte pro Änderungsset: bitte aufteilen oder propose_bulk_product_change nutzen.`);
  const valid = a.changes.filter(c => { try { toGid('Product', c.id); return true; } catch { return false; } });
  const rows = await productsByIds(q, valid.map(c => c.id));
  for (const p of rows) if (p.variants?.pageInfo?.hasNextPage) p.variants.nodes = await allVariants(q, p);
  const by = new Map(rows.map(p => [shortId(p.id), p]));
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = []; let unchanged = 0;
  for (const ch of a.changes) {
    const p = by.get(shortId(String(ch.id)));
    if (!p) { skipped.push({ id: String(ch.id), reason: 'Produkt nicht gefunden' }); continue; }
    const id = shortId(p.id), label = productLabel(p), variants: Json[] = p.variants?.nodes ?? [];
    const fields = Object.fromEntries(Object.entries(ch.fields ?? {}).map(([k, v]) => [ALIAS[k] ?? k, v]));
    if ('active' in fields && 'status' in fields) { skipped.push({ id, reason: 'active und status nicht gleichzeitig' }); delete fields.active; }
    const newPrices = new Map<string, number>();
    for (const [field, raw] of Object.entries(fields).sort(([x], [y]) => (x === 'price' ? -1 : y === 'price' ? 1 : 0))) {
      const def = PRODUCT_FIELDS[field];
      if (!def) { skipped.push({ id, reason: NOT_HERE[field] ? `${field}: ${NOT_HERE[field]}` : `Feld "${field}" nicht erlaubt (erlaubt: ${Object.keys(PRODUCT_FIELDS).join(', ')})` }); continue; }
      try {
        const base = { id: `${id}:${field}`, entity: 'product', entityId: id, label, field, fieldLabel: def.label };
        if (def.kind === 'price') {
          const plan = planPrices(variants, field as 'price' | 'listPrice', raw as PriceSpec, newPrices);
          if (!plan.changes.length) { unchanged++; continue; }
          if (field === 'price') plan.changes.forEach(c => newPrices.set(c.id, c.after!));
          const ids = new Set(plan.changes.map(c => c.id));
          items.push({ ...base, before: priceRange(variants.filter(v => ids.has(v.id)).map(v => toNum(field === 'price' ? v.price : v.compareAtPrice)), currency),
            after: plan.changes.every(c => c.after === null) ? 'entfernt' : priceRange(plan.changes.map(c => c.after), currency), afterRaw: { variants: plan.changes.map(c => ({ id: c.id, value: c.after })) }, warn: plan.warn });
          continue;
        }
        if (def.kind === 'faq') {
          const faq = normFaq(raw as RawFaq, p.title);
          let cur: { items?: unknown[] } | null = null; try { cur = p.faq?.value ? JSON.parse(p.faq.value) : null; } catch { /* altes Format */ }
          items.push({ ...base, before: cur?.items?.length ? `${cur.items.length} Fragen` : '–', after: `${faq.items.length} Fragen: „${cut(faq.items[0].q, 70)}“ …`, afterRaw: faq, html: { before: '', after: faq.items.map(i => `F: ${i.q}\nA: ${i.a}`).join('\n\n').slice(0, 4000) }, warn: ['Das Theme muss das Metafeld lotse.faq ausgeben (z. B. als FAQ-Abschnitt)'] });
          continue;
        }
        if (def.kind === 'variantStr') {
          if (variants.length !== 1) throw new Error('Produkt hat mehrere Varianten: SKU/Barcode je Variante mit propose_variants');
          if (typeof raw !== 'string' || raw.length > 255) throw new Error(`${def.label}: Text bis 255 Zeichen erwartet`);
          const cur = variants[0][field] ?? null;
          if ((cur ?? '') === raw) { unchanged++; continue; }
          items.push({ ...base, before: cut(cur), after: cut(raw), afterRaw: { variantId: variants[0].id, value: raw }, warn: [] });
          continue;
        }
        let cur: unknown, next: unknown, before: string, after: string; const warn: string[] = [];
        switch (def.kind) {
          case 'bool': if (typeof raw !== 'boolean') throw new Error(`${def.label}: true/false erwartet`); cur = p.status === 'ACTIVE'; next = raw;
            before = STATUS_DE[p.status] ?? p.status; after = raw ? 'aktiv' : 'Entwurf'; if (!raw) warn.push('Wird deaktiviert (Entwurf, im Shop nicht sichtbar)'); break;
          case 'status': { const s = String(raw).toUpperCase(); if (!STATUS.includes(s as typeof STATUS[number])) throw new Error('Status: ACTIVE, DRAFT oder ARCHIVED'); cur = p.status; next = s; before = STATUS_DE[p.status] ?? p.status; after = STATUS_DE[s]; if (s !== 'ACTIVE') warn.push('Im Shop nicht mehr sichtbar'); break; }
          case 'tags': { const curT: string[] = p.tags ?? []; const n = tagsAfter(curT, raw); if (sameList([...curT].sort(), [...n].sort())) { unchanged++; continue; } cur = curT; next = n; before = curT.join(', ') || '–'; after = n.join(', ') || '–'; if (n.length < curT.length) warn.push(`${curT.length - n.length} Tag(s) entfernt: Kollektionen mit Tag-Regeln können sich ändern`); break; }
          default: {
            if (typeof raw !== 'string') throw new Error(`${def.label}: Text erwartet`);
            if (def.kind === 'str' && raw.length > 255) throw new Error(`${def.label}: max. 255 Zeichen`);
            if (field === 'name' && !raw.trim()) throw new Error('Name darf nicht leer sein');
            cur = field === 'name' ? p.title : field === 'description' ? p.descriptionHtml : field === 'metaTitle' ? p.seo?.title : field === 'metaDescription' ? p.seo?.description : p[field];
            next = raw; before = cut(cur); after = cut(raw);
          }
        }
        if (cur === next || (cur == null && next === '')) { unchanged++; continue; }
        items.push({ ...base, before, after, afterRaw: next, html: def.kind === 'html' ? { before: String(cur ?? '').slice(0, 4000), after: String(next).slice(0, 4000) } : undefined, warn });
      } catch (e) { skipped.push({ id, reason: `${field}: ${errMsg(e)}` }); }
    }
  }
  if (!items.length) throw new Error(`Keine Änderung nötig bzw. nichts anwendbar (${unchanged} unverändert, ${skipped.length} übersprungen: ${skipped.slice(0, 3).map(s => s.reason).join('; ')})`);
  return { id: newId(), kind: 'products', entity: 'product', title: a.title, reason: a.reason, items, skipped, unchanged, atomic: false };
}

// ---- Executor: Produktfelder ----
const seoOf = (p: Json) => ({ title: p.seo?.title ?? null, description: p.seo?.description ?? null });
export async function freshProduct(client: ShopifyClient, id: string): Promise<Json> {
  const q: Q = (d, v) => client.gql(d, v);
  const [p] = await productsByIds(q, [id], undefined, 1);
  if (!p) throw new Error('Produkt nicht mehr vorhanden');
  if (p.variants?.pageInfo?.hasNextPage) p.variants.nodes = await allVariants(q, p);
  return p;
}

/** schreibt alle Felder eines Produkts; liefert die Rückgängig-Schritte (auch bei Teilfehlern die der erfolgreichen Schritte) */
export async function applyProductItems(client: ShopifyClient, its: ChangeItem[], results: ApplyResult['results'], undo: UndoOp[]) {
  const p = await freshProduct(client, its[0].entityId!), gid = p.id;
  const varById = new Map<string, Json>((p.variants?.nodes ?? []).map((v: Json) => [v.id, v]));
  const prod: Json = { id: gid }, back: Json = { id: gid }, prodItems: ChangeItem[] = [];
  const vIn = new Map<string, Json>(), vBack = new Map<string, Json>(), varItems: ChangeItem[] = [];
  let faq: ChangeItem | undefined;
  for (const it of its) {
    const raw = it.afterRaw;
    switch (it.field) {
      case 'name': prod.title = raw; back.title = p.title; prodItems.push(it); break;
      case 'description': prod.descriptionHtml = raw; back.descriptionHtml = p.descriptionHtml ?? ''; prodItems.push(it); break;
      case 'vendor': case 'productType': prod[it.field] = raw; back[it.field] = p[it.field] ?? ''; prodItems.push(it); break;
      case 'tags': prod.tags = raw; back.tags = p.tags ?? []; prodItems.push(it); break;
      case 'active': prod.status = raw ? 'ACTIVE' : 'DRAFT'; back.status = p.status; prodItems.push(it); break;
      case 'status': prod.status = raw; back.status = p.status; prodItems.push(it); break;
      case 'metaTitle': case 'metaDescription': {
        prod.seo = { ...seoOf(p), ...(prod.seo ?? {}), [it.field === 'metaTitle' ? 'title' : 'description']: raw }; back.seo = seoOf(p); prodItems.push(it); break;
      }
      case 'price': case 'listPrice': {
        for (const c of (raw as { variants: { id: string; value: number | null }[] }).variants) {
          const v = varById.get(c.id); if (!v) throw new Error('Variante nicht mehr vorhanden');
          const k = it.field === 'price' ? 'price' : 'compareAtPrice';
          vIn.set(c.id, { ...(vIn.get(c.id) ?? { id: c.id }), [k]: c.value === null ? null : money(c.value) });
          vBack.set(c.id, { ...(vBack.get(c.id) ?? { id: c.id }), [k]: moneyRaw(v[k]) });
        }
        varItems.push(it); break;
      }
      case 'sku': case 'barcode': {
        const { variantId, value } = raw as { variantId: string; value: string }, v = varById.get(variantId); if (!v) throw new Error('Variante nicht mehr vorhanden');
        const set = (m: Map<string, Json>, val: string | null) => m.set(variantId, { ...(m.get(variantId) ?? { id: variantId }), ...(it.field === 'sku' ? { inventoryItem: { sku: val } } : { barcode: val }) });
        set(vIn, value); set(vBack, v[it.field] ?? null); varItems.push(it); break;
      }
      case 'faq': faq = it; break;
    }
  }
  const step = async (list: ChangeItem[], fn: () => Promise<void>) => {
    if (!list.length) return;
    try { await fn(); list.forEach(i => results.push({ itemId: i.id, ok: true })); }
    catch (e) { list.forEach(i => results.push({ itemId: i.id, ok: false, error: errMsg(e) })); }
  };
  await step(prodItems, () => runRecording(client, M.productUpdate, { product: prod }, undo, reqOp('product', gid, M.productUpdate, { product: back })));
  await step(varItems, () => runRecording(client, M.variantsUpdate, { productId: gid, variants: [...vIn.values()] }, undo, reqOp('variants', gid, M.variantsUpdate, { productId: gid, variants: [...vBack.values()] })));
  if (faq) await step([faq], async () => {
    const f = faq!.afterRaw as { title: string; items: { q: string; a: string }[] };
    await runRecording(client, M.metafieldsSet, { metafields: [{ ownerId: gid, namespace: 'lotse', key: 'faq', type: 'json', value: JSON.stringify({ title: f.title, items: f.items, html: faqHtml(f) }) }] }, undo,
      p.faq ? reqOp('metafield', gid, M.metafieldsSet, { metafields: [{ ownerId: gid, namespace: 'lotse', key: 'faq', type: p.faq.type, value: p.faq.value }] })
        : reqOp('metafield', gid, M.metafieldsDelete, { metafields: [{ ownerId: gid, namespace: 'lotse', key: 'faq' }] }));
  });
}

export async function applyProducts(client: ShopifyClient, cs: ChangeSet, selected: Set<string>, ctx?: ApplyCtx): Promise<ApplyResult> {
  const groups = new Map<string, ChangeItem[]>();
  for (const it of cs.items) if (selected.has(it.id) && it.entityId) groups.set(it.entityId, [...(groups.get(it.entityId) ?? []), it]);
  const results: ApplyResult['results'] = [], undo: UndoOp[] = []; let done = 0;
  await pool([...groups.values()], WRITE_CONCURRENCY, async its => {
    try { await applyProductItems(client, its, results, undo); } catch (e) { its.forEach(i => results.push({ itemId: i.id, ok: false, error: errMsg(e) })); }
    ctx?.progress?.(++done, groups.size, { results, undo });
  });
  return { results, undo };
}

// ---- Neue Produkte ----
export interface NewProductInput {
  name: string; description: string; price: number; listPrice?: number | null; sku?: string; barcode?: string; vendor?: string; productType?: string; tags?: string[];
  metaTitle?: string; metaDescription?: string; collectionIds?: string[]; images?: string[]; active?: boolean;
}
export interface NewProductPayload extends NewProductInput { images: string[]; collectionIds: string[]; active: boolean; tags: string[]; currency?: string }

export async function buildNewProductsChangeSet(q: Q, a: { title: string; reason: string; products: NewProductInput[] }, currency: string): Promise<ChangeSet> {
  if (!a.products?.length) throw new Error('products ist leer');
  if (a.products.length > 50) throw new Error('Maximal 50 neue Produkte pro Änderungsset: bitte aufteilen.');
  const colIds = [...new Set(a.products.flatMap(p => p.collectionIds ?? []))];
  const cols = colIds.length ? await collectionsByIds(q, colIds, 'id title ruleSet { appliedDisjunctively }') : [];
  const colBy = new Map(cols.map(c => [shortId(c.id), c]));
  const shopMedia = [...new Set(a.products.flatMap(p => p.images ?? []).filter(m => !m.startsWith('staged:') && !/^https?:/.test(m)))];
  const media = shopMedia.length ? await mediaByIds(q, shopMedia) : [];
  const mediaUrl = new Map(media.map(m => [shortId(m.id), m.image?.url as string]));
  const skus = a.products.map(p => p.sku?.trim()).filter(Boolean) as string[];
  const taken = new Set<string>();
  if (skus.length) {
    const r = await q<Json>('query SkuTaken($first: Int!, $query: String) { productVariants(first: $first, query: $query) { nodes { sku } } }', { first: 100, query: skus.map(s => `sku:"${s.replace(/"/g, '')}"`).join(' OR ') });
    for (const v of r.productVariants.nodes) if (v.sku) taken.add(v.sku);
  }
  const items: ChangeItem[] = [], assets: ChangeAsset[] = [], skipped: { id: string; reason: string }[] = [];
  a.products.forEach((p, i) => {
    const key = `neu-${i + 1}`;
    try {
      const name = stripHtml(p.name);
      if (!name || name.length > 255) throw new Error('Name fehlt oder ist länger als 255 Zeichen');
      if (typeof p.description !== 'string' || !stripHtml(p.description)) throw new Error('Beschreibung fehlt');
      if (!(typeof p.price === 'number' && Number.isFinite(p.price) && p.price >= 0)) throw new Error('Preis fehlt oder ist ungültig: bitte beim Nutzer erfragen, nicht schätzen');
      if (p.sku && taken.has(p.sku.trim())) throw new Error(`SKU ${p.sku} ist schon vergeben`);
      const collectionIds = (p.collectionIds ?? []).map(c => shortId(toGid('Collection', c)));
      const unknown = collectionIds.filter(c => !colBy.has(c)); if (unknown.length) throw new Error(`Kollektion nicht gefunden: ${unknown.join(', ')}`);
      const smart = collectionIds.filter(c => colBy.get(c)?.ruleSet); if (smart.length) throw new Error(`Kollektion ${smart.map(c => colBy.get(c)!.title).join(', ')} ist automatisch (Regeln): Produkte landen dort über ihre Daten (z. B. Tags), nicht manuell`);
      const images = (p.images ?? []).filter(m => (m.startsWith('staged:') ? !!stagedMeta(m.slice(7)) : /^https:\/\//.test(m) || mediaUrl.has(shortId(m))));
      for (const m of (p.images ?? []).filter(m => !images.includes(m))) skipped.push({ id: key, reason: `Bild ${m} nicht gefunden` });
      for (const m of images) { const sm = m.startsWith('staged:') ? stagedMeta(m.slice(7)) : null; assets.push({ name, url: sm ? `/staged/${sm.file}` : mediaUrl.get(shortId(m)) ?? m, alt: name, note: m === images[0] ? 'Titelbild' : 'weiteres Bild' }); }
      const active = p.active === true, tags = normTags(p.tags ?? []);
      const payload: NewProductPayload = { ...p, name, images: images.map(m => (m.startsWith('staged:') || /^https:/.test(m) ? m : shortId(m))), collectionIds, active, tags, currency };
      const warn: string[] = [];
      if (!images.length) warn.push('Ohne Bild');
      if (p.price === 0) warn.push('Preis 0');
      if (active) warn.push('Wird sofort aktiv und im Online Store veröffentlicht');
      const where = collectionIds.map(c => colBy.get(c)!.title).join(', ');
      items.push({ id: key, entity: 'product', label: `${name}${p.sku ? ` (${p.sku})` : ''}`, field: 'create', fieldLabel: 'Neues Produkt', before: '–',
        after: `${fmtMoney(p.price, currency)}${p.listPrice ? ` statt ${fmtMoney(p.listPrice, currency)}` : ''} · ${active ? 'aktiv' : 'Entwurf'}${where ? ` · ${where}` : ''} · ${images.length} ${images.length === 1 ? 'Bild' : 'Bilder'}`,
        afterRaw: payload, html: { before: '', after: [`<h4>${name}</h4>`, p.description, p.metaTitle ? `<p><b>Meta-Title:</b> ${stripHtml(p.metaTitle)}</p>` : '', p.metaDescription ? `<p><b>Meta-Description:</b> ${stripHtml(p.metaDescription)}</p>` : ''].join('').slice(0, 6000) }, warn });
    } catch (e) { skipped.push({ id: key, reason: `${p?.name ?? key}: ${errMsg(e)}` }); }
  });
  if (!items.length) throw new Error(`Kein Produkt anlegbar: ${skipped.map(s => s.reason).join('; ')}`);
  return { id: newId(), kind: 'new-products', entity: 'product', title: a.title, reason: a.reason, items, assets, skipped, atomic: false };
}

/** Online-Store-Publikation (für Veröffentlichen von Produkten/Kollektionen) */
export async function onlineStorePublication(client: ShopifyClient): Promise<string> {
  const r = await client.gql<Json>('query Pubs { publications(first: 20) { nodes { id name } } }');
  const p = r.publications.nodes.find((x: Json) => /online store|onlineshop|online-shop/i.test(x.name)) ?? r.publications.nodes[0];
  if (!p) throw new Error('Keine Online-Store-Publikation gefunden (Berechtigung read_publications?)');
  return p.id;
}

/** Produkt-IDs mit diesem Titel (Kandidaten für das Rückgängig eines Anlegens mit unklarem Ausgang) */
export const productIdsByTitle = (client: ShopifyClient, title: string) => idsWhere((d, v) => client.gql(d, v), 'products', qField('title', title));

/**
 * Legt ein Produkt an. Rückgängig-Schritte landen SOFORT nach jeder erfolgreichen Mutation in undo (auch wenn ein späterer Schritt
 * scheitert, bleibt das angelegte Produkt rückgängig machbar; geht die Antwort von productCreate verloren, wird das Produkt per Titel
 * nachgelesen). Wirft beim ersten Fehler.
 */
export async function createProduct(client: ShopifyClient, p: NewProductPayload, undo: UndoOp[]): Promise<void> {
  const media: Json[] = [], files: string[] = [];
  for (const m of p.images) {
    if (m.startsWith('staged:')) { const up = await uploadStagedImage(client, m.slice(7)); media.push({ originalSource: up.originalSource, mediaContentType: 'IMAGE', alt: up.alt }); }
    else if (/^https:\/\//.test(m)) media.push({ originalSource: m, mediaContentType: 'IMAGE', alt: p.name });
    else files.push(toGid('MediaImage', m));
  }
  const r = await runCreating<Json>(client, M.productCreate, {
    product: { title: p.name, descriptionHtml: p.description, status: p.active ? 'ACTIVE' : 'DRAFT', ...(p.vendor ? { vendor: p.vendor } : {}), ...(p.productType ? { productType: p.productType } : {}),
      ...(p.tags.length ? { tags: p.tags } : {}), ...(p.metaTitle || p.metaDescription ? { seo: { title: p.metaTitle ?? null, description: p.metaDescription ?? null } } : {}),
      ...(p.collectionIds.length ? { collectionsToJoin: p.collectionIds.map(c => toGid('Collection', c)) } : {}) },
    media: media.length ? media : null,
  }, undo, 'product', () => productIdsByTitle(client, p.name));
  const gid = r.product.id;
  undo.push(deleteOp('product', gid)); // läuft beim Rückgängig zuletzt (umgekehrte Reihenfolge)
  const variantId = r.product.variants?.nodes?.[0]?.id;
  if (variantId) await run(client, M.variantsUpdate, { productId: gid, variants: [{ id: variantId, price: money(p.price, p.currency), ...(p.listPrice ? { compareAtPrice: money(p.listPrice, p.currency) } : {}), ...(p.sku ? { inventoryItem: { sku: p.sku } } : {}), ...(p.barcode ? { barcode: p.barcode } : {}) }] });
  if (files.length) { // vorhandene Dateien nur verknüpfen; beim Rückgängig zuerst lösen, damit das Löschen des Produkts sie nicht mitnimmt
    await runRecording(client, M.fileUpdate, { files: files.map(id => ({ id, referencesToAdd: [gid] })) }, undo, reqOp('product-media', gid, M.fileUpdate, { files: files.map(id => ({ id, referencesToRemove: [gid] })) }));
  }
  if (p.active) await run(client, M.publish, { id: gid, input: [{ publicationId: await onlineStorePublication(client) }] });
}

// ---- Varianten ----
export interface VariantsArgs {
  title: string; reason: string; productId: string;
  update?: { id: string; price?: PriceSpec; listPrice?: PriceSpec; sku?: string; barcode?: string }[];
  updateAll?: { price?: PriceSpec; listPrice?: PriceSpec };
  create?: { options: Record<string, string>; price?: number; listPrice?: number | null; sku?: string; barcode?: string }[];
}
export async function buildVariantsChangeSet(q: Q, a: VariantsArgs, currency: string): Promise<ChangeSet> {
  const [p] = await productsByIds(q, [a.productId], undefined, 1);
  if (!p) throw new Error('Produkt nicht gefunden');
  if (p.variants?.pageInfo?.hasNextPage) p.variants.nodes = await allVariants(q, p);
  const variants: Json[] = p.variants.nodes, byId = new Map(variants.map(v => [shortId(v.id), v]));
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = [], pid = shortId(p.id);
  // updateAll gilt für alle Varianten, update je Variante hat feldweise Vorrang; fremde IDs aus update bleiben als „gehört nicht zu diesem Produkt“ stehen
  const vid = (id: string) => { try { return shortId(toGid('ProductVariant', id)); } catch { return String(id); } };
  const byUpd = new Map((a.update ?? []).map(u => [vid(u.id), u]));
  const updates = a.updateAll ? [...variants.map(v => ({ id: shortId(v.id), ...a.updateAll, ...byUpd.get(shortId(v.id)) })), ...(a.update ?? []).filter(u => !byId.has(vid(u.id)))] : [...(a.update ?? [])];
  const seen = new Set<string>();
  for (const u of updates) {
    const id = vid(String(u.id)), v = byId.get(id);
    if (!v) { skipped.push({ id, reason: 'Variante gehört nicht zu diesem Produkt' }); continue; }
    if (seen.has(id)) continue; seen.add(id);
    const label = `${p.title}, ${v.title}${v.sku ? ` (${v.sku})` : ''}`;
    try {
      let newPrice: number | undefined;
      for (const field of ['price', 'listPrice'] as const) {
        if (u[field] === undefined) continue;
        const plan = planPrices([v], field, u[field] as PriceSpec, newPrice != null ? new Map([[v.id, newPrice]]) : undefined);
        const c = plan.changes[0]; if (!c) continue;
        if (field === 'price') newPrice = c.after!;
        items.push({ id: `${id}:${field}`, entity: 'variant', entityId: pid, label, field, fieldLabel: PRODUCT_FIELDS[field].label, before: fmtMoney(c.before, currency) ?? '–', after: c.after == null ? 'entfernt' : fmtMoney(c.after, currency)!, afterRaw: { variants: [{ id: v.id, value: c.after }] }, warn: plan.warn });
      }
      for (const field of ['sku', 'barcode'] as const) {
        if (u[field] === undefined || (v[field] ?? '') === u[field]) continue;
        items.push({ id: `${id}:${field}`, entity: 'variant', entityId: pid, label, field, fieldLabel: PRODUCT_FIELDS[field].label, before: v[field] ?? '–', after: String(u[field]), afterRaw: { variantId: v.id, value: String(u[field]) }, warn: [] });
      }
    } catch (e) { skipped.push({ id, reason: errMsg(e) }); }
  }
  if (a.create?.length) {
    if (p.hasOnlyDefaultVariant) throw new Error('Das Produkt hat noch keine Optionen (nur die Standardvariante). Optionen wie Farbe/Größe zuerst im Shopify-Admin anlegen; danach kann Lotse Varianten ergänzen.');
    const optNames: string[] = p.options.map((o: Json) => o.name), existing = new Set(variants.map(v => (v.selectedOptions ?? []).map((o: Json) => o.value).join(' / ')));
    a.create.forEach((c, i) => {
      const key = `neu-${i + 1}`;
      try {
        const opts = Object.fromEntries(Object.entries(c.options ?? {}).map(([k, v]) => [optNames.find(n => n.toLowerCase() === k.toLowerCase()) ?? k, String(v).trim()]));
        const unknown = Object.keys(opts).filter(k => !optNames.includes(k)); if (unknown.length) throw new Error(`Option ${unknown.join(', ')} gibt es nicht (vorhanden: ${optNames.join(', ')})`);
        const missing = optNames.filter(n => !opts[n]); if (missing.length) throw new Error(`Wert für ${missing.join(', ')} fehlt`);
        const title = optNames.map(n => opts[n]).join(' / ');
        if (existing.has(title)) throw new Error(`Variante ${title} gibt es schon`); existing.add(title);
        const price = c.price ?? toNum(variants[0]?.price);
        if (price == null || !(price >= 0)) throw new Error('Preis fehlt');
        const newValues = optNames.filter(n => !(p.options.find((o: Json) => o.name === n)?.values ?? []).includes(opts[n])).map(n => `${n}: ${opts[n]}`);
        items.push({ id: key, entity: 'variant', entityId: pid, label: `${p.title}, ${title}`, field: 'create', fieldLabel: 'Neue Variante', before: '–',
          after: `${fmtMoney(price, currency)}${c.listPrice ? ` statt ${fmtMoney(c.listPrice, currency)}` : ''}${c.sku ? ` · SKU ${c.sku}` : ''}${c.price == null ? ' (Preis wie erste Variante)' : ''}`,
          afterRaw: { optionValues: optNames.map(n => ({ optionName: n, name: opts[n] })), price: money(price, currency), ...(c.listPrice ? { compareAtPrice: money(c.listPrice, currency) } : {}), ...(c.sku ? { inventoryItem: { sku: c.sku } } : {}), ...(c.barcode ? { barcode: c.barcode } : {}) },
          warn: [...(newValues.length ? [`Neue Ausprägung ${newValues.join(', ')} (bleibt beim Rückgängigmachen als Wert ohne Variante bestehen)`] : []), 'Bestand 0, im Shopify-Admin pflegen'] });
      } catch (e) { skipped.push({ id: key, reason: errMsg(e) }); }
    });
  }
  if (!items.length) throw new Error(`Keine Änderung nötig bzw. nichts anwendbar${skipped.length ? `: ${skipped.slice(0, 3).map(s => s.reason).join('; ')}` : ''}`);
  return { id: newId(), kind: 'variants', entity: 'variant', title: a.title, reason: a.reason, items, skipped, atomic: false, noun: { one: 'Variante', many: 'Varianten' } };
}

export async function applyVariants(client: ShopifyClient, cs: ChangeSet, selected: Set<string>, ctx?: ApplyCtx): Promise<ApplyResult> {
  const its = cs.items.filter(i => selected.has(i.id)), results: ApplyResult['results'] = [], undo = trackedUndo(ctx, its.length, results);
  const upd = its.filter(i => i.field !== 'create'), creates = its.filter(i => i.field === 'create');
  if (upd.length) {
    try { await applyProductItems(client, upd, results, undo); } catch (e) { upd.forEach(i => results.push({ itemId: i.id, ok: false, error: errMsg(e) })); }
  }
  if (creates.length) {
    const gid = toGid('Product', creates[0].entityId!);
    const note = (ids: string[]) => { if (ids.length) undo.push(reqOp('variants', gid, M.variantsDelete, { productId: gid, variantsIds: ids })); };
    try {
      const r = await run<Json>(client, M.variantsCreate, { productId: gid, variants: creates.map(i => i.afterRaw) });
      note((r.productVariants ?? []).map((v: Json) => v.id));
      creates.forEach(i => results.push({ itemId: i.id, ok: true }));
    } catch (e) {
      if (!isUserError(e)) { // Ausgang unklar: angelegte Varianten an ihren Optionswerten erkennen und zum Löschen vormerken
        try {
          const want = new Set(creates.map(i => ((i.afterRaw as Json).optionValues as Json[]).map(o => `${o.optionName}=${o.name}`).join('|'))), p = await freshProduct(client, creates[0].entityId!);
          note((p.variants.nodes as Json[]).filter(v => want.has((v.selectedOptions as Json[]).map(o => `${o.name}=${o.value}`).join('|'))).map(v => v.id));
        } catch { /* nicht lesbar */ }
      }
      creates.forEach(i => results.push({ itemId: i.id, ok: false, error: errMsg(e) }));
    }
  }
  return { results, undo };
}

// ---- Stapelverarbeitung: eine Regel für alle Produkte eines Filters ----
export const BULK_MAX = 10_000;
const SAMPLE = 50;
export interface PriceRule { percent?: number; add?: number; set?: number; round?: string }
export interface BulkChange { price?: PriceRule; listPrice?: PriceRule | null | 'currentPrice'; active?: boolean; status?: string; tags?: { add?: string[]; remove?: string[] } }
export interface BulkPlan {
  id: string; group: 'ok' | 'warn'; variants?: { id: string; price?: string; compareAtPrice?: string | null }[]; status?: string; tags?: string[];
  /** Werte beim Vorschlag: hat sich das Produkt bis zur Freigabe geändert, wird es nicht überschrieben */
  prev?: { status?: string; tags?: string[]; variants?: Record<string, { price?: string | null; compareAtPrice?: string | null }> };
}

export function validateBulk(c: BulkChange) {
  const keys = Object.keys(c ?? {}).filter(k => (c as Json)[k] !== undefined);
  if (!keys.length) throw new Error('change ist leer');
  const bad = keys.filter(k => !['price', 'listPrice', 'active', 'status', 'tags'].includes(k)); if (bad.length) throw new Error(`Nicht erlaubte Felder: ${bad.join(', ')} (Bestand ist auf Shopify nur lesbar)`);
  const rule = (r: unknown, label: string) => {
    const x = r as PriceRule; if (!x || typeof x !== 'object') throw new Error(`${label}: Regel {percent|add|set, round?} erwartet`);
    if ([x.percent, x.add, x.set].filter(v => v != null).length !== 1) throw new Error(`${label}: genau eine von percent, add oder set angeben`);
    if (x.percent != null && x.percent <= -100) throw new Error(`${label}: percent muss größer als −100 sein`);
    if (x.round != null && x.round !== 'none' && !/^\.\d{2}$/.test(x.round)) throw new Error(`${label}: round z. B. ".99", ".95", ".00" oder "none"`);
  };
  if (c.price !== undefined) rule(c.price, 'Preis');
  if (c.listPrice != null && c.listPrice !== 'currentPrice') rule(c.listPrice, 'Streichpreis');
  if (c.status !== undefined && !STATUS.includes(String(c.status).toUpperCase() as typeof STATUS[number])) throw new Error('status: ACTIVE, DRAFT oder ARCHIVED');
  if (c.active !== undefined && c.status !== undefined) throw new Error('active und status nicht gleichzeitig');
}
export function describeBulk(c: BulkChange, currency: string): string {
  const r = (x: PriceRule) => (x.set != null ? `= ${fmtMoney(x.set, currency)}` : x.percent != null ? `${x.percent > 0 ? '+' : '−'}${Math.abs(x.percent)} %` : `${(x.add ?? 0) > 0 ? '+' : '−'}${fmtMoney(Math.abs(x.add ?? 0), currency)}`) + (x.round && x.round !== 'none' ? `, gerundet auf ${x.round}` : '');
  const out: string[] = [];
  if (c.price) out.push(`Preis ${r(c.price)}`);
  if (c.listPrice !== undefined) out.push(`Streichpreis ${c.listPrice === null ? 'entfernen' : c.listPrice === 'currentPrice' ? '= bisheriger Preis' : r(c.listPrice)}`);
  if (c.active !== undefined) out.push(c.active ? 'aktivieren' : 'deaktivieren (Entwurf)');
  if (c.status) out.push(`Status ${STATUS_DE[c.status.toUpperCase()]}`);
  if (c.tags?.add?.length) out.push(`Tags + ${c.tags.add.join(', ')}`);
  if (c.tags?.remove?.length) out.push(`Tags − ${c.tags.remove.join(', ')}`);
  return out.join(' · ');
}

/** Plan je Produkt (rein, testbar) */
export function planBulk(p: Json, c: BulkChange, currency: string): { plan: BulkPlan | null; before: string[]; after: string[]; warn: string[]; skip?: string; old?: number; neu?: number } {
  const plan: BulkPlan = { id: shortId(p.id), group: 'ok' }, prev: NonNullable<BulkPlan['prev']> = {}, before: string[] = [], after: string[] = [], warn = new Set<string>();
  const vs: Json[] = p.variants?.nodes ?? [];
  try {
    if (c.price || c.listPrice !== undefined) {
      const out: NonNullable<BulkPlan['variants']> = [], olds: number[] = [], news: number[] = [], lb: (number | null)[] = [], la: (number | null)[] = [];
      for (const v of vs) {
        const cur = toNum(v.price), list = toNum(v.compareAtPrice); if (cur == null) throw new Error('kein Preis vorhanden');
        const price = c.price ? resolvePrice(cur, c.price)! : cur;
        if (!(price >= 0)) throw new Error(`Preis würde negativ (${fmtMoney(price, currency)})`);
        let nl: number | null | undefined;
        if (c.listPrice === null) nl = null; else if (c.listPrice === 'currentPrice') nl = cur; else if (c.listPrice) nl = list == null && c.listPrice.set == null ? undefined : resolvePrice(list, c.listPrice);
        const row: { id: string; price?: string; compareAtPrice?: string | null } = { id: v.id }, was: { price?: string | null; compareAtPrice?: string | null } = {};
        if (price !== cur) { row.price = money(price, currency); was.price = moneyRaw(v.price); olds.push(cur); news.push(price); if (price < 0.01) warn.add('Preis unter 0,01'); if (cur > 0 && Math.abs((price - cur) / cur) >= 0.3) warn.add('Preisänderung ≥ 30 %'); }
        if (nl !== undefined && nl !== list) { row.compareAtPrice = nl === null ? null : money(nl, currency); was.compareAtPrice = moneyRaw(v.compareAtPrice); lb.push(list); la.push(nl); if (nl != null && nl <= price) warn.add('Streichpreis ≤ Preis'); }
        if (row.price !== undefined || row.compareAtPrice !== undefined) { out.push(row); (prev.variants ??= {})[v.id] = was; }
      }
      if (out.length) {
        plan.variants = out;
        // Anzahl der geänderten Varianten mit anzeigen (sonst wirkt ein Produkt mit 4 Varianten wie eine einzelne Preisänderung)
        if (news.length) { before.push(`Preis ${priceRange(olds, currency)}`); after.push(`Preis ${priceRange(news, currency)}`); }
        if (la.length) { before.push(`Streichpreis ${priceRange(lb, currency)}`); after.push(la.every(x => x === null) ? 'Streichpreis entfernt' : `Streichpreis ${priceRange(la, currency)}`); }
      }
      if (olds.length) return finish({ old: olds[0], neu: news[0] });
    }
    return finish({});
  } catch (e) { return { plan: null, before, after, warn: [...warn], skip: errMsg(e) }; }

  function finish(x: { old?: number; neu?: number }) {
    const status = c.status ? c.status.toUpperCase() : c.active !== undefined ? (c.active ? 'ACTIVE' : 'DRAFT') : undefined;
    if (status && status !== p.status) { plan.status = status; prev.status = p.status; before.push(STATUS_DE[p.status] ?? p.status); after.push(STATUS_DE[status]); }
    if (c.tags) { const cur: string[] = p.tags ?? [], n = tagsAfter(cur, c.tags); if (!sameList([...cur].sort(), [...n].sort())) { plan.tags = n; prev.tags = cur; before.push(`Tags ${cur.join(', ') || '–'}`); after.push(`Tags ${n.join(', ') || '–'}`); } }
    if (!plan.variants && !plan.status && !plan.tags) return { plan: null, before, after, warn: [...warn] };
    plan.prev = prev;
    plan.group = warn.size ? 'warn' : 'ok';
    return { plan, before, after, warn: [...warn], ...x };
  }
}

// Shopify rechnet die Kostengrenze (1000) nach der ANGEFRAGTEN Größe: 50 Produkte × (1 + 2 + 15 Varianten) + 2 = 902 je Seite;
// die wenigen Produkte mit mehr als 15 Varianten lädt allVariants nach
const BULK_SEL = 'id title status tags variants(first: 15) { nodes { id sku price compareAtPrice } pageInfo { hasNextPage endCursor } }';
export const BULK_PAGE = 50;
/** alle Produkte eines Filters (seitenweise, mit allen Varianten) */
export async function scanProducts(q: Q, f: ProductFilter, cap = BULK_MAX, sel = BULK_SEL): Promise<Json[]> {
  const out: Json[] = [], query = productQuery(f); let after: string | null = null;
  for (;;) {
    const r = await searchProducts(q, query, { first: BULK_PAGE, after, sel, sortKey: 'ID' });
    for (const p of r.nodes) { if (p.variants?.pageInfo?.hasNextPage) p.variants.nodes = await allVariants(q, p); out.push(p); }
    if (out.length > cap) throw new Error(`Mehr als ${cap.toLocaleString('de-DE')} Produkte passen auf den Filter: bitte enger filtern (Kollektion, Hersteller, Produkttyp, Tag, Preis).`);
    if (!r.pageInfo.hasNextPage) return out;
    after = r.pageInfo.endCursor;
  }
}

export function bulkChangeSet(title: string, reason: string, c: BulkChange, rows: Json[], currency: string): { cs: ChangeSet; payload: { plans: BulkPlan[] } } {
  const planned = rows.map(p => ({ p, r: planBulk(p, c, currency) }));
  const todo = planned.filter(x => x.r.plan), skippedRows = planned.filter(x => x.r.skip);
  if (todo.length > BULK_MAX) throw new Error(`${todo.length} Produkte: maximal ${BULK_MAX} pro Änderungsset.`);
  const skipped = skippedRows.slice(0, 100).map(x => ({ id: shortId(x.p.id), reason: `${x.p.title}: ${x.r.skip}` }));
  const unchanged = planned.length - todo.length - skippedRows.length;
  if (!todo.length) throw new Error(`Keine Änderung nötig bzw. nichts anwendbar (${planned.length} passende Produkte, ${unchanged} unverändert, ${skippedRows.length} übersprungen)`);
  const rule = describeBulk(c, currency), items: ChangeItem[] = [];
  const counts = (xs: string[]) => Object.entries(xs.reduce<Record<string, number>>((m, v) => ({ ...m, [v]: (m[v] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([v, n]) => `${n}× ${v}`).join(', ');
  for (const g of ['ok', 'warn'] as const) {
    const xs = todo.filter(x => x.r.plan!.group === g); if (!xs.length) continue;
    const warn = g === 'warn' ? Object.entries(xs.flatMap(x => x.r.warn).reduce<Record<string, number>>((m, w) => ({ ...m, [w]: (m[w] ?? 0) + 1 }), {})).map(([w, n]) => `${n}× ${w}`) : [];
    items.push({ id: `grp:${g}`, entity: 'product', label: `${xs.length.toLocaleString('de-DE')} ${xs.length === 1 ? 'Produkt' : 'Produkte'} ${g === 'ok' ? 'ohne Auffälligkeiten' : 'mit Warnungen'}`, field: 'bulk', fieldLabel: rule, before: counts(xs.map(x => x.r.before.join(' · '))), after: counts(xs.map(x => x.r.after.join(' · '))), afterRaw: { count: xs.length }, warn });
  }
  const sample: ChangeItem[] = [...todo.slice(0, SAMPLE), ...todo.slice(SAMPLE).filter(x => x.r.warn.length).slice(0, 10)].map(({ p, r }) => ({ id: shortId(p.id), entity: 'info', entityId: shortId(p.id), label: p.title, fieldLabel: rule, before: r.before.join(' · '), after: r.after.join(' · '), warn: r.warn }));
  const cs: ChangeSet = { id: newId(), kind: 'bulk-products', entity: 'product', noun: { one: 'Produkt', many: 'Produkte' }, title, reason, items, sample, total: todo.length, skipped, unchanged, atomic: false, applyLabel: `${todo.length.toLocaleString('de-DE')} ${todo.length === 1 ? 'Produkt' : 'Produkte'} ändern` };
  return { cs, payload: { plans: todo.map(x => x.r.plan!) } };
}

/** Was hat sich seit dem Vorschlag geändert? null = nichts (rein, testbar) */
export function bulkStale(plan: BulkPlan, p: Json, vById: Map<string, Json>): string | null {
  const pv = plan.prev; if (!pv) return null;
  if (pv.status !== undefined && pv.status !== p.status) return 'Status';
  if (pv.tags && !sameList([...pv.tags].sort(), [...(p.tags ?? [])].sort())) return 'Tags';
  for (const [id, was] of Object.entries(pv.variants ?? {})) {
    const v = vById.get(id); if (!v) return 'Varianten';
    if (was.price !== undefined && toNum(was.price) !== toNum(v.price)) return 'Preis';
    if (was.compareAtPrice !== undefined && toNum(was.compareAtPrice) !== toNum(v.compareAtPrice)) return 'Streichpreis';
  }
  return null;
}

export async function applyBulk(client: ShopifyClient, cs: ChangeSet, payload: { plans: BulkPlan[] }, selected: Set<string>, ctx?: ApplyCtx): Promise<ApplyResult> {
  const plans = payload.plans.filter(p => selected.has(`grp:${p.group}`)), all: ApplyResult['results'] = [], undo: UndoOp[] = [];
  const chunks = Array.from({ length: Math.ceil(plans.length / 25) }, (_, i) => plans.slice(i * 25, (i + 1) * 25));
  let done = 0; ctx?.progress?.(0, plans.length);
  const q: Q = (d, v) => client.gql(d, v);
  await pool(chunks, WRITE_CONCURRENCY, async list => {
    let cur: Map<string, Json>;
    try { cur = new Map((await productsByIds(q, list.map(p => p.id), BULK_SEL, 25)).map(p => [shortId(p.id), p])); }
    catch (e) { list.forEach(p => all.push({ itemId: p.id, ok: false, error: errMsg(e) })); done += list.length; ctx?.progress?.(done, plans.length, { results: all, undo }); return; }
    for (const plan of list) {
      try {
        const p = cur.get(plan.id); if (!p) throw new Error('Produkt nicht mehr vorhanden');
        if (p.variants?.pageInfo?.hasNextPage) p.variants.nodes = await allVariants(q, p);
        const gid = p.id, vById = new Map<string, Json>(p.variants.nodes.map((v: Json) => [v.id, v]));
        const stale = bulkStale(plan, p, vById); if (stale) throw new Error(`Seit dem Vorschlag im Shop geändert (${stale}), nicht überschrieben: bitte neu vorschlagen`);
        if (plan.status || plan.tags) {
          await runRecording(client, M.productUpdate, { product: { id: gid, ...(plan.status ? { status: plan.status } : {}), ...(plan.tags ? { tags: plan.tags } : {}) } }, undo,
            reqOp('product', gid, M.productUpdate, { product: { id: gid, ...(plan.status ? { status: p.status } : {}), ...(plan.tags ? { tags: p.tags } : {}) } }));
        }
        if (plan.variants?.length) {
          const back = plan.variants.map(v => { const o = vById.get(v.id); if (!o) throw new Error('Variante nicht mehr vorhanden'); return { id: v.id, ...(v.price !== undefined ? { price: moneyRaw(o.price) } : {}), ...(v.compareAtPrice !== undefined ? { compareAtPrice: moneyRaw(o.compareAtPrice) } : {}) }; });
          await runRecording(client, M.variantsUpdate, { productId: gid, variants: plan.variants }, undo, reqOp('variants', gid, M.variantsUpdate, { productId: gid, variants: back }));
        }
        all.push({ itemId: plan.id, ok: true });
      } catch (e) { all.push({ itemId: plan.id, ok: false, error: errMsg(e) }); }
      ctx?.progress?.(++done, plans.length, { results: all, undo });
    }
  });
  // Ergebnis klein halten: je Gruppe eine Zeile + Stichprobe + höchstens 100 Fehler
  const bad = new Map(all.filter(r => !r.ok).map(r => [r.itemId, r])), sample = new Set((cs.sample ?? []).map(i => i.id)), results: ApplyResult['results'] = [];
  for (const g of ['ok', 'warn'] as const) {
    const ids = plans.filter(p => p.group === g).map(p => p.id); if (!ids.length) continue;
    const f = ids.filter(id => bad.has(id)).length;
    results.push({ itemId: `grp:${g}`, ok: !f, ...(f ? { error: `${f} von ${ids.length} fehlgeschlagen` } : {}) });
  }
  results.push(...all.filter(r => sample.has(r.itemId)), ...[...bad.values()].filter(r => !sample.has(r.itemId)).slice(0, 100));
  return { results, undo, counts: { applied: all.length - bad.size, failed: bad.size } };
}
