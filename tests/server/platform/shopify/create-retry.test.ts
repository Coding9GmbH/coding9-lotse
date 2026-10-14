import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ShopifyClient } from '../../../../src/server/platform/shopify/client';
import type { UndoOp } from '@/lib/protocol';

test('Shopify: if the SKU is already taken, no second product is created', async () => {
  const { createProduct } = await import('../../../../src/server/platform/shopify/products');
  let mutated = 0;
  const client = {
    gql: async (q: string) => {
      if (q.includes('productVariants')) return { productVariants: { nodes: [{ sku: 'VASE-1' }] } };
      return { products: { nodes: [] } };
    },
    mutate: async () => { mutated++; throw new Error('mutate sollte nicht laufen'); },
  } as unknown as ShopifyClient;
  const undo: UndoOp[] = [];
  await assert.rejects(createProduct(client, { name: 'Vase', description: '<p>x</p>', price: 10, sku: 'VASE-1', images: [], collectionIds: [], tags: [], active: false }, undo), /SKU VASE-1 ist schon vergeben/);
  assert.equal(mutated, 0);
  assert.equal(undo.length, 0);
});
