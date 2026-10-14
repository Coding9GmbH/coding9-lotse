import 'server-only';
// Produktbilder & Alt-Texte: Bilder bestehender Produkte hinzufügen/entfernen/sortieren, Titelbild setzen, Alt-Texte/Titel der Medien pflegen.
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { ChangeAsset, ChangeItem, ChangeSet, ChatEvent, UndoOp } from '@/lib/protocol';
import { applyEach, errMsg, MAX_ITEMS, registerApplier, stripTags, undoOps } from '../changes';
import { importFromUrl, noteMedia, stagedMeta, uploadStaged } from '../media';
import { HEX32, newId, type Shopware, type ShopReader, type SwEntity } from '../shopware';
import { fail, guard, nextOffsetOf, ok, pageOf, type AnyTool } from '../tool-kit';
import type { Feature } from './types';

export const KIND_IMAGES = 'product-images';
export const KIND_ALT = 'media-alt';
export const ALT_MAX = 125;
const AI_MARK = /\bKI[- ]?generiert/i;

const fileOf = (m: SwEntity | null | undefined) => (m?.fileName ? `${m.fileName}${m.fileExtension ? `.${m.fileExtension}` : ''}` : '–');
const nameOfProduct = (p: SwEntity, parent?: SwEntity | null) => p.translated?.name ?? p.name ?? parent?.translated?.name ?? parent?.name ?? null;
const productLabel = (p: SwEntity, parent?: SwEntity | null) => `${nameOfProduct(p, parent) ?? p.productNumber}${p.productNumber ? ` (${p.productNumber})` : ''}`;
const plainText = stripTags;
// wie slug() in media.ts; Uploads heißen „<slug>-xxxxx“ (Zufallsendung)
const slugish = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** Alt-Text ist nur der Dateiname (z. B. Upload „IMG_1234“, „Vase_Kiesel_front“): zählt als fehlend */
export const altIsFileName = (alt: string | null | undefined, fileName: string | null | undefined) => {
  const a = plainText(alt).toLowerCase();
  if (!a) return false;
  const f = slugish(String(fileName ?? '')), s = slugish(a).slice(0, 48);
  return (!!s && (s === f || s === f.replace(/-[a-z0-9]{5}$/, ''))) || /^(img|dsc|dscn|pxl|photo|foto|bild|image|upload)[-_ ]?\d*$/.test(a) || /\.(jpe?g|png|webp|gif|avif)$/.test(a);
};

// ---- Bildliste eines Produkts planen (rein, testbar) ----
export interface PmRow { id: string; mediaId: string; position: number }
export interface AddSpec { image: string; position?: number; cover?: boolean; alt?: string }
export interface ImageOps { add?: AddSpec[]; remove?: string[]; order?: string[]; cover?: string }
/** Eintrag der Ziel-Bildliste: vorhandene Produkt-Bild-Zuordnung (id) oder neue (isNew, ref = mediaId | staged:… | URL) */
export interface PlanEntry { id: string; ref: string; isNew: boolean; alt?: string }
export interface ImagePlan { entries: PlanEntry[]; removed: PmRow[]; coverId: string | null; changed: boolean; errors: string[] }

export function planImages(cur: PmRow[], curCover: string | null, ops: ImageOps, genId: () => string = newId): ImagePlan {
  const sorted = [...cur].sort((a, b) => a.position - b.position);
  let list: PlanEntry[] = sorted.map(r => ({ id: r.id, ref: r.mediaId, isNew: false }));
  const errors: string[] = [], removed: PmRow[] = [];
  const find = (ref: string) => list.find(e => e.id === ref || e.ref === ref);
  for (const r of ops.remove ?? []) {
    const e = list.find(x => !x.isNew && (x.id === r || x.ref === r));
    if (!e) { errors.push(`Entfernen: Bild ${r} ist nicht am Produkt`); continue; }
    list = list.filter(x => x !== e); removed.push(sorted.find(x => x.id === e.id)!);
  }
  let coverId: string | null = null;
  for (const a of ops.add ?? []) {
    if (list.some(e => e.ref === a.image)) { errors.push(`Hinzufügen: ${a.image} ist schon am Produkt`); continue; }
    const e: PlanEntry = { id: genId(), ref: a.image, isNew: true, ...(a.alt ? { alt: a.alt } : {}) };
    const at = Number.isInteger(a.position) ? Math.min(Math.max(a.position!, 0), list.length) : list.length;
    list.splice(at, 0, e);
    if (a.cover) coverId = e.id;
  }
  if (ops.order?.length) {
    const listed: PlanEntry[] = [];
    for (const r of ops.order) { const e = find(r); if (!e) errors.push(`Reihenfolge: ${r} ist nicht am Produkt`); else if (!listed.includes(e)) listed.push(e); }
    list = [...listed, ...list.filter(e => !listed.includes(e))];
  }
  if (ops.cover) { const e = find(ops.cover); if (e) coverId = e.id; else errors.push(`Titelbild: ${ops.cover} ist nicht am Produkt`); }
  if (!coverId) coverId = curCover && list.some(e => e.id === curCover) ? curCover : list[0]?.id ?? null;
  const changed = removed.length > 0 || list.some(e => e.isNew) || coverId !== (curCover ?? null)
    || list.length !== sorted.length || list.some((e, i) => sorted[i].id !== e.id); // nur Positionswerte normalisieren (z. B. 1 statt 0) zählt nicht als Änderung
  return { entries: list, removed, coverId, changed, errors };
}

/** „3 Bilder, Titelbild: a.jpg“ */
export const imagesSummary = (names: string[], coverName: string | null, inherited = false) => (names.length ? `${names.length} ${names.length === 1 ? 'Bild' : 'Bilder'}${inherited ? ' (geerbt vom Hauptprodukt)' : ''}, Titelbild: ${coverName ?? '–'}` : 'keine Bilder');
export const INHERIT_WARN = 'Variante bekommt eigene Bilder. Die geerbten Bilder des Hauptprodukts werden dann nicht mehr angezeigt';

/** Varianten ohne eigene Bilder erben die Bilder (und das Titelbild) des Hauptprodukts: Hauptprodukte dazu laden */
async function inheritedFrom(ro: ShopReader, rows: SwEntity[], associations: Record<string, unknown>): Promise<Record<string, SwEntity>> {
  const pids = [...new Set(rows.filter(r => r.parentId && !(r.media ?? []).length).map(r => r.parentId as string))];
  return pids.length ? Object.fromEntries((await ro.search('product', { ids: pids, limit: pids.length, associations: associations as never })).data.map(p => [p.id, p])) : {};
}
/** Mehrfach genannte Produkte zusammenführen (sonst zwei parallele Schreibvorgänge auf dasselbe Produkt) */
export function mergeProductOps<T extends ImageOps & { productId: string }>(products: T[]): T[] {
  const by = new Map<string, T>();
  for (const p of products) {
    const m = by.get(p.productId);
    if (!m) { by.set(p.productId, { ...p }); continue; }
    by.set(p.productId, { ...m, add: [...(m.add ?? []), ...(p.add ?? [])], remove: [...(m.remove ?? []), ...(p.remove ?? [])], order: p.order?.length ? p.order : m.order, cover: p.cover ?? m.cover });
  }
  return [...by.values()];
}

/** Payload je Produkt (afterRaw): der Executor prüft den Stand (snapshot = Zuordnungs-IDs, snapshotCover = Titelbild) und schreibt danach */
export interface ImagesPayload { productId: string; snapshot: string[]; snapshotCover?: string | null; entries: PlanEntry[]; removed: PmRow[]; coverId: string | null }

export interface ProductImagesArgs { title: string; reason: string; products: (ImageOps & { productId: string })[] }

interface RefInfo { name: string; url?: string; ai: boolean; error?: string }
async function refInfos(ro: ShopReader, refs: string[]): Promise<Record<string, RefInfo>> {
  const out: Record<string, RefInfo> = {}, ids = refs.filter(r => HEX32.test(r));
  const media = ids.length ? (await ro.search('media', { ids, limit: ids.length })).data : [];
  for (const r of refs) {
    if (r.startsWith('staged:')) { const m = stagedMeta(r.slice(7)); out[r] = m ? { name: m.name, url: `/staged/${m.file}`, ai: !!m.ai } : { name: r, ai: false, error: 'vorgemerktes Bild nicht gefunden' }; }
    else if (/^https?:\/\//i.test(r)) { let name = r; try { name = decodeURIComponent(new URL(r).pathname.split('/').pop() || r); } catch { /* bleibt URL */ } out[r] = { name, url: r, ai: false }; }
    else if (HEX32.test(r)) {
      const m = media.find(x => x.id === r);
      out[r] = !m ? { name: r, ai: false, error: 'Medium nicht gefunden' } : !String(m.mimeType ?? '').startsWith('image/') ? { name: fileOf(m), ai: false, error: 'Medium ist kein Bild' } : { name: fileOf(m), url: m.url, ai: noteMedia(m) };
    } else out[r] = { name: r, ai: false, error: 'unbekannte Bildangabe (erlaubt: mediaId, staged:…, https-URL)' };
  }
  return out;
}

export async function buildProductImagesChangeSet(ro: ShopReader, args: ProductImagesArgs, genId: () => string = newId): Promise<ChangeSet> {
  const { title, reason } = args;
  if (!args.products?.length) throw new Error('products ist leer');
  const products = mergeProductOps(args.products);
  if (products.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} Produkte pro Änderungsset, bitte aufteilen.`);
  const ids = products.map(p => p.productId), assoc = { media: { associations: { media: {} } } };
  const rows = (await ro.search('product', { ids, limit: ids.length, associations: assoc })).data;
  const by: Record<string, SwEntity> = Object.fromEntries(rows.map(r => [r.id, r]));
  const parents = await inheritedFrom(ro, rows, assoc);
  const refs = [...new Set(products.flatMap(p => (p.add ?? []).map(a => String(a.image ?? '').trim())).filter(Boolean))];
  const info = await refInfos(ro, refs);
  const items: ChangeItem[] = [], skipped: ChangeSet['skipped'] = [], assets = new Map<string, ChangeAsset>(); let unchanged = 0;
  const asset = (url: string | undefined, name: string, note: string) => { if (!url) return; const a = assets.get(url); if (a) { if (!a.note.includes(note)) a.note += ` · ${note}`; } else assets.set(url, { name, url, note }); };
  for (const ch of products) {
    const cur = by[ch.productId];
    if (!cur) { skipped.push({ id: ch.productId, reason: 'Produkt nicht gefunden' }); continue; }
    const parent = parents[cur.parentId] ?? null, label = productLabel(cur, parent);
    const inh: SwEntity[] = parent && !(cur.media ?? []).length ? parent.media ?? [] : []; // geerbte Bilder (nur Anzeige)
    const add: AddSpec[] = [];
    for (const a of ch.add ?? []) {
      const ref = String(a.image ?? '').trim(), i = info[ref];
      if (!i || i.error) { skipped.push({ id: ch.productId, reason: `${label}: ${ref || '(leer)'}: ${i?.error ?? 'fehlt'}` }); continue; }
      add.push({ ...a, image: ref, ...(a.alt ? { alt: plainText(a.alt).slice(0, 255) } : {}) });
    }
    const pms: SwEntity[] = cur.media ?? [];
    const plan = planImages(pms.map(m => ({ id: m.id, mediaId: m.mediaId, position: m.position ?? 0 })), cur.coverId ?? null, { ...ch, add }, genId);
    for (const e of plan.errors) skipped.push({ id: ch.productId, reason: `${label}: ${e}${inh.length && !/Hinzufügen/.test(e) ? ' (die Bilder sind vom Hauptprodukt geerbt, dort ändern)' : ''}` });
    if (!plan.changed) { unchanged++; continue; }
    const pmById: Record<string, SwEntity> = Object.fromEntries(pms.map(m => [m.id, m]));
    const nameOf = (e: PlanEntry) => (e.isNew ? info[e.ref].name : fileOf(pmById[e.id]?.media));
    const shown = inh.length ? inh : pms, shownCover = inh.length ? parent!.coverId : cur.coverId;
    const curSorted = [...shown].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)), curCover = curSorted.find(m => m.id === shownCover);
    const before = imagesSummary(curSorted.map(m => fileOf(m.media)), curCover ? fileOf(curCover.media) : null, inh.length > 0);
    const coverEntry = plan.entries.find(e => e.id === plan.coverId);
    const after = imagesSummary(plan.entries.map(nameOf), coverEntry ? nameOf(coverEntry) : null);
    const warn: string[] = inh.length ? [INHERIT_WARN] : [];
    if (!plan.entries.length) warn.push('Produkt hat danach kein Bild');
    if (plan.removed.length) warn.push(`${plan.removed.length} ${plan.removed.length === 1 ? 'Bild wird' : 'Bilder werden'} entfernt (bleibt in der Medienverwaltung)`);
    if (coverEntry && (coverEntry.isNew ? info[coverEntry.ref].ai : noteMedia(pmById[coverEntry.id]?.media))) warn.push('Titelbild ist KI-generiert');
    if (plan.entries.some(e => e.isNew && /^https?:/i.test(e.ref))) warn.push('Bild wird erst bei Freigabe von der URL geladen');
    if (plan.entries.some(e => e.isNew && !HEX32.test(e.ref))) warn.push('Hochgeladene/importierte Bilder bleiben auch nach „Rückgängig“ in der Medienverwaltung');
    for (const e of plan.entries.filter(x => x.isNew)) asset(info[e.ref].url, info[e.ref].name, `neu bei ${cur.productNumber ?? label}${e.id === plan.coverId ? ' (Titelbild)' : ''}`);
    for (const r of plan.removed) asset(pmById[r.id]?.media?.url, fileOf(pmById[r.id]?.media), `entfernt bei ${cur.productNumber ?? label}`);
    const list = (names: string[], cover: string | null) => names.map((n, i) => `${i + 1}. ${n}${n === cover ? ' (Titelbild)' : ''}`).join('\n') || '–';
    const payload: ImagesPayload = { productId: cur.id, snapshot: pms.map(m => m.id).sort(), snapshotCover: cur.coverId ?? null, entries: plan.entries, removed: plan.removed, coverId: plan.coverId };
    items.push({ id: `${cur.id}:images`, entity: 'product', entityId: cur.id, label, field: 'images', fieldLabel: 'Bilder', before, after, afterRaw: payload,
      html: { before: list(curSorted.map(m => fileOf(m.media)), curCover ? fileOf(curCover.media) : null), after: list(plan.entries.map(nameOf), coverEntry ? nameOf(coverEntry) : null) }, warn });
  }
  if (!items.length) throw new Error(`Keine Bildänderung nötig bzw. nichts anwendbar (${unchanged} unverändert, ${skipped.length} übersprungen: ${skipped.slice(0, 3).map(s => s.reason).join('; ')})`);
  return { id: newId(), kind: KIND_IMAGES, entity: 'product', noun: { one: 'Produkt', many: 'Produkte' }, applyLabel: 'Bilder übernehmen', title, reason, items, assets: [...assets.values()], skipped, unchanged, atomic: false };
}

/** Rückgängig-Schritte in Schreibreihenfolge; undoOps läuft rückwärts: entfernte neu anlegen → Positionen/Titelbild → neue löschen */
export function imagesUndo(productId: string, cur: { coverId: string | null; media: PmRow[] }, p: ImagesPayload): UndoOp[] {
  const kept = p.entries.filter(e => !e.isNew).map(e => cur.media.find(m => m.id === e.id)!).filter(Boolean);
  return [
    ...p.entries.filter(e => e.isNew).map((e): UndoOp => ({ op: 'delete', entity: 'product-media', id: e.id })),
    { op: 'patch', entity: 'product', id: productId, data: { coverId: cur.coverId ?? null, media: kept.map(m => ({ id: m.id, position: m.position })) } },
    ...p.removed.map(r => cur.media.find(m => m.id === r.id) ?? r).map((r): UndoOp => ({ op: 'create', entity: 'product-media', id: r.id, data: { productId, mediaId: r.mediaId, position: r.position } })),
  ];
}

async function resolveRef(swW: Shopware, e: PlanEntry): Promise<string> {
  if (e.ref.startsWith('staged:')) return uploadStaged(swW, e.ref.slice(7), { folder: 'product' });
  if (/^https?:\/\//i.test(e.ref)) return (await importFromUrl(swW, e.ref, { alt: e.alt, folder: 'product' })).mediaId;
  return e.ref;
}

/** Jedes Bild (staged/URL) nur einmal je Änderungsset hochladen/importieren, auch wenn es an mehrere Produkte geht */
export type Resolver = (e: PlanEntry) => Promise<string>;
export const resolverFor = (swW: Shopware, one: (swW: Shopware, e: PlanEntry) => Promise<string> = resolveRef): Resolver => { const m = new Map<string, Promise<string>>(); return e => { let r = m.get(e.ref); if (!r) m.set(e.ref, r = one(swW, e)); return r; }; };

const CHANGED = 'Die Bilder des Produkts wurden inzwischen geändert, bitte neu vorschlagen.';
export async function applyImages(swW: Shopware, p: ImagesPayload, resolve: Resolver = resolverFor(swW)): Promise<UndoOp[]> {
  const cur = await swW.get('product', p.productId, { associations: { media: {} } });
  if (!cur) throw new Error('Produkt nicht mehr vorhanden');
  const media: PmRow[] = (cur.media ?? []).map((m: SwEntity) => ({ id: m.id, mediaId: m.mediaId, position: m.position ?? 0 }));
  if (media.map(m => m.id).sort().join() !== [...p.snapshot].sort().join()) throw new Error(CHANGED);
  if (p.snapshotCover !== undefined && (cur.coverId ?? null) !== p.snapshotCover) throw new Error(CHANGED); // Titelbild inzwischen geändert: der Vorschlag zeigte ein anderes „vorher“
  const rows = [];
  try { for (const [i, e] of p.entries.entries()) rows.push(e.isNew ? { id: e.id, mediaId: await resolve(e), position: i } : { id: e.id, position: i }); }
  catch (e) { throw new Error(`${errMsg(e)}. Produkt unverändert; bereits hochgeladene Bilder bleiben in der Medienverwaltung`); }
  const undo = imagesUndo(p.productId, { coverId: cur.coverId ?? null, media }, p);
  await swW.update('product', p.productId, { coverId: p.coverId, media: rows });
  try { for (const r of p.removed) await swW.req('DELETE', `/product-media/${r.id}`); }
  catch (e) { await undoOps(swW, undo); throw e; } // halb gelöscht: Ausgangszustand wiederherstellen (Anlegen noch vorhandener Zuordnungen schlägt harmlos fehl)
  return undo;
}
registerApplier(KIND_IMAGES, (swW, cs, _payload, selected, ctx) => { const resolve = resolverFor(swW); return applyEach(cs, selected, it => applyImages(swW, it.afterRaw as ImagesPayload, resolve), ctx); });

// ---- Alt-Texte / Titel von Medien ----
export interface AltArgs { title: string; reason: string; images: { mediaId: string; alt: string; title?: string }[] }
/** Bilder, die die KI in diesem Chat mit view_image angesehen hat (mediaIds und URL-Pfade) */
export function viewedImages(events: ChatEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) if (e.t === 'tool' && e.name.replace(/^mcp__shop__/, '') === 'view_image') {
    const i = (e.input ?? {}) as { mediaId?: string; url?: string };
    if (i.mediaId) out.add(i.mediaId); if (i.url) out.add(urlKey(i.url));
  }
  return out;
}
const urlKey = (u: string) => { let p = u; try { p = new URL(u, 'http://x').pathname; } catch { /* relativ */ } const i = p.indexOf('/media/'); return i >= 0 ? p.slice(i) : p; };

export function checkAlt(raw: unknown): { alt: string; warn: string[] } {
  const alt = plainText(raw), warn: string[] = [];
  if (!alt) throw new Error('Alt-Text ist leer');
  if (alt.length > 255) throw new Error('Alt-Text länger als 255 Zeichen');
  if (/^(ein |das |dieses? )?(bild|foto|abbildung|grafik|image|picture|photo)\s+(von|vom|zeigt|mit|eine[sr]?|des|der|of)\b/i.test(alt)) throw new Error('Alt-Text beginnt mit „Bild von …“. Direkt beschreiben, was zu sehen ist');
  if (alt.length > ALT_MAX) warn.push(`Alt-Text ${alt.length} Zeichen (empfohlen ≤ ${ALT_MAX})`);
  return { alt, warn };
}

export async function buildAltTextChangeSet(ro: ShopReader, { title, reason, images }: AltArgs, viewed: Set<string> | null): Promise<ChangeSet> {
  if (!images?.length) throw new Error('images ist leer');
  if (images.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} Bilder pro Änderungsset, bitte aufteilen.`);
  const ids = [...new Set(images.map(i => i.mediaId))].filter(id => HEX32.test(id));
  const media = ids.length ? (await ro.search('media', { ids, limit: ids.length })).data : [];
  const by: Record<string, SwEntity> = Object.fromEntries(media.map(m => [m.id, m]));
  // Wo wird das Bild verwendet? (Alt-Text gilt überall, wo das Medium eingebunden ist)
  const users = ids.length ? (await ro.search('product', { limit: 500, filter: [{ type: 'equalsAny', field: 'media.mediaId', value: ids }], associations: { media: {} } })).data : [];
  const usedBy = (id: string) => users.filter(p => (p.media ?? []).some((m: SwEntity) => m.mediaId === id));
  const items: ChangeItem[] = [], skipped: ChangeSet['skipped'] = [], assets: ChangeAsset[] = []; let unchanged = 0;
  const seen = new Set<string>();
  // Texte werden in der Standardsprache (API-Kontext) geschrieben; weitere Sprachen behalten ihren Text
  const langs = (await ro.search('language', { limit: 1, 'total-count-mode': 1 }).catch(() => null))?.total ?? 1;
  const langWarn = langs > 1 ? [`Gilt nur für die Standardsprache; ${langs - 1} weitere ${langs === 2 ? 'Sprache behält' : 'Sprachen behalten'} ihren bisherigen Text`] : [];
  for (const im of images) {
    const m = by[im.mediaId];
    if (!m) { skipped.push({ id: im.mediaId, reason: `Medium ${im.mediaId} nicht gefunden` }); continue; }
    if (seen.has(m.id)) { skipped.push({ id: m.id, reason: `${fileOf(m)}: doppelt angegeben` }); continue; }
    seen.add(m.id);
    if (viewed && !viewed.has(m.id) && !(m.url && viewed.has(urlKey(m.url)))) { skipped.push({ id: m.id, reason: `${fileOf(m)}: Bild nicht angesehen. Erst view_image aufrufen, dann beschreiben` }); continue; }
    const ps = usedBy(m.id), label = `${fileOf(m)}${ps.length ? ` · ${ps.slice(0, 2).map(p => p.translated?.name ?? p.name).join(', ')}${ps.length > 2 ? ` +${ps.length - 2}` : ''}` : ''}`;
    const shared = ps.length > 1 ? [`Bild wird in ${ps.length} Produkten verwendet`] : [];
    let n = 0;
    try {
      const { alt, warn } = checkAlt(im.alt);
      if (alt === (m.alt ?? '')) unchanged++;
      else { items.push({ id: `${m.id}:alt`, entity: 'media', entityId: m.id, label, field: 'alt', fieldLabel: 'Alt-Text', before: plainText(m.alt) || '–', after: alt, afterRaw: alt, warn: [...warn, ...shared, ...langWarn] }); n++; }
    } catch (e) { skipped.push({ id: m.id, reason: `${fileOf(m)}: ${errMsg(e)}` }); }
    // KI-Bild, dessen Kennzeichnung nur im Alt-Text steckt: beim Ersetzen des Alt-Texts in den Titel übernehmen
    const keepMark = im.title == null && n > 0 && noteMedia(m) && !AI_MARK.test(`${m.title ?? ''} ${m.fileName ?? ''}`);
    if (im.title != null || keepMark) {
      let t = plainText(im.title ?? (plainText(m.title) || items[items.length - 1].after)).slice(0, 255);
      if (noteMedia(m) && !AI_MARK.test(t)) t = `KI-generiert: ${t}`; // Kennzeichnung bleibt erhalten
      if (!t) skipped.push({ id: m.id, reason: `${fileOf(m)}: Titel ist leer` });
      else if (t === (m.title ?? '')) unchanged++;
      else { items.push({ id: `${m.id}:title`, entity: 'media', entityId: m.id, label, field: 'title', fieldLabel: 'Titel', before: plainText(m.title) || '–', after: t, afterRaw: t, warn: [...shared, ...langWarn, ...(keepMark ? ['KI-Kennzeichnung wird in den Titel übernommen'] : [])] }); n++; }
    }
    if (n && m.url && assets.length < 60) assets.push({ name: fileOf(m), url: m.url, alt: plainText(m.alt) || undefined, note: noteMedia(m) ? 'KI-generiert' : ps.length ? `${ps.length} ${ps.length === 1 ? 'Produkt' : 'Produkte'}` : 'Medium' });
  }
  if (!items.length) throw new Error(`Keine Änderung nötig bzw. nichts anwendbar (${unchanged} unverändert, ${skipped.length} übersprungen: ${skipped.slice(0, 3).map(s => s.reason).join('; ')})`);
  return { id: newId(), kind: KIND_ALT, entity: 'media', noun: { one: 'Bild', many: 'Bilder' }, applyLabel: 'Texte übernehmen', title, reason, items, assets, skipped, unchanged, atomic: false };
}

registerApplier(KIND_ALT, (swW, cs, _payload, selected, ctx) => applyEach(cs, selected, async it => {
  const field = it.field as 'alt' | 'title', cur = await swW.get('media', it.entityId!);
  if (!cur) throw new Error('Medium nicht mehr vorhanden');
  await swW.update('media', cur.id, { [field]: it.afterRaw });
  return { op: 'patch', entity: 'media', id: cur.id, data: { [field]: cur[field] ?? null } };
}, ctx));

// ---- Lesen ----
const mediaAssoc = { media: { sort: [{ field: 'position' }], associations: { media: {} } } };
const imageRow = (pm: SwEntity, coverId: string | null) => {
  const m = pm.media ?? {};
  return { productMediaId: pm.id, mediaId: pm.mediaId, position: pm.position, cover: pm.id === coverId, file: fileOf(m), url: m.url, alt: m.alt ?? null, title: m.title ?? null,
    ...(noteMedia(m) ? { aiGenerated: true } : {}), ...(!plainText(m.alt) ? { altMissing: true } : altIsFileName(m.alt, m.fileName) ? { altIsFileName: true } : {}) };
};

export const productFilter = (a: { categoryId?: string; active?: boolean; includeVariants?: boolean }) => [
  ...(a.includeVariants ? [] : [{ type: 'equals', field: 'parentId', value: null }]),
  ...(a.categoryId ? [{ type: 'equals', field: 'categoriesRo.id', value: a.categoryId }] : []),
  ...(a.active != null ? [{ type: 'equals', field: 'active', value: a.active }] : []),
];

// Produkte mit mindestens einem Bild bzw. mit einem Bild ohne Alt-Text (auch vom Shop-Check genutzt, damit die Zahlen übereinstimmen)
export const HAS_MEDIA = { type: 'not', operator: 'and', queries: [{ type: 'equals', field: 'media.id', value: null }] };
export const ALT_GAP = [HAS_MEDIA, { type: 'multi', operator: 'or', queries: [{ type: 'equals', field: 'media.media.alt', value: null }, { type: 'equals', field: 'media.media.alt', value: '' }] }];

/** Filter für Bildlücken (auch vom Shop-Check genutzt): ohne Bild bzw. mindestens ein Bild ohne Alt-Text */
export const GAP_FILTER = {
  images: [{ type: 'equals', field: 'media.id', value: null }, { type: 'multi', operator: 'or', queries: [{ type: 'equals', field: 'parentId', value: null }, { type: 'equals', field: 'parent.media.id', value: null }] }], // Varianten mit geerbten Bildern haben Bilder
  alt: ALT_GAP, // Produkte ganz ohne Bild zählen nicht (Join liefert sonst alt = null)
};

export const productImages: Feature = {
  key: 'product-images',
  platforms: ['shopware'],
  toolNames: ['get_product_images', 'find_image_gaps', 'propose_product_images', 'propose_alt_texts'],
  tools: session => {
    const { sw } = session;
    return [
      tool('get_product_images', 'Liest die Bilder eines oder vieler Produkte (max. 50): je Bild productMediaId, mediaId, Position, Titelbild (cover), Datei, URL, Alt-Text, Titel, aiGenerated (KI-Bild), altMissing/altIsFileName (Alt-Text fehlt oder ist nur der Dateiname). Varianten ohne eigene Bilder: inherited=true, gezeigt werden die geerbten Bilder des Hauptprodukts. Ändert nichts.',
        { productIds: z.array(z.string()).optional().describe('Produkt-IDs'), productNumbers: z.array(z.string()).optional().describe('alternativ Produktnummern') },
        guard(async ({ productIds, productNumbers }) => {
          const ids = productIds ?? [], nums = productNumbers ?? [];
          if (!ids.length && !nums.length) return fail('productIds oder productNumbers angeben');
          if (ids.length + nums.length > 50) return fail('Maximal 50 Produkte pro Aufruf');
          const r = await sw.search('product', { limit: 50, ...(ids.length ? { ids } : { filter: [{ type: 'equalsAny', field: 'productNumber', value: nums }] }), associations: mediaAssoc });
          const parents = await inheritedFrom(sw, r.data, mediaAssoc);
          return ok(r.data.map(p => {
            const par = parents[p.parentId] && !(p.media ?? []).length ? parents[p.parentId] : null;
            return { id: p.id, number: p.productNumber, name: nameOfProduct(p, parents[p.parentId]), parentId: p.parentId ?? undefined,
              ...(par ? { inherited: true, note: 'Variante ohne eigene Bilder, zeigt die Bilder des Hauptprodukts. Eigene Bilder ersetzen diese Galerie.' } : {}),
              images: ((par ?? p).media ?? []).map((pm: SwEntity) => ({ ...imageRow(pm, (par ?? p).coverId ?? null), ...(par ? { inherited: true } : {}) })) };
          }));
        })),

      tool('find_image_gaps', 'Findet Produkte mit Bildlücken (paginiert, mit Gesamtzahl): missing="images" = Produkte ganz ohne Bild; missing="alt" = Produkte mit mindestens einem Bild ohne Alt-Text (liefert diese Bilder mit mediaId/URL). Filter: Kategorie, aktiv, Varianten (Varianten, die Bilder vom Hauptprodukt erben, gelten als bebildert). Blättern mit nextOffset. Ändert nichts.',
        { missing: z.enum(['images', 'alt']), categoryId: z.string().optional(), active: z.boolean().optional(), includeVariants: z.boolean().optional(), limit: z.number().optional().describe('max. 100 (bei alt max. 50)'), offset: z.number().optional() },
        guard(async a => {
          const { limit, page, offset, note } = pageOf(a.offset, Math.max(1, Math.min(Math.floor(a.limit ?? 25), a.missing === 'alt' ? 50 : 100))); // Shopware blättert seitenweise
          const base = productFilter(a);
          const gap = GAP_FILTER[a.missing];
          const [r, all] = await Promise.all([
            sw.search('product', { limit, page, filter: [...base, ...gap], 'total-count-mode': 1, sort: [{ field: 'productNumber', order: 'ASC' }], ...(a.missing === 'alt' ? { associations: mediaAssoc } : {}) }),
            sw.search('product', { limit: 1, filter: base, 'total-count-mode': 1 }),
          ]);
          const noAlt = (pm: SwEntity) => !plainText(pm.media?.alt) || altIsFileName(pm.media?.alt, pm.media?.fileName);
          return ok({ missing: a.missing, total: r.total, ofProducts: all.total, offset, ...(note ? { note } : {}), returned: r.data.length, nextOffset: nextOffsetOf(offset, r.data.length, limit, r.total),
            products: r.data.map(p => ({ id: p.id, number: p.productNumber, name: p.translated?.name ?? p.name, active: p.active,
              ...(a.missing === 'alt' ? { imageCount: p.media?.length ?? 0, imagesWithoutAlt: (p.media ?? []).filter(noAlt).map((pm: SwEntity) => ({ mediaId: pm.mediaId, url: pm.media?.url, file: fileOf(pm.media), cover: pm.id === p.coverId, ...(plainText(pm.media?.alt) ? { altIsFileName: true } : {}), ...(noteMedia(pm.media) ? { aiGenerated: true } : {}) })) } : {}) })),
            hint: a.missing === 'alt' ? 'Gezählt werden nur leere Alt-Texte. Alt-Texte, die nur der Dateiname sind (typisch nach Uploads), fehlen in total; get_product_images zeigt sie als altIsFileName.' : 'Varianten, die die Bilder ihres Hauptprodukts erben, zählen als bebildert.' });
        })),

      tool('propose_product_images', `SCHLÄGT Bildänderungen an bestehenden Produkten vor (max. ${MAX_ITEMS} Produkte): Bilder hinzufügen, entfernen, umsortieren, Titelbild setzen. Es wird NICHTS geschrieben: Der Nutzer sieht je Produkt vorher/nachher samt Vorschaubildern und gibt frei; der Aufruf wartet auf die Entscheidung. Bilder (add.image): mediaId (Chat-Anhang/search_media), "staged:…" (import_image/generate_image, wird erst bei Freigabe hochgeladen, KI-Kennzeichnung bleibt) oder https-URL (wird bei Freigabe importiert, dann alt angeben). remove/order/cover verweisen auf mediaId oder productMediaId (aus get_product_images). Entfernte Bilder bleiben in der Medienverwaltung. Varianten mit geerbten Bildern bekommen eine eigene Galerie (geerbte Bilder werden dann nicht mehr gezeigt; sollen sie bleiben, per add mitgeben). Ändert KEINE Alt-Texte vorhandener Medien (dafür propose_alt_texts).`,
        { title: z.string().describe('z. B. "Neue Fotos für Vase Kiesel"'), reason: z.string(),
          products: z.array(z.object({
            productId: z.string(),
            add: z.array(z.object({ image: z.string().describe('mediaId | staged:… | https-URL'), position: z.number().optional().describe('0 = vorne; ohne Angabe ans Ende'), cover: z.boolean().optional().describe('als Titelbild setzen'), alt: z.string().optional().describe('nur für URL-Import') })).optional(),
            remove: z.array(z.string()).optional().describe('mediaId oder productMediaId'),
            order: z.array(z.string()).optional().describe('gewünschte Reihenfolge (mediaId/productMediaId/neues image); Nicht-Genannte folgen dahinter'),
            cover: z.string().optional().describe('Titelbild: mediaId/productMediaId/neues image; ohne Angabe bleibt es (entfernt → erstes Bild)'),
          })) },
        guard(async a => { const cs = await buildProductImagesChangeSet(sw, a); return ok(await session.requestChange(cs)); })),

      tool('propose_alt_texts', `SCHLÄGT Alt-Texte (und optional Titel) für Medien vor, einzeln oder in Masse (max. ${MAX_ITEMS} Bilder). Jedes Bild MUSS vorher mit view_image angesehen worden sein, sonst wird es übersprungen. Alt-Text: konkret beschreiben, was zu sehen ist (Produkt, Farbe, Material, Szene), ≤ ${ALT_MAX} Zeichen, ohne „Bild von“. Gilt überall, wo das Medium verwendet wird. Bei KI-Bildern bleibt „KI-generiert“ im Titel erhalten. Es wird NICHTS geschrieben, bis der Nutzer freigibt.`,
        { title: z.string(), reason: z.string(), images: z.array(z.object({ mediaId: z.string(), alt: z.string(), title: z.string().optional() })) },
        guard(async a => { const cs = await buildAltTextChangeSet(sw, a, viewedImages(session.events)); return ok(await session.requestChange(cs)); })),
    ] as AnyTool[];
  },
};
