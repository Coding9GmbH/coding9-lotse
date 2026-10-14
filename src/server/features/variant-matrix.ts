import 'server-only';
// Varianten eines Hauptprodukts: lesen, anlegen (Eigenschaften × Ausprägungen), ändern, löschen – als Änderungsset mit exaktem Rückgängig.
import type { ChangeItem, ChangeSet } from '@/lib/protocol';
import { DEFAULT_CURRENCY, MAX_ITEMS, WRITE_CONCURRENCY, errMsg, eur, net, pool, resolvePrice, trackedUndo, type ApplyCtx, type ApplyResult, type PriceSpec } from '../changes';
import { newId, type Shopware, type ShopReader, type SwEntity } from '../shopware';

export const VARIANTS_KIND = 'variants';
const HEX = /^[0-9a-f]{32}$/i;
const nameOf = (e: SwEntity | null | undefined) => String(e?.translated?.name ?? e?.name ?? '');
const same = (a: string, b: string) => a.trim().toLocaleLowerCase('de-DE') === b.trim().toLocaleLowerCase('de-DE');

export interface AxisInput { group: string; options: string[] }
export interface VariantOverride { options: string[]; price?: number | null; listPrice?: number | null; stock?: number; active?: boolean; productNumber?: string }
export interface VariantChange { price?: PriceSpec; listPrice?: PriceSpec; stock?: number; active?: boolean | null }
export interface VariantsArgs {
  title: string; reason: string; productId: string;
  create?: { axes: AxisInput[]; defaults?: { price?: number | null; listPrice?: number | null; stock?: number; active?: boolean }; overrides?: VariantOverride[] };
  remove?: string[];
  update?: (VariantChange & { id: string })[];
  updateAll?: VariantChange;
}

/** Neue Variante (afterRaw eines create-Items) */
export interface NewVariant { id: string; productNumber: string; optionIds: string[]; price: number | null; listPrice: number | null; stock: number; active: boolean | null }
export interface NewOption { id: string; groupId: string; name: string; position: number }
export interface VariantsPayload { parentId: string; taxRate: number; currencyId: string; newGroups: { id: string; name: string }[]; newOptions: NewOption[] }

interface Opt { id: string; name: string; groupId: string; groupName: string }
/** Alle Kombinationen der Achsen (kartesisches Produkt) */
export const combinations = <T,>(axes: T[][]): T[][] => axes.reduce<T[][]>((acc, ax) => acc.flatMap(c => ax.map(o => [...c, o])), [[]]);
/** Nächste freie Nummer HAUPT.n (höchste vorhandene Endung + 1) */
export function nextSuffix(parentNumber: string, numbers: string[]): number {
  const pre = parentNumber + '.';
  return numbers.reduce((m, n) => (n?.startsWith(pre) && /^\d+$/.test(n.slice(pre.length)) ? Math.max(m, parseInt(n.slice(pre.length), 10)) : m), 0) + 1;
}
const comboKey = (ids: string[]) => [...ids].sort().join('|');
const optLabel = (opts: { groupName: string; name: string }[]) => opts.map(o => `${o.groupName}: ${o.name}`).join(' / ');
/** Ausprägungen einer Variante, stabil nach Eigenschaft sortiert: „Farbe: Sand“, „Größe: M“ */
const optionTexts = (v: SwEntity) => (v.options ?? []).map((o: SwEntity) => `${nameOf(o.group)}: ${nameOf(o)}`).sort((a: string, b: string) => a.localeCompare(b, 'de'));
const variantLabel = (v: SwEntity) => `${optionTexts(v).join(' / ') || nameOf(v) || 'Variante'} (${v.productNumber})`;
const priceText = (v: SwEntity, parent: SwEntity) => (v.price ? eur(v.price[0]?.gross) : `${eur(parent.price?.[0]?.gross)} (geerbt)`);
const activeText = (a: boolean | null | undefined, parentActive: boolean) => (a == null ? `${parentActive ? 'aktiv' : 'inaktiv'} (geerbt)` : a ? 'aktiv' : 'inaktiv');

const VARIANT_ASSOC = { options: { associations: { group: {} } } };
/** Hauptprodukt + Konfigurator + alle Varianten (paginiert; offset wird auf ein Vielfaches von limit gerundet und so zurückgegeben) über den Lese-Client der KI */
export async function loadFamily(ro: ShopReader, productId: string, { limit = 500, offset = 0 } = {}) {
  let parent = await ro.get('product', productId, { associations: { tax: {}, configuratorSettings: { associations: { option: { associations: { group: {} } } } } } });
  if (!parent) throw new Error('Produkt nicht gefunden');
  if (parent.parentId) parent = await ro.get('product', parent.parentId, { associations: { tax: {}, configuratorSettings: { associations: { option: { associations: { group: {} } } } } } });
  if (!parent) throw new Error('Hauptprodukt nicht gefunden');
  const l = Math.max(1, Math.floor(limit)), off = Math.floor(Math.max(0, offset) / l) * l;
  const r = await ro.search('product', { limit: l, page: off / l + 1, filter: [{ type: 'equals', field: 'parentId', value: parent.id }], associations: VARIANT_ASSOC, sort: [{ field: 'productNumber', order: 'ASC' }], 'total-count-mode': 1 });
  return { parent, children: r.data, total: r.total ?? r.data.length, offset: off };
}

/** Lese-Ansicht für get_variants */
export function variantsView(parent: SwEntity, children: SwEntity[], total: number) {
  return {
    parent: { id: parent.id, number: parent.productNumber, name: nameOf(parent), gross: parent.price?.[0]?.gross ?? null, listPriceGross: parent.price?.[0]?.listPrice?.gross ?? null, stock: parent.stock, active: parent.active, taxRate: parent.tax?.taxRate },
    configurator: Object.values((parent.configuratorSettings ?? []).reduce((acc: Record<string, { groupId: string; group: string; options: { id: string; name: string }[] }>, s: SwEntity) => {
      const g = s.option?.group; if (!g) return acc;
      (acc[g.id] ||= { groupId: g.id, group: nameOf(g), options: [] }).options.push({ id: s.option.id, name: nameOf(s.option) });
      return acc;
    }, {})),
    total, returned: children.length,
    variants: children.map(v => ({
      id: v.id, number: v.productNumber, options: optionTexts(v),
      gross: v.price?.[0]?.gross ?? null, priceInherited: !v.price, listPriceGross: v.price?.[0]?.listPrice?.gross ?? null,
      stock: v.stock, active: v.active, activeInherited: v.active == null,
    })),
  };
}

async function findGroup(ro: ShopReader, ref: string): Promise<SwEntity | null> {
  if (HEX.test(ref)) return ro.get('property-group', ref, { associations: { options: {} } });
  const r = await ro.search('property-group', { limit: 25, filter: [{ type: 'contains', field: 'name', value: ref.trim() }], associations: { options: {} } });
  return r.data.find(g => same(nameOf(g), ref)) ?? null;
}

export async function buildVariantsChangeSet(ro: ShopReader, a: VariantsArgs): Promise<{ cs: ChangeSet; payload: VariantsPayload }> {
  if (!a.create?.axes?.length && !a.remove?.length && !a.update?.length && !a.updateAll) throw new Error('Nichts zu tun: create, remove, update oder updateAll angeben');
  const { parent, children, total } = await loadFamily(ro, a.productId, { limit: 500 });
  if (total > children.length) throw new Error(`Hauptprodukt hat ${total} Varianten – mehr als 500 werden hier nicht bearbeitet`);
  const parentName = nameOf(parent), pp = parent.price?.[0];
  const payload: VariantsPayload = { parentId: parent.id, taxRate: parent.tax?.taxRate ?? 19, currencyId: pp?.currencyId ?? DEFAULT_CURRENCY, newGroups: [], newOptions: [] };
  const items: ChangeItem[] = [], skipped: ChangeSet['skipped'] = []; let unchanged = 0;
  const byId = Object.fromEntries(children.map(c => [c.id, c]));
  const removeIds = new Set<string>();

  // ---- Neue Varianten ----
  if (a.create?.axes?.length) {
    const axes: Opt[][] = [];
    for (const ax of a.create.axes) {
      if (!ax.options?.length) throw new Error(`Eigenschaft „${ax.group}“: keine Ausprägungen angegeben`);
      const g = await findGroup(ro, ax.group);
      if (!g && HEX.test(ax.group)) throw new Error(`Eigenschaftsgruppe ${ax.group} nicht gefunden`);
      const groupId = g?.id ?? newId(), groupName = g ? nameOf(g) : ax.group.trim();
      if (!g) { payload.newGroups.push({ id: groupId, name: groupName }); items.push({ id: `grp:${groupId}`, entity: 'info', label: groupName, fieldLabel: 'Neue Eigenschaft', before: '–', after: 'wird angelegt', warn: [] }); }
      const opts: Opt[] = [];
      for (const ref of [...new Set(ax.options.map(o => o.trim()).filter(Boolean))]) {
        const o = (g?.options ?? []).find((x: SwEntity) => x.id === ref || same(nameOf(x), ref));
        if (o) { opts.push({ id: o.id, name: nameOf(o), groupId, groupName }); continue; }
        if (HEX.test(ref)) throw new Error(`Ausprägung ${ref} gehört nicht zu „${groupName}“`);
        const no: NewOption = { id: newId(), groupId, name: ref, position: (g?.options?.length ?? 0) + payload.newOptions.filter(x => x.groupId === groupId).length + 1 };
        payload.newOptions.push(no); opts.push({ id: no.id, name: ref, groupId, groupName });
        items.push({ id: `opt:${no.id}`, entity: 'info', label: `${groupName}: ${ref}`, fieldLabel: 'Neue Ausprägung', before: '–', after: 'wird angelegt (nur wenn eine ausgewählte Variante sie nutzt)', warn: [] });
      }
      axes.push(opts);
    }
    if (new Set(axes.map(x => x[0]?.groupId)).size !== axes.length) throw new Error('Jede Eigenschaft nur einmal als Achse angeben');
    const combos = combinations(axes);
    if (combos.length > MAX_ITEMS) throw new Error(`${combos.length} Kombinationen – maximal ${MAX_ITEMS} pro Änderungsset`);
    const existing = new Set(children.map(c => comboKey(c.optionIds ?? (c.options ?? []).map((o: SwEntity) => o.id))));
    const existingGroups = new Set(children.flatMap(c => (c.options ?? []).map((o: SwEntity) => o.group?.id ?? o.groupId)));
    const groupWarn = children.length && (existingGroups.size !== axes.length || axes.some(x => !existingGroups.has(x[0].groupId)))
      ? `Vorhandene Varianten nutzen andere Eigenschaften (${[...new Set(children.flatMap(c => (c.options ?? []).map((o: SwEntity) => nameOf(o.group))))].join(', ')})` : null;
    const d = a.create.defaults ?? {};
    const numbersTaken = new Set<string>(children.map(c => c.productNumber));
    let n = nextSuffix(parent.productNumber, [...numbersTaken]);
    const planned: { combo: Opt[]; nv: NewVariant; auto: boolean }[] = [];
    const nextNumber = () => { while (numbersTaken.has(`${parent.productNumber}.${n}`)) n++; return `${parent.productNumber}.${n++}`; };
    for (const combo of combos) {
      if (existing.has(comboKey(combo.map(o => o.id)))) { skipped.push({ id: comboKey(combo.map(o => o.id)), reason: `${optLabel(combo)}: Variante existiert bereits` }); continue; }
      const ov = (a.create.overrides ?? []).filter(o => o.options?.length && o.options.every(r => combo.some(c => c.id === r || same(c.name, r)))).reduce<Partial<VariantOverride>>((m, o) => ({ ...m, ...o }), {});
      const price = ov.price !== undefined ? ov.price : d.price ?? null, listPrice = ov.listPrice !== undefined ? ov.listPrice : d.listPrice ?? null;
      const stock = ov.stock ?? d.stock ?? 0, active = ov.active ?? d.active ?? null;
      try {
        if (price != null && !(Number.isFinite(price) && price >= 0)) throw new Error('Preis ungültig');
        if (listPrice != null && !(Number.isFinite(listPrice) && listPrice >= 0)) throw new Error('Streichpreis ungültig');
        if (!Number.isInteger(stock) || stock < 0) throw new Error('Bestand: ganze Zahl ≥ 0 erwartet');
        const productNumber = ov.productNumber?.trim() || nextNumber();
        if (numbersTaken.has(productNumber)) throw new Error(`Produktnummer ${productNumber} doppelt`);
        numbersTaken.add(productNumber);
        planned.push({ auto: !ov.productNumber?.trim(), combo, nv: { id: newId(), productNumber, optionIds: combo.map(o => o.id), price: price == null ? null : Math.round(price * 100) / 100, listPrice: listPrice == null ? null : Math.round(listPrice * 100) / 100, stock, active } });
      } catch (e) { skipped.push({ id: comboKey(combo.map(o => o.id)), reason: `${optLabel(combo)}: ${errMsg(e)}` }); }
    }
    // Produktnummern shopweit prüfen; automatisch vergebene bei Kollision weiterzählen
    const taken = new Set<string>();
    for (let round = 0, check = planned.map(p => p.nv.productNumber); check.length && round < 5; round++) {
      const hit = (await ro.search('product', { limit: check.length, filter: [{ type: 'equalsAny', field: 'productNumber', value: check }] })).data.map(p => String(p.productNumber));
      hit.forEach(x => { taken.add(x); numbersTaken.add(x); });
      const again = planned.filter(p => p.auto && taken.has(p.nv.productNumber));
      again.forEach(p => { p.nv.productNumber = nextNumber(); });
      check = again.map(p => p.nv.productNumber);
    }
    for (const { combo, nv } of planned) {
      if (taken.has(nv.productNumber)) { skipped.push({ id: nv.id, reason: `${optLabel(combo)}: Produktnummer ${nv.productNumber} ist schon vergeben` }); continue; }
      const warn: string[] = [];
      if (groupWarn) warn.push(groupWarn);
      if (nv.price === 0) warn.push('Preis 0 €');
      if (nv.active === true && !parent.active) warn.push('Variante aktiv, Hauptprodukt inaktiv');
      items.push({ id: `new:${nv.id}`, entity: 'product', label: `${parentName}: ${optLabel(combo)}`, field: 'create', fieldLabel: 'Neue Variante', before: '–',
        after: [nv.productNumber, nv.price == null ? `${eur(pp?.gross)} (geerbt)` : eur(nv.price), nv.listPrice != null ? `statt ${eur(nv.listPrice)}` : '', `Bestand ${nv.stock}`, activeText(nv.active, !!parent.active)].filter(Boolean).join(' · '), afterRaw: nv, warn });
    }
    if (planned.length) items.push({ id: 'cfg', entity: 'info', label: parentName, fieldLabel: 'Varianten-Auswahl', before: `${(parent.configuratorSettings ?? []).length} Ausprägungen`, after: 'fehlende Ausprägungen der neuen Varianten werden ergänzt', warn: [] });
  }

  // ---- Varianten löschen ----
  for (const id of [...new Set(a.remove ?? [])]) {
    const v = byId[id];
    if (!v) { skipped.push({ id, reason: 'keine Variante dieses Hauptprodukts' }); continue; }
    removeIds.add(id);
    items.push({ id: `del:${id}`, entity: 'product', entityId: id, label: variantLabel(v), field: 'delete', fieldLabel: 'Variante löschen', before: `${priceText(v, parent)} · Bestand ${v.stock}`, after: 'gelöscht', warn: v.stock > 0 ? [`Bestand ${v.stock}`] : [] });
  }
  if (removeIds.size) items.push({ id: 'cfg-clean', entity: 'info', label: parentName, fieldLabel: 'Varianten-Auswahl', before: '–', after: 'Ausprägungen ohne verbleibende Variante werden entfernt', warn: [] });

  // ---- Varianten ändern (einzeln + alle) ----
  const changes = new Map<string, VariantChange>();
  if (a.updateAll) for (const c of children) if (!removeIds.has(c.id)) changes.set(c.id, { ...a.updateAll });
  for (const u of a.update ?? []) {
    if (!byId[u.id]) { skipped.push({ id: u.id, reason: 'keine Variante dieses Hauptprodukts' }); continue; }
    if (removeIds.has(u.id)) { skipped.push({ id: u.id, reason: 'wird gelöscht' }); continue; }
    const { id, ...rest } = u; changes.set(id, { ...changes.get(id), ...rest });
  }
  if (changes.size > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} Varianten pro Änderungsset`);
  for (const [id, ch] of changes) {
    const v = byId[id], own = v.price?.[0], base = own ?? pp, label = variantLabel(v);
    const add = (field: string, fieldLabel: string, before: string, after: string, afterRaw: unknown, warn: string[] = []) => items.push({ id: `${id}:${field}`, entity: 'product', entityId: id, label, field, fieldLabel, before, after, afterRaw, warn });
    try {
      if (ch.price !== undefined) {
        const cur = base?.gross ?? null, price = resolvePrice(cur, ch.price);
        if (price !== null && !(Number.isFinite(price) && price >= 0)) throw new Error('Preis ungültig');
        if (price === null ? !own : own && price === cur) unchanged++;
        else {
          const warn: string[] = [];
          if (price === 0) warn.push('Preis 0 €');
          if (cur && price != null && Math.abs((price - cur) / cur) >= 0.3) warn.push(`Preisänderung ${price > cur ? '+' : ''}${(((price - cur) / cur) * 100).toFixed(0)} %`);
          add('price', 'Preis (brutto)', own ? eur(cur) : `${eur(cur)} (geerbt)`, price === null ? `erbt vom Hauptprodukt (${eur(pp?.gross)})` : eur(price), price, warn);
        }
      }
      if (ch.listPrice !== undefined) {
        const cur = base?.listPrice?.gross ?? null, lp = resolvePrice(cur, ch.listPrice);
        if (lp !== null && !(Number.isFinite(lp) && lp >= 0)) throw new Error('Streichpreis ungültig');
        if (lp === cur && (own || lp === null)) unchanged++;
        else add('listPrice', 'Streichpreis (brutto)', `${eur(cur)}${own ? '' : ' (geerbt)'}`, lp === null ? 'entfernt' : eur(lp), lp, !own && !items.some(i => i.id === `${id}:price`) ? [`Preis wird fixiert (bisher geerbt: ${eur(pp?.gross)})`] : []);
      }
      if (ch.stock !== undefined) {
        if (!Number.isInteger(ch.stock) || ch.stock < 0) throw new Error('Bestand: ganze Zahl ≥ 0 erwartet');
        if (ch.stock === v.stock) unchanged++; else add('stock', 'Bestand', String(v.stock ?? '–'), String(ch.stock), ch.stock, v.stock > 0 && ch.stock === 0 ? ['Bestand auf 0'] : []);
      }
      if (ch.active !== undefined) {
        if (ch.active !== null && typeof ch.active !== 'boolean') throw new Error('active: true/false/null erwartet');
        if (ch.active === v.active || (ch.active === null && v.active == null)) unchanged++;
        else add('active', 'Aktiv', activeText(v.active, !!parent.active), activeText(ch.active, !!parent.active), ch.active, ch.active === false ? ['Wird deaktiviert'] : []);
      }
    } catch (e) { skipped.push({ id, reason: `${label}: ${errMsg(e)}` }); }
  }

  if (!items.some(i => i.entity !== 'info')) throw new Error(`Keine Änderung nötig bzw. nichts anwendbar (${unchanged} unverändert, ${skipped.length} übersprungen: ${skipped.slice(0, 3).map(s => s.reason).join('; ')})`);
  const cs: ChangeSet = { id: newId(), kind: VARIANTS_KIND, entity: 'product', noun: { one: 'Variante', many: 'Varianten' }, title: a.title, reason: a.reason, items, skipped, unchanged, atomic: false };
  return { cs, payload };
}

// ================= Executor =================
const keepMoney = (m: SwEntity | null | undefined) => (m && m.gross != null ? { currencyId: m.currencyId, gross: m.gross, net: m.net, linked: m.linked ?? true } : undefined);
const priceArr = (p: VariantsPayload, gross: number, list: number | null, regulation?: SwEntity | null) => {
  const regulationPrice = keepMoney(regulation);
  return [{ currencyId: p.currencyId, gross, net: net(gross, p.taxRate), linked: true, ...(list != null ? { listPrice: { currencyId: p.currencyId, gross: list, net: net(list, p.taxRate), linked: true } } : {}), ...(regulationPrice ? { regulationPrice } : {}) }];
};

const KEEP = ['parentId', 'productNumber', 'stock', 'active', 'price', 'purchasePrices', 'ean', 'manufacturerNumber', 'weight', 'width', 'height', 'length', 'minPurchase', 'maxPurchase', 'purchaseSteps', 'isCloseout', 'shippingFree', 'markAsTopseller',
  'deliveryTimeId', 'restockTime', 'releaseDate', 'taxId', 'manufacturerId', 'unitId', 'coverId', 'purchaseUnit', 'referenceUnit', 'cmsPageId', 'featureSetId'];
const TR_KEEP = ['languageId', 'name', 'keywords', 'description', 'metaTitle', 'metaDescription', 'packUnit', 'packUnitPlural', 'customFields', 'customSearchKeywords', 'slotConfig'];
const pick = (o: SwEntity, keys: string[]) => Object.fromEntries(keys.filter(k => o?.[k] != null).map(k => [k, o[k]]));
/** Datensatz, mit dem eine gelöschte Variante exakt wieder angelegt wird (eigene Werte, Zuordnungen, Bilder, Übersetzungen).
 *  Übersetzte Felder (auch customFields) NUR in translations – ein Wert auf oberster Ebene würde die Übersetzung der Systemsprache ersetzen. */
export function variantSnapshot(v: SwEntity): Record<string, unknown> {
  const ids = (list: SwEntity[] | undefined) => (list ?? []).map(x => ({ id: x.id }));
  const tr = (v.translations ?? []).map((t: SwEntity) => pick(t, TR_KEEP)).filter((t: SwEntity) => Object.keys(t).length > 1);
  return {
    ...pick(v, KEEP),
    ...(!v.translations && v.customFields != null ? { customFields: v.customFields } : {}),
    options: ids(v.options), properties: ids(v.properties), categories: ids(v.categories), tags: ids(v.tags),
    ...(v.media?.length ? { media: v.media.map((m: SwEntity) => ({ id: m.id, mediaId: m.mediaId, position: m.position ?? 0 })) } : {}),
    ...(v.prices?.length ? { prices: v.prices.map((p: SwEntity) => ({ id: p.id, ruleId: p.ruleId, quantityStart: p.quantityStart, quantityEnd: p.quantityEnd ?? null, price: p.price })) } : {}),
    ...(v.visibilities?.length ? { visibilities: v.visibilities.map((s: SwEntity) => ({ id: s.id, salesChannelId: s.salesChannelId, visibility: s.visibility })) } : {}),
    ...(tr.length ? { translations: tr } : {}),
  };
}

export async function applyVariants(swW: Shopware, cs: ChangeSet, payload: VariantsPayload, selected: Set<string>, ctx?: ApplyCtx): Promise<ApplyResult> {
  const results: ApplyResult['results'] = [], sel = cs.items.filter(i => selected.has(i.id) && i.entity !== 'info');
  const undo = trackedUndo(ctx, sel.length, results); // jeder Schritt (Eigenschaft, Konfigurator, Variante) sofort gesichert
  const creates = sel.filter(i => i.field === 'create'), deletes = sel.filter(i => i.field === 'delete'), updates = sel.filter(i => i.field !== 'create' && i.field !== 'delete');
  const failAll = (its: ChangeItem[], e: unknown) => its.forEach(i => results.push({ itemId: i.id, ok: false, error: errMsg(e) }));
  const parentId = payload.parentId;

  // 1. Neue Eigenschaften/Ausprägungen – nur, was ausgewählte neue Varianten brauchen
  if (creates.length) {
    const need = new Set(creates.flatMap(i => (i.afterRaw as NewVariant).optionIds));
    const opts = payload.newOptions.filter(o => need.has(o.id)), groups = payload.newGroups.filter(g => opts.some(o => o.groupId === g.id));
    let ready = true;
    try {
      for (const g of groups) { await swW.create('property-group', { id: g.id, name: g.name, displayType: 'text', sortingType: 'alphanumeric' }); undo.push({ op: 'delete', entity: 'property-group', id: g.id }); }
      for (const o of opts) { await swW.create('property-group-option', { id: o.id, groupId: o.groupId, name: o.name, position: o.position }); undo.push({ op: 'delete', entity: 'property-group-option', id: o.id }); }
      // 2. Varianten-Auswahl (Konfigurator) um fehlende Ausprägungen ergänzen
      const have = (await swW.search('product-configurator-setting', { limit: 500, filter: [{ type: 'equals', field: 'productId', value: parentId }] })).data;
      let pos = have.reduce((m, s) => Math.max(m, s.position ?? 0), 0);
      for (const optionId of need) {
        if (have.some(s => s.optionId === optionId)) continue;
        const id = newId(); await swW.create('product-configurator-setting', { id, productId: parentId, optionId, position: ++pos }); undo.push({ op: 'delete', entity: 'product-configurator-setting', id });
      }
    } catch (e) { ready = false; failAll(creates, e); }
    // 3. Varianten anlegen
    if (ready) await pool(creates, WRITE_CONCURRENCY, async it => {
      const v = it.afterRaw as NewVariant;
      try {
        await swW.create('product', { id: v.id, parentId, productNumber: v.productNumber, stock: v.stock, ...(v.active != null ? { active: v.active } : {}), ...(v.price != null ? { price: priceArr(payload, v.price, v.listPrice) } : {}), options: v.optionIds.map(id => ({ id })) });
        undo.push({ op: 'delete', entity: 'product', id: v.id }); results.push({ itemId: it.id, ok: true });
      } catch (e) { failAll([it], e); }
    });
  }

  // 4. Werte ändern (je Variante ein PATCH; Rückgängig = alte eigene Werte, null = wieder geerbt)
  const groups: Record<string, ChangeItem[]> = {};
  for (const it of updates) (groups[it.entityId!] ||= []).push(it);
  await pool(Object.entries(groups), WRITE_CONCURRENCY, async ([id, its]) => {
    try {
      const cur = await swW.get('product', id, { associations: { tax: {} } }); if (!cur) throw new Error('Variante nicht mehr vorhanden');
      const parent = !cur.price ? await swW.get('product', cur.parentId) : null;
      const taxRate = cur.taxId && cur.tax ? cur.tax.taxRate : payload.taxRate; // eigener Steuersatz der Variante hat Vorrang
      const data: Record<string, unknown> = {}, back: Record<string, unknown> = {};
      for (const it of its) if (it.field === 'stock' || it.field === 'active') { data[it.field] = it.afterRaw; back[it.field] = cur[it.field] ?? null; }
      const pi = its.find(i => i.field === 'price'), li = its.find(i => i.field === 'listPrice');
      if (pi || li) {
        const base = (cur.price ?? parent?.price ?? [])[0] ?? {};
        if (pi && pi.afterRaw === null) data.price = null;
        else {
          const gross = (pi ? pi.afterRaw : base.gross) as number | undefined; if (gross == null) throw new Error('Kein Preis vorhanden');
          const lp = (li ? li.afterRaw : base.listPrice?.gross) as number | null | undefined;
          data.price = [{ ...priceArr({ ...payload, taxRate, currencyId: base.currencyId ?? payload.currencyId }, gross, lp ?? null, base.regulationPrice)[0] }, ...(cur.price ?? []).slice(1)];
        }
        back.price = cur.price ?? null;
      }
      await swW.update('product', id, data); undo.push({ op: 'patch', entity: 'product', id, data: back });
      its.forEach(i => results.push({ itemId: i.id, ok: true }));
    } catch (e) { failAll(its, e); }
  });

  // 5. Varianten löschen (vorher vollständige Kopie für Rückgängig sichern)
  await pool(deletes, WRITE_CONCURRENCY, async it => {
    try {
      const v = (await swW.search('product', { ids: [it.entityId!], limit: 1, associations: { options: {}, properties: {}, categories: {}, tags: {}, media: {}, prices: {}, visibilities: {}, translations: {} } })).data[0];
      if (!v) throw new Error('Variante nicht mehr vorhanden');
      if (v.parentId !== parentId) throw new Error('gehört nicht zu diesem Hauptprodukt');
      await swW.req('DELETE', `/product/${v.id}`);
      undo.push({ op: 'create', entity: 'product', id: v.id, data: variantSnapshot(v) }); results.push({ itemId: it.id, ok: true });
    } catch (e) { failAll([it], e); }
  });
  // 6. Ausprägungen ohne verbleibende Variante aus der Auswahl nehmen
  if (deletes.length && results.some(r => r.ok && r.itemId.startsWith('del:'))) {
    try {
      const rest = (await swW.search('product', { limit: 500, filter: [{ type: 'equals', field: 'parentId', value: parentId }], associations: { options: {} } })).data;
      const used = new Set(rest.flatMap(c => (c.options ?? []).map((o: SwEntity) => o.id)));
      const settings = (await swW.search('product-configurator-setting', { limit: 500, filter: [{ type: 'equals', field: 'productId', value: parentId }] })).data;
      for (const s of settings.filter(s => !used.has(s.optionId))) {
        await swW.req('DELETE', `/product-configurator-setting/${s.id}`);
        undo.push({ op: 'create', entity: 'product-configurator-setting', id: s.id, data: pick(s, ['productId', 'optionId', 'position', 'price', 'mediaId', 'customFields']) });
      }
    } catch { /* Aufräumen ist optional – Varianten sind gelöscht */ }
  }
  return { results, undo };
}
