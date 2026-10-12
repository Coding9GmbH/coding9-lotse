/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Pages, metafields, translations, discounts, themes and URL redirects.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { data, gql } from './helpers.test-util';
import { startFakeShopify, type FakeShopify } from './server';

let fake: FakeShopify;
const VASE = 'gid://shopify/Product/9100000000001';
const BECHER = 'gid://shopify/Product/9100000000002';
const WOHN = 'gid://shopify/Collection/480000000001';

before(async () => {
  fake = await startFakeShopify();
});
after(async () => {
  await fake.close();
});
beforeEach(() => fake.reset());

describe('pages', () => {
  it('lists the seeded page', async () => {
    const d = await data(fake, '{ pages(first: 5) { nodes { id title handle body bodySummary isPublished templateSuffix } } }');
    assert.equal(d.pages.nodes.length, 1);
    assert.deepEqual({ ...d.pages.nodes[0], id: undefined, body: undefined }, {
      id: undefined,
      title: 'Über uns',
      handle: 'ueber-uns',
      body: undefined,
      bodySummary: 'Haus Holm ist eine kleine Manufaktur an der Nordsee. Wir gestalten Dinge, die bleiben.',
      isPublished: true,
      templateSuffix: null,
    });
  });

  it('creates, updates and deletes pages', async () => {
    const c = await data(fake, 'mutation($page: PageCreateInput!) { pageCreate(page: $page) { page { id title handle body isPublished templateSuffix } userErrors { field message code } } }', {
      page: { title: 'Pflegehinweise', body: '<h2>Keramik</h2><p>Mit Wasser.</p>', isPublished: false, templateSuffix: 'lotse-x' },
    });
    assert.deepEqual(c.pageCreate.userErrors, []);
    const page = c.pageCreate.page;
    assert.deepEqual({ ...page, id: undefined }, { id: undefined, title: 'Pflegehinweise', handle: 'pflegehinweise', body: '<h2>Keramik</h2><p>Mit Wasser.</p>', isPublished: false, templateSuffix: 'lotse-x' });

    const u = await data(fake, 'mutation($id: ID!, $page: PageUpdateInput!) { pageUpdate(id: $id, page: $page) { page { title isPublished publishedAt } userErrors { field message code } } }', {
      id: page.id,
      page: { title: 'Pflege', isPublished: true },
    });
    assert.equal(u.pageUpdate.page.title, 'Pflege');
    assert.equal(u.pageUpdate.page.isPublished, true);
    assert.ok(u.pageUpdate.page.publishedAt);

    const taken = await data(fake, 'mutation($id: ID!) { pageUpdate(id: $id, page: { handle: "ueber-uns" }) { userErrors { field message code } } }', { id: page.id });
    assert.deepEqual(taken.pageUpdate.userErrors, [{ field: ['page', 'handle'], message: 'Handle has already been taken', code: 'TAKEN' }]);

    const del = await data(fake, 'mutation($id: ID!) { pageDelete(id: $id) { deletedPageId userErrors { code } } }', { id: page.id });
    assert.equal(del.pageDelete.deletedPageId, page.id);
    const missing = await data(fake, 'mutation($id: ID!) { pageDelete(id: $id) { deletedPageId userErrors { field code } } }', { id: page.id });
    assert.deepEqual(missing.pageDelete, { deletedPageId: null, userErrors: [{ field: ['id'], code: 'NOT_FOUND' }] });
  });

  it('validates blank titles', async () => {
    const d = await data(fake, 'mutation { pageCreate(page: { title: "" }) { page { id } userErrors { field message code } } }');
    assert.deepEqual(d.pageCreate.userErrors, [{ field: ['page', 'title'], message: "Title can't be blank", code: 'BLANK' }]);
  });

  it('searches pages', async () => {
    const d = await data(fake, '{ pages(first: 5, query: "title:Über*") { nodes { title } } a: pages(first: 5, query: "published_status:unpublished") { nodes { title } } }');
    assert.deepEqual(d.pages.nodes, [{ title: 'Über uns' }]);
    assert.deepEqual(d.a.nodes, []);
  });
});

const SET = `mutation($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) { metafields { id namespace key type value jsonValue ownerType compareDigest } userErrors { field message code elementIndex } }
}`;

describe('metafields', () => {
  it('sets and reads metafields on products, pages and the shop', async () => {
    const d = await data(fake, SET, {
      metafields: [
        { ownerId: VASE, namespace: 'custom', key: 'pflege', type: 'multi_line_text_field', value: 'Handwäsche\nNicht in die Mikrowelle' },
        { ownerId: VASE, namespace: 'custom', key: 'hoehe_cm', type: 'number_integer', value: '24' },
        { ownerId: 'gid://shopify/Page/129000000001', namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: 'Über Haus Holm' },
        { ownerId: 'gid://shopify/Shop/60123456789', namespace: 'lotse', key: 'settings', type: 'json', value: '{"a":1}' },
      ],
    });
    assert.deepEqual(d.metafieldsSet.userErrors, []);
    assert.equal(d.metafieldsSet.metafields[1].jsonValue, 24);
    assert.deepEqual(d.metafieldsSet.metafields[3].jsonValue, { a: 1 });
    assert.equal(d.metafieldsSet.metafields[3].ownerType, 'SHOP');
    const r = await data(fake, `{ product(id: "${VASE}") { material: metafield(namespace: "custom", key: "material") { value type } dotted: metafield(key: "custom.hoehe_cm") { value } metafields(first: 10, namespace: "custom") { nodes { key } } } shop { metafield(namespace: "lotse", key: "settings") { jsonValue } } }`);
    assert.deepEqual(r.product.material, { value: 'Steinzeug', type: 'single_line_text_field' });
    assert.deepEqual(r.product.dotted, { value: '24' });
    assert.deepEqual(r.product.metafields.nodes.map((n: any) => n.key), ['material', 'pflege', 'hoehe_cm']);
    assert.deepEqual(r.shop.metafield.jsonValue, { a: 1 });
  });

  it('validates types and values atomically', async () => {
    const d = await data(fake, SET, {
      metafields: [
        { ownerId: VASE, namespace: 'custom', key: 'ok', type: 'single_line_text_field', value: 'fine' },
        { ownerId: VASE, namespace: 'custom', key: 'zahl', type: 'number_integer', value: 'zwölf' },
        { ownerId: VASE, namespace: 'custom', key: 'ohne_typ', value: 'x' },
        { ownerId: 'gid://shopify/Product/1', namespace: 'custom', key: 'x', type: 'boolean', value: 'true' },
        { ownerId: VASE, namespace: 'custom', key: 'farbe', type: 'colour', value: '#fff' },
      ],
    });
    assert.equal(d.metafieldsSet.metafields, null);
    assert.deepEqual(
      d.metafieldsSet.userErrors.map((e: any) => [e.field.join('.'), e.code, e.elementIndex]),
      [
        ['metafields.1.value', 'INVALID_VALUE', 1],
        ['metafields.2.type', 'BLANK', 2],
        ['metafields.3.ownerId', 'INVALID', 3],
        ['metafields.4.type', 'INVALID_TYPE', 4],
      ],
    );
    assert.equal(fake.state.findMetafield(VASE, 'custom', 'ok'), undefined, 'nothing written');
  });

  it('honours compareDigest and type inheritance on update', async () => {
    const r = await data(fake, `{ product(id: "${VASE}") { metafield(namespace: "custom", key: "material") { compareDigest } } }`);
    const ok = await data(fake, SET, { metafields: [{ ownerId: VASE, namespace: 'custom', key: 'material', value: 'Porzellan', compareDigest: r.product.metafield.compareDigest }] });
    assert.equal(ok.metafieldsSet.metafields[0].value, 'Porzellan');
    assert.equal(ok.metafieldsSet.metafields[0].type, 'single_line_text_field');
    const stale = await data(fake, SET, { metafields: [{ ownerId: VASE, namespace: 'custom', key: 'material', value: 'Glas', compareDigest: r.product.metafield.compareDigest }] });
    assert.equal(stale.metafieldsSet.userErrors[0].code, 'STALE_OBJECT');
  });

  it('deletes metafields and returns null for missing ones', async () => {
    const d = await data(fake, 'mutation($m: [MetafieldIdentifierInput!]!) { metafieldsDelete(metafields: $m) { deletedMetafields { ownerId namespace key } userErrors { message } } }', {
      m: [
        { ownerId: VASE, namespace: 'custom', key: 'material' },
        { ownerId: VASE, namespace: 'custom', key: 'gibtsnicht' },
      ],
    });
    assert.deepEqual(d.metafieldsDelete.deletedMetafields, [{ ownerId: VASE, namespace: 'custom', key: 'material' }, null]);
  });
});

describe('translations', () => {
  it('lists shop locales', async () => {
    const d = await data(fake, '{ shopLocales { locale name primary published } }');
    assert.deepEqual(d.shopLocales, [
      { locale: 'de', name: 'German', primary: true, published: true },
      { locale: 'en', name: 'English', primary: false, published: true },
    ]);
  });

  it('registers, reads, detects outdated and removes translations', async () => {
    const r = await data(fake, `{ translatableResource(resourceId: "${VASE}") { resourceId translatableContent { key value digest locale type } translations(locale: "en") { key value } } }`);
    const content = r.translatableResource.translatableContent;
    assert.deepEqual(content.map((c: any) => `${c.key}:${c.type}`), ['title:SINGLE_LINE_TEXT_FIELD', 'body_html:HTML', 'handle:URI', 'product_type:SINGLE_LINE_TEXT_FIELD']);
    assert.equal(content[0].locale, 'de');
    const title = content.find((c: any) => c.key === 'title');
    const body = content.find((c: any) => c.key === 'body_html');

    const reg = await data(fake, 'mutation($id: ID!, $t: [TranslationInput!]!) { translationsRegister(resourceId: $id, translations: $t) { translations { key value locale outdated } userErrors { field message code } } }', {
      id: VASE,
      t: [
        { locale: 'en', key: 'title', value: 'Vase “Pebble”', translatableContentDigest: title.digest },
        { locale: 'en', key: 'body_html', value: '<p>Hand-thrown stoneware vase.</p>', translatableContentDigest: body.digest },
      ],
    });
    assert.deepEqual(reg.translationsRegister.userErrors, []);
    assert.equal(reg.translationsRegister.translations.length, 2);

    await data(fake, 'mutation { productUpdate(product: { id: "gid://shopify/Product/9100000000001", title: "Vase Kiesel XL" }) { userErrors { message } } }');
    const after1 = await data(fake, `{ product(id: "${VASE}") { translations(locale: "en") { key value outdated } } translatableResource(resourceId: "${VASE}") { translations(locale: "en", outdated: true) { key } } }`);
    assert.deepEqual(after1.product.translations, [
      { key: 'title', value: 'Vase “Pebble”', outdated: true },
      { key: 'body_html', value: '<p>Hand-thrown stoneware vase.</p>', outdated: false },
    ]);
    assert.deepEqual(after1.translatableResource.translations, [{ key: 'title' }]);

    const rm = await data(fake, 'mutation($id: ID!) { translationsRemove(resourceId: $id, translationKeys: ["title"], locales: ["en"]) { translations { key value } userErrors { message } } }', { id: VASE });
    assert.deepEqual(rm.translationsRemove.translations, [{ key: 'title', value: 'Vase “Pebble”' }]);
    assert.equal(fake.state.translations.filter((t) => t.resourceId === VASE).length, 1);
  });

  it('rejects wrong digests, unknown keys, primary and unknown locales', async () => {
    const d = await data(fake, 'mutation($id: ID!, $t: [TranslationInput!]!) { translationsRegister(resourceId: $id, translations: $t) { translations { key } userErrors { field code } } }', {
      id: VASE,
      t: [
        { locale: 'en', key: 'title', value: 'x', translatableContentDigest: 'nope' },
        { locale: 'de', key: 'title', value: 'x', translatableContentDigest: 'nope' },
        { locale: 'fr', key: 'tagline', value: 'x', translatableContentDigest: 'nope' },
      ],
    });
    assert.equal(d.translationsRegister.translations, null);
    assert.deepEqual(
      d.translationsRegister.userErrors.map((e: any) => `${e.field.join('.')}:${e.code}`),
      [
        'translations.0.translatableContentDigest:INVALID_TRANSLATABLE_CONTENT',
        'translations.1.locale:INVALID_LOCALE_FOR_SHOP',
        'translations.1.translatableContentDigest:INVALID_TRANSLATABLE_CONTENT',
        'translations.2.locale:INVALID_LOCALE_FOR_SHOP',
        'translations.2.key:INVALID_KEY_FOR_MODEL',
      ],
    );
  });

  it('paginates translatable resources by type, including pages and collections', async () => {
    const d = await data(fake, '{ p: translatableResources(first: 2, resourceType: PRODUCT) { nodes { resourceId } pageInfo { hasNextPage } } pages: translatableResources(first: 5, resourceType: ONLINE_STORE_PAGE) { nodes { resourceId translatableContent { key } } } c: translatableResources(first: 5, resourceType: COLLECTION) { nodes { resourceId } } }');
    assert.equal(d.p.nodes.length, 2);
    assert.equal(d.p.pageInfo.hasNextPage, true);
    assert.deepEqual(d.pages.nodes[0].translatableContent.map((c: any) => c.key), ['title', 'body_html', 'handle']);
    assert.equal(d.c.nodes.length, 2);
  });
});

const DISCOUNT_FIELDS = `
  id
  codeDiscount {
    __typename
    ... on DiscountCodeBasic {
      title status summary startsAt endsAt usageLimit appliesOncePerCustomer
      codes(first: 5) { nodes { code } }
      customerGets {
        value { __typename ... on DiscountPercentage { percentage } ... on DiscountAmount { amount { amount currencyCode } appliesOnEachItem } }
        items { __typename ... on AllDiscountItems { allItems } ... on DiscountCollections { collections(first: 5) { nodes { title } } } ... on DiscountProducts { products(first: 5) { nodes { title } } } }
      }
      minimumRequirement { __typename ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount currencyCode } } ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity } }
      context { __typename ... on DiscountBuyerSelectionAll { all } }
    }
  }
`;

const CREATE_DISCOUNT = `mutation($d: DiscountCodeBasicInput!) { discountCodeBasicCreate(basicCodeDiscount: $d) { codeDiscountNode { ${DISCOUNT_FIELDS} } userErrors { field message code } } }`;

describe('discounts', () => {
  const base = {
    title: 'Herbst 15',
    code: 'HERBST15',
    startsAt: '2026-01-01T00:00:00Z',
    endsAt: '2036-01-01T00:00:00Z',
    context: { all: 'ALL' },
    customerGets: { value: { percentage: 0.15 }, items: { collections: { add: [WOHN] } } },
    minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: '50.00' } },
    usageLimit: 100,
    appliesOncePerCustomer: true,
  };

  it('creates a percentage code discount for a collection with minimum subtotal', async () => {
    const d = await data(fake, CREATE_DISCOUNT, { d: base });
    assert.deepEqual(d.discountCodeBasicCreate.userErrors, []);
    const c = d.discountCodeBasicCreate.codeDiscountNode.codeDiscount;
    assert.equal(c.__typename, 'DiscountCodeBasic');
    assert.equal(c.status, 'ACTIVE');
    assert.equal(c.summary, '15% off 1 collection • Minimum purchase of €50.00 • One use per customer • Limit of 100 uses');
    assert.deepEqual(c.codes.nodes, [{ code: 'HERBST15' }]);
    assert.deepEqual(c.customerGets.value, { __typename: 'DiscountPercentage', percentage: 0.15 });
    assert.deepEqual(c.customerGets.items, { __typename: 'DiscountCollections', collections: { nodes: [{ title: 'Wohnaccessoires' }] } });
    assert.deepEqual(c.minimumRequirement, { __typename: 'DiscountMinimumSubtotal', greaterThanOrEqualToSubtotal: { amount: '50.0', currencyCode: 'EUR' } });
    assert.deepEqual(c.context, { __typename: 'DiscountBuyerSelectionAll', all: 'ALL' });
  });

  it('validates percentage range, duplicate codes, dates and missing fields', async () => {
    await data(fake, CREATE_DISCOUNT, { d: base });
    const d = await data(fake, CREATE_DISCOUNT, {
      d: { ...base, customerGets: { value: { percentage: 15 }, items: { all: true } }, endsAt: '2025-01-01T00:00:00Z' },
    });
    assert.equal(d.discountCodeBasicCreate.codeDiscountNode, null);
    assert.deepEqual(
      d.discountCodeBasicCreate.userErrors.map((e: any) => [e.field.join('.'), e.code]),
      [
        ['basicCodeDiscount.code', 'TAKEN'],
        ['basicCodeDiscount.endsAt', 'INVALID'],
        ['basicCodeDiscount.customerGets.value.percentage', 'VALUE_OUTSIDE_RANGE'],
      ],
    );
    const empty = await data(fake, CREATE_DISCOUNT, { d: { title: '' } });
    assert.deepEqual(
      empty.discountCodeBasicCreate.userErrors.map((e: any) => e.field.join('.')),
      ['basicCodeDiscount.title', 'basicCodeDiscount.code', 'basicCodeDiscount.startsAt', 'basicCodeDiscount.context', 'basicCodeDiscount.customerGets'],
    );
  });

  it('queries, updates and deletes code discounts', async () => {
    const created = await data(fake, CREATE_DISCOUNT, { d: base });
    const id = created.discountCodeBasicCreate.codeDiscountNode.id;
    const list = await data(fake, `{ codeDiscountNodes(first: 5, query: "status:active") { nodes { ${DISCOUNT_FIELDS} } } byCode: codeDiscountNodeByCode(code: "herbst15") { id } }`);
    assert.equal(list.codeDiscountNodes.nodes.length, 1);
    assert.equal(list.byCode.id, id);
    const upd = await data(fake, `mutation($id: ID!, $d: DiscountCodeBasicInput!) { discountCodeBasicUpdate(id: $id, basicCodeDiscount: $d) { codeDiscountNode { ${DISCOUNT_FIELDS} } userErrors { field message } } }`, {
      id,
      d: { customerGets: { value: { discountAmount: { amount: '5.00', appliesOnEachItem: false } }, items: { products: { productsToAdd: [BECHER] } } }, minimumRequirement: { quantity: { greaterThanOrEqualToQuantity: '2' } }, startsAt: '2035-01-01T00:00:00Z' },
    });
    const c = upd.discountCodeBasicUpdate.codeDiscountNode.codeDiscount;
    assert.equal(c.status, 'SCHEDULED');
    assert.deepEqual(c.customerGets.value, { __typename: 'DiscountAmount', amount: { amount: '5.0', currencyCode: 'EUR' }, appliesOnEachItem: false });
    assert.deepEqual(c.customerGets.items.products.nodes, [{ title: 'Becher „Morgen“' }]);
    assert.deepEqual(c.minimumRequirement, { __typename: 'DiscountMinimumQuantity', greaterThanOrEqualToQuantity: '2' });
    const del = await data(fake, 'mutation($id: ID!) { discountCodeDelete(id: $id) { deletedCodeDiscountId userErrors { message } } }', { id });
    assert.equal(del.discountCodeDelete.deletedCodeDiscountId, id);
    assert.equal(fake.state.discounts.size, 0);
  });
});

describe('themes', () => {
  const MAIN = 'gid://shopify/OnlineStoreTheme/151000000001';
  const UPSERT = `mutation($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    themeFilesUpsert(themeId: $themeId, files: $files) { upsertedThemeFiles { filename } job { id } userErrors { field message code filename } }
  }`;

  it('finds the main theme and reads JSON templates', async () => {
    const d = await data(fake, '{ themes(first: 5, roles: [MAIN]) { nodes { id name role files(filenames: ["templates/*.json", "templates/missing.json"]) { nodes { filename contentType body { ... on OnlineStoreThemeFileBodyText { content } } } userErrors { filename code } } } } }');
    assert.equal(d.themes.nodes.length, 1);
    const theme = d.themes.nodes[0];
    assert.equal(theme.id, MAIN);
    assert.equal(theme.role, 'MAIN');
    assert.deepEqual(theme.files.nodes.map((f: any) => f.filename), ['templates/collection.json', 'templates/index.json', 'templates/page.json', 'templates/product.json']);
    assert.deepEqual(theme.files.userErrors, [{ filename: 'templates/missing.json', code: 'NOT_FOUND' }]);
    const index = JSON.parse(theme.files.nodes[1].body.content);
    assert.deepEqual(index.order, ['image_banner', 'featured_collection']);
  });

  it('upserts a section and a page template that uses it, then assigns it to a page', async () => {
    const section = `<section class="lotse-x">{{ section.settings.heading }}</section>\n{% schema %}\n{"name":"Lotse X","settings":[{"type":"text","id":"heading","label":"Überschrift"}],"presets":[{"name":"Lotse X"}]}\n{% endschema %}\n`;
    const template = JSON.stringify({ sections: { main: { type: 'lotse-x', settings: { heading: 'Hallo' } } }, order: ['main'] });
    const d = await data(fake, UPSERT, {
      themeId: MAIN,
      files: [
        { filename: 'templates/page.lotse-x.json', body: { type: 'TEXT', value: `/* Generated by Lotse */\n${template}` } },
        { filename: 'sections/lotse-x.liquid', body: { type: 'BASE64', value: Buffer.from(section).toString('base64') } },
      ],
    });
    assert.deepEqual(d.themeFilesUpsert.userErrors, []);
    assert.deepEqual(d.themeFilesUpsert.upsertedThemeFiles, [{ filename: 'templates/page.lotse-x.json' }, { filename: 'sections/lotse-x.liquid' }]);
    assert.equal(fake.state.themeFileText(151000000001, 'sections/lotse-x.liquid'), section);
    const read = await data(fake, `{ theme(id: "${MAIN}") { files(filenames: ["sections/lotse-x.liquid"]) { nodes { body { ... on OnlineStoreThemeFileBodyText { content } } checksumMd5 size } } } }`);
    assert.equal(read.theme.files.nodes[0].body.content, section);
    assert.equal(read.theme.files.nodes[0].size, String(Buffer.byteLength(section)));

    const page = await data(fake, 'mutation { pageUpdate(id: "gid://shopify/Page/129000000001", page: { templateSuffix: "lotse-x" }) { page { templateSuffix } } }');
    assert.equal(page.pageUpdate.page.templateSuffix, 'lotse-x');
  });

  it('validates JSON templates, section references and liquid schema', async () => {
    const d = await data(fake, UPSERT, {
      themeId: MAIN,
      files: [
        { filename: 'templates/page.kaputt.json', body: { type: 'TEXT', value: '{ "sections": ' } },
        { filename: 'templates/page.fehlt.json', body: { type: 'TEXT', value: JSON.stringify({ sections: { a: { type: 'gibts-nicht' } }, order: ['a'] }) } },
        { filename: 'sections/schema.liquid', body: { type: 'TEXT', value: '{% schema %}{ invalid }{% endschema %}' } },
        { filename: 'secrets/x.txt', body: { type: 'TEXT', value: 'x' } },
        { filename: 'snippets/ok.liquid', body: { type: 'TEXT', value: '{% if true %}ok{% endif %}' } },
      ],
    });
    assert.deepEqual(d.themeFilesUpsert.upsertedThemeFiles, [{ filename: 'snippets/ok.liquid' }]);
    assert.deepEqual(
      d.themeFilesUpsert.userErrors.map((e: any) => [e.filename, e.code]),
      [
        ['secrets/x.txt', 'INVALID'],
        ['templates/page.kaputt.json', 'FILE_VALIDATION_ERROR'],
        ['templates/page.fehlt.json', 'FILE_VALIDATION_ERROR'],
        ['sections/schema.liquid', 'FILE_VALIDATION_ERROR'],
      ],
    );
    assert.match(d.themeFilesUpsert.userErrors[2].message, /Section type 'gibts-nicht' does not refer to an existing section file/);
  });

  it('deletes theme files but protects required ones', async () => {
    const d = await data(fake, `mutation { themeFilesDelete(themeId: "${MAIN}", files: ["templates/page.json", "layout/theme.liquid", "assets/nope.css"]) { deletedThemeFiles { filename } userErrors { filename code } } }`);
    assert.deepEqual(d.themeFilesDelete.deletedThemeFiles, [{ filename: 'templates/page.json' }]);
    assert.deepEqual(d.themeFilesDelete.userErrors, [
      { filename: 'layout/theme.liquid', code: 'INVALID' },
      { filename: 'assets/nope.css', code: 'NOT_FOUND' },
    ]);
  });

  it('can simulate a missing theme write exemption for the live theme', async () => {
    const strict = await startFakeShopify({ themeWriteAccess: 'unpublished-only' });
    try {
      const r = await strict.graphql<any>(UPSERT, { themeId: MAIN, files: [{ filename: 'snippets/a.liquid', body: { type: 'TEXT', value: 'a' } }] });
      assert.equal(r.body.data.themeFilesUpsert.userErrors[0].code, 'ACCESS_DENIED');
      const ok = await strict.graphql<any>(UPSERT, { themeId: 'gid://shopify/OnlineStoreTheme/151000000002', files: [{ filename: 'snippets/a.liquid', body: { type: 'TEXT', value: 'a' } }] });
      assert.deepEqual(ok.body.data.themeFilesUpsert.userErrors, []);
    } finally {
      await strict.close();
    }
  });
});

describe('url redirects', () => {
  it('creates, lists, updates and deletes redirects', async () => {
    const c = await data(fake, 'mutation { urlRedirectCreate(urlRedirect: { path: "/alt", target: "/pages/ueber-uns" }) { urlRedirect { id path target } userErrors { field message code } } }');
    const id = c.urlRedirectCreate.urlRedirect.id;
    const dup = await data(fake, 'mutation { urlRedirectCreate(urlRedirect: { path: "/alt", target: "/x" }) { urlRedirect { id } userErrors { field message code } } }');
    assert.deepEqual(dup.urlRedirectCreate.userErrors, [{ field: ['urlRedirect', 'path'], message: 'Path has already been taken', code: 'CREATE_FAILED' }]);
    const list = await data(fake, '{ urlRedirects(first: 5, query: "path:/alt") { nodes { path target } } }');
    assert.deepEqual(list.urlRedirects.nodes, [{ path: '/alt', target: '/pages/ueber-uns' }]);
    const u = await data(fake, 'mutation($id: ID!) { urlRedirectUpdate(id: $id, urlRedirect: { target: "/" }) { urlRedirect { target } userErrors { message } } }', { id });
    assert.equal(u.urlRedirectUpdate.urlRedirect.target, '/');
    const d = await data(fake, 'mutation($id: ID!) { urlRedirectDelete(id: $id) { deletedUrlRedirectId } }', { id });
    assert.equal(d.urlRedirectDelete.deletedUrlRedirectId, id);
  });
});

describe('state', () => {
  it('exposes a JSON snapshot over HTTP and resets', async () => {
    await data(fake, 'mutation { pageCreate(page: { title: "Temp" }) { page { id } } }');
    const snap = await (await fetch(`${fake.url}/__fake/state`)).json();
    assert.equal(snap.pages.length, 2);
    assert.ok(snap.themes[0].files['templates/index.json']);
    await fetch(`${fake.url}/__fake/reset`, { method: 'POST' });
    assert.equal(fake.state.pages.size, 1);
    const body = await gql(fake, '{ pagesCount { count } }');
    assert.equal(body.data.pagesCount.count, 1);
  });
});
