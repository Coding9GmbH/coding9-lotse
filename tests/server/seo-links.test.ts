import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLinks, collectLinks, extractLinks, parseHref, rewriteLinks, prepareSpecLinks, type LinkReport } from '../../src/server/seo-links';
import { auditSpec } from '../../src/server/audit';
import { expandSpec } from '../../src/server/patterns';
import type { PageSpec } from '../../src/server/cms';
import type { ShopReader, SwEntity } from '../../src/server/shopware';

const P = (n: number) => String(n).padStart(32, 'a'), SC = 'sc1', DE = 'lang-de', NAV = 'nav0000000000000000000000000000a', FOOT = 'foot000000000000000000000000000a';
/** Mini shop: evaluate equals/equalsAny/contains (also over list paths like visibilities.salesChannelId) and ids */
function fakeShop(db: Record<string, SwEntity[]>, base = 'http://api.test'): ShopReader & { calls: string[] } {
  const get = (o: SwEntity, f: string): unknown[] => f.split('.').reduce<unknown[]>((vs, k) => vs.flatMap(v => { const x = (v as SwEntity)?.[k]; return Array.isArray(x) ? x : [x]; }), [o]);
  const match = (o: SwEntity, f: { type: string; field: string; value: unknown; queries?: unknown[]; operator?: string }): boolean => {
    if (f.type === 'multi') return (f.queries as typeof f[]).some(q => match(o, q));
    const vs = get(o, f.field);
    if (f.type === 'equals') return vs.some(v => (v ?? null) === f.value || (typeof v === 'string' && typeof f.value === 'string' && v.toLowerCase() === f.value.toLowerCase()));
    if (f.type === 'equalsAny') return vs.some(v => (f.value as unknown[]).some(x => typeof v === 'string' && typeof x === 'string' ? v.toLowerCase() === x.toLowerCase() : v === x));
    if (f.type === 'contains') return vs.some(v => String(v ?? '').includes(String(f.value)));
    return true;
  };
  const calls: string[] = [];
  return {
    base, calls,
    async search(entity, c = {}) {
      calls.push(entity);
      let rows = db[entity] ?? [];
      if (c.ids) rows = rows.filter(r => (c.ids as string[]).includes(r.id));
      for (const f of (c.filter as never[]) ?? []) rows = rows.filter(r => match(r, f));
      return { data: rows.slice(0, (c.limit as number) ?? 500), total: rows.length };
    },
    async get(entity, id) { return (db[entity] ?? []).find(r => r.id === id) ?? null; },
    async salesChannels() { return db['sales-channel']; },
    async req() { throw new Error('nicht erlaubt'); },
  };
}
const shop = () => fakeShop({
  'sales-channel': [{ id: SC, name: 'Storefront', languageId: DE, navigationCategoryId: NAV, footerCategoryId: FOOT, domains: [{ url: 'https://shop.test', languageId: DE }] }],
  product: [
    { id: P(1), name: 'Vase Kiesel', active: true, visibilities: [{ salesChannelId: SC }] },
    { id: P(2), name: 'Becher alt', active: false, visibilities: [{ salesChannelId: SC }] },
    { id: P(3), name: 'Plaid', active: true, visibilities: [] },
    { id: P(6), parentId: P(1), name: null, active: null, visibilities: [] }, { id: P(7), parentId: P(2), name: null, active: null, visibilities: [] },
  ],
  category: [{ id: P(4), name: 'Wohnen', active: true, type: 'page', path: `|${NAV}|` }, { id: P(5), name: 'Ordner', active: true, type: 'folder', path: `|${NAV}|` },
    { id: P(8), name: 'Versand', active: true, type: 'page', path: `|${FOOT}|` }, { id: P(9).replace(/^a/, 'b'), name: 'Fremd', active: true, type: 'page', path: '|anderer-root|' }],
  'landing-page': [],
  'seo-url': [
    { id: 's1', foreignKey: P(1), routeName: 'frontend.detail.page', seoPathInfo: 'vase-kiesel/HH-1', salesChannelId: SC, languageId: DE, isCanonical: true, isDeleted: false },
    { id: 's0', foreignKey: P(1), routeName: 'frontend.detail.page', seoPathInfo: 'alte-vase/HH-1', salesChannelId: SC, languageId: DE, isCanonical: null, isDeleted: false },
    { id: 's4', foreignKey: P(4), routeName: 'frontend.navigation.page', seoPathInfo: 'Wohnen/', salesChannelId: SC, languageId: DE, isCanonical: true, isDeleted: false },
  ],
});

test('extractLinks: href, text, rel, target (also single quotes)', () => {
  assert.deepEqual(extractLinks(`<p><a class="btn" href="/detail/x" target='_blank' rel="noopener">Zur <b>Vase</b></a> <a name="x">ohne</a></p>`), [{ href: '/detail/x', text: 'Zur Vase', rel: 'noopener', target: '_blank' }]);
});

test('parseHref: technical, SEO path, absolute in shop, external, anchor, unsafe', () => {
  const b = ['https://shop.test', 'https://shop.test/en'];
  assert.deepEqual(parseHref(`/detail/${P(1)}`, b), { type: 'internal', kind: 'product', id: P(1), path: `detail/${P(1)}`, absolute: false });
  assert.equal(parseHref(`https://shop.test/navigation/${P(4)}?p=2`, b).kind, 'category');
  assert.equal(parseHref(`https://shop.test/en/landingPage/${P(6)}`, b).kind, 'landing');
  assert.equal(parseHref('/en/wohnen/', b).path, 'wohnen/');
  assert.equal(parseHref('https://example.org/x', b).type, 'external');
  assert.equal(parseHref('#faq', b).type, 'anchor');
  assert.equal(parseHref('mailto:a@b.de', b).type, 'other');
  assert.equal(parseHref('javascript:alert(1)', b).type, 'invalid');
});

test('collectLinks/rewriteLinks: HTML, pattern links (with text) and slot config, image URLs stay', () => {
  const spec = { sections: [{ blocks: [
    { type: 'pattern', pattern: 'hero', data: { ctaText: 'Zur Vase', ctaHref: '/detail/1', imageUrl: '/detail/1' } },
    { type: 'text', html: '<a href="/detail/1">Vase</a>' }, { type: 'image-cover', linkUrl: '/detail/1', image: { url: '/detail/1' } },
    { type: 'reuse', _src: { slots: [{ config: { url: { source: 'static', value: '/detail/1' } } }] } },
  ] }] };
  assert.deepEqual(collectLinks(spec).map(l => [l.href, l.text]), [['/detail/1', 'Zur Vase'], ['/detail/1', 'Vase'], ['/detail/1', ''], ['/detail/1', '']]);
  const out = rewriteLinks(spec, new Map([['/detail/1', '/vase']]));
  assert.equal(out.sections[0].blocks[0].data!.ctaHref, '/vase'); assert.equal(out.sections[0].blocks[0].data!.imageUrl, '/detail/1');
  assert.equal(out.sections[0].blocks[1].html, '<a href="/vase">Vase</a>'); assert.equal(out.sections[0].blocks[2].linkUrl, '/vase');
  assert.deepEqual(out.sections[0].blocks[2].image, { url: '/detail/1' });
  assert.equal(JSON.stringify(out.sections[0].blocks[3]).includes('"/vase"'), true);
  assert.equal(spec.sections[0].blocks[1].html, '<a href="/detail/1">Vase</a>', 'original stays unchanged');
});

test('checkLinks: technical links → SEO URL, inactive/missing/invisible/folder = important, rest recommended', async () => {
  const links = extractLinks([
    `<a href="/detail/${P(1)}">Vase Kiesel</a>`, `<a href="https://shop.test/detail/${P(1)}#top">Vase</a>`, `<a href="/alte-vase/HH-1">alt</a>`, `<a href="/Wohnen">Wohnen</a>`,
    `<a href="/detail/${P(2)}">Becher</a>`, `<a href="/detail/${P(9)}">weg</a>`, `<a href="/detail/${P(3)}">Plaid</a>`, `<a href="/navigation/${P(5)}">Ordner</a>`,
    '<a href="/gibts-nicht">x</a>', '<a href="/checkout/cart">Warenkorb</a>', '<a href="http://extern.de" target="_blank">hier klicken</a>', `<a href="/navigation/${P(4)}" target="_blank" rel="nofollow">Wohnen</a>`,
  ].join(''));
  const r = await checkLinks(shop(), links);
  assert.equal(r.rewrites.get(`/detail/${P(1)}`), '/vase-kiesel/HH-1');
  assert.equal(r.rewrites.get(`https://shop.test/detail/${P(1)}#top`), 'https://shop.test/vase-kiesel/HH-1#top');
  assert.equal(r.rewrites.get('/alte-vase/HH-1'), '/vase-kiesel/HH-1', 'outdated SEO URL → canonical');
  assert.equal(r.rewrites.has('/Wohnen'), false, 'canonical path stays');
  assert.equal(r.rewrites.get(`/navigation/${P(4)}`), '/Wohnen/');
  const by = (h: string) => r.findings.filter(f => f.href === h).map(f => `${f.level}: ${f.problem}`).join(' | ');
  assert.match(by(`/detail/${P(2)}`), /^wichtig: .*inaktiv/);
  assert.match(by(`/detail/${P(9)}`), /^wichtig: .*existiert nicht/);
  assert.match(by(`/detail/${P(3)}`), /^wichtig: .*nicht sichtbar/);
  assert.match(by(`/navigation/${P(5)}`), /^wichtig: .*keine Seite/);
  assert.match(by('/gibts-nicht'), /^wichtig: Ziel nicht gefunden/);
  assert.equal(by('/checkout/cart'), ''); assert.equal(by('/Wohnen'), ''); assert.equal(by(`/detail/${P(1)}`), '');
  assert.match(by('http://extern.de'), /Linktext.*\| empfohlen: Externer Link ohne HTTPS \| empfohlen: .*noopener/);
  assert.match(by(`/navigation/${P(4)}`), /neuen Tab.*nofollow/);
  assert.equal(r.internal, 11); assert.equal(r.external, 1);
});

test('page draft: SEO URLs in preview/spec, quality check reports broken targets as "wichtig" (important) with a hint', async () => {
  const raw = { name: 'T', type: 'landingpage', sections: [{ blocks: [
    { type: 'pattern', pattern: 'hero', data: { title: 'Vasen', ctaText: 'Vase Kiesel ansehen', ctaHref: `/detail/${P(1)}` } },
    { type: 'text', html: `<p><a href="/detail/${P(2)}">Becher</a> <a href="/navigation/${P(4)}">Wohnen</a></p>` },
  ] }] } as unknown as PageSpec;
  const { spec, report } = await prepareSpecLinks(shop(), raw);
  const exp = expandSpec(spec);
  assert.match(exp.sections[0].blocks[0].html!, /href="\/vase-kiesel\/HH-1"/);
  assert.match(exp.sections[0].blocks[1].html!, /href="\/Wohnen\/"/);
  const a = auditSpec(exp, report);
  const bad = a.checks.find(c => c.level === 'wichtig' && /Link/.test(c.msg))!;
  assert.equal(bad.ok, false); assert.match(String(bad.hint), /Becher.*inaktiv/);
  assert.equal(a.stats.internalLinks, 3);
  const ok = auditSpec(exp, { ...report, findings: [] } as LinkReport).checks.filter(c => /Link/.test(c.msg) && c.area === 'SEO' && /Linkziele|Links sauber/.test(c.msg));
  assert.ok(ok.length === 2 && ok.every(c => c.ok));
});

test('prepareSpecLinks: shop unreachable → draft unchanged, no report', async () => {
  const broken = { ...shop(), salesChannels: async () => { throw new Error('offline'); } } as unknown as ShopReader;
  const spec = { sections: [{ blocks: [{ type: 'text', html: '<a href="/detail/1">x</a>' }] }] };
  const r = await prepareSpecLinks(broken, spec);
  assert.equal(r.spec, spec); assert.equal(r.report, null);
});

test('descriptions in change sets: links rewritten, warnings on the element', async () => {
  const { checkHtmlItems } = await import('../../src/server/seo-links');
  const items = [{ afterRaw: `<p><a href="/detail/${P(1)}">Vase</a> <a href="/detail/${P(2)}">Becher</a></p>`, after: '', html: { before: '', after: '' }, warn: [] as string[] }, { afterRaw: '<p>ohne Links</p>', after: '', warn: [] as string[] }];
  await checkHtmlItems(shop(), items);
  assert.match(String(items[0].afterRaw), /href="\/vase-kiesel\/HH-1"/); assert.match(items[0].html!.after, /vase-kiesel/);
  assert.equal(items[0].warn.length, 1); assert.match(items[0].warn[0], /Becher.*inaktiv/);
  assert.deepEqual(items[1].warn, []);
});

test('collectLinks/rewriteLinks: mapped slot configs and non-URLs are not links', async () => {
  const cfg = { manufacturer: { config: { url: { source: 'mapped', value: 'product.manufacturer.link' }, media: { source: 'mapped', value: 'product.manufacturer.media' } } }, box: { linkUrl: 'kein link' }, ok: { url: { source: 'static', value: '/detail/1' } } };
  assert.deepEqual(collectLinks(cfg).map(l => l.href), ['/detail/1']);
  const out = rewriteLinks(cfg, new Map([['product.manufacturer.link', '/x'], ['/detail/1', '/vase']]));
  assert.equal(out.manufacturer.config.url.value, 'product.manufacturer.link'); assert.equal(out.ok.url.value, '/vase');
  const r = await checkLinks(shop(), collectLinks({ url: { source: 'mapped', value: 'product.manufacturer.link' } }));
  assert.deepEqual(r.findings, []); assert.equal(r.internal, 0);
});

test('checkLinks: variants inherit visibility/active from the parent product, footer categories are visible', async () => {
  const B = P(9).replace(/^a/, 'b');
  const r = await checkLinks(shop(), extractLinks(`<a href="/detail/${P(6)}">Variante</a><a href="/detail/${P(7)}">Variante alt</a><a href="/navigation/${P(8)}">Versand</a><a href="/navigation/${B}">Fremd</a>`));
  const by = (h: string) => r.findings.filter(f => f.href === h).map(f => `${f.level}: ${f.problem}`).join(' | ');
  assert.doesNotMatch(by(`/detail/${P(6)}`), /wichtig/);
  assert.match(by(`/detail/${P(7)}`), /^wichtig: .*Becher alt.*inaktiv/);
  assert.doesNotMatch(by(`/navigation/${P(8)}`), /wichtig/);
  assert.match(by(`/navigation/${B}`), /^wichtig: .*nicht sichtbar/);
});

test('checkHtmlItems: the text preview ("after") also shows the rewritten link', async () => {
  const { checkHtmlItems } = await import('../../src/server/seo-links');
  const raw = `<p><a href="/detail/${P(1)}">Vase</a></p>`, items = [{ afterRaw: raw, after: raw, warn: [] as string[] }];
  await checkHtmlItems(shop(), items);
  assert.equal(items[0].after, '<p><a href="/vase-kiesel/HH-1">Vase</a></p>');
});

test('checkLinks: findings have a short form (short) for lists, problem = short + remedy, no long dashes', async () => {
  const r = await checkLinks(shop(), [{ href: `/detail/${P(2)}`, text: 'hier klicken' }, { href: `/detail/${'c'.repeat(32)}`, text: 'Produkt', target: '_blank' }]);
  const f = r.findings.find(x => x.href === `/detail/${P(2)}` && x.level === 'wichtig')!;
  assert.equal(f.short, 'Produkt „Becher alt“ ist inaktiv'); assert.match(f.problem, /^Produkt „Becher alt“ ist inaktiv: nicht verlinken/);
  assert.ok(r.findings.some(x => x.short === 'Nichtssagender Linktext „hier klicken“'));
  assert.ok(r.findings.some(x => x.short === 'Interner Link öffnet neuen Tab' && x.problem === 'Interner Link öffnet neuen Tab: target="_blank" entfernen'));
  assert.ok(r.findings.every(x => x.short && x.problem.startsWith(x.short)));
  assert.doesNotMatch(r.findings.map(x => x.problem).join(' '), /[–—]/);
});

test('extractLinks: unclosed anchors are ignored as before and do not freeze (ReDoS)', () => {
  assert.deepEqual(extractLinks('<a href="/a">A</a><a href="/b">offen').map(l => l.href), ['/a']);
  for (const bad of ['<a href="/x">', '<a ', '<a href="/x"><']) {
    const t = Date.now(); extractLinks(bad.repeat(80_000)); const d = Date.now() - t;
    assert.ok(d < 1000, `${bad}: ${d} ms`);
  }
});
