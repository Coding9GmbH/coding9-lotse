// OpenMage: sales per product via GET /v1/sales of the Lotse module (1.3.0+) against the fake; the AI's read client may not use it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeOpenmage } from '../../../support/openmage-fake';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-openmage-sales-'));
const fake = await startFakeOpenmage({ orders: [
  { day: '2026-09-01', items: [{ product_id: 1, qty: 2, revenue: 98 }, { product_id: 3, qty: 1, revenue: 39 }] },
  { day: '2026-09-15', items: [{ product_id: 1, qty: 1, revenue: 49 }] },
  { day: '2026-09-20', canceled: true, items: [{ product_id: 2, qty: 5, revenue: 90 }] },
  { day: '2026-10-05', items: [{ product_id: 2, qty: 1, revenue: 18 }] }, // outside the period
] });
test.after(() => fake.close());
const { OmClient } = await import('../../../../src/server/platform/openmage/client');
const { openmageSales } = await import('../../../../src/server/platform/openmage/sales');
const { createOmGuard, OmReader } = await import('../../../../src/server/platform/openmage/reader');
const client = new OmClient({ url: fake.base, token: fake.token, storeCode: 'en' });

test('sales: sums per product of the period, canceled orders excluded, whole shop without store, IDs as strings', async () => {
  const r = await openmageSales(client, { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(r.rows, [{ productId: '1', quantity: 3, revenue: 147, orders: 2 }, { productId: '3', quantity: 1, revenue: 39, orders: 1 }]);
  assert.deepEqual([r.orders, r.currency, r.capped, r.notes], [2, 'EUR', false, undefined]);
  const call = fake.log.filter(l => l.path === '/v1/sales').at(-1)!;
  assert.equal(call.store, 'admin', 'no store scope: sales of the whole shop');
  assert.ok(!JSON.stringify(r).match(/customer|email|increment/i));
});

test('sales: from/to are sent as given, invalid periods are rejected by the module', async () => {
  const one = await openmageSales(client, { from: '2026-10-05', to: '2026-10-05' });
  assert.deepEqual(one.rows.map(x => x.productId), ['2']);
  await assert.rejects(openmageSales(client, { from: '2026-10-05', to: '2026-09-01' }), /from liegt nach to/);
});

test('sales: module older than 1.3.0 (404) → clear message to update', async () => {
  fake.salesMissing = true;
  try { await assert.rejects(openmageSales(client, { from: '2026-09-01', to: '2026-09-30' }), /Lotse_Connector ist zu alt für den Abverkauf: bitte auf Version 1\.3\.0 aktualisieren/); }
  finally { fake.salesMissing = false; }
});

test('sales: the AI read client denies /v1/sales (only the adapter reads it), salesrules stay readable', () => {
  const events: { op: string; denied?: string }[] = [];
  const g = createOmGuard({ onAccess: a => events.push(a) });
  for (const p of ['/v1/sales', '/v1/sales/1', '/v1/Sales']) assert.throws(() => g.check(p), /ZUGRIFF VERWEIGERT/, p);
  assert.equal(g.check('/v1/salesrules'), 'sales-rule');
  assert.ok(events.some(e => e.op === 'deny'));
  const reader = new OmReader(client, g);
  assert.ok(!('sales' in reader), 'no sales method on the AI read client');
});
