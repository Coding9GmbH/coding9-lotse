import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

test('search queries: the terms go to the model provider, they are not "keine Personendaten" (no personal data)', () => {
  const t = read('prompts/common/18-gsc.md');
  assert.doesNotMatch(t, /keine Personendaten/);
  assert.doesNotMatch(t, /nur Begriffe/);
  assert.match(t, /Die Suchbegriffe gehen an Anthropic oder OpenAI/);
  assert.doesNotMatch(t, /updatedAt/);
});

test('approved data: unused sample codes without redeemers may go to the AI', () => {
  const files = [
    'prompts/shopware/02-2-freigegebene-daten.md',
    'prompts/magento/02-2-freigegebene-daten.md',
    'prompts/openmage/02-2-freigegebene-daten.md',
    'prompts/shopify/02-2-freigegebene-daten.md',
    'prompts/shopware/14-promotionen.md',
    'prompts/magento/14-promotionen.md',
    'prompts/openmage/14-promotionen.md',
    'prompts/shopify/14-promotionen.md',
  ];
  for (const rel of files) {
    const t = read(rel);
    assert.doesNotMatch(t, /nur Zählwerte/, rel);
    assert.match(t, /ungenutzte Beispielcodes ohne Kundendaten und ohne Einlöser/, rel);
  }
  const sec = read('SECURITY.md');
  assert.match(sec, /Ungenutzte Beispielcodes ohne Einlöser gehen mit/);
  assert.doesNotMatch(sec, /keine Codes/);
});
