import 'server-only';
// OpenMage: Produktbilder (Galerie: hinzufügen, ausblenden, sortieren, Titelbild), Alt-Texte (Bild-Label) und neue Produkte.
// Rollen (image/small_image/thumbnail) sind Store-scoped Produktattribute; PATCH …/images/{id} mit types setzt sie exakt.
// „Entfernen“ blendet ein Bild aus (disabled); Rückgängig blendet es wieder ein. Neue Bilder löscht Rückgängig (?mode=delete).
import type { ChangeAsset, ChangeItem, ChangeSet, UndoOp } from '@/lib/protocol';
import { downloadImage, readStaged, stagedMeta } from '../../media';
import { fetchShopPage } from '../../storefront';
import { applyEach, errMsg, MAX_ITEMS, newIdSafe, partialTicker, pool, WRITE_CONCURRENCY, type ApplyResult } from './kit';
import { isGlobal, skuPath, type OmClient } from './client';
import { basisWord, COVER_TYPES, coverImage, fileName, mediaId, money, omAttr, parseMediaId, plain, productLabel, same, stripTitleAffixes, urlKey, type OmImage, type OmProduct } from './map';
import type { OmReader } from './reader';
import { getProduct, reg, reqOp, storePath, writeStore } from './write';

export const ALT_MAX = 125;
const IMG_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Bild-Inhalt für POST …/images (base64): vorgemerkt (staged:…), Shop-Bild (om-…) oder https-URL (Lotse lädt, nicht der Shop-Server) */
export async function imageContent(c: OmClient, ref: string, name: string): Promise<{ base64: string; filename: string }> {
  let buf: Buffer, mime: string, base = urlKey(name) || 'bild';
  if (ref.startsWith('staged:')) {
    const m = readStaged(ref.slice(7)); if (!m) throw new Error(`Vorgemerktes Bild ${ref} nicht gefunden`);
    ({ buf, mime } = m); if (stagedMeta(ref.slice(7))?.ai) base = `ki-generiert-${base}`;
  } else if (parseMediaId(ref)) {
    const { productId, imageId } = parseMediaId(ref)!;
    const p = await c.req('GET', `/v1/products/id:${productId}`, undefined, { nullOn404: true }) as OmProduct | null;
    const e = p?.images?.find(x => x.id === imageId);
    if (!e?.url) throw new Error(`Medium ${ref} nicht gefunden`);
    const allowed = [c.publicUrl, c.base, e.url].filter(Boolean);
    const res = await fetchShopPage(e.url, allowed, { publicUrl: c.publicUrl, internalBase: c.base, fetchImpl: (href, init) => c.storefrontFetch(href, init) });
    if (!res.ok) throw new Error(`Medium ${ref} nicht ladbar (HTTP ${res.status})`);
    buf = Buffer.from(await res.arrayBuffer()); mime = (res.headers.get('content-type') ?? '').split(';')[0] || 'image/jpeg';
    base = fileName(e).replace(/\.[a-z0-9]+$/i, '');
  } else if (/^https:\/\//.test(ref)) ({ buf, mime } = await downloadImage(ref));
  else throw new Error(`Unbekannte Bildquelle ${ref}`);
  if (!IMG_MIME.has(mime)) throw new Error(`Bildtyp ${mime} wird von der OpenMage-Galerie nicht unterstützt (JPG, PNG, GIF, WebP)`);
  if (buf.length > 20 * 1024 * 1024) throw new Error('Bild größer als 20 MB');
  return { base64: buf.toString('base64'), filename: `${base}.${mime.split('/')[1].replace('jpeg', 'jpg')}` };
}
/** Prüft eine Bildquelle beim Bauen (ohne zu laden) und liefert eine Vorschau-URL */
export async function imagePreview(ro: OmReader, ref: string): Promise<string> {
  if (ref.startsWith('staged:')) { const m = stagedMeta(ref.slice(7)); if (!m) throw new Error(`Vorgemerktes Bild ${ref} nicht gefunden`); return `/staged/${m.file}`; }
  const mid = parseMediaId(ref);
  if (mid) { const p = await ro.productById(mid.productId, 'admin'); const e = p?.images?.find(x => x.id === mid.imageId); if (!e) throw new Error(`Medium ${ref} nicht gefunden`); return (await ro.mediaUrl(e.file)) ?? ''; }
  if (/^https:\/\//.test(ref)) return ref;
  throw new Error(`Bildquelle ${ref}: mediaId (om-…), staged:… oder https-URL erwartet`);
}

// ================= Produktbilder =================
export interface ImagesArgs { title: string; reason: string; products: { productId: string; add?: { image: string; position?: number; cover?: boolean; alt?: string }[]; remove?: string[]; order?: string[]; cover?: string }[] }
/** Plan je Produkt: Zielzustand der vorhandenen Einträge + neue Bilder; cover = Bild-ID oder „new:<index>“ */
export interface ImagesPlan { sku: string; adds: { ref: string; label: string; position: number }[]; entries: { id: number; position: number; disabled: boolean }[]; cover: string | null }

export async function buildProductImagesChangeSet(ro: OmReader, a: ImagesArgs): Promise<{ cs: ChangeSet; payload: { plans: Record<string, ImagesPlan>; store: string } }> {
  if (!a.products?.length) throw new Error('products ist leer');
  if (a.products.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} Produkte pro Änderungsset.`);
  const items: ChangeItem[] = [], assets: ChangeAsset[] = [], skipped: { id: string; reason: string }[] = [], plans: Record<string, ImagesPlan> = {};
  for (const x of a.products) {
    try {
      const p = await ro.productByRef(String(x.productId), 'admin');
      if (!p) throw new Error('Produkt nicht gefunden');
      const id = String(p.id), entries = [...(p.images ?? [])].sort((m, n) => (m.position ?? 0) - (n.position ?? 0));
      const find = (ref: string) => { const mid = parseMediaId(ref); const eid = mid && mid.productId === id ? mid.imageId : /^\d+$/.test(ref) ? Number(ref) : null; return entries.find(e => e.id === eid) ?? null; };
      const hide = new Set<number>();
      for (const r of x.remove ?? []) { const e = find(r); if (!e) throw new Error(`Bild ${r} gehört nicht zu diesem Produkt`); hide.add(e.id); }
      type Slot = { kind: 'old'; e: OmImage } | { kind: 'new'; i: number };
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
      const curCover = coverImage(p);
      if (!cover && curCover && hide.has(curCover.id)) { const first = slots[0]; cover = first ? (first.kind === 'old' ? String(first.e.id) : `new:${first.i}`) : null; }
      if (!cover && !curCover && slots.length) { const first = slots[0]; cover = first.kind === 'old' ? String(first.e.id) : `new:${first.i}`; }
      if (cover && curCover && cover === String(curCover.id)) cover = null;
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
      if (hide.size) warn.push(`${hide.size} ${hide.size === 1 ? 'Bild wird' : 'Bilder werden'} ausgeblendet (bleiben in OpenMage gespeichert)`);
      if (cover && curCover) warn.push('Titelbild wird getauscht');
      items.push({ id: `${id}:images`, entity: 'product', entityId: id, label: productLabel(p), field: 'images', fieldLabel: 'Bilder',
        before: `${show(entries.filter(e => !e.disabled).map(fileName))} (Titelbild: ${curCover ? fileName(curCover) : '–'})`,
        after: `${show(slots.map(nameOf))} (Titelbild: ${coverName})`, afterRaw: id, warn });
    } catch (e) { skipped.push({ id: String(x.productId), reason: errMsg(e) }); }
  }
  if (!items.length) throw new Error(`Nichts anwendbar: ${skipped.map(s => `${s.id}: ${s.reason}`).slice(0, 5).join('; ')}`);
  return { cs: { id: newIdSafe(), kind: 'product-media', entity: 'product', noun: { one: 'Produkt', many: 'Produkte' }, title: a.title, reason: a.reason, items, assets, skipped, atomic: false }, payload: { plans, store: await ro.store() } };
}

const imgPath = (sku: string, id?: number) => `/v1/products/${skuPath(sku)}/images${id != null ? `/${id}` : ''}`;
/** Rückgängig eines PATCH auf ein Bild: Position, Sichtbarkeit und exakte Rollenliste von vorher */
const restoreOp = (sku: string, e: OmImage) => reqOp('product-image', sku, 'PATCH', imgPath(sku, e.id), { position: e.position, disabled: !!e.disabled, types: e.types ?? [] });

/**
 * Galerie und Rollen werden global (Store 0) geschrieben. Hat die Store-View eigene Galerie-Zeilen (Position/Sichtbarkeit je View,
 * entsteht in Magento 1 bei jedem Produkt-Save im Store-Scope) oder eigene Rollen-Attribute, verdecken die den globalen Stand: dann
 * wird dort nachgezogen. Rückgängig je View: Galerie-Zeile mit den Vorher-Werten (Position null = Standardwert), Rollen über writeStore.
 */
async function fixStoreView(c: OmClient, plan: ImagesPlan, store: string, coverFile: string | null, hiddenIds: Set<number>): Promise<UndoOp[]> {
  if (isGlobal(store)) return [];
  const undo: UndoOp[] = [];
  const view = await c.req('GET', imgPath(plan.sku), undefined, { store }) as OmImage[];
  for (const pe of plan.entries) {
    const v = view.find(x => x.id === pe.id); if (!v) continue;
    const fix: Record<string, unknown> = {}, back: Record<string, unknown> = {};
    if ((v.position ?? 0) !== pe.position) { fix.position = pe.position; back.position = v.position_use_default ? null : v.position; }
    if (!!v.disabled !== pe.disabled) { fix.disabled = pe.disabled; back.disabled = !!v.disabled; }
    if (!Object.keys(fix).length) continue;
    await c.req('PATCH', imgPath(plan.sku, pe.id), fix, { store });
    undo.push(reqOp('product-image', plan.sku, 'PATCH', storePath(imgPath(plan.sku, pe.id), store), back));
  }
  // Rollen: Titelbild trägt alle, ausgeblendete Bilder keine; alles andere bleibt, wie es in der View ist
  const want: Record<string, string> = {};
  if (coverFile) for (const r of COVER_TYPES) want[r] = coverFile;
  for (const v of view) if (hiddenIds.has(v.id)) for (const r of v.types ?? []) want[r] ??= 'no_selection';
  if (Object.keys(want).length) {
    const vp = await getProduct(c, plan.sku, store), fix: Record<string, unknown> = {};
    for (const [r, f] of Object.entries(want)) if (vp && !same(omAttr(vp, r) ?? 'no_selection', f)) fix[r] = f;
    if (Object.keys(fix).length) undo.push(...await writeStore(c, 'product', plan.sku, store, fix));
  }
  if (Object.keys(want).length || plan.entries.length) {
    const after = await c.req('GET', imgPath(plan.sku), undefined, { store }) as OmImage[];
    for (const pe of plan.entries) { const v = after.find(x => x.id === pe.id); if (v && !!v.disabled !== pe.disabled) throw Object.assign(new Error(`Bild ${pe.id} ist in der Store-View „${store}“ weiter ${v.disabled ? 'ausgeblendet' : 'sichtbar'}`), { undo }); }
    const cv = coverFile ? after.find(x => x.file === coverFile) : null;
    if (coverFile && !cv?.types?.includes('image')) throw Object.assign(new Error(`Titelbild wird in der Store-View „${store}“ nicht übernommen`), { undo });
  }
  return undo;
}

export async function applyImages(c: OmClient, plan: ImagesPlan, store = 'admin'): Promise<UndoOp[]> {
  const cur = await getProduct(c, plan.sku, 'admin');
  if (!cur) throw new Error('Produkt nicht mehr vorhanden');
  const entries = cur.images ?? [], deletes: UndoOp[] = [], restores: UndoOp[] = [];
  // Rollen, die ein neues Titelbild übernimmt, liegen danach bei keinem alten Bild mehr: alte Rollen exakt zurück
  const prevCover = coverImage(cur);
  let coverFile: string | null = null;
  try {
    for (const [i, ad] of plan.adds.entries()) {
      const content = await imageContent(c, ad.ref, ad.label || cur.name || plan.sku), isCover = plan.cover === `new:${i}`;
      const r = await c.req('POST', imgPath(plan.sku), { ...content, label: ad.label || '', position: ad.position, types: isCover ? [...COVER_TYPES] : [], disabled: false }) as { image?: OmImage };
      const nid = Number(r?.image?.id);
      if (!nid) throw new Error('Bild wurde nicht angelegt');
      deletes.push(reqOp('product-image', plan.sku, 'DELETE', `${imgPath(plan.sku, nid)}?mode=delete`));
      if (isCover) { coverFile = String(r!.image!.file); if (prevCover) restores.push(restoreOp(plan.sku, prevCover)); }
    }
    for (const pe of plan.entries) {
      const e = entries.find(x => x.id === pe.id); if (!e) throw new Error(`Bild ${pe.id} nicht mehr vorhanden`);
      await c.req('PATCH', imgPath(plan.sku, e.id), { position: pe.position, disabled: pe.disabled, ...(pe.disabled ? { types: [] } : {}) });
      restores.push(restoreOp(plan.sku, e));
    }
    if (plan.cover && !plan.cover.startsWith('new:')) {
      const e = entries.find(x => String(x.id) === plan.cover); if (!e) throw new Error('Titelbild nicht mehr vorhanden');
      await c.req('PATCH', imgPath(plan.sku, e.id), { types: [...new Set([...(e.types ?? []), ...COVER_TYPES])] });
      coverFile = String(e.file);
      if (!plan.entries.some(x => x.id === e.id)) restores.push(restoreOp(plan.sku, e));
      if (prevCover && prevCover.id !== e.id && !plan.entries.some(x => x.id === prevCover.id)) restores.push(restoreOp(plan.sku, prevCover));
    }
    restores.push(...await fixStoreView(c, plan, store, coverFile, new Set(plan.entries.filter(pe => pe.disabled).map(pe => pe.id))));
  } catch (err) { throw Object.assign(new Error(errMsg(err)), { undo: [...deletes, ...restores, ...((err as { undo?: UndoOp[] }).undo ?? [])] }); }
  // Ausführung rückwärts: Store-View zurück → Einträge zurücksetzen (Rollen exakt) → neue Einträge löschen
  return [...deletes, ...restores];
}
reg.register('product-media', async (c, cs, payload, selected, ctx) => {
  const { plans, store } = payload as { plans: Record<string, ImagesPlan>; store?: string }, results: ApplyResult['results'] = [], undo: UndoOp[] = [];
  const view = store ?? await c.mainStore(), list = cs.items.filter(i => selected.has(i.id) && i.entity !== 'info'), tick = partialTicker(ctx, list.length, { results, undo });
  await pool(list, WRITE_CONCURRENCY, async it => {
    try { undo.push(...await applyImages(c, plans[it.entityId!], view)); results.push({ itemId: it.id, ok: true }); }
    catch (e) { undo.push(...((e as { undo?: UndoOp[] }).undo ?? [])); results.push({ itemId: it.id, ok: false, error: errMsg(e) }); }
    finally { tick(); }
  });
  return { results, undo };
});

// ================= Alt-Texte (Bild-Label) =================
export interface AltArgs { title: string; reason: string; images: { mediaId: string; alt: string }[] }
export async function buildAltTextChangeSet(ro: OmReader, a: AltArgs, viewed: Set<string>): Promise<{ cs: ChangeSet; payload: { skus: Record<string, string>; store: string } }> {
  if (!a.images?.length) throw new Error('images ist leer');
  if (a.images.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} Bilder pro Änderungsset.`);
  const ids = [...new Set(a.images.map(i => parseMediaId(i.mediaId)?.productId).filter(Boolean) as string[])];
  const prods = new Map<string, OmProduct>();
  for (const id of ids) { const p = await ro.productById(id); if (p) prods.set(id, p); }
  const items: ChangeItem[] = [], assets: ChangeAsset[] = [], skipped: { id: string; reason: string }[] = [], skus: Record<string, string> = {};
  for (const im of a.images) {
    const mid = parseMediaId(im.mediaId), p = mid ? prods.get(mid.productId) : undefined, e = p?.images?.find(x => x.id === mid!.imageId);
    if (!mid || !p || !e) { skipped.push({ id: im.mediaId, reason: 'Bild nicht gefunden (mediaId aus get_product_images verwenden)' }); continue; }
    const url = await ro.mediaUrl(e.file);
    const seen = viewed.has(im.mediaId) || (!!url && [...viewed].some(v => url.endsWith(v) || v.endsWith(String(e.file))));
    if (!seen) { skipped.push({ id: im.mediaId, reason: 'nicht mit view_image angesehen' }); continue; }
    const alt = plain(im.alt);
    if (!alt) { skipped.push({ id: im.mediaId, reason: 'Alt-Text leer' }); continue; }
    if (alt.length > ALT_MAX) { skipped.push({ id: im.mediaId, reason: `Alt-Text länger als ${ALT_MAX} Zeichen` }); continue; }
    if (same(e.label, alt)) continue;
    skus[im.mediaId] = p.sku;
    items.push({ id: im.mediaId, entity: 'media', entityId: im.mediaId, label: `${productLabel(p)} · ${fileName(e)}`, field: 'alt', fieldLabel: 'Alt-Text', before: plain(e.label) || '–', after: alt, afterRaw: alt, warn: /^(bild|foto|image) (von|of)\b/i.test(alt) ? ['Beginnt mit „Bild von“'] : [] });
    if (url) assets.push({ name: fileName(e), url, alt, note: productLabel(p) });
  }
  if (!items.length) throw new Error(`Keine Änderung nötig bzw. nichts anwendbar: ${skipped.map(s => `${s.id}: ${s.reason}`).slice(0, 5).join('; ') || 'Alt-Texte schon gesetzt'}`);
  return { cs: { id: newIdSafe(), kind: 'media-alt', entity: 'media', noun: { one: 'Bild', many: 'Bilder' }, title: a.title, reason: a.reason, items, assets, skipped, atomic: false }, payload: { skus, store: await ro.store() } };
}
reg.register('media-alt', (c, cs, payload, selected, ctx) => {
  const { skus, store } = payload as { skus: Record<string, string>; store: string };
  return applyEach(cs, selected, async it => {
    const sku = skus[it.id], { imageId } = parseMediaId(it.id)!;
    const inView = (await c.req('GET', imgPath(sku), undefined, { store }) as OmImage[]).find(x => x.id === imageId);
    if (!inView) throw new Error('Bild nicht mehr vorhanden');
    // eigener Store-Text → dort ändern (Rückgängig: alter Text); sonst global (Rückgängig: alter globaler Text)
    const own = inView.label_use_default === false, scope = own ? store : 'admin';
    const before = own ? inView.label : (await c.req('GET', imgPath(sku)) as OmImage[]).find(x => x.id === imageId)?.label ?? '';
    await c.req('PATCH', imgPath(sku, imageId), { label: String(it.afterRaw) }, { store: scope });
    return reqOp('product-image', sku, 'PATCH', storePath(imgPath(sku, imageId), scope), { label: before ?? '' });
  }, ctx);
});

// ================= Neue Produkte =================
export interface NewProductInput { name: string; description: string; price: number; sku?: string; stock?: number; active?: boolean; shortDescription?: string; metaTitle?: string; metaDescription?: string; keywords?: string; weight?: number; categoryIds?: string[]; images?: string[]; taxClass?: string }
export interface NewProductPlan extends Omit<NewProductInput, 'taxClass'> { sku: string; urlKey: string; attributeSetId: number; websiteIds: number[]; taxClassId: number | null; images: string[]; categoryIds: string[]; stock: number; active: boolean; /** weitere Attribute (Import: Sonderpreis, Einkaufspreis, Hersteller, Eigenschaften) */ extra?: Record<string, unknown> }
const skuOf = (name: string) => `${name.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().split(/\s+/).slice(0, 3).map(w => w.slice(0, 4).toUpperCase()).join('-') || 'NEU'}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

/** Stammdaten für neue Produkte: Attributset, Websites, Steuerklassen */
export async function newProductDefaults(ro: OmReader) {
  const [attrs, info] = await Promise.all([ro.attributes(), ro.info()]);
  const set = attrs.attribute_sets.find(s => s.is_default) ?? attrs.attribute_sets[0];
  const tax = attrs.attributes.find(a => a.code === 'tax_class_id');
  const taxOpts = ((tax?.options ?? []) as { label: string; value: unknown }[]).filter(o => o.value !== '' && o.value != null && Number(o.value) !== 0).map(o => ({ label: o.label, value: Number(o.value) }));
  return { attributeSetId: set ? Number(set.id) : null, websiteIds: info.websites.map(w => Number(w.id)).filter(i => i > 0), taxOpts };
}

export async function buildNewProductsChangeSet(ro: OmReader, { title, reason, products }: { title: string; reason: string; products: NewProductInput[] }): Promise<{ cs: ChangeSet; payload: null }> {
  if (!products?.length) throw new Error('products ist leer');
  if (products.length > 50) throw new Error('Maximal 50 neue Produkte pro Änderungsset, bitte aufteilen.');
  const { attributeSetId, websiteIds, taxOpts } = await newProductDefaults(ro), basis = await ro.priceBasis();
  if (!attributeSetId) throw new Error('Kein Attributset für Produkte gefunden');
  const catIds = [...new Set(products.flatMap(p => p.categoryIds ?? []).map(String))], cats = new Map<string, string>();
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
      const sku = p.sku?.trim() || skuOf(name);
      if (sku.includes('/')) throw new Error('SKU darf keinen Schrägstrich enthalten');
      if (taken.has(sku) || keys.has(sku)) throw new Error(`SKU ${sku} ist schon vergeben`);
      const unknown = (p.categoryIds ?? []).map(String).filter(c => !cats.has(c)); if (unknown.length) throw new Error(`Kategorie nicht gefunden: ${unknown.join(', ')}`);
      let uk = urlKey(name);
      if (keys.has(uk) || (await ro.resolveUrl(`${uk}${(await ro.suffixes()).product}`).catch(() => null))) uk = urlKey(`${name}-${sku}`);
      const tax = p.taxClass ? taxOpts.find(o => o.label.toLowerCase() === p.taxClass!.toLowerCase() || String(o.value) === p.taxClass) : taxOpts.find(o => o.value === 2) ?? taxOpts[0];
      if (p.taxClass && !tax) throw new Error(`Steuerklasse ${p.taxClass} nicht gefunden (vorhanden: ${taxOpts.map(o => o.label).join(', ')})`);
      const images: string[] = [];
      for (const ref of p.images ?? []) { try { const url = await imagePreview(ro, ref); images.push(ref); assets.push({ name, url, alt: name, note: images.length === 1 ? 'Titelbild' : 'weiteres Bild' }); } catch (e) { skipped.push({ id: key, reason: errMsg(e) }); } }
      const stockN = Number.isInteger(p.stock) && (p.stock as number) >= 0 ? (p.stock as number) : 0, active = p.active === true;
      const warn: string[] = [];
      if (!images.length) warn.push('Ohne Bild');
      if (p.price === 0) warn.push('Preis 0 €');
      if (active) warn.push('Wird sofort aktiv im Shop');
      keys.add(sku); keys.add(uk);
      const plan: NewProductPlan = { ...p, ...(p.metaTitle ? { metaTitle: stripTitleAffixes(p.metaTitle, await ro.storeView().catch(() => undefined)) } : {}), name, sku, urlKey: uk, attributeSetId, websiteIds, taxClassId: tax?.value ?? null, images, categoryIds: (p.categoryIds ?? []).map(String), stock: stockN, active };
      const where = plan.categoryIds.map(c => cats.get(c)).join(', ');
      items.push({ id: key, entity: 'product', label: `${name} (${sku})`, field: 'create', fieldLabel: 'Neues Produkt', before: '–',
        after: `${money(p.price)} ${basisWord(basis)} · ${active ? 'aktiv' : 'inaktiv (Entwurf)'} · Bestand ${stockN}${where ? ` · ${where}` : ''} · ${images.length} ${images.length === 1 ? 'Bild' : 'Bilder'}`,
        afterRaw: plan, html: { before: '', after: [`<h4>${name}</h4>`, p.description, p.metaTitle ? `<p><b>Meta-Title:</b> ${plain(p.metaTitle)}</p>` : '', p.metaDescription ? `<p><b>Meta-Description:</b> ${plain(p.metaDescription)}</p>` : ''].join('').slice(0, 6000) }, warn });
    } catch (e) { skipped.push({ id: key, reason: `${p?.name ?? key}: ${errMsg(e)}` }); }
  }
  if (!items.length) throw new Error(`Kein Produkt anlegbar: ${skipped.map(s => s.reason).join('; ')}`);
  return { cs: { id: newIdSafe(), kind: 'new-products', entity: 'product', title, reason, items, assets, skipped, atomic: false }, payload: null };
}

/**
 * Produkt anlegen (global, inaktiv als Entwurf) samt Bestand, Kategorien und Bildern. Rückgängig löscht erst die Bilddateien
 * (Schritte von applyImages, mode=delete; das Löschen des Produkts allein ließe die Dateien unter media/catalog/product liegen), dann das Produkt.
 */
export async function createProduct(c: OmClient, p: NewProductPlan): Promise<UndoOp[]> {
  if (await getProduct(c, p.sku)) throw new Error(`SKU ${p.sku} ist schon vergeben`);
  const attributes: Record<string, unknown> = { name: p.name, price: p.price, description: p.description, url_key: p.urlKey, status: p.active ? 1 : 2, visibility: 4, ...(p.taxClassId != null ? { tax_class_id: p.taxClassId } : {}),
    ...(p.shortDescription ? { short_description: p.shortDescription } : {}), ...(p.metaTitle ? { meta_title: p.metaTitle } : {}), ...(p.metaDescription ? { meta_description: p.metaDescription } : {}), ...(p.keywords ? { meta_keyword: p.keywords } : {}), ...(p.weight != null ? { weight: p.weight } : {}), ...(p.extra ?? {}) };
  for (const k of Object.keys(attributes)) if (attributes[k] === null || attributes[k] === undefined) delete attributes[k];
  const undo = [reqOp('product', p.sku, 'DELETE', `/v1/products/${skuPath(p.sku)}`)];
  try { await c.req('POST', '/v1/products', { sku: p.sku, type_id: 'simple', attribute_set_id: p.attributeSetId, website_ids: p.websiteIds, attributes, stock: { qty: p.stock, is_in_stock: p.stock > 0 }, categories: p.categoryIds.map((id, k) => ({ id: Number(id), position: k })) }); }
  catch (e) { throw Object.assign(e instanceof Error ? e : new Error(String(e)), { undo }); }
  if (p.images.length) {
    try { undo.push(...await applyImages(c, { sku: p.sku, adds: p.images.map((ref, i) => ({ ref, label: p.name, position: i + 1 })), entries: [], cover: 'new:0' })); }
    catch (e) { throw Object.assign(new Error(`Angelegt, aber Bild nicht übernommen: ${errMsg(e)}`), { undo: [...undo, ...((e as { undo?: UndoOp[] }).undo ?? [])] }); }
  }
  return undo;
}
reg.register('new-products', async (c, cs, _payload, selected, ctx) => {
  const results: ApplyResult['results'] = [], undo: UndoOp[] = [], list = cs.items.filter(i => selected.has(i.id) && i.entity !== 'info'), tick = partialTicker(ctx, list.length, { results, undo });
  await pool(list, WRITE_CONCURRENCY, async it => {
    try { undo.push(...await createProduct(c, it.afterRaw as NewProductPlan)); results.push({ itemId: it.id, ok: true }); }
    catch (e) { undo.push(...((e as { undo?: UndoOp[] }).undo ?? [])); results.push({ itemId: it.id, ok: false, error: errMsg(e) }); }
    finally { tick(); }
  });
  return { results, undo };
});

/** Bilder eines Produkts für Werkzeuge (mediaId, URL, Alt-Text, Position, Titelbild, ausgeblendet) */
export async function imageRows(ro: OmReader, p: OmProduct) {
  const cover = coverImage(p);
  return Promise.all([...(p.images ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map(async e => {
    const url = await ro.mediaUrl(e.file), label = plain(e.label);
    return { mediaId: mediaId(p.id, e.id), url, file: fileName(e), alt: label || null, position: e.position ?? 0, cover: e.id === cover?.id, roles: e.types ?? [], ...(e.disabled ? { hidden: true } : {}), ...(!label ? { altMissing: true } : {}), ...(/ki-generiert/i.test(String(e.file)) ? { aiGenerated: true } : {}) };
  }));
}
