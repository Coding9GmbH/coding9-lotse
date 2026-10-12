import 'server-only';
// Shopify: Übersetzungen (translationsRegister je Sprache) und Rabattcodes (DiscountCodeBasic = Promotionen in Lotse) – lesen, vorschlagen, anwenden, rückgängig.
import type { ChangeItem, ChangeSet, UndoOp } from '@/lib/protocol';
import { slugify } from '@/lib/text';
import { MAX_ITEMS, WRITE_CONCURRENCY, cut, errMsg, partialTicker, pool, trackedUndo, type ApplyCtx, type ApplyResult } from '../../changes';
import { newId } from '../../shopware';
import { shortId, toGid, type Json, type ShopifyClient } from './client';
import { collectionsByIds, fmtMoney, idsWhere, money, productsByIds, qField, stripHtml, type Q } from './data';
import { deleteOp, M, reqOp, runCreating, runRecording } from './ops';

// =============== Sprachen + Übersetzungen ===============
export type TrEntity = 'product' | 'category' | 'page';
export const TR_TYPE: Record<TrEntity, string> = { product: 'Product', category: 'Collection', page: 'Page' };
/** Lotse-Feld → Shopify-Übersetzungsschlüssel */
export const TR_KEYS: Record<string, string> = { name: 'title', description: 'body_html', metaTitle: 'meta_title', metaDescription: 'meta_description', handle: 'handle', productType: 'product_type' };
const TR_FIELD = Object.fromEntries(Object.entries(TR_KEYS).map(([k, v]) => [v, k]));
const TR_LABEL: Record<string, string> = { name: 'Name', description: 'Beschreibung', metaTitle: 'Meta-Title', metaDescription: 'Meta-Description', handle: 'URL (Handle)', productType: 'Produkttyp' };

export async function shopLocales(q: Q): Promise<{ locale: string; name: string; primary: boolean; published: boolean }[]> {
  return (await q<Json>('query Locales { shopLocales { locale name primary published } }')).shopLocales;
}
const TR_QUERY = (locale: string) => `query Translations($resourceIds: [ID!]!, $first: Int!) { translatableResourcesByIds(first: $first, resourceIds: $resourceIds) { nodes { resourceId translatableContent { key value digest locale } translations(locale: "${locale.replace(/[^A-Za-z-]/g, '')}") { key value outdated } } } }`;
/** Quelltexte + Übersetzungen einer Sprache für Ressourcen (GIDs) */
export async function readTranslations(q: Q, gids: string[], locale: string): Promise<Map<string, Json>> {
  const out = new Map<string, Json>();
  for (let i = 0; i < gids.length; i += 50) {
    const r = await q<Json>(TR_QUERY(locale), { resourceIds: gids.slice(i, i + 50), first: 50 });
    for (const n of r.translatableResourcesByIds.nodes) out.set(n.resourceId, n);
  }
  return out;
}

export async function buildTranslationChangeSet(q: Q, a: { title: string; reason: string; entity: TrEntity; changes: { id: string; language: string; fields: Record<string, unknown> }[] }): Promise<ChangeSet> {
  if (!a.changes?.length) throw new Error('changes ist leer');
  if (a.changes.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} Einträge pro Änderungsset.`);
  const locales = await shopLocales(q), primary = locales.find(l => l.primary)?.locale;
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = []; let unchanged = 0;
  const byLocale = new Map<string, typeof a.changes>();
  for (const c of a.changes) {
    const loc = locales.find(l => l.locale.toLowerCase() === String(c.language).toLowerCase() || l.locale.toLowerCase() === String(c.language).toLowerCase().split(/[-_]/)[0]);
    if (!loc) { skipped.push({ id: c.id, reason: `Sprache ${c.language} gibt es im Shop nicht (vorhanden: ${locales.map(l => l.locale).join(', ')})` }); continue; }
    if (loc.locale === primary) { skipped.push({ id: c.id, reason: `${loc.locale} ist die Hauptsprache: Texte dort mit propose_product_changes/propose_category_changes ändern` }); continue; }
    byLocale.set(loc.locale, [...(byLocale.get(loc.locale) ?? []), c]);
  }
  const names = new Map<string, string>();
  for (const [locale, list] of byLocale) {
    const gids = [...new Set(list.map(c => toGid(TR_TYPE[a.entity], c.id)))];
    const res = await readTranslations(q, gids, locale);
    if (!names.size) {
      const rows = a.entity === 'product' ? await productsByIds(q, gids, 'id title', 50) : a.entity === 'category' ? await collectionsByIds(q, gids, 'id title') : [];
      rows.forEach(r => names.set(r.id, r.title));
    }
    for (const c of list) {
      const gid = toGid(TR_TYPE[a.entity], c.id), r = res.get(gid);
      if (!r) { skipped.push({ id: c.id, reason: 'nicht gefunden' }); continue; }
      const src = new Map<string, Json>(r.translatableContent.map((x: Json) => [x.key, x])), cur = new Map<string, Json>(r.translations.map((x: Json) => [x.key, x]));
      const label = `${names.get(gid) ?? src.get('title')?.value ?? shortId(gid)} · ${locale}`;
      for (const [field, raw] of Object.entries(c.fields ?? {})) {
        const key = TR_KEYS[field];
        if (!key) { skipped.push({ id: c.id, reason: `Feld ${field} nicht übersetzbar (erlaubt: ${Object.keys(TR_KEYS).join(', ')})` }); continue; }
        if (!src.has(key)) { skipped.push({ id: c.id, reason: `${field}: in der Hauptsprache leer: erst dort pflegen` }); continue; }
        if (typeof raw !== 'string' || !raw.trim()) { skipped.push({ id: c.id, reason: `${field}: Text erwartet` }); continue; }
        let value = raw.trim();
        if (key === 'handle') value = slugify(value);
        const before = cur.get(key);
        if (before?.value === value && !before.outdated) { unchanged++; continue; }
        const warn: string[] = [];
        if (before?.outdated) warn.push('Bisherige Übersetzung ist veraltet (Quelltext wurde geändert)');
        if ((key === 'meta_title' || key === 'title') && value.length > 70) warn.push(`${value.length} Zeichen`);
        items.push({ id: `${shortId(gid)}:${locale}:${field}`, entity: a.entity === 'page' ? 'landing-page' : a.entity, entityId: shortId(gid), label, field, fieldLabel: `${TR_LABEL[field]} (${locale})`,
          before: before?.value ? cut(before.value) : 'leer (zeigt Hauptsprache)', after: cut(value), afterRaw: { resourceId: gid, locale, key, value },
          html: key === 'body_html' ? { before: String(before?.value ?? src.get(key)?.value ?? '').slice(0, 4000), after: value.slice(0, 4000) } : undefined, warn });
      }
    }
  }
  if (!items.length) throw new Error(`Keine Änderung nötig bzw. nichts anwendbar (${unchanged} unverändert, ${skipped.length} übersprungen: ${skipped.slice(0, 3).map(s => s.reason).join('; ')})`);
  return { id: newId(), kind: 'translations', entity: a.entity, title: a.title, reason: a.reason, items, skipped, unchanged, atomic: false, noun: { one: 'Übersetzung', many: 'Übersetzungen' } };
}

export async function applyTranslations(client: ShopifyClient, cs: ChangeSet, selected: Set<string>, ctx?: ApplyCtx): Promise<ApplyResult> {
  const groups = new Map<string, ChangeItem[]>();
  let n = 0;
  for (const it of cs.items) if (selected.has(it.id)) { const r = it.afterRaw as Json, k = `${r.resourceId}|${r.locale}`; groups.set(k, [...(groups.get(k) ?? []), it]); n++; }
  const results: ApplyResult['results'] = [], undo: UndoOp[] = [], tick = partialTicker(ctx, n, { results, undo });
  await pool([...groups.entries()], WRITE_CONCURRENCY, async ([k, its]) => {
    const [resourceId, locale] = k.split('|');
    try {
      const r = (await readTranslations((d, v) => client.gql(d, v), [resourceId], locale)).get(resourceId);
      if (!r) throw new Error('Datensatz nicht mehr vorhanden');
      const digest = new Map<string, string>(r.translatableContent.map((x: Json) => [x.key, x.digest])), cur = new Map<string, Json>(r.translations.map((x: Json) => [x.key, x]));
      const keys = its.map(i => (i.afterRaw as Json).key as string);
      for (const key of keys) if (!digest.get(key)) throw new Error(`${TR_FIELD[key] ?? key}: Quelltext fehlt inzwischen`);
      const prior = keys.filter(key => cur.get(key)?.value), fresh = keys.filter(key => !cur.get(key)?.value), back: UndoOp[] = [];
      if (prior.length) back.push(reqOp('translation', resourceId, M.translationsRegister, { resourceId, translations: prior.map(key => ({ locale, key, value: cur.get(key)!.value, translatableContentDigest: digest.get(key) })) }));
      if (fresh.length) back.push(reqOp('translation', resourceId, M.translationsRemove, { resourceId, translationKeys: fresh, locales: [locale] }));
      await runRecording(client, M.translationsRegister, { resourceId, translations: its.map(i => { const x = i.afterRaw as Json; return { locale, key: x.key, value: x.value, translatableContentDigest: digest.get(x.key) }; }) }, undo, back);
      its.forEach(i => results.push({ itemId: i.id, ok: true }));
    } catch (e) { its.forEach(i => results.push({ itemId: i.id, ok: false, error: errMsg(e) })); }
    finally { tick(); }
  });
  return { results, undo };
}

// =============== Rabattcodes (Promotionen) ===============
export const discountSel = (n = 25) => `id codeDiscount { __typename
  ... on DiscountCodeBasic { title status summary startsAt endsAt usageLimit appliesOncePerCustomer asyncUsageCount
    codesCount { count } codes(first: 5) { nodes { code } }
    combinesWith { productDiscounts orderDiscounts shippingDiscounts }
    context { __typename }
    customerGets { value { __typename ... on DiscountPercentage { percentage } ... on DiscountAmount { amount { amount currencyCode } appliesOnEachItem } }
      items { __typename ... on AllDiscountItems { allItems } ... on DiscountProducts { products(first: ${n}) { nodes { id title } } } ... on DiscountCollections { collections(first: ${n}) { nodes { id title } } } } }
    minimumRequirement { __typename ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount currencyCode } } ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity } } }
  ... on DiscountCodeBxgy { title status summary startsAt endsAt }
  ... on DiscountCodeFreeShipping { title status summary startsAt endsAt } }`;
const STATUS_DE: Record<string, string> = { ACTIVE: 'läuft', SCHEDULED: 'geplant', EXPIRED: 'abgelaufen' };
export const DEFAULT_TZ = 'Europe/Berlin';
const dateDeTz = (iso: string | null | undefined, tz = DEFAULT_TZ) => { if (!iso) return null; try { return new Date(iso).toLocaleDateString('de-DE', { timeZone: tz }); } catch { return new Date(iso).toLocaleDateString('de-DE', { timeZone: DEFAULT_TZ }); } };
/** Versatz der Zeitzone zu UTC in ms zum Zeitpunkt utcMs (Sommer-/Winterzeit berücksichtigt) */
function tzOffsetMs(utcMs: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(utcMs)).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}
/** „JJJJ-MM-TT“ → Tagesbeginn bzw. (end) Tagesende in der Shop-Zeitzone als UTC-ISO; volle Zeitpunkte bleiben, wie sie sind */
export function toIso(d: string, end = false, tz = DEFAULT_TZ): string {
  const s = String(d).trim(), m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const local = Date.UTC(+m[1], +m[2] - 1, +m[3], end ? 23 : 0, end ? 59 : 0, end ? 59 : 0), chk = new Date(local);
    if (chk.getUTCMonth() !== +m[2] - 1 || chk.getUTCDate() !== +m[3]) throw new Error(`Datum „${s}“ ungültig (JJJJ-MM-TT)`);
    let zone = tz; try { tzOffsetMs(local, zone); } catch { zone = DEFAULT_TZ; }
    let t = local - tzOffsetMs(local, zone); t = local - tzOffsetMs(t, zone); // zweiter Durchgang: Versatz am Zieltag selbst (Umstellungstage)
    return new Date(t).toISOString();
  }
  const t = Date.parse(s); if (Number.isNaN(t)) throw new Error(`Datum „${s}“ ungültig (JJJJ-MM-TT)`); return new Date(t).toISOString();
}

/** Rabatt für die KI (nur Zählwerte, keine Einlöser); Datumsanzeige in der Shop-Zeitzone */
export function discountView(n: Json, currency = 'EUR', tz = DEFAULT_TZ) {
  const d = n.codeDiscount ?? {}, v = d.customerGets?.value, items = d.customerGets?.items, min = d.minimumRequirement;
  const value = v?.__typename === 'DiscountPercentage' ? `${Math.round(v.percentage * 10000) / 100} %` : v?.__typename === 'DiscountAmount' ? `${fmtMoney(v.amount.amount, v.amount.currencyCode ?? currency)}${v.appliesOnEachItem ? ' je Artikel' : ''}` : null;
  const scope = !items ? null : items.__typename === 'AllDiscountItems' ? 'alle Artikel' : items.__typename === 'DiscountProducts' ? `Produkte: ${items.products.nodes.map((p: Json) => `${p.title} (${shortId(p.id)})`).join(', ')}` : items.__typename === 'DiscountCollections' ? `Kollektionen: ${items.collections.nodes.map((c: Json) => `${c.title} (${shortId(c.id)})`).join(', ')}` : null;
  return {
    id: shortId(n.id), type: d.__typename?.replace(/^DiscountCode/, '') ?? null, title: d.title, status: STATUS_DE[d.status] ?? d.status, summary: d.summary,
    codes: d.codes?.nodes?.map((c: Json) => c.code) ?? [], codesCount: d.codesCount?.count ?? null, value, appliesTo: scope,
    minimum: min?.__typename === 'DiscountMinimumSubtotal' ? `ab ${fmtMoney(min.greaterThanOrEqualToSubtotal.amount, currency)} Bestellwert` : min?.__typename === 'DiscountMinimumQuantity' ? `ab ${min.greaterThanOrEqualToQuantity} Artikeln` : null,
    startsAt: d.startsAt ?? null, endsAt: d.endsAt ?? null, period: `${dateDeTz(d.startsAt, tz) ?? '?'} bis ${dateDeTz(d.endsAt, tz) ?? 'unbegrenzt'}`,
    usageLimit: d.usageLimit ?? null, oncePerCustomer: d.appliesOncePerCustomer ?? null, timesUsed: d.asyncUsageCount ?? null,
    combinesWith: d.combinesWith ?? null, allBuyers: d.context ? d.context.__typename === 'DiscountBuyerSelectionAll' : null,
  };
}
/** Rabatte per ID über nodes; 10 je Abfrage halten die angefragten Kosten (je Rabatt ≈ 65 mit Produkt-/Kollektionslisten) unter 1000 */
export async function discountsByIds(q: Q, ids: string[]): Promise<Json[]> {
  const gids = [...new Set(ids.map(i => toGid('DiscountCodeNode', i)))], out: Json[] = [];
  for (let i = 0; i < gids.length; i += 10) {
    const r = await q<{ nodes: (Json | null)[] }>(`query DiscountsByIds($ids: [ID!]!) { nodes(ids: $ids) { ... on DiscountCodeNode { ${discountSel()} } } }`, { ids: gids.slice(i, i + 10) });
    out.push(...r.nodes.filter((n): n is Json => !!n?.id));
  }
  return out;
}
export async function listDiscounts(q: Q, o: { status?: string; term?: string; first?: number; after?: string | null }) {
  const parts = [o.status && o.status !== 'all' ? `status:${o.status}` : '', o.term ? `title:*${o.term.replace(/[^\p{L}\p{N} -]/gu, '').split(' ')[0]}*` : ''].filter(Boolean);
  const r = await q<Json>(`query Discounts($first: Int!, $after: String, $query: String) { codeDiscountNodes(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) { nodes { ${discountSel(3)} } pageInfo { hasNextPage endCursor } } }`,
    { first: Math.min(25, o.first ?? 25), after: o.after ?? null, query: parts.join(' AND ') || null });
  return r.codeDiscountNodes;
}

export interface PromotionArgs {
  id?: string; reason: string; title?: string; code?: string;
  type?: 'percentage' | 'amount'; value?: number; appliesOnEachItem?: boolean;
  productIds?: string[]; collectionIds?: string[];
  minimumSubtotal?: number | null; minimumQuantity?: number | null;
  startsAt?: string; endsAt?: string | null; usageLimit?: number | null; oncePerCustomer?: boolean;
  combinesWith?: { productDiscounts?: boolean; orderDiscounts?: boolean; shippingDiscounts?: boolean };
}
const valueInput = (a: PromotionArgs) => {
  if (a.type === 'percentage') { if (!(a.value! > 0 && a.value! <= 100)) throw new Error('Prozent-Rabatt: value zwischen 0 und 100'); return { percentage: Math.round(a.value! * 100) / 10000 }; }
  if (!(a.value! > 0)) throw new Error('Betrag-Rabatt: value > 0'); return { discountAmount: { amount: money(a.value!), appliesOnEachItem: !!a.appliesOnEachItem } };
};

/** shop: Währung und Zeitzone des Shops (Tagesdaten JJJJ-MM-TT gelten in der Shop-Zeitzone) */
export async function buildPromotionChangeSet(q: Q, a: PromotionArgs, shop: { currency: string; timezone?: string }): Promise<{ cs: ChangeSet; payload: Json }> {
  const warn: string[] = [], items: ChangeItem[] = [], { currency } = shop, tz = shop.timezone || DEFAULT_TZ;
  const day = (d: string, end = false) => toIso(d, end, tz), dateDe = (iso: string | null | undefined) => dateDeTz(iso, tz);
  const running = (await listDiscounts(q, { status: 'active', first: 25 })).nodes.map((n: Json) => discountView(n, currency, tz));
  if (a.id) {
    const [cur] = await discountsByIds(q, [a.id]); if (!cur) throw new Error('Rabatt nicht gefunden');
    const v = discountView(cur, currency, tz); if (cur.codeDiscount.__typename !== 'DiscountCodeBasic') throw new Error(`Rabatte vom Typ ${v.type} kann Lotse nicht ändern (nur Prozent/Betrag-Rabattcodes)`);
    const input: Json = {}, show = (f: string, label: string, before: unknown, after: unknown) => items.push({ id: `f:${f}`, entity: 'promotion', entityId: v.id, label: v.title, field: f, fieldLabel: label, before: String(before ?? '–'), after: String(after ?? '–'), warn: [] });
    if (a.title !== undefined && a.title !== v.title) { input.title = a.title; show('title', 'Name', v.title, a.title); }
    if (a.startsAt !== undefined) { input.startsAt = day(a.startsAt); show('startsAt', 'Start', dateDe(v.startsAt), dateDe(input.startsAt)); }
    if (a.endsAt !== undefined) { input.endsAt = a.endsAt === null ? null : day(a.endsAt, true); show('endsAt', 'Ende', dateDe(v.endsAt) ?? 'unbegrenzt', dateDe(input.endsAt) ?? 'unbegrenzt'); if (input.endsAt === null) warn.push('Ohne Enddatum'); }
    if (a.usageLimit !== undefined) { input.usageLimit = a.usageLimit; show('usageLimit', 'Einlösungen gesamt', v.usageLimit ?? 'unbegrenzt', a.usageLimit ?? 'unbegrenzt'); }
    if (a.oncePerCustomer !== undefined) { input.appliesOncePerCustomer = a.oncePerCustomer; show('oncePerCustomer', '1× pro Kunde', v.oncePerCustomer ? 'ja' : 'nein', a.oncePerCustomer ? 'ja' : 'nein'); }
    if (a.value !== undefined) { if (!a.type) throw new Error('type (percentage|amount) mit value angeben'); input.customerGets = { value: valueInput(a) }; show('value', 'Rabatt', v.value, a.type === 'percentage' ? `${a.value} %` : fmtMoney(a.value, currency)); if (a.type === 'percentage' && a.value > 50) warn.push('Rabatt über 50 %'); }
    if (a.combinesWith) { input.combinesWith = a.combinesWith; show('combinesWith', 'Kombinierbar', JSON.stringify(v.combinesWith), JSON.stringify({ ...v.combinesWith, ...a.combinesWith })); }
    if (a.code || a.productIds || a.collectionIds || a.minimumSubtotal !== undefined || a.minimumQuantity !== undefined) throw new Error('Code, Geltungsbereich und Mindestbestellwert bestehender Rabatte ändert Lotse nicht: dafür einen neuen Rabatt anlegen und den alten beenden');
    if (!items.length) throw new Error('Keine Änderung angegeben');
    if (v.timesUsed) warn.push(`Schon ${v.timesUsed}× eingelöst`);
    items[0].warn.push(...warn);
    return { cs: { id: newId(), kind: 'promotion', entity: 'promotion', title: `Rabatt ändern: ${v.title}`, reason: a.reason, items, skipped: [], atomic: true, noun: { one: 'Rabatt', many: 'Rabatte' } }, payload: { id: cur.id, input } };
  }
  // neu
  if (!a.title?.trim() || !a.code?.trim() || !a.type || a.value == null) throw new Error('Neu anlegen: title, code, type und value sind Pflicht');
  const code = a.code.trim(); if (/\s/.test(code) || code.length > 255) throw new Error('Code ohne Leerzeichen, max. 255 Zeichen');
  // Eindeutigkeit des Codes prüft Shopify beim Anlegen (userError TAKEN); laufende Codes warnen unten vorab
  const startsAt = a.startsAt ? day(a.startsAt) : new Date().toISOString(), endsAt = a.endsAt ? day(a.endsAt, true) : null;
  if (endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) throw new Error('Ende liegt vor dem Start');
  let itemsInput: Json = { all: true }, scope = 'alle Artikel';
  if (a.productIds?.length && a.collectionIds?.length) throw new Error('Entweder productIds oder collectionIds');
  if (a.productIds?.length) { const ps = await productsByIds(q, a.productIds, 'id title', 50); if (ps.length !== new Set(a.productIds.map(x => shortId(toGid('Product', x)))).size) throw new Error('Produkt(e) nicht gefunden'); itemsInput = { products: { productsToAdd: ps.map(p => p.id) } }; scope = `Produkte: ${ps.map(p => p.title).join(', ')}`; }
  if (a.collectionIds?.length) { const cs = await collectionsByIds(q, a.collectionIds, 'id title'); if (cs.length !== new Set(a.collectionIds.map(x => shortId(toGid('Collection', x)))).size) throw new Error('Kollektion(en) nicht gefunden'); itemsInput = { collections: { add: cs.map(c => c.id) } }; scope = `Kollektionen: ${cs.map(c => c.title).join(', ')}`; }
  if (a.minimumSubtotal != null && a.minimumQuantity != null) throw new Error('Nur ein Mindestwert: minimumSubtotal oder minimumQuantity');
  const input: Json = {
    title: stripHtml(a.title), code, startsAt, endsAt, context: { all: 'ALL' },
    customerGets: { value: valueInput(a), items: itemsInput },
    ...(a.minimumSubtotal != null ? { minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: money(a.minimumSubtotal) } } } : a.minimumQuantity != null ? { minimumRequirement: { quantity: { greaterThanOrEqualToQuantity: String(Math.floor(a.minimumQuantity)) } } } : {}),
    ...(a.usageLimit != null ? { usageLimit: a.usageLimit } : {}), appliesOncePerCustomer: !!a.oncePerCustomer,
    combinesWith: { productDiscounts: !!a.combinesWith?.productDiscounts, orderDiscounts: !!a.combinesWith?.orderDiscounts, shippingDiscounts: !!a.combinesWith?.shippingDiscounts },
  };
  if (!endsAt) warn.push('Ohne Enddatum');
  if (a.type === 'percentage' && a.value > 50) warn.push('Rabatt über 50 %');
  if (running.some((r: ReturnType<typeof discountView>) => r.codes.some((c: string) => c.toLowerCase() === code.toLowerCase()))) warn.push('Code ist schon bei einem laufenden Rabatt vergeben');
  if (running.length) warn.push(`${running.length} Rabatt(e) laufen bereits (${running.slice(0, 3).map((r: ReturnType<typeof discountView>) => r.title).join(', ')}): Kombinierbarkeit prüfen`);
  const summary = `${a.type === 'percentage' ? `${a.value} %` : fmtMoney(a.value, currency)} auf ${scope}, Code ${code}, ${dateDe(startsAt)} bis ${dateDe(endsAt) ?? 'unbegrenzt'}${a.oncePerCustomer ? ', 1× pro Kunde' : ''}${a.usageLimit ? `, max. ${a.usageLimit} Einlösungen` : ''}${a.minimumSubtotal ? `, ab ${fmtMoney(a.minimumSubtotal, currency)}` : ''}`;
  items.push({ id: 'neu', entity: 'promotion', label: input.title, field: 'create', fieldLabel: 'Neuer Rabattcode', before: '–', after: summary, warn: [...warn, ...(Date.parse(startsAt) > Date.now() ? ['Geplant: startet automatisch am Startdatum'] : [])] });
  return { cs: { id: newId(), kind: 'promotion', entity: 'promotion', title: `Rabatt anlegen: ${input.title}`, reason: a.reason, items, skipped: [], atomic: true, noun: { one: 'Rabatt', many: 'Rabatte' } }, payload: { input } };
}

const priorValue = (v: Json | undefined) => (v?.__typename === 'DiscountPercentage' ? { percentage: v.percentage } : v?.__typename === 'DiscountAmount' ? { discountAmount: { amount: v.amount.amount, appliesOnEachItem: v.appliesOnEachItem } } : undefined);
/** Kartenfeld → Schlüssel im DiscountCodeBasicInput. Anlegen ist eine Zeile (id neu) und bleibt ganz oder gar nicht. */
const PROMO_KEY: Record<string, string> = { title: 'title', startsAt: 'startsAt', endsAt: 'endsAt', usageLimit: 'usageLimit', oncePerCustomer: 'appliesOncePerCustomer', value: 'customerGets', combinesWith: 'combinesWith' };
export async function applyPromotion(client: ShopifyClient, cs: ChangeSet, payload: { id?: string; input: Json }, selected: Set<string>, ctx?: ApplyCtx): Promise<ApplyResult> {
  const chosen = cs.items.filter(i => selected.has(i.id));
  const undo = trackedUndo(ctx, chosen.length);
  if (!chosen.length) return { results: [], undo };
  const input: Json = payload.id
    ? Object.fromEntries(chosen.flatMap(i => { const key = PROMO_KEY[i.field]; return key && Object.prototype.hasOwnProperty.call(payload.input, key) ? [[key, payload.input[key]]] : []; }))
    : payload.input;
  if (payload.id && !Object.keys(input).length) return { results: [], undo };
  try {
    if (!payload.id) {
      const ids = () => idsWhere((d, v) => client.gql(d, v), 'codeDiscountNodes', qField('title', String(payload.input.title ?? '')));
      const r = await runCreating<Json>(client, M.discountCreate, { input: payload.input }, undo, 'discount', ids);
      undo.push(deleteOp('discount', r.codeDiscountNode.id));
    } else {
      const [cur] = await discountsByIds((d, v) => client.gql(d, v), [payload.id]); if (!cur) throw new Error('Rabatt nicht mehr vorhanden');
      const d = cur.codeDiscount, back: Json = {};
      for (const k of Object.keys(input)) {
        if (k === 'customerGets') back.customerGets = { value: priorValue(d.customerGets?.value) };
        else if (k === 'combinesWith') back.combinesWith = d.combinesWith;
        else back[k] = d[k] ?? null;
      }
      await runRecording(client, M.discountUpdate, { id: cur.id, input }, undo, reqOp('promotion', cur.id, M.discountUpdate, { id: cur.id, input: back }));
    }
    return { results: chosen.map(i => ({ itemId: i.id, ok: true })), undo };
  } catch (e) { return { results: chosen.map(i => ({ itemId: i.id, ok: false, error: errMsg(e) })), undo }; }
}

export async function buildPromotionStatusChangeSet(q: Q, a: { ids: string[]; action: 'activate' | 'deactivate'; reason?: string }, shop: { currency: string; timezone?: string }): Promise<ChangeSet> {
  if (!a.ids?.length || a.ids.length > MAX_ITEMS) throw new Error(`ids: 1 bis ${MAX_ITEMS} Rabatte`);
  const rows = await discountsByIds(q, a.ids), items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = [];
  for (const id of a.ids) {
    const n = rows.find(r => shortId(r.id) === shortId(toGid('DiscountCodeNode', id)));
    if (!n) { skipped.push({ id, reason: 'nicht gefunden' }); continue; }
    const v = discountView(n, shop.currency, shop.timezone || DEFAULT_TZ), st = n.codeDiscount.status;
    if (a.action === 'activate' && st === 'ACTIVE') { skipped.push({ id, reason: 'läuft schon' }); continue; }
    if (a.action === 'deactivate' && st === 'EXPIRED') { skipped.push({ id, reason: 'ist schon beendet' }); continue; }
    items.push({ id: v.id, entity: 'promotion', entityId: v.id, label: v.title, field: 'status', fieldLabel: 'Status', before: `${v.status} (${v.period})`, after: a.action === 'activate' ? 'läuft ab jetzt, ohne Enddatum' : 'beendet (Ende = jetzt)',
      afterRaw: a.action, warn: a.action === 'deactivate' && v.codes.length ? [`Code ${v.codes[0]} funktioniert danach nicht mehr`] : a.action === 'activate' ? ['Ein bisheriges Enddatum entfällt'] : [] });
  }
  if (!items.length) throw new Error(`Nichts zu tun: ${skipped.map(s => `${s.id}: ${s.reason}`).join('; ')}`);
  return { id: newId(), kind: 'promotion-status', entity: 'promotion', title: a.action === 'activate' ? 'Rabatte aktivieren' : 'Rabatte beenden', reason: a.reason ?? null, items, skipped, atomic: false, noun: { one: 'Rabatt', many: 'Rabatte' } };
}
export async function applyPromotionStatus(client: ShopifyClient, cs: ChangeSet, selected: Set<string>, ctx?: ApplyCtx): Promise<ApplyResult> {
  const results: ApplyResult['results'] = [], undo: UndoOp[] = [], its = cs.items.filter(i => selected.has(i.id)), tick = partialTicker(ctx, its.length, { results, undo });
  let fresh = new Map<string, Json>();
  try { fresh = new Map((await discountsByIds((d, v) => client.gql(d, v), its.map(i => i.entityId!))).map(n => [shortId(n.id), n])); }
  catch (e) { return { results: its.map(i => ({ itemId: i.id, ok: false, error: errMsg(e) })), undo }; }
  for (const it of its) {
    try {
      const cur = fresh.get(shortId(toGid('DiscountCodeNode', it.entityId!))); if (!cur) throw new Error('Rabatt nicht mehr vorhanden');
      await runRecording(client, it.afterRaw === 'activate' ? M.discountActivate : M.discountDeactivate, { id: cur.id }, undo,
        reqOp('promotion', cur.id, M.discountUpdate, { id: cur.id, input: { startsAt: cur.codeDiscount.startsAt, endsAt: cur.codeDiscount.endsAt ?? null } }));
      results.push({ itemId: it.id, ok: true });
    } catch (e) { results.push({ itemId: it.id, ok: false, error: errMsg(e) }); }
    finally { tick(); }
  }
  return { results, undo };
}
