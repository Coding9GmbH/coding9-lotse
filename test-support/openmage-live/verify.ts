// Live-Prüfung des OpenMage-Adapters gegen eine echte OpenMage-Instanz mit installiertem Lotse_Connector und den
// „Haus Holm“-Demodaten (integrations/openmage/README.md): jede Änderungsart über die echten Lotse-Werkzeuge
// (Vorschlag → Freigabe → Schreiben → Rückgängig), Seiten veröffentlichen mit Storefront-HTML-Prüfung, Shop-Check, Import.
// Am Ende muss der Shop-Zustand (Produkte, Kategorien, CMS, Preisregeln, URL-Rewrites) dem Ausgangszustand entsprechen.
//
//   OPENMAGE_URL=http://127.0.0.1:8891 OPENMAGE_TOKEN=… npx tsx --conditions=react-server test-support/openmage-live/verify.ts
//   Optional: OPENMAGE_STORE_CODE (Standard: Standard-Store-View), LOTSE_OUT=<Ordner> für die Storefront-HTML-Dateien.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatEvent } from '@/lib/protocol';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-openmage-live-'));
const URL_ = (process.env.OPENMAGE_URL ?? '').replace(/\/+$/, ''), TOKEN = process.env.OPENMAGE_TOKEN ?? '';
if (!URL_ || !TOKEN) { console.error('OPENMAGE_URL und OPENMAGE_TOKEN setzen'); process.exit(2); }
const OUT = process.env.LOTSE_OUT;
const { updateSettings } = await import('../../src/server/settings');
const { getSession, decideChange, undoChangeSet } = await import('../../src/server/sessions');
const { buildTools } = await import('../../src/server/tools');
const { reconfigureAll } = await import('../../src/server/platform/index');
const { openmage, openmageReaderFor } = await import('../../src/server/platform/openmage/index');
const { listChecks } = await import('../../src/server/checks');
const { runChecks } = await import('../../src/server/shopcheck-run');
const { stageImage } = await import('../../src/server/media');
const { saveFile } = await import('../../src/server/files');

updateSettings({ platform: 'openmage', openmage: { url: URL_, token: TOKEN, storeCode: process.env.OPENMAGE_STORE_CODE ?? '' } });
reconfigureAll();

const api = async (p: string) => { const r = await fetch(`${URL_}/lotse-api${p}`, { headers: { authorization: `Bearer ${TOKEN}` } }); const j = await r.json(); if (!r.ok) throw new Error(`${p}: ${r.status} ${JSON.stringify(j)}`); return j.data; };
const page = async (p: string) => { const r = await fetch(`${URL_}${p}`, { headers: { 'cache-control': 'no-cache' }, redirect: 'manual' }); return { status: r.status, location: r.headers.get('location') ?? '', html: await r.text() }; };
const events: ChatEvent[] = [], session = getSession('openmage-live');
session.emit = ev => { events.push(ev); session.events.push(ev); if (ev.t === 'changeset') setTimeout(() => decideChange(session.id, ev.approvalId, true), 0); };
const tools = buildTools(session);
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await tools.find(t => t.name === name)!.handler(args, {})) as { isError?: boolean; content: { text: string }[] };
  const t = r.content.map(c => c.text).join('\n');
  if (r.isError) throw new Error(`${name}: ${t}`);
  try { return JSON.parse(t); } catch { return t; }
};
const lastResult = () => [...events].reverse().find((e): e is Extract<ChatEvent, { t: 'changeset_result' }> => e.t === 'changeset_result')!;
let checks = 0;
const ok = (cond: unknown, msg: string) => { if (!cond) throw new Error(`PRÜFUNG FEHLGESCHLAGEN: ${msg}`); checks++; console.log(`  ✓ ${msg}`); };
const log = (...a: unknown[]) => console.log(...a);
const save = (name: string, html: string) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, name), html); } };

/** Vollständiger Vergleichszustand (ohne Zeitstempel und Zähler): global und jede Store-View (auch die, die Kunden sehen) */
const STORES = ['', ...((await api('/v1/info') as { store_views: { id: number; code: string }[] }).store_views.filter(v => v.id > 0).map(v => v.code))];
async function state(): Promise<string> {
  const strip = (x: unknown): unknown => Array.isArray(x) ? x.map(strip) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([k]) => !['updated_at', 'update_time', 'duration_ms', 'created_at', 'creation_time'].includes(k)).map(([k, v]) => [k, strip(v)])) : x;
  const list = async (p: string) => (await api(`${p}${p.includes('?') ? '&' : '?'}limit=200`)) as { sku?: string; id: number }[];
  const products = await list('/v1/products'), out: Record<string, unknown> = {};
  for (const p of products) for (const st of STORES) out[`p:${p.sku}:${st}`] = await api(`/v1/products/${encodeURIComponent(p.sku!)}${st ? `?store=${st}` : ''}`);
  const cats = (await api('/v1/categories?flat=1')) as { id: number }[];
  for (const c of cats) for (const st of STORES) out[`c:${c.id}:${st}`] = await api(`/v1/categories/${c.id}${st ? `?store=${st}` : ''}`);
  for (const pg of (await list('/v1/cms/pages')) as { id: number }[]) out[`page:${pg.id}`] = await api(`/v1/cms/pages/${pg.id}`);
  for (const b of (await list('/v1/cms/blocks')) as { id: number }[]) out[`block:${b.id}`] = await api(`/v1/cms/blocks/${b.id}`);
  for (const r of (await list('/v1/salesrules')) as { id: number }[]) out[`rule:${r.id}`] = await api(`/v1/salesrules/${r.id}`);
  // System-Rewrites legt OpenMage bei Kategorie-Zuordnungen neu an (neue ID): ohne ID vergleichen
  out.rewrites = ((await api('/v1/urlrewrites?all=1&limit=200')) as Record<string, unknown>[]).map(r => { const { id: _ignored, ...rest } = r; void _ignored; return rest; }).map(r => JSON.stringify(r)).sort();
  return JSON.stringify(strip(out));
}
async function undoLast(label: string) {
  const u = await undoChangeSet(session.id, lastResult().csId);
  ok(u?.ok, `${label}: Rückgängig ausgeführt${u?.ok ? '' : ` (${JSON.stringify(u)})`}`);
}
async function roundtrip(label: string, run: () => Promise<{ status?: string; [k: string]: unknown }>, check?: (r: Record<string, unknown>) => void | Promise<void>) {
  const before = await state();
  const r = await run();
  ok(r.status === 'applied', `${label}: angewendet${r.status === 'applied' ? '' : ` (${JSON.stringify(r).slice(0, 400)})`}`);
  ok((await state()) !== before, `${label}: Shop hat sich geändert`);
  await check?.(r);
  await undoLast(label);
  const after = await state();
  if (after !== before) diff(before, after);
  ok(after === before, `${label}: Ausgangszustand exakt wiederhergestellt`);
}
/** Unterschiede zweier Zustände ausgeben (zur Fehlersuche) */
function diff(a: string, b: string) {
  const A = JSON.parse(a) as Record<string, unknown>, B = JSON.parse(b) as Record<string, unknown>;
  const walk = (x: unknown, y: unknown, p: string) => {
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x)) { for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], `${p}.${k}`); return; }
    console.log(`  ≠ ${p}: ${JSON.stringify(x)?.slice(0, 300)} -> ${JSON.stringify(y)?.slice(0, 300)}`);
  };
  for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) walk(A[k], B[k], k);
}

const start = await state();
log(`${(await openmage.testConnection()).message} (Store-Views im Vergleich: ${STORES.filter(Boolean).join(', ')})`);
const write = async (method: string, p: string, body: unknown) => { const r = await fetch(`${URL_}/lotse-api${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(j)}`); return j.data; };
const info = await api('/v1/info') as { price_includes_tax: boolean };
log(`Preisbasis laut Shop: ${info.price_includes_tax ? 'brutto' : 'netto'}`);

// ---- Lesen ----
const sp = await call('search_products', { term: 'Vase' });
ok(sp.products.some((p: { number: string }) => p.number === 'HH-VASE-KIESEL'), 'search_products findet die Vase');
const gp = await call('get_product', { id: 'HH-VASE-KIESEL' });
ok(gp.price === '49,00 €' && gp.images?.[0]?.mediaId?.startsWith('om-1-'), `get_product: Preis ${gp.price}, Bild ${gp.images?.[0]?.mediaId}`);
const en = await call('get_translations', { entity: 'product', ids: ['1'], stores: ['en'] });
ok(en[0].storeViews.en.name.own === true, 'get_translations: en hat eigenen Namen');
const cat = await call('get_category', { id: '3' });
ok(cat.url === `${URL_}/wohnaccessoires.html`, `get_category: URL ${cat.url}`);
const mu = await session.lookup.mapUrls([`${URL_}/vase-kiesel.html`, `${URL_}/wohnaccessoires.html`, `${URL_}/ueber-haus-holm`, `${URL_}/`]);
ok(mu.get(`${URL_}/vase-kiesel.html`)?.kind === 'product' && mu.get(`${URL_}/wohnaccessoires.html`)?.kind === 'category' && mu.get(`${URL_}/ueber-haus-holm`)?.kind === 'landing' && mu.get(`${URL_}/`)?.kind === 'home', 'Search-Console-Zuordnung über URL-Rewrites und CMS');
const rp = await call('read_page', { url: `${URL_}/vase-kiesel.html` });
ok(rp.target?.type === 'PRODUCT', 'read_page erkennt die Produktseite');
const vars = await call('get_variants', { id: 'HH-KISSEN-WELLE' });
ok(vars.variants?.length === 3 && vars.axes[0].code === 'color', 'get_variants: 3 Varianten über Farbe');
const promos = await call('list_promotions', {});
ok(promos.promotions.some((p: { code: { code?: string } }) => p.code.code === 'WILLKOMMEN10'), 'list_promotions zeigt den Gutschein');
ok(!JSON.stringify(await api('/v1/products/HH-VASE-KIESEL')).replace(/backorders/g, '').match(/customer|order/i), 'Produktdaten ohne Kunden-/Bestellbezug');

// ---- Produkte ----
await roundtrip('Produktänderung (Texte, Preis + Streichpreis, Bestand, Status, Attribut)', () => call('propose_product_changes', { title: 'Live', reason: 'Test', changes: [{ id: 'HH-VASE-KIESEL', fields: { name: 'Vase „Kiesel“ (Test)', metaDescription: 'Neue Meta-Description aus dem Live-Test, lang genug für die Suche und mit einem Nutzen für den Leser formuliert.', price: { percent: -10, round: '.99' }, listPrice: 49, specialToDate: '2026-12-31', stock: 95, active: false } }, { id: 'HH-KISSEN-WELLE-SAND', fields: { attributes: { color: 'Salbei' } } }] }), async () => {
  const p = await api('/v1/products/HH-VASE-KIESEL') as Record<string, unknown>, en = await api('/v1/products/HH-VASE-KIESEL?store=en') as { name: string; attributes: Record<string, unknown> };
  const de = await api('/v1/products/HH-VASE-KIESEL?store=default') as { status: number; special_price: number | null };
  ok(p.name === 'Vase „Kiesel“ (Test)' && Number(p.price) === 49 && Number(p.special_price) === 43.99 && String(p.special_to_date).startsWith('2026-12-31'), `global: Name, Preis 49 / Sonderpreis 43.99 bis 31.12.`);
  // status hat in der Standard-Store-View einen eigenen Wert: Lotse schreibt dort (so sieht es Kunde und Admin), global bleibt unberührt
  ok(de.status === 2 && Number(de.special_price) === 43.99, 'Store-View default: Status 2 (eigener Wert), Sonderpreis sichtbar');
  ok((p.stock as { qty: number }).qty === 95, 'Bestand 95');
  ok(en.name === 'Vase "Kiesel"', 'englischer Name (eigener Wert der View) unverändert');
  ok((await api('/v1/products/HH-KISSEN-WELLE-SAND') as { attributes: { color: number } }).attributes.color === 4, 'Attribut color = Salbei (4)');
});
await roundtrip('Übersetzung: en setzen und entfernen', () => call('propose_translations', { title: 'EN', reason: 'Test', entity: 'product', changes: [{ id: 'HH-BECHER-MORGEN', store: 'en', fields: { metaTitle: 'Buy mug Morgen (test)', name: null } }] }), async () => {
  const en = await api('/v1/products/HH-BECHER-MORGEN?store=en') as { name: string; attributes: Record<string, unknown>; store_overrides: string[] };
  ok(en.attributes.meta_title === 'Buy mug Morgen (test)' && en.store_overrides.includes('meta_title'), 'en: eigener Meta-Title');
  ok(!en.store_overrides.includes('name') && en.name === 'Becher „Morgen“', 'en: Name erbt wieder den globalen Text');
});
await roundtrip('Kategorie (Name, Meta, aktiv) und Übersetzung', () => call('propose_category_changes', { title: 'K', reason: 'Test', changes: [{ id: '4', fields: { metaTitle: 'Küche & Tisch | Haus Holm (Test)', description: '<p>Test-Beschreibung</p>' } }] }), async () => {
  ok((await api('/v1/categories/4') as { meta_title: string }).meta_title === 'Küche & Tisch | Haus Holm (Test)', 'Kategorie-Meta-Title global geschrieben');
});
await roundtrip('Kategorie-Übersetzung en', () => call('propose_translations', { title: 'EN', reason: 'Test', entity: 'category', changes: [{ id: '4', store: 'en', fields: { description: '<p>Kitchen (test)</p>' } }] }), async () => ok((await api('/v1/categories/4?store=en') as { description: string }).description === '<p>Kitchen (test)</p>', 'en: eigene Beschreibung'));
// Store-Scope-Save in Magento 1 kopiert sonst jedes Attribut in die View: store_overrides darf nur um die geschriebenen Codes wachsen
const cat4Before = (await api('/v1/categories/4?store=default') as { store_overrides: string[] }).store_overrides;
await roundtrip('Kategorie-Übersetzung in der Haupt-View (nur der geschriebene Code wird Store-Wert)', () => call('propose_translations', { title: 'DE', reason: 'Test', entity: 'category', changes: [{ id: '4', store: 'default', fields: { name: 'Küche & Tisch (DE-Test)' } }] }), async () => {
  const de = await api('/v1/categories/4?store=default') as { name: string; store_overrides: string[] };
  ok(de.name === 'Küche & Tisch (DE-Test)' && JSON.stringify(de.store_overrides) === JSON.stringify([...cat4Before, 'name'].sort()), `default: store_overrides ${JSON.stringify(de.store_overrides)} = vorher + name`);
  ok((await api('/v1/categories/4') as { name: string }).name === 'Küche & Tisch', 'global unverändert');
});
await roundtrip('Kategorie-Zuordnung', () => call('propose_category_products', { title: 'Z', reason: 'Test', categoryId: '4', add: [{ productId: 'HH-KERZE-ABEND', position: 7 }], remove: ['HH-BECHER-MORGEN'] }), async () => {
  const k = await api('/v1/products/HH-KERZE-ABEND') as { categories: { id: number; position: number }[] }, b = await api('/v1/products/HH-BECHER-MORGEN') as { categories: { id: number }[] };
  ok(k.categories.some(c => c.id === 4 && c.position === 7) && !b.categories.some(c => c.id === 4), 'Kerze in Küche (Position 7), Becher entfernt');
});
await roundtrip('URL-Schlüssel mit 301 (Rückgängig löscht die Weiterleitung)', () => call('propose_seo_urls', { title: 'U', reason: 'Test', entity: 'product', changes: [{ id: 'HH-SCHALE-UFER', urlKey: 'schale-ufer-steinzeug-test' }] }), async () => {
  const r = await page('/schale-ufer.html');
  ok(r.status === 301 && /schale-ufer-steinzeug-test\.html/.test(r.location + r.html), `alte URL leitet weiter (${r.status})`);
  ok((await page('/schale-ufer-steinzeug-test.html')).status === 200, 'neue URL antwortet 200');
});
await roundtrip('URL-Schlüssel einer Kategorie mit 301 (Rückgängig löscht die Weiterleitungen, auch die des Zurücksetzens)', () => call('propose_seo_urls', { title: 'U', reason: 'Test', entity: 'category', changes: [{ id: '4', urlKey: 'kueche-tisch-test' }] }), async () => {
  const r = await page('/kueche-tisch.html');
  ok(r.status === 301 && /kueche-tisch-test\.html/.test(r.location + r.html), `alte Kategorie-URL leitet weiter (${r.status})`);
  ok((await page('/kueche-tisch-test.html')).status === 200, 'neue Kategorie-URL antwortet 200');
  ok(lastResult().undo?.some(u => /\/v1\/urlrewrites\/\d+$/.test(String(u.path)) && u.method === 'DELETE'), 'Rückgängig-Schritte löschen die angelegten Rewrites');
});
const lp = await call('list_products', { term: 'HH-', limit: 3 });
ok(lp.total >= 6 && lp.products.length === 3 && lp.nextOffset === 3, `list_products term: total ${lp.total} sichtbare Produkte (Name ODER SKU, eine Abfrage), Seite 1 = 3`);
const lp2 = await call('list_products', { term: 'HH-', limit: 3, offset: 3 });
ok(lp2.products.length === 3 && !lp2.products.some((p: { id: string }) => lp.products.some((q: { id: string }) => q.id === p.id)), 'Seite 2 ohne Doppelte');
const lcms = await call('list_cms_pages', { term: 'haus-holm' });
ok(lcms.items.some((p: { identifier: string }) => p.identifier === 'ueber-haus-holm'), 'list_cms_pages term findet die Seite über den identifier');
await roundtrip('Varianten: Preis, Bestand, Status eines Einzelprodukts', () => call('propose_variants', { title: 'V', reason: 'Test', productId: 'HH-KISSEN-WELLE', changes: [{ options: { Farbe: 'Anthrazit' }, price: 44.9, stock: 12, active: false }] }), async () => {
  const k = await api('/v1/products/HH-KISSEN-WELLE-ANTHRAZIT') as { price: number; status: number; stock: { qty: number } }, kd = await api('/v1/products/HH-KISSEN-WELLE-ANTHRAZIT?store=default') as { status: number };
  ok(k.price === 44.9 && kd.status === 2 && k.stock.qty === 12, 'Anthrazit: 44,90, inaktiv (Store-View), Bestand 12');
});
await roundtrip('Stapel: Kategorie 3 −20 % mit Streichpreis', () => call('propose_bulk_product_change', { title: 'S', reason: 'Test', filter: { categoryId: '3', typeId: 'simple' }, change: { price: { percent: -20, round: '.99' }, listPrice: 'currentPrice' } }), async () => {
  const p = await api('/v1/products/HH-KERZE-ABEND') as { price: number; special_price: number };
  ok(p.price === 24 && p.special_price === 18.99, `Kerze: regulär 24 als Streichpreis, Sonderpreis ${p.special_price} (19,20 auf .99 gerundet)`);
});

// ---- Bilder ----
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DwHwyBNAMDA5gGAwAAEf8L/6GwrhgAAAAASUVORK5CYII=', 'base64');
const staged = stageImage(png, 'image/png', { name: 'lotse-test', alt: 'Lotse Testbild' });
await roundtrip('Produktbilder: neues Titelbild', () => call('propose_product_images', { title: 'B', reason: 'Test', products: [{ productId: 'HH-BECHER-MORGEN', add: [{ image: staged.mediaId, cover: true, alt: 'Lotse Testbild' }] }] }), async () => {
  const imgs = await api('/v1/products/HH-BECHER-MORGEN/images') as { file: string; types: string[]; label: string }[];
  const neu = imgs.find(i => /lotse-testbild/.test(i.file));
  ok(neu && neu.types.includes('image') && neu.types.includes('thumbnail'), `neues Bild ${neu?.file} ist Titelbild`);
});
const becherImgs = await api('/v1/products/HH-BECHER-MORGEN/images') as { id: number }[];
await roundtrip('Produktbild ausblenden', () => call('propose_product_images', { title: 'B', reason: 'Test', products: [{ productId: 'HH-BECHER-MORGEN', remove: [`om-2-${becherImgs[0].id}`] }] }), async () => ok((await api('/v1/products/HH-BECHER-MORGEN/images') as { disabled: boolean }[])[0].disabled === true, 'Bild ausgeblendet'));
session.events.push({ t: 'tool', name: 'mcp__shop__view_image', input: { mediaId: `om-1-${gp.images[0].mediaId.split('-')[2]}` } } as unknown as ChatEvent);
await roundtrip('Alt-Text (Bild-Label)', () => call('propose_alt_texts', { title: 'A', reason: 'Test', images: [{ mediaId: gp.images[0].mediaId, alt: 'Vase Kiesel aus Steinzeug, matt glasiert, von vorn' }] }), async () => ok((await api('/v1/products/HH-VASE-KIESEL/images') as { label: string }[])[0].label === 'Vase Kiesel aus Steinzeug, matt glasiert, von vorn', 'Label gesetzt'));

// Store-View mit eigener Galerie-Zeile (Label je View; disabled ist in Magento 1 je Zeile ein fester Wert): Ausblenden muss auch dort greifen
await write('PATCH', '/v1/products/HH-BECHER-MORGEN/images/' + becherImgs[0].id + '?store=default', { label: 'Becher Morgen (DE)' });
const becherOver = (await api('/v1/products/HH-BECHER-MORGEN?store=default') as { store_overrides: string[] }).store_overrides;
await roundtrip('Produktbild ausblenden (View mit eigener Galerie-Zeile)', () => call('propose_product_images', { title: 'B', reason: 'Test', products: [{ productId: 'HH-BECHER-MORGEN', remove: [`om-2-${becherImgs[0].id}`] }] }), async () => {
  const de = (await api('/v1/products/HH-BECHER-MORGEN/images?store=default') as { disabled: boolean; label: string }[])[0], g = (await api('/v1/products/HH-BECHER-MORGEN/images') as { disabled: boolean }[])[0];
  ok(de.disabled === true && g.disabled === true && de.label === 'Becher Morgen (DE)', 'Bild in default und global ausgeblendet, Label der View bleibt');
  ok(JSON.stringify((await api('/v1/products/HH-BECHER-MORGEN?store=default') as { store_overrides: string[] }).store_overrides) === JSON.stringify(becherOver), 'keine neuen Store-Werte am Produkt');
});
session.events.push({ t: 'tool', name: 'mcp__shop__view_image', input: { mediaId: `om-2-${becherImgs[0].id}` } } as unknown as ChatEvent);
await roundtrip('Alt-Text in der View mit eigenem Text', () => call('propose_alt_texts', { title: 'A', reason: 'Test', images: [{ mediaId: `om-2-${becherImgs[0].id}`, alt: 'Becher Morgen aus Steinzeug' }] }), async () => {
  ok((await api('/v1/products/HH-BECHER-MORGEN/images?store=default') as { label: string }[])[0].label === 'Becher Morgen aus Steinzeug' && (await api('/v1/products/HH-BECHER-MORGEN/images') as { label: string }[])[0].label === '', 'Label in der View geändert, global leer');
  ok(JSON.stringify((await api('/v1/products/HH-BECHER-MORGEN?store=default') as { store_overrides: string[] }).store_overrides) === JSON.stringify(becherOver), 'keine neuen Store-Werte am Produkt');
});
await write('PATCH', '/v1/products/HH-BECHER-MORGEN/images/' + becherImgs[0].id + '?store=default', { label: null });

// ---- Neue Produkte, Promotionen, CMS ----
await roundtrip('Neues Produkt (inaktiv, Bestand, Kategorie, Bild)', () => call('propose_new_products', { title: 'N', reason: 'Test', products: [{ name: 'Lotse Testteller', description: '<p>Teller aus dem Live-Test.</p>', price: 12.5, sku: 'LOTSE-TEST-TELLER', stock: 3, categoryIds: ['4'], images: [staged.mediaId], metaTitle: 'Testteller' }] }), async () => {
  const p = await api('/v1/products/LOTSE-TEST-TELLER') as { status: number; price: number; stock: { qty: number }; categories: { id: number }[]; images: unknown[]; url_key: string };
  ok(p.status === 2 && p.price === 12.5 && p.stock.qty === 3 && p.categories.some(c => c.id === 4) && p.images.length === 1, `angelegt: inaktiv, 12,50, Bestand 3, Küche, 1 Bild (url_key ${p.url_key})`);
});
await roundtrip('Promotion anlegen (fester Code, Kategorie, Mindestbestellwert)', () => call('propose_promotion', { reason: 'Test', name: 'Lotse Herbst Test', active: true, validFrom: '2026-11-01', validUntil: '2026-11-30', code: { mode: 'fixed', code: 'LOTSEHERBST' }, discount: { type: 'percentage', value: 15, categoryIds: ['3'] }, minSubtotal: 50, maxUsesPerCustomer: 1 }), async r => {
  const rule = await api(`/v1/salesrules/${r.promotionId ?? (lastResult().published as { promotionId: string }).promotionId}`) as Record<string, unknown>;
  ok(rule.coupon_code === 'LOTSEHERBST' && rule.coupon_type === 2 && rule.discount_amount === 15 && rule.uses_per_customer === 1, 'Regel mit Code, 15 %, 1× pro Kunde');
  ok(JSON.stringify(rule.conditions).includes('base_subtotal') && JSON.stringify(rule.actions).includes('category_ids'), 'Bedingungsbäume gesetzt');
});
await roundtrip('Promotion ändern (nur Rabattwert und Enddatum)', () => call('propose_promotion', { id: '1', reason: 'Test', discount: { type: 'percentage', value: 12 }, validUntil: '2027-01-31' }), async () => { const r = await api('/v1/salesrules/1') as { discount_amount: number; to_date: string; coupon_code: string }; ok(r.discount_amount === 12 && String(r.to_date).startsWith('2027-01-31') && r.coupon_code === 'WILLKOMMEN10', 'Rabatt 12 %, Enddatum, Code unverändert'); });
await roundtrip('Promotion beenden', () => call('propose_promotion_status', { ids: ['1'], action: 'end' }), async () => ok((await api('/v1/salesrules/1') as { is_active: boolean }).is_active === false, 'inaktiv'));
await roundtrip('CMS-Seite ändern', () => call('propose_cms_page_changes', { title: 'Meta', reason: 'Test', changes: [{ id: 'ueber-haus-holm', fields: { metaDescription: 'Haus Holm: ruhige Dinge aus Keramik, Leinen und Licht (Live-Test).', title: 'Über Haus Holm (Test)' } }] }), async () => ok(/Über Haus Holm \(Test\)/.test((await page('/ueber-haus-holm')).html), 'Storefront zeigt den neuen Titel'));

// ---- Seiten veröffentlichen ----
const d1 = await call('draft_page', { name: 'Herbst bei Haus Holm', type: 'landingpage', seo: { keyword: 'herbst deko', metaTitle: 'Herbst-Deko aus Keramik und Leinen | Haus Holm', metaDescription: 'Ruhige Herbst-Deko von Haus Holm: Vasen, Schalen und Plaids aus natürlichen Materialien. Jetzt die Favoriten der Saison ansehen und bestellen.' },
  sections: [{ blocks: [
    { type: 'pattern', pattern: 'hero', data: { eyebrow: 'Saison', title: 'Herbst bei Haus Holm', subtitle: 'Keramik, Leinen und Licht für ruhige Abende.', ctaText: 'Zu den Wohnaccessoires', ctaHref: '/wohnaccessoires.html', variant: 'plain' } },
    { type: 'pattern', pattern: 'usp-bar', data: { items: [{ icon: 'truck', title: 'Versand ab 60 € frei' }, { icon: 'refresh', title: '30 Tage Rückgabe' }, { icon: 'leaf', title: 'Natürliche Materialien' }] } },
    { type: 'image-text', image: { mediaId: gp.images[0].mediaId, alt: 'Vase Kiesel' }, html: '<h2>Handgemacht an der Küste</h2><p>Jedes Stück wird in unserer Werkstatt gedreht.</p>' },
    { type: 'product-slider', title: 'Favoriten der Saison', productIds: ['HH-VASE-KIESEL', 'HH-PLAID-DUENE', 'HH-SCHALE-UFER'] },
    { type: 'text', html: '<h2>Herbst-Deko, die bleibt</h2><p>Unsere <a href="/kueche-tisch.html">Küche &amp; Tisch</a> Stücke passen zu jeder Jahreszeit.</p>' },
  ] }] });
ok(/Entwurf "Herbst bei Haus Holm"/.test(String(d1)), 'Landingpage-Entwurf in der Vorschau');
await roundtrip('Landingpage veröffentlichen', () => call('publish_page', { target: 'landingpage', url: 'lotse-test/herbst' }), async r => {
  const lp = await page('/lotse-test/herbst');
  ok(lp.status === 200, `Storefront /lotse-test/herbst antwortet 200 (${r.storefront})`);
  ok(/<title>Herbst-Deko aus Keramik und Leinen\s+\| Haus Holm/.test(lp.html), 'Browser-Titel = Meta-Title (Theme hängt das Suffix selbst an, mit eigenem Leerzeichen)');
  ok(/Herbst bei Haus Holm<\/h1>/.test(lp.html) && !/<div class="page-title">/.test(lp.html), 'genau eine H1 aus dem Inhalt, keine Theme-Überschrift');
  ok(/Vase/.test(lp.html) && /49,00/.test(lp.html) && /Plaid/.test(lp.html), 'Produktboxen mit Namen und Preisen');
  ok(/media\/catalog\/product\/v\/a\/vase-kiesel\.jpg/.test(lp.html), 'Produktbild eingebunden');
  ok(!/\{\{/.test(lp.html.replace(/\{\{[^}]*\}\}/g, m => (m.includes('block') ? '' : m))), 'keine unverarbeiteten Direktiven');
  save('landingpage.html', lp.html);
});
ok((await page('/lotse-test/herbst')).status === 404, 'nach Rückgängig: Seite weg (404)');

await call('draft_page', { name: 'Wohnaccessoires Intro', type: 'product_list', previewCategoryId: '3', sections: [{ blocks: [
  { type: 'pattern', pattern: 'usp-bar', data: { items: [{ icon: 'leaf', title: 'Natürliche Materialien' }, { icon: 'award', title: 'Handgemacht in kleinen Serien' }] } },
  { type: 'text', html: '<h1>Ruhige Dinge für jeden Raum</h1><p>Vasen, Schalen und Kerzen aus Steinzeug und Wachs.</p>' },
] }] });
await roundtrip('Kategorie-Inhalt veröffentlichen', () => call('publish_page', { target: 'category', categoryId: '3', metaDescription: 'Wohnaccessoires von Haus Holm: Vasen, Schalen und Kerzen aus Steinzeug und Rapswachs, handgemacht an der Nordseeküste.' }), async () => {
  const cp = await page('/wohnaccessoires.html');
  ok(cp.status === 200 && /Ruhige Dinge für jeden Raum/.test(cp.html), 'Kategorieseite zeigt den Block');
  ok(/<h2[^>]*>Ruhige Dinge für jeden Raum<\/h2>/.test(cp.html) && /<h1>Wohnaccessoires<\/h1>/.test(cp.html), 'H1 bleibt der Kategoriename, Inhalt als H2');
  ok(/product-name|products-grid|category-products/.test(cp.html), 'Produktliste weiter sichtbar');
  ok(/Wohnaccessoires von Haus Holm: Vasen, Schalen/.test(cp.html), 'Meta-Description der Kategorie gesetzt');
  save('kategorie.html', cp.html);
});
ok(!/Ruhige Dinge für jeden Raum/.test((await page('/wohnaccessoires.html')).html), 'nach Rückgängig: Block nicht mehr auf der Kategorieseite');

// Haupt-View mit eigenem Anzeigemodus: display_mode wird in der View geschrieben, landing_page global; Rückgängig darf keinen Store-Wert zurücklassen
await write('PATCH', '/v1/categories/5?store=default', { attributes: { display_mode: 'PRODUCTS' } });
const cat5Over = (await api('/v1/categories/5?store=default') as { store_overrides: string[] }).store_overrides;
ok(cat5Over.includes('display_mode'), `Vorbereitung: Kategorie 5 hat in default einen eigenen display_mode (${cat5Over.join(', ')})`);
await call('draft_page', { name: 'Kerzen Intro', type: 'product_list', previewCategoryId: '5', sections: [{ blocks: [{ type: 'text', html: '<h1>Licht für ruhige Abende</h1><p>Kerzen aus Rapswachs.</p>' }] }] });
await roundtrip('Kategorie-Inhalt veröffentlichen (View mit eigenem Anzeigemodus)', () => call('publish_page', { target: 'category', categoryId: '5' }), async () => {
  const de = await api('/v1/categories/5?store=default') as { display_mode: string; landing_page: number | null; store_overrides: string[] }, g = await api('/v1/categories/5') as { landing_page: number | null };
  ok(de.display_mode === 'PRODUCTS_AND_PAGE' && de.landing_page != null && de.landing_page === g.landing_page, `default zeigt Block ${de.landing_page} mit PRODUCTS_AND_PAGE, landing_page global`);
  ok(JSON.stringify(de.store_overrides) === JSON.stringify(cat5Over), `store_overrides unverändert (${de.store_overrides.join(', ')})`);
});
ok((await api('/v1/categories/5?store=default') as { landing_page: number | null }).landing_page === null, 'nach Rückgängig: kein landing_page in der View (keine verwaiste Block-ID)');
await write('PATCH', '/v1/categories/5?store=default', { attributes: { display_mode: null } });

await call('draft_page', { name: 'Vase Pflege', type: 'product_detail', previewProductId: '1', sections: [{ blocks: [
  { type: 'text', html: '<h2>Pflege</h2><p>Mit einem feuchten Tuch abwischen. Nicht spülmaschinenfest.</p>' },
  { type: 'pattern', pattern: 'faq', data: { title: 'Fragen zur Vase', items: [{ q: 'Ist die Vase wasserdicht?', a: 'Ja, innen glasiert.' }, { q: 'Wie hoch ist sie?', a: '24 cm.' }] } },
] }] });
await roundtrip('Produktbeschreibung veröffentlichen', () => call('publish_page', { target: 'product', productIds: ['HH-VASE-KIESEL'] }), async () => {
  const pp = await page('/vase-kiesel.html');
  ok(/Mit einem feuchten Tuch abwischen/.test(pp.html) && /FAQPage/.test(pp.html), 'Produktseite zeigt den neuen Inhalt mit FAQ-Schema');
  save('produkt.html', pp.html);
});
await roundtrip('Produktinhalt unter zwei Beschreibungen angehängt', () => call('publish_page', { target: 'product', productIds: ['HH-VASE-KIESEL', 'HH-BECHER-MORGEN'] }), async () => {
  for (const p of ['/vase-kiesel.html', '/becher-morgen.html']) { const h = (await page(p)).html; ok(/Mit einem feuchten Tuch abwischen/.test(h) && !/\{\{block/.test(h), `${p} zeigt den angehängten Inhalt (keine Direktive im HTML)`); }
  ok(/rund geschliffenen Steinen/.test((await page('/vase-kiesel.html')).html), 'bisherige Beschreibung bleibt erhalten');
});

// ---- Import ----
const csv = 'SKU;Name;Preis;UVP;Bestand;Beschreibung;Kategorie\nHH-BECHER-MORGEN;Becher „Morgen“ (Import);;;;;\nLOTSE-IMP-1;Lotse Importschale;29,90;39,90;5;Schale aus dem Import;Küche & Tisch\n';
const f = saveFile(Buffer.from(csv), 'lotse-live.csv');
const mapping = { productNumber: 'SKU', name: 'Name', priceGross: 'Preis', listPrice: 'UVP', stock: 'Bestand', description: 'Beschreibung', category: 'Kategorie' };
const prev = await call('preview_import', { fileId: f.fileId, mapping });
ok(prev.stats.create === 1 && prev.stats.update === 1, `preview_import: ${prev.stats.create} neu, ${prev.stats.update} aktualisieren`);
await roundtrip('Lieferanten-Import', () => call('propose_import', { fileId: f.fileId, title: 'Import', reason: 'Live', mapping }), async () => {
  const n = await api('/v1/products/LOTSE-IMP-1') as { status: number; price: number; special_price: number; stock: { qty: number }; categories: { id: number }[] };
  // Shop rechnet netto, die Datei brutto: 39,90 / 1,19 = 33,5294 (Streichpreis), 29,90 / 1,19 = 25,1261 (Verkaufspreis)
  ok(n.status === 2 && Math.abs(n.price - 39.9 / 1.19) < 0.001 && Math.abs(n.special_price - 29.9 / 1.19) < 0.001 && n.stock.qty === 5 && n.categories.some(c => c.id === 4), `neues Produkt als Entwurf, Preise netto (${n.price} / ${n.special_price}), Bestand, Kategorie`);
  ok((await api('/v1/products/HH-BECHER-MORGEN') as { name: string }).name === 'Becher „Morgen“ (Import)', 'vorhandenes Produkt: Name aktualisiert');
});

// ---- Shop-Check ----
await openmage.loadChecks();
const ro = openmageReaderFor('openmage-live-check');
const run = await runChecks(ro as never, listChecks('openmage').filter(c => c.id.startsWith('openmage.')), { perRun: false, ctx: r => ({ platform: 'openmage', reader: r, lookup: openmage.lookup(r) }) });
ok(run.errors.length === 0, `Shop-Check ohne Fehler (${run.checks} Prüfungen, ${run.findings.length} Befunde)`);
for (const x of run.findings) log(`   [${x.severity}] ${x.title}: ${x.count}${x.total ? ` von ${x.total}` : ''}`);

ok((await state()) === start, 'Gesamter Shop-Zustand am Ende = Anfang');
log(`\nLIVE OK: ${checks} Prüfungen`);
process.exit(0);
