import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CheckRun } from '@/lib/protocol';
import type { ShopReader } from './shopware';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-shopcheck-'));
for (const k of ['SHOPWARE_PASSWORD', 'SHOPWARE_CLIENT_SECRET', 'SHOPWARE_URL', 'SHOP_PLATFORM']) delete process.env[k];

const { updateSettings } = await import('./settings');
const { cachedRun, isStale, latestShopCheck, redactRun, startShopCheck, STALE_MS } = await import('./shopcheck');

const PASSWORD = 'streng-geheim-4711';
updateSettings({ shopware: { url: 'http://127.0.0.1:9', user: 'admin', password: PASSWORD }, scopes: { media: true, products: true } });

const run = (over: Partial<CheckRun> = {}): CheckRun => ({ checkedAt: new Date().toISOString(), findings: [], errors: [], durationMs: 1, checks: 4, ...over });
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

test('isStale: fehlend oder älter als 6 Std.; unvollständiger Durchlauf schon nach 5 Min.', () => {
  assert.equal(isStale(null), true);
  assert.equal(isStale(run({ checkedAt: ago(7 * 3600_000) })), true);
  assert.equal(isStale(run({ checkedAt: ago(STALE_MS - 60_000) })), false);
  const broken = { errors: [{ check: 'a', error: 'x' }, { check: 'b', error: 'y' }], checks: 4 }; // Hälfte gescheitert
  assert.equal(isStale(run({ ...broken, checkedAt: ago(6 * 60_000) })), true);
  assert.equal(isStale(run({ ...broken, checkedAt: ago(2 * 60_000) })), false);
  assert.equal(isStale(run({ errors: [{ check: 'a', error: 'x' }], checks: 4, checkedAt: ago(6 * 60_000) })), false, 'teilweise gescheitert zählt wie ok');
});

test('redactRun: Zugangsdaten aus den Einstellungen erreichen weder Oberfläche noch KI', () => {
  const r = redactRun(run({ errors: [{ check: 'x', error: `Login mit ${PASSWORD} fehlgeschlagen, Bearer abcdefghijklmnopqrstuvwxyz` }] }));
  assert.ok(!JSON.stringify(r).includes(PASSWORD));
  assert.match(r.errors[0].error, /•••/);
  const clean = run(); assert.equal(redactRun(clean), clean, 'ohne Fehler unverändert');
});

test('startShopCheck: nur ein Durchlauf gleichzeitig, Ergebnis nur für dieselbe Signatur (Shop + Bereiche) aus dem Speicher', async () => {
  let calls = 0;
  const reader: ShopReader = {
    base: 'http://127.0.0.1:9',
    async search() { calls++; throw new Error(`Shop antwortet nicht (Passwort ${PASSWORD})`); },
    async get() { calls++; throw new Error('nicht erreichbar'); },
    async salesChannels() { calls++; throw new Error('nicht erreichbar'); },
    async req() { calls++; throw new Error('nicht erreichbar'); },
  };
  const p1 = startShopCheck(reader), p2 = startShopCheck(reader);
  assert.equal(p1, p2, 'zweiter Start liefert den laufenden Durchlauf');
  const r = await p1;
  const after = calls;
  assert.ok(r.checks && r.checks > 0 && after > 0);
  assert.ok(r.errors.length > 0, 'Prüfungen scheitern isoliert');
  assert.ok(r.errors.some(e => e.error.includes(PASSWORD)), 'roh im Lauf (nur serverintern)');
  assert.equal(cachedRun()?.checkedAt, r.checkedAt, 'gespeichert');
  // Werkzeug/Oberfläche bekommen nur die bereinigte Fassung
  const forAi = await latestShopCheck();
  assert.equal(forAi.checkedAt, r.checkedAt); assert.ok(!JSON.stringify(forAi).includes(PASSWORD)); assert.equal(calls, after, 'kein neuer Durchlauf');
  // Bereich gesperrt → andere Signatur → nichts aus dem Speicher (gesperrte Daten bleiben nicht sichtbar)
  updateSettings({ scopes: { media: false } });
  assert.equal(cachedRun(), null);
  updateSettings({ scopes: { media: true } });
  assert.equal(cachedRun()?.checkedAt, r.checkedAt);
  // nach dem Ende startet ein neuer Durchlauf (frischer Lauf, nicht der alte)
  const r2 = await startShopCheck(reader);
  assert.ok(calls > after); assert.notEqual(r2, r);
});
