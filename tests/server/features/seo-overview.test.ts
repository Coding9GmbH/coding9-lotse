import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// SEO-Übersicht: ohne Anbindung leer, mit Sistrix fertige Aufträge (Shop-Zuordnung, OnPage), Quellenausfall blockiert nichts
process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-seo-'));
const KEY = 'sx_0123456789abcdef0123456789abcdef';
const { startFakeSistrix } = await import('../../support/sistrix-fake');
const fake = await startFakeSistrix({ apiKey: KEY });
process.env.LOTSE_SISTRIX_API_BASE = fake.base;
after(() => fake.close());

const A = await import('../../../src/server/features/sistrix-api');
const { seoOverview } = await import('../../../src/server/features/seo-overview');

const PAGE = 'https://www.shop.de/Vasen/Kiesel';
const lookup = { mapUrls: async (urls: string[]) => new Map(urls.map(u => [u, u === PAGE ? { kind: 'category', id: 'c1', name: 'Vasen' } : null])) } as never;

test('ohne Anbindung: keine Quelle, keine Einträge', async () => {
  const o = await seoOverview(lookup);
  assert.deepEqual([o.gsc, o.sistrix, o.items.length, o.errors.length], [false, false, 0, 0]);
});

test('Sistrix: Chancen werden dem Shop zugeordnet und werden zu fertigen Aufträgen, OnPage nach Fehlern zuerst', async () => {
  A.saveSistrix({ key: KEY, domain: 'shop.de', country: 'de' });
  fake.data['domain.opportunities'] = [{ kw: 'vase steinzeug', gain: '72', position: '11', url: PAGE, competition: '40' }, { kw: 'ohne zuordnung', gain: '90', position: '12', url: 'https://www.shop.de/unbekannt' }];
  fake.data['project.overview'] = [{ hash: 'h1', name: 'shop.de' }];
  fake.data['project.onpage.crawl'] = [{ type: 'warning', name: 'title_too_long', count: '40' }, { type: 'error', name: 'http_404', count: '7' }, { type: 'error', name: 'leer', count: '0' }];
  const o = await seoOverview(lookup);
  assert.equal(o.sistrix, true);
  const kw = o.items.filter(i => i.kind === 'keyword');
  assert.equal(kw.length, 1, 'nicht zuordenbare Seite bekommt keinen Auftrag');
  assert.match(kw[0].prompt, /„vase steinzeug“.*Kategorie „Vasen“ \(ID c1\).*get_category/s);
  assert.deepEqual(kw[0].metrics.map(m => m.label), ['Gewinn (0–100)', 'Position']);
  const on = o.items.filter(i => i.kind === 'onpage');
  assert.deepEqual(on.map(i => i.id), ['sistrix:onpage:http_404', 'sistrix:onpage:title_too_long']);
  assert.match(on[0].prompt, /sistrix_onpage mit issue="http_404"/);
  assert.ok(o.items.every(i => i.prompt.length > 40 && i.title));
});

test('Quelle fällt aus: Fehler wird gemeldet, nichts bricht', async () => {
  A.clearSistrixCache();
  fake.failNext = { code: '202', message: 'Not enough credits' };
  const o = await seoOverview(lookup);
  assert.equal(o.errors.length, 1); assert.equal(o.errors[0].source, 'sistrix'); assert.match(o.errors[0].error, /Not enough credits/);
  assert.deepEqual(o.items, []);
});
