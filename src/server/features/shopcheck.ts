import 'server-only';
// Shop-Check: Kernprüfungen (SEO, Bilder, Bestand, Preise, Links, Sprachen) registrieren + Werkzeug run_shop_check für die KI.
// Große Kataloge: Zählungen über total-count (DAL-Filter, exakt); Prüfungen, die Texte/Preise brauchen, lesen höchstens SCAN_MAX Produkte („mindestens“).
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { CheckFinding } from '@/lib/protocol';
import { countText, runHealth, SEVERITY_LABEL, summaryText } from '@/lib/shopcheck';
import { DEFAULT_CURRENCY, errMsg, onApplied } from '../changes';
import { registerCheck } from '../checks';
import { ago } from '@/lib/format';
import { checkLinks, collectLinks, extractLinks, linkContext, shortProblem, type LinkCtx } from '../seo-links';
import { latestShopCheck, recheckShopCheck } from '../shopcheck';
import type { PlatformKind } from '@/lib/platforms';
import type { CustomCheck } from '@/lib/custom-checks';
import { CHECK_FIELDS, CHECK_OPS, conditionsText, CUSTOM_PREFIX, parseCheckInput, type CheckField, type CheckOp } from '@/lib/custom-checks';
import { addCustom, checkList, customFinding, listCustom, removeCustom, setCheckEnabled, updateCustom } from '../custom-checks';
import type { ShopReader, SwEntity } from '../shopware';
import { fail, guard, ok, type AnyTool } from '../tool-kit';
import { GAP_FILTER } from './product-images';
import { auditPages } from './seo';
import { DEFS, makeFinding, productLabel, scanHits, SCAN_INCLUDES, toScanRow, type Hit, type ScanRow } from './shopcheck-rules';
import { loadLanguages, SYSTEM_LANGUAGE } from './translations';
import type { Feature } from './types';

export const SCAN_MAX = 2500, SCAN_PAGE = 250, PAGES_MAX = 200;

// Freigegebene Änderung angewendet (z. B. ein Befund über „Als Auftrag ins Feld“ behoben) → Shop-Check im Hintergrund neu
onApplied('shopcheck', () => { void recheckShopCheck(); });

// Pro Durchlauf nur einmal lesen (runChecks gibt jedem Durchlauf ein eigenes Lese-Client-Objekt, siehe perRun), auch wenn mehrere Prüfungen dieselben Daten brauchen
const memos = new WeakMap<ShopReader, Map<string, Promise<unknown>>>();
function memo<T>(sw: ShopReader, key: string, fn: () => Promise<T>): Promise<T> {
  let m = memos.get(sw); if (!m) memos.set(sw, (m = new Map()));
  if (!m.has(key)) m.set(key, fn());
  return m.get(key) as Promise<T>;
}

const eq = (field: string, value: unknown) => ({ type: 'equals', field, value });
const empty = (field: string) => ({ type: 'multi', operator: 'or', queries: [eq(field, null), eq(field, '')] });
const ACTIVE_MAIN = [eq('active', true), eq('parentId', null)];
const PRODUCT_LIST = { product: ['id', 'productNumber', 'name', 'translated'] };

/** Anzahl + bis zu 5 Beispiele in einer Abfrage */
async function countProducts(sw: ShopReader, filter: unknown[], opts?: { languageId?: string }) {
  const r = await sw.search('product', { limit: 5, filter, 'total-count-mode': 1, sort: [{ field: 'productNumber', order: 'ASC' }], includes: PRODUCT_LIST }, opts);
  return { count: r.total ?? r.data.length, sample: r.data.map(p => ({ id: p.id, label: productLabel(p) })) };
}
const activeTotal = (sw: ShopReader) => memo(sw, 'activeTotal', async () => (await sw.search('product', { limit: 1, filter: ACTIVE_MAIN, 'total-count-mode': 1, includes: { product: ['id'] } })).total ?? 0);
// null = kein Verkaufskanal mit Domain; Lesefehler werden weitergereicht (Prüfung gilt dann als gescheitert, nicht als „ohne Befund“)
const ctxOf = (sw: ShopReader) => memo(sw, 'ctx', () => linkContext(sw));

/** Aktive Hauptprodukte seitenweise lesen (nur benötigte Felder), höchstens SCAN_MAX */
export async function scanProducts(sw: ShopReader): Promise<{ rows: ScanRow[]; total: number; capped: boolean }> {
  return memo(sw, 'scan', async () => {
    const rows: ScanRow[] = []; let total = 0;
    for (let page = 1; rows.length < SCAN_MAX; page++) {
      const r = await sw.search('product', { limit: SCAN_PAGE, page, filter: ACTIVE_MAIN, sort: [{ field: 'productNumber', order: 'ASC' }], includes: SCAN_INCLUDES, ...(page === 1 ? { 'total-count-mode': 1 } : {}) });
      if (page === 1) total = r.total ?? r.data.length;
      rows.push(...r.data.map(toScanRow));
      if (r.data.length < SCAN_PAGE) break;
    }
    return { rows, total, capped: rows.length < total };
  });
}

type Def = (typeof DEFS)[keyof typeof DEFS];
const fromCount = (d: Def) => async (sw: ShopReader, filter: unknown[]) => { const [c, total] = await Promise.all([countProducts(sw, [...ACTIVE_MAIN, ...filter]), activeTotal(sw)]); return makeFinding(d, c.count, total, c.sample); };
// Symbol der Standardwährung für Preis-Beispiele (Bereich „Shop-Grunddaten“ aus → ohne Symbol)
const currencySymbol = (sw: ShopReader) => memo(sw, 'currency', () => sw.get('currency', DEFAULT_CURRENCY).then(c => String(c?.symbol ?? c?.isoCode ?? ''), () => ''));
const fromScan = (d: Def, pick: (h: ReturnType<typeof scanHits>) => Hit[] | { count: number; sample: Hit[] }) => async (sw: ShopReader) => {
  const [s, cur] = await Promise.all([scanProducts(sw), currencySymbol(sw)]), h = pick(scanHits(s.rows, cur)), list = Array.isArray(h) ? { count: h.length, sample: h } : h;
  return makeFinding(d, list.count, s.total, list.sample, { atLeast: s.capped });
};

// ---- Produkte: SEO, Bilder, Bestand, Preise ----
registerCheck({ id: 'shopcheck.meta-description', area: 'SEO', scopes: ['products'], run: sw => fromCount(DEFS.metaDescMissing)(sw, [empty('metaDescription')]) });
registerCheck({ id: 'shopcheck.meta-title', area: 'SEO', scopes: ['products'], run: sw => fromCount(DEFS.metaTitleMissing)(sw, [empty('metaTitle')]) });
registerCheck({ id: 'shopcheck.meta-title-long', area: 'SEO', scopes: ['products'], run: fromScan(DEFS.metaTitleLong, h => h.metaTitleLong) });
registerCheck({ id: 'shopcheck.meta-title-duplicate', area: 'SEO', scopes: ['products'], run: fromScan(DEFS.metaTitleDup, h => h.metaTitleDup) });
registerCheck({ id: 'shopcheck.description-thin', area: 'SEO', scopes: ['products'], run: fromScan(DEFS.thin, h => h.thin) });
registerCheck({ id: 'shopcheck.no-image', area: 'Bilder', scopes: ['products'], run: sw => fromCount(DEFS.noImage)(sw, GAP_FILTER.images) });
registerCheck({ id: 'shopcheck.alt-missing', area: 'Bilder', scopes: ['products', 'media'], run: sw => fromCount(DEFS.altMissing)(sw, GAP_FILTER.alt) });
// Bestand: nur Produkte ohne Varianten (bei Variantenprodukten zählt der Bestand der Varianten); Abverkauf aus = trotzdem bestellbar
registerCheck({ id: 'shopcheck.stock-zero', area: 'Daten', scopes: ['products'], run: sw => fromCount(DEFS.stockZero)(sw, [{ type: 'range', field: 'stock', parameters: { lte: 0 } }, eq('isCloseout', false), { type: 'multi', operator: 'or', queries: [eq('childCount', 0), eq('childCount', null)] }]) });
registerCheck({ id: 'shopcheck.price-zero', area: 'Preise', scopes: ['products'], run: fromScan(DEFS.priceZero, h => h.priceZero) });
registerCheck({ id: 'shopcheck.below-purchase', area: 'Preise', scopes: ['products'], run: fromScan(DEFS.belowPurchase, h => h.belowPurchase) });
registerCheck({ id: 'shopcheck.list-price', area: 'Preise', scopes: ['products'], run: fromScan(DEFS.listBelow, h => h.listBelow) });

// ---- Links in Produktbeschreibungen (Ziele gegen den Shop prüfen) ----
registerCheck({ id: 'shopcheck.description-links', area: 'Links', scopes: ['products', 'shop'], run: async sw => {
  const [s, ctx] = await Promise.all([scanProducts(sw), ctxOf(sw)]);
  if (!ctx) return null;
  const withLinks = s.rows.map(r => ({ r, links: extractLinks(r.description) })).filter(x => x.links.length);
  if (!withLinks.length) return null;
  const rep = await checkLinks(sw, withLinks.flatMap(x => x.links), { ctx });
  const bad = new Map(rep.findings.filter(f => f.level === 'wichtig').map(f => [f.href, shortProblem(f)]));
  const hits = withLinks.filter(x => x.links.some(l => bad.has(l.href))).map(x => ({ id: x.r.id, label: `${x.r.label}: ${bad.get(x.links.find(l => bad.has(l.href))!.href)!}` }));
  return makeFinding(DEFS.descLinks, hits.length, s.total, hits, { atLeast: s.capped });
} });

// ---- Kategorien mit eigener Seite im Verkaufskanal ----
async function categoryCounts(sw: ShopReader) {
  return memo(sw, 'categories', async () => {
    const ctx = await ctxOf(sw);
    const base = [eq('active', true), eq('type', 'page'), ...(ctx?.navigationCategoryId ? [{ type: 'contains', field: 'path', value: `|${ctx.navigationCategoryId}|` }] : [{ type: 'range', field: 'level', parameters: { gte: 2 } }])];
    const q = async (extra: unknown[]) => { const r = await sw.search('category', { limit: 5, filter: [...base, ...extra], 'total-count-mode': 1, sort: [{ field: 'level', order: 'ASC' }, { field: 'name', order: 'ASC' }], includes: { category: ['id', 'name', 'translated'] } }); return { count: r.total ?? r.data.length, sample: r.data.map((c: SwEntity) => ({ id: c.id, label: String(c.translated?.breadcrumb?.slice(1).join(' > ') || c.translated?.name || c.name) })) }; };
    const [all, meta, desc] = await Promise.all([q([]), q([empty('metaDescription')]), q([empty('description')])]);
    return { total: all.count, meta, desc };
  });
}
registerCheck({ id: 'shopcheck.category-meta', area: 'SEO', scopes: ['categories'], run: async sw => { const c = await categoryCounts(sw); return makeFinding(DEFS.catMeta, c.meta.count, c.total, c.meta.sample); } });
registerCheck({ id: 'shopcheck.category-description', area: 'SEO', scopes: ['categories'], run: async sw => { const c = await categoryCounts(sw); return makeFinding(DEFS.catDesc, c.desc.count, c.total, c.desc.sample); } });

// ---- Einkaufswelten: Links und feste Produkte (seo_audit entity=pages) ----
registerCheck({ id: 'shopcheck.cms-links', area: 'Links', scopes: ['cms', 'shop'], run: async sw => {
  const ctx = await ctxOf(sw);
  if (!ctx) return null;
  const broken: Hit[] = [], technical: Hit[] = []; let total = 0, checked = 0, techLinks = 0;
  for (let offset = 0; offset < PAGES_MAX; offset += 50) {
    const r = await auditPages(sw, ctx, 50, offset);
    total = r.total ?? 0; checked += r.checked; techLinks += r.counts.technischeLinksMitSeoUrl;
    for (const p of r.pages) {
      const hi = p.problems.find(x => x.level === 'wichtig');
      if (hi) broken.push({ id: p.id, label: `${p.name}: ${shortProblem(hi)}` });
    }
    if (r.counts.technischeLinksMitSeoUrl) technical.push(...(await technicalPages(sw, ctx, offset)));
    if (r.nextOffset == null) break;
  }
  const atLeast = checked < total;
  return [makeFinding(DEFS.cmsBroken, broken.length, total, broken, { atLeast }), makeFinding(DEFS.cmsTechnical, technical.length, total, technical, { atLeast, fixExtra: techLinks ? ` Insgesamt ${techLinks} technische Links.` : '' })].filter((x): x is CheckFinding => !!x);
} });

/** Einkaufswelten dieses Abschnitts (ab offset), deren technische Links (/detail/…) eine SEO-URL hätten */
async function technicalPages(sw: ShopReader, ctx: LinkCtx, offset: number): Promise<Hit[]> {
  const out: Hit[] = [];
  const r = await sw.search('cms-page', { limit: 50, page: offset / 50 + 1, sort: [{ field: 'name', order: 'ASC' }], associations: { sections: { associations: { blocks: { associations: { slots: {} } } } } } });
  for (const p of r.data) {
    const links = collectLinks((p.sections ?? []).flatMap((s: SwEntity) => (s.blocks ?? []).flatMap((b: SwEntity) => (b.slots ?? []).map((sl: SwEntity) => sl.translated?.config ?? sl.config))));
    if (!links.length) continue;
    const rep = await checkLinks(sw, links, { ctx });
    if (rep.rewrites.size) out.push({ id: p.id, label: `${p.name}: ${rep.rewrites.size} technische ${rep.rewrites.size === 1 ? 'Link' : 'Links'}` });
  }
  return out;
}

// ---- Übersetzungen: nur wenn der Shop mehrere Sprachen in Storefront-Domains nutzt ----
registerCheck({ id: 'shopcheck.translations', area: 'Sprachen', scopes: ['products', 'shop'], run: async sw => {
  const [langs, channels, ctx] = await Promise.all([loadLanguages(sw), sw.salesChannels(), ctxOf(sw)]);
  const used = [...new Set(channels.flatMap(s => (s.domains ?? []).filter((d: SwEntity) => /^https?:\/\//.test(String(d.url))).map((d: SwEntity) => String(d.languageId))))];
  if (used.length < 2) return null;
  // Hauptsprache (Standard-Domain) und Systemsprache tragen die Texte; geprüft werden die übrigen Sprachen
  const check = langs.filter(l => used.includes(l.id) && l.id !== SYSTEM_LANGUAGE && l.id !== ctx?.languageId);
  const total = await activeTotal(sw), out: CheckFinding[] = [];
  for (const l of check) {
    const c = await countProducts(sw, [...ACTIVE_MAIN, { type: 'not', operator: 'and', queries: [eq('translations.languageId', l.id)] }]);
    const f = makeFinding(DEFS.translation, c.count, total, c.sample, { title: `Produkte ohne Übersetzung: ${l.name}`, idSuffix: l.locale || l.id, fixExtra: ` Zielsprache: ${l.name}${l.locale ? ` (${l.locale})` : ''}.` });
    if (f) out.push(f);
  }
  return out;
} });

// ---- Werkzeug ----
const view = (f: CheckFinding) => ({ id: f.id, area: f.area, severity: SEVERITY_LABEL[f.severity], title: f.title, betroffen: countText(f), hint: f.hint, beispiele: f.sample?.map(s => s.label), fixPrompt: f.fixPrompt });

export const shopcheck: Feature = {
  key: 'shopcheck',
  platforms: 'all',
  toolNames: ['run_shop_check', 'list_checks', 'create_check', 'update_check', 'set_check_enabled', 'delete_check'],
  tools: session => [
    tool('run_shop_check', 'Liefert die Befunde des Shop-Checks (dasselbe wie auf der Startseite): was im Shop gerade nicht stimmt, je Punkt Bereich, Gewicht (Wichtig/Mittel/Hinweis), Anzahl, Beispiele, Begründung und fixPrompt (Auftrag, wie Lotse es mit den propose_*-Werkzeugen behebt). Nutzt das gespeicherte Ergebnis (bis 6 Std. alt), sonst wird neu geprüft (kann bei großen Katalogen etwas dauern). Ändert nichts im Shop. Geeignet für „Was sollte ich als Nächstes verbessern?“.',
      { area: z.string().optional().describe('nur diesen Bereich, z. B. "SEO", "Bilder", "Preise", "Links", "Daten", "Sprachen"'), refresh: z.boolean().optional().describe('true = jetzt neu prüfen statt gespeichertes Ergebnis') },
      guard(async a => {
        const run = await latestShopCheck(!!a.refresh);
        const list = a.area ? run.findings.filter(f => f.area.toLowerCase() === a.area!.trim().toLowerCase()) : run.findings;
        const areas = [...new Set(run.findings.map(f => f.area))];
        return ok({
          checkedAt: run.checkedAt, geprueft: ago(run.checkedAt), zusammenfassung: summaryText(list), areas,
          findings: list.map(view),
          ...(run.errors.length ? { fehler: run.errors, ...(runHealth(run) === 'unvollstaendig' ? { unvollstaendig: `${run.errors.length} von ${run.checks ?? 0} Prüfungen gescheitert: Ergebnis nicht verlässlich, nicht als „alles in Ordnung“ deuten.` } : {}) } : {}),
          ...(run.skipped?.length ? { nichtGeprueft: `${run.skipped.length} Prüfungen übersprungen (Bereich in den Einstellungen gesperrt)` } : {}),
          hint: 'Reihenfolge = Priorität (Wichtig zuerst, dann Anzahl). Zum Beheben den fixPrompt als Plan nutzen: Umfang vorher per ask_user bestätigen, nichts erfinden, Änderungen nur über propose_*-Werkzeuge.',
        });
      })),

    tool('list_checks', 'Listet ALLE Prüfungen des Shop-Checks dieser Plattform: eingebaute und eigene, je id, Titel, Bereich, an/aus und bei eigenen die Regel. Vor create_check/update_check/set_check_enabled/delete_check aufrufen, um IDs zu kennen.', {},
      guard(async () => {
        const list = checkList(session.platform);
        return ok({ pruefungen: list.map(c => ({ id: c.id, titel: c.title, bereich: c.area, an: c.enabled, eigene: c.custom || undefined, regel: c.rule })),
          felder: Object.fromEntries(Object.entries(CHECK_FIELDS).map(([k, v]) => [k, v.label])), vergleiche: Object.keys(CHECK_OPS) });
      })),

    tool('create_check', 'Legt eine EIGENE Prüfung für den Shop-Check an (z. B. „Produktbeschreibung unter 2000 Zeichen“, „Bestand unter 5“, „Meta-Description fehlt“). Die Prüfung gilt für alle aktiven Produkte und wird so ausgewertet: Bedingungen über neutrale Felder, kein Code. Zeigt dem Nutzer vorher die Regel samt Trefferzahl im Shop und fragt, ob sie gespeichert werden soll. Erscheint danach als normaler Befund auf der Startseite.',
      {
        title: z.string().describe('Kurzer Titel des Befunds, z. B. „Beschreibung unter 2000 Zeichen“'),
        conditions: z.array(z.object({ field: z.enum(Object.keys(CHECK_FIELDS) as [CheckField, ...CheckField[]]), op: z.enum(Object.keys(CHECK_OPS) as [CheckOp, ...CheckOp[]]), value: z.union([z.number(), z.boolean()]) })).min(1).max(5)
          .describe('Bedingungen; Beispiel: {field:"descriptionChars", op:"lt", value:2000}. hasImage braucht op eq/neq und true/false'),
        match: z.enum(['all', 'any']).optional().describe('all = alle Bedingungen müssen zutreffen (Standard), any = mindestens eine'),
        severity: z.enum(['hoch', 'mittel', 'niedrig']).optional(), area: z.string().optional().describe('Bereich auf der Startseite, Standard „Eigene Prüfungen“'),
        hint: z.string().optional().describe('Ein Satz: warum das wichtig ist'),
      },
      guard(async a => {
        const draft = parseCheckInput({ title: a.title, conditions: a.conditions, match: a.match, severity: a.severity, area: a.area, hint: a.hint });
        const preview = await dryRun(session, { ...draft, id: 'preview', createdAt: '' });
        const answer = await session.askUser({
          question: `Neue Prüfung im Shop-Check:\n**${draft.title}**\nTrifft zu, wenn: ${conditionsText(draft)}.\n${preview}\nSpeichern?`,
          options: [{ label: 'Ja, anlegen' }, { label: 'Nein' }],
        });
        if (!/^\s*ja\b/i.test(answer)) return ok({ status: 'nicht angelegt', antwort: answer });
        const c = addCustom(draft);
        void recheckShopCheck().catch(() => {});
        return ok({ status: 'angelegt', id: c.id, hinweis: 'Läuft ab sofort bei jedem Shop-Check mit; die Startseite aktualisiert sich nach dem nächsten Durchlauf.' });
      })),

    tool('update_check', 'Ändert eine EIGENE Prüfung (id aus list_checks, beginnt mit custom.): Titel, Bedingungen, Verknüpfung, Gewicht, Bereich, Hinweis. Nur die angegebenen Felder ändern sich; bei conditions die vollständige neue Liste senden. Fragt den Nutzer vorher. Eingebaute Prüfungen lassen sich nur an/ausschalten.',
      {
        id: z.string(), title: z.string().optional(),
        conditions: z.array(z.object({ field: z.enum(Object.keys(CHECK_FIELDS) as [CheckField, ...CheckField[]]), op: z.enum(Object.keys(CHECK_OPS) as [CheckOp, ...CheckOp[]]), value: z.union([z.number(), z.boolean()]) })).min(1).max(5).optional(),
        match: z.enum(['all', 'any']).optional(), severity: z.enum(['hoch', 'mittel', 'niedrig']).optional(), area: z.string().optional(), hint: z.string().optional(),
      },
      guard(async ({ id, ...patch }) => {
        const cur = listCustom().find(c => c.id === id);
        if (!cur) return fail(id.startsWith(CUSTOM_PREFIX) ? 'Eigene Prüfung nicht gefunden (list_checks)' : 'Eingebaute Prüfungen lassen sich nur an-/ausschalten (set_check_enabled).');
        const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
        const next = { ...cur, ...parseCheckInput({ ...cur, ...clean }) };
        const preview = await dryRun(session, next);
        const answer = await session.askUser({ question: `Prüfung „${cur.title}“ ändern?\nNeu: **${next.title}**, trifft zu, wenn: ${conditionsText(next)}.\n${preview}`, options: [{ label: 'Ja, ändern' }, { label: 'Nein' }] });
        if (!/^\s*ja\b/i.test(answer)) return ok({ status: 'nicht geändert', antwort: answer });
        const c = updateCustom(id, clean);
        void recheckShopCheck().catch(() => {});
        return ok({ status: 'geändert', id: c.id });
      })),

    tool('set_check_enabled', 'Schaltet EINE Prüfung des Shop-Checks an oder aus (eingebaut oder eigen; id aus list_checks). Aus = wird nicht mehr geprüft und taucht nicht mehr auf der Startseite auf. Beim Ausschalten fragt das Werkzeug den Nutzer.',
      { id: z.string(), enabled: z.boolean() },
      guard(async ({ id, enabled }) => {
        const c = checkList(session.platform).find(x => x.id === id);
        if (!c) return fail('Prüfung nicht gefunden (list_checks)');
        if (c.enabled === enabled) return ok({ status: 'unverändert', an: enabled });
        if (!enabled) {
          const answer = await session.askUser({ question: `Prüfung „${c.title}“ (${c.area}) ausschalten? Sie wird dann nicht mehr geprüft und nicht mehr angezeigt.`, options: [{ label: 'Ja, ausschalten' }, { label: 'Nein' }] });
          if (!/^\s*ja\b/i.test(answer)) return ok({ status: 'nicht geändert', antwort: answer });
        }
        setCheckEnabled(id, enabled);
        void recheckShopCheck().catch(() => {});
        return ok({ status: enabled ? 'eingeschaltet' : 'ausgeschaltet', id });
      })),

    tool('delete_check', 'Löscht eine EIGENE Prüfung (id aus list_checks, beginnt mit custom.). Fragt den Nutzer vorher. Eingebaute Prüfungen lassen sich nur ausschalten.',
      { id: z.string() },
      guard(async ({ id }) => {
        const c = listCustom().find(x => x.id === id);
        if (!c) return fail('Eigene Prüfung nicht gefunden (list_checks)');
        const answer = await session.askUser({ question: `Eigene Prüfung „${c.title}“ löschen?`, options: [{ label: 'Ja, löschen' }, { label: 'Nein' }] });
        if (!/^\s*ja\b/i.test(answer)) return ok({ status: 'nicht gelöscht' });
        removeCustom(id);
        void recheckShopCheck().catch(() => {});
        return ok({ status: 'gelöscht' });
      })),
  ] as AnyTool[],
};

/** Probelauf gegen die echten Produkte, damit der Nutzer vor dem Speichern die Trefferzahl sieht */
async function dryRun(session: { platform: PlatformKind; reader: unknown }, c: CustomCheck): Promise<string> {
  try {
    const { getPlatform } = await import('../platform');
    const scan = await getPlatform(session.platform).scanProducts(session.reader);
    const f = customFinding(c, scan);
    const base = `${scan.capped ? 'mindestens ' : ''}`;
    return f ? `Würde aktuell **${base}${f.count.toLocaleString('de-DE')} von ${scan.total.toLocaleString('de-DE')} Produkten** melden${f.sample?.length ? `, z. B. ${f.sample.slice(0, 3).map(s => s.label).join('; ')}` : ''}.`
      : `Würde aktuell **nichts** melden (${scan.total.toLocaleString('de-DE')} Produkte geprüft).`;
  } catch (e) { return `Probelauf nicht möglich (${errMsg(e)}); die Prüfung wird trotzdem gespeichert.`; }
}
