import 'server-only';
// Multilingual support: read languages/domains/hreflang, read texts per language and propose translations (products, categories,
// landing pages, Shopping Experience elements, alt texts) as a change set. Undo restores the previous state per language.
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { ChangeItem, ChangeSet, UndoOp } from '@/lib/protocol';
import { MAX_ITEMS, assertFresh, normFaq, faqHtml, ensureFieldSet, partialTicker, pool, registerApplier, errMsg, type ApplyCtx, type ApplyResult, type Faq, type RawFaq } from '../changes';
import { HEX32, newId, SYSTEM_LANGUAGE, type Shopware, type ShopReader, type SwEntity } from '../shopware';
import { ok, guard, type AnyTool } from '../tool-kit';
import type { Session } from '../sessions';
import type { Feature } from './types';
import { checkSeg, configLinks, mapConfigLinks, plain, seoKey, seoVariants, shopPath, slotTexts, type Cfg, type Domain, type LinkIndex, type SeoHit, type SlotSeg } from './translations-html';

export { SYSTEM_LANGUAGE };
const SC_TYPES: Record<string, string> = { '8a243080f92e4c719546314b577cf82b': 'Storefront', 'f183ee5650cf4bdb8a774337575067a6': 'Headless', 'ed535e5722134ac1aa6524f73e26881b': 'Produktvergleich' };
const cut = (t: unknown, n = 160) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const textOf = (v: unknown) => (typeof v === 'string' ? plain(v) : '');

// ---- Languages ----
export interface Lang { id: string; name: string; locale: string; parentId: string | null; system: boolean }
export async function loadLanguages(ro: ShopReader): Promise<Lang[]> {
  const r = await ro.search('language', { limit: 100, associations: { locale: {} } });
  return r.data.map(l => ({ id: l.id, name: l.translated?.name ?? l.name, locale: l.locale?.code ?? '', parentId: l.parentId ?? null, system: l.id === SYSTEM_LANGUAGE }))
    .sort((a, b) => Number(b.system) - Number(a.system) || a.name.localeCompare(b.name));
}
/** Language by ID, locale ("en-GB", also "en" if unambiguous) or name */
export function resolveLang(langs: Lang[], ref: string): Lang {
  const r = String(ref ?? '').trim().toLowerCase();
  const hit = langs.find(l => l.id === r) ?? langs.find(l => l.locale.toLowerCase() === r) ?? langs.find(l => l.name.toLowerCase() === r);
  if (hit) return hit;
  const pre = langs.filter(l => l.locale.toLowerCase().split('-')[0] === r);
  if (pre.length === 1) return pre[0];
  throw new Error(`Sprache „${ref}“ unbekannt${pre.length > 1 ? ' (mehrdeutig)' : ''}. Vorhanden: ${langs.map(l => `${l.name} (${l.locale})`).join(', ')}`);
}
/** Fallback chain of a language: own → parent language → system language */
export const fallbackChain = (langs: Lang[], l: Lang): Lang[] => { const out = [l]; let p = l.parentId ? langs.find(x => x.id === l.parentId) : undefined; while (p && !out.includes(p)) { out.push(p); p = p.parentId ? langs.find(x => x.id === p!.parentId) : undefined; } const sys = langs.find(x => x.system); if (sys && !out.includes(sys)) out.push(sys); return out; };

export async function languageOverview(ro: ShopReader) {
  const [langs, sc] = await Promise.all([loadLanguages(ro), ro.search('sales-channel', { limit: 50, associations: { domains: {}, languages: {} } }).then(r => r.data)]);
  const domainUrl = (id: string | null | undefined) => sc.flatMap(s => s.domains ?? []).find((d: SwEntity) => d.id === id)?.url ?? null;
  return {
    systemLanguage: langs.find(l => l.system)?.name ?? null,
    languages: langs.map(l => {
      const chans = sc.filter(s => (s.languages ?? []).some((x: SwEntity) => x.id === l.id) || s.languageId === l.id);
      const domains = chans.flatMap(s => (s.domains ?? []).filter((d: SwEntity) => d.languageId === l.id).map((d: SwEntity) => ({ salesChannel: s.translated?.name ?? s.name, url: d.url as string })));
      return {
        id: l.id, name: l.name, locale: l.locale, systemDefault: l.system, inheritsFrom: fallbackChain(langs, l).slice(1).map(x => x.name),
        salesChannels: chans.map(s => ({ name: s.translated?.name ?? s.name, type: SC_TYPES[s.typeId] ?? s.typeId, defaultLanguage: s.languageId === l.id })),
        domains, storefrontReachable: domains.some(d => /^https?:\/\//.test(d.url)),
      };
    }),
    hreflang: sc.filter(s => SC_TYPES[s.typeId] === 'Storefront').map(s => ({
      salesChannel: s.translated?.name ?? s.name, active: !!s.hreflangActive, defaultDomain: domainUrl(s.hreflangDefaultDomainId),
      domains: (s.domains ?? []).map((d: SwEntity) => ({ url: d.url, language: langs.find(l => l.id === d.languageId)?.locale ?? d.languageId })),
      hint: (s.domains ?? []).length < 2 ? 'Nur eine Domain: hreflang greift erst mit je einer Domain pro Sprache.' : !s.hreflangActive ? 'hreflang ist aus: in den Verkaufskanal-Einstellungen aktivieren (Admin).' : !s.hreflangDefaultDomainId ? 'Keine x-default-Domain gesetzt.' : 'ok',
    })),
    note: 'Felder ohne eigene Übersetzung erben (Sprache → Elternsprache → Systemsprache). Texte in der Systemsprache gelten für alle Sprachen ohne eigenen Wert.',
  };
}

// ---- Translatable fields ----
type TrKind = 'str' | 'html' | 'faq';
export type TrEntity = 'product' | 'category' | 'landing-page';
interface TrField { label: string; kind: TrKind; max?: number }
const STR = (label: string, max = 255): TrField => ({ label, kind: 'str', max });
export const TR_ENTITIES: Record<TrEntity, { noun: { one: string; many: string }; alias: string; fields: Record<string, TrField> }> = {
  product: { noun: { one: 'Produkt', many: 'Produkte' }, alias: 'product', fields: { name: STR('Name'), description: { label: 'Beschreibung', kind: 'html' }, metaTitle: STR('Meta-Title'), metaDescription: STR('Meta-Description'), keywords: STR('Keywords', 1000), faq: { label: 'FAQ', kind: 'faq' } } },
  category: { noun: { one: 'Kategorie', many: 'Kategorien' }, alias: 'category', fields: { name: STR('Name'), description: { label: 'Beschreibung', kind: 'html' }, metaTitle: STR('Meta-Title'), metaDescription: STR('Meta-Description'), keywords: STR('Keywords', 1000) } },
  'landing-page': { noun: { one: 'Landingpage', many: 'Landingpages' }, alias: 'landing_page', fields: { name: STR('Name'), metaTitle: STR('Meta-Title'), metaDescription: STR('Meta-Description'), keywords: STR('Keywords', 1000), url: STR('URL-Pfad') } },
};
const ownFaq = (row: SwEntity | undefined) => (row?.customFields?.aicb_blocks?.faq as { q: string; a: string }[] | undefined) ?? null;
const ownVal = (row: SwEntity | undefined, field: string) => (field === 'faq' ? ownFaq(row) : row?.[field] ?? null);
const effVal = (row: SwEntity | undefined, field: string) => (field === 'faq' ? ((row?.translated?.customFields?.aicb_blocks?.faq as unknown[]) ?? null) : row?.translated?.[field] ?? null);
const isEmpty = (v: unknown) => v == null || (typeof v === 'string' && !textOf(v)) || (Array.isArray(v) && !v.length);
const faqText = (f: { q: string; a: string }[] | null | undefined) => (f ?? []).map(i => `F: ${i.q}\nA: ${i.a}`).join('\n\n');
const label = (entity: TrEntity, r: SwEntity | undefined, id: string) => { const n = r?.translated?.name ?? r?.name ?? id; return entity === 'product' && r?.productNumber ? `${n} (${r.productNumber})` : n; };

/** Reads the same records per language (own values + inherited values) */
async function readPerLanguage(ro: ShopReader, entity: TrEntity, ids: string[], langs: Lang[]) {
  const def = TR_ENTITIES[entity], fields = Object.keys(def.fields).filter(f => f !== 'faq');
  const includes = { [def.alias]: ['id', 'productNumber', 'parentId', ...fields, 'customFields', 'translated'] };
  const out = new Map<string, Map<string, SwEntity>>(); // languageId → id → row
  await Promise.all(langs.map(async l => { const r = await ro.search(entity, { ids, limit: ids.length, includes }, { languageId: l.id }); out.set(l.id, new Map(r.data.map(x => [x.id, x]))); }));
  return out;
}

export interface ReadArgs { entity: TrEntity; ids?: string[]; categoryId?: string; term?: string; languages?: string[]; onlyMissing?: boolean; full?: boolean; limit?: number; offset?: number }
export async function readTranslations(ro: ShopReader, a: ReadArgs) {
  const def = TR_ENTITIES[a.entity]; if (!def) throw new Error('entity: product, category oder landing-page');
  const all = await loadLanguages(ro), langs = a.languages?.length ? [...new Set(a.languages.map(x => resolveLang(all, x)))] : all;
  const limit = Math.min(Math.max(1, a.limit ?? 20), a.full ? 10 : 50), offset = a.offset ?? 0;
  const filter: Record<string, unknown>[] = [];
  if (a.entity === 'product') { if (!a.ids?.length) filter.push({ type: 'equals', field: 'parentId', value: null }); if (a.categoryId) filter.push({ type: 'equals', field: 'categoriesRo.id', value: a.categoryId }); }
  else if (a.categoryId) throw new Error('categoryId nur bei entity=product');
  const idList = a.ids?.length ? [...new Set(a.ids)] : null, pageIds = idList?.slice(offset, offset + limit);
  if (pageIds && !pageIds.length) return { entity: a.entity, total: idList!.length, offset, returned: 0, items: [], hint: `offset ${offset} liegt hinter den ${idList!.length} ids.` };
  const page = await ro.search(a.entity, { limit, page: pageIds ? 1 : Math.floor(offset / limit) + 1, 'total-count-mode': 1, ...(pageIds ? { ids: pageIds } : {}), ...(a.term ? { term: a.term } : {}), filter, ...(a.entity === 'product' && !a.term ? { sort: [{ field: 'productNumber', order: 'ASC' }] } : {}), includes: { [def.alias]: ['id', 'name', 'productNumber', 'translated'] } });
  const ids = page.data.map(r => r.id), total = idList ? idList.length : page.total ?? page.data.length;
  const per = ids.length ? await readPerLanguage(ro, a.entity, ids, langs) : new Map();
  const max = a.full ? 20000 : 600;
  const gaps = new Set<string>(); // records with gaps in a non-system language
  const keyOf = (l: Lang) => (l.locale && langs.filter(x => x.locale === l.locale).length === 1 ? l.locale : `${l.locale || l.name} (${l.id})`); // same locale twice → append ID
  const rows = page.data.map(base => {
    const languages: Record<string, unknown> = {};
    for (const l of langs) {
      const r = per.get(l.id)?.get(base.id) as SwEntity | undefined, values: Record<string, unknown> = {}, inherited: string[] = [], empty: string[] = [];
      for (const f of Object.keys(def.fields)) {
        const own = ownVal(r, f), eff = effVal(r, f);
        if (!isEmpty(own)) values[f] = f === 'faq' ? own : cut(own, f === 'description' ? max : 1000);
        else if (!isEmpty(eff)) { inherited.push(f); if (!l.system) gaps.add(base.id); }
        else empty.push(f);
      }
      languages[keyOf(l)] = { language: l.name, values, ...(inherited.length ? { inherited } : {}), ...(empty.length ? { empty } : {}) };
    }
    return { id: base.id, name: base.translated?.name ?? base.name, ...(base.productNumber ? { number: base.productNumber } : {}), languages };
  });
  const list = a.onlyMissing ? rows.filter(r => gaps.has(r.id)) : rows;
  return {
    entity: a.entity, total, offset, scanned: rows.length, returned: list.length, languages: langs.map(l => ({ id: l.id, name: l.name, locale: l.locale, systemDefault: l.system })),
    items: list,
    hint: 'values = eigener Wert der Sprache; inherited = kein eigener Wert, im Shop erscheint der Text der Rückfallsprache (meist Systemsprache); empty = auch geerbt leer.' + (offset + limit < total ? ` Weitere: offset=${offset + limit}.` : '') + (a.onlyMissing ? ' onlyMissing filtert nur die gelesene Seite (scanned): returned=0 heißt nicht, dass es keine Lücken mehr gibt; weitere Seiten per offset prüfen.' : ''),
  };
}

// ---- Change set: translations of products/categories/landing pages ----
/** afterRaw of a translation item */
export interface TrRaw { languageId: string; field: string; value: unknown }
/** afterRaw of an element item (cms-slot): only the changed config keys; the executor reads the rest of the config fresh and untruncated when writing
 *  from the shop (language baseLanguageId) and merges the patch in. This way neither the full element config ends up in the change set nor a
 *  version scrubbed by the read guard (sensitive keys removed) as a translation in the shop. */
export interface SlotRaw { languageId: string; field: 'config'; patch: Record<string, unknown>; baseLanguageId: string }
/** Own value of a language (stale-write guard): when proposing from the language's row, when writing from the translation row.
 *  Element config only in the patched keys (the rest of the config is not in the set); empty patch (texts saved) = the language had no own config. */
export function ownOf(row: SwEntity | undefined | null, r: TrRaw | SlotRaw): unknown {
  if ('patch' in r) { const cfg = row?.config ?? null, keys = Object.keys(r.patch); return keys.length ? Object.fromEntries(keys.map(k => [k, cfg?.[k] ?? null])) : cfg; }
  return r.field === 'faq' ? ownFaq(row ?? undefined) : row?.[r.field] ?? null;
}
export interface TrChange { id: string; language: string; fields: Record<string, unknown> }
export interface TrArgs { title: string; reason: string; entity: TrEntity; changes: TrChange[]; keepInherited?: boolean }

function checkVal(f: TrField, field: string, v: unknown, lang: Lang, name: string): unknown {
  if (v === null) { if (lang.system && field === 'name') throw new Error('Name der Systemsprache darf nicht leer sein'); return null; }
  if (f.kind === 'faq') {
    const raw = v as RawFaq & { title?: unknown };
    if (!lang.locale.startsWith('de') && !(raw && !Array.isArray(raw) && typeof raw.title === 'string' && raw.title.trim())) throw new Error('FAQ: title in der Zielsprache angeben');
    return normFaq(raw, name);
  }
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${f.label}: Text erwartet (null = eigene Übersetzung entfernen)`);
  if (f.max && v.length > f.max) throw new Error(`${f.label}: max. ${f.max} Zeichen`);
  if (field === 'url' && !/^[\p{Ll}\d]+(?:[-_./][\p{Ll}\d]+)*$/u.test(v.trim())) throw new Error('URL-Pfad: nur Kleinbuchstaben, Ziffern und - _ . / (ohne Leerzeichen, ohne / am Anfang/Ende), z. B. "sommer-deko"');
  return f.kind === 'str' ? v.trim() : v;
}
const seoWarn = (field: string, v: unknown) => {
  if (typeof v !== 'string') return [];
  if (field === 'metaTitle' && v.length > 60) return [`Meta-Title ${v.length} Zeichen (> 60)`];
  if (field === 'metaDescription' && (v.length > 160 || v.length < 100)) return [`Meta-Description ${v.length} Zeichen (empfohlen 120 bis 158)`];
  return [];
};
const show = (field: string, v: unknown) => (v == null ? '–' : field === 'faq' ? `${(Array.isArray(v) ? v : (v as Faq).items ?? []).length} Fragen` : cut(textOf(v) || v));

export async function buildTranslationChangeSet(ro: ShopReader, a: TrArgs): Promise<ChangeSet> {
  const def = TR_ENTITIES[a.entity]; if (!def) throw new Error('entity: product, category oder landing-page');
  if (!a.changes?.length) throw new Error('changes ist leer');
  if (a.changes.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} Einträge pro Änderungsset, bitte aufteilen.`);
  const langs = await loadLanguages(ro), sys = langs.find(l => l.system)!;
  const ids = [...new Set(a.changes.map(c => c.id))];
  const per = await readPerLanguage(ro, a.entity, ids, langs);
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = []; let unchanged = 0;
  const seen = new Set<string>(), explicit = new Set<string>();
  for (const c of a.changes) { try { const l = resolveLang(langs, c.language); Object.keys(c.fields ?? {}).forEach(f => explicit.add(`${c.id}:${l.id}:${f}`)); } catch { /* reported below */ } }
  const push = (it: ChangeItem) => { if (seen.has(it.id)) { skipped.push({ id: it.entityId!, reason: `${it.label}: ${it.fieldLabel} doppelt, nur der erste Wert zählt` }); return; } seen.add(it.id); items.push(it); };
  for (const ch of a.changes) {
    let lang: Lang; try { lang = resolveLang(langs, ch.language); } catch (e) { skipped.push({ id: ch.id, reason: errMsg(e) }); continue; }
    const row = per.get(lang.id)?.get(ch.id), sysRow = per.get(sys.id)?.get(ch.id);
    if (!row || !sysRow) { skipped.push({ id: ch.id, reason: 'nicht gefunden' }); continue; }
    const name = label(a.entity, sysRow, ch.id);
    for (const [field, raw] of Object.entries(ch.fields ?? {})) {
      const f = def.fields[field];
      if (!f) { skipped.push({ id: ch.id, reason: `Feld „${field}“ nicht übersetzbar (erlaubt: ${Object.keys(def.fields).join(', ')})` }); continue; }
      try {
        const value = checkVal(f, field, raw, lang, row.translated?.name ?? name);
        const own = ownVal(row, field), eff = effVal(row, field);
        const cmp = field === 'faq' ? (value as Faq | null)?.items ?? null : value;
        // FAQ null with an existing own aicb_blocks (e.g. {faq: null}) is a change: only then does the language inherit again
        if (JSON.stringify(cmp) === JSON.stringify(own) && !(field === 'faq' && value == null && row.customFields?.aicb_blocks != null)) { unchanged++; continue; }
        const warn = seoWarn(field, value);
        if (!lang.system && value != null && field !== 'name' && field !== 'url' && JSON.stringify(cmp) === JSON.stringify(ownVal(sysRow, field))) warn.push(`identisch mit ${sys.name}, nicht übersetzt?`);
        const rowOf = (l: Lang) => per.get(l.id)?.get(ch.id);
        // null: which text is visible afterwards (first own value in the fallback chain)
        const inheritsAfter = value == null ? fallbackChain(langs, lang).slice(1).map(l => ({ l, v: ownVal(rowOf(l), field) })).find(x => !isEmpty(x.v)) : undefined;
        if (value == null && field === 'faq' && Object.keys(row.customFields?.aicb_blocks ?? {}).some(k => k !== 'faq' && k !== 'faq_html')) warn.push('aicb_blocks enthält weitere eigene Inhalte: FAQ wird in dieser Sprache entfernt, erbt aber nicht');
        // System language is changed: affected are languages that inherit the field all the way to the system language (without an explicit own entry in the set)
        const heirs = lang.system ? langs.filter(l => { if (l.system) return false; const ch2 = fallbackChain(langs, l); const before = ch2.slice(0, ch2.findIndex(x => x.system)); return before.every(x => isEmpty(ownVal(rowOf(x), field)) && !explicit.has(`${ch.id}:${x.id}:${field}`)); }) : [];
        const hv = ownVal(sysRow, field), saved: Lang[] = [], mixed: Lang[] = [], follow: Lang[] = [];
        for (const h of heirs) {
          if (a.keepInherited !== false && !isEmpty(hv)) saved.push(h);
          else if (value != null && isEmpty(hv)) mixed.push(h);
          else follow.push(h);
        }
        const verb = (ls: Lang[]) => `${ls.map(l => l.name).join(', ')} ${ls.length > 1 ? 'erben' : 'erbt'} dieses Feld`;
        if (saved.length) warn.push(`${verb(saved)}: bisheriger Text wird dort gesichert`);
        if (mixed.length) warn.push(`${verb(mixed)} und ${mixed.length > 1 ? 'zeigen' : 'zeigt'} danach diesen Text (${lang.name}). Eigene Fassung in ${mixed.map(l => l.name).join(', ')} mitliefern`);
        if (follow.length) warn.push(`${verb(follow)} und ${follow.length > 1 ? 'ändern' : 'ändert'} sich mit`);
        const html = f.kind === 'html' || f.kind === 'faq' || String(value ?? '').length > 160
          ? { before: field === 'faq' ? faqText((own ?? eff) as { q: string; a: string }[]) : textOf(own ?? eff).slice(0, 4000), after: field === 'faq' ? faqText((value as Faq | null)?.items ?? (inheritsAfter?.v as { q: string; a: string }[] | undefined)) : textOf(value ?? inheritsAfter?.v).slice(0, 4000) } : undefined;
        push({ id: `${ch.id}:${lang.id}:${field}`, entity: a.entity, entityId: ch.id, label: `${name} · ${lang.name}`, field, fieldLabel: `${f.label} (${lang.locale})`,
          before: isEmpty(own) ? (isEmpty(eff) ? '–' : `erbt: ${show(field, eff)}`) : show(field, own),
          after: value == null ? (inheritsAfter ? `eigene Übersetzung entfernen (erbt ${inheritsAfter.l.name}: ${show(field, inheritsAfter.v)})` : 'eigenen Wert entfernen (danach leer)') : show(field, value),
          afterRaw: { languageId: lang.id, field, value } satisfies TrRaw, beforeRaw: own ?? null, html, warn });
        // inheriting languages keep their visible text (own value = previous text of the system language)
        for (const h of saved) {
          const blocks = sysRow.customFields?.aicb_blocks;
          push({ id: `${ch.id}:${h.id}:${field}`, entity: a.entity, entityId: ch.id, label: `${name} · ${h.name}`, field, fieldLabel: `${f.label} (${h.locale}) sichern`,
            before: `erbt: ${show(field, hv)}`, after: `eigener Wert = bisheriger Text`, afterRaw: { languageId: h.id, field, value: field === 'faq' ? { title: plain(String(blocks?.faq_html ?? '').match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? '') || `Häufige Fragen zu ${name}`, items: hv, ...(typeof blocks?.faq_html === 'string' ? { html: blocks.faq_html } : {}) } : hv } satisfies TrRaw, beforeRaw: ownVal(rowOf(h), field) ?? null, warn: [] });
        }
      } catch (e) { skipped.push({ id: ch.id, reason: `${name} · ${lang.name} · ${field}: ${errMsg(e)}` }); }
    }
  }
  if (!items.length) throw new Error(`Keine Änderung nötig bzw. nichts anwendbar (${unchanged} unverändert, ${skipped.length} übersprungen: ${skipped.slice(0, 3).map(s => s.reason).join('; ')})`);
  return { id: newId(), kind: 'translations', entity: a.entity, noun: def.noun, applyLabel: 'Übersetzungen übernehmen', title: a.title, reason: a.reason, items, skipped, unchanged, atomic: false };
}

// ---- Shopping Experiences: element texts per language ----
const cmsCriteria = { associations: { sections: { sort: [{ field: 'position' }], associations: { blocks: { sort: [{ field: 'position' }], associations: { slots: {} } } } } } };
export interface PageSlot { key: string; id: string; slot: string; type: string; block: string; blockNo: number; config: Cfg | null; own: Cfg | null; mediaId: string | null }
/** Slots in reading order; key "s{n}" is stable as long as the layout does not change. config = effective (with inheritance), own = the language's own value */
export async function loadPageSlots(ro: ShopReader, cmsPageId: string, languageId: string): Promise<{ page: SwEntity; slots: PageSlot[] }> {
  const page = await ro.get('cms-page', cmsPageId, cmsCriteria, { languageId });
  if (!page) throw new Error(`CMS-Layout ${cmsPageId} nicht gefunden`);
  const slots: PageSlot[] = []; let blockNo = 0;
  for (const s of [...(page.sections ?? [])].sort((x: SwEntity, y: SwEntity) => x.position - y.position)) for (const b of [...(s.blocks ?? [])].sort((x: SwEntity, y: SwEntity) => x.position - y.position)) {
    blockNo++;
    for (const sl of [...(b.slots ?? [])].sort((x: SwEntity, y: SwEntity) => String(x.slot).localeCompare(String(y.slot)))) {
      const config = sl.translated?.config ?? sl.config ?? null, m = config?.media;
      slots.push({ key: `s${slots.length}`, id: sl.id, slot: sl.slot, type: sl.type, block: b.type, blockNo, config, own: sl.config ?? null, mediaId: m && m.source !== 'mapped' && typeof m.value === 'string' && HEX32.test(m.value) ? m.value : null });
    }
  }
  return { page, slots };
}
// Image alt texts per language (without access to the media library: no alt texts)
async function mediaAlts(ro: ShopReader, ids: string[], languageId: string) {
  if (!ids.length) return new Map<string, SwEntity>();
  const r = await ro.search('media', { ids, limit: ids.length }, { languageId }).catch(() => ({ data: [] as SwEntity[] }));
  return new Map(r.data.map(m => [m.id, m]));
}

/** Default source language: system language; if it is the target itself, a storefront's default language (e.g. German) */
async function defaultSource(ro: ShopReader, langs: Lang[], tgt: Lang | null): Promise<Lang> {
  const sys = langs.find(l => l.system)!;
  if (!tgt?.system) return sys;
  const sc = (await ro.salesChannels()).find(s => SC_TYPES[s.typeId] === 'Storefront' && s.languageId !== tgt.id);
  const l = langs.find(x => x.id === sc?.languageId) ?? langs.find(x => !x.system);
  if (!l) throw new Error('Quellsprache angeben (source)');
  return l;
}

export interface PageTextsArgs { cmsPageId: string; source?: string; target?: string }
export async function readPageTexts(ro: ShopReader, a: PageTextsArgs) {
  const langs = await loadLanguages(ro), tgt = a.target ? resolveLang(langs, a.target) : null, src = a.source ? resolveLang(langs, a.source) : await defaultSource(ro, langs, tgt);
  const { page, slots } = await loadPageSlots(ro, a.cmsPageId, src.id);
  const tslots = tgt ? (await loadPageSlots(ro, a.cmsPageId, tgt.id)).slots : [];
  const mids = [...new Set(slots.map(s => s.mediaId).filter((x): x is string => !!x))];
  const [sm, tm] = await Promise.all([mediaAlts(ro, mids, src.id), tgt ? mediaAlts(ro, mids, tgt.id) : Promise.resolve(new Map<string, SwEntity>())]);
  let n = 0;
  const out = slots.map(s => {
    const texts: { key: string; kind: string; attr?: string; text: string }[] = slotTexts(s.config as Cfg, s.key).segs.map(g => ({ key: g.key, kind: g.kind, ...(g.attr ? { attr: g.attr } : {}), text: g.src }));
    const alt = s.mediaId ? sm.get(s.mediaId)?.translated?.alt : null;
    if (alt) texts.push({ key: `${s.key}.alt`, kind: 'mediaAlt', text: alt });
    n += texts.length;
    const t = tslots.find(x => x.id === s.id);
    return { key: s.key, block: `${s.blockNo}: ${s.block}`, element: `${s.slot} (${s.type})`, ...(tgt ? { targetHasOwn: !!t?.own, ...(s.mediaId ? { targetAlt: tm.get(s.mediaId)?.alt ?? null } : {}) } : {}), texts, links: configLinks(s.config as Cfg) };
  }).filter(s => s.texts.length || s.links.length);
  return {
    cmsPage: { id: page.id, name: page.translated?.name ?? page.name, type: page.type }, sourceLanguage: `${src.name} (${src.locale})`, ...(tgt ? { targetLanguage: `${tgt.name} (${tgt.locale})` } : {}), segments: n, slots: out,
    hint: 'Für propose_page_translation JEDEN key übersetzen (texts: {key: Übersetzung}). kind text = HTML-Schnipsel: Inline-Tags (<strong>, <a …>, <br>) genau so übernehmen; attr/value/mediaAlt = reiner Text. Links werden automatisch auf die Zielsprache umgestellt.',
  };
}

async function linkIndex(ro: ShopReader, links: string[], tgt: Lang): Promise<LinkIndex> {
  const sc = await ro.salesChannels();
  // only real storefront domains (headless channels have pseudo domains like "default.headless0")
  const domains: Domain[] = sc.flatMap(s => (s.domains ?? []).map((d: SwEntity) => ({ url: String(d.url), languageId: d.languageId, salesChannelId: s.id }))).filter(d => /^https?:\/\//.test(d.url));
  const ix: LinkIndex = { domains, targetLanguageId: tgt.id, targetLanguageName: tgt.name, bySeoPath: new Map(), targetSeo: new Map() };
  const paths = [...new Set(links.map(u => shopPath(u, domains)).filter(p => p?.path).map(p => p!.path))];
  const tech = paths.map(p => p.match(/^(?:navigation|detail|landingPage)\/([0-9a-f]{32})$/)?.[1]).filter((x): x is string => !!x);
  const seoPaths = paths.filter(p => !/^(?:navigation|detail|landingPage)\/[0-9a-f]{32}$/.test(p)).flatMap(seoVariants);
  if (seoPaths.length) {
    const r = await ro.search('seo-url', { limit: 500, filter: [{ type: 'equalsAny', field: 'seoPathInfo', value: seoPaths }, { type: 'equals', field: 'isDeleted', value: false }] });
    for (const h of r.data as SeoHit[]) if (!ix.bySeoPath.has(h.seoPathInfo) || (h as SwEntity).isCanonical) ix.bySeoPath.set(h.seoPathInfo, h);
  }
  const fks = [...new Set([...tech, ...[...ix.bySeoPath.values()].map(h => h.foreignKey)])];
  if (fks.length) {
    const r = await ro.search('seo-url', { limit: 500, filter: [{ type: 'equalsAny', field: 'foreignKey', value: fks }, { type: 'equals', field: 'languageId', value: tgt.id }, { type: 'equals', field: 'isCanonical', value: true }, { type: 'equals', field: 'isDeleted', value: false }] });
    for (const h of r.data as SeoHit[]) ix.targetSeo.set(seoKey(h.salesChannelId, h.routeName, h.foreignKey), h.seoPathInfo);
  }
  return ix;
}

export interface PageTrArgs { cmsPageId: string; target: string; source?: string; title?: string; reason?: string; texts: Record<string, string>; keepInherited?: boolean }
export async function buildPageTranslationChangeSet(ro: ShopReader, a: PageTrArgs): Promise<ChangeSet> {
  const langs = await loadLanguages(ro);
  const tgt = resolveLang(langs, a.target), src = a.source ? resolveLang(langs, a.source) : await defaultSource(ro, langs, tgt);
  if (src.id === tgt.id) throw new Error('Quell- und Zielsprache sind gleich');
  const { page, slots } = await loadPageSlots(ro, a.cmsPageId, src.id);
  const tslots = new Map((await loadPageSlots(ro, a.cmsPageId, tgt.id)).slots.map(s => [s.id, s]));
  // If other languages inherit from the target language (system language), they keep their visible text
  const heirs = tgt.system && a.keepInherited !== false ? await Promise.all(langs.filter(l => !l.system).map(async l => ({ l, slots: new Map((await loadPageSlots(ro, a.cmsPageId, l.id)).slots.map(s => [s.id, s])) }))) : [];
  const texts = a.texts ?? {}, errs: string[] = [], plans: { s: PageSlot; segs: SlotSeg[]; apply: (t: Record<string, string>) => unknown }[] = [];
  const known = new Set<string>();
  for (const s of slots) {
    const { segs, apply } = slotTexts(s.config as Cfg, s.key);
    segs.forEach(g => { known.add(g.key); const t = texts[g.key]; if (t === undefined) return; const e = checkSeg(g, t); if (e) errs.push(`${g.key}: ${e}`); });
    if (segs.length || configLinks(s.config as Cfg).length) plans.push({ s, segs, apply }); // also pure link elements (e.g. image with target URL)
  }
  const mids = [...new Set(slots.map(s => s.mediaId).filter((x): x is string => !!x))];
  const [sm, tm] = await Promise.all([mediaAlts(ro, mids, src.id), mediaAlts(ro, mids, tgt.id)]);
  const altKeys = new Map<string, string>(); // key → mediaId
  for (const s of slots) if (s.mediaId && sm.get(s.mediaId)?.translated?.alt) { known.add(`${s.key}.alt`); if (![...altKeys.values()].includes(s.mediaId)) altKeys.set(`${s.key}.alt`, s.mediaId); }
  const unknown = Object.keys(texts).filter(k => !known.has(k));
  if (unknown.length) errs.push(`Unbekannte keys: ${unknown.slice(0, 15).join(', ')} (get_page_texts erneut lesen)`);
  const missing = [...known].filter(k => texts[k] === undefined && (!k.endsWith('.alt') || altKeys.has(k)));
  if (missing.length) errs.push(`Ohne Übersetzung (keine Sprachmischung: alle keys übersetzen, Markennamen unverändert übernehmen): ${missing.slice(0, 30).join(', ')}${missing.length > 30 ? ` … (+${missing.length - 30})` : ''}`);
  for (const [k] of altKeys) if (texts[k] !== undefined && /<[a-z/!]/i.test(texts[k])) errs.push(`${k}: kein HTML erlaubt (reiner Text)`);
  if (errs.length) throw new Error(errs.join('; '));
  const built = plans.map(p => ({ ...p, config: p.apply(texts) as Record<string, { source?: string; value?: unknown }> }));
  const ix = await linkIndex(ro, built.flatMap(b => configLinks(b.config)), tgt);
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = []; let unchanged = 0, moved = 0;
  const notes = new Set<string>();
  for (const b of built) {
    const { config, changed, notes: n } = mapConfigLinks(b.config, ix); n.forEach(x => notes.add(x)); moved += changed.length;
    const t = tslots.get(b.s.id), own = t?.own ?? null;
    if (JSON.stringify(own) === JSON.stringify(config)) { unchanged++; continue; }
    if (!b.segs.length && !changed.length) { unchanged++; continue; }
    const same = b.segs.filter(g => texts[g.key]?.trim() === g.src.trim() && /\p{L}{4,}/u.test(g.src)).length;
    const warn = [...(same > 1 && same >= b.segs.length / 2 ? [`${same} von ${b.segs.length} Texten identisch mit ${src.name}`] : []), ...changed.map(c => `Link → ${c.to}`), ...n];
    const lines = (cfg: unknown) => slotTexts(cfg as Cfg, 'x').segs.map(g => plain(g.src)).filter(Boolean).join('\n');
    const lbl = `${page.translated?.name ?? page.name} · Block ${b.s.blockNo} (${b.s.block}) › ${b.s.slot}`;
    const hs = heirs.filter(h => !h.slots.get(b.s.id)?.own);
    if (hs.length) warn.push(`${hs.map(h => h.l.name).join(', ')}: bisheriger Text wird gesichert (erbt sonst ${tgt.name})`);
    else if (tgt.system && a.keepInherited === false) warn.push('Systemsprache: Sprachen ohne eigene Texte zeigen danach diese Fassung');
    const src0 = (b.s.config ?? {}) as Record<string, unknown>, patch = Object.fromEntries(Object.entries(config).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(src0[k]))); // only keys with a text/link change
    const raw: SlotRaw = { languageId: tgt.id, field: 'config', patch, baseLanguageId: src.id };
    items.push({ id: `${b.s.id}:${tgt.id}`, entity: 'cms-slot', entityId: b.s.id, label: lbl, field: 'config', fieldLabel: `${b.segs.length ? 'Texte' : 'Link'} (${tgt.locale})`,
      before: own ? cut(lines(own) || '–') : `erbt ${fallbackChain(langs, tgt)[1]?.name ?? ''}: ${cut(lines(t?.config ?? b.s.config), 120)}`, after: b.segs.length ? cut(b.segs.map(g => plain(texts[g.key] ?? '')).join(' · ')) : cut(changed.map(c => c.to).join(', ')),
      afterRaw: raw, beforeRaw: ownOf({ config: own }, raw), html: { before: lines(own ?? t?.config ?? b.s.config).slice(0, 4000), after: lines(config).slice(0, 4000) }, warn });
    // inheriting languages: the executor reads their previously visible config fresh from the shop and writes it as their own value
    for (const h of hs) items.push({ id: `${b.s.id}:${h.l.id}`, entity: 'cms-slot', entityId: b.s.id, label: lbl, field: 'config', fieldLabel: `Texte (${h.l.locale}) sichern`, before: 'erbt', after: 'eigener Wert = bisheriger Text', afterRaw: { languageId: h.l.id, field: 'config', patch: {}, baseLanguageId: h.l.id } satisfies SlotRaw, beforeRaw: null, warn: [] });
  }
  for (const [k, mid] of altKeys) {
    const v = texts[k].trim(), cur = tm.get(mid)?.alt ?? null;
    if (v === cur) { unchanged++; continue; }
    items.push({ id: `${mid}:${tgt.id}:alt`, entity: 'media', entityId: mid, label: `Bild ${sm.get(mid)?.fileName ?? mid}`, field: 'alt', fieldLabel: `Alt-Text (${tgt.locale})`, before: cur ?? `erbt: ${cut(sm.get(mid)?.translated?.alt)}`, after: cut(v), afterRaw: { languageId: tgt.id, field: 'alt', value: v } satisfies TrRaw, beforeRaw: cur, warn: tgt.system ? ['Alt-Text der Systemsprache gilt für alle Sprachen ohne eigenen'] : [] });
  }
  const kept = [...notes].filter(n => n.includes('bleibt unverändert')).length;
  if (moved || kept) items.unshift({ id: 'links', entity: 'info', label: 'Shop-Links', fieldLabel: tgt.name, before: `${moved + kept} Links`, after: `${moved} auf ${tgt.name} umgestellt${kept ? `, ${kept} unverändert (siehe Hinweise)` : ''}`, warn: [] });
  if (!items.some(i => i.entity !== 'info')) throw new Error(`Keine Änderung nötig (${unchanged} Elemente bereits so übersetzt).`);
  return { id: newId(), kind: 'page-translation', entity: 'cms-slot', noun: { one: 'Element', many: 'Elemente' }, applyLabel: 'Übersetzung übernehmen', title: a.title ?? `Seite übersetzen: ${page.translated?.name ?? page.name} → ${tgt.name}`, reason: a.reason ?? null, items, skipped, unchanged, atomic: false };
}

// ================= EXECUTOR =================
/** Write data + exact undo steps for an entity: rows = existing translation rows (all languages). Pure, so it is testable.
 *  pre (if set) is written before data: Shopware merges custom fields per key; removing keys only works by clearing + setting again. */
export function planTranslationWrite(entity: string, id: string, rows: SwEntity[], raws: TrRaw[]): { pre: Record<string, unknown> | null; data: Record<string, unknown>; undo: UndoOp[] } {
  const translations: Record<string, Record<string, unknown>> = {}, reset: Record<string, Record<string, unknown>> = {}, undo: UndoOp[] = [], drops: UndoOp[] = [];
  const byLang = new Map<string, TrRaw[]>(); for (const r of raws) byLang.set(r.languageId, [...(byLang.get(r.languageId) ?? []), r]);
  for (const [lang, rs] of byLang) {
    const row = rows.find(r => r.languageId === lang), next: Record<string, unknown> = {}, prev: Record<string, unknown> = {};
    for (const r of rs) {
      if (r.field === 'faq') {
        const cf = (row?.customFields ?? {}) as Record<string, unknown>, blocks = (cf.aicb_blocks ?? {}) as Record<string, unknown>, f = r.value as (Faq & { html?: string }) | null;
        prev.customFields = row?.customFields ?? null;
        if (f) { next.customFields = { aicb_blocks: { ...blocks, faq: f.items, faq_html: f.html ?? faqHtml(f) } }; continue; }
        // Remove FAQ: own aicb_blocks must go, otherwise it shadows the inherited value (merge per top-level key)
        const other = Object.fromEntries(Object.entries(blocks).filter(([k]) => k !== 'faq' && k !== 'faq_html')), rest = Object.fromEntries(Object.entries(cf).filter(([k]) => k !== 'aicb_blocks'));
        const left = Object.keys(other).length ? { ...rest, aicb_blocks: other } : rest;
        next.customFields = Object.keys(left).length ? left : null;
        if (next.customFields) reset[lang] = { customFields: null };
      } else { next[r.field] = r.value; prev[r.field] = row?.[r.field] ?? null; }
    }
    translations[lang] = next;
    // If there was no translation row yet, undo removes it again (the language then inherits as before)
    if (row) undo.push({ op: 'patch', entity, id, data: { translations: { [lang]: prev } } });
    else drops.push({ op: 'req', entity, id, method: 'DELETE', path: `/${entity}/${id}/translations/${lang}` });
    // Shopware merges custom fields: clear first, then set the old state completely (undo runs backwards)
    if (row && prev.customFields) undo.push({ op: 'patch', entity, id, data: { translations: { [lang]: { customFields: null } } } });
  }
  // Undo runs backwards: restore the old values first, THEN delete new rows. Otherwise the language briefly inherits the new text
  // (e.g. German → English system language) and Shopware creates SEO URLs for it that linger as redirects.
  return { pre: Object.keys(reset).length ? { translations: reset } : null, data: { translations }, undo: [...drops, ...undo] };
}

/** Element config (SlotRaw): read the current effective config of language baseLanguageId with the privileged client (untruncated) and merge the patch in */
export async function resolveRaw(swW: Pick<Shopware, 'get'>, entity: string, id: string, r: TrRaw | SlotRaw): Promise<TrRaw> {
  if (!('patch' in r)) return r;
  const base = (await swW.get(entity, id, {}, { languageId: r.baseLanguageId }))?.translated?.config ?? {};
  return { languageId: r.languageId, field: 'config', value: { ...base, ...r.patch } };
}

export async function applyTranslations(swW: Shopware, cs: ChangeSet, _payload: unknown, selected: Set<string>, ctx?: ApplyCtx): Promise<ApplyResult> {
  const groups = new Map<string, ChangeItem[]>();
  let n = 0;
  for (const it of cs.items) if (selected.has(it.id) && it.entity !== 'info') { const k = `${it.entity}|${it.entityId}`; groups.set(k, [...(groups.get(k) ?? []), it]); n++; }
  const results: ApplyResult['results'] = [], undo: UndoOp[] = [], tick = partialTicker(ctx, n, { results, undo });
  await pool([...groups.values()], 2, async its => {
    const { entity, entityId: id } = its[0];
    let live = its;
    try {
      const cur = (await swW.search(entity, { ids: [id!], limit: 1, associations: { translations: {} } })).data[0];
      if (!cur) throw new Error('Datensatz nicht mehr vorhanden');
      const rows: SwEntity[] = cur.translations ?? [];
      // Language translated differently in the meantime (other chat, admin): skip this item, but write the record's others
      live = its.filter(it => { const r = it.afterRaw as TrRaw | SlotRaw; try { assertFresh(it.fieldLabel, ownOf(rows.find(x => x.languageId === r.languageId), r), it.beforeRaw); return true; } catch (e) { results.push({ itemId: it.id, ok: false, error: errMsg(e) }); return false; } });
      if (!live.length) return;
      const raws = await Promise.all(live.map(i => resolveRaw(swW, entity, id!, i.afterRaw as TrRaw | SlotRaw)));
      if (entity === 'product' && raws.some(r => r.field === 'faq' && r.value)) await ensureFieldSet(swW);
      const plan = planTranslationWrite(entity, id!, rows, raws);
      if (plan.pre) { await swW.update(entity, id!, plan.pre); undo.push(...plan.undo); } // pre only for existing rows → undo patches restore even a partial state exactly
      await swW.update(entity, id!, plan.data);
      if (!plan.pre) undo.push(...plan.undo);
      live.forEach(i => results.push({ itemId: i.id, ok: true }));
    } catch (e) { live.forEach(i => results.push({ itemId: i.id, ok: false, error: errMsg(e) })); }
    finally { tick(); }
  });
  return { results, undo };
}
registerApplier('translations', applyTranslations);
registerApplier('page-translation', applyTranslations);

// ================= TOOLS =================
const ENTITY = z.enum(['product', 'category', 'landing-page']);
const resolvePageId = async (ro: ShopReader, a: { cmsPageId?: string; categoryId?: string; productId?: string; landingPageId?: string }) => {
  if (a.cmsPageId) return a.cmsPageId;
  const id = a.categoryId ? (await ro.get('category', a.categoryId))?.cmsPageId : a.productId ? (await ro.get('product', a.productId))?.cmsPageId : a.landingPageId ? (await ro.get('landing-page', a.landingPageId))?.cmsPageId : null;
  if (!id) throw new Error('Kein CMS-Layout gefunden (cmsPageId, categoryId, productId oder landingPageId angeben; Ziel ohne eigenes Layout hat keine Element-Texte).');
  return id as string;
};

export const translations: Feature = {
  key: 'translations',
  platforms: ['shopware'],
  toolNames: ['list_languages', 'get_translations', 'propose_translations', 'get_page_texts', 'propose_page_translation'],
  tools: (session: Session) => {
    const sw = session.sw;
    return [
      tool('list_languages', 'Listet alle Shop-Sprachen: Locale, Systemsprache (Rückfall für alle Übersetzungen), Vererbung, welche Verkaufskanäle sie nutzen (Standardsprache?) und unter welchen Domains sie erreichbar sind, dazu den hreflang-Status je Storefront (aktiv, x-default-Domain). Ändert nichts.',
        {}, guard(async () => ok(await languageOverview(sw)))),

      tool('get_translations', 'Liest Name, Beschreibung, Meta-Title, Meta-Description, Keywords (Produkte zusätzlich FAQ-Zusatzfeld, Landingpages URL-Pfad) JE SPRACHE für Produkte, Kategorien oder Landingpages. Zeigt je Sprache eigene Werte und welche Felder fehlen (inherited = erbt aus der Rückfallsprache). Filter: ids, categoryId (nur Produkte), term; Paginierung über limit/offset (max. 50, mit full=true max. 10 und ungekürzte Beschreibung); onlyMissing=true zeigt nur Datensätze mit Lücken. Ändert nichts.',
        { entity: ENTITY, ids: z.array(z.string()).optional(), categoryId: z.string().optional(), term: z.string().optional(), languages: z.array(z.string()).optional().describe('Sprach-IDs oder Locales (z. B. "en-GB"); ohne = alle'), onlyMissing: z.boolean().optional(), full: z.boolean().optional().describe('Beschreibung ungekürzt (Basis zum Übersetzen)'), limit: z.number().optional(), offset: z.number().optional() },
        guard(async a => ok(await readTranslations(sw, a)))),

      tool('propose_translations', `SCHLÄGT Übersetzungen für Produkte, Kategorien oder Landingpages vor (je Datensatz und Sprache, max. ${MAX_ITEMS} Einträge). Es wird NICHTS geschrieben: Der Nutzer sieht je Feld und Sprache Alt→Neu, wählt aus und gibt frei; der Aufruf wartet auf die Entscheidung. Felder: name, description (HTML), metaTitle, metaDescription, keywords; Produkte zusätzlich faq {title, items:[{q,a}]} (title in der Zielsprache Pflicht), Landingpages url. null entfernt die eigene Übersetzung (Feld erbt wieder). Wird die Systemsprache geändert, sichert das Set automatisch den bisherigen Text in Sprachen, die ihn erben (keepInherited=false schaltet das ab). War das Feld in der Systemsprache bisher leer, gibt es nichts zu sichern: erbende Sprachen zeigen danach den neuen Text; deren eigene Fassung im selben Set mitliefern. Übersetzt NICHT selbst, du lieferst die fertigen Texte.`,
        { title: z.string(), reason: z.string(), entity: ENTITY, keepInherited: z.boolean().optional(),
          changes: z.array(z.object({ id: z.string(), language: z.string().describe('Sprach-ID oder Locale, z. B. "en-GB"'), fields: z.record(z.string(), z.any()) })) },
        guard(async a => { const cs = await buildTranslationChangeSet(sw, a); return ok(await session.requestChange(cs)); })),

      tool('get_page_texts', 'Liest alle übersetzbaren Texte eines CMS-Layouts (Einkaufswelt) in der Quellsprache als nummerierte Abschnitte: Texte/HTML-Schnipsel, Button-/Linktexte, alt/title-Attribute, Slider-Titel, Alt-Texte von Bildern, samt enthaltener Links. Markup, CSS und Skripte werden nicht ausgegeben und bleiben unverändert. Mit target zeigt es, ob die Zielsprache schon eigene Texte hat. Ändert nichts.',
        { cmsPageId: z.string().optional(), categoryId: z.string().optional(), productId: z.string().optional(), landingPageId: z.string().optional(), source: z.string().optional().describe('Quellsprache (ID/Locale); Standard: Systemsprache bzw., wenn sie das Ziel ist, Standardsprache der Storefront'), target: z.string().optional() },
        guard(async a => ok(await readPageTexts(sw, { cmsPageId: await resolvePageId(sw, a), source: a.source, target: a.target })))),

      tool('propose_page_translation', 'SCHLÄGT die Übersetzung eines bestehenden CMS-Layouts (z. B. von Lotse veröffentlicht) in eine Zielsprache vor: setzt deine Übersetzungen je key aus get_page_texts in die Element-Konfiguration der Zielsprache ein (Markup/CSS/JS bleiben), übersetzt FAQ-Schema (JSON-LD) mit, stellt Shop-Links auf die SEO-URL der Zielsprache um (wenn es dort eine Domain gibt) und setzt Alt-Texte der Bilder in der Zielsprache. ALLE keys müssen übersetzt sein. Es wird NICHTS geschrieben, bis der Nutzer freigibt; der Aufruf wartet auf die Entscheidung. Ändert weder Layout-Aufbau noch Zuweisung.',
        { cmsPageId: z.string(), target: z.string().describe('Zielsprache (ID/Locale)'), source: z.string().optional().describe('wie bei get_page_texts'), title: z.string().optional(), reason: z.string().optional(), keepInherited: z.boolean().optional(),
          texts: z.record(z.string(), z.string()).describe('alle keys aus get_page_texts, z. B. { "s3.0": "Übersetzung", "s3.1": "…", "s5.alt": "…" }') },
        guard(async a => { const cs = await buildPageTranslationChangeSet(sw, a); return ok(await session.requestChange(cs)); })),
    ] as AnyTool[];
  },
};
