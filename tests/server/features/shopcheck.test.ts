import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listChecks } from '../../../src/server/checks';
import type { Criteria } from '../../../src/server/policy';
import type { ShopReader, SwEntity } from '../../../src/server/shopware';
import { runHealth } from '@/lib/shopcheck';
import { perRun, runChecks } from '../../../src/server/shopcheck-run';
import { SCAN_MAX, SCAN_PAGE, scanProducts } from '../../../src/server/features/shopcheck';
import { SYSTEM_LANGUAGE } from '../../../src/server/features/sprachen';

/** Fake-Shop: total aktive Produkte, jedes 10. mit Preis 0 */
function fakeShop(total: number) {
  const calls: Criteria[] = [];
  const prod = (i: number): SwEntity => ({ id: `p${i}`, productNumber: `N-${i}`, translated: { name: `P${i}`, metaTitle: `T${i}`, description: 'wort '.repeat(60) }, price: [{ currencyId: 'b7d2554b0ce847cd82f3ac9bd1c0dfca', gross: i % 10 ? 10 : 0 }] });
  const sw: ShopReader = {
    base: 'http://shop',
    async search(entity, c = {}) {
      calls.push(c);
      if (entity !== 'product') return { data: [] };
      const limit = Number(c.limit ?? 25), page = Number(c.page ?? 1), from = (page - 1) * limit;
      return { data: Array.from({ length: Math.max(0, Math.min(limit, total - from)) }, (_, k) => prod(from + k)), total };
    },
    get: async () => null, salesChannels: async () => [], req: async () => null,
  };
  return { sw, calls };
}

test('scanProducts: seitenweise, nur benötigte Felder, gedeckelt bei SCAN_MAX', async () => {
  const { sw, calls } = fakeShop(SCAN_MAX + 700);
  const s = await scanProducts(sw);
  assert.equal(s.rows.length, SCAN_MAX);
  assert.equal(s.total, SCAN_MAX + 700);
  assert.equal(s.capped, true);
  assert.equal(calls.length, SCAN_MAX / SCAN_PAGE);
  assert.ok(calls.every(c => c.includes && c.limit === SCAN_PAGE));
  await scanProducts(sw); // je Lese-Client nur einmal
  assert.equal(calls.length, SCAN_MAX / SCAN_PAGE);
});

test('Preis-0-Prüfung: gedeckelter Katalog meldet „mindestens“', async () => {
  const { sw } = fakeShop(SCAN_MAX + 10);
  const c = listChecks().find(x => x.id === 'shopcheck.price-zero')!;
  const f = await c.run(sw) as { count: number; total: number; atLeast?: boolean; fixPrompt: string };
  assert.equal(f.count, SCAN_MAX / 10);
  assert.equal(f.total, SCAN_MAX + 10);
  assert.equal(f.atLeast, true);
  assert.match(f.fixPrompt, /mindestens 250 Produkte/);
});

test('Kernprüfungen sind registriert und nennen ihre Bereiche', () => {
  const ids = listChecks().map(c => c.id);
  for (const id of ['shopcheck.meta-description', 'shopcheck.no-image', 'shopcheck.stock-zero', 'shopcheck.below-purchase', 'shopcheck.cms-links', 'shopcheck.translations']) assert.ok(ids.includes(id), id);
  assert.ok(listChecks().filter(c => c.id.startsWith('shopcheck.')).every(c => c.scopes?.length));
});

test('runChecks: zweiter Durchlauf mit demselben Lese-Client sieht geänderte Daten (Zwischenspeicher nur je Durchlauf)', async () => {
  let zero = true;
  const sw: ShopReader = {
    base: 'http://shop',
    async search(entity) {
      if (entity !== 'product') return { data: [], total: 0 };
      return { data: [{ id: 'p1', productNumber: 'N-1', translated: { name: 'P1' }, price: [{ currencyId: 'b7d2554b0ce847cd82f3ac9bd1c0dfca', gross: zero ? 0 : 10 }] }], total: 1 };
    },
    get: async () => null, salesChannels: async () => [], req: async () => null,
  };
  const checks = listChecks().filter(c => c.id === 'shopcheck.price-zero');
  assert.equal((await runChecks(sw, checks)).findings.length, 1);
  zero = false;
  assert.equal((await runChecks(sw, checks)).findings.length, 0);
});

test('Shop nicht erreichbar: alle Prüfungen scheitern, kein „Alles im grünen Bereich“', async () => {
  const down = () => Promise.reject(new Error('fetch failed'));
  const sw: ShopReader = { base: 'http://shop', search: down, get: down, salesChannels: down, req: down };
  const run = await runChecks(sw, listChecks().filter(c => c.id.startsWith('shopcheck.')));
  assert.equal(run.findings.length, 0);
  assert.equal(run.errors.length, run.checks);
  assert.equal(runHealth(run), 'unvollstaendig');
});

// ---- Kategorien und Übersetzungen: Fake-Shop, der die DAL-Filter dieser Prüfungen auswertet ----
type Filter = { type: string; field: string; value?: unknown; queries?: Filter[]; parameters?: { gte?: number } };
const DE = SYSTEM_LANGUAGE, EN = 'e'.repeat(32), FR = 'f'.repeat(32);
function langShop() {
  const match = (r: SwEntity, f: Filter): boolean => {
    switch (f.type) {
      case 'equals': return f.field === 'translations.languageId' ? (r.translations ?? []).some((t: SwEntity) => t.languageId === f.value) : (r[f.field] ?? null) === f.value;
      case 'not': return !f.queries!.every(q => match(r, q));
      case 'multi': return f.queries!.some(q => match(r, q));
      case 'contains': return String(r[f.field] ?? '').includes(String(f.value));
      case 'range': return Number(r[f.field]) >= (f.parameters!.gte ?? -Infinity);
      default: return true;
    }
  };
  const cat = (id: string, path: string, level: number, extra: SwEntity = {}): SwEntity => ({ id, path, level, active: true, type: 'page', translated: { name: id.toUpperCase(), breadcrumb: ['Home', id.toUpperCase()] }, metaDescription: 'ok', description: 'text', ...extra });
  const db: Record<string, SwEntity[]> = {
    product: [
      { id: 'p1', productNumber: 'N-1', active: true, parentId: null, translated: { name: 'P1' }, translations: [{ languageId: DE }, { languageId: EN }] },
      { id: 'p2', productNumber: 'N-2', active: true, parentId: null, translated: { name: 'P2' }, translations: [{ languageId: DE }] },
      { id: 'p3', productNumber: 'N-3', active: true, parentId: null, translated: { name: 'P3' }, translations: [{ languageId: DE }, { languageId: EN }] },
    ],
    language: [{ id: DE, name: 'Deutsch', locale: { code: 'de-DE' } }, { id: EN, name: 'English', locale: { code: 'en-GB' } }, { id: FR, name: 'Français', locale: { code: 'fr-FR' } }],
    category: [cat('nav', '|', 1), cat('c1', '|nav|', 2, { metaDescription: null }), cat('c2', '|nav|c1|', 3, { description: '' }), cat('c3', '|other|', 2, { metaDescription: null }), cat('c4', '|nav|', 2, { type: 'link', metaDescription: null })],
  };
  const calls: string[] = [];
  const sw: ShopReader = {
    base: 'http://shop',
    async search(entity, c = {}) {
      calls.push(entity);
      const rows = (db[entity] ?? []).filter(r => ((c.filter as Filter[] | undefined) ?? []).every(f => match(r, f)));
      return { data: rows.slice(0, Number(c.limit ?? 25)), total: rows.length };
    },
    get: async () => null, req: async () => null,
    salesChannels: async () => [{ id: 'sc', languageId: DE, navigationCategoryId: 'nav', domains: [{ url: 'https://shop.de', languageId: DE }, { url: 'https://shop.de/en', languageId: EN }] }],
  };
  return { sw, calls };
}
type F = { id: string; count: number; total: number; title: string; sample: { id: string; label: string }[]; fixPrompt: string };
const check = (id: string) => listChecks().find(c => c.id === id)!;

test('Übersetzungen: nur Sprachen mit Storefront-Domain außer System-/Hauptsprache; Hauptsprache zählt nie als fehlend', async () => {
  const { sw } = langShop();
  const out = [await check('shopcheck.translations').run(sw)].flat() as F[];
  assert.equal(out.length, 1, 'Französisch hat keine Domain, Deutsch ist Hauptsprache');
  assert.deepEqual([out[0].id, out[0].count, out[0].total, out[0].title], ['sprachen.missing-translation.en-GB', 1, 3, 'Produkte ohne Übersetzung: English']);
  assert.deepEqual(out[0].sample.map(s => s.id), ['p2']);
  assert.match(out[0].fixPrompt, /Zielsprache: English \(en-GB\)/);
  // nur eine Domain-Sprache: keine Prüfung
  const one = { ...sw, salesChannels: async () => [{ id: 'sc', languageId: DE, domains: [{ url: 'https://shop.de', languageId: DE }] }] };
  assert.equal(await check('shopcheck.translations').run(one), null);
});

test('Kategorien: nur aktive Seiten unter der Navigation des Kanals zählen; beide Prüfungen teilen sich die Zählung', async () => {
  const { sw, calls } = langShop();
  const ro = perRun(sw);
  const [meta, desc] = await Promise.all([check('shopcheck.category-meta').run(ro), check('shopcheck.category-description').run(ro)]) as F[];
  assert.deepEqual([meta.count, meta.total, meta.sample.map(s => s.label)], [1, 2, ['C1']], 'c3 liegt außerhalb der Navigation, c4 ist ein Link');
  assert.deepEqual([desc.count, desc.total, desc.sample.map(s => s.id)], [1, 2, ['c2']]);
  assert.equal(calls.filter(e => e === 'category').length, 3, 'gesamt + Meta + Beschreibung, nur einmal je Durchlauf');
  // ohne Navigationskategorie: Fallback auf Ebene ≥ 2
  const noNav = { ...sw, salesChannels: async () => [{ id: 'sc', languageId: DE, domains: [{ url: 'https://shop.de', languageId: DE }] }] };
  const m2 = await check('shopcheck.category-meta').run(perRun(noNav)) as F;
  assert.deepEqual([m2.count, m2.total], [2, 3], 'c1 und c3 ohne Meta-Description');
});
