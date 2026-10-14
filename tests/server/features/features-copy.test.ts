import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// German texts (tool descriptions, warnings, skip reasons) without long dashes; the standalone placeholder "–" for empty values stays allowed.
test('modules images, SEO, product data, languages: no long dashes in texts', () => {
  for (const f of ['product-images', 'seo', 'seo-rules', 'product-data', 'product-data-plan', 'product-data-apply', 'translations', 'translations-html']) {
    const src = fs.readFileSync(new URL(`../../../src/server/features/${f}.ts`, import.meta.url), 'utf8');
    const hits = src.split('\n').flatMap((l, i) => (/\s[–—]\s/.test(l) ? [`${f}.ts:${i + 1}`] : []));
    assert.deepEqual(hits, []);
  }
});
