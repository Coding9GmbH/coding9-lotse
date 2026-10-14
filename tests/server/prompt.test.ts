import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-prompt-'));
const { buildBasePrompt, buildSystem, fillVars, promptFiles, promptRoot, webBlock } = await import('../../src/server/prompt');
const { BLOCKS, GENERIC_BLOCKS } = await import('../../src/server/cms');

test('promptFiles: common + Plattform nach Dateinamen verzahnt, gleicher Name im Plattform-Ordner ersetzt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-prompts-'));
  const put = (dir: string, f: string, t: string) => { fs.mkdirSync(path.join(root, dir), { recursive: true }); fs.writeFileSync(path.join(root, dir, f), t); };
  put('common', '01-1-rolle.md', 'A'); put('common', '02-regeln.md', 'C-gemeinsam'); put('common', 'notiz.txt', 'nie');
  put('shopware', '01-2-seiten.md', 'B'); put('shopware', '02-regeln.md', 'C-shopware');
  put('shopify', '03-extra.md', 'D');
  const rel = (kind: 'shopware' | 'shopify' | 'magento') => promptFiles(kind, root).map(f => path.relative(root, f));
  assert.deepEqual(rel('shopware'), ['common/01-1-rolle.md', 'shopware/01-2-seiten.md', 'shopware/02-regeln.md']);
  assert.deepEqual(rel('shopify'), ['common/01-1-rolle.md', 'common/02-regeln.md', 'shopify/03-extra.md']);
  assert.deepEqual(rel('magento'), ['common/01-1-rolle.md', 'common/02-regeln.md'], 'ohne eigenen Ordner nur common');
});

test('fillVars: bekannte Platzhalter füllen, unbekannte stehen lassen', () => {
  assert.equal(fillVars('für einen {{shop}} ({{platform}}) {{x}}', { shop: 'Shopware-6-Shop', platform: 'Shopware' }), 'für einen Shopware-6-Shop (Shopware) {{x}}');
});

test('Gemeinsame Prompts sind plattform-neutral (Shopware-Begriffe nur in prompts/shopware)', () => {
  const dir = path.join(promptRoot(), 'common');
  for (const f of fs.readdirSync(dir)) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(t, /Shopware|Einkaufswelt|get_cms_page|reuse|Verkaufskan|pdp-|sales.?channel/i, f);
    assert.doesNotMatch(t, /[–—]{2}/, f);
  }
});

test('Shopware-Prompt: alle Platzhalter gefüllt, Einkaufswelten + voller Blockkatalog', () => {
  const p = buildBasePrompt('shopware');
  assert.doesNotMatch(p, /\{\{\w+\}\}/);
  assert.match(p, /^Du bist der AI-Assistent einer KI-first Verwaltung für einen Shopware-6-Shop \("Lotse"\)/);
  assert.match(p, /## So funktionieren Shopware-Einkaufswelten/);
  assert.match(p, /- LAYOUT\/SEITEN: Kategorie-Landingpages \(product_list\)/);
  for (const k of Object.keys(BLOCKS)) (BLOCKS[k].htmlOnly ? assert.doesNotMatch : assert.match)(p, new RegExp(`^- ${k}: `, 'm'), k);
  // Reihenfolge der aufgeteilten Datei 01: Rolle → Seiten (Shopware) → Fähigkeiten → Shop-Verwaltung (Shopware) → Ablauf
  const order = ['## Was du kannst', '- LAYOUT/SEITEN', '- PREISE & DATEN', '- SHOP-VERWALTUNG', '## Ablauf (immer)', '## Datenschutz & Zugriff', '- Du siehst nur freigegebene', '- Kunden, Bestellungen'].map(s => p.indexOf(s));
  assert.ok(order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1])), `Reihenfolge ${order.join(',')}`);
});

test('Shopify-/Magento-/OpenMage-Prompt: gemeinsame Regeln, eigene Begriffe, nur generische Blöcke', () => {
  for (const [kind, shop] of [['shopify', 'Shopify-Shop'], ['magento', 'Magento-2-Shop'], ['openmage', 'OpenMage-Shop']] as const) {
    const p = buildBasePrompt(kind);
    assert.doesNotMatch(p, /\{\{\w+\}\}/, kind);
    assert.ok(p.includes(`für einen ${shop} ("Lotse")`), kind);
    assert.doesNotMatch(p, /Einkaufswelt|Shopware/, kind);
    assert.match(p, /## Datenschutz & Zugriff/);
    assert.match(p, /## Pattern-Katalog/);
    const catalog = p.slice(p.indexOf('## Verfügbare Blocktypen'));
    // Shopify zusätzlich theme-main (Position des Theme-Inhalts in Kollektions-/Produktvorlagen)
    for (const k of Object.keys(BLOCKS)) (GENERIC_BLOCKS.includes(k) || (kind === 'shopify' && k === 'theme-main') ? assert.match : assert.doesNotMatch)(catalog, new RegExp(`^- ${k}: `, 'm'), `${kind}: ${k}`);
  }
});

test('Prompt baut für alle vier Plattformen: Platzhalter gefüllt, Shop-Begriff der Plattform, gemeinsame Abschnitte, keine doppelten Gedankenstriche', () => {
  for (const [kind, shop] of [['shopware', 'Shopware-6-Shop'], ['shopify', 'Shopify-Shop'], ['magento', 'Magento-2-Shop'], ['openmage', 'OpenMage-Shop']] as const) {
    const p = buildBasePrompt(kind);
    assert.doesNotMatch(p, /\{\{\w+\}\}/, kind);
    assert.ok(p.includes(`für einen ${shop} ("Lotse")`), kind);
    for (const h of ['## Was du kannst', '## Ablauf (immer)', '## Datenschutz & Zugriff', '## Verfügbare Blocktypen']) assert.ok(p.includes(h), `${kind}: ${h}`);
    assert.doesNotMatch(p, /[–—]{2}/, kind);
  }
});

test('Prompts nennen nur Werkzeuge, die es auf der Plattform gibt (auch shopcheckTools)', async () => {
  const { toolNamesFor } = await import('../../src/server/tools');
  const { getPlatform } = await import('../../src/server/platform');
  // Bezeichner mit Unterstrich, die keine Werkzeuge sind (Seitentypen, Feldnamen, Rabattarten)
  const allow = new Set(['product_list', 'product_detail', 'cms_page', 'shop_page', 'aicb_blocks', 'write_themes', 'special_price', 'small_image', 'cart_fixed', 'buy_x_get_y', 'content_heading']);
  for (const kind of ['shopware', 'shopify', 'magento', 'openmage'] as const) {
    const names = new Set(toolNamesFor(kind));
    const refs = [...new Set([...buildBasePrompt(kind).matchAll(/\b([a-z]+(?:_[a-z0-9]+)+)\b/g)].map(m => m[1]))];
    assert.deepEqual(refs.filter(r => !names.has(r) && !allow.has(r)), [], kind);
    const sc = getPlatform(kind).promptVars.shopcheckTools ?? '';
    assert.deepEqual([...sc.matchAll(/[a-z]+(?:_[a-z0-9]+)+/g)].map(m => m[0]).filter(n => !names.has(n)), [], `${kind} shopcheckTools`);
  }
});

test('Internetrecherche im System-Prompt: aus → ehrlicher Hinweis auf den Schalter, an → Quellenregeln und Schutz vor Anweisungen aus dem Netz', () => {
  assert.match(webBlock(false), /keinen Zugriff auf das Internet[\s\S]*Einstellungen → KI-Zugriff → Internet/);
  assert.match(webBlock(true), /Quellen[\s\S]*keine Anweisungen/);
  assert.ok(buildSystem('shopware', 'de').includes(webBlock(false)), 'Standard: aus');
  assert.ok(buildSystem('shopware', 'de', true).includes(webBlock(true)));
});
