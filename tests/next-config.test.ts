import { test } from 'node:test';
import assert from 'node:assert/strict';
import nextConfig from '../next.config';

// Sicherheits-Header: Oberfläche/API nie einbettbar, /shop und /staged (eigene CSP, Vorschau im iframe) nur SAMEORIGIN.
type Rule = { source: string; headers: { key: string; value: string }[] };
const rules = (await nextConfig.headers!()) as Rule[];
/** Grobe Nachbildung von path-to-regexp für die hier genutzten Quellen ('/', '/x/:path*') */
const matches = (source: string, path: string) => source === '/:path*' || source === path || (source.endsWith('/:path*') && (path === source.slice(0, -7) || path.startsWith(source.slice(0, -6))));
/** Wie Next: alle passenden Regeln, spätere überschreiben gleiche Schlüssel */
const headersFor = (path: string) => Object.fromEntries(rules.filter(r => matches(r.source, path)).flatMap(r => r.headers.map(h => [h.key.toLowerCase(), h.value])));

test('App-Routen: frame-ancestors none, DENY, object-src/base-uri/form-action – ohne script-src (Next-Inline-Skripte)', () => {
  for (const path of ['/', '/settings', '/wissen', '/api/approve', '/api/settings']) {
    const h = headersFor(path);
    assert.equal(h['x-frame-options'], 'DENY', path);
    const csp = h['content-security-policy'] ?? '';
    for (const d of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"]) assert.ok(csp.includes(d), `${path}: ${d}`);
    assert.doesNotMatch(csp, /script-src|default-src/, path);
    assert.equal(h['x-content-type-options'], 'nosniff');
    assert.equal(h['referrer-policy'], 'same-origin');
  }
});

test('/shop, /staged und Storefront-Pfade: einbettbar in die eigene Oberfläche, ohne App-CSP (setzen ihre eigene)', () => {
  for (const path of ['/shop', '/shop/navigation/x', '/staged/abc.png', '/media/x.svg', '/widgets/menu']) {
    const h = headersFor(path);
    assert.equal(h['x-frame-options'], 'SAMEORIGIN', path);
    assert.equal(h['content-security-policy'], undefined, path);
    assert.equal(h['x-content-type-options'], 'nosniff');
  }
});
