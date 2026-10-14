import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// KI-Zugriff: Hersteller haben einen eigenen Schalter, Search Console und Sistrix sind Daten-Schalter (Werkzeuge, Prüfungen, SEO-Übersicht)
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

test('Hersteller sind ein eigener Bereich, nicht mehr bei den Produkten; Integrationen haben keine Shop-Entitäten', () => {
  assert.deepEqual(SCOPES.manufacturers.entities, ['product-manufacturer']);
  assert.ok(!SCOPES.products.entities.includes('product-manufacturer'));
  assert.deepEqual([SCOPES.gsc.entities, SCOPES.sistrix.entities], [[], []]);
  assert.ok(['manufacturers', 'gsc', 'sistrix'].every(k => DEFAULT_SCOPES[k as keyof typeof DEFAULT_SCOPES] === true && SCOPE_KEYS.includes(k as never)));
});

test('Internetrecherche ist ein eigener Schalter ohne Shop-Entitäten und standardmäßig aus; einschalten bleibt gespeichert', () => {
  assert.deepEqual(SCOPES.web.entities, []);
  assert.equal(DEFAULT_SCOPES.web, false);
  assert.ok(SCOPE_KEYS.filter(k => k !== 'web').every(k => DEFAULT_SCOPES[k]), 'alle übrigen Bereiche bleiben an');
  assert.equal(getSettings().scopes.web, false);
  updateSettings({ scopes: { web: true } });
  assert.equal(getSettings().scopes.web, true);
  updateSettings({ scopes: { web: false } });
  assert.equal(getSettings().scopes.web, false);
});

test('Bereich „Hersteller“ aus: Lesen von Herstellern wird abgewiesen, Produkte bleiben lesbar', async () => {
  const events: { op: string; entity: string; denied?: string }[] = [];
  const g = createGuard({ getScopes: () => ({ ...DEFAULT_SCOPES, manufacturers: false }), onAccess: a => events.push(a) });
  assert.throws(() => g.checkSearch('product-manufacturer', {}), /Hersteller/);
  assert.doesNotThrow(() => g.checkSearch('product', {}));
  assert.equal(events.at(-1)?.denied !== undefined, true);
});

test('Sistrix-Schalter aus: Werkzeug meldet gesperrt, Shop-Prüfungen sind an den Bereich gebunden, SEO-Übersicht blendet die Quelle aus', async () => {
  A.saveSistrix({ key: KEY, domain: 'shop.de', country: 'de' });
  const session = { platform: 'shopware', lookup: { mapUrls: async () => new Map() } } as never;
  const run = async () => { const t = S.sistrix.tools(session).find(x => x.name === 'sistrix_visibility')!; return (await t.handler({}, {}) as { content: { text: string }[]; isError?: boolean }); };
  assert.equal((await run()).isError, undefined, 'an: Werkzeug liefert');
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
