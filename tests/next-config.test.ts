import { test } from 'node:test';
import assert from 'node:assert/strict';
import nextConfig from '../next.config';

// Security headers: UI/API never embeddable, /shop and /staged (own CSP, preview in iframe) SAMEORIGIN only.
type Rule = { source: string; headers: { key: string; value: string }[] };
const rules = (await nextConfig.headers!()) as Rule[];
/** Rough imitation of path-to-regexp for the sources used here ('/', '/x/:path*') */
const matches = (source: string, path: string) => source === '/:path*' || source === path || (source.endsWith('/:path*') && (path === source.slice(0, -7) || path.startsWith(source.slice(0, -6))));
/** Like Next: all matching rules, later ones override identical keys */
const headersFor = (path: string) => Object.fromEntries(rules.filter(r => matches(r.source, path)).flatMap(r => r.headers.map(h => [h.key.toLowerCase(), h.value])));

test('app routes: frame-ancestors none, DENY, object-src/base-uri/form-action, without script-src (Next inline scripts)', () => {
  for (const path of ['/', '/settings', '/wissen', '/sandbox-coding', '/sandbox-coding/t_abcdefabcdef', '/api/approve', '/api/settings']) {
    const h = headersFor(path);
    assert.equal(h['x-frame-options'], 'DENY', path);
    const csp = h['content-security-policy'] ?? '';
    for (const d of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"]) assert.ok(csp.includes(d), `${path}: ${d}`);
    assert.doesNotMatch(csp, /script-src|default-src/, path);
    assert.equal(h['x-content-type-options'], 'nosniff');
    assert.equal(h['referrer-policy'], 'same-origin');
  }
});

test('/shop, /staged and storefront paths: embeddable in our own UI, without app CSP (they set their own)', () => {
  for (const path of ['/shop', '/shop/navigation/x', '/staged/abc.png', '/media/x.svg', '/widgets/menu']) {
    const h = headersFor(path);
    assert.equal(h['x-frame-options'], 'SAMEORIGIN', path);
    assert.equal(h['content-security-policy'], undefined, path);
    assert.equal(h['x-content-type-options'], 'nosniff');
  }
});

test('/sbx (sandbox preview): SAMEORIGIN, no app CSP, Referer only within Lotse (the key in the path never leaves)', () => {
  for (const path of ['/sbx/t_abcdefabcdef.0123456789abcdef0123', '/sbx/t_abcdefabcdef.0123456789abcdef0123/checkout/cart']) {
    const h = headersFor(path);
    assert.equal(h['x-frame-options'], 'SAMEORIGIN', path);
    assert.equal(h['content-security-policy'], undefined, path);
    assert.equal(h['referrer-policy'], 'same-origin', path);
  }
});
