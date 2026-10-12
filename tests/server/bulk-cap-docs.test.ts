import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

test('Magento und OpenMage nennen die 5.000er Stapelgrenze, die Plattform-Doku beide Deckel', () => {
  for (const rel of ['prompts/magento/12-varianten.md', 'prompts/openmage/12-varianten.md']) {
    const t = read(rel);
    const section = t.slice(t.indexOf('## Stapelverarbeitung'));
    assert.ok(section.length > 20, rel);
    assert.match(section, /5\.000/, rel);
  }
  const doc = read('docs/platform.md');
  assert.match(doc, /Magento und OpenMage brechen bei 5\.000 Produkten ab, Shopware und Shopify bei 10\.000/);
});
