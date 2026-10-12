import 'server-only';
// Lieferanten-Import: Executor (schreibt nur nach Freigabe mit dem privilegierten Client) + exakte Rückgängig-Schritte.
import type { ChangeSet, UndoOp } from '@/lib/protocol';
import { DEFAULT_CURRENCY, WRITE_CONCURRENCY, errMsg, pool, registerApplier, type ApplyCtx, type ApplyResult } from '../changes';
import { importFromUrl } from '../media';
import { newId, type Shopware, type SwEntity } from '../shopware';
import { singleton } from '../state';
import { cleanPrices, planWrite } from './varianten-bulk';
import { IMPORT_KIND, isSelected, type CreatePlan, type ImageJob, type ImportPayload, type ImportPlan, type UpdatePlan, type VariantPlan } from './import-plan';

export interface ImportReport {
  created: { id: string; number: string; name: string; line: number; variants: number }[];
  updated: { id: string; number: string; line: number }[];
  failed: { line: number; number: string; error: string }[];
  imageErrors: string[];
}
// Ergebnis je Änderungsset für das Werkzeug (der Applier läuft innerhalb von requestChange im selben Prozess)
const REPORTS = singleton('import-reports', () => new Map<string, ImportReport>());
export const takeReport = (csId: string) => { const r = REPORTS.get(csId) ?? null; REPORTS.delete(csId); return r; };

const del = (entity: string, id: string): UndoOp => ({ op: 'delete', entity, id });

/** Bild-URL zeigt auf ein Medium dieses Shops (z. B. aus einem eigenen Export) → vorhandenes Medium verwenden statt ein Duplikat hochzuladen */
export async function shopMediaId(sw: Shopware, url: string): Promise<string | null> {
  let u: URL; try { u = new URL(url); } catch { return null; }
  const own = [sw.base, sw.publicUrl].flatMap(b => { try { return b ? [new URL(b).host] : []; } catch { return []; } });
  if (!own.includes(u.host) || !u.pathname.startsWith('/media/')) return null;
  const r = await sw.search('media', { limit: 1, filter: [{ type: 'equals', field: 'path', value: decodeURIComponent(u.pathname.slice(1)) }] }).catch(() => null);
  return (r?.data?.[0]?.id as string | undefined) ?? null;
}

/** Bilder herunterladen und hochladen; ein fehlerhaftes Bild bricht das Produkt nicht ab */
async function uploadImages(swW: Shopware, jobs: ImageJob[], undo: UndoOp[], errors: string[]) {
  const out = new Map<string, { id: string; mediaId: string; position: number }[]>();
  for (const j of jobs) {
    const list: { id: string; mediaId: string; position: number }[] = [];
    for (const url of j.urls) {
      try {
        const own = await shopMediaId(swW, url);
        if (own) { list.push({ id: newId(), mediaId: own, position: list.length }); continue; } // gehört dem Shop – Rückgängig löscht es nicht
        const m = await importFromUrl(swW, url, { alt: j.alt, folder: 'product' }); undo.push(del('media', m.mediaId)); list.push({ id: newId(), mediaId: m.mediaId, position: list.length });
      }
      catch (e) { errors.push(`${j.alt}: ${errMsg(e)}`); }
    }
    if (list.length) out.set(j.productId, list);
  }
  return out;
}

async function applyCreate(swW: Shopware, p: CreatePlan, channels: SwEntity[], undo: UndoOp[], report: ImportReport) {
  const media: UndoOp[] = [];
  const imgs = await uploadImages(swW, p.images, media, report.imageErrors);
  const data = structuredClone(p.product) as Record<string, unknown> & { children?: Record<string, unknown>[] };
  for (const target of [data, ...(data.children ?? [])]) {
    const m = imgs.get(target.id as string);
    if (m) { target.media = m; target.coverId = m[0].id; }
  }
  data.visibilities = channels.map(s => ({ salesChannelId: s.id, visibility: 30 }));
  try { await swW.create('product', data); }
  catch (e) { for (const op of media) await swW.req('DELETE', `/media/${op.id}`).catch(() => {}); throw e; } // keine verwaisten Bilder
  undo.push(...media, del('product', p.id), ...p.childIds.map(id => del('product', id)));
  report.created.push({ id: p.id, number: p.number, name: String(p.product.name), line: p.line, variants: p.childIds.length });
}

async function applyUpdate(swW: Shopware, p: UpdatePlan, undo: UndoOp[], report: ImportReport) {
  const cur = await swW.get('product', p.id, { associations: { tax: {}, properties: {}, categories: {}, media: {} } });
  if (!cur) throw new Error('Produkt nicht mehr vorhanden');
  const parent = cur.parentId && (!cur.price || !cur.tax) ? await swW.get('product', cur.parentId, { associations: { tax: {} } }) : null;
  const data: Record<string, unknown> = { ...p.set }, back: Record<string, unknown> = Object.fromEntries(Object.keys(p.set).map(k => [k, cur[k] ?? null]));
  if (p.price || p.stock !== undefined) {
    const w = planWrite({ id: p.id, group: 'ok', ...(p.price ? { price: p.price } : {}), ...(p.stock !== undefined ? { stock: p.stock } : {}) }, cur, parent);
    for (const k of ['price', 'stock']) if (k in w.row) { data[k] = w.row[k]; back[k] = w.back[k]; }
  }
  if (p.purchase !== undefined) {
    const rate = Number((cur.tax ?? parent?.tax)?.taxRate ?? p.taxRate), currencyId = (cur.price ?? parent?.price)?.[0]?.currencyId ?? DEFAULT_CURRENCY;
    data.purchasePrices = [{ currencyId, net: p.purchase, gross: Math.round(p.purchase * (1 + rate / 100) * 100) / 100, linked: true }];
    back.purchasePrices = cleanPrices(cur.purchasePrices);
  }
  const extra: UndoOp[] = [];
  for (const [assoc, ids] of [['properties', p.addProperties], ['categories', p.addCategories]] as const) {
    const have = new Set((cur[assoc] ?? []).map((x: SwEntity) => x.id)), add = ids.filter(id => !have.has(id));
    if (!add.length) continue;
    data[assoc] = add.map(id => ({ id }));
    for (const id of add) extra.push({ op: 'req', entity: 'product', id: p.id, method: 'DELETE', path: `/product/${p.id}/${assoc}/${id}` });
  }
  const media: UndoOp[] = [];
  if (p.images.length && !(cur.media ?? []).length) {
    const m = (await uploadImages(swW, p.images, media, report.imageErrors)).get(p.id);
    if (m) { data.media = m; if (!cur.coverId) { data.coverId = m[0].id; back.coverId = null; } }
  }
  if (!Object.keys(data).length) { for (const op of media) await swW.req('DELETE', `/media/${op.id}`).catch(() => {}); return; }
  try { await swW.update('product', p.id, data); }
  catch (e) { for (const op of media) await swW.req('DELETE', `/media/${op.id}`).catch(() => {}); throw e; }
  // Rückgängig (rückwärts): Felder zurück, Zuordnungen lösen, Bilder löschen
  undo.push(...media, ...extra, { op: 'patch', entity: 'product', id: p.id, data: back });
  report.updated.push({ id: p.id, number: p.number, line: p.line });
}

async function applyVariants(swW: Shopware, p: VariantPlan, undo: UndoOp[], report: ImportReport) {
  const have = new Set((await swW.search('product-configurator-setting', { limit: 500, filter: [{ type: 'equals', field: 'productId', value: p.id }] })).data.map(s => s.optionId));
  for (const optionId of p.configurator.filter(o => !have.has(o))) {
    const id = newId(); await swW.create('product-configurator-setting', { id, productId: p.id, optionId }); undo.push(del('product-configurator-setting', id));
  }
  const media: UndoOp[] = [];
  const imgs = await uploadImages(swW, p.images, media, report.imageErrors);
  undo.push(...media);
  for (const c of p.children) {
    const m = imgs.get(c.id as string);
    await swW.create('product', { ...c, ...(m ? { media: m, coverId: m[0].id } : {}) });
    undo.push(del('product', c.id as string));
  }
  report.created.push({ id: p.id, number: p.number, name: p.label.replace(/ \([^)]*\)$/, ''), line: p.line, variants: p.children.length });
}

export async function applyImport(swW: Shopware, cs: ChangeSet, payload: ImportPayload, selected: Set<string>, ctx?: ApplyCtx): Promise<ApplyResult> {
  const plans = payload.plans.filter(p => isSelected(p, selected));
  const report: ImportReport = { created: [], updated: [], failed: [], imageErrors: [] };
  const undo: UndoOp[] = [], all: ApplyResult['results'] = [];
  // 1) Neue Hersteller/Eigenschaften – nur, was ausgewählte Produkte brauchen (Gruppe vor Ausprägung)
  const used = new Set(plans.flatMap(p => p.uses));
  for (const c of payload.creates) if (used.has(c.id) && c.needs) used.add(c.needs);
  const order = ['product-manufacturer', 'property-group', 'property-group-option'];
  for (const c of payload.creates.filter(c => used.has(c.id)).sort((a, b) => order.indexOf(a.entity) - order.indexOf(b.entity))) {
    try { await swW.create(c.entity, { id: c.id, ...c.data }); undo.push(del(c.entity, c.id)); }
    catch (e) { REPORTS.set(cs.id, report); return { results: [], undo, error: `${c.label} konnte nicht angelegt werden: ${errMsg(e)}` }; }
  }
  // 2) Produkte (schonend parallel, mit Fortschritt)
  const channels = plans.some(p => p.kind === 'create') ? (await swW.salesChannels()).filter(s => s.domains?.length) : [];
  let done = 0; ctx?.progress?.(0, plans.length);
  await pool(plans, WRITE_CONCURRENCY, async (p: ImportPlan) => {
    const u: UndoOp[] = [];
    try {
      if (p.kind === 'create') await applyCreate(swW, p, channels, u, report);
      else if (p.kind === 'update') await applyUpdate(swW, p, u, report);
      else await applyVariants(swW, p, u, report);
      all.push({ itemId: `p:${p.key}`, ok: true });
    } catch (e) { all.push({ itemId: `p:${p.key}`, ok: false, error: errMsg(e) }); report.failed.push({ line: p.line, number: p.number, error: errMsg(e) }); }
    undo.push(...u); // auch bei Teilfehlern (z. B. Varianten) bleibt Rückgängig vollständig
    ctx?.progress?.(++done, plans.length, { results: all, undo });
  });
  REPORTS.set(cs.id, report);
  if (cs.total == null) return { results: all, undo };
  // Gruppen-Ansicht: je Gruppe eine Zeile + Stichprobe + höchstens 100 Fehler, Zahlen in counts
  const bad = new Map(all.filter(r => !r.ok).map(r => [r.itemId, r])), sample = new Set((cs.sample ?? []).map(i => i.id)), results: ApplyResult['results'] = [];
  for (const g of new Set(plans.map(p => p.group))) {
    const ids = plans.filter(p => p.group === g).map(p => `p:${p.key}`), f = ids.filter(id => bad.has(id)).length;
    results.push({ itemId: `grp:${g}`, ok: !f, ...(f ? { error: `${f} von ${ids.length} fehlgeschlagen` } : {}) });
  }
  results.push(...all.filter(r => sample.has(r.itemId)), ...[...bad.values()].filter(r => !sample.has(r.itemId)).slice(0, 100));
  return { results, undo, counts: { applied: all.length - bad.size, failed: bad.size } };
}

registerApplier(IMPORT_KIND, (swW, cs, payload, selected, ctx) => applyImport(swW, cs, payload as ImportPayload, selected, ctx));
