/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ResolveInfo } from '../graphql';
import { type ConnArgs, type Ctx, idOf, metafieldResolvers, ONLINE_STORE_PUBLICATION_ID, paginate, safeIdOf, search, sortBy, stripHtml, truncate, ue, type UE } from '../context';
import type { SearchSpec } from '../search';
import { gid, handleize, isoNow, type CollectionRec, type ProductRec, type RuleRec } from '../state';
import { ownerMetafieldInputs, setMetafields } from './metafields';
import { addRedirect, newJob } from './products';
import { translationsFor } from './translations';

export const collectionSearchSpec = (ctx: Ctx): SearchSpec<CollectionRec> => ({
  fields: {
    title: { kind: 'text', get: (c) => c.title },
    handle: { kind: 'keyword', get: (c) => c.handle },
    collection_type: { kind: 'keyword', get: (c) => (c.ruleSet ? 'smart' : 'custom') },
    id: { kind: 'number', get: (c) => c.id },
    updated_at: { kind: 'date', get: (c) => c.updatedAt },
    product_id: { kind: 'number', get: (c) => ctx.state.collectionProducts(c).map((p) => p.id) },
    published_status: { kind: 'keyword', get: (c) => ['any', c.published ? 'published' : 'unpublished'] },
  },
  freeText: (c) => [c.title, c.handle],
});

export function sortCollections(list: CollectionRec[], sortKey?: string | null): CollectionRec[] {
  if (sortKey === 'TITLE') return sortBy(list, (c) => c.title, (c) => c.id);
  if (sortKey === 'UPDATED_AT') return sortBy(list, (c) => c.updatedAt, (c) => c.id);
  return sortBy(list, (c) => c.id, (c) => c.id);
}

function minPrice(p: ProductRec, ctx: Ctx): number {
  const prices = ctx.state.productVariants(p).map((v) => Number(v.price));
  return prices.length ? Math.min(...prices) : 0;
}

function collectionProductsSorted(c: CollectionRec, sortKey: string | null | undefined, ctx: Ctx): ProductRec[] {
  const list = ctx.state.collectionProducts(c);
  const key = sortKey && sortKey !== 'COLLECTION_DEFAULT' ? sortKey : c.sortOrder;
  switch (key) {
    case 'MANUAL':
      return c.ruleSet ? sortBy(list, (p) => p.id, (p) => p.id) : list;
    case 'TITLE':
    case 'ALPHA_ASC':
      return sortBy(list, (p) => p.title, (p) => p.id);
    case 'ALPHA_DESC':
      return sortBy(list, (p) => p.title, (p) => p.id).reverse();
    case 'PRICE':
    case 'PRICE_ASC':
      return sortBy(list, (p) => minPrice(p, ctx), (p) => p.id);
    case 'PRICE_DESC':
      return sortBy(list, (p) => minPrice(p, ctx), (p) => p.id).reverse();
    case 'CREATED':
      return sortBy(list, (p) => p.createdAt, (p) => p.id);
    case 'CREATED_DESC':
      return sortBy(list, (p) => p.createdAt, (p) => p.id).reverse();
    default:
      return sortBy(list, (p) => p.id, (p) => p.id);
  }
}

export const collectionTypes = {
  Collection: {
    id: (c: CollectionRec) => gid('Collection', c.id),
    legacyResourceId: (c: CollectionRec) => String(c.id),
    description: (c: CollectionRec, a: { truncateAt?: number | null }) => truncate(stripHtml(c.descriptionHtml), a.truncateAt),
    image: (c: CollectionRec) =>
      c.image ? { id: gid('CollectionImage', c.image.id), url: c.image.url, altText: c.image.altText, width: 1024, height: 1024, originalSrc: c.image.url, src: c.image.url, transformedSrc: c.image.url } : null,
    ruleSet: (c: CollectionRec) => c.ruleSet,
    products: (c: CollectionRec, a: ConnArgs & { sortKey?: string }, ctx: Ctx) => paginate(collectionProductsSorted(c, a.sortKey, ctx), a, ctx, (p) => p.id),
    productsCount: (c: CollectionRec, _: unknown, ctx: Ctx) => ({ count: ctx.state.collectionProducts(c).length, precision: 'EXACT' }),
    hasProduct: (c: CollectionRec, a: { id: string }, ctx: Ctx) => {
      const id = idOf(a.id, 'Product');
      return ctx.state.collectionProducts(c).some((p) => p.id === id);
    },
    onlineStoreUrl: (c: CollectionRec, _: unknown, ctx: Ctx) => (c.published ? `${ctx.state.shop.primaryDomainUrl}/collections/${c.handle}` : null),
    publishedOnCurrentPublication: (c: CollectionRec) => c.published,
    publishedOnPublication: (c: CollectionRec, a: { publicationId: string }) => c.published && safeIdOf(a.publicationId, 'Publication') === ONLINE_STORE_PUBLICATION_ID,
    ...metafieldResolvers((c: CollectionRec) => gid('Collection', c.id)),
    translations: (c: CollectionRec, a: { locale: string; marketId?: string | null }, ctx: Ctx) => translationsFor(gid('Collection', c.id), a.locale, ctx, a.marketId),
  },
};

export const collectionQueries = {
  collections: (_: unknown, a: ConnArgs & { query?: string; sortKey?: string }, ctx: Ctx, info: ResolveInfo) => {
    const list = search(sortCollections([...ctx.state.collections.values()], a.sortKey), a.query, collectionSearchSpec(ctx), ctx, info);
    return paginate(list, a, ctx, (c) => c.id);
  },
  collection: (_: unknown, a: { id: string }, ctx: Ctx) => {
    const id = idOf(a.id, 'Collection');
    return id !== null ? (ctx.state.collections.get(id) ?? null) : null;
  },
  collectionByHandle: (_: unknown, a: { handle: string }, ctx: Ctx) => ctx.state.findCollectionByHandle(a.handle) ?? null,
  collectionsCount: (_: unknown, a: { query?: string; limit?: number }, ctx: Ctx, info: ResolveInfo) => {
    const n = search([...ctx.state.collections.values()], a.query, collectionSearchSpec(ctx), ctx, info).length;
    const limit = a.limit ?? 10000;
    return { count: Math.min(n, limit), precision: n > limit ? 'AT_LEAST' : 'EXACT' };
  },
};

const TEXT_COLUMNS = new Set(['TITLE', 'TYPE', 'VENDOR', 'VARIANT_TITLE']);
const NUMBER_COLUMNS = new Set(['VARIANT_PRICE', 'VARIANT_COMPARE_AT_PRICE', 'VARIANT_WEIGHT', 'VARIANT_INVENTORY']);
const TEXT_RELATIONS = new Set(['EQUALS', 'NOT_EQUALS', 'STARTS_WITH', 'ENDS_WITH', 'CONTAINS', 'NOT_CONTAINS']);
const NUMBER_RELATIONS = new Set(['EQUALS', 'NOT_EQUALS', 'GREATER_THAN', 'LESS_THAN']);

function validateRuleSet(rs: any, errors: UE[]): { appliedDisjunctively: boolean; rules: RuleRec[] } | null {
  if (!rs) return null;
  const rules: RuleRec[] = [];
  const list: any[] = rs.rules ?? [];
  if (!list.length) errors.push(ue(['ruleSet', 'rules'], 'Smart collections must have at least one rule'));
  if (list.length > 60) errors.push(ue(['ruleSet', 'rules'], 'Smart collections can have at most 60 rules'));
  list.forEach((r, i) => {
    if (!String(r.condition ?? '').trim() && r.relation !== 'IS_SET' && r.relation !== 'IS_NOT_SET') errors.push(ue(['ruleSet', 'rules', i, 'condition'], "Condition can't be blank"));
    if (TEXT_COLUMNS.has(r.column) && !TEXT_RELATIONS.has(r.relation)) errors.push(ue(['ruleSet', 'rules', i, 'relation'], `Relation ${r.relation} is not valid for column ${r.column}`));
    if (NUMBER_COLUMNS.has(r.column)) {
      if (!NUMBER_RELATIONS.has(r.relation)) errors.push(ue(['ruleSet', 'rules', i, 'relation'], `Relation ${r.relation} is not valid for column ${r.column}`));
      if (Number.isNaN(Number(r.condition))) errors.push(ue(['ruleSet', 'rules', i, 'condition'], 'Condition must be a number'));
    }
    if (r.column === 'TAG' && r.relation !== 'EQUALS' && r.relation !== 'NOT_EQUALS') errors.push(ue(['ruleSet', 'rules', i, 'relation'], `Relation ${r.relation} is not valid for column TAG`));
    if (r.column === 'IS_PRICE_REDUCED' && r.condition !== 'true' && r.condition !== 'false') errors.push(ue(['ruleSet', 'rules', i, 'condition'], 'Condition must be true or false'));
    if (r.column === 'PRODUCT_METAFIELD_DEFINITION' || r.column === 'VARIANT_METAFIELD_DEFINITION' || r.column === 'PRODUCT_TAXONOMY_NODE_ID' || r.column === 'PRODUCT_CATEGORY_ID') {
      errors.push(ue(['ruleSet', 'rules', i, 'column'], `The Shopify fake does not support rule column ${r.column}`));
    }
    rules.push({ column: r.column, relation: r.relation, condition: String(r.condition ?? '') });
  });
  return { appliedDisjunctively: Boolean(rs.appliedDisjunctively), rules };
}

function productIdsFrom(ids: string[] | null | undefined, ctx: Ctx, errors: UE[], field: string): number[] {
  const out: number[] = [];
  (ids ?? []).forEach((raw, i) => {
    const id = safeIdOf(raw, 'Product');
    if (id === null || !ctx.state.products.has(id)) errors.push(ue([field, String(i)], `Product ${raw} does not exist`));
    else if (!out.includes(id)) out.push(id);
  });
  return out;
}

function imageFrom(input: any, ctx: Ctx, errors: UE[]): CollectionRec['image'] | undefined {
  if (input.image === undefined) return undefined;
  if (input.image === null) return null;
  if (input.image.src && !/^https?:\/\//.test(input.image.src)) {
    errors.push(ue(['image', 'src'], 'Image URL is invalid'));
    return undefined;
  }
  return { url: input.image.src ?? '', altText: input.image.altText ?? null, id: ctx.state.nextId('ProductImage') };
}

export const collectionMutations = {
  collectionCreate: (_: unknown, a: { input: any }, ctx: Ctx) => {
    const input = a.input;
    const errors: UE[] = [];
    if (input.id) errors.push(ue(['id'], 'Collection creation does not accept an id'));
    if (!input.title || !String(input.title).trim()) errors.push(ue(['title'], "Title can't be blank"));
    let handle: string | null = null;
    if (input.handle) {
      handle = handleize(input.handle);
      if (!handle) errors.push(ue(['handle'], 'Handle is invalid'));
      else if (ctx.state.handleTaken('collection', handle)) errors.push(ue(['handle'], `Handle '${handle}' already in use. Please provide a new handle.`));
    }
    const ruleSet = validateRuleSet(input.ruleSet, errors);
    if (ruleSet && input.products?.length) errors.push(ue(['products'], "Products can't be added manually to a smart collection"));
    const productIds = productIdsFrom(input.products, ctx, errors, 'products');
    const image = imageFrom(input, ctx, errors);
    if (errors.length) return { collection: null, userErrors: errors };
    const now = isoNow();
    const c: CollectionRec = {
      id: ctx.state.nextId('Collection'),
      title: input.title,
      handle: handle ?? ctx.state.uniqueHandle('collection', handleize(input.title) || 'collection'),
      descriptionHtml: input.descriptionHtml ?? '',
      sortOrder: input.sortOrder ?? (ruleSet ? 'BEST_SELLING' : 'MANUAL'),
      templateSuffix: input.templateSuffix || null,
      seo: { title: input.seo?.title ?? null, description: input.seo?.description ?? null },
      image: image ?? null,
      ruleSet,
      productIds: ruleSet ? [] : productIds,
      published: ctx.options.autoPublish,
      createdAt: now,
      updatedAt: now,
    };
    ctx.state.collections.set(c.id, c);
    if (input.metafields?.length) {
      const res = setMetafields(ownerMetafieldInputs(gid('Collection', c.id), input.metafields), ctx, (i, n) => ['metafields', i, n]);
      if (res.errors.length) {
        ctx.state.collections.delete(c.id);
        return { collection: null, userErrors: res.errors.map((e) => ({ field: e.field, message: e.message })) };
      }
    }
    return { collection: c, userErrors: [] };
  },

  collectionUpdate: (_: unknown, a: { input: any }, ctx: Ctx) => {
    const input = a.input;
    const id = input.id ? safeIdOf(input.id, 'Collection') : null;
    const c = id !== null ? ctx.state.collections.get(id) : undefined;
    if (!c) return { collection: null, job: null, userErrors: [ue(['id'], 'Collection does not exist')] };
    const errors: UE[] = [];
    if (input.title !== undefined && (!input.title || !String(input.title).trim())) errors.push(ue(['title'], "Title can't be blank"));
    let handle: string | null = null;
    if (input.handle !== undefined && input.handle !== null) {
      handle = handleize(input.handle);
      if (!handle) errors.push(ue(['handle'], "Handle can't be blank"));
      else if (ctx.state.handleTaken('collection', handle, c.id)) errors.push(ue(['handle'], `Handle '${handle}' already in use. Please provide a new handle.`));
    }
    if (input.products?.length) errors.push(ue(['products'], 'Products can only be specified when creating a collection. Use collectionAddProducts instead.'));
    let ruleSet: CollectionRec['ruleSet'] | undefined;
    if (input.ruleSet !== undefined) {
      if (!c.ruleSet && input.ruleSet) errors.push(ue(['ruleSet'], 'Cannot update rule set of a custom collection'));
      else if (c.ruleSet && input.ruleSet === null) errors.push(ue(['ruleSet'], 'Cannot remove the rule set of a smart collection'));
      else ruleSet = validateRuleSet(input.ruleSet, errors);
    }
    const image = imageFrom(input, ctx, errors);
    if (input.metafields?.length) {
      errors.push(...setMetafields(ownerMetafieldInputs(gid('Collection', c.id), input.metafields), ctx, (i, n) => ['metafields', i, n], { dryRun: true }).errors.map((e) => ({ field: e.field, message: e.message })));
    }
    if (errors.length) return { collection: c, job: null, userErrors: errors };
    if (input.title !== undefined) c.title = input.title;
    if (handle && handle !== c.handle) {
      if (input.redirectNewHandle) addRedirect(`/collections/${c.handle}`, `/collections/${handle}`, ctx);
      c.handle = handle;
    }
    if (input.descriptionHtml !== undefined) c.descriptionHtml = input.descriptionHtml ?? '';
    if (input.sortOrder) c.sortOrder = input.sortOrder;
    if (input.templateSuffix !== undefined) c.templateSuffix = input.templateSuffix || null;
    if (input.seo) {
      if ('title' in input.seo) c.seo.title = input.seo.title || null;
      if ('description' in input.seo) c.seo.description = input.seo.description || null;
    }
    if (ruleSet) c.ruleSet = ruleSet;
    if (image !== undefined) c.image = image;
    if (input.metafields?.length) setMetafields(ownerMetafieldInputs(gid('Collection', c.id), input.metafields), ctx, (i, n) => ['metafields', i, n]);
    c.updatedAt = isoNow();
    return { collection: c, job: ruleSet ? newJob(ctx) : null, userErrors: [] };
  },

  collectionDelete: (_: unknown, a: { input: { id: string } }, ctx: Ctx) => {
    const id = safeIdOf(a.input.id, 'Collection');
    const c = id !== null ? ctx.state.collections.get(id) : undefined;
    if (!c) return { deletedCollectionId: null, shop: {}, userErrors: [ue(['id'], 'Collection does not exist')] };
    ctx.state.collections.delete(c.id);
    ctx.state.deleteOwnerData(gid('Collection', c.id));
    for (const d of ctx.state.discounts.values()) if (d.items.kind === 'collections') d.items.collectionIds = d.items.collectionIds.filter((x) => x !== c.id);
    return { deletedCollectionId: gid('Collection', c.id), shop: {}, userErrors: [] };
  },

  collectionAddProducts: (_: unknown, a: { id: string; productIds: string[] }, ctx: Ctx) => {
    const id = safeIdOf(a.id, 'Collection');
    const c = id !== null ? ctx.state.collections.get(id) : undefined;
    if (!c) return { collection: null, userErrors: [ue(['id'], 'Collection does not exist')] };
    if (c.ruleSet) return { collection: null, userErrors: [ue(['id'], "Can't manually add products to a smart collection")] };
    if (a.productIds.length > 250) return { collection: null, userErrors: [ue(['productIds'], 'Too many product ids (maximum is 250)')] };
    const errors: UE[] = [];
    const ids = productIdsFrom(a.productIds, ctx, errors, 'productIds');
    if (errors.length) return { collection: null, userErrors: errors };
    for (const pid of ids) if (!c.productIds.includes(pid)) c.productIds.push(pid);
    c.updatedAt = isoNow();
    return { collection: c, userErrors: [] };
  },

  collectionRemoveProducts: (_: unknown, a: { id: string; productIds: string[] }, ctx: Ctx) => {
    const id = safeIdOf(a.id, 'Collection');
    const c = id !== null ? ctx.state.collections.get(id) : undefined;
    if (!c) return { job: null, userErrors: [ue(['id'], 'Collection does not exist')] };
    if (c.ruleSet) return { job: null, userErrors: [ue(['id'], "Can't manually remove products from a smart collection")] };
    const errors: UE[] = [];
    const ids = productIdsFrom(a.productIds, ctx, errors, 'productIds');
    if (errors.length) return { job: null, userErrors: errors };
    c.productIds = c.productIds.filter((x) => !ids.includes(x));
    c.updatedAt = isoNow();
    return { job: newJob(ctx), userErrors: [] };
  },

  // Moves wirken nacheinander (newPosition 0-basiert, ab Produktanzahl = ans Ende), nur bei sortOrder MANUAL (wie Shopify)
  collectionReorderProducts: (_: unknown, a: { id: string; moves: { id: string; newPosition: string }[] }, ctx: Ctx) => {
    const id = safeIdOf(a.id, 'Collection');
    const c = id !== null ? ctx.state.collections.get(id) : undefined;
    if (!c) return { job: null, userErrors: [ue(['id'], 'Collection does not exist')] };
    if (c.ruleSet || c.sortOrder !== 'MANUAL') return { job: null, userErrors: [ue(['id'], "Can't reorder products unless collection is manually sorted.")] };
    if (a.moves.length > 250) return { job: null, userErrors: [ue(['moves'], 'Too many moves (maximum is 250)')] };
    const errors: UE[] = [];
    a.moves.forEach((m, i) => {
      const pid = safeIdOf(m.id, 'Product');
      if (pid === null || !c.productIds.includes(pid)) errors.push(ue(['moves', i, 'id'], `Product ${m.id} is not in the collection`));
    });
    if (errors.length) return { job: null, userErrors: errors };
    for (const m of a.moves) {
      const pid = idOf(m.id, 'Product')!;
      const list = c.productIds.filter((x) => x !== pid);
      list.splice(Math.min(Number(m.newPosition), list.length), 0, pid);
      c.productIds = list;
    }
    c.updatedAt = isoNow();
    return { job: newJob(ctx), userErrors: [] };
  },
};
