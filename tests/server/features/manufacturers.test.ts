import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Shopware, ShopReader, SwEntity } from '../../../src/server/shopware';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-hersteller-'));
const { buildManufacturerChangeSet } = await import('../../../src/server/features/manufacturers');
const { applyChangeSet, undoOps } = await import('../../../src/server/changes');

const M1 = 'a'.repeat(32), MEDIA = 'b'.repeat(32);
/** Fake shop: product-manufacturer + media in memory, reading and writing via the same table */
function fake(db: Record<string, SwEntity[]>) {
  const search = async (entity: string, c: { ids?: string[]; filter?: { type: string; field: string; value: unknown }[] } = {}) => {
    let rows = db[entity] ?? [];
    if (c.ids) rows = rows.filter(r => c.ids!.includes(r.id));
    for (const f of c.filter ?? []) {
      if (f.type === 'equals') rows = rows.filter(r => r[f.field] === f.value);
      // MySQL compares texts case-insensitively (like Shopware)
      if (f.type === 'equalsAny') rows = rows.filter(r => (f.value as unknown[]).some(v => String(v).toLowerCase() === String(r[f.field]).toLowerCase()));
    }
    return { data: rows, total: rows.length };
  };
  const get = async (entity: string, id: string) => (db[entity] ?? []).find(r => r.id === id) ?? null;
  const create = async (entity: string, data: Record<string, unknown>) => { (db[entity] ||= []).push({ ...data } as SwEntity); return null; };
  const update = async (entity: string, id: string, data: Record<string, unknown>) => { Object.assign((db[entity] ?? []).find(r => r.id === id)!, data); return null; };
  const req = async (method: string, p: string) => { const [, entity, id] = p.split('/'); if (method === 'DELETE') db[entity] = (db[entity] ?? []).filter(r => r.id !== id); return null; };
  return { ro: { search, get } as unknown as ShopReader, sw: { search, get, create, update, req } as unknown as Shopware };
}
const base = () => ({ 'product-manufacturer': [{ id: M1, name: '3M', translated: { name: '3M', description: 'Alt' }, description: 'Alt', link: null }] as SwEntity[], media: [{ id: MEDIA }] as SwEntity[] });

test('create: preview, apply with requested ID, undo deletes again; existing and duplicate names are skipped', async () => {
  const db = base(), f = fake(db);
  const { cs } = await buildManufacturerChangeSet(f.ro, { title: 't', reason: 'r', create: [{ name: '3M Peltor', description: '<p>Gehörschutz</p>', link: 'https://www.3m.de/peltor', mediaId: MEDIA }, { name: '3m' }, { name: '3M Peltor' }] });
  assert.equal(cs.items.length, 1); assert.equal(cs.items[0].label, 'Hersteller „3M Peltor“'); assert.match(cs.items[0].after, /Beschreibung, Webseite https:\/\/www\.3m\.de\/peltor, Logo/);
  assert.deepEqual(cs.skipped.map(s => s.id), ['3m', '3M Peltor']);
  const r = await applyChangeSet(f.sw, cs, null, new Set(cs.items.map(i => i.id)));
  assert.deepEqual(r.results.map(x => x.ok), [true]);
  const made = db['product-manufacturer'].find(m => m.name === '3M Peltor')!;
  assert.equal(made.id, cs.items[0].entityId); assert.equal(made.link, 'https://www.3m.de/peltor'); assert.equal(made.mediaId, MEDIA);
  await undoOps(f.sw, r.undo);
  assert.equal(db['product-manufacturer'].length, 1);
});

test('edit: only changed fields, null removes, undo restores, an intermediate change is not overwritten', async () => {
  const db = base(), f = fake(db);
  const { cs } = await buildManufacturerChangeSet(f.ro, { title: 't', reason: 'r', update: [{ id: M1, name: '3M', description: 'Neu', link: 'https://www.3m.de', mediaId: null }] });
  assert.deepEqual(cs.items.map(i => i.field), ['description', 'link'], 'name unchanged, logo was empty: no entry');
  const r = await applyChangeSet(f.sw, cs, null, new Set(cs.items.map(i => i.id)));
  assert.deepEqual(r.results.map(x => x.ok), [true, true]);
  assert.equal(db['product-manufacturer'][0].description, 'Neu'); assert.equal(db['product-manufacturer'][0].link, 'https://www.3m.de');
  await undoOps(f.sw, r.undo);
  assert.equal(db['product-manufacturer'][0].description, 'Alt'); assert.equal(db['product-manufacturer'][0].link, null);
  // Shop changed after the proposal → don't overwrite
  const { cs: cs2 } = await buildManufacturerChangeSet(f.ro, { title: 't', reason: 'r', update: [{ id: M1, link: 'https://www.3m.com' }] });
  db['product-manufacturer'][0].link = 'https://anders.de';
  const r2 = await applyChangeSet(f.sw, cs2, null, new Set(cs2.items.map(i => i.id)));
  assert.equal(r2.results[0].ok, false); assert.equal(db['product-manufacturer'][0].link, 'https://anders.de');
});

test('input: invalid link, unknown logo, unknown manufacturer, empty set', async () => {
  const f = fake(base());
  await assert.rejects(buildManufacturerChangeSet(f.ro, { title: 't', reason: 'r', create: [{ name: 'X', link: 'www.x.de' }] }), /Link „www\.x\.de“ ungültig/);
  await assert.rejects(buildManufacturerChangeSet(f.ro, { title: 't', reason: 'r', create: [{ name: 'X', mediaId: 'c'.repeat(32) }] }), /Medium .* nicht gefunden/);
  await assert.rejects(buildManufacturerChangeSet(f.ro, { title: 't', reason: 'r', update: [{ id: 'd'.repeat(32), name: 'Y' }] }), /Nichts zu ändern.*nicht gefunden/);
  await assert.rejects(buildManufacturerChangeSet(f.ro, { title: 't', reason: 'r' }), /Weder create noch update/);
  await assert.rejects(buildManufacturerChangeSet(f.ro, { title: 't', reason: 'r', update: [{ id: M1, name: '  ' }] }), /Name darf nicht leer sein/);
});
