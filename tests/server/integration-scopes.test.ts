import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// AI access: manufacturers have their own switch, Search Console and Sistrix are data switches (tools, checks, SEO overview)
process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-scopes-'));
const KEY = 'sx_0123456789abcdef0123456789abcdef';
const { startFakeSistrix } = await import('../support/sistrix-fake');
const fake = await startFakeSistrix({ apiKey: KEY, data: { 'domain.visibilityindex': [{ date: '2026-10-05', value: '0.058' }] } });
process.env.LOTSE_SISTRIX_API_BASE = fake.base;
after(() => fake.close());

const { SCOPES, SCOPE_KEYS, DEFAULT_SCOPES, createGuard } = await import('../../src/server/policy');
const { updateSettings, getSettings } = await import('../../src/server/settings');
const A = await import('../../src/server/features/sistrix-api');
const S = await import('../../src/server/features/sistrix');
const { seoOverview } = await import('../../src/server/features/seo-overview');
const { listChecks } = await import('../../src/server/checks');

test('manufacturers are a separate area, no longer under products; integrations have no shop entities', () => {
  assert.deepEqual(SCOPES.manufacturers.entities, ['product-manufacturer']);
  assert.ok(!SCOPES.products.entities.includes('product-manufacturer'));
  assert.deepEqual([SCOPES.gsc.entities, SCOPES.sistrix.entities], [[], []]);
  assert.ok(['manufacturers', 'gsc', 'sistrix'].every(k => DEFAULT_SCOPES[k as keyof typeof DEFAULT_SCOPES] === true && SCOPE_KEYS.includes(k as never)));
});

test('web research is a separate switch without shop entities and off by default; enabling it is persisted', () => {
  assert.deepEqual(SCOPES.web.entities, []);
  assert.equal(DEFAULT_SCOPES.web, false);
  assert.ok(SCOPE_KEYS.filter(k => k !== 'web').every(k => DEFAULT_SCOPES[k]), 'all other areas stay on');
  assert.equal(getSettings().scopes.web, false);
  updateSettings({ scopes: { web: true } });
  assert.equal(getSettings().scopes.web, true);
  updateSettings({ scopes: { web: false } });
  assert.equal(getSettings().scopes.web, false);
});

test('area "Hersteller" (manufacturers) off: reading manufacturers is rejected, products stay readable', async () => {
  const events: { op: string; entity: string; denied?: string }[] = [];
  const g = createGuard({ getScopes: () => ({ ...DEFAULT_SCOPES, manufacturers: false }), onAccess: a => events.push(a) });
  assert.throws(() => g.checkSearch('product-manufacturer', {}), /Hersteller/);
  assert.doesNotThrow(() => g.checkSearch('product', {}));
  assert.equal(events.at(-1)?.denied !== undefined, true);
});

test('Sistrix switch off: tool reports locked, shop checks are bound to the area, SEO overview hides the source', async () => {
  A.saveSistrix({ key: KEY, domain: 'shop.de', country: 'de' });
  const session = { platform: 'shopware', lookup: { mapUrls: async () => new Map() } } as never;
  const run = async () => { const t = S.sistrix.tools(session).find(x => x.name === 'sistrix_visibility')!; return (await t.handler({}, {}) as { content: { text: string }[]; isError?: boolean }); };
  assert.equal((await run()).isError, undefined, 'on: tool returns data');
  assert.equal((await seoOverview({ mapUrls: async () => new Map() } as never)).sistrix, true);

  updateSettings({ scopes: { sistrix: false } });
  assert.equal(getSettings().scopes.sistrix, false);
  const r = await run();
  assert.equal(r.isError, true); assert.match(r.content[0].text, /Zugriff der KI auf Sistrix ist ausgeschaltet.*KI-Zugriff/);
  assert.equal((await seoOverview({ mapUrls: async () => new Map() } as never)).sistrix, false);
  const checks = listChecks().filter(c => c.area === 'Sistrix');
  assert.ok(checks.length === 2 && checks.every(c => c.scopes?.includes('sistrix')));
  assert.ok(listChecks().filter(c => c.area === 'Search Console').every(c => c.scopes?.includes('gsc')));
  updateSettings({ scopes: { sistrix: true } });
});
