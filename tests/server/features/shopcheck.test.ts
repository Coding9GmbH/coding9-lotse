import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listChecks } from '../../../src/server/checks';
import type { Criteria } from '../../../src/server/policy';
import type { ShopReader, SwEntity } from '../../../src/server/shopware';
import { runHealth } from '@/lib/shopcheck';
import { perRun, runChecks } from '../../../src/server/shopcheck-run';
import { SCAN_MAX, SCAN_PAGE, scanProducts } from '../../../src/server/features/shopcheck';
import { SYSTEM_LANGUAGE } from '../../../src/server/features/translations';

/** Fake shop: `total` active products, every 10th with price 0 */
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

test('scanProducts: paginated, only needed fields, capped at SCAN_MAX', async () => {
  const { sw, calls } = fakeShop(SCAN_MAX + 700);
  const s = await scanProducts(sw);
  assert.equal(s.rows.length, SCAN_MAX);
  assert.equal(s.total, SCAN_MAX + 700);
  assert.equal(s.capped, true);
  assert.equal(calls.length, SCAN_MAX / SCAN_PAGE);
  assert.ok(calls.every(c => c.includes && c.limit === SCAN_PAGE));
  await scanProducts(sw); // only once per read client
  assert.equal(calls.length, SCAN_MAX / SCAN_PAGE);
});

test('Price-0 check: capped catalog reports "mindestens" (at least)', async () => {
  const { sw } = fakeShop(SCAN_MAX + 10);
  const c = listChecks().find(x => x.id === 'shopcheck.price-zero')!;
  const f = await c.run(sw) as { count: number; total: number; atLeast?: boolean; fixPrompt: string };
  assert.equal(f.count, SCAN_MAX / 10);
  assert.equal(f.total, SCAN_MAX + 10);
  assert.equal(f.atLeast, true);
  assert.match(f.fixPrompt, /mindestens 250 Produkte/);
});

test('Core checks are registered and name their areas', () => {
  const ids = listChecks().map(c => c.id);
  for (const id of ['shopcheck.meta-description', 'shopcheck.no-image', 'shopcheck.stock-zero', 'shopcheck.below-purchase', 'shopcheck.cms-links', 'shopcheck.translations']) assert.ok(ids.includes(id), id);
  assert.ok(listChecks().filter(c => c.id.startsWith('shopcheck.')).every(c => c.scopes?.length));
});

test('runChecks: second run with the same read client sees changed data (cache only per run)', async () => {
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

test('Shop unreachable: all checks fail, no "Alles im grünen Bereich"', async () => {
  const down = () => Promise.reject(new Error('fetch failed'));
  const sw: ShopReader = { base: 'http://shop', search: down, get: down, salesChannels: down, req: down };
  const run = await runChecks(sw, listChecks().filter(c => c.id.startsWith('shopcheck.')));
  assert.equal(run.findings.length, 0);
  assert.equal(run.errors.length, run.checks);
  assert.equal(runHealth(run), 'unvollstaendig');
});

// ---- Categories and translations: fake shop that evaluates the DAL filters of these checks ----
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

test('Translations: only languages with a storefront domain except system/main language; main language never counts as missing', async () => {
  const { sw } = langShop();
  const out = [await check('shopcheck.translations').run(sw)].flat() as F[];
  assert.equal(out.length, 1, 'French has no domain, German is the main language');
  assert.deepEqual([out[0].id, out[0].count, out[0].total, out[0].title], ['sprachen.missing-translation.en-GB', 1, 3, 'Produkte ohne Übersetzung: English']);
  assert.deepEqual(out[0].sample.map(s => s.id), ['p2']);
  assert.match(out[0].fixPrompt, /Zielsprache: English \(en-GB\)/);
  // only one domain language: no check
  const one = { ...sw, salesChannels: async () => [{ id: 'sc', languageId: DE, domains: [{ url: 'https://shop.de', languageId: DE }] }] };
  assert.equal(await check('shopcheck.translations').run(one), null);
});

test('Categories: only active pages under the channel navigation count; both checks share the count', async () => {
  const { sw, calls } = langShop();
  const ro = perRun(sw);
  const [meta, desc] = await Promise.all([check('shopcheck.category-meta').run(ro), check('shopcheck.category-description').run(ro)]) as F[];
  assert.deepEqual([meta.count, meta.total, meta.sample.map(s => s.label)], [1, 2, ['C1']], 'c3 is outside the navigation, c4 is a link');
  assert.deepEqual([desc.count, desc.total, desc.sample.map(s => s.id)], [1, 2, ['c2']]);
  assert.equal(calls.filter(e => e === 'category').length, 3, 'total + meta + description, only once per run');
  // without navigation category: fall back to level ≥ 2
  const noNav = { ...sw, salesChannels: async () => [{ id: 'sc', languageId: DE, domains: [{ url: 'https://shop.de', languageId: DE }] }] };
  const m2 = await check('shopcheck.category-meta').run(perRun(noNav)) as F;
  assert.deepEqual([m2.count, m2.total], [2, 3], 'c1 and c3 without meta description');
});
