/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Protocol-level behaviour of the Shopify fake: auth, HTTP failures, throttling,
 * cost extensions, GraphQL validation and execution semantics.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { data, gql } from './helpers.test-util';
import { startFakeShopify, type FakeShopify } from './server';

let fake: FakeShopify;

before(async () => {
  fake = await startFakeShopify();
});
after(async () => {
  await fake.close();
});
beforeEach(() => fake.reset());

describe('HTTP & auth', () => {
  it('answers shop queries with cost extensions and version header', async () => {
    const res = await fake.graphql<any>('{ shop { name currencyCode primaryDomain { url host } myshopifyDomain } }');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-shopify-api-version'), '2026-10');
    assert.ok(res.headers.get('x-request-id'));
    assert.deepEqual(res.body.data.shop, {
      name: 'Haus Holm',
      currencyCode: 'EUR',
      primaryDomain: { url: 'https://haus-holm.myshopify.com', host: 'haus-holm.myshopify.com' },
      myshopifyDomain: 'haus-holm.myshopify.com',
    });
    const cost = res.body.extensions.cost;
    assert.equal(cost.requestedQueryCost, 2);
    assert.equal(typeof cost.actualQueryCost, 'number');
    assert.deepEqual(Object.keys(cost.throttleStatus).sort(), ['currentlyAvailable', 'maximumAvailable', 'restoreRate']);
    assert.equal(cost.throttleStatus.maximumAvailable, 2000);
  });

  it('rejects missing or wrong access tokens with 401', async () => {
    const res = await fake.graphql<any>('{ shop { name } }', undefined, { token: 'shpat_wrong' });
    assert.equal(res.status, 401);
    assert.equal(res.body.errors, '[API] Invalid API key or access token (unrecognized login or wrong password)');
    const raw = await fetch(fake.graphqlUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '{ shop { name } }' }) });
    assert.equal(raw.status, 401);
  });

  it('serves older supported versions and falls forward for unsupported ones', async () => {
    const ok = await fake.graphql<any>('{ shop { name } }', undefined, { apiVersion: '2026-01' });
    assert.equal(ok.headers.get('x-shopify-api-version'), '2026-01');
    const old = await fake.graphql<any>('{ shop { name } }', undefined, { apiVersion: '2023-01' });
    assert.equal(old.status, 200);
    assert.equal(old.headers.get('x-shopify-api-version'), '2025-10');
    const bad = await fetch(`${fake.url}/admin/api/latest/graphql.json`, { method: 'POST', headers: { 'X-Shopify-Access-Token': fake.token } });
    assert.equal(bad.status, 404);
  });

  it('returns 400 for a missing query parameter', async () => {
    const res = await fetch(fake.graphqlUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': fake.token }, body: '{}' });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { errors: { query: 'Required parameter missing or invalid' } });
  });

  it('accepts application/graphql bodies', async () => {
    const res = await fetch(fake.graphqlUrl, { method: 'POST', headers: { 'Content-Type': 'application/graphql', 'X-Shopify-Access-Token': fake.token }, body: '{ shop { name } }' });
    assert.equal((await res.json()).data.shop.name, 'Haus Holm');
  });

  it('fails on demand with 429 + Retry-After, then recovers', async () => {
    fake.failNext({ status: 429, retryAfter: 2, times: 2 });
    for (let i = 0; i < 2; i++) {
      const res = await fake.graphql<any>('{ shop { name } }');
      assert.equal(res.status, 429);
      assert.equal(res.headers.get('retry-after'), '2.0');
      assert.match(res.body.errors, /Exceeded 2 calls per second/);
    }
    const res = await fake.graphql<any>('{ shop { name } }');
    assert.equal(res.status, 200);
  });

  it('can be told to fail via the HTTP control endpoint', async () => {
    await fetch(`${fake.url}/__fake/fail`, { method: 'POST', body: JSON.stringify({ status: 401 }) });
    const res = await fake.graphql<any>('{ shop { name } }');
    assert.equal(res.status, 401);
    assert.equal((await fake.graphql<any>('{ shop { name } }')).status, 200);
  });

  it('records requests for assertions', async () => {
    await fake.graphql('query Named { shop { name } }');
    const last = fake.state.requestLog.at(-1)!;
    assert.equal(last.operationName, null);
    assert.match(last.query, /query Named/);
    assert.equal(last.status, 200);
    const viaHttp = await (await fetch(`${fake.url}/__fake/requests`)).json();
    assert.equal(viaHttp.length, fake.state.requestLog.length);
  });

  it('exposes the granted access scopes', async () => {
    const d = await data(fake, '{ currentAppInstallation { accessScopes { handle } } }');
    const handles = d.currentAppInstallation.accessScopes.map((s: any) => s.handle);
    assert.ok(handles.includes('write_products'));
    assert.ok(!handles.includes('read_customers'));
    const rest = await fetch(`${fake.url}/admin/oauth/access_scopes.json`, { headers: { 'X-Shopify-Access-Token': fake.token } });
    assert.ok((await rest.json()).access_scopes.some((s: any) => s.handle === 'read_themes'));
  });
});

describe('throttling & cost', () => {
  it('computes connection costs as 2 + first * node cost', async () => {
    const body = await gql(fake, '{ products(first: 10) { nodes { id title } } }');
    assert.equal(body.extensions.cost.requestedQueryCost, 12);
    assert.ok(body.extensions.cost.actualQueryCost <= 12);
  });

  it('rejects queries above the single query cost limit', async () => {
    const body = await gql(fake, '{ products(first: 250) { nodes { variants(first: 250) { nodes { id } } } } }');
    assert.equal(body.data, undefined);
    assert.equal(body.errors![0].extensions.code, 'MAX_COST_EXCEEDED');
    assert.match(body.errors![0].message, /exceeds the single query max cost limit \(1000\)/);
  });

  it('returns THROTTLED when the bucket is empty', async () => {
    fake.throttle.currentlyAvailable = 0;
    const body = await gql(fake, '{ products(first: 5) { nodes { id } } }');
    assert.equal(body.errors![0].message, 'Throttled');
    assert.equal(body.errors![0].extensions.code, 'THROTTLED');
    assert.equal(body.extensions.cost.throttleStatus.currentlyAvailable, 0);
    fake.throttle.currentlyAvailable = 2000;
  });

  it('charges mutations 10 points', async () => {
    const body = await gql(fake, 'mutation { urlRedirectCreate(urlRedirect: { path: "/a", target: "/b" }) { urlRedirect { id } userErrors { field message } } }');
    assert.equal(body.extensions.cost.requestedQueryCost, 10);
  });
});

describe('validation (graphql-ruby compatible)', () => {
  it('reports unknown fields', async () => {
    const body = await gql(fake, '{ products(first: 1) { nodes { titel } } }');
    assert.equal(body.data, undefined);
    assert.equal(body.errors![0].message, "Field 'titel' doesn't exist on type 'Product'");
    assert.deepEqual(body.errors![0].extensions, { code: 'undefinedField', typeName: 'Product', fieldName: 'titel' });
    assert.deepEqual(body.errors![0].locations, [{ line: 1, column: 32 }]);
  });

  it('reports parse errors', async () => {
    const body = await gql(fake, '{ shop { name }');
    assert.match(body.errors![0].message, /Unexpected end of document|Parse error/);
  });

  it('reports unknown arguments and missing required arguments', async () => {
    const a = await gql(fake, '{ products(frist: 1) { nodes { id } } }');
    assert.equal(a.errors![0].message, "Field 'products' doesn't accept argument 'frist'");
    const b = await gql(fake, '{ product { id } }');
    assert.equal(b.errors![0].message, "Field 'product' is missing required arguments: id");
  });

  it('requires selections on objects and forbids them on scalars', async () => {
    const a = await gql(fake, '{ shop }');
    assert.match(a.errors![0].message, /Field must have selections \(field 'shop' returns Shop but has no selections/);
    const b = await gql(fake, '{ shop { name { x } } }');
    assert.match(b.errors![0].message, /Selections can't be made on scalars/);
  });

  it('rejects unknown input fields in variables like Shopify', async () => {
    const body = await gql(fake, 'mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { product { id } userErrors { field message } } }', {
      p: { id: 'gid://shopify/Product/9100000000001', titel: 'x' },
    });
    assert.equal(body.data, undefined);
    assert.equal(body.errors![0].message, 'Variable $p of type ProductUpdateInput! was provided invalid value for titel (Field is not defined on ProductUpdateInput)');
    assert.deepEqual(body.errors![0].extensions.problems, [{ path: ['titel'], explanation: 'Field is not defined on ProductUpdateInput' }]);
  });

  it('rejects invalid enum values and missing non-null variables', async () => {
    const a = await gql(fake, 'mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { userErrors { message } } }', { p: { id: 'gid://shopify/Product/1', status: 'LIVE' } });
    assert.match(a.errors![0].message, /for status \(Expected "LIVE" to be one of: ACTIVE, ARCHIVED, DRAFT, UNLISTED\)/);
    const b = await gql(fake, 'query($id: ID!) { product(id: $id) { id } }');
    assert.equal(b.errors![0].message, 'Variable $id of type ID! was provided invalid value');
  });

  it('checks variable usage', async () => {
    const a = await gql(fake, 'query($id: ID!, $unused: Int) { product(id: $id) { id } }', { id: 'gid://shopify/Product/1' });
    assert.equal(a.errors![0].message, 'Variable $unused is declared by anonymous query but not used');
    const b = await gql(fake, 'query Q { product(id: $id) { id } }');
    assert.equal(b.errors![0].message, 'Variable $id is used by Q but not declared');
    const c = await gql(fake, 'query Q($id: ID) { product(id: $id) { id } }', { id: 'gid://shopify/Product/1' });
    assert.equal(c.errors![0].message, 'Nullability mismatch on variable $id and argument id (ID / ID!)');
  });

  it('rejects invalid literal arguments', async () => {
    const body = await gql(fake, '{ products(first: "ten") { nodes { id } } }');
    assert.equal(body.errors![0].extensions.code, 'argumentLiteralsIncompatible');
  });

  it('requires first or last on connections', async () => {
    const body = await gql(fake, '{ products { nodes { id } } }');
    assert.equal(body.errors![0].message, 'you must provide one of first or last');
    assert.deepEqual(body.errors![0].path, ['products']);
    assert.equal(body.data, null);
  });

  it('reports malformed global ids', async () => {
    const body = await gql(fake, '{ product(id: "123") { id } }');
    assert.equal(body.errors![0].message, "Invalid global id '123'");
  });

  it('does not support introspection (documented deviation)', async () => {
    const body = await gql(fake, '{ __schema { types { name } } }');
    assert.match(body.errors![0].message, /Introspection is not supported/);
  });
});

describe('execution semantics', () => {
  it('supports aliases, fragments, inline fragments, @include/@skip and __typename', async () => {
    const d = await data(
      fake,
      `query Q($withVariants: Boolean!, $skipTitle: Boolean = true) {
        first: products(first: 1) { nodes { ...P } }
        second: products(first: 1, reverse: true) { nodes { __typename title @skip(if: $skipTitle) } }
      }
      fragment P on Product {
        id
        variants(first: 1) @include(if: $withVariants) { nodes { price } }
        media(first: 1) { nodes { __typename ... on MediaImage { image { url } } } }
      }`,
      { withVariants: true },
    );
    assert.equal(d.first.nodes[0].variants.nodes[0].price, '49.00');
    assert.equal(d.first.nodes[0].media.nodes[0].__typename, 'MediaImage');
    assert.deepEqual(d.second.nodes[0], { __typename: 'Product' });
  });

  it('selects operations by name', async () => {
    const res = await fetch(fake.graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': fake.token },
      body: JSON.stringify({ query: 'query A { shop { name } } query B { shop { currencyCode } }', operationName: 'B' }),
    });
    assert.deepEqual((await res.json()).data, { shop: { currencyCode: 'EUR' } });
    const amb = await gql(fake, 'query A { shop { name } } query B { shop { currencyCode } }');
    assert.equal(amb.errors![0].message, 'An operation name is required');
  });

  it('resolves node / nodes across types', async () => {
    const d = await data(
      fake,
      `{ nodes(ids: ["gid://shopify/Product/9100000000001", "gid://shopify/Collection/480000000001", "gid://shopify/Product/1"]) {
          __typename
          ... on Product { title }
          ... on Collection { title }
        } }`,
    );
    assert.deepEqual(d.nodes, [{ __typename: 'Product', title: 'Vase „Kiesel“' }, { __typename: 'Collection', title: 'Wohnaccessoires' }, null]);
  });

  it('serialises Money, Decimal and DateTime like Shopify', async () => {
    const d = await data(fake, '{ product(id: "gid://shopify/Product/9100000000001") { createdAt priceRangeV2 { minVariantPrice { amount currencyCode } } variants(first: 1) { nodes { price compareAtPrice } } } }');
    assert.equal(d.product.createdAt, '2026-01-15T09:00:00Z');
    assert.deepEqual(d.product.priceRangeV2.minVariantPrice, { amount: '49.0', currencyCode: 'EUR' });
    assert.deepEqual(d.product.variants.nodes[0], { price: '49.00', compareAtPrice: null });
  });
});

describe('privacy', () => {
  it('denies customers and orders with ACCESS_DENIED', async () => {
    for (const q of ['{ customers(first: 5) { nodes { id email } } }', '{ orders(first: 5) { nodes { id totalPriceSet { shopMoney { amount } } } } }', '{ customer(id: "gid://shopify/Customer/1") { email } }']) {
      const body = await gql(fake, q);
      assert.equal(body.errors![0].extensions.code, 'ACCESS_DENIED', q);
      assert.match(body.errors![0].message, /^Access denied for \w+ field\. Required access: `read_(customers|orders)` access scope\.$/);
      assert.ok(body.errors![0].path);
    }
  });

  it('null-propagates a denied non-null root field', async () => {
    const body = await gql(fake, '{ shop { name } customers(first: 1) { nodes { id } } }');
    assert.equal(body.data, null);
    assert.equal(body.errors![0].extensions.code, 'ACCESS_DENIED');
  });

  it('keeps sibling data for nullable denied fields', async () => {
    const body = await gql(fake, '{ shop { name } order(id: "gid://shopify/Order/1") { id } }');
    assert.deepEqual(body.data, { shop: { name: 'Haus Holm' }, order: null });
  });

  it('enforces configured scopes on other resources too', async () => {
    const limited = await startFakeShopify({ accessScopes: ['read_products'] });
    try {
      const r = await limited.graphql<any>('mutation { productDelete(input: { id: "gid://shopify/Product/9100000000001" }) { deletedProductId } }');
      assert.equal(r.body.errors[0].extensions.code, 'ACCESS_DENIED');
      assert.equal(r.body.errors[0].extensions.requiredAccess, '`write_products` access scope.');
      assert.equal(limited.state.products.size, 3);
    } finally {
      await limited.close();
    }
  });
});

describe('CLI', () => {
  it('starts via `npx tsx test-support/shopify-fake/server.ts --port`', async () => {
    const serverPath = fileURLToPath(new URL('./server.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', serverPath, '--port', '0', '--quiet'], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let out = '';
        const timer = setTimeout(() => reject(new Error(`timeout, output: ${out}`)), 20000);
        child.stdout.on('data', (c) => {
          out += String(c);
          const m = /listening on (http:\/\/\S+)/.exec(out);
          if (m) {
            clearTimeout(timer);
            resolve(m[1]);
          }
        });
        child.on('exit', (code) => reject(new Error(`exited with ${code}: ${out}`)));
      });
      const res = await fetch(`${url}/admin/api/2026-10/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': 'shpat_fake_haus_holm_00000000000000000000' },
        body: JSON.stringify({ query: '{ shop { name } }' }),
      });
      assert.equal((await res.json()).data.shop.name, 'Haus Holm');
    } finally {
      child.kill('SIGTERM');
    }
  });
});
