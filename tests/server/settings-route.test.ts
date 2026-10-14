import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChangeSet, ChatEvent } from '@/lib/protocol';

// PUT /api/settings: changes to the shop connection end up in the audit log (field names only) and are rejected while a change set is being written.
process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-settings-route-'));
for (const k of Object.keys(process.env)) if (/^(SHOPWARE_|SHOPIFY_|MAGENTO_|OPENMAGE_|SHOP_PLATFORM$)/.test(k)) delete process.env[k];

const { updateSettings, getSettings, connectionChanges } = await import('../../src/server/settings');
const { ADAPTERS } = await import('../../src/server/platform');
const { getSession, decideChange, writesInProgress } = await import('../../src/server/sessions');
const { auditList } = await import('../../src/server/db');
const { PUT } = await import('../../src/app/api/settings/route');

updateSettings({ platform: 'shopware', shopware: { url: 'http://alt.shop', user: 'admin', password: 'altes-passwort' } });
const put = (body: unknown) => PUT(new Request('http://127.0.0.1/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const cs: ChangeSet = { id: 'cs-run', kind: 'products', entity: 'product', title: 'Test', reason: null, atomic: false, skipped: [], items: [{ id: 'a', entity: 'product', entityId: 'p1', label: 'P', field: 'name', fieldLabel: 'Name', before: 'alt', after: 'neu', afterRaw: 'neu', warn: [] }] };
const tick = () => new Promise(r => setTimeout(r, 5));

test('connectionChanges: lists only shop connection fields that actually change', () => {
  assert.deepEqual(connectionChanges({ shopware: { url: 'http://alt.shop', user: 'admin', password: '' }, ai: { model: 'opus' }, scopes: { cms: false } }), []);
  assert.deepEqual(connectionChanges({ shopware: { url: 'http://neu.shop', password: 'neues-passwort' } }), ['shopware.url', 'shopware.password']);
  assert.deepEqual(connectionChanges({ platform: 'shopify', shopify: { storeDomain: 'laden.myshopify.com' } }), ['platform', 'shopify.storeDomain']);
  assert.deepEqual(connectionChanges({ shopware: { password: null } }), ['shopware.password']);
  assert.deepEqual(connectionChanges({ shopware: { url: 'http://neu.shop' } }), ['shopware.url', 'shopware.password'], 'different origin discards the saved password (visible in the audit)');
  assert.deepEqual(connectionChanges({ shopware: { url: 'http://alt.shop/' } }), ['shopware.url'], 'same origin keeps it');
});

test('PUT: shop connection changed → audit row with field names, never values; AI settings without audit', async () => {
  const before = auditList().length;
  const r = await put({ shopware: { url: 'http://neu.shop', password: 'streng-geheim' }, ai: { model: 'opus' } });
  assert.equal(r.status, 200);
  assert.equal(getSettings().shopware.url, 'http://neu.shop');
  const rows = auditList();
  assert.equal(rows.length, before + 1);
  assert.equal(rows[0].decision, 'changed'); assert.equal(rows[0].kind, 'settings');
  assert.deepEqual(rows[0].fields, { 'shopware.url': 'geändert', 'shopware.password': 'geändert' });
  assert.ok(!JSON.stringify(rows).includes('streng-geheim') && !JSON.stringify(rows).includes('neu.shop'), 'no values in the audit log');
  assert.equal((await put({ ai: { model: 'sonnet' }, image: { openaiKey: 'sk-abcdefghijklmnopqrstuvwxyz' } })).status, 200);
  assert.equal(auditList().length, before + 1, 'AI/image settings create no row');
});

test('PUT: while a change set is being written, switching the shop connection is rejected with 409, other settings are not', async () => {
  let finish!: () => void;
  const origApply = ADAPTERS.shopware.apply;
  ADAPTERS.shopware.apply = () => new Promise(res => { finish = () => res({ results: [{ itemId: 'a', ok: true }], undo: [] }); });
  try {
    const s = getSession('settings-busy'); s.running = true;
    s.emit = (ev: ChatEvent) => { s.events.push(ev); };
    const pending = s.requestChange(cs);
    await tick();
    const approvalId = (s.events.findLast(e => e.t === 'changeset') as { approvalId: string }).approvalId;
    assert.ok(decideChange('settings-busy', approvalId, true)); await tick();
    assert.equal(writesInProgress(), 1);
    const r = await put({ shopware: { url: 'http://anderer.shop' } });
    assert.equal(r.status, 409); assert.match((await r.json() as { error: string }).error, /Bitte warte/);
    assert.equal(getSettings().shopware.url, 'http://neu.shop', 'nothing saved');
    assert.equal((await put({ platform: 'magento' })).status, 409, 'platform switch likewise');
    assert.equal((await put({ ai: { model: '' }, shopware: { url: 'http://neu.shop' } })).status, 200, 'unchanged connection + AI setting works');
    finish(); await pending; s.running = false;
    assert.equal(writesInProgress(), 0);
    assert.equal((await put({ shopware: { url: 'http://anderer.shop' } })).status, 200);
    assert.equal(getSettings().shopware.url, 'http://anderer.shop');
  } finally { ADAPTERS.shopware.apply = origApply; }
});
