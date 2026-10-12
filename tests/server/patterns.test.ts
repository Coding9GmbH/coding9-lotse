import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PATTERNS } from '../../src/server/patterns';
import type { PageSpec } from '../../src/server/cms';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-test-'));

const heads = (html: string) => (html.match(/<th scope="col"[^>]*>[^<]*<\/th>/g) ?? []).length;

test('Vergleich: Kopf bekommt leere Ecke, wenn Zeilen eine Beschriftungsspalte haben', () => {
  const rows = [['Röstgrad', 'mitteldunkel', 'hell'], ['Packung', '500 g', '500 g']];
  assert.equal(heads(PATTERNS.comparison.build({ title: 'T', columns: ['Espresso', 'Filter'], rows }).html), 3);
  assert.equal(heads(PATTERNS.comparison.build({ title: 'T', columns: ['', 'Espresso', 'Filter'], rows }).html), 3);
});

test('Hero: Split-Überschrift bleibt kompakt', () => {
  const { css } = PATTERNS.hero.build({ title: 'T', ctaText: 'Los', ctaHref: '/' });
  assert.match(css, /\.hero\.split h1/);
});

test('KI-Bild: Muster kennzeichnen es sichtbar, echte Fotos nicht', async () => {
  const { stageImage, AI_CREDIT } = await import('../../src/server/media');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5d10000000049454e44ae426082', 'hex');
  const ai = stageImage(png, 'image/png', { alt: 'Kaffee', ai: true }), real = stageImage(png, 'image/png', { alt: 'Foto' });
  for (const p of ['hero', 'split', 'band']) {
    assert.ok(PATTERNS[p].build({ title: 'T', ctaText: 'Los', ctaHref: '/', imageUrl: ai.url, imageAlt: 'x' }).html.includes(AI_CREDIT), p);
    assert.ok(!PATTERNS[p].build({ title: 'T', ctaText: 'Los', ctaHref: '/', imageUrl: real.url, imageAlt: 'x' }).html.includes(AI_CREDIT), p);
  }
});

test('Shop-Medium mit Titel „KI-generiert“ bekommt die Bildzeile, normale Fotos nicht', async () => {
  const { noteMedia, AI_CREDIT } = await import('../../src/server/media');
  assert.equal(noteMedia({ url: 'http://shop.test/media/ab/vase.jpg', title: 'KI-generiert: Vase' }), true);
  assert.equal(noteMedia({ url: 'http://shop.test/media/cd/foto.jpg', title: 'Vase' }), false);
  const html = (url: string) => PATTERNS.split.build({ title: 'T', text: 'x', imageUrl: url, imageAlt: 'x' }).html;
  assert.ok(html('http://localhost:3333/shop/media/ab/vase.jpg').includes(AI_CREDIT)); // gleicher Pfad, anderer Host
  assert.ok(!html('http://shop.test/media/cd/foto.jpg').includes(AI_CREDIT));
});

test('Sicherheit der Muster: unsichere Links, HTML in Daten und JSON-LD-Ausbruch werden entschärft', () => {
  const hero = PATTERNS.hero.build({ title: '<img src=x onerror=alert(1)>', ctaText: 'Los', ctaHref: 'javascript:alert(1)', secondaryText: 'Mehr', secondaryHref: 'data:text/html,x' }).html;
  assert.ok(!hero.includes('<img src=x'), 'Titel escaped'); assert.match(hero, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal((hero.match(/href="#"/g) ?? []).length, 2, 'javascript:/data: → "#"');
  assert.match(PATTERNS['cta-banner'].build({ title: 'T', ctaText: 'Los', ctaHref: 'tel:+4940123' }).html, /href="tel:\+4940123"/);
  const faq = PATTERNS.faq.build({ title: 'F', items: [{ q: '</script><script>alert(1)</script>', a: 'Antwort' }] }).html;
  assert.equal((faq.match(/<script/g) ?? []).length, 1, 'nur das JSON-LD-Skript');
  assert.match(faq, /"name":"\\u003c\/script>\\u003cscript>alert\(1\)\\u003c\/script>"/, "kein </script> im JSON-LD"); assert.match(faq, /<summary>&lt;\/script&gt;/);
  assert.match(PATTERNS['usp-bar'].build({ items: [{ icon: 'nicht-vorhanden', title: 'x' }] }).html, /M20 6 9 17l-5-5/, 'unbekanntes Icon → check');
  for (const p of ['usp-bar', 'benefits', 'steps', 'faq', 'facts']) assert.doesNotThrow(() => PATTERNS[p].build({ title: 'T', items: 'kein Array' }), p);
  assert.match(PATTERNS.split.build({ title: 'T', text: 'x', points: 'kein Array', imageUrl: '/a.jpg' }).html, /<\/p><\/div>/);
});

test('Vergleich: Zeilen, die kein Array sind, werden übersprungen statt abzustürzen', () => {
  const html = PATTERNS.comparison.build({ title: 'T', columns: ['Espresso', 'Filter'], rows: ['Röstgrad mitteldunkel hell', ['Packung', '500 g', '500 g']] }).html;
  assert.equal((html.match(/<tr>/g) ?? []).length, 2); assert.match(html, /<th scope="row">Packung<\/th>/);
});

test('Hero: Bildvarianten ohne imageUrl werden plain (keine weiße Schrift auf weißer Fläche)', () => {
  assert.match(PATTERNS.hero.build({ variant: 'image', title: 'Vasen', ctaText: 'Los', ctaHref: '/' }).html, /class="hero plain"/);
  assert.match(PATTERNS.hero.build({ variant: 'split', title: 'Vasen', ctaText: 'Los', ctaHref: '/' }).html, /class="hero plain"/);
  const withImg = PATTERNS.hero.build({ variant: 'image', title: 'Vasen', ctaText: 'Los', ctaHref: '/', imageUrl: '/a.jpg' }).html;
  assert.match(withImg, /class="hero image"/); assert.match(withImg, /<img class="media pic"/);
  assert.match(PATTERNS.hero.build({ variant: 'solid', title: 'Vasen', ctaText: 'Los', ctaHref: '/' }).html, /class="hero solid"/);
});

test('Unbekanntes Pattern: wird gemeldet statt still zum Platzhaltertext zu werden', async () => {
  const { expandSpec, unknownPatterns, patternCatalog } = await import('../../src/server/patterns');
  const { validateSpec, renderPreview } = await import('../../src/server/cms');
  const spec = { name: 'T', type: 'landingpage', sections: [{ blocks: [{ type: 'pattern', pattern: 'ctaBanner', data: { title: 'x' } }, { type: 'pattern', pattern: 'facts', data: { items: [] } }] }] } as unknown as PageSpec;
  assert.deepEqual(unknownPatterns(spec), ['ctaBanner']);
  const ex = expandSpec(spec);
  assert.equal(ex.sections[0].blocks[0].type, 'pattern', 'bleibt stehen'); assert.equal(ex.sections[0].blocks[1].type, 'custom-html');
  assert.match(validateSpec(ex)[0], /unbekanntes Pattern "ctaBanner"/);
  const html = renderPreview(ex);
  assert.ok(!html.includes('Unbekanntes Pattern')); assert.match(html, /class="ph"[^>]*>Pattern ctaBanner</, 'nur Platzhalter während des Streamens');
  assert.doesNotMatch(patternCatalog(), /[–—]/, 'Pattern-Katalog ohne lange Striche');
});
