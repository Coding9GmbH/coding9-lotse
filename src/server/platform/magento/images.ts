import 'server-only';
// Magento: product images (gallery: add, hide, sort, cover image), alt texts (gallery label) and new products.
// Gallery roles (image/small_image/thumbnail/swatch_image) are product attributes holding the file path; undo restores them exactly.
// "Remove" hides an image (disabled = "Hide from Product Page") instead of deleting the file, so undo is exact.
import type { ChangeAsset, ChangeItem, ChangeSet, UndoOp } from '@/lib/protocol';
import { downloadImage, readStaged, stagedMeta } from '../../media';
import { applyEach, errMsg, MAX_ITEMS, newIdSafe, partialTicker, pool, WRITE_CONCURRENCY, type ApplyResult } from './kit';
import { skuPath, type MagentoClient } from './client';
import { attrStr, basisWord, coverEntry, IMAGE_ROLES, COVER_TYPES, mediaId, money, needBasis, parseMediaId, plain, sameValue, urlKey, type MGalleryEntry, type MProduct, type MRecord } from './map';
import type { MagentoReader } from './reader';
import { productLabel, stockSource } from './catalog';
import { getEnt, mainStoreCode, reg, reqOp } from './write';

export const ALT_MAX = 125;
const IMG_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const fileName = (e: MGalleryEntry) => String(e.file ?? '').split('/').pop() || `Bild ${e.id}`;

/** Image content for the REST gallery (base64): staged (staged:…), Magento media (mg-…) or https URL */
async function imageContent(c: MagentoClient, ref: string, name: string): Promise<{ base64_encoded_data: string; type: string; name: string }> {
  let buf: Buffer, mime: string, base = urlKey(name) || 'bild';
  if (ref.startsWith('staged:')) {
    const m = readStaged(ref.slice(7)); if (!m) throw new Error(`Vorgemerktes Bild ${ref} nicht gefunden`);
    ({ buf, mime } = m); if (stagedMeta(ref.slice(7))?.ai) base = `ki-generiert-${base}`;
  } else if (parseMediaId(ref)) {
    const { productId, entryId } = parseMediaId(ref)!;
    const r = await c.search('/V1/products', { filters: [[{ field: 'entity_id', value: productId }]], pageSize: 1 }, { store: 'all' });
    const e = (r.items[0]?.media_gallery_entries as MGalleryEntry[] | undefined)?.find(x => x.id === entryId);
    if (!e?.file) throw new Error(`Medium ${ref} nicht gefunden`);
    const res = await c.storefrontFetch(`${c.base}/media/catalog/product${e.file}`);
    if (!res.ok) throw new Error(`Medium ${ref} nicht ladbar (HTTP ${res.status})`);
    buf = Buffer.from(await res.arrayBuffer()); mime = (res.headers.get('content-type') ?? '').split(';')[0] || 'image/jpeg';
    base = String(e.file).split('/').pop()!.replace(/\.[a-z0-9]+$/i, '');
  } else if (/^https:\/\//.test(ref)) ({ buf, mime } = await downloadImage(ref));
  else throw new Error(`Unbekannte Bildquelle ${ref}`);
  if (!IMG_MIME.has(mime)) throw new Error(`Bildtyp ${mime} wird von der Magento-Galerie nicht unterstützt (JPG, PNG, GIF, WebP)`);
  return { base64_encoded_data: buf.toString('base64'), type: mime, name: `${base}.${mime.split('/')[1].replace('jpeg', 'jpg')}` };
}
/** Checks an image source while building (without loading it) and returns a preview URL */
async function imagePreview(ro: MagentoReader, ref: string): Promise<string> {
  if (ref.startsWith('staged:')) { const m = stagedMeta(ref.slice(7)); if (!m) throw new Error(`Vorgemerktes Bild ${ref} nicht gefunden`); return `/staged/${m.file}`; }
  const mid = parseMediaId(ref);
  if (mid) { const [p] = await ro.productsByIds([mid.productId], 'all'); const e = p?.media_gallery_entries?.find(x => x.id === mid.entryId); if (!e) throw new Error(`Medium ${ref} nicht gefunden`); return (await ro.mediaUrl(e.file)) ?? ''; }
  if (/^https:\/\//.test(ref)) return ref;
  throw new Error(`Bildquelle ${ref}: mediaId (mg-…), staged:… oder https-URL erwartet`);
}

// ================= Product images =================
export interface ImagesArgs { title: string; reason: string; products: { productId: string; add?: { image: string; position?: number; cover?: boolean; alt?: string }[]; remove?: string[]; order?: string[]; cover?: string }[] }
/** Plan per product: target state of the existing entries + new images; cover = entry ID or "new:<index>" */
export interface ImagesPlan { sku: string; adds: { ref: string; label: string; position: number }[]; entries: { id: number; position: number; disabled: boolean }[]; cover: string | null }

export async function buildProductImagesChangeSet(ro: MagentoReader, a: ImagesArgs): Promise<{ cs: ChangeSet; payload: { plans: Record<string, ImagesPlan>; store: string } }> {
  if (!a.products?.length) throw new Error('products ist leer');
  if (a.products.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} Produkte pro Änderungsset.`);
  const items: ChangeItem[] = [], assets: ChangeAsset[] = [], skipped: { id: string; reason: string }[] = [], plans: Record<string, ImagesPlan> = {};
  for (const x of a.products) {
    try {
      const p = await ro.productByRef(String(x.productId), 'all');
      if (!p) throw new Error('Produkt nicht gefunden');
      const id = String(p.id), entries = [...(p.media_gallery_entries ?? [])].sort((m, n) => (m.position ?? 0) - (n.position ?? 0));
      const find = (ref: string) => { const mid = parseMediaId(ref); const eid = mid && mid.productId === id ? mid.entryId : /^\d+$/.test(ref) ? Number(ref) : null; return entries.find(e => e.id === eid) ?? null; };
      const hide = new Set<number>();
      for (const r of x.remove ?? []) { const e = find(r); if (!e) throw new Error(`Bild ${r} gehört nicht zu diesem Produkt`); hide.add(e.id); }
      // Order: visible images in current order, new images at their position or at the end
      type Slot = { kind: 'old'; e: MGalleryEntry } | { kind: 'new'; i: number };
      const slots: Slot[] = entries.filter(e => !e.disabled && !hide.has(e.id)).map(e => ({ kind: 'old', e }));
      const adds: ImagesPlan['adds'] = [];
      for (const [i, ad] of (x.add ?? []).entries()) {
        const url = await imagePreview(ro, ad.image);
        const label = plain(ad.alt ?? (ad.image.startsWith('staged:') ? stagedMeta(ad.image.slice(7))?.alt : '') ?? '').slice(0, ALT_MAX) || String(p.name ?? '');
        adds.push({ ref: ad.image, label, position: 0 });
        const at = ad.position != null ? Math.max(0, Math.min(ad.position, slots.length)) : slots.length;
        slots.splice(at, 0, { kind: 'new', i });
        assets.push({ name: String(p.name ?? p.sku), url, alt: label, note: ad.cover ? 'neues Titelbild' : 'neues Bild' });
      }
      if (x.order?.length) {
        const key = (s: Slot) => (s.kind === 'old' ? s.e.id : `new:${s.i}`);
        const want = x.order.map(r => { const e = find(r); if (e) return e.id; const ni = (x.add ?? []).findIndex(ad => ad.image === r); if (ni >= 0) return `new:${ni}`; throw new Error(`order: Bild ${r} unbekannt`); });
        slots.sort((s, t) => { const i = want.indexOf(key(s)), j = want.indexOf(key(t)); return (i < 0 ? 1e6 : i) - (j < 0 ? 1e6 : j); });
      }
      const coverAdd = (x.add ?? []).findIndex(ad => ad.cover);
      let cover: string | null = null;
      if (x.cover) { const e = find(x.cover); const ni = (x.add ?? []).findIndex(ad => ad.image === x.cover); if (e) { if (hide.has(e.id)) throw new Error('Ein ausgeblendetes Bild kann nicht Titelbild sein'); cover = String(e.id); } else if (ni >= 0) cover = `new:${ni}`; else throw new Error(`cover: Bild ${x.cover} unbekannt`); }
      else if (coverAdd >= 0) cover = `new:${coverAdd}`;
      const curCover = coverEntry(p);
      if (!cover && curCover && hide.has(curCover.id)) { const first = slots[0]; cover = first ? (first.kind === 'old' ? String(first.e.id) : `new:${first.i}`) : null; }
      if (!cover && !curCover && slots.length) { const first = slots[0]; cover = first.kind === 'old' ? String(first.e.id) : `new:${first.i}`; }
      if (cover && curCover && cover === String(curCover.id)) cover = null;
      // Positions 1..n for visible ones, hidden ones after them
      const planEntries: ImagesPlan['entries'] = [];
      slots.forEach((s, k) => { if (s.kind === 'old') planEntries.push({ id: s.e.id, position: k + 1, disabled: false }); else adds[s.i].position = k + 1; });
      entries.filter(e => e.disabled || hide.has(e.id)).forEach((e, k) => planEntries.push({ id: e.id, position: slots.length + k + 1, disabled: true }));
      const changed = planEntries.filter(pe => { const e = entries.find(z => z.id === pe.id)!; return (e.position ?? 0) !== pe.position || !!e.disabled !== pe.disabled; });
      if (!adds.length && !changed.length && !cover) { skipped.push({ id, reason: 'keine Änderung' }); continue; }
      plans[id] = { sku: p.sku, adds, entries: changed, cover };
      const show = (list: string[]) => list.length ? list.join(' · ') : 'keine Bilder';
      const nameOf = (s: Slot) => (s.kind === 'old' ? fileName(s.e) : `neu: ${adds[s.i].label || adds[s.i].ref}`);
      const coverName = cover ? (cover.startsWith('new:') ? `neu: ${adds[Number(cover.slice(4))].label}` : fileName(entries.find(e => String(e.id) === cover)!)) : curCover ? fileName(curCover) : '–';
      const warn: string[] = [];
      if (hide.size) warn.push(`${hide.size} ${hide.size === 1 ? 'Bild wird' : 'Bilder werden'} ausgeblendet (bleiben in Magento gespeichert)`);
      if (cover && curCover) warn.push('Titelbild wird getauscht');
      items.push({ id: `${id}:images`, entity: 'product', entityId: id, label: productLabel(p), field: 'images', fieldLabel: 'Bilder',
        before: `${show(entries.filter(e => !e.disabled).map(fileName))} (Titelbild: ${curCover ? fileName(curCover) : '–'})`,
        after: `${show(slots.map(nameOf))} (Titelbild: ${coverName})`, afterRaw: id, warn });
    } catch (e) { skipped.push({ id: String(x.productId), reason: errMsg(e) }); }
  }
  if (!items.length) throw new Error(`Nichts anwendbar: ${skipped.map(s => `${s.id}: ${s.reason}`).slice(0, 5).join('; ')}`);
  return { cs: { id: newIdSafe(), kind: 'product-media', entity: 'product', noun: { one: 'Produkt', many: 'Produkte' }, title: a.title, reason: a.reason, items, assets, skipped, atomic: false }, payload: { plans, store: ro.storeCode } };
}

const entryBody = (e: MGalleryEntry, over: Partial<MGalleryEntry> = {}) => ({ entry: { id: e.id, media_type: e.media_type ?? 'image', label: e.label ?? null, position: e.position ?? 0, disabled: !!e.disabled, types: e.types ?? [], file: e.file, ...over } });
const rolesOf = (p: MRecord) => Object.fromEntries(IMAGE_ROLES.map(r => [r, attrStr(p, r) ?? 'no_selection']));
const roleBody = (sku: string, roles: Record<string, unknown>) => ({ product: { sku, custom_attributes: Object.entries(roles).map(([attribute_code, value]) => ({ attribute_code, value })) } });
const ROLE_LABELS = ['image_label', 'small_image_label', 'thumbnail_label'] as const;

/**
 * Store view with its own gallery values (saved in the admin in the view: label/position/disabled per store): the global change
 * doesn't reach it. So apply and verify position, visibility and cover image roles of the planned entries in the view as well.
 * A gallery PUT in the view writes all gallery values and roles as values of the view (Magento has no "Use Default
 * Value" for this via REST); undo: previous values of the entries, roles of the view or null = inherited again (same as global).
 */
async function fixStoreView(c: MagentoClient, plan: ImagesPlan, store: string, coverId: number | null): Promise<UndoOp[]> {
  if (store === 'all') return [];
  const [view, glob] = await Promise.all([getEnt(c, 'product', plan.sku, store), getEnt(c, 'product', plan.sku, 'all')]) as (MProduct | null)[];
  if (!view || !glob) throw new Error('Produkt nicht mehr vorhanden');
  const entries = view.media_gallery_entries ?? [], fixes: { e: MGalleryEntry; over: Partial<MGalleryEntry> }[] = [];
  const withCover = (e: MGalleryEntry) => [...new Set([...(e.types ?? []), ...COVER_TYPES])];
  for (const pe of plan.entries) {
    const e = entries.find(x => x.id === pe.id); if (!e) continue;
    const isCover = e.id === coverId;
    if ((e.position ?? 0) !== pe.position || !!e.disabled !== pe.disabled || (isCover && !e.types?.includes('image'))) fixes.push({ e, over: { position: pe.position, disabled: pe.disabled, types: pe.disabled ? [] : isCover ? withCover(e) : e.types ?? [] } });
  }
  if (coverId != null && !plan.entries.some(pe => pe.id === coverId)) { const e = entries.find(x => x.id === coverId); if (e && !e.types?.includes('image')) fixes.push({ e, over: { types: withCover(e) } }); }
  if (!fixes.length) return [];
  // Roles plus the image titles derived from them (image_label …) that Magento resets per store on gallery save (verified live)
  const roles = Object.fromEntries([...IMAGE_ROLES, ...ROLE_LABELS].map(r => { const v = attrStr(view, r), g = attrStr(glob, r); return [r, sameValue(v, g) ? null : v]; }));
  const path = `/${store}/V1/products/${skuPath(plan.sku)}`, undo: UndoOp[] = [reqOp('product', plan.sku, 'PUT', path, roleBody(plan.sku, roles))];
  for (const { e, over } of fixes) {
    await c.req('PUT', `/V1/products/${skuPath(plan.sku)}/media/${e.id}`, entryBody(e, over), { store });
    undo.push(reqOp('product-media', plan.sku, 'PUT', `${path}/media/${e.id}`, entryBody(e)));
  }
  const after = (await getEnt(c, 'product', plan.sku, store) as MProduct | null)?.media_gallery_entries ?? [];
  for (const pe of plan.entries) { const v = after.find(x => x.id === pe.id); if (v && (!!v.disabled !== pe.disabled || (v.position ?? 0) !== pe.position)) throw Object.assign(new Error(`Bild ${pe.id} ist in der Store-View „${store}“ weiter ${v.disabled ? 'ausgeblendet' : 'sichtbar'} bzw. anders sortiert`), { undo }); }
  if (coverId != null && coverEntry({ media_gallery_entries: after } as MProduct)?.id !== coverId) throw Object.assign(new Error(`Titelbild wird in der Store-View „${store}“ nicht übernommen`), { undo });
  return undo;
}

export async function applyImages(c: MagentoClient, plan: ImagesPlan, store = c.storeCode): Promise<UndoOp[]> {
  const cur = await getEnt(c, 'product', plan.sku, 'all') as MProduct | null;
  if (!cur) throw new Error('Produkt nicht mehr vorhanden');
  const entries = cur.media_gallery_entries ?? [], base = `/all/V1/products/${skuPath(plan.sku)}/media`;
  const deletes: UndoOp[] = [], restores: UndoOp[] = [], viewUndo: UndoOp[] = [], newIds: number[] = [];
  const roleRestore = reqOp('product', plan.sku, 'PUT', `/all/V1/products/${skuPath(plan.sku)}`, roleBody(plan.sku, rolesOf(cur)));
  try {
    for (const [i, ad] of plan.adds.entries()) {
      const content = await imageContent(c, ad.ref, ad.label || cur.name || plan.sku);
      const isCover = plan.cover === `new:${i}`;
      const nid = await c.req('POST', `/V1/products/${skuPath(plan.sku)}/media`, { entry: { media_type: 'image', label: ad.label || null, position: ad.position, disabled: false, types: isCover ? [...COVER_TYPES] : [], content } }, { store: 'all' });
      deletes.push(reqOp('product-media', plan.sku, 'DELETE', `${base}/${Number(nid)}`)); newIds.push(Number(nid));
    }
    for (const pe of plan.entries) {
      const e = entries.find(x => x.id === pe.id); if (!e) throw new Error(`Bild ${pe.id} nicht mehr vorhanden`);
      await c.req('PUT', `/V1/products/${skuPath(plan.sku)}/media/${e.id}`, entryBody(e, { position: pe.position, disabled: pe.disabled, types: pe.disabled ? [] : e.types ?? [] }), { store: 'all' });
      restores.push(reqOp('product-media', plan.sku, 'PUT', `${base}/${e.id}`, entryBody(e)));
    }
    if (plan.cover && !plan.cover.startsWith('new:')) {
      const e = entries.find(x => String(x.id) === plan.cover); if (!e) throw new Error('Titelbild nicht mehr vorhanden');
      const pe = plan.entries.find(x => x.id === e.id);
      await c.req('PUT', `/V1/products/${skuPath(plan.sku)}/media/${e.id}`, entryBody(e, { ...(pe ? { position: pe.position } : {}), types: [...new Set([...(e.types ?? []), ...COVER_TYPES])] }), { store: 'all' });
      if (!pe) restores.push(reqOp('product-media', plan.sku, 'PUT', `${base}/${e.id}`, entryBody(e)));
    }
    const coverId = plan.cover ? (plan.cover.startsWith('new:') ? newIds[Number(plan.cover.slice(4))] ?? null : Number(plan.cover)) : null;
    viewUndo.push(...await fixStoreView(c, plan, store, coverId));
  } catch (err) {
    // Partially written: still return undo steps so nothing is orphaned
    throw Object.assign(new Error(errMsg(err)), { undo: [...deletes, roleRestore, ...restores, ...viewUndo, ...((err as { undo?: UndoOp[] }).undo ?? [])] });
  }
  // Executed in reverse: restore store view → reset entries → restore roles exactly → delete new entries
  return [...deletes, roleRestore, ...restores, ...viewUndo];
}
reg.register('product-media', async (c, cs, payload, selected, ctx) => {
  const { plans, store } = payload as { plans: Record<string, ImagesPlan>; store?: string }, results: ApplyResult['results'] = [], undo: UndoOp[] = [];
  const list = cs.items.filter(i => selected.has(i.id) && i.entity !== 'info'), tick = partialTicker(ctx, list.length, { results, undo });
  await pool(list, WRITE_CONCURRENCY, async it => {
    try { undo.push(...await applyImages(c, plans[it.entityId!], store ?? c.storeCode)); results.push({ itemId: it.id, ok: true }); }
    catch (e) { undo.push(...((e as { undo?: UndoOp[] }).undo ?? [])); results.push({ itemId: it.id, ok: false, error: errMsg(e) }); }
    finally { tick(); }
  });
  return { results, undo };
});

// ================= Alt texts (gallery label) =================
export interface AltArgs { title: string; reason: string; images: { mediaId: string; alt: string }[] }
export async function buildAltTextChangeSet(ro: MagentoReader, a: AltArgs, viewed: Set<string>): Promise<{ cs: ChangeSet; payload: { skus: Record<string, string>; store: string } }> {
  if (!a.images?.length) throw new Error('images ist leer');
  if (a.images.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} Bilder pro Änderungsset.`);
  const ids = [...new Set(a.images.map(i => parseMediaId(i.mediaId)?.productId).filter(Boolean) as string[])];
  const prods = new Map((await ro.productsByIds(ids)).map(p => [String(p.id), p]));
  const items: ChangeItem[] = [], assets: ChangeAsset[] = [], skipped: { id: string; reason: string }[] = [], skus: Record<string, string> = {};
  for (const im of a.images) {
    const mid = parseMediaId(im.mediaId), p = mid ? prods.get(mid.productId) : undefined, e = p?.media_gallery_entries?.find(x => x.id === mid!.entryId);
    if (!mid || !p || !e) { skipped.push({ id: im.mediaId, reason: 'Bild nicht gefunden (mediaId aus get_product_images verwenden)' }); continue; }
    const url = await ro.mediaUrl(e.file);
    const seen = viewed.has(im.mediaId) || (!!url && [...viewed].some(v => url.endsWith(v) || v.endsWith(String(e.file))));
    if (!seen) { skipped.push({ id: im.mediaId, reason: 'nicht mit view_image angesehen' }); continue; }
    const alt = plain(im.alt);
    if (!alt) { skipped.push({ id: im.mediaId, reason: 'Alt-Text leer' }); continue; }
    if (alt.length > ALT_MAX) { skipped.push({ id: im.mediaId, reason: `Alt-Text länger als ${ALT_MAX} Zeichen` }); continue; }
    if (sameValue(e.label, alt)) continue;
    skus[im.mediaId] = p.sku;
    items.push({ id: im.mediaId, entity: 'media', entityId: im.mediaId, label: `${productLabel(p)} · ${fileName(e)}`, field: 'alt', fieldLabel: 'Alt-Text', before: plain(e.label) || '–', after: alt, afterRaw: alt, warn: /^(bild|foto|image) (von|of)\b/i.test(alt) ? ['Beginnt mit „Bild von“'] : [] });
    if (url) assets.push({ name: fileName(e), url, alt, note: productLabel(p) });
  }
  if (!items.length) throw new Error(`Keine Änderung nötig bzw. nichts anwendbar: ${skipped.map(s => `${s.id}: ${s.reason}`).slice(0, 5).join('; ') || 'Alt-Texte schon gesetzt'}`);
  return { cs: { id: newIdSafe(), kind: 'media-alt', entity: 'media', noun: { one: 'Bild', many: 'Bilder' }, title: a.title, reason: a.reason, items, assets, skipped, atomic: false }, payload: { skus, store: ro.storeCode } };
}
reg.register('media-alt', async (c, cs, payload, selected, ctx) => {
  const { skus, store = c.storeCode } = payload as { skus: Record<string, string>; store?: string }, main = await mainStoreCode(c);
  return applyEach(cs, selected, async it => {
    const sku = skus[it.id], { entryId } = parseMediaId(it.id)!;
    const [inView, glob] = await Promise.all([getEnt(c, 'product', sku, store), getEnt(c, 'product', sku, 'all')]) as (MProduct | null)[];
    const ev = inView?.media_gallery_entries?.find(x => x.id === entryId), eg = glob?.media_gallery_entries?.find(x => x.id === entryId);
    if (!ev || !eg) throw new Error('Bild nicht mehr vorhanden');
    // Store view has its own text → change it there; not the main store view (e.g. language view) → only there, never global (same rule as writeScoped)
    const scope = store !== 'all' && (store !== main || !sameValue(ev.label, eg.label)) ? store : 'all', e = scope === 'all' ? eg : ev;
    // A gallery save in the view also sets the derived image titles (image_label …) there as its own values: undo restores them (null = inherited again)
    const labels = scope === 'all' ? null : Object.fromEntries(ROLE_LABELS.map(r => { const v = attrStr(inView, r), g = attrStr(glob, r); return [r, sameValue(v, g) ? null : v]; }));
    await c.req('PUT', `/V1/products/${skuPath(sku)}/media/${entryId}`, entryBody(e, { label: String(it.afterRaw) }), { store: scope });
    // A view's gallery values have no "Use Default Value" via REST: undo writes the previous (possibly inherited) text as the view's value
    return [...(labels ? [reqOp('product', sku, 'PUT', `/${scope}/V1/products/${skuPath(sku)}`, roleBody(sku, labels))] : []), reqOp('product-media', sku, 'PUT', `/${scope}/V1/products/${skuPath(sku)}/media/${entryId}`, entryBody(e))];
  }, ctx);
});

// ================= New products =================
export interface NewProductInput { name: string; description: string; price: number; sku?: string; stock?: number; active?: boolean; shortDescription?: string; metaTitle?: string; metaDescription?: string; keywords?: string; weight?: number; categoryIds?: string[]; images?: string[]; taxClass?: string }
export interface NewProductPlan extends Omit<NewProductInput, 'taxClass'> { sku: string; urlKey: string; attributeSetId: number; websiteIds: number[]; taxClassId: string; images: string[]; categoryIds: string[]; stock: number; active: boolean; source: string | null; /** further attributes (import: special price, purchase price, manufacturer, properties) */ extra?: Record<string, unknown> }
const skuOf = (name: string) => `${name.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().split(/\s+/).slice(0, 3).map(w => w.slice(0, 4).toUpperCase()).join('-') || 'NEU'}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

export async function buildNewProductsChangeSet(ro: MagentoReader, { title, reason, products }: { title: string; reason: string; products: NewProductInput[] }): Promise<{ cs: ChangeSet; payload: null }> {
  if (!products?.length) throw new Error('products ist leer');
  if (products.length > 50) throw new Error('Maximal 50 neue Produkte pro Änderungsset, bitte aufteilen.');
  const [sets, websites, taxAttr, stock] = await Promise.all([ro.attributeSets(), ro.websites(), ro.attribute('tax_class_id'), stockSource(ro)]);
  const set = sets.items.find(s => s.attribute_set_name === 'Default' && Number(s.entity_type_id) === 4) ?? sets.items.find(s => Number(s.entity_type_id) === 4);
  if (!set) throw new Error('Kein Attributset für Produkte gefunden');
  const websiteIds = websites.map(w => Number(w.id)).filter(i => i > 0);
  const taxOpts = ((taxAttr?.options ?? []) as { label: string; value: string }[]).filter(o => o.value !== '' && o.value !== '0');
  const catIds = [...new Set(products.flatMap(p => p.categoryIds ?? []).map(String))];
  const cats = new Map<string, string>();
  for (const cid of catIds) { const c = await ro.category(cid); if (c) cats.set(cid, String(c.name)); }
  const wanted = products.map(p => p.sku?.trim()).filter(Boolean) as string[];
  const taken = new Set((await ro.productsBySkus(wanted)).map(p => p.sku));
  const items: ChangeItem[] = [], assets: ChangeAsset[] = [], skipped: { id: string; reason: string }[] = [], keys = new Set<string>();
  for (const [i, p] of products.entries()) {
    const key = `neu-${i + 1}`;
    try {
      const name = plain(p.name);
      if (!name || name.length > 255) throw new Error('Name fehlt oder ist länger als 255 Zeichen');
      if (typeof p.description !== 'string' || !plain(p.description)) throw new Error('Beschreibung fehlt');
      if (!(typeof p.price === 'number' && Number.isFinite(p.price) && p.price >= 0)) throw new Error('Preis fehlt oder ist ungültig. Bitte beim Nutzer erfragen, nicht schätzen');
      const basis = needBasis(ro.priceBasis);
      const sku = p.sku?.trim() || skuOf(name);
      if (taken.has(sku) || keys.has(sku)) throw new Error(`SKU ${sku} ist schon vergeben`);
      const unknown = (p.categoryIds ?? []).map(String).filter(c => !cats.has(c)); if (unknown.length) throw new Error(`Kategorie nicht gefunden: ${unknown.join(', ')}`);
      let uk = urlKey(name);
      if ((await ro.products({ filters: [[{ field: 'url_key', value: uk }]], pageSize: 1 })).items.length || keys.has(uk)) uk = urlKey(`${name}-${sku}`);
      const tax = p.taxClass ? taxOpts.find(o => o.label.toLowerCase() === p.taxClass!.toLowerCase() || o.value === p.taxClass) : taxOpts.find(o => o.value === '2') ?? taxOpts[0];
      if (!tax) throw new Error(`Steuerklasse ${p.taxClass ?? ''} nicht gefunden (vorhanden: ${taxOpts.map(o => o.label).join(', ')})`);
      const images: string[] = [];
      for (const ref of p.images ?? []) { try { const url = await imagePreview(ro, ref); images.push(ref); assets.push({ name, url, alt: name, note: images.length === 1 ? 'Titelbild' : 'weiteres Bild' }); } catch (e) { skipped.push({ id: key, reason: errMsg(e) }); } }
      const stockN = Number.isInteger(p.stock) && (p.stock as number) >= 0 ? (p.stock as number) : 0, active = p.active === true;
      const warn: string[] = [];
      if (!images.length) warn.push('Ohne Bild');
      if (p.price === 0) warn.push('Preis 0 €');
      if (active) warn.push('Wird sofort aktiv im Shop');
      if ('reason' in stock && stockN > 0) warn.push(`Bestand nicht gesetzt: ${stock.reason}`);
      keys.add(sku); keys.add(uk);
      const plan: NewProductPlan = { ...p, name, sku, urlKey: uk, attributeSetId: Number(set.attribute_set_id), websiteIds, taxClassId: tax.value, images, categoryIds: (p.categoryIds ?? []).map(String), stock: stockN, active, source: 'source' in stock ? stock.source : null };
      const where = plan.categoryIds.map(c => cats.get(c)).join(', ');
      items.push({ id: key, entity: 'product', label: `${name} (${sku})`, field: 'create', fieldLabel: 'Neues Produkt', before: '–',
        after: `${money(p.price)} ${basisWord(basis)} · ${active ? 'aktiv' : 'inaktiv (Entwurf)'} · Bestand ${stockN}${where ? ` · ${where}` : ''} · ${images.length} ${images.length === 1 ? 'Bild' : 'Bilder'}`,
        afterRaw: plan, html: { before: '', after: [`<h4>${name}</h4>`, p.description, p.metaTitle ? `<p><b>Meta-Title:</b> ${plain(p.metaTitle)}</p>` : '', p.metaDescription ? `<p><b>Meta-Description:</b> ${plain(p.metaDescription)}</p>` : ''].join('').slice(0, 6000) }, warn });
    } catch (e) { skipped.push({ id: key, reason: `${p?.name ?? key}: ${errMsg(e)}` }); }
  }
  if (!items.length) throw new Error(`Kein Produkt anlegbar: ${skipped.map(s => s.reason).join('; ')}`);
  return { cs: { id: newIdSafe(), kind: 'new-products', entity: 'product', title, reason, items, assets, skipped, atomic: false }, payload: null };
}

export async function createProduct(c: MagentoClient, p: NewProductPlan): Promise<UndoOp[]> {
  if (await getEnt(c, 'product', p.sku, 'all')) throw new Error(`SKU ${p.sku} ist schon vergeben`);
  const gallery = [];
  for (const [i, ref] of p.images.entries()) gallery.push({ media_type: 'image', label: p.name, position: i + 1, disabled: false, types: i === 0 ? [...COVER_TYPES] : [], content: await imageContent(c, ref, p.name) });
  const ca: Record<string, unknown> = { description: p.description, url_key: p.urlKey, tax_class_id: p.taxClassId, ...(p.shortDescription ? { short_description: p.shortDescription } : {}), ...(p.metaTitle ? { meta_title: p.metaTitle } : {}), ...(p.metaDescription ? { meta_description: p.metaDescription } : {}), ...(p.keywords ? { meta_keyword: p.keywords } : {}), ...(p.extra ?? {}) };
  const undo = [reqOp('product', p.sku, 'DELETE', `/all/V1/products/${skuPath(p.sku)}`)];
  try { await c.req('POST', '/V1/products', { product: {
    sku: p.sku, name: p.name, attribute_set_id: p.attributeSetId, price: p.price, status: p.active ? 1 : 2, visibility: 4, type_id: 'simple', ...(p.weight != null ? { weight: p.weight } : {}),
    extension_attributes: { website_ids: p.websiteIds, category_links: p.categoryIds.map((id, k) => ({ category_id: id, position: k })) },
    custom_attributes: Object.entries(ca).map(([attribute_code, value]) => ({ attribute_code, value })),
    ...(gallery.length ? { media_gallery_entries: gallery } : {}),
  } }, { store: 'all' });
  } catch (e) { throw Object.assign(e instanceof Error ? e : new Error(String(e)), { undo }); }
  if (p.source) {
    await c.req('POST', '/V1/inventory/source-items', { sourceItems: [{ sku: p.sku, source_code: p.source, quantity: p.stock, status: p.stock > 0 ? 1 : 0 }] }, { store: 'all' }).catch(e => { throw Object.assign(new Error(`Angelegt, aber Bestand nicht gesetzt: ${errMsg(e)}`), { undo }); });
    undo.unshift(sourceItemDelete(p.sku, p.source)); // MSI doesn't delete stock of deleted products by itself
  }
  return undo;
}
/** Undo: remove the stock (MSI) of a product that was deleted again */
export const sourceItemDelete = (sku: string, source: string) => reqOp('source-item', sku, 'POST', '/all/V1/inventory/source-items-delete', { sourceItems: [{ sku, source_code: source }] });
reg.register('new-products', async (c, cs, _payload, selected, ctx) => {
  const results: ApplyResult['results'] = [], undo: UndoOp[] = [], list = cs.items.filter(i => selected.has(i.id) && i.entity !== 'info'), tick = partialTicker(ctx, list.length, { results, undo });
  await pool(list, WRITE_CONCURRENCY, async it => {
    try { undo.push(...await createProduct(c, it.afterRaw as NewProductPlan)); results.push({ itemId: it.id, ok: true }); }
    catch (e) { undo.push(...((e as { undo?: UndoOp[] }).undo ?? [])); results.push({ itemId: it.id, ok: false, error: errMsg(e) }); }
    finally { tick(); }
  });
  return { results, undo };
});

/** Images of a product for tools (mediaId, URL, alt text, position, cover image, hidden) */
export async function imageRows(ro: MagentoReader, p: MProduct) {
  const cover = coverEntry(p);
  return Promise.all([...(p.media_gallery_entries ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map(async e => {
    const url = await ro.mediaUrl(e.file), label = plain(e.label);
    return { mediaId: mediaId(p.id, e.id), url, file: fileName(e), alt: label || null, position: e.position ?? 0, cover: e.id === cover?.id, roles: e.types ?? [], ...(e.disabled ? { hidden: true } : {}), ...(!label ? { altMissing: true } : {}), ...(/ki-generiert/i.test(String(e.file)) ? { aiGenerated: true } : {}) };
  }));
}
