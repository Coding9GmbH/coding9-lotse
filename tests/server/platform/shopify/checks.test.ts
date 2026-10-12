// Shopify-Shop-Check: reine Auswertung + Durchlauf gegen den Admin-GraphQL-Fake (Seed „Haus Holm“ mit eingebauten Lücken).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CheckFinding } from '@/lib/protocol';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-shopify-checks-'));
delete process.env.SHOP_PLATFORM;

const { startFakeShopify } = await import('../../../../test-support/shopify-fake/server');
const fake = await startFakeShopify({ port: 0 });
after(() => fake.close());
const { updateSettings } = await import('../../../../src/server/settings');
const { getPlatform, reconfigureAll } = await import('../../../../src/server/platform/index');
const { listChecks } = await import('../../../../src/server/checks');
const { scanFindings, internalLinks, toRow, SHOPIFY_DEFS } = await import('../../../../src/server/platform/shopify/checks');
const { toolNamesFor } = await import('../../../../src/server/tools');

updateSettings({ platform: 'shopify', shopify: { storeDomain: fake.url, accessToken: fake.token, apiVersion: '2026-10' } });
reconfigureAll();
const shopify = getPlatform('shopify');

test('Auswertung (rein): Metas, dünne Texte, Bilder, Bestand, Preise', () => {
  const row = (id: string, o: Partial<ReturnType<typeof toRow>>) => ({ ...toRow({ id: `gid://shopify/Product/${id}`, title: `P${id}`, handle: `p${id}`, descriptionHtml: '<p>' + 'Wort '.repeat(60) + '</p>', seo: { title: 'Titel', description: 'D' }, tracksInventory: true, variants: { nodes: [{ price: '10.00', inventoryPolicy: 'DENY', inventoryQuantity: 5 }] }, media: { nodes: [{ id: 'm', alt: 'a' }] } }), ...o });
  const h = scanFindings([
    row('1', { metaTitle: '', metaDescription: '' }),
    row('2', { metaTitle: 'x'.repeat(70), description: '<p>kurz</p>', images: 0 }),
    row('3', { metaTitle: 'Gleich', altMissing: 1, variants: [{ price: 0, compareAt: null, policy: 'CONTINUE', qty: 0 }] }),
    row('4', { metaTitle: 'gleich', variants: [{ price: 20, compareAt: 18, policy: 'DENY', qty: 0 }, { price: 200, compareAt: null, policy: 'DENY', qty: 0 }] }),
  ]);
  assert.deepEqual(h.metaDescMissing.map(x => x.id), ['1']); assert.deepEqual(h.metaTitleMissing.map(x => x.id), ['1']);
  assert.deepEqual(h.metaTitleLong.map(x => x.id), ['2']); assert.equal(h.metaTitleDup.count, 2);
  assert.deepEqual(h.thin.map(x => x.id), ['2']); assert.deepEqual(h.noImage.map(x => x.id), ['2']); assert.deepEqual(h.altMissing.map(x => x.id), ['3']);
  assert.deepEqual(h.oversell.map(x => x.id), ['3']); assert.deepEqual(h.soldOut.map(x => x.id), ['4']);
  assert.deepEqual(h.priceZero.map(x => x.id), ['3']); assert.deepEqual(h.listBelow.map(x => x.id), ['4']); assert.match(h.listBelow[0].label, /18,00 €/);
  assert.deepEqual(h.priceSpread.map(x => x.id), ['4']);
});

test('Interne Links: relativ und eigene Domains, mit Sprachpräfix; fremde Domains und Anker zählen nicht', () => {
  const html = '<a href="/products/vase">a</a><a href="https://haus-holm.myshopify.com/en/collections/keramik">b</a><a href="https://example.com/products/x">c</a><a href="#top">d</a><a href="/pages/ueber-uns">e</a><a href="/collections/all">f</a>';
  assert.deepEqual(internalLinks(html, ['haus-holm.myshopify.com']).map(l => `${l.kind}:${l.handle}`), ['product:vase', 'category:keramik', 'landing:ueber-uns']);
});

test('Aufträge nennen nur Shopify-Werkzeuge, die es gibt; keine Shopware-Begriffe', () => {
  const names = new Set(toolNamesFor('shopify'));
  for (const d of Object.values(SHOPIFY_DEFS)) {
    const t = d.fix('3 Produkte') + d.hint;
    for (const m of t.matchAll(/\b([a-z]+(?:_[a-z]+)+)\b/g)) assert.ok(names.has(m[1]) || ['product_list', 'product_detail'].includes(m[1]), `${d.id}: ${m[1]} gibt es nicht`);
    assert.doesNotMatch(t, /Shopware|Einkaufswelt|find_products_by_data|get_product_details|suggest_internal_links/, d.id);
    assert.doesNotMatch(t, /[–—]/, d.id);
  }
});

test('Durchlauf gegen den Fake: Befunde aus echten Daten, Datenschutz-Bereiche wirken', async () => {
  // eingebaute Lücken: Seite mit kaputtem Link, Kollektion ohne Description
  await fake.graphql('mutation { pageCreate(page: { title: "Ratgeber", handle: "ratgeber", body: "<p><a href=\\"/products/gibt-es-nicht\\">alt</a> <a href=\\"/products/vase-kiesel\\">ok</a></p>", isPublished: true }) { page { id } userErrors { message } } }');
  await shopify.loadChecks();
  const checks = listChecks('shopify'), reader = shopify.openSession('shop-check').reader;
  assert.ok(checks.length >= 15, `${checks.length} Prüfungen`);
  assert.ok(checks.every(c => c.id.startsWith('shopify.') || c.platforms === 'all'));
  const findings: CheckFinding[] = [];
  for (const c of checks.filter(c => c.platforms !== 'all')) { const r = await c.run(reader as never, { platform: 'shopify', reader, lookup: shopify.lookup(reader) }); findings.push(...[r].flat().filter((f): f is CheckFinding => !!f)); }
  const by = (id: string) => findings.find(f => f.id === id);
  assert.equal(by('bilder.product-without-image')?.count, 1, 'Plaid ohne Bild');
  assert.match(String(by('bilder.product-without-image')?.fixPrompt), /find_image_gaps missing=images[\s\S]*propose_product_images/);
  assert.ok((by('bilder.alt-missing')?.count ?? 0) >= 1, 'Vase-Bild ohne Alt-Text');
  assert.ok((by('seo.product-meta-description-missing')?.count ?? 0) >= 1);
  assert.equal(by('links.pages')?.count, 1); assert.match(JSON.stringify(by('links.pages')?.sample), /gibt-es-nicht/);
  assert.ok(by('sprachen.missing-translation.en'), 'Englisch: Übersetzungen fehlen');
  assert.ok(findings.every(f => f.total == null || f.count <= f.total));
  assert.ok(checks.filter(c => c.platforms !== 'all').every(c => c.scopes?.length), 'jede Prüfung nennt ihre Bereiche (abschaltbar unter KI-Zugriff)');
});
