import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-prompt-cap-'));
const { buildBasePrompt, promptRoot } = await import('../../src/server/prompt');

const read = (rel: string) => fs.readFileSync(path.join(promptRoot(), rel), 'utf8');

test('Gemeinsame Fähigkeiten nennen keine Felder, die nicht jede Plattform speichert', () => {
  for (const rel of ['common/01-3-faehigkeiten.md', 'common/07-produkte.md']) {
    const t = read(rel);
    assert.doesNotMatch(t, /EAN/, rel);
    assert.doesNotMatch(t, /Hersteller-Nr/, rel);
    assert.doesNotMatch(t, /brutto/i, rel);
  }
  assert.match(read('common/07-produkte.md'), /Preis NIE schätzen/);

  const shopware = buildBasePrompt('shopware');
  assert.match(shopware, /EAN\/Hersteller-Nr/);
  assert.match(shopware, /Preis \(brutto\)/);

  const shopifySkills = read('shopify/01-3-faehigkeiten.md');
  const shopifyProducts = read('shopify/07-produkte.md');
  assert.match(shopifySkills, /Barcode/);
  assert.match(shopifyProducts, /Preis NIE schätzen/);
  assert.doesNotMatch(shopifyProducts, /brutto/i);

  for (const kind of ['magento', 'openmage'] as const) {
    const p = buildBasePrompt(kind);
    assert.doesNotMatch(p, /Preis \(brutto\)/, kind);
    assert.doesNotMatch(p, /EAN\/Hersteller-Nr/, kind);
  }
});

test('save_styleguide verspricht kein Shopware-Onboarding und keinen reuse-Block', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  const start = src.indexOf("tool('save_styleguide'");
  const end = src.indexOf("tool('draft_page'", start);
  assert.ok(start >= 0 && end > start);
  const block = src.slice(start, end);
  assert.doesNotMatch(block, /get_brand_signals/);
  assert.doesNotMatch(block, /reuse/);
  assert.match(block, /Farben/);
  assert.match(block, /Typografie/);
  assert.match(block, /Tonalität/);
});
