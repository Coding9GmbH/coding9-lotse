import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ShopReader, SwEntity } from '../../../src/server/shopware';
import type { FakeRow } from '../../support/gsc-fake';

// Full flow against a local Google fake (token endpoint + Search Console API): JWT, token cache, paging, opportunities, mapping, measurement.
process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-gsc-'));
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const EMAIL = 'lotse-test@projekt.iam.gserviceaccount.com';
const KEY = JSON.stringify({ type: 'service_account', project_id: 'projekt', private_key_id: 'kid1', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), client_email: EMAIL });
const { startFakeGoogle } = await import('../../support/gsc-fake');
const fake = await startFakeGoogle(publicKey, { clientEmail: EMAIL });
process.env.LOTSE_GSC_TOKEN_URL = fake.tokenUrl;
process.env.LOTSE_GSC_API_BASE = fake.apiBase;
after(() => fake.close());

const G = await import('../../../src/server/features/gsc-google');
const F = await import('../../../src/server/features/gsc');
const { mapUrls } = await import('../../../src/server/features/gsc-map');
const { kvGet } = await import('../../../src/server/db');

/** Fake reader: ids, equals, equalsAny on flat fields */
function fakeReader(db: Record<string, SwEntity[]>): ShopReader {
  const search = async (entity: string, c: Record<string, unknown> = {}) => {
    let rows = db[entity] ?? [];
    if (Array.isArray(c.ids)) rows = rows.filter(r => (c.ids as string[]).includes(r.id));
    for (const f of (c.filter as { type: string; field: string; value: unknown }[] | undefined) ?? []) {
      if (f.type === 'equals') rows = rows.filter(r => r[f.field] === f.value);
      if (f.type === 'equalsAny') rows = rows.filter(r => (f.value as unknown[]).includes(r[f.field]));
    }
    return { data: rows, total: rows.length };
  };
  return { base: 'http://shop.test', search, get: async (e, id) => (await search(e, { ids: [id] })).data[0] ?? null, salesChannels: async () => db['sales-channel'] ?? [], req: async () => null };
}
const P1 = 'a'.repeat(32), P2 = 'b'.repeat(32), C1 = 'c'.repeat(32), SC = 'd'.repeat(32), DE = 'e'.repeat(32), EN = 'f'.repeat(32);
const seo = (foreignKey: string, routeName: string, seoPathInfo: string, languageId = DE, isCanonical = true) => ({ id: crypto.randomUUID(), foreignKey, routeName, seoPathInfo, salesChannelId: SC, languageId, isCanonical, isDeleted: false });
const shopDb = () => ({
  'sales-channel': [{ id: SC, name: 'Storefront', languageId: DE, domains: [{ url: 'https://www.shop.de', languageId: DE }, { url: 'https://www.shop.de/en', languageId: EN }] }],
  'seo-url': [seo(P1, 'frontend.detail.page', 'Vase-Kiesel-22-cm/HH-VASE-22'), seo(P1, 'frontend.detail.page', 'Vase-Pebble/HH-VASE-22', EN), seo(C1, 'frontend.navigation.page', 'Wohnen/Vasen/'), seo(P2, 'frontend.detail.page', 'Becher/HH-BECH-350'), seo(P1, 'frontend.detail.page', 'alt/vase', DE, false)],
  product: [{ id: P1, name: 'Vase „Kiesel“', productNumber: 'HH-VASE-22', active: true, metaTitle: 'Vase Kiesel | Haus Holm', metaDescription: 'Alt' }, { id: P2, name: 'Becher', productNumber: 'HH-BECH-350', active: true }],
  category: [{ id: C1, name: 'Vasen', active: true, metaTitle: null }],
  'landing-page': [] as SwEntity[],
});
type Done = Exclude<Awaited<ReturnType<typeof F.measure>>, { status: 'zu früh' }>;
const days = (from: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(from + 'T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10));

test('Key: validation, stored encrypted, only client_email exposed', () => {
  assert.throws(() => G.parseServiceKey('kein json'), /Kein gültiges JSON/);
  assert.throws(() => G.parseServiceKey('{"type":"authorized_user"}'), /kein Service-Konto/);
  assert.throws(() => G.parseServiceKey(JSON.stringify({ type: 'service_account', client_email: 'x@y', private_key: 'kaputt' })), /nicht lesbar/);
  assert.equal(G.normProperty('sc-domain:Shop.de'), 'sc-domain:shop.de');
  assert.equal(G.normProperty('https://www.shop.de'), 'https://www.shop.de/');
  assert.throws(() => G.normProperty('shop.de'), /sc-domain/);
  G.saveGsc({ key: KEY, property: 'sc-domain:shop.de' });
  const pub = G.gscPublic();
  assert.deepEqual({ ...pub, updatedAt: null }, { hasKey: true, clientEmail: EMAIL, projectId: 'projekt', property: 'sc-domain:shop.de', connected: true, updatedAt: null });
  assert.ok(!JSON.stringify(pub).includes('PRIVATE KEY'));
  const raw = JSON.stringify(kvGet('gsc'));
  assert.ok(!raw.includes('PRIVATE KEY') && raw.includes('enc:v1:'));
  G.saveGsc({ property: 'https://www.shop.de' }); // change property, key stays
  assert.equal(G.getGscConfig()?.key.client_email, EMAIL);
  G.saveGsc({ property: 'sc-domain:shop.de' });
});

test('JWT: RS256, claims and signature verifiable with the public key', () => {
  const jwt = G.signJwt(G.parseServiceKey(KEY), 'https://oauth2.googleapis.com/token', 1_800_000_000);
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'RS256', typ: 'JWT', kid: 'kid1' });
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url').toString()), { iss: EMAIL, scope: 'https://www.googleapis.com/auth/webmasters.readonly', aud: 'https://oauth2.googleapis.com/token', iat: 1_800_000_000, exp: 1_800_003_600 });
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url')));
});

test('Test connection: token is fetched and cached, property must be granted', async () => {
  const t0 = fake.stats.token;
  let r = await G.testGsc();
  assert.equal(r.ok, false); assert.match(r.message, /sieht keine Property/);
  fake.sites.push({ siteUrl: 'https://andere.de/', permissionLevel: 'siteOwner' });
  r = await G.testGsc();
  assert.equal(r.ok, false); assert.match(r.message, /nicht freigegeben/); assert.deepEqual(r.sites, ['https://andere.de/']);
  fake.sites.push({ siteUrl: 'sc-domain:shop.de', permissionLevel: 'siteRestrictedUser' });
  r = await G.testGsc();
  assert.equal(r.ok, true); assert.match(r.message, /Verbunden mit sc-domain:shop.de/);
  assert.equal(fake.stats.token - t0, 1, 'only one token for three calls');
  // wrong key → Google rejects the signature
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  await assert.rejects(G.accessToken({ client_email: 'fremd@x.iam.gserviceaccount.com', private_key: String(other) }), /Google-Anmeldung fehlgeschlagen: Invalid JWT Signature/);
});

test('Search Analytics: paging via startRow up to maxRows, filters and dataState in the body', async () => {
  fake.data = Array.from({ length: 30_000 }, (_, i) => ({ date: '2026-08-01', page: `https://www.shop.de/p${i}`, query: `q${i}`, clicks: 1, impressions: 10, position: 5 }));
  const q0 = fake.stats.query;
  const rows = await G.searchAnalytics(G.getGscConfig()!, { startDate: '2026-08-01', endDate: '2026-08-01', dimensions: ['page'], maxRows: 50_000 });
  assert.equal(rows.length, 30_000); assert.equal(fake.stats.query - q0, 2);
  const [b1, b2] = fake.stats.bodies.slice(-2);
  assert.deepEqual([b1.startRow, b1.rowLimit, b2.startRow, b2.rowLimit, b1.dataState, b1.type], [0, 25_000, 25_000, 25_000, 'final', 'web']);
  const few = await G.searchAnalytics(G.getGscConfig()!, { startDate: '2026-08-01', endDate: '2026-08-01', dimensions: ['page'], maxRows: 3, filters: [{ dimension: 'page', operator: 'contains', expression: '/p1' }], dataState: 'all' });
  assert.equal(few.length, 3); assert.ok(few.every(r => r.keys[0].includes('/p1')));
  assert.deepEqual(fake.stats.bodies.at(-1)!.dimensionFilterGroups, [{ groupType: 'and', filters: [{ dimension: 'page', operator: 'contains', expression: '/p1' }] }]);
  fake.data = [];
});

test('Mapping: GSC URLs → product/category via SEO URLs, language prefix, technical paths, home page', async () => {
  const ro = fakeReader(shopDb());
  const urls = ['https://www.shop.de/Vase-Kiesel-22-cm/HH-VASE-22', 'https://www.shop.de/en/Vase-Pebble/HH-VASE-22', 'https://www.shop.de/Wohnen/Vasen/', `https://www.shop.de/detail/${P2}`, 'https://www.shop.de/', 'https://www.shop.de/gibt-es-nicht', 'https://www.shop.de/alt/vase'];
  const m = await mapUrls(ro, urls, { metas: true });
  assert.deepEqual(m.get(urls[0]), { kind: 'product', id: P1, name: 'Vase „Kiesel“', number: 'HH-VASE-22', active: true, salesChannel: 'Storefront', metaTitle: 'Vase Kiesel | Haus Holm', metaDescription: 'Alt' });
  assert.equal(m.get(urls[1])?.id, P1);
  assert.equal(m.get(urls[2])?.kind, 'category');
  assert.equal(m.get(urls[3])?.name, 'Becher');
  assert.equal(m.get(urls[4])?.kind, 'home');
  assert.equal(m.get(urls[5]), null);
  assert.equal(m.get(urls[6])?.id, P1, 'old (non-canonical) URL still points to the product');
});

test('Opportunities, baseline on apply, measurement afterwards and shop check', async () => {
  const db = shopDb(), ro = fakeReader(db);
  const vase = 'https://www.shop.de/Vase-Kiesel-22-cm/HH-VASE-22', becher = 'https://www.shop.de/Becher/HH-BECH-350';
  const rows: FakeRow[] = [];
  // before (August): vase 100 impr./day, 1 click, pos. 3 → CTR 1 % instead of ~10 %; mug normal
  for (const d of days('2026-08-01', 31)) rows.push({ date: d, page: vase, query: 'vase steinzeug', clicks: 1, impressions: 100, position: 3 }, { date: d, page: becher, query: 'becher', clicks: 10, impressions: 100, position: 3 });
  // after (September/October): vase 6 clicks/day
  for (const d of days('2026-09-02', 38)) rows.push({ date: d, page: vase, query: 'vase steinzeug', clicks: 6, impressions: 100, position: 3 }, { date: d, page: becher, query: 'becher', clicks: 10, impressions: 100, position: 3 });
  fake.data = rows;
  const cfg = G.getGscConfig()!;
  const opp = await F.findOpportunities(cfg, ro, {}, new Date('2026-09-01T12:00:00Z'));
  assert.equal(opp.total, 1);
  assert.equal(opp.items[0].ref?.id, P1); assert.equal(opp.items[0].ref?.metaTitle, 'Vase Kiesel | Haus Holm');
  assert.equal(opp.items[0].queries[0].keys[0], 'vase steinzeug');
  assert.equal(opp.items[0].o.impressions, 2800);

  // change set applied (via the observer in changes.ts)
  const { notifyApplied } = await import('../../../src/server/changes');
  const cs = { id: 'cs1', kind: 'products', entity: 'product', title: 'Metas', reason: null, atomic: false, skipped: [], items: [
    { id: `${P1}:metaTitle`, entity: 'product', entityId: P1, label: 'Vase „Kiesel“ (HH-VASE-22)', field: 'metaTitle', fieldLabel: 'Meta-Title', before: 'Vase Kiesel | Haus Holm', after: 'Vase Kiesel aus Steinzeug, 22 cm | Haus Holm', afterRaw: 'Vase Kiesel aus Steinzeug, 22 cm | Haus Holm', warn: [] },
    { id: `${P2}:stock`, entity: 'product', entityId: P2, label: 'Becher', field: 'stock', fieldLabel: 'Bestand', before: '1', after: '2', afterRaw: 2, warn: [] },
  ] };
  // time of change: Sept 1 (observer uses "now" → here directly with a fixed date)
  const made = await F.baselinesFor(cfg, cs.items, { ro, changeSetId: cs.id }, new Date('2026-09-01T12:00:00Z'));
  assert.equal(made.length, 1, 'only meta fields create baselines');
  const b = made[0];
  assert.deepEqual([b.before.startDate, b.before.endDate, b.before.days, b.before.clicks, b.before.impressions], ['2026-08-02', '2026-08-29', 28, 28, 2800]);
  assert.deepEqual(b.urls, [vase]);
  assert.equal(b.site?.impressions, 5600);
  // observer path: without a fixed date, but same mechanism (page known → baseline)
  await notifyApplied(cs, { results: [{ itemId: `${P1}:metaTitle`, ok: true }] }, { ro, chatId: 'chat1' });
  assert.equal(F.listBaselines().length, 2);
  assert.match(F.listBaselines()[0].measured?.verdict ?? '', /überholt/, 'older open measurement of the same page is superseded');
  // page unknown to Google → no baseline
  assert.equal((await F.baselinesFor(cfg, [{ ...cs.items[0], entity: 'category', entityId: C1, field: 'metaDescription' }], { ro, changeSetId: 'cs2' }, new Date('2026-09-01T12:00:00Z'))).length, 0);

  // measure: too early → state the date
  const early = await F.measure(cfg, ro, b, new Date('2026-09-10T12:00:00Z'));
  assert.equal(early.status, 'zu früh'); assert.match(String(early.message), /ab 2026-09-18/);
  // complete: CTR 1 % → 6 %, significant
  db.product[0].metaTitle = 'Vase Kiesel aus Steinzeug, 22 cm | Haus Holm';
  const full = await F.measure(cfg, ro, b, new Date('2026-10-10T12:00:00Z')) as Done;
  assert.equal(full.status, 'vollständig'); assert.equal(full.verdict, 'verbessert');
  assert.equal(full.after.clicks, 168); assert.equal(full.change.clicksPerDay, '+500 %');
  assert.ok(!full.notes.some(n => /anderen Wert/.test(n)));
  // reset in the meantime → note
  db.product[0].metaTitle = 'Vase Kiesel | Haus Holm';
  const drift = await F.measure(cfg, ro, b, new Date('2026-10-10T12:00:00Z')) as Done;
  assert.ok(drift.notes.some(n => /anderen Wert/.test(n)));

  // shop check: opportunities + due measurements (only when connected)
  const { listChecks } = await import('../../../src/server/checks');
  const checks = listChecks().filter(c => c.area === 'Search Console');
  assert.deepEqual(checks.map(c => c.id).sort(), ['gsc.cannibalization', 'gsc.decline', 'gsc.low-ctr', 'gsc.measure-due']);
  const due = await checks.find(c => c.id === 'gsc.measure-due')!.run(ro) as { count: number; title: string };
  assert.equal(due.count, 0, 'the fully measured and the superseded measurement are done; the new one is not due yet');
  const low = await checks.find(c => c.id === 'gsc.low-ctr')!.run(ro) as { count: number; title: string };
  assert.equal(typeof low.count, 'number'); assert.match(low.title, /Klickrate/);
  G.saveGsc({ key: null });
  assert.equal(await checks[0].run(ro), null, 'no findings without a connection');
  fake.data = [];
});

test('Baseline for SEO URL with umlaut and language prefix: Google knows the page percent-encoded under /en', async () => {
  G.saveGsc({ key: KEY, property: 'sc-domain:shop.de' });
  const P3 = '9'.repeat(32), db = shopDb();
  db.product.push({ id: P3, name: 'Küchenvase', productNumber: 'HH-KUECHE-1', active: true, metaTitle: 'Alt', metaDescription: '' });
  db['seo-url'].push(seo(P3, 'frontend.detail.page', 'küche/vase-kiesel'), seo(P3, 'frontend.detail.page', 'küche/vase-kiesel', EN));
  const ro = fakeReader(db), page = 'https://www.shop.de/en/k%C3%BCche/vase-kiesel';
  fake.data = days('2026-08-01', 31).map(d => ({ date: d, page, query: 'vase', clicks: 2, impressions: 50, position: 4 }));
  const b = await F.recordBaseline(G.getGscConfig()!, ro, { entity: 'product', entityId: P3, label: 'Küchenvase', fields: [{ field: 'metaTitle', before: 'Alt', after: 'Neu' }], changeSetId: 'cs9' }, new Date('2026-09-01T12:00:00Z'));
  assert.ok(b, 'baseline created');
  assert.equal(b!.before.impressions, 28 * 50);
  assert.deepEqual(b!.urls, [page], 'URLs from the Search Console rows');
  assert.match(b!.pathRegex, /k%C3%BCche/);
  assert.ok(new RegExp(b!.pathRegex).test('https://www.shop.de/küche/vase-kiesel'), 'raw form still matches');
  G.saveGsc({ key: null });
  fake.data = [];
});

test('Rankings: just short of page 1, cannibalization and losses against the previous period, mapped to the shop', async () => {
  G.saveGsc({ key: KEY, property: 'sc-domain:shop.de' }); G.clearGscCache();
  const ro = fakeReader(shopDb()), now = new Date('2026-10-14T12:00:00Z');
  const VASE = 'https://www.shop.de/Vase-Kiesel-22-cm/HH-VASE-22', CAT = 'https://www.shop.de/Wohnen/Vasen/', BECHER = 'https://www.shop.de/Becher/HH-BECH-350';
  const cur = days('2026-09-14', 28), prev = days('2026-08-17', 28); // periods up to 2026-10-11 (today minus 3 days) and the 28 days before
  fake.data = [
    ...cur.map(d => ({ date: d, page: VASE, query: 'vase steinzeug', clicks: 0, impressions: 10, position: 8 })),
    ...cur.map(d => ({ date: d, page: CAT, query: 'vase steinzeug', clicks: 0, impressions: 8, position: 9 })),
    ...prev.map(d => ({ date: d, page: BECHER, query: 'becher', clicks: 3, impressions: 30, position: 3 })),
    ...cur.map(d => ({ date: d, page: BECHER, query: 'becher', clicks: 1, impressions: 30, position: 7 })),
    ...[...prev, ...cur].map(d => ({ date: d, page: 'https://www.shop.de/', query: 'haus holm', clicks: 10, impressions: 20, position: 1 })), // stable shop trend
  ];
  const r = await F.rankingInsights(G.getGscConfig()!, ro, {}, now);
  assert.equal(r.period.endDate, '2026-10-11'); assert.equal(r.previous.endDate, '2026-09-13');
  assert.deepEqual(r.cannibal.map(c => c.x.query), ['vase steinzeug']);
  assert.deepEqual(r.cannibal[0].refs.map(x => x?.id).sort(), [P1, C1].sort(), 'both pages mapped to the shop');
  assert.ok(r.striking.some(s => s.ref?.id === P1), 'vase ranks at position 8: just short of page 1');
  assert.deepEqual(r.decline.map(d => d.ref?.id), [P2], 'mug: 84 → 28 clicks');
  assert.equal(r.decline[0].x.before.clicks, 84);
  G.saveGsc({ key: null });
  fake.data = [];
});
