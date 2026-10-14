import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Shopware } from '../../src/server/shopware';

// Docker case: shop reachable internally under a different address than the sales channel domain → Host header must carry the domain
test('storefrontFetch: internal address with the host of the sales channel domain', async () => {
  const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/plain'); r.end(`${q.headers.host} ${q.url}`); });
  await new Promise<void>(res => srv.listen(0, '127.0.0.1', res));
  try {
    const { port } = srv.address() as AddressInfo;
    const sw = new Shopware({ url: `http://127.0.0.1:${port}`, publicUrl: '', user: '', password: '', clientId: '', clientSecret: '' });
    sw.sfDomain = 'http://shop.example:8888';
    const r = await sw.storefrontFetch('http://shop.example:8888/Clothing/?p=2', { headers: { accept: 'text/html' } });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'shop.example:8888 /Clothing/?p=2');
  } finally { srv.close(); }
});
