/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Products, variants, media/files, staged uploads, collections and publishing.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { data, gql } from '../../../test-support/shopify-fake/helpers.test-util';
import { startFakeShopify, type FakeShopify } from '../../../test-support/shopify-fake/server';

let fake: FakeShopify;
const VASE = 'gid://shopify/Product/9100000000001';
const BECHER = 'gid://shopify/Product/9100000000002';
const PLAID = 'gid://shopify/Product/9100000000003';
const WOHN = 'gid://shopify/Collection/480000000001';
const KERAMIK = 'gid://shopify/Collection/480000000002';

before(async () => {
  fake = await startFakeShopify();
});
after(async () => {
  await fake.close();
});
beforeEach(() => fake.reset());

const PRODUCT_FIELDS = `
  id title handle descriptionHtml status vendor productType tags
  seo { title description }
  options { name values optionValues { name hasVariants } }
  variants(first: 10) { nodes { id title price compareAtPrice sku barcode inventoryQuantity selectedOptions { name value } } }
  media(first: 10) { nodes { id alt mediaContentType status ... on MediaImage { image { url altText } } } }
  collections(first: 10) { nodes { id title } }
`;

describe('seed', () => {
  it('contains the Haus Holm catalogue', async () => {
    const d = await data(fake, `{ products(first: 10) { nodes { ${PRODUCT_FIELDS} } } }`);
    const byTitle = Object.fromEntries(d.products.nodes.map((p: any) => [p.title, p]));
    assert.deepEqual(Object.keys(byTitle), ['Vase „Kiesel“', 'Becher „Morgen“', 'Plaid „Düne“']);
    assert.equal(byTitle['Vase „Kiesel“'].variants.nodes[0].price, '49.00');
    assert.equal(byTitle['Plaid „Düne“'].variants.nodes[0].price, '89.00');
    const becher = byTitle['Becher „Morgen“'];
    assert.equal(becher.variants.nodes.length, 4);
    assert.deepEqual(becher.options.map((o: any) => o.name), ['Farbe', 'Größe']);
    assert.deepEqual(becher.variants.nodes[0].selectedOptions, [
      { name: 'Farbe', value: 'Sand' },
      { name: 'Größe', value: '250 ml' },
    ]);
    assert.equal(becher.variants.nodes[0].title, 'Sand / 250 ml');
    assert.equal(becher.media.nodes.length, 2);
    assert.equal(byTitle['Vase „Kiesel“'].media.nodes[0].image.altText, null, 'seed contains an image without alt text');
    assert.deepEqual(
      byTitle['Vase „Kiesel“'].collections.nodes.map((c: any) => c.title).sort(),
      ['Keramik', 'Wohnaccessoires'],
    );
  });
});

describe('products query', () => {
  it('paginates with cursors in both directions', async () => {
    const p1 = await data(fake, '{ products(first: 2) { edges { cursor node { title } } pageInfo { hasNextPage hasPreviousPage startCursor endCursor } } }');
    assert.equal(p1.products.edges.length, 2);
    assert.deepEqual(p1.products.pageInfo.hasNextPage, true);
    assert.deepEqual(p1.products.pageInfo.hasPreviousPage, false);
    const p2 = await data(fake, 'query($after: String) { products(first: 2, after: $after) { nodes { title } pageInfo { hasNextPage hasPreviousPage } } }', { after: p1.products.pageInfo.endCursor });
    assert.deepEqual(p2.products.nodes.map((n: any) => n.title), ['Plaid „Düne“']);
    assert.deepEqual(p2.products.pageInfo, { hasNextPage: false, hasPreviousPage: true });
    const back = await data(fake, 'query($before: String) { products(last: 1, before: $before) { nodes { title } } }', { before: p1.products.pageInfo.endCursor });
    assert.deepEqual(back.products.nodes.map((n: any) => n.title), ['Vase „Kiesel“']);
  });

  it('supports sortKey and reverse', async () => {
    const d = await data(fake, '{ products(first: 3, sortKey: TITLE, reverse: true) { nodes { title } } }');
    assert.deepEqual(d.products.nodes.map((n: any) => n.title), ['Vase „Kiesel“', 'Plaid „Düne“', 'Becher „Morgen“']);
  });

  it('filters with Shopify search syntax', async () => {
    const titles = async (query: string) => (await data(fake, 'query($q: String) { products(first: 10, query: $q) { nodes { title } } }', { q: query })).products.nodes.map((n: any) => n.title);
    assert.deepEqual(await titles('tag:Keramik'), ['Vase „Kiesel“', 'Becher „Morgen“']);
    assert.deepEqual(await titles('-tag:Keramik'), ['Plaid „Düne“']);
    assert.deepEqual(await titles('tag_not:Keramik'), ['Plaid „Düne“']);
    assert.deepEqual(await titles('title:Vase*'), ['Vase „Kiesel“']);
    assert.deepEqual(await titles('sku:HH-PLAID-DUENE'), ['Plaid „Düne“']);
    assert.deepEqual(await titles('product_type:Becher OR product_type:Textil'), ['Becher „Morgen“', 'Plaid „Düne“']);
    assert.deepEqual(await titles('status:active,draft vendor:"Haus Holm" Kiesel'), ['Vase „Kiesel“']);
    assert.deepEqual(await titles(`id:>${9100000000001}`), ['Becher „Morgen“', 'Plaid „Düne“']);
    assert.deepEqual(await titles('status:archived'), []);
  });

  it('reports unknown search fields in extensions.search', async () => {
    const body = await gql(fake, '{ products(first: 5, query: "colour:red tag:Textil") { nodes { title } } }');
    assert.deepEqual(body.data.products.nodes, [{ title: 'Plaid „Düne“' }]);
    assert.deepEqual(body.extensions.search, [{ path: ['products'], query: 'colour:red tag:Textil', warnings: [{ field: 'colour', message: 'Invalid search field for this query.' }] }]);
  });

  it('returns null for unknown ids and supports productByIdentifier / productsCount', async () => {
    const d = await data(fake, '{ product(id: "gid://shopify/Product/1") { id } productByIdentifier(identifier: { handle: "plaid-duene" }) { title } productsCount(query: "tag:Keramik") { count precision } }');
    assert.equal(d.product, null);
    assert.equal(d.productByIdentifier.title, 'Plaid „Düne“');
    assert.deepEqual(d.productsCount, { count: 2, precision: 'EXACT' });
  });
});

const UPDATE = `mutation($product: ProductUpdateInput!) {
  productUpdate(product: $product) { product { id title handle descriptionHtml status tags seo { title description } templateSuffix } userErrors { field message } }
}`;

describe('productUpdate', () => {
  it('updates SEO, description, title, status and tags', async () => {
    const d = await data(fake, UPDATE, {
      product: { id: VASE, title: 'Vase „Kiesel“ groß', descriptionHtml: '<p>Neu</p>', seo: { title: 'Vase Kiesel', description: 'Handgedreht.' }, status: 'DRAFT', tags: ['Keramik', 'Neu', 'Keramik'] },
    });
    assert.deepEqual(d.productUpdate.userErrors, []);
    assert.deepEqual(d.productUpdate.product, {
      id: VASE,
      title: 'Vase „Kiesel“ groß',
      handle: 'vase-kiesel',
      descriptionHtml: '<p>Neu</p>',
      status: 'DRAFT',
      tags: ['Keramik', 'Neu'],
      seo: { title: 'Vase Kiesel', description: 'Handgedreht.' },
      templateSuffix: null,
    });
    const rec = fake.state.findProductByHandle('vase-kiesel')!;
    assert.equal(rec.seo.title, 'Vase Kiesel');
    assert.equal(rec.status, 'DRAFT');
  });

  it('still accepts the deprecated input: ProductInput argument', async () => {
    const d = await data(fake, 'mutation($input: ProductInput!) { productUpdate(input: $input) { product { title } userErrors { message } } }', { input: { id: PLAID, title: 'Plaid Düne' } });
    assert.equal(d.productUpdate.product.title, 'Plaid Düne');
  });

  it('returns userErrors for blank titles, taken handles and unknown products', async () => {
    const a = await data(fake, UPDATE, { product: { id: VASE, title: '' } });
    assert.deepEqual(a.productUpdate.userErrors, [{ field: ['title'], message: "Title can't be blank" }]);
    const b = await data(fake, UPDATE, { product: { id: VASE, handle: 'becher-morgen' } });
    assert.deepEqual(b.productUpdate.userErrors, [{ field: ['handle'], message: "Handle 'becher-morgen' already in use. Please provide a new handle." }]);
    const c = await data(fake, UPDATE, { product: { id: 'gid://shopify/Product/42', title: 'x' } });
    assert.deepEqual(c.productUpdate, { product: null, userErrors: [{ field: ['id'], message: 'Product does not exist' }] });
    assert.equal(fake.state.products.get(9100000000001)!.title, 'Vase „Kiesel“', 'failed updates do not write');
  });

  it('creates a redirect when the handle changes with redirectNewHandle', async () => {
    await data(fake, UPDATE, { product: { id: VASE, handle: 'Vase Kiesel Groß', redirectNewHandle: true } });
    const d = await data(fake, '{ product(id: "gid://shopify/Product/9100000000001") { handle } urlRedirects(first: 5) { nodes { path target } } }');
    assert.equal(d.product.handle, 'vase-kiesel-gross');
    assert.deepEqual(d.urlRedirects.nodes, [{ path: '/products/vase-kiesel', target: '/products/vase-kiesel-gross' }]);
  });

  it('joins and leaves manual collections and rejects smart ones', async () => {
    const created = await data(fake, 'mutation { collectionCreate(input: { title: "Sommer" }) { collection { id } } }');
    const sommer = created.collectionCreate.collection.id;
    const d = await data(fake, 'mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { product { collections(first: 5) { nodes { title } } } userErrors { field message } } }', {
      p: { id: PLAID, collectionsToJoin: [sommer], collectionsToLeave: [WOHN] },
    });
    assert.deepEqual(d.productUpdate.product.collections.nodes.map((c: any) => c.title), ['Sommer']);
    const e = await data(fake, 'mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { userErrors { field message } } }', { p: { id: PLAID, collectionsToJoin: [KERAMIK] } });
    assert.equal(e.productUpdate.userErrors[0].field[0], 'collectionsToJoin');
  });
});

describe('productCreate / productDelete', () => {
  it('creates a product with options (one variant) and deletes it again', async () => {
    const d = await data(
      fake,
      `mutation($product: ProductCreateInput!) { productCreate(product: $product) {
        product { id title handle status vendor onlineStoreUrl options { name values } variants(first: 5) { nodes { title price selectedOptions { name value } } } }
        userErrors { field message } } }`,
      { product: { title: 'Kerze „Ebbe“', productOptions: [{ name: 'Duft', values: [{ name: 'Salz' }, { name: 'Holz' }] }], tags: ['Duft'] } },
    );
    const p = d.productCreate.product;
    assert.equal(p.handle, 'kerze-ebbe');
    assert.equal(p.status, 'ACTIVE');
    assert.equal(p.vendor, 'Haus Holm');
    assert.equal(p.onlineStoreUrl, null, 'API-created products are not published to the Online Store');
    assert.deepEqual(p.options, [{ name: 'Duft', values: ['Salz'] }]);
    assert.deepEqual(p.variants.nodes, [{ title: 'Salz', price: '0.00', selectedOptions: [{ name: 'Duft', value: 'Salz' }] }]);

    const dup = await data(fake, 'mutation { productCreate(product: { title: "Kerze Ebbe" }) { product { handle } } }');
    assert.equal(dup.productCreate.product.handle, 'kerze-ebbe-1');

    const del = await data(fake, 'mutation($id: ID!) { productDelete(input: { id: $id }) { deletedProductId userErrors { message } } }', { id: p.id });
    assert.equal(del.productDelete.deletedProductId, p.id);
    const again = await data(fake, 'mutation($id: ID!) { productDelete(input: { id: $id }) { deletedProductId userErrors { field message } } }', { id: p.id });
    assert.deepEqual(again.productDelete, { deletedProductId: null, userErrors: [{ field: ['id'], message: 'Product does not exist' }] });
  });

  it('validates the title', async () => {
    const d = await data(fake, 'mutation { productCreate(product: { title: " " }) { product { id } userErrors { field message } } }');
    assert.deepEqual(d.productCreate, { product: null, userErrors: [{ field: ['title'], message: "Title can't be blank" }] });
  });

  it('publishes via publishablePublish', async () => {
    const created = await data(fake, 'mutation { productCreate(product: { title: "Schale" }) { product { id } } }');
    const pubs = await data(fake, '{ publications(first: 5) { nodes { id name } } }');
    assert.equal(pubs.publications.nodes[0].name, 'Online Store');
    const d = await data(fake, 'mutation($id: ID!, $pub: ID!) { publishablePublish(id: $id, input: [{ publicationId: $pub }]) { publishable { ... on Product { onlineStoreUrl publishedOnCurrentPublication } } userErrors { message } } }', {
      id: created.productCreate.product.id,
      pub: pubs.publications.nodes[0].id,
    });
    assert.deepEqual(d.publishablePublish.publishable, { onlineStoreUrl: 'https://haus-holm.myshopify.com/products/schale', publishedOnCurrentPublication: true });
  });
});

const BULK_UPDATE = `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    product { id }
    productVariants { id price compareAtPrice barcode sku inventoryItem { sku } }
    userErrors { field message code }
  }
}`;

describe('variants', () => {
  it('bulk-updates price, compareAtPrice, barcode and sku', async () => {
    const vid = 'gid://shopify/ProductVariant/51200000000001';
    const d = await data(fake, BULK_UPDATE, { productId: VASE, variants: [{ id: vid, price: '44.9', compareAtPrice: 49, barcode: '4000000000001', inventoryItem: { sku: 'HH-VASE-K2' } }] });
    assert.deepEqual(d.productVariantsBulkUpdate.userErrors, []);
    assert.deepEqual(d.productVariantsBulkUpdate.productVariants, [
      { id: vid, price: '44.90', compareAtPrice: '49.00', barcode: '4000000000001', sku: 'HH-VASE-K2', inventoryItem: { sku: 'HH-VASE-K2' } },
    ]);
    const clear = await data(fake, BULK_UPDATE, { productId: VASE, variants: [{ id: vid, compareAtPrice: null }] });
    assert.equal(clear.productVariantsBulkUpdate.productVariants[0].compareAtPrice, null);
  });

  it('is atomic and reports per-variant userErrors', async () => {
    const d = await data(fake, BULK_UPDATE, {
      productId: BECHER,
      variants: [
        { id: 'gid://shopify/ProductVariant/51200000000002', price: '19.00' },
        { id: 'gid://shopify/ProductVariant/51200000000001', price: '-1' },
        { id: 'gid://shopify/ProductVariant/51200000000003', inventoryQuantities: [{ availableQuantity: 3, locationId: 'gid://shopify/Location/71000000001' }] },
      ],
    });
    assert.equal(d.productVariantsBulkUpdate.productVariants, null);
    assert.deepEqual(
      d.productVariantsBulkUpdate.userErrors.map((e: any) => [e.field.join('.'), e.code]),
      [
        ['variants.1.id', 'PRODUCT_VARIANT_DOES_NOT_EXIST'],
        ['variants.2.inventoryQuantities', 'INVALID_INPUT'],
      ],
    );
    assert.equal(fake.state.variants.get(51200000000002)!.price, '18.00');
  });

  it('rejects invalid Money values at the variable level', async () => {
    const body = await gql(fake, BULK_UPDATE, { productId: VASE, variants: [{ id: 'gid://shopify/ProductVariant/51200000000001', price: 'zehn' }] });
    assert.match(body.errors![0].message, /for 0\.price \(Could not coerce value "zehn" to Money\)/);
  });

  it('bulk-creates variants with new option values and removes the standalone variant', async () => {
    const created = await data(fake, 'mutation { productCreate(product: { title: "Tuch", productOptions: [{ name: "Farbe", values: [{ name: "Grau" }] }] }) { product { id } } }');
    const id = created.productCreate.product.id;
    const d = await data(
      fake,
      `mutation($id: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkCreate(productId: $id, variants: $variants, strategy: REMOVE_STANDALONE_VARIANT) {
        product { options { name values } variants(first: 5) { nodes { title price inventoryQuantity } } } userErrors { field message code } } }`,
      {
        id,
        variants: [
          { optionValues: [{ optionName: 'Farbe', name: 'Blau' }], price: '25.00', inventoryQuantities: [{ availableQuantity: 4, locationId: 'gid://shopify/Location/71000000001' }] },
          { optionValues: [{ optionName: 'Farbe', name: 'Rot' }], price: '25.00' },
        ],
      },
    );
    assert.deepEqual(d.productVariantsBulkCreate.userErrors, []);
    assert.deepEqual(d.productVariantsBulkCreate.product.variants.nodes, [
      { title: 'Blau', price: '25.00', inventoryQuantity: 4 },
      { title: 'Rot', price: '25.00', inventoryQuantity: 0 },
    ]);
    assert.deepEqual(d.productVariantsBulkCreate.product.options[0].values, ['Blau', 'Rot']);
    const dup = await data(fake, 'mutation($id: ID!) { productVariantsBulkCreate(productId: $id, variants: [{ optionValues: [{ optionName: "Farbe", name: "Rot" }] }]) { userErrors { code } } }', { id });
    assert.equal(dup.productVariantsBulkCreate.userErrors[0].code, 'VARIANT_ALREADY_EXISTS');
  });
});

describe('media & files', () => {
  it('uploads via staged upload, processes asynchronously and serves the file', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000280000001e00806000000', 'hex');
    const staged = await data(fake, 'mutation($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }', {
      input: [{ resource: 'IMAGE', filename: 'vase-detail.png', mimeType: 'image/png', httpMethod: 'PUT' }],
    });
    const target = staged.stagedUploadsCreate.stagedTargets[0];
    assert.ok(target.parameters.some((p: any) => p.name === 'content_type'));
    const put = await fetch(target.url, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: png });
    assert.equal(put.status, 200);

    const created = await data(fake, 'mutation($id: ID!, $media: [CreateMediaInput!]!) { productCreateMedia(productId: $id, media: $media) { media { id alt status mediaContentType ... on MediaImage { image { url } } } mediaUserErrors { field message code } } }', {
      id: VASE,
      media: [{ originalSource: target.resourceUrl, mediaContentType: 'IMAGE', alt: 'Vase Detail' }],
    });
    const m = created.productCreateMedia.media[0];
    assert.equal(m.status, 'UPLOADED');
    assert.equal(m.image, null, 'image is null until processing finished');

    const later = await data(fake, 'query($id: ID!) { node(id: $id) { ... on MediaImage { status alt image { url altText width height } } } }', { id: m.id });
    assert.equal(later.node.status, 'READY');
    assert.equal(later.node.image.altText, 'Vase Detail');
    assert.deepEqual([later.node.image.width, later.node.image.height], [640, 480]);
    const file = await fetch(later.node.image.url);
    assert.equal(file.status, 200);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
  });

  it('accepts multipart POST uploads', async () => {
    const staged = await data(fake, 'mutation { stagedUploadsCreate(input: [{ resource: IMAGE, filename: "a.jpg", mimeType: "image/jpeg", httpMethod: POST }]) { stagedTargets { url resourceUrl parameters { name value } } } }');
    const t = staged.stagedUploadsCreate.stagedTargets[0];
    const form = new FormData();
    for (const p of t.parameters) form.append(p.name, p.value);
    form.append('file', new Blob([Buffer.from('jpegdata')], { type: 'image/jpeg' }), 'a.jpg');
    const res = await fetch(t.url, { method: 'POST', body: form });
    assert.equal(res.status, 201);
    assert.equal(fake.state.stagedUploads.values().next().value!.body!.toString(), 'jpegdata');
  });

  it('marks media FAILED when the staged upload never arrived', async () => {
    const staged = await data(fake, 'mutation { stagedUploadsCreate(input: [{ resource: IMAGE, filename: "x.jpg", mimeType: "image/jpeg" }]) { stagedTargets { resourceUrl } } }');
    const created = await data(fake, 'mutation($src: String!) { productCreateMedia(productId: "gid://shopify/Product/9100000000003", media: [{ originalSource: $src, mediaContentType: IMAGE }]) { media { id } } }', {
      src: staged.stagedUploadsCreate.stagedTargets[0].resourceUrl,
    });
    const d = await data(fake, 'query($id: ID!) { node(id: $id) { ... on MediaImage { status mediaErrors { code } image { url } } } }', { id: created.productCreateMedia.media[0].id });
    assert.deepEqual(d.node, { status: 'FAILED', mediaErrors: [{ code: 'IMAGE_DOWNLOAD_FAILURE' }], image: null });
  });

  it('updates alt text via fileUpdate', async () => {
    const mediaId = 'gid://shopify/MediaImage/32600000000001';
    const d = await data(fake, 'mutation($files: [FileUpdateInput!]!) { fileUpdate(files: $files) { files { id alt ... on MediaImage { image { altText } } } userErrors { field message code } } }', {
      files: [{ id: mediaId, alt: 'Vase Kiesel aus Steinzeug' }],
    });
    assert.deepEqual(d.fileUpdate.files, [{ id: mediaId, alt: 'Vase Kiesel aus Steinzeug', image: { altText: 'Vase Kiesel aus Steinzeug' } }]);
    const bad = await data(fake, 'mutation { fileUpdate(files: [{ id: "gid://shopify/MediaImage/1", alt: "x" }]) { files { id } userErrors { field message code } } }');
    assert.deepEqual(bad.fileUpdate.userErrors, [{ field: ['files', '0', 'id'], message: 'File id gid://shopify/MediaImage/1 does not exist.', code: 'FILE_DOES_NOT_EXIST' }]);
  });

  it('refuses to update files that are still processing', async () => {
    const created = await data(fake, 'mutation { fileCreate(files: [{ originalSource: "https://example.com/a.jpg", contentType: IMAGE }]) { files { id fileStatus } } }');
    assert.equal(created.fileCreate.files[0].fileStatus, 'UPLOADED');
    // simulate a client that updates in the same "tick": mark the file as created in the next request
    const id = Number(created.fileCreate.files[0].id.split('/').pop());
    fake.state.media.get(id)!.createdInRequest = fake.state.requestSeq + 1;
    const d = await data(fake, 'mutation($id: ID!) { fileUpdate(files: [{ id: $id, alt: "x" }]) { userErrors { code message } } }', { id: created.fileCreate.files[0].id });
    assert.deepEqual(d.fileUpdate.userErrors, [{ code: 'NON_READY_STATE', message: 'Non-ready files cannot be updated.' }]);
  });

  it('reorders and deletes product media', async () => {
    const [m1, m2] = ['gid://shopify/MediaImage/32600000000002', 'gid://shopify/MediaImage/32600000000003'];
    const r = await data(fake, 'mutation($id: ID!, $moves: [MoveInput!]!) { productReorderMedia(id: $id, moves: $moves) { job { id done } mediaUserErrors { message } } }', {
      id: BECHER,
      moves: [{ id: m2, newPosition: '0' }],
    });
    assert.equal(r.productReorderMedia.job.done, false);
    const order = await data(fake, `{ product(id: "${BECHER}") { media(first: 5) { nodes { id } } featuredMedia { id } } }`);
    assert.deepEqual(order.product.media.nodes.map((n: any) => n.id), [m2, m1]);
    assert.equal(order.product.featuredMedia.id, m2);
    const del = await data(fake, 'mutation($id: ID!, $ids: [ID!]!) { productDeleteMedia(productId: $id, mediaIds: $ids) { deletedMediaIds mediaUserErrors { field code } } }', { id: BECHER, ids: [m1] });
    assert.deepEqual(del.productDeleteMedia.deletedMediaIds, [m1]);
    const wrong = await data(fake, 'mutation($id: ID!, $ids: [ID!]!) { productDeleteMedia(productId: $id, mediaIds: $ids) { deletedMediaIds mediaUserErrors { field code } } }', { id: VASE, ids: [m2] });
    assert.deepEqual(wrong.productDeleteMedia.mediaUserErrors, [{ field: ['mediaIds', '0'], code: 'MEDIA_DOES_NOT_EXIST_ON_PRODUCT' }]);
  });

  it('rejects unsupported media types and invalid URLs', async () => {
    const d = await data(fake, `mutation { productCreateMedia(productId: "${VASE}", media: [{ originalSource: "not a url", mediaContentType: IMAGE }, { originalSource: "https://youtu.be/x", mediaContentType: EXTERNAL_VIDEO }]) { media { id } mediaUserErrors { field code } } }`);
    assert.deepEqual(d.productCreateMedia.mediaUserErrors, [
      { field: ['media', '0', 'originalSource'], code: 'INVALID' },
      { field: ['media', '1', 'mediaContentType'], code: 'INVALID_MEDIA_TYPE' },
    ]);
  });
});

describe('collections', () => {
  it('lists manual and smart collections with ruleSet and products', async () => {
    const d = await data(fake, '{ collections(first: 5) { nodes { id title handle sortOrder ruleSet { appliedDisjunctively rules { column relation condition } } products(first: 10) { nodes { title } } productsCount { count } } } }');
    const [wohn, keramik] = d.collections.nodes;
    assert.equal(wohn.ruleSet, null);
    assert.equal(wohn.products.nodes.length, 3);
    assert.deepEqual(keramik.ruleSet, { appliedDisjunctively: false, rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'Keramik' }] });
    assert.deepEqual(keramik.products.nodes.map((n: any) => n.title), ['Vase „Kiesel“', 'Becher „Morgen“']);
    const smart = await data(fake, '{ collections(first: 5, query: "collection_type:smart") { nodes { title } } }');
    assert.deepEqual(smart.collections.nodes, [{ title: 'Keramik' }]);
  });

  it('re-evaluates smart collections when products change', async () => {
    await data(fake, UPDATE, { product: { id: PLAID, tags: ['Keramik'] } });
    const d = await data(fake, `{ collection(id: "${KERAMIK}") { productsCount { count } hasProduct(id: "${PLAID}") } }`);
    assert.deepEqual(d.collection, { productsCount: { count: 3 }, hasProduct: true });
  });

  it('creates, updates and deletes collections', async () => {
    const c = await data(
      fake,
      `mutation($input: CollectionInput!) { collectionCreate(input: $input) { collection { id handle ruleSet { rules { column } } products(first: 5) { nodes { title } } } userErrors { field message } } }`,
      { input: { title: 'Unter 50 €', ruleSet: { appliedDisjunctively: false, rules: [{ column: 'VARIANT_PRICE', relation: 'LESS_THAN', condition: '50' }] } } },
    );
    assert.equal(c.collectionCreate.collection.handle, 'unter-50');
    assert.deepEqual(c.collectionCreate.collection.products.nodes.map((n: any) => n.title), ['Vase „Kiesel“', 'Becher „Morgen“']);
    const id = c.collectionCreate.collection.id;
    const u = await data(fake, 'mutation($input: CollectionInput!) { collectionUpdate(input: $input) { collection { title descriptionHtml seo { title } } userErrors { message } } }', {
      input: { id, title: 'Geschenke unter 50 €', descriptionHtml: '<p>Kleine Freuden</p>', seo: { title: 'Geschenke' } },
    });
    assert.deepEqual(u.collectionUpdate.collection, { title: 'Geschenke unter 50 €', descriptionHtml: '<p>Kleine Freuden</p>', seo: { title: 'Geschenke' } });
    const del = await data(fake, 'mutation($id: ID!) { collectionDelete(input: { id: $id }) { deletedCollectionId } }', { id });
    assert.equal(del.collectionDelete.deletedCollectionId, id);
  });

  it('validates smart collection rules', async () => {
    const d = await data(fake, 'mutation { collectionCreate(input: { title: "x", ruleSet: { appliedDisjunctively: false, rules: [{ column: TAG, relation: CONTAINS, condition: "a" }, { column: VARIANT_PRICE, relation: GREATER_THAN, condition: "abc" }] } }) { collection { id } userErrors { field message } } }');
    assert.equal(d.collectionCreate.collection, null);
    assert.deepEqual(d.collectionCreate.userErrors.map((e: any) => e.field.join('.')), ['ruleSet.rules.0.relation', 'ruleSet.rules.1.condition']);
  });

  it('adds and removes products on manual collections only', async () => {
    const created = await data(fake, `mutation { collectionCreate(input: { title: "Neu", products: ["${VASE}"] }) { collection { id } } }`);
    const id = created.collectionCreate.collection.id;
    const add = await data(fake, 'mutation($id: ID!, $p: [ID!]!) { collectionAddProducts(id: $id, productIds: $p) { collection { products(first: 5) { nodes { title } } } userErrors { message } } }', { id, p: [PLAID] });
    assert.deepEqual(add.collectionAddProducts.collection.products.nodes.map((n: any) => n.title), ['Vase „Kiesel“', 'Plaid „Düne“']);
    const rem = await data(fake, 'mutation($id: ID!, $p: [ID!]!) { collectionRemoveProducts(id: $id, productIds: $p) { job { id } userErrors { message } } }', { id, p: [VASE] });
    assert.ok(rem.collectionRemoveProducts.job.id.startsWith('gid://shopify/Job/'));
    assert.deepEqual(fake.state.collections.get(Number(id.split('/').pop()))!.productIds, [9100000000003]);
    const smart = await data(fake, 'mutation($id: ID!, $p: [ID!]!) { collectionAddProducts(id: $id, productIds: $p) { collection { id } userErrors { field message } } }', { id: KERAMIK, p: [PLAID] });
    assert.deepEqual(smart.collectionAddProducts.userErrors, [{ field: ['id'], message: "Can't manually add products to a smart collection" }]);
  });
});

describe('bulk operations', () => {
  it('runs a bulk query and serves JSONL with __parentId', async () => {
    const run = await data(fake, `mutation { bulkOperationRunQuery(query: """
      { products { edges { node { id title variants { edges { node { id sku } } } } } } }
    """) { bulkOperation { id status url } userErrors { field message } } }`);
    assert.equal(run.bulkOperationRunQuery.bulkOperation.status, 'CREATED');
    assert.equal(run.bulkOperationRunQuery.bulkOperation.url, null);
    const cur = await data(fake, '{ currentBulkOperation { id status objectCount rootObjectCount url } }');
    assert.equal(cur.currentBulkOperation.status, 'COMPLETED');
    assert.equal(cur.currentBulkOperation.rootObjectCount, '3');
    assert.equal(cur.currentBulkOperation.objectCount, '9');
    const lines = (await (await fetch(cur.currentBulkOperation.url)).text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 9);
    assert.deepEqual(lines[0], { id: VASE, title: 'Vase „Kiesel“' });
    assert.deepEqual(lines[1], { id: 'gid://shopify/ProductVariant/51200000000001', sku: 'HH-VASE-KIESEL', __parentId: VASE });
  });

  it('reports invalid bulk queries as userErrors', async () => {
    const d = await data(fake, 'mutation { bulkOperationRunQuery(query: "{ products { nodes { nope } } }") { bulkOperation { id } userErrors { field message code } } }');
    assert.deepEqual(d.bulkOperationRunQuery.userErrors, [{ field: ['query'], message: "Field 'nope' doesn't exist on type 'Product'", code: 'INVALID' }]);
  });
});
