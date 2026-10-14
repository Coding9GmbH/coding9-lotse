import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-bilder-'));
const { planImages, imagesUndo, imagesSummary, checkAlt, altIsFileName, viewedImages, buildProductImagesChangeSet, buildAltTextChangeSet, mergeProductOps, applyImages, resolverFor, INHERIT_WARN, KIND_IMAGES, KIND_ALT } = await import('../../../src/server/features/product-images');
type Reader = Parameters<typeof buildProductImagesChangeSet>[0];

const H = (c: string) => c.repeat(32);
const cur = [{ id: 'pm2', mediaId: H('b'), position: 1 }, { id: 'pm1', mediaId: H('a'), position: 0 }, { id: 'pm3', mediaId: H('c'), position: 2 }];
const seq = () => { let n = 0; return () => `new${++n}`; };

test('planImages: adding appends at the end, cover image stays', () => {
  const p = planImages(cur, 'pm1', { add: [{ image: H('d') }] }, seq());
  assert.deepEqual(p.entries.map(e => e.id), ['pm1', 'pm2', 'pm3', 'new1']);
  assert.equal(p.coverId, 'pm1'); assert.ok(p.changed); assert.deepEqual(p.errors, []);
});

test('planImages: removing the cover image → first remaining image becomes cover', () => {
  const p = planImages(cur, 'pm1', { remove: [H('a')] }, seq());
  assert.deepEqual(p.entries.map(e => e.id), ['pm2', 'pm3']);
  assert.equal(p.coverId, 'pm2'); assert.deepEqual(p.removed, [{ id: 'pm1', mediaId: H('a'), position: 0 }]);
});

test('planImages: new image in front as cover, order and errors', () => {
  const p = planImages(cur, 'pm1', { add: [{ image: 'staged:abc', position: 0, cover: true }, { image: H('a') }], order: ['pm3', 'gibtsnicht'] }, seq());
  assert.deepEqual(p.entries.map(e => e.id), ['pm3', 'new1', 'pm1', 'pm2']);
  assert.equal(p.coverId, 'new1');
  assert.equal(p.errors.length, 2);
  assert.match(p.errors[0], /schon am Produkt/); assert.match(p.errors[1], /Reihenfolge/);
});

test('planImages: set cover by mediaId; no change → changed=false', () => {
  assert.equal(planImages(cur, 'pm1', { cover: H('c') }).coverId, 'pm3');
  assert.equal(planImages(cur, 'pm1', {}).changed, false);
  assert.equal(planImages(cur, 'pm1', { remove: ['x'] }).errors.length, 1);
  assert.equal(planImages([], null, { add: [{ image: H('a') }] }, seq()).coverId, 'new1');
});

test('imagesUndo: delete new ones, restore positions/cover, recreate removed ones at the same position', () => {
  const p = planImages(cur, 'pm1', { add: [{ image: H('d'), cover: true }], remove: ['pm2'] }, seq());
  const undo = imagesUndo('prod', { coverId: 'pm1', media: cur }, { productId: 'prod', snapshot: [], entries: p.entries, removed: p.removed, coverId: p.coverId });
  assert.deepEqual(undo, [
    { op: 'delete', entity: 'product-media', id: 'new1' },
    { op: 'patch', entity: 'product', id: 'prod', data: { coverId: 'pm1', media: [{ id: 'pm1', position: 0 }, { id: 'pm3', position: 2 }] } },
    { op: 'create', entity: 'product-media', id: 'pm2', data: { productId: 'prod', mediaId: H('b'), position: 1 } },
  ]);
});

test('imagesSummary', () => {
  assert.equal(imagesSummary(['a.jpg', 'b.jpg', 'c.jpg'], 'a.jpg'), '3 Bilder, Titelbild: a.jpg');
  assert.equal(imagesSummary(['a.jpg'], 'a.jpg'), '1 Bild, Titelbild: a.jpg');
  assert.equal(imagesSummary([], null), 'keine Bilder');
});

test('checkAlt: length, "Bild von", empty', () => {
  assert.deepEqual(checkAlt(' Bauchige Vase aus <b>Steinzeug</b> '), { alt: 'Bauchige Vase aus Steinzeug', warn: [] });
  assert.match(checkAlt('x'.repeat(130)).warn[0], /130 Zeichen/);
  assert.throws(() => checkAlt('Bild von einer Vase'), /Bild von/);
  assert.throws(() => checkAlt('Foto einer Vase'), /Bild von/);
  assert.throws(() => checkAlt('  '), /leer/);
  assert.throws(() => checkAlt('x'.repeat(256)), /255/);
});

test('altIsFileName detects upload file names', () => {
  assert.ok(altIsFileName('IMG_1234', 'IMG_1234-ab12c'));
  assert.ok(altIsFileName('vase.jpg', 'x'));
  assert.ok(altIsFileName('upload', 'upload-abcde'));
  assert.ok(!altIsFileName('Bauchige Vase', 'vase'));
  assert.ok(!altIsFileName(null, 'vase'));
  assert.ok(altIsFileName('Vase_Kiesel_front', 'vase-kiesel-front-k3x9a'), 'chat upload with random suffix');
  assert.ok(!altIsFileName('Vase aus Steinzeug', 'vase-kiesel-front-k3x9a'));
});

test('planImages: merely different position values (1 instead of 0) are not a change', () => {
  const one = [{ id: 'pm1', mediaId: H('a'), position: 1 }];
  assert.equal(planImages(one, 'pm1', { cover: H('a') }).changed, false);
  assert.equal(planImages([{ id: 'x', mediaId: H('a'), position: 3 }, { id: 'y', mediaId: H('b'), position: 5 }], 'x', { order: ['x'] }).changed, false);
  assert.equal(planImages(cur, 'pm1', { order: [H('c')] }).changed, true);
});

test('mergeProductOps: duplicate products are merged', () => {
  const m = mergeProductOps([{ productId: 'p1', add: [{ image: 'a' }] }, { productId: 'p2', cover: 'x' }, { productId: 'p1', add: [{ image: 'b' }], remove: ['r'], cover: 'c' }]);
  assert.equal(m.length, 2);
  assert.deepEqual(m[0], { productId: 'p1', add: [{ image: 'a' }, { image: 'b' }], remove: ['r'], order: undefined, cover: 'c' });
});

test('viewedImages: mediaIds and URL paths from view_image calls', () => {
  const v = viewedImages([
    { t: 'tool', id: '1', name: 'view_image', input: { mediaId: H('a') } },
    { t: 'tool', id: '2', name: 'mcp__shop__view_image', input: { url: 'http://shop.test/media/x/y.jpg?ts=1' } },
    { t: 'tool', id: '3', name: 'search_media', input: { mediaId: H('b') } },
  ]);
  assert.ok(v.has(H('a'))); assert.ok(v.has('/media/x/y.jpg')); assert.ok(!v.has(H('b')));
});

const media: Record<string, Record<string, unknown>> = {
  [H('a')]: { id: H('a'), fileName: 'vase', fileExtension: 'jpg', mimeType: 'image/jpeg', url: 'http://shop.test/media/vase.jpg', alt: null, title: null },
  [H('b')]: { id: H('b'), fileName: 'szene', fileExtension: 'jpg', mimeType: 'image/jpeg', url: 'http://shop.test/media/szene.jpg', alt: 'Alt', title: 'KI-generiert: Szene' },
  [H('d')]: { id: H('d'), fileName: 'neu', fileExtension: 'png', mimeType: 'image/png', url: 'http://shop.test/media/neu.png', alt: null, title: null },
  [H('e')]: { id: H('e'), fileName: 'doc', fileExtension: 'pdf', mimeType: 'application/pdf', url: 'http://shop.test/media/doc.pdf' },
};
const products = [
  { id: 'p1', productNumber: 'HH-1', name: 'Vase', coverId: 'pm1', media: [{ id: 'pm1', mediaId: H('a'), position: 0, media: media[H('a')] }, { id: 'pm2', mediaId: H('b'), position: 1, media: media[H('b')] }] },
  { id: 'p2', productNumber: 'HH-2', name: 'Becher', coverId: 'pm9', media: [{ id: 'pm9', mediaId: H('b'), position: 0, media: media[H('b')] }] },
  { id: 'v1', productNumber: 'HH-1.1', name: null, parentId: 'p1', coverId: null, media: [] },
];
let langs = 1;
const ro = { search: async (entity: string, c: { ids?: string[] }) => entity === 'language' ? { data: [], total: langs } : ({ data: entity === 'media' ? (c.ids ?? []).map(id => media[id]).filter(Boolean) : entity === 'product' ? (c.ids ? products.filter(p => c.ids!.includes(p.id)) : products) : [] }) } as unknown as Reader;

test('Image change set: before/after, preview images, skipped entries', async () => {
  const cs = await buildProductImagesChangeSet(ro, { title: 'Fotos', reason: 'Upload', products: [
    { productId: 'p1', add: [{ image: H('d'), cover: true }, { image: H('e') }, { image: 'staged:fehlt' }] },
    { productId: 'p2', add: [{ image: H('d') }] },
    { productId: 'p3', add: [{ image: H('d') }] },
  ] }, seq());
  assert.equal(cs.kind, KIND_IMAGES); assert.equal(cs.items.length, 2);
  assert.equal(cs.items[0].before, '2 Bilder, Titelbild: vase.jpg');
  assert.equal(cs.items[0].after, '3 Bilder, Titelbild: neu.png');
  assert.equal(cs.items[1].after, '2 Bilder, Titelbild: szene.jpg');
  assert.match(cs.items[1].warn.join(), /KI-generiert/);
  assert.equal(cs.assets?.length, 1); assert.match(cs.assets![0].note, /neu bei HH-1 \(Titelbild\) · neu bei HH-2/);
  assert.equal(cs.skipped.length, 3);
  const pl = cs.items[0].afterRaw as { snapshot: string[]; snapshotCover: string | null; coverId: string };
  assert.deepEqual(pl.snapshot, ['pm1', 'pm2']); assert.equal(pl.snapshotCover, 'pm1'); assert.equal(pl.coverId, 'new1');
});

test('Image change set: nothing to do → error', async () => {
  await assert.rejects(buildProductImagesChangeSet(ro, { title: 't', reason: 'r', products: [{ productId: 'p1', cover: 'pm1' }] }), /Keine Bildänderung/);
});

test('Alt text change set: only viewed images, AI label in the title stays', async () => {
  const cs = await buildAltTextChangeSet(ro, { title: 'Alt-Texte', reason: 'SEO', images: [
    { mediaId: H('a'), alt: 'Bauchige Vase aus mattem Steinzeug' },
    { mediaId: H('b'), alt: 'Wohnszene mit Vase und Becher auf Sideboard', title: 'Wohnszene Sideboard' },
    { mediaId: H('d'), alt: 'Becher' },
  ] }, new Set([H('a'), '/media/szene.jpg']));
  assert.equal(cs.kind, KIND_ALT);
  assert.deepEqual(cs.items.map(i => [i.entityId, i.field, i.after]), [
    [H('a'), 'alt', 'Bauchige Vase aus mattem Steinzeug'],
    [H('b'), 'alt', 'Wohnszene mit Vase und Becher auf Sideboard'],
    [H('b'), 'title', 'KI-generiert: Wohnszene Sideboard'],
  ]);
  assert.match(cs.items[1].warn.join(), /2 Produkten/);
  assert.match(cs.skipped[0].reason, /nicht angesehen/);
});

test('Variant with inherited images: before shows the parent product gallery, warning', async () => {
  const cs = await buildProductImagesChangeSet(ro, { title: 't', reason: 'r', products: [{ productId: 'v1', add: [{ image: H('d') }] }] }, seq());
  const it = cs.items[0];
  assert.equal(it.label, 'Vase (HH-1.1)');
  assert.equal(it.before, '2 Bilder (geerbt vom Hauptprodukt), Titelbild: vase.jpg');
  assert.equal(it.after, '1 Bild, Titelbild: neu.png');
  assert.ok(it.warn.includes(INHERIT_WARN));
  assert.deepEqual((it.afterRaw as { snapshot: string[] }).snapshot, []);
  await assert.rejects(buildProductImagesChangeSet(ro, { title: 't', reason: 'r', products: [{ productId: 'v1', remove: [H('a')] }] }), /vom Hauptprodukt geerbt/);
});

test('Product named twice → one entry', async () => {
  const cs = await buildProductImagesChangeSet(ro, { title: 't', reason: 'r', products: [{ productId: 'p2', add: [{ image: H('d') }] }, { productId: 'p2', add: [{ image: H('a') }] }] }, seq());
  assert.equal(cs.items.length, 1); assert.equal(cs.items[0].after, '3 Bilder, Titelbild: szene.jpg');
});

test('Alt text: AI label only in alt → moves to the title; notice about other languages', async () => {
  media[H('f')] = { id: H('f'), fileName: 'motiv', fileExtension: 'png', mimeType: 'image/png', url: 'http://shop.test/media/motiv.png', alt: 'KI-generiert: Motiv', title: null };
  langs = 3;
  try {
    const cs = await buildAltTextChangeSet(ro, { title: 't', reason: 'r', images: [{ mediaId: H('f'), alt: 'Blaue Vase auf Holztisch' }] }, null);
    assert.deepEqual(cs.items.map(i => [i.field, i.after]), [['alt', 'Blaue Vase auf Holztisch'], ['title', 'KI-generiert: Blaue Vase auf Holztisch']]);
    assert.match(cs.items[0].warn.join(), /2 weitere Sprachen/);
  } finally { langs = 1; delete media[H('f')]; }
});

// ---- Executor applyImages with fake writer ----
type Writer = Parameters<typeof applyImages>[0];
const fakeWriter = (product: Record<string, unknown> | null, o: { failDelete?: boolean } = {}) => {
  const calls: unknown[][] = [];
  const w = {
    calls, get: async () => product,
    update: async (...a: unknown[]) => { calls.push(['update', ...a]); }, create: async (...a: unknown[]) => { calls.push(['create', ...a]); },
    req: async (m: string, p: string) => { calls.push(['req', m, p]); if (o.failDelete && m === 'DELETE') throw new Error('kaputt'); },
    search: async () => ({ data: [] }),
  };
  return w as unknown as Writer & { calls: unknown[][] };
};
const curProduct = () => ({ id: 'p1', coverId: 'pm1', media: [{ id: 'pm1', mediaId: H('a'), position: 0 }, { id: 'pm2', mediaId: H('b'), position: 1 }] });
const payloadFor = (ops: Parameters<typeof planImages>[2], cover = 'pm1') => { const p = planImages(cur.filter(m => m.id !== 'pm3'), 'pm1', ops, seq()); return { productId: 'p1', snapshot: ['pm1', 'pm2'], snapshotCover: cover, entries: p.entries, removed: p.removed, coverId: p.coverId }; };
const noResolve = async () => { throw new Error('nie'); };

test('applyImages: state changed (assignments or cover) → abort without writing', async () => {
  const w1 = fakeWriter({ ...curProduct(), media: [{ id: 'pm1', mediaId: H('a'), position: 0 }] });
  await assert.rejects(applyImages(w1, payloadFor({ add: [{ image: H('d') }] }), noResolve), /inzwischen geändert/);
  const w2 = fakeWriter({ ...curProduct(), coverId: 'pm2' }); // admin only changed the cover image
  await assert.rejects(applyImages(w2, payloadFor({ add: [{ image: H('d') }] }), noResolve), /inzwischen geändert/);
  assert.deepEqual(w1.calls, []); assert.deepEqual(w2.calls, []);
  // old sets without snapshotCover (created before this check) still work
  const w3 = fakeWriter({ ...curProduct(), coverId: 'pm2' }), old = { ...payloadFor({ cover: H('b') }), snapshotCover: undefined };
  assert.equal((await applyImages(w3, old, noResolve)).length, 1); assert.equal(w3.calls.length, 1);
});

test('applyImages: upload error → product unchanged; error while removing → original state restored via undo', async () => {
  const w = fakeWriter(curProduct());
  await assert.rejects(applyImages(w, payloadFor({ add: [{ image: 'staged:x' }] }), async () => { throw new Error('Upload kaputt'); }), /Upload kaputt\. Produkt unverändert/);
  assert.deepEqual(w.calls, []);
  const f = fakeWriter(curProduct(), { failDelete: true });
  await assert.rejects(applyImages(f, payloadFor({ add: [{ image: 'staged:x' }], remove: ['pm2'] }), async () => H('d')), /kaputt/);
  assert.deepEqual(f.calls, [
    ['update', 'product', 'p1', { coverId: 'pm1', media: [{ id: 'pm1', position: 0 }, { id: 'new1', mediaId: H('d'), position: 1 }] }],
    ['req', 'DELETE', '/product-media/pm2'],
    ['create', 'product-media', { id: 'pm2', productId: 'p1', mediaId: H('b'), position: 1 }], // undo backwards: recreate the removed assignment …
    ['update', 'product', 'p1', { coverId: 'pm1', media: [{ id: 'pm1', position: 0 }] }], // … restore positions/cover image …
    ['req', 'DELETE', '/product-media/new1'], // … delete the new assignment
  ]);
});

test('applyImages: success returns exact undo steps; resolver loads each image reference only once per set', async () => {
  const w = fakeWriter(curProduct());
  const undo = await applyImages(w, payloadFor({ add: [{ image: H('d'), cover: true }], remove: [H('b')] }), async () => H('d'));
  assert.deepEqual(w.calls.map(c => c[0]), ['update', 'req']);
  assert.deepEqual(undo, [
    { op: 'delete', entity: 'product-media', id: 'new1' },
    { op: 'patch', entity: 'product', id: 'p1', data: { coverId: 'pm1', media: [{ id: 'pm1', position: 0 }] } },
    { op: 'create', entity: 'product-media', id: 'pm2', data: { productId: 'p1', mediaId: H('b'), position: 1 } },
  ]);
  let n = 0;
  const resolve = resolverFor(w, async (_sw, e) => { n++; return `${e.ref}-id`; });
  assert.deepEqual(await Promise.all([resolve({ id: 'x', ref: 'staged:s', isNew: true }), resolve({ id: 'y', ref: 'staged:s', isNew: true }), resolve({ id: 'z', ref: 'https://x/y.jpg', isNew: true })]), ['staged:s-id', 'staged:s-id', 'https://x/y.jpg-id']);
  assert.equal(n, 2);
});

test('Applier media-alt (via applyChangeSet): writes alt/title and returns the before value as undo', async () => {
  const { applyChangeSet } = await import('../../../src/server/changes');
  const w = fakeWriter({ id: H('a'), alt: null, title: 'Alt-Titel' });
  const cs = { id: 'cs', kind: KIND_ALT, entity: 'media', title: 't', reason: null, skipped: [], atomic: false, items: [
    { id: `${H('a')}:alt`, entity: 'media', entityId: H('a'), label: 'vase.jpg', field: 'alt', fieldLabel: 'Alt-Text', before: '–', after: 'Vase', afterRaw: 'Vase', warn: [] },
    { id: `${H('a')}:title`, entity: 'media', entityId: H('a'), label: 'vase.jpg', field: 'title', fieldLabel: 'Titel', before: 'Alt-Titel', after: 'Neu', afterRaw: 'Neu', warn: [] },
  ] };
  const r = await applyChangeSet(w, cs as never, null, new Set([`${H('a')}:alt`, `${H('a')}:title`]));
  assert.deepEqual(r.results.map(x => x.ok), [true, true]);
  assert.deepEqual(w.calls.sort(), [['update', 'media', H('a'), { alt: 'Vase' }], ['update', 'media', H('a'), { title: 'Neu' }]]);
  assert.deepEqual(r.undo.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [{ op: 'patch', entity: 'media', id: H('a'), data: { alt: null } }, { op: 'patch', entity: 'media', id: H('a'), data: { title: 'Alt-Titel' } }]);
  const gone = await applyChangeSet(fakeWriter(null), cs as never, null, new Set([`${H('a')}:alt`]));
  assert.deepEqual(gone.results, [{ itemId: `${H('a')}:alt`, ok: false, error: 'Medium nicht mehr vorhanden' }]);
});
