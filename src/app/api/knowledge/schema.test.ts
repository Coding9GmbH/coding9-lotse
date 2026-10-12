import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkSchema } from './schema';

test('linkSchema: Kennungen aller vier Plattformen werden akzeptiert (Shopware hex, Shopify/Magento/OpenMage numerisch, Shopify-GID)', () => {
  for (const id of ['0194c1a2b3c44d5e8f6071829304a5b6', '4711', '9876543210', 'gid://shopify/Product/8123456789']) {
    const r = linkSchema.safeParse({ kind: 'product', id, number: '4711', name: 'Vase' });
    assert.ok(r.success, `id ${id}`); assert.equal(r.data.id, id);
  }
  assert.equal(linkSchema.parse({ kind: 'category', id: ' 12 ' }).id, '12', 'Leerraum am Rand wird entfernt');
});

test('linkSchema: leere, zu lange und unsaubere Kennungen werden abgelehnt', () => {
  for (const id of ['', '   ', 'a'.repeat(65), 'a b', 'a\nb', 'a\u0000b']) assert.ok(!linkSchema.safeParse({ kind: 'product', id }).success, JSON.stringify(id));
  assert.ok(!linkSchema.safeParse({ kind: 'product', id: 12 }).success, 'Zahl statt Text');
  assert.ok(!linkSchema.safeParse({ kind: 'page', id: '12' }).success, 'unbekannte Art');
  assert.ok(linkSchema.safeParse({ kind: 'product', id: 'a'.repeat(64) }).success);
});
