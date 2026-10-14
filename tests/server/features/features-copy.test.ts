import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Deutsche Texte (Werkzeugbeschreibungen, Warnungen, Skip-Gründe) ohne lange Gedankenstriche; der alleinstehende Platzhalter „–“ für leere Werte bleibt erlaubt.
test('Module Bilder, SEO, Stammdaten, Sprachen: keine langen Gedankenstriche in Texten', () => {
  for (const f of ['product-images', 'seo', 'seo-rules', 'product-data', 'product-data-plan', 'product-data-apply', 'translations', 'translations-html']) {
    const src = fs.readFileSync(new URL(`../../../src/server/features/${f}.ts`, import.meta.url), 'utf8');
    const hits = src.split('\n').flatMap((l, i) => (/\s[–—]\s/.test(l) ? [`${f}.ts:${i + 1}`] : []));
    assert.deepEqual(hits, []);
  }
});
