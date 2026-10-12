// Live-Prüfung der Shopify-Seiten: veröffentlicht über die echten Lotse-Werkzeuge (draft_page → publish_page → Freigabe)
// eine Landingpage, eine Kollektionsvorlage und eine Produktvorlage, liest Theme-Dateien, Zuordnungen und (falls erreichbar)
// die Storefront, nimmt alles mit Rückgängig zurück und vergleicht den Ausgangszustand.
//
//   Lokal gegen den Fake (Standard, startet ihn selbst):
//     npx tsx --conditions=react-server test-support/shopify-live/verify-pages.ts
//   Gegen einen Entwicklungs-Shop (eigene Testdaten!):
//     SHOPIFY_STORE_DOMAIN=mein-dev.myshopify.com SHOPIFY_ACCESS_TOKEN=shpat_… LOTSE_COLLECTION=<id> LOTSE_PRODUCTS=<id>,<id> \
//       npx tsx --conditions=react-server test-support/shopify-live/verify-pages.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatEvent } from '@/lib/protocol';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-verify-pages-'));
const realShop = !!process.env.SHOPIFY_STORE_DOMAIN;
const fake = realShop ? null : await (await import('../shopify-fake/server')).startFakeShopify({ port: 0 });
const { updateSettings } = await import('../../src/server/settings');
const { getSession, decideChange } = await import('../../src/server/sessions');
const { buildTools } = await import('../../src/server/tools');
const { getPlatform, reconfigureAll } = await import('../../src/server/platform/index');
const { shopifyClient } = await import('../../src/server/platform/shopify/index');
const { mainTheme, readThemeFiles } = await import('../../src/server/platform/shopify/theme');

const domain = realShop ? process.env.SHOPIFY_STORE_DOMAIN! : fake!.url;
updateSettings({ platform: 'shopify', shopify: { storeDomain: domain, accessToken: process.env.SHOPIFY_ACCESS_TOKEN ?? fake!.token, apiVersion: process.env.SHOPIFY_API_VERSION ?? '' } });
reconfigureAll();
const shopify = getPlatform('shopify'), client = shopifyClient();
const COLLECTION = process.env.LOTSE_COLLECTION ?? '480000000001', PRODUCTS = (process.env.LOTSE_PRODUCTS ?? '9100000000001,9100000000002').split(',');

const events: ChatEvent[] = [], session = getSession('verify-pages');
session.emit = ev => { events.push(ev); session.events.push(ev); if (ev.t === 'changeset') setTimeout(() => decideChange(session.id, ev.approvalId, true), 0); };
const tools = buildTools(session);
const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await tools.find(t => t.name === name)!.handler(args, {})) as { isError?: boolean; content: { text: string }[] };
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r.content[0].text;
};
const lastResult = () => [...events].reverse().find((e): e is Extract<ChatEvent, { t: 'changeset_result' }> => e.t === 'changeset_result')!;
const log = (...a: unknown[]) => console.log(...a);
const ok = (cond: unknown, msg: string) => { if (!cond) throw new Error(`PRÜFUNG FEHLGESCHLAGEN: ${msg}`); log(`  ✓ ${msg}`); };

/** Zustand für den Vergleich: Fake = kompletter Speicher (ohne Zeitstempel), echter Shop = betroffene Datensätze + Theme-Dateien */
async function state(): Promise<string> {
  if (fake) {
    const s = JSON.parse(JSON.stringify(fake.state.snapshot()));
    const strip = (x: unknown): unknown => Array.isArray(x) ? x.map(strip) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([k]) => !['updatedAt', 'createdInRequest'].includes(k)).map(([k, v]) => [k, strip(v)])) : x;
    delete s.requestCount; delete s.stagedUploads; delete s.bulkOperations;
    return JSON.stringify(strip(s));
  }
  const t = await mainTheme(client), files = await readThemeFiles(client, t.id, ['templates/*.json', 'sections/lotse-content.liquid']);
  const c = await client.gql(`query S($c: ID!, $p: [ID!]!) { collection(id: $c) { templateSuffix descriptionHtml seo { title description } } nodes(ids: $p) { ... on Product { id templateSuffix } } shop { metafields(namespace: "lotse", first: 50) { nodes { key value } } } pages(first: 50, query: "handle:lotse-pruefung*") { nodes { id } } }`,
    { c: `gid://shopify/Collection/${COLLECTION}`, p: PRODUCTS.map(p => `gid://shopify/Product/${p}`) });
  return JSON.stringify({ files: [...files.entries()].sort(), c });
}

async function storefront(url: string) {
  if (fake) return log(`  Storefront (Fake rendert kein Liquid): ${url}`);
  try { const r = await fetch(url); const html = await r.text(); ok(r.ok && html.includes('lotse-content'), `Storefront ${url} zeigt den Lotse-Inhalt`); }
  catch (e) { log(`  Storefront nicht abrufbar (${String(e)}), z. B. Passwortschutz des Entwicklungs-Shops`); }
}

const before = await state();
const undos: { name: string; ops: NonNullable<ReturnType<typeof lastResult>['undo']> }[] = [];
try {
  const theme = await mainTheme(client);
  log(`Theme: ${theme.name} (${theme.id})`);

  log('\n1) Landingpage');
  await call('draft_page', { name: 'Lotse Prüfung Ratgeber', type: 'landingpage', seo: { keyword: 'vasen', metaTitle: 'Vasen kombinieren: kleiner Ratgeber | Lotse-Prüfung', metaDescription: 'Testseite von Lotse: Formen, Höhen und Materialien von Vasen im Überblick, mit echten Produkten aus dem Shop. Wird nach der Prüfung wieder entfernt.' },
    sections: [{ blocks: [{ type: 'text-hero', html: '<h1>Vasen richtig kombinieren</h1><p>Prüfseite von Lotse.</p>' }, { type: 'product-slider', title: 'Aus dem Shop', productIds: PRODUCTS }, { type: 'pattern', pattern: 'faq', data: { title: 'Fragen', items: [{ q: 'Bleibt die Seite?', a: 'Nein, sie wird gleich zurückgenommen.' }, { q: 'Was wird geprüft?', a: 'Seite, Vorlage und Inhalt.' }] } }] }] });
  log('  ' + (await call('publish_page', { target: 'landingpage', url: 'lotse-pruefung-ratgeber', published: false })).slice(0, 120));
  let res = lastResult(); ok(res.status === 'applied', 'Landingpage veröffentlicht'); undos.push({ name: 'Landingpage', ops: res.undo! });
  const page = (await client.gql<{ pages: { nodes: { handle: string; templateSuffix: string | null; body: string }[] } }>('query { pages(first: 5, query: "handle:lotse-pruefung-ratgeber") { nodes { handle templateSuffix body } } }')).pages.nodes[0];
  ok(page?.templateSuffix === 'lotse-lotse-pruefung-ratgeber' || page?.templateSuffix === null, `Seite /pages/${page?.handle} mit Vorlage ${page?.templateSuffix ?? '(Standard, kein Theme-Schreibrecht)'}`);
  ok(/Vasen richtig kombinieren/.test(page.body) && /\/products\//.test(page.body), 'Seiteninhalt mit Überschrift und Produktlinks');
  const files1 = await readThemeFiles(client, theme.id, ['templates/page.lotse-lotse-pruefung-ratgeber.json', 'sections/lotse-content.liquid']);
  if (page.templateSuffix) ok(files1.size === 2, 'Theme: Seitenvorlage + Abschnitt lotse-content angelegt');
  await storefront(String((res.published as { storefront?: string })?.storefront));

  log('\n2) Kollektionsvorlage');
  await call('draft_page', { name: 'Lotse Prüfung Kollektion', type: 'product_list', previewCategoryId: COLLECTION, sections: [{ blocks: [{ type: 'text', html: '<p>Einstieg über der Produktliste (Prüfung).</p>' }, { type: 'theme-main' }, { type: 'text', html: '<h2>Ratgeber unter der Produktliste</h2><p>Prüftext.</p>' }] }] });
  await call('publish_page', { target: 'category', categoryId: COLLECTION });
  res = lastResult();
  if (res.status !== 'applied' && /Theme/.test(JSON.stringify(res))) {
    log('  Kein Theme-Schreibrecht: Kollektion als Beschreibung'); await call('publish_page', { target: 'category', categoryId: COLLECTION, mode: 'description' }); res = lastResult();
  }
  ok(res.status === 'applied', 'Kollektion veröffentlicht'); undos.push({ name: 'Kollektion', ops: res.undo! });
  const tplName = String((res.published as { template?: string })?.template ?? '');
  if (tplName) {
    const tpl = JSON.parse((await readThemeFiles(client, theme.id, [tplName])).get(tplName)!);
    log(`  Vorlage ${tplName}: ${tpl.order.map((k: string) => `${k}(${tpl.sections[k].type})`).join(' → ')}`);
    ok(tpl.order.includes('lotse_before') && tpl.order.includes('lotse_after'), 'Lotse-Abschnitte vor und nach dem Hauptabschnitt');
  }
  await storefront(String((res.published as { storefront?: string })?.storefront));

  log('\n3) Produktvorlage');
  await call('draft_page', { name: 'Lotse Prüfung', type: 'product_detail', previewProductId: PRODUCTS[0], sections: [{ blocks: [{ type: 'theme-main' }, { type: 'pattern', pattern: 'usp-bar', data: { items: [{ title: 'Prüfung', text: 'Vorlage von Lotse' }, { title: 'Rückgängig', text: 'wird entfernt' }, { title: 'Theme', text: 'bleibt unverändert' }] } }] }] });
  await call('publish_page', { target: 'product', productIds: PRODUCTS, layout: 'lotse-pruefung' });
  res = lastResult();
  if (res.status === 'applied') {
    undos.push({ name: 'Produkte', ops: res.undo! });
    const tpl = 'templates/product.lotse-lotse-pruefung.json', t = JSON.parse((await readThemeFiles(client, theme.id, [tpl])).get(tpl)!);
    log(`  Vorlage ${tpl}: ${t.order.map((k: string) => `${k}(${t.sections[k].type})`).join(' → ')}`);
    ok(t.order.includes('lotse_after'), 'Lotse-Abschnitt nach dem Produktbereich');
    for (const u of [(res.published as { storefront?: string[] })?.storefront ?? []].flat()) await storefront(u);
  } else log(`  Produktvorlage nicht möglich: ${res.error ?? JSON.stringify(res.results)}`);
} finally {
  log('\n4) Rückgängig (umgekehrte Reihenfolge)');
  for (const u of undos.reverse()) { const r = await shopify.undo(u.ops); ok(r.every(x => x.ok), `${u.name}: ${r.length} Schritte zurückgenommen${r.some(x => !x.ok) ? ` ${JSON.stringify(r)}` : ''}`); }
  ok((await state()) === before, 'Ausgangszustand exakt wiederhergestellt (Theme-Dateien, Seiten, Kollektion, Produkte, Metafelder, Dateien)');
  await fake?.close();
}
log('\nAlles geprüft.');
process.exit(0);
