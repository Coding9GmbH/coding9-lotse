import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ShopifyClient } from '../../../../src/server/platform/shopify/client';
import type { UndoOp } from '@/lib/protocol';

test('Shopify: verlorene fileCreate-Antwort merkt die neue Datei zum Löschen vor', async () => {
  const { createShopFile } = await import('../../../../src/server/platform/shopify/publish');
  const files = new Map<string, { id: string }>();
  let n = 0;
  const client = {
    gql: async (q: string) => (q.includes('files(') ? { files: { nodes: [...files.values()] } } : {}),
    mutate: async () => {
      const id = 'gid://shopify/MediaImage/9';
      files.set(id, { id });
      if (n++ === 0) throw new Error('Zeitlimit');
      return { files: [{ id, fileStatus: 'READY', image: { url: 'https://cdn.shopify.com/a.jpg' } }] };
    },
  } as unknown as ShopifyClient;
  const undo: UndoOp[] = [];
  await assert.rejects(createShopFile(client, 'https://cdn.example.com/a.jpg', 'Vase', undo), /Zeitlimit/);
  assert.equal(files.size, 1);
  assert.ok(undo.some(o => o.op === 'delete' && o.entity === 'file' && o.id === 'gid://shopify/MediaImage/9'));
});
