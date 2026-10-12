import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-prompt-quality-'));
const { buildBasePrompt, promptRoot } = await import('../../src/server/prompt');

const read = (rel: string) => fs.readFileSync(path.join(promptRoot(), rel), 'utf8');

test('Qualität: H1, Listing und Wortumfang nur, wo der Seiten-Check sie verlangt', () => {
  const common = read('common/04-1-qualitaet.md');
  assert.match(common, /draft_page/, 'Qualitätsschleife bleibt');
  assert.match(common, /wichtig/);
  assert.match(common, /450/);
  assert.doesNotMatch(common, /Genau eine H1/);
  assert.doesNotMatch(common, /Kategorie ≥250/);
  assert.doesNotMatch(common, /Listing nach Hero/);
  assert.doesNotMatch(common, /≥120/);
  assert.doesNotMatch(read('common/06-gestaltung.md'), /Listing früh/);

  const shopware = buildBasePrompt('shopware');
  assert.match(shopware, /Genau eine H1/);
  assert.match(shopware, /Kategorie ≥250/);
  assert.match(shopware, /Listing nach Hero/);
  assert.doesNotMatch(shopware, /mindestens 120 Wörter/);

  const shopify = buildBasePrompt('shopify');
  assert.doesNotMatch(shopify, /Genau eine H1/);
  assert.doesNotMatch(shopify, /Kategorie ≥250/);
  assert.match(shopify, /Kollektionsseite[\s\S]{0,800}Kein eigenes H1/);
  assert.match(shopify, /Produktseiten-Vorlage[\s\S]{0,900}Kein eigenes H1/);
  assert.match(shopify, /mindestens 250 Wörter/);
  assert.match(shopify, /höchstens 200 Wörter vor theme-main/);
  assert.doesNotMatch(shopify, /product-listing-Block/);

  for (const kind of ['magento', 'openmage'] as const) {
    const p = buildBasePrompt(kind);
    assert.doesNotMatch(p, /Genau eine H1/, kind);
    assert.doesNotMatch(p, /Kategorie ≥250/, kind);
    assert.match(p, /Kategorie \(product_list[\s\S]{0,800}KEINE H1/, kind);
    assert.match(p, /Produkt \(product_detail[\s\S]{0,900}KEINE H1/, kind);
    assert.match(p, /KEIN product-listing-Block/, kind);
    assert.match(p, /mindestens 150 und höchstens 300 Wörter/, kind);
    assert.match(p, /mindestens 120 Wörter/, kind);
  }
});
