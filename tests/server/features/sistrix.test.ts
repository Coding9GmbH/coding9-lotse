import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Full flow against a local Sistrix fake: save key/domain (encrypted), test, tools with shop mapping, cache, errors, shop check.
process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-sistrix-'));
const KEY = 'sx_0123456789abcdef0123456789abcdef';
const { startFakeSistrix } = await import('../../support/sistrix-fake');
const fake = await startFakeSistrix({ apiKey: KEY });
process.env.LOTSE_SISTRIX_API_BASE = fake.base;
after(() => fake.close());

const A = await import('../../../src/server/features/sistrix-api');
const S = await import('../../../src/server/features/sistrix');
const { kvGet } = await import('../../../src/server/db');
const { redact } = await import('../../../src/server/settings');
const { listChecks } = await import('../../../src/server/checks');

const PAGE = 'https://www.shop.de/Vase-Kiesel-22-cm/HH-VASE-22';
const session = { platform: 'shopware', lookup: { mapUrls: async (urls: string[]) => new Map(urls.map(u => [u, u === PAGE ? { kind: 'product', id: 'p1', name: 'Vase', number: 'HH-VASE-22', metaTitle: 'T', metaDescription: 'D' } : null])) } } as never;
const run = async (name: string, args: Record<string, unknown> = {}) => {
  const t = S.sistrix.tools(session).find(x => x.name === name)!;
  const r = await t.handler(args, {}) as { content: { text: string }[]; isError?: boolean };
  return { text: r.content[0].text, err: !!r.isError, json: r.isError ? null : JSON.parse(r.content[0].text) };
};
const calls = (m: string) => fake.calls.filter(c => c.method === m);

test('address parameter: domain, host, path or url depending on input', () => {
  assert.deepEqual(A.addressParam('huntify.de'), { domain: 'huntify.de' });
  assert.deepEqual(A.addressParam('www.huntify.de'), { host: 'www.huntify.de' });
  assert.deepEqual(A.addressParam('shop.example.co.uk'), { host: 'shop.example.co.uk' });
  assert.deepEqual(A.addressParam('example.co.uk'), { domain: 'example.co.uk' });
  assert.deepEqual(A.addressParam('huntify.de/jagd/'), { path: 'huntify.de/jagd/' });
  assert.deepEqual(A.addressParam('huntify.de/jagd/hose.html'), { url: 'huntify.de/jagd/hose.html' });
  assert.deepEqual(A.addressParam('huntify.de/'), { domain: 'huntify.de' });
});

test('validate inputs: key, domain, country', () => {
  assert.throws(() => A.normKey('kurz'), /Sistrix-API-Schlüssel/);
  assert.equal(A.normDomain('https://WWW.Shop.de/Wohnen/?a=1'), 'www.shop.de/wohnen/');
  assert.equal(A.normDomain(''), '');
  assert.equal(A.normDomain('www.huntify.de/'), 'www.huntify.de', 'trailing slash on the host is dropped');
  assert.equal(A.normDomain('shop.de/wohnen/'), 'shop.de/wohnen/', 'path stays');
  assert.throws(() => A.normDomain('kein domain'), /Domain:/);
  assert.throws(() => A.normDomain('shop.de&api_key=x'), /Domain:/, 'no parameter injection');
  assert.equal(A.normCountry('DE'), 'de');
  assert.throws(() => A.normCountry('deu'), /Land:/);
});

test('save: encrypted, only "present" exposed, disconnect clears everything, key is redacted from messages', () => {
  assert.equal(A.sistrixPublic().connected, false);
  A.saveSistrix({ key: KEY, domain: 'Shop.de', country: 'DE' });
  const pub = A.sistrixPublic();
  assert.deepEqual({ ...pub, updatedAt: null }, { hasKey: true, domain: 'shop.de', country: 'de', project: '', connected: true, updatedAt: null });
  assert.ok(!JSON.stringify(pub).includes(KEY));
  const raw = JSON.stringify(kvGet('sistrix'));
  assert.ok(!raw.includes(KEY) && raw.includes('enc:v1:'));
  assert.ok(!redact(`Fehler mit ${KEY} im Text`).includes(KEY));
  A.saveSistrix({ domain: 'mein-shop.de' }); // key stays
  assert.equal(A.getSistrixConfig()?.key, KEY);
  A.saveSistrix({ domain: 'shop.de' });
});

test('test connection: free credits call, key in the body (never in the URL), wrong key is reported clearly', async () => {
  const r = await A.testSistrix();
  assert.equal(r.ok, true); assert.equal(r.credits, 1234); assert.match(r.message, /Verbunden für shop\.de, 1234 Credits übrig/);
  assert.equal(calls('credits').at(-1)!.params.format, 'json');
  A.saveSistrix({ key: 'sx_ffffffffffffffffffffffffffffffff' });
  await assert.rejects(A.testSistrix(), /Sistrix: Invalid API key \(101\)/);
  A.saveSistrix({ key: KEY });
});

test('visibility: series ascending, change, country and limit are passed along', async () => {
  fake.data['domain.visibilityindex'] = [
    { date: '2026-09-28', value: '8.4', domain: 'shop.de' }, { date: '2026-09-21', value: '9.1', domain: 'shop.de' },
    { date: '2026-09-14', value: '10.0', domain: 'shop.de' }, { date: '2026-09-07', value: '10.2', domain: 'shop.de' },
  ];
  const r = await run('sistrix_visibility', { weeks: 4 });
  assert.equal(r.err, false);
  assert.deepEqual(r.json.series.map((p: { date: string }) => p.date), ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
  assert.equal(r.json.latest.value, 8.4); assert.equal(r.json.changePct, -17.6);
  const c = calls('domain.visibilityindex').at(-1)!.params;
  assert.deepEqual([c.domain, c.address_object, c.history, c.limit, c.country], ['shop.de', undefined, 'true', '4', 'de']);
  // second call with the same arguments comes from the cache (no credits)
  const n = calls('domain.visibilityindex').length;
  await run('sistrix_visibility', { weeks: 4 });
  assert.equal(calls('domain.visibilityindex').length, n);
});

test('home page card: history and change, cached for long (no credit usage on every page view)', async () => {
  A.clearSistrixCache();
  fake.data['domain.visibilityindex'] = [{ date: '2026-10-05', value: '0.058' }, { date: '2026-09-28', value: '0.05' }];
  const cfg = A.getSistrixConfig()!;
  const n = calls('domain.visibilityindex').length;
  const o = await S.visibilityOverview(cfg, 8);
  assert.deepEqual(o.series.map(p => p.date), ['2026-09-28', '2026-10-05']);
  assert.equal(o.latest?.value, 0.058); assert.equal(o.changePct, 16);
  assert.equal(calls('domain.visibilityindex').at(-1)!.params.limit, '8');
  await S.visibilityOverview(cfg, 8);
  assert.equal(calls('domain.visibilityindex').length, n + 1, 'second call from the cache');
});

test('opportunities and top pages: rows are mapped to the shop, limit capped, other domain possible', async () => {
  fake.data['domain.opportunities'] = [{ domain: 'vase steinzeug', gain: '72', position: '11', url: PAGE, competition: '40' }, { domain: 'becher', gain: '10', position: '15', url: 'https://www.shop.de/unbekannt', competition: '10' }];
  const r = await run('sistrix_opportunities', { limit: 500 });
  assert.equal(calls('domain.opportunities').at(-1)!.params.limit, '50', 'capped at 50');
  assert.equal(r.json.items[0].shop.id, 'p1'); assert.equal(r.json.items[0].change, 'propose_product_changes');
  assert.equal(r.json.items[0].gain, 72, 'numeric text becomes a number');
  assert.equal(r.json.items[1].shop, null); assert.match(r.json.items[1].change, /nicht im Shop/);
  fake.data['domain.urls'] = [{ url: PAGE, top10: '5', top100: '20', share: '3.5' }];
  const t = await run('sistrix_top_pages', { domain: 'https://Wettbewerber.de', regexUrl: '/wohnen/' });
  const p = calls('domain.urls').at(-1)!.params;
  assert.deepEqual([p.domain, p.regex_url, p.limit], ['wettbewerber.de', '/wohnen/', '25']);
  assert.equal(t.json.items[0].shop.name, 'Vase');
  const bad = await run('sistrix_top_pages', { domain: 'x y' });
  assert.equal(bad.err, true); assert.match(bad.text, /Domain:/);
});

test('keywords: several as JSON list, at most 10, duplicates are dropped', async () => {
  fake.data['keyword.seo.metrics'] = [{ kw: 'vase', competition: '55', cpc: '0.4', traffic: '1200' }];
  await run('sistrix_keyword_metrics', { keywords: ['vase', 'Vase ', 'becher'] });
  assert.equal(calls('keyword.seo.metrics').at(-1)!.params.kw, JSON.stringify(['vase', 'Vase', 'becher']));
  await run('sistrix_keyword_metrics', { keywords: ['einzeln'] });
  assert.equal(calls('keyword.seo.metrics').at(-1)!.params.kw, 'einzeln');
});

test('OnPage: project for the domain, summary, then URLs of one issue type', async () => {
  fake.data['project.overview'] = [{ hash: 'h-other', name: 'andere.de' }, { hash: 'h-shop', name: 'www.shop.de' }];
  fake.data['project.onpage.crawl'] = [{ type: 'error', name: 'http_404', count: '7' }, { type: 'warning', name: 'title_too_long', count: '40' }];
  fake.data['project.onpage.overview'] = [{ time: '2026-09-01', pages: '900', error: '7', warnings: '40', notice: '3' }, { time: '2026-10-01', pages: '910', error: '7', warnings: '40', notice: '2' }];
  fake.data['project.onpage.issue'] = [{ url: PAGE, status_code: '404', link_from: ['https://www.shop.de/'] }];
  const s = await run('sistrix_onpage');
  assert.equal(s.json.project, 'www.shop.de'); assert.equal(s.json.lastCrawl.time, '2026-10-01');
  assert.equal(s.json.issues[0].name, 'title_too_long', 'sorted by count');
  const i = await run('sistrix_onpage', { issue: 'http_404' });
  assert.equal(calls('project.onpage.issue').at(-1)!.params.project, 'h-shop');
  assert.equal(i.json.items[0].shop.id, 'p1', 'nested response: URLs arrive');
  assert.equal(i.json.items[0].status_code, 404);
  const unk = await run('sistrix_onpage', { issue: 'gibt_es_nicht' });
  assert.match(unk.json.message, /Unbekannte Fehlerart.*http_404/);
  A.clearSistrixCache(); // data changes: otherwise the project list comes from the cache
  fake.data['project.overview'] = [{ hash: 'h1', name: 'a.de' }, { hash: 'h2', name: 'b.de' }];
  const many = await run('sistrix_onpage');
  assert.match(many.json.message, /Mehrere Projekte/);
  A.saveSistrix({ project: 'h2' }); // chosen in the SEO area: applies to all tools and the shop check when not specified
  assert.equal((await run('sistrix_onpage')).json.project, 'b.de');
  A.saveSistrix({ project: '' });
  A.clearSistrixCache();
  fake.data['project.overview'] = [];
  assert.match((await run('sistrix_onpage', { project: 'x' })).json.message, /kein Optimizer-Projekt/);
});

test('errors from Sistrix arrive in understandable form, without connection the tool says so', async () => {
  fake.failNext = { code: '202', message: 'Not enough credits' };
  const r = await run('sistrix_competitors', { limit: 3 });
  assert.equal(r.err, true); assert.match(r.text, /Not enough credits \(202\)/);
  assert.ok(!(await run('sistrix_competitors', { limit: 3 })).err, 'errors are not cached');
});

test('shop check: visibility loss and OnPage issues, nothing without connection', async () => {
  const checks = listChecks().filter(c => c.area === 'Sistrix');
  assert.deepEqual(checks.map(c => c.id).sort(), ['sistrix.onpage-errors', 'sistrix.visibility-drop']);
  const drop = checks.find(c => c.id === 'sistrix.visibility-drop')!;
  A.clearSistrixCache();
  fake.data['domain.visibilityindex'] = [{ date: '2026-10-05', value: '7.0' }, { date: '2026-09-28', value: '8.0' }, { date: '2026-09-21', value: '9.0' }, { date: '2026-09-14', value: '9.5' }, { date: '2026-09-07', value: '10.0' }];
  const f = await drop.run({} as never) as { count: number; severity: string; title: string };
  assert.equal(f.count, 1); assert.equal(f.severity, 'hoch'); assert.match(f.title, /30 % niedriger/);
  A.clearSistrixCache();
  fake.data['domain.visibilityindex'] = [{ date: '2026-10-05', value: '10.5' }, { date: '2026-09-07', value: '10.0' }];
  assert.equal(((await drop.run({} as never)) as { count: number }).count, 0);
  fake.data['project.overview'] = [{ hash: 'h-shop', name: 'shop.de' }];
  A.clearSistrixCache();
  const on = await checks.find(c => c.id === 'sistrix.onpage-errors')!.run({} as never) as { count: number; sample: { id: string }[] };
  assert.equal(on.count, 1); assert.equal(on.sample[0].id, 'http_404');
  A.saveSistrix({ key: null });
  assert.equal(await drop.run({} as never), null);
  assert.equal(A.sistrixConnected(), false);
  assert.match((await run('sistrix_visibility')).text, /nicht verbunden/);
});
