import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkSchema } from '../../../../src/app/api/knowledge/schema';

test('linkSchema: identifiers of all four platforms are accepted (Shopware hex, Shopify/Magento/OpenMage numeric, Shopify GID)', () => {
  for (const id of ['0194c1a2b3c44d5e8f6071829304a5b6', '4711', '9876543210', 'gid://shopify/Product/8123456789']) {
    const r = linkSchema.safeParse({ kind: 'product', id, number: '4711', name: 'Vase' });
    assert.ok(r.success, `id ${id}`); assert.equal(r.data.id, id);
  }
  assert.equal(linkSchema.parse({ kind: 'category', id: ' 12 ' }).id, '12', 'surrounding whitespace is trimmed');
});

test('linkSchema: empty, too long and malformed identifiers are rejected', () => {
  for (const id of ['', '   ', 'a'.repeat(65), 'a b', 'a\nb', 'a\u0000b']) assert.ok(!linkSchema.safeParse({ kind: 'product', id }).success, JSON.stringify(id));
  assert.ok(!linkSchema.safeParse({ kind: 'product', id: 12 }).success, 'number instead of text');
  assert.ok(!linkSchema.safeParse({ kind: 'page', id: '12' }).success, 'unknown kind');
  assert.ok(linkSchema.safeParse({ kind: 'product', id: 'a'.repeat(64) }).success);
});
