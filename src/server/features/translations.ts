import 'server-only';
// Mehrsprachigkeit: Sprachen/Domains/hreflang lesen, Texte je Sprache lesen und Übersetzungen (Produkte, Kategorien,
// Landingpages, Einkaufswelten-Elemente, Alt-Texte) als Änderungsset vorschlagen. Rückgängig stellt den vorherigen Stand je Sprache her.
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

// ---- Sprachen ----
export interface Lang { id: string; name: string; locale: string; parentId: string | null; system: boolean }
export async function loadLanguages(ro: ShopReader): Promise<Lang[]> {
  const r = await ro.search('language', { limit: 100, associations: { locale: {} } });
  return r.data.map(l => ({ id: l.id, name: l.translated?.name ?? l.name, locale: l.locale?.code ?? '', parentId: l.parentId ?? null, system: l.id === SYSTEM_LANGUAGE }))
    .sort((a, b) => Number(b.system) - Number(a.system) || a.name.localeCompare(b.name));
}
/** Sprache per ID, Locale („en-GB“, auch „en“ wenn eindeutig) oder Name */
export function resolveLang(langs: Lang[], ref: string): Lang {
  const r = String(ref ?? '').trim().toLowerCase();
  const hit = langs.find(l => l.id === r) ?? langs.find(l => l.locale.toLowerCase() === r) ?? langs.find(l => l.name.toLowerCase() === r);
  if (hit) return hit;
  const pre = langs.filter(l => l.locale.toLowerCase().split('-')[0] === r);
  if (pre.length === 1) return pre[0];
  throw new Error(`Sprache „${ref}“ unbekannt${pre.length > 1 ? ' (mehrdeutig)' : ''}. Vorhanden: ${langs.map(l => `${l.name} (${l.locale})`).join(', ')}`);
}
/** Rückfallkette einer Sprache: eigene → Elternsprache → Systemsprache */
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

// ---- Übersetzbare Felder ----
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

/** Liest dieselben Datensätze je Sprache (eigene Werte + geerbte Werte) */
async function readPerLanguage(ro: ShopReader, entity: TrEntity, ids: string[], langs: Lang[]) {
  const def = TR_ENTITIES[entity], fields = Object.keys(def.fields).filter(f => f !== 'faq');
  const includes = { [def.alias]: ['id', 'productNumber', 'parentId', ...fields, 'customFields', 'translated'] };
  const out = new Map<string, Map<string, SwEntity>>(); // languageId → id → Zeile
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
  const gaps = new Set<string>(); // Datensätze mit Lücken in einer Nicht-Systemsprache
  const keyOf = (l: Lang) => (l.locale && langs.filter(x => x.locale === l.locale).length === 1 ? l.locale : `${l.locale || l.name} (${l.id})`); // gleiche Locale zweimal → ID anhängen
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

// ---- Änderungsset: Übersetzungen von Produkten/Kategorien/Landingpages ----
/** afterRaw eines Übersetzungs-Items */
export interface TrRaw { languageId: string; field: string; value: unknown }
/** afterRaw eines Element-Items (cms-slot): nur die geänderten Config-Schlüssel; die übrige Config liest der Executor beim Schreiben frisch und ungekürzt
 *  aus dem Shop (Sprache baseLanguageId) und mischt den Patch hinein. So landet weder die komplette Element-Konfiguration im Änderungsset noch eine
 *  vom Lese-Guard bereinigte Fassung (sensible Schlüssel entfernt) als Übersetzung im Shop. */
export interface SlotRaw { languageId: string; field: 'config'; patch: Record<string, unknown>; baseLanguageId: string }
/** Eigener Wert einer Sprache (Stale-Write-Guard): beim Vorschlag aus der Zeile der Sprache, beim Schreiben aus der Übersetzungszeile.
 *  Element-Config nur in den gepatchten Schlüsseln (die übrige Config liegt nicht im Set); leerer Patch (Texte sichern) = die Sprache hatte keine eigene Config. */
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
  for (const c of a.changes) { try { const l = resolveLang(langs, c.language); Object.keys(c.fields ?? {}).forEach(f => explicit.add(`${c.id}:${l.id}:${f}`)); } catch { /* unten gemeldet */ } }
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
        // FAQ null bei vorhandenem eigenen aicb_blocks (z. B. {faq: null}) ist eine Änderung: erst danach erbt die Sprache wieder
        if (JSON.stringify(cmp) === JSON.stringify(own) && !(field === 'faq' && value == null && row.customFields?.aicb_blocks != null)) { unchanged++; continue; }
        const warn = seoWarn(field, value);
        if (!lang.system && value != null && field !== 'name' && field !== 'url' && JSON.stringify(cmp) === JSON.stringify(ownVal(sysRow, field))) warn.push(`identisch mit ${sys.name}, nicht übersetzt?`);
        const rowOf = (l: Lang) => per.get(l.id)?.get(ch.id);
        // null: welcher Text danach sichtbar ist (erster eigener Wert in der Rückfallkette)
        const inheritsAfter = value == null ? fallbackChain(langs, lang).slice(1).map(l => ({ l, v: ownVal(rowOf(l), field) })).find(x => !isEmpty(x.v)) : undefined;
        if (value == null && field === 'faq' && Object.keys(row.customFields?.aicb_blocks ?? {}).some(k => k !== 'faq' && k !== 'faq_html')) warn.push('aicb_blocks enthält weitere eigene Inhalte: FAQ wird in dieser Sprache entfernt, erbt aber nicht');
        // Systemsprache wird geändert: betroffen sind Sprachen, die das Feld bis zur Systemsprache durchgehend erben (ohne explizite eigene Angabe im Set)
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
        // erbende Sprachen behalten ihren sichtbaren Text (eigener Wert = bisheriger Text der Systemsprache)
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

// ---- Einkaufswelten: Element-Texte je Sprache ----
const cmsCriteria = { associations: { sections: { sort: [{ field: 'position' }], associations: { blocks: { sort: [{ field: 'position' }], associations: { slots: {} } } } } } };
export interface PageSlot { key: string; id: string; slot: string; type: string; block: string; blockNo: number; config: Cfg | null; own: Cfg | null; mediaId: string | null }
/** Slots in Lesereihenfolge; key „s{n}“ ist stabil, solange sich der Aufbau nicht ändert. config = wirksam (mit Vererbung), own = eigener Wert der Sprache */
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
// Alt-Texte der Bilder je Sprache (ohne Freigabe der Medienbibliothek: keine Alt-Texte)
async function mediaAlts(ro: ShopReader, ids: string[], languageId: string) {
  if (!ids.length) return new Map<string, SwEntity>();
  const r = await ro.search('media', { ids, limit: ids.length }, { languageId }).catch(() => ({ data: [] as SwEntity[] }));
  return new Map(r.data.map(m => [m.id, m]));
}

/** Standard-Quellsprache: Systemsprache; ist sie selbst das Ziel, die Standardsprache einer Storefront (z. B. Deutsch) */
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
  // nur echte Storefront-Domains (Headless-Kanäle haben Pseudo-Domains wie „default.headless0“)
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
  // Erben andere Sprachen von der Zielsprache (Systemsprache), behalten sie ihren sichtbaren Text
  const heirs = tgt.system && a.keepInherited !== false ? await Promise.all(langs.filter(l => !l.system).map(async l => ({ l, slots: new Map((await loadPageSlots(ro, a.cmsPageId, l.id)).slots.map(s => [s.id, s])) }))) : [];
  const texts = a.texts ?? {}, errs: string[] = [], plans: { s: PageSlot; segs: SlotSeg[]; apply: (t: Record<string, string>) => unknown }[] = [];
  const known = new Set<string>();
  for (const s of slots) {
    const { segs, apply } = slotTexts(s.config as Cfg, s.key);
    segs.forEach(g => { known.add(g.key); const t = texts[g.key]; if (t === undefined) return; const e = checkSeg(g, t); if (e) errs.push(`${g.key}: ${e}`); });
    if (segs.length || configLinks(s.config as Cfg).length) plans.push({ s, segs, apply }); // auch reine Link-Elemente (z. B. Bild mit Ziel-URL)
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
    const src0 = (b.s.config ?? {}) as Record<string, unknown>, patch = Object.fromEntries(Object.entries(config).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(src0[k]))); // nur Schlüssel mit Text-/Link-Änderung
    const raw: SlotRaw = { languageId: tgt.id, field: 'config', patch, baseLanguageId: src.id };
    items.push({ id: `${b.s.id}:${tgt.id}`, entity: 'cms-slot', entityId: b.s.id, label: lbl, field: 'config', fieldLabel: `${b.segs.length ? 'Texte' : 'Link'} (${tgt.locale})`,
      before: own ? cut(lines(own) || '–') : `erbt ${fallbackChain(langs, tgt)[1]?.name ?? ''}: ${cut(lines(t?.config ?? b.s.config), 120)}`, after: b.segs.length ? cut(b.segs.map(g => plain(texts[g.key] ?? '')).join(' · ')) : cut(changed.map(c => c.to).join(', ')),
      afterRaw: raw, beforeRaw: ownOf({ config: own }, raw), html: { before: lines(own ?? t?.config ?? b.s.config).slice(0, 4000), after: lines(config).slice(0, 4000) }, warn });
    // erbende Sprachen: der Executor liest ihre bisher sichtbare Config frisch aus dem Shop und schreibt sie als eigenen Wert
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
/** Schreibdaten + exakte Rückgängig-Schritte für eine Entität: rows = bisherige Übersetzungszeilen (alle Sprachen). Pur, damit testbar.
 *  pre (falls gesetzt) wird vor data geschrieben: Zusatzfelder werden von Shopware je Schlüssel gemergt; Schlüssel entfernen geht nur über leeren + neu setzen. */
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
        // FAQ entfernen: eigenes aicb_blocks muss weg, sonst überdeckt es den geerbten Wert (Merge je Schlüssel der obersten Ebene)
        const other = Object.fromEntries(Object.entries(blocks).filter(([k]) => k !== 'faq' && k !== 'faq_html')), rest = Object.fromEntries(Object.entries(cf).filter(([k]) => k !== 'aicb_blocks'));
        const left = Object.keys(other).length ? { ...rest, aicb_blocks: other } : rest;
        next.customFields = Object.keys(left).length ? left : null;
        if (next.customFields) reset[lang] = { customFields: null };
      } else { next[r.field] = r.value; prev[r.field] = row?.[r.field] ?? null; }
    }
    translations[lang] = next;
    // Gab es noch keine Übersetzungszeile, wird sie beim Rückgängigmachen wieder entfernt (Sprache erbt dann wie vorher)
    if (row) undo.push({ op: 'patch', entity, id, data: { translations: { [lang]: prev } } });
    else drops.push({ op: 'req', entity, id, method: 'DELETE', path: `/${entity}/${id}/translations/${lang}` });
    // Zusatzfelder werden von Shopware gemergt: erst leeren, dann den alten Stand vollständig setzen (Undo läuft rückwärts)
    if (row && prev.customFields) undo.push({ op: 'patch', entity, id, data: { translations: { [lang]: { customFields: null } } } });
  }
  // Undo läuft rückwärts: erst die alten Werte zurück, DANN neue Zeilen löschen. Sonst erbt die Sprache kurz den neuen Text
  // (z. B. Deutsch → englische Systemsprache) und Shopware legt dafür SEO-URLs an, die als Weiterleitung liegen bleiben.
  return { pre: Object.keys(reset).length ? { translations: reset } : null, data: { translations }, undo: [...drops, ...undo] };
}

/** Element-Config (SlotRaw): aktuelle wirksame Config der Sprache baseLanguageId mit dem privilegierten Client lesen (ungekürzt) und den Patch hineinmischen */
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
      // Sprache inzwischen anders übersetzt (anderer Chat, Admin): dieses Item nicht schreiben, die übrigen des Datensatzes schon
      live = its.filter(it => { const r = it.afterRaw as TrRaw | SlotRaw; try { assertFresh(it.fieldLabel, ownOf(rows.find(x => x.languageId === r.languageId), r), it.beforeRaw); return true; } catch (e) { results.push({ itemId: it.id, ok: false, error: errMsg(e) }); return false; } });
      if (!live.length) return;
      const raws = await Promise.all(live.map(i => resolveRaw(swW, entity, id!, i.afterRaw as TrRaw | SlotRaw)));
      if (entity === 'product' && raws.some(r => r.field === 'faq' && r.value)) await ensureFieldSet(swW);
      const plan = planTranslationWrite(entity, id!, rows, raws);
      if (plan.pre) { await swW.update(entity, id!, plan.pre); undo.push(...plan.undo); } // pre nur bei vorhandenen Zeilen → Undo-Patches stellen auch einen Teilstand exakt her
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

// ================= WERKZEUGE =================
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
