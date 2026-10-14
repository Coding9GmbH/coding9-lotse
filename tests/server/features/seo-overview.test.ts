import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SeoItem, SeoOverview } from '../../../src/lib/protocol';

// SEO overview: empty without connection, ready-made tasks with Sistrix (shop mapping, OnPage), a failing source blocks nothing,
// project choice with several Optimizer projects, stored state (no credits) and done/ignored marks
process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-seo-'));
const KEY = 'sx_0123456789abcdef0123456789abcdef';
const { startFakeSistrix } = await import('../../support/sistrix-fake');
const fake = await startFakeSistrix({ apiKey: KEY });
process.env.LOTSE_SISTRIX_API_BASE = fake.base;
after(() => fake.close());

const A = await import('../../../src/server/features/sistrix-api');
const S = await import('../../../src/server/features/seo-overview');
const { seoOverview, seoOverviewCached, seoOverviewStored, setSeoMark, reconcileMarks } = S;

const PAGE = 'https://www.shop.de/Vasen/Kiesel';
const lookup = { mapUrls: async (urls: string[]) => new Map(urls.map(u => [u, u === PAGE ? { kind: 'category', id: 'c1', name: 'Vasen' } : null])) } as never;
const calls = (m: string) => fake.calls.filter(c => c.method === m).length;

test('without connection: no source, no entries', async () => {
  const o = await seoOverview(lookup);
  assert.deepEqual([o.gsc, o.sistrix, o.items.length, o.errors.length], [false, false, 0, 0]);
});

test('Sistrix: opportunities are mapped to the shop and become ready-made tasks, OnPage errors first', async () => {
  A.saveSistrix({ key: KEY, domain: 'shop.de', country: 'de' });
  fake.data['domain.opportunities'] = [{ kw: 'vase steinzeug', gain: '72', position: '11', url: PAGE, competition: '40' }, { kw: 'ohne zuordnung', gain: '90', position: '12', url: 'https://www.shop.de/unbekannt' }];
  fake.data['project.overview'] = [{ hash: 'h1', name: 'shop.de' }];
  fake.data['project.onpage.overview'] = [{ time: '2026-09-01', pages: '900', error: '9', warnings: '40', notice: '3' }, { time: '2026-10-01', pages: '910', error: '7', warnings: '40', notice: '2' }];
  fake.data['project.onpage.crawl'] = [{ type: 'warning', name: 'title_too_long', count: '40' }, { type: 'error', name: 'http_404', count: '7' }, { type: 'error', name: 'leer', count: '0' }, { type: 'notice', name: 'hinweis', count: '2' }];
  const o = await seoOverview(lookup);
  assert.equal(o.sistrix, true);
  const kw = o.items.filter(i => i.kind === 'keyword');
  assert.equal(kw.length, 1, 'unmappable page gets no task');
  assert.match(kw[0].prompt, /„vase steinzeug“.*Kategorie „Vasen“ \(ID c1\).*get_category/s);
  assert.deepEqual(kw[0].metrics.map(m => m.label), ['Gewinn (0–100)', 'Position']);
  const on = o.items.filter(i => i.kind === 'onpage');
  assert.deepEqual(on.map(i => i.id), ['sistrix:onpage:http_404', 'sistrix:onpage:title_too_long'], 'notices and empty error types are dropped');
  assert.match(on[0].prompt, /sistrix_onpage mit issue="http_404"/);
  assert.deepEqual(o.onpage, { status: 'ok', project: { hash: 'h1', name: 'shop.de' }, projects: undefined, lastCrawl: { date: '2026-10-01', pages: 910, errors: 7, warnings: 40, notices: 2 } });
  assert.ok(o.items.every(i => i.prompt.length > 40 && i.title));
});

test('several Optimizer projects without mapping: choice instead of silent omission, chosen project applies', async () => {
  A.clearSistrixCache();
  fake.data['project.overview'] = [{ hash: 'h1', name: 'Kunde A' }, { hash: 'h2', name: 'Kunde B' }];
  let o = await seoOverview(lookup);
  assert.equal(o.onpage?.status, 'choose');
  assert.deepEqual(o.onpage?.projects?.map(p => p.hash), ['h1', 'h2']);
  assert.equal(o.items.filter(i => i.kind === 'onpage').length, 0);
  A.saveSistrix({ project: 'h2' });
  o = await seoOverview(lookup);
  assert.equal(o.onpage?.status, 'ok'); assert.equal(o.onpage?.project?.name, 'Kunde B'); assert.equal(o.onpage?.projects?.length, 2, 'switching stays possible');
  assert.match(o.items.find(i => i.kind === 'onpage')!.prompt, /project="h2"/);
  A.saveSistrix({ domain: 'anderer-shop.de' });
  assert.equal(A.getSistrixConfig()?.project, undefined, 'other domain: remap project');
  A.saveSistrix({ domain: 'shop.de' });
  fake.data['project.overview'] = [];
  A.clearSistrixCache();
  assert.equal((await seoOverview(lookup)).onpage?.status, 'none');
  fake.data['project.overview'] = [{ hash: 'h1', name: 'shop.de' }];
  A.clearSistrixCache();
});

test('stored state: second call costs no request, refresh fetches anew, workspace only reads', async () => {
  A.clearSistrixCache();
  const first = await seoOverviewCached(lookup);
  assert.equal(first.cached, undefined);
  const n = calls('domain.opportunities');
  const again = await seoOverviewCached(lookup);
  assert.equal(again.cached, true); assert.equal(calls('domain.opportunities'), n, 'from the DB, not from Sistrix');
  assert.equal(seoOverviewStored()?.items.length, first.items.length);
  await seoOverviewCached(lookup, true);
  assert.equal(calls('domain.opportunities'), n + 1, 'refresh bypasses all caches');
  A.saveSistrix({ country: 'at' });
  assert.equal(seoOverviewStored(), null, 'connection changed: old state no longer fits');
  A.saveSistrix({ country: 'de' });
});

test('done/ignored: stays on refetch, disappears with the lever, done items come back after a week', async () => {
  const id = 'sistrix:onpage:http_404';
  assert.equal(setSeoMark(id, 'ignored')?.state, 'ignored');
  let o = await seoOverviewCached(lookup, true);
  assert.equal(o.items.find(i => i.id === id)?.mark?.state, 'ignored');
  assert.equal(setSeoMark(id, null), null);
  o = await seoOverviewCached(lookup);
  assert.equal(o.items.find(i => i.id === id)?.mark, undefined);
  // reconciliation checked directly
  const now = Date.parse('2026-10-14T12:00:00Z'), base: Omit<SeoOverview, 'items'> = { gsc: false, sistrix: true, errors: [], generatedAt: '' };
  const item: SeoItem = { id, source: 'sistrix', kind: 'onpage', title: '', detail: '', metrics: [], impact: 1, prompt: '' };
  const marks = { [id]: { state: 'done' as const, at: '2026-10-10T00:00:00Z' }, 'sistrix:opp:x': { state: 'ignored' as const, at: '2026-01-01T00:00:00Z' }, 'gsc:meta:1': { state: 'done' as const, at: '2026-01-01T00:00:00Z' } };
  assert.deepEqual(Object.keys(reconcileMarks({ ...base, items: [item] }, marks, now)), [id, 'gsc:meta:1'], 'no longer reported: mark is dropped; source off: stays');
  assert.deepEqual(Object.keys(reconcileMarks({ ...base, items: [item] }, marks, now + 7 * 864e5)), ['gsc:meta:1'], 'done but still reported after a week: open again');
  assert.ok(id in reconcileMarks({ ...base, items: [], errors: [{ source: 'sistrix', error: 'x' }] }, marks, now), 'source failed: discard nothing');
});

test('source fails: error is reported, nothing breaks, nothing is stored', async () => {
  A.clearSistrixCache();
  fake.failNext = { code: '202', message: 'Not enough credits' };
  const before = seoOverviewStored()?.generatedAt;
  const o = await seoOverviewCached(lookup, true);
  assert.equal(o.errors.length, 1); assert.equal(o.errors[0].source, 'sistrix'); assert.match(o.errors[0].error, /Not enough credits/);
  assert.deepEqual(o.items, []);
  assert.equal(seoOverviewStored()?.generatedAt, before, 'faulty state does not overwrite the last good one');
});

test('rankings in the SEO area: one lever per page, do not additionally boost contested queries', () => {
  const m = (clicks: number, impressions: number, position: number) => ({ clicks, impressions, ctr: clicks / impressions, position });
  const vase = { kind: 'product' as const, id: 'p1', name: 'Vase' }, kat = { kind: 'category' as const, id: 'c1', name: 'Vasen' }, becher = { kind: 'product' as const, id: 'p2', name: 'Becher' }, plaid = { kind: 'product' as const, id: 'p3', name: 'Plaid' };
  const items = S.rankingItems({
    striking: [
      { x: { page: '/vase', impressions: 900, clicks: 5, potentialClicks: 80, queries: [{ query: 'vase steinzeug', ...m(2, 600, 8) }, { query: 'vase gross', ...m(3, 300, 9) }] }, ref: vase },
      { x: { page: '/becher', impressions: 500, clicks: 5, potentialClicks: 40, queries: [{ query: 'becher', ...m(5, 500, 7) }] }, ref: becher },
      { x: { page: '/plaid', impressions: 400, clicks: 2, potentialClicks: 30, queries: [{ query: 'plaid', ...m(2, 400, 9) }] }, ref: plaid },
    ],
    cannibal: [{ x: { query: 'vase steinzeug', impressions: 1000, clicks: 4, bestPosition: 8, pages: [{ page: '/vase', share: 0.6, ...m(2, 600, 8) }, { page: '/vasen', share: 0.4, ...m(2, 400, 10) }] }, refs: [vase, kat] }],
    decline: [{ x: { page: '/becher', before: m(80, 900, 3), after: m(30, 800, 6), change: -0.63, vsSite: -0.6 }, ref: becher }],
  } as never, new Set(['p3']));
  assert.deepEqual(items.map(i => i.id).sort(), ['gsc:cannibal:vase steinzeug', 'gsc:decline:p2', 'gsc:striking:p1']);
  const vaseItem = items.find(i => i.id === 'gsc:striking:p1')!;
  assert.doesNotMatch(vaseItem.prompt, /vase steinzeug/, 'contested query is dropped, settle the main page first');
  assert.match(vaseItem.prompt, /„vase gross“/);
  assert.match(items.find(i => i.kind === 'cannibal')!.prompt, /Hauptseite/);
  assert.match(items.find(i => i.kind === 'decline')!.prompt, /Ursache/);
});
