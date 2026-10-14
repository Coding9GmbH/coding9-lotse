import { test } from 'node:test';
import assert from 'node:assert/strict';
import { examples } from '../../src/lib/labels';

const titles = (a: Parameters<typeof examples>[3], locale: 'de' | 'en' = 'de') => examples('Vase', 'Vasen', locale, a).map(e => e.title);

test('Examples: without integrations no Search Console, Sistrix or manufacturer examples', () => {
  const t = titles({});
  assert.equal(t.length, 8);
  assert.ok(!t.some(x => /Search-Console|Sistrix|Hersteller/.test(x)));
});

test('Examples: each integration unlocks only its own examples', () => {
  assert.ok(titles({ gsc: true }).includes('Search-Console-Chancen'));
  assert.ok(!titles({ gsc: true }).some(x => /Sistrix/.test(x)));
  assert.deepEqual(titles({ sistrix: true }).filter(x => !titles({}).includes(x)), ['Sichtbarkeit & Wettbewerb', 'Sistrix-Chancen nutzen']);
  assert.deepEqual(titles({ shopware: true }).filter(x => !titles({}).includes(x)), ['Hersteller anlegen']);
  assert.equal(titles({ gsc: true, sistrix: true, shopware: true }).length, 12);
});

test('Examples: German and English have the same count and one track per example', () => {
  const all = { gsc: true, sistrix: true, shopware: true };
  assert.equal(titles(all, 'en').length, titles(all, 'de').length);
  assert.ok(examples('Vase', 'Vasen', 'en', all).every(e => e.tag && e.title && e.text));
});
