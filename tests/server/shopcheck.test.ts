import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CheckRun } from '@/lib/protocol';
import type { ShopReader } from '../../src/server/shopware';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-shopcheck-'));
for (const k of ['SHOPWARE_PASSWORD', 'SHOPWARE_CLIENT_SECRET', 'SHOPWARE_URL', 'SHOP_PLATFORM']) delete process.env[k];

const { updateSettings } = await import('../../src/server/settings');
const { cachedRun, isStale, latestShopCheck, recheckShopCheck, redactRun, startShopCheck, STALE_MS } = await import('../../src/server/shopcheck');

const PASSWORD = 'streng-geheim-4711';
updateSettings({ shopware: { url: 'http://127.0.0.1:9', user: 'admin', password: PASSWORD }, scopes: { media: true, products: true } });

const run = (over: Partial<CheckRun> = {}): CheckRun => ({ checkedAt: new Date().toISOString(), findings: [], errors: [], durationMs: 1, checks: 4, ...over });
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

test('isStale: missing or older than 6 h; incomplete run already after 5 min', () => {
  assert.equal(isStale(null), true);
  assert.equal(isStale(run({ checkedAt: ago(7 * 3600_000) })), true);
  assert.equal(isStale(run({ checkedAt: ago(STALE_MS - 60_000) })), false);
  const broken = { errors: [{ check: 'a', error: 'x' }, { check: 'b', error: 'y' }], checks: 4 }; // half failed
  assert.equal(isStale(run({ ...broken, checkedAt: ago(6 * 60_000) })), true);
  assert.equal(isStale(run({ ...broken, checkedAt: ago(2 * 60_000) })), false);
  assert.equal(isStale(run({ errors: [{ check: 'a', error: 'x' }], checks: 4, checkedAt: ago(6 * 60_000) })), false, 'partially failed counts as ok');
});

test('redactRun: credentials from the settings reach neither the UI nor the AI', () => {
  const r = redactRun(run({ errors: [{ check: 'x', error: `Login mit ${PASSWORD} fehlgeschlagen, Bearer abcdefghijklmnopqrstuvwxyz` }] }));
  assert.ok(!JSON.stringify(r).includes(PASSWORD));
  assert.match(r.errors[0].error, /•••/);
  const clean = run(); assert.equal(redactRun(clean), clean, 'unchanged without errors');
});

test('startShopCheck: only one run at a time, result from storage only for the same signature (shop + scopes)', async () => {
  let calls = 0;
  const reader: ShopReader = {
    base: 'http://127.0.0.1:9',
    async search() { calls++; throw new Error(`Shop antwortet nicht (Passwort ${PASSWORD})`); },
    async get() { calls++; throw new Error('nicht erreichbar'); },
    async salesChannels() { calls++; throw new Error('nicht erreichbar'); },
    async req() { calls++; throw new Error('nicht erreichbar'); },
  };
  const p1 = startShopCheck(reader), p2 = startShopCheck(reader);
  assert.equal(p1, p2, 'second start returns the running run');
  const r = await p1;
  const after = calls;
  assert.ok(r.checks && r.checks > 0 && after > 0);
  assert.ok(r.errors.length > 0, 'checks fail in isolation');
  assert.ok(r.errors.some(e => e.error.includes(PASSWORD)), 'raw in the run (server-internal only)');
  assert.equal(cachedRun()?.checkedAt, r.checkedAt, 'saved');
  // tool/UI get only the redacted version
  const forAi = await latestShopCheck();
  assert.equal(forAi.checkedAt, r.checkedAt); assert.ok(!JSON.stringify(forAi).includes(PASSWORD)); assert.equal(calls, after, 'no new run');
  // scope blocked → different signature → nothing from storage (blocked data does not stay visible)
  updateSettings({ scopes: { media: false } });
  assert.equal(cachedRun(), null);
  updateSettings({ scopes: { media: true } });
  assert.equal(cachedRun()?.checkedAt, r.checkedAt);
  // after the end a new run starts (fresh run, not the old one)
  const r2 = await startShopCheck(reader);
  assert.ok(calls > after); assert.notEqual(r2, r);
});

test('recheckShopCheck: recheck after changes, only with an existing result, exactly one follow-up run during a run', async () => {
  let calls = 0;
  const reader: ShopReader = {
    base: 'http://127.0.0.1:9',
    async search() { calls++; throw new Error('nicht erreichbar'); },
    async get() { calls++; throw new Error('nicht erreichbar'); },
    async salesChannels() { calls++; throw new Error('nicht erreichbar'); },
    async req() { calls++; throw new Error('nicht erreichbar'); },
  };
  // Without a result for this shop (different signature): trigger nothing, the home page checks on the next visit
  updateSettings({ scopes: { media: false } });
  assert.equal(cachedRun(), null);
  await recheckShopCheck(reader);
  assert.equal(calls, 0, 'no run without an existing result');
  updateSettings({ scopes: { media: true } });

  // With result: new run, then a fresher result
  const before = cachedRun();
  assert.ok(before);
  await new Promise(r => setTimeout(r, 5));
  await recheckShopCheck(reader);
  const perRun = calls;
  assert.ok(perRun > 0, 'run started');
  assert.notEqual(cachedRun()?.checkedAt, before.checkedAt, 'result refreshed');

  // While a run is in progress: several triggers → exactly one follow-up run (the running one may have read old data)
  calls = 0;
  const running = startShopCheck(reader);
  await Promise.all([recheckShopCheck(reader), recheckShopCheck(reader), recheckShopCheck(reader)]);
  await running;
  assert.equal(calls, perRun * 2, 'running run + exactly one follow-up run');
});

test('recheckShopCheck: shop not set up → nothing', async () => {
  let calls = 0;
  const reader = { base: '', async search() { calls++; throw new Error('x'); }, async get() { calls++; throw new Error('x'); }, async salesChannels() { calls++; throw new Error('x'); }, async req() { calls++; throw new Error('x'); } } as ShopReader;
  updateSettings({ shopware: { url: '' } });
  await recheckShopCheck(reader);
  assert.equal(calls, 0);
  updateSettings({ shopware: { url: 'http://127.0.0.1:9', password: PASSWORD } }); // URL empty → different origin: the password is discarded
});

test('approved change applied → shop check rechecks via the onApplied hook (real wiring)', async () => {
  await import('../../src/server/features'); // registers the hooks as in the chat
  const { notifyApplied } = await import('../../src/server/changes');
  const before = cachedRun();
  assert.ok(before, 'result from the previous tests present');
  await new Promise(r => setTimeout(r, 5));
  const cs = { id: 'cs1', kind: 'products', title: 'Meta-Descriptions', reason: '', items: [{ id: 'i1', entity: 'product', entityId: 'p1', label: 'Vase', field: 'metaDescription', before: '', after: 'Neu' }] } as never;
  await notifyApplied(cs, { results: [{ itemId: 'i1', ok: true }] }, { ro: {} as ShopReader, chatId: 'c1' });
  // The hook starts in the background; wait until a new result is stored
  for (let i = 0; i < 200 && cachedRun()?.checkedAt === before.checkedAt; i++) await new Promise(r => setTimeout(r, 50));
  assert.notEqual(cachedRun()?.checkedAt, before.checkedAt, 'new run after the change');

  // Nothing applied (everything failed) → no hook, no run
  const now = cachedRun()?.checkedAt;
  await notifyApplied(cs, { results: [{ itemId: 'i1', ok: false }] }, { ro: {} as ShopReader, chatId: 'c1' });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(cachedRun()?.checkedAt, now);
});
