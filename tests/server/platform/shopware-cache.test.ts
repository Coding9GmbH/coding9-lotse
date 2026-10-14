import { test } from 'node:test';
import assert from 'node:assert/strict';

// Cache leeren nach dem Schreiben: richtiger Endpunkt, Best-Effort (Fehler brechen nichts ab), abschaltbar
process.env.AICB_DATA = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'lotse-cache-'));
const { clearShopCache, clearCacheEnabled } = await import('../../../src/server/platform/shopware/cache');

test('ruft DELETE /_action/cache auf und meldet Erfolg', async () => {
  const calls: string[] = [];
  assert.equal(await clearShopCache({ req: async (m, p) => { calls.push(`${m} ${p}`); return null; } }, 'test'), true);
  assert.deepEqual(calls, ['DELETE /_action/cache']);
});

test('fehlendes Recht (403) wirft nicht, sondern meldet false', async () => {
  const e = Object.assign(new Error('Shopware 403: system:clear:cache'), { status: 403 });
  assert.equal(await clearShopCache({ req: async () => { throw e; } }, 'test'), false);
});

test('LOTSE_CLEAR_CACHE=0 schaltet ab, sonst an', async () => {
  assert.equal(clearCacheEnabled({}), true);
  assert.equal(clearCacheEnabled({ LOTSE_CLEAR_CACHE: '' }), true);
  assert.equal(clearCacheEnabled({ LOTSE_CLEAR_CACHE: '1' }), true);
  for (const v of ['0', 'false', 'OFF', 'no']) assert.equal(clearCacheEnabled({ LOTSE_CLEAR_CACHE: v }), false, v);
  process.env.LOTSE_CLEAR_CACHE = '0';
  let n = 0;
  assert.equal(await clearShopCache({ req: async () => { n++; return null; } }, 'test'), false);
  assert.equal(n, 0, 'abgeschaltet: kein Aufruf');
  delete process.env.LOTSE_CLEAR_CACHE;
});
