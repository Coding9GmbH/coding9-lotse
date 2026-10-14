import { test } from 'node:test';
import assert from 'node:assert/strict';

// Technical check of live pages: evaluation (noindex, canonical, H1, structured data, robots.txt) and full run against a fake shop
const A = await import('../../../src/server/features/site-audit');
const S = await import('../../../src/server/features/seo-overview');

const page = (o: { head?: string; body?: string; lang?: string | null } = {}) =>
  `<!doctype html><html${o.lang === null ? '' : ` lang="${o.lang ?? 'de'}"`}><head><title>Vase | Haus Holm</title><meta name="viewport" content="width=device-width"><meta content="Schöne Vasen" name="description">${o.head ?? ''}</head><body>${o.body ?? '<h1>Vase</h1>'}</body></html>`;
const got = (url: string, body: string, status = 200, headers: Record<string, string> = {}) => ({ url, status, body, headers });

test('evaluate page: noindex (meta and header), canonical self/other, H1, language, viewport', () => {
  const ok = A.auditPage(got('https://www.shop.de/vase/', page({ head: '<link rel="canonical" href="https://shop.de/vase">' })), 'product');
  assert.equal(ok.noindex, false); assert.equal(ok.canonicalSelf, true, 'www. and trailing slash do not count');
  assert.equal(ok.description, 'Schöne Vasen', 'attribute order does not matter'); assert.equal(ok.h1, 1); assert.equal(ok.lang, 'de'); assert.equal(ok.viewport, true);
  assert.equal(A.auditPage(got('https://shop.de/a', page({ head: '<meta name="robots" content="noindex, follow">' })), 'home').noindex, true);
  assert.equal(A.auditPage(got('https://shop.de/a', page(), 200, { 'x-robots-tag': 'noindex' }), 'home').noindex, true);
  const other = A.auditPage(got('https://shop.de/vase-rot', page({ head: "<link href='/vase' rel='canonical'>", body: '<h1>A</h1><script>var x="<h1>"</script><h1>B</h1>' })), 'product');
  assert.equal(other.canonical, 'https://shop.de/vase'); assert.equal(other.canonicalSelf, false); assert.equal(other.h1, 2, 'H1 in scripts does not count');
  assert.equal(A.auditPage(got('https://shop.de/', page({ lang: null })), 'home').lang, null);
});

test('structured data: JSON-LD with @graph and lists, microdata, broken JSON is skipped', () => {
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","offers":{"@type":"Offer"}},{"@type":["BreadcrumbList"]}]}</script>
    <script type="application/ld+json">{kaputt</script><div itemscope itemtype="https://schema.org/Organization"></div>`;
  assert.deepEqual(A.schemaTypes(html).sort(), ['BreadcrumbList', 'Offer', 'Organization', 'Product']);
});

test('robots.txt: block only for all search engines, Allow lifts it, sitemaps are read', () => {
  assert.deepEqual(A.parseRobots('User-agent: *\nDisallow: /\nSitemap: https://shop.de/sitemap.xml'), { blocksAll: true, sitemaps: ['https://shop.de/sitemap.xml'] });
  assert.equal(A.parseRobots('User-agent: badbot\nDisallow: /\n\nUser-agent: *\nDisallow: /checkout').blocksAll, false);
  assert.equal(A.parseRobots('User-agent: *\nDisallow: /\nAllow: /').blocksAll, false);
  assert.equal(A.parseRobots('# Kommentar\nUser-agent: Googlebot\nUser-agent: *\nDisallow: / # alles').blocksAll, true, 'several User-agent lines form one group');
});

test('full run: home page, category and product found via links, findings with tasks', async () => {
  const B = 'https://www.shop.de', calls: string[] = [];
  const pages: Record<string, { status: number; body: string; headers?: Record<string, string> }> = {
    '/': { status: 200, body: page({ body: '<h1>Haus Holm</h1><a href="/wohnen/vasen/">Vasen</a><a href="https://www.shop.de/vase-kiesel">Vase</a><a href="https://fremd.de/x">extern</a><a href="/bild.jpg">Bild</a>' }) },
    '/wohnen/vasen/': { status: 200, body: page({ head: '<link rel="canonical" href="https://www.shop.de/wohnen/vasen/">', body: '<h1>Vasen</h1><script type="application/ld+json">{"@type":"BreadcrumbList"}</script>' }) },
    '/vase-alt': { status: 301, body: '', headers: { location: '/vase-kiesel' } },
    '/vase-kiesel': { status: 200, body: page({ head: '<meta name="robots" content="noindex">', body: '<h1>Vase</h1><h1>Noch eine</h1>' }) },
    '/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /checkout/' },
    '/sitemap.xml': { status: 404, body: 'nicht da' },
  };
  const fetchImpl = async (url: string) => { calls.push(url); const p = pages[new URL(url).pathname] ?? { status: 404, body: '' }; return new Response(p.body, { status: p.status, headers: p.headers }); };
  const lookup = { mapUrls: async (urls: string[]) => new Map(urls.map(u => [u, u.endsWith('/wohnen/vasen/') ? { kind: 'category', id: 'c1' } : u.endsWith('/vase-kiesel') ? { kind: 'product', id: 'p1' } : null])) } as never;
  const r = await A.siteAudit({ base: async () => B + '/', fetch: fetchImpl }, lookup, 'Shopware');
  assert.deepEqual(r.pages.map(p => p.kind), ['home', 'category', 'product']);
  assert.ok(!calls.some(c => c.includes('fremd.de')), 'no foreign pages');
  const ids = r.findings.map(f => f.id);
  for (const id of ['site:noindex', 'site:sitemap', 'site:canonical-missing', 'site:schema-product', 'site:schema-breadcrumb']) assert.ok(ids.includes(id), id);
  assert.deepEqual(r.findings.find(f => f.id === 'site:h1')?.urls, [B + '/vase-kiesel'], 'two H1 on the product page');
  assert.ok(!ids.includes('site:robots-block'));
  const noindex = r.findings.find(f => f.id === 'site:noindex')!;
  assert.equal(noindex.severity, 'hoch'); assert.deepEqual(noindex.urls, [B + '/vase-kiesel']);
  assert.match(noindex.fix, /Shopware/); assert.match(noindex.fix, /nichts behaupten zu beheben/);
  // redirect within the domain is followed, to a foreign domain it is not
  assert.equal((await A.fetchSite(fetchImpl, '/vase-alt', B)).url, B + '/vase-kiesel');
  pages['/weg'] = { status: 302, body: '', headers: { location: 'https://boese.de/' } };
  await assert.rejects(A.fetchSite(fetchImpl, '/weg', B), /fremde Adresse/);
  // as levers in the SEO area: high before medium before low, IDs stable
  const items = S.siteItems(r).sort((a, b) => b.impact - a.impact);
  assert.equal(items[0].id, 'site:noindex'); assert.ok(items.every(i => i.source === 'site' && i.kind === 'site' && i.prompt.length > 80));
});

test('home page unreachable: one clear finding, no follow-up errors', async () => {
  const r = await A.siteAudit({ base: async () => 'http://shop.de', fetch: async () => { throw new Error('ECONNREFUSED'); } }, { mapUrls: async () => new Map() } as never, 'Shopify');
  const ids = r.findings.map(f => f.id);
  assert.ok(ids.includes('site:status')); assert.ok(ids.includes('site:https'));
  assert.ok(!ids.some(i => /title|h1|canonical|noindex/.test(i)), 'unfetchable pages produce no content findings');
});
