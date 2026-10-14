// Gallery download: the same public address must not be rewritten to a foreign host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageContent } from '../../../../src/server/platform/openmage/images';
import type { OmClient } from '../../../../src/server/platform/openmage/client';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

test('imageContent: shop image with path prefix stays on the shop host', async () => {
  const fetched: { url: string; redirect?: RequestRedirect }[] = [];
  const attack = 'https://mein-shop.de/de@169.254.169.254/media/a.jpg';
  const c = {
    publicUrl: 'https://mein-shop.de/de',
    base: 'http://172.17.0.2',
    req: async () => ({ images: [{ id: 7, url: attack, file: '/a.jpg' }] }),
    storefrontFetch: async (url: string, init?: RequestInit) => {
      fetched.push({ url, redirect: init?.redirect });
      if (new URL(url).hostname !== 'mein-shop.de') return new Response('no', { status: 500 });
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    },
  } as unknown as OmClient;
  const out = await imageContent(c, 'om-1-7', 'Vase');
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, attack);
  assert.equal(fetched[0].redirect, 'manual');
  assert.equal(new URL(fetched[0].url).hostname, 'mein-shop.de');
  assert.ok(out.base64.length > 10);

  fetched.length = 0;
  c.req = async () => ({ images: [{ id: 7, url: 'https://mein-shop.de/de/media/a.jpg', file: '/a.jpg' }] });
  (c as { storefrontFetch: OmClient['storefrontFetch'] }).storefrontFetch = async (url: string, init?: RequestInit) => {
    fetched.push({ url, redirect: init?.redirect });
    return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
  };
  await imageContent(c, 'om-1-7', 'Vase');
  assert.equal(fetched[0].url, 'http://172.17.0.2/media/a.jpg');
});
