/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'node:crypto';
import type { ResolveInfo } from '../graphql';
import {
  type ConnArgs,
  type Ctx,
  idOf,
  isValidMoney,
  mapConn,
  mediaStatus,
  mediaView,
  metafieldResolvers,
  money,
  ONLINE_STORE_PUBLICATION_ID,
  paginate,
  safeIdOf,
  search,
  sortBy,
  stripHtml,
  truncate,
  ue,
  type UE,
} from '../context';
import type { SearchSpec } from '../search';
import {
  formatMoney,
  gid,
  handleize,
  isoNow,
  normalizeTags,
  type MediaRec,
  type OptionRec,
  type ProductRec,
  type VariantRec,
} from '../state';
import { ownerMetafieldInputs, setMetafields } from './metafields';
import { translationsFor } from './translations';
import { collectionSearchSpec, sortCollections } from './collections';

/* ------------------------------------------------------------ search specs */

export const productSearchSpec = (ctx: Ctx): SearchSpec<ProductRec> => ({
  fields: {
    title: { kind: 'text', get: (p) => p.title },
    handle: { kind: 'keyword', get: (p) => p.handle },
    vendor: { kind: 'keyword', get: (p) => p.vendor },
    product_type: { kind: 'keyword', get: (p) => p.productType },
    tag: { kind: 'keyword', get: (p) => p.tags },
    status: { kind: 'keyword', get: (p) => p.status },
    sku: { kind: 'keyword', get: (p) => ctx.state.productVariants(p).map((v) => v.sku ?? '') },
    barcode: { kind: 'keyword', get: (p) => ctx.state.productVariants(p).map((v) => v.barcode ?? '') },
    id: { kind: 'number', get: (p) => p.id },
    created_at: { kind: 'date', get: (p) => p.createdAt },
    updated_at: { kind: 'date', get: (p) => p.updatedAt },
    published_at: { kind: 'date', get: (p) => p.publishedAt },
    published_status: { kind: 'keyword', get: (p) => ['any', p.published ? 'published' : 'unpublished', p.published ? 'approved' : 'unapproved'] },
    gift_card: { kind: 'boolean', get: (p) => p.isGiftCard },
    inventory_total: { kind: 'number', get: (p) => ctx.state.productVariants(p).reduce((s, v) => s + v.inventoryQuantity, 0) },
    out_of_stock_somewhere: { kind: 'boolean', get: (p) => ctx.state.productVariants(p).some((v) => v.inventoryQuantity <= 0) },
    price: { kind: 'number', get: (p) => ctx.state.productVariants(p).map((v) => Number(v.price)) },
    collection_id: { kind: 'number', get: (p) => ctx.state.productCollections(p).map((c) => c.id) },
  },
  freeText: (p) => [p.title, p.handle, p.vendor, p.productType, ...p.tags, ...ctx.state.productVariants(p).map((v) => v.sku ?? '')],
});

// Shopify's tag_not:x is the negation of tag:x
export function rewriteProductQuery(q: string | null | undefined): string | null | undefined {
  return q?.replace(/(^|\s)tag_not:/g, '$1-tag:');
}

export const variantSearchSpec = (ctx: Ctx): SearchSpec<VariantRec> => ({
  fields: {
    sku: { kind: 'keyword', get: (v) => v.sku ?? '' },
    barcode: { kind: 'keyword', get: (v) => v.barcode ?? '' },
    product_id: { kind: 'number', get: (v) => v.productId },
    id: { kind: 'number', get: (v) => v.id },
    title: { kind: 'text', get: (v) => variantTitle(v) },
    price: { kind: 'number', get: (v) => Number(v.price) },
    inventory_quantity: { kind: 'number', get: (v) => v.inventoryQuantity },
    product_status: { kind: 'keyword', get: (v) => ctx.state.products.get(v.productId)?.status ?? '' },
    vendor: { kind: 'keyword', get: (v) => ctx.state.products.get(v.productId)?.vendor ?? '' },
    updated_at: { kind: 'date', get: (v) => v.updatedAt },
    created_at: { kind: 'date', get: (v) => v.createdAt },
  },
  freeText: (v) => [variantTitle(v), v.sku ?? '', v.barcode ?? '', ctx.state.products.get(v.productId)?.title ?? ''],
});

export function variantTitle(v: VariantRec): string {
  return v.selectedOptions.map((o) => o.value).join(' / ');
}

function hasOnlyDefaultVariant(p: ProductRec): boolean {
  return p.options.length === 1 && p.options[0].name === 'Title' && p.options[0].values.length === 1 && p.options[0].values[0].name === 'Default Title' && p.variantIds.length <= 1;
}

export function productView(p: ProductRec) {
  return { ...p, __typename: 'Product' };
}

export function sortProducts(list: ProductRec[], sortKey: string | null | undefined, ctx: Ctx): ProductRec[] {
  switch (sortKey) {
    case 'TITLE':
      return sortBy(list, (p) => p.title, (p) => p.id);
    case 'PRODUCT_TYPE':
      return sortBy(list, (p) => p.productType, (p) => p.id);
    case 'VENDOR':
      return sortBy(list, (p) => p.vendor, (p) => p.id);
    case 'INVENTORY_TOTAL':
      return sortBy(list, (p) => ctx.state.productVariants(p).reduce((s, v) => s + v.inventoryQuantity, 0), (p) => p.id);
    case 'UPDATED_AT':
      return sortBy(list, (p) => p.updatedAt, (p) => p.id);
    case 'CREATED_AT':
      return sortBy(list, (p) => p.createdAt, (p) => p.id);
    case 'PUBLISHED_AT':
      return sortBy(list, (p) => p.publishedAt ?? '', (p) => p.id);
    default:
      return sortBy(list, (p) => p.id, (p) => p.id);
  }
}

/* ---------------------------------------------------------- type resolvers */

const imageOf = (m: MediaRec, ctx: Ctx) =>
  mediaStatus(m, ctx) === 'READY'
    ? { id: gid('ImageSource', m.imageId), url: m.url, altText: m.alt === '' ? null : m.alt, width: m.width, height: m.height, originalSrc: m.url, src: m.url, transformedSrc: m.url }
    : null;

export const productTypes = {
  Product: {
    id: (p: ProductRec) => gid('Product', p.id),
    legacyResourceId: (p: ProductRec) => String(p.id),
    description: (p: ProductRec, a: { truncateAt?: number | null }) => truncate(stripHtml(p.descriptionHtml), a.truncateAt),
    hasOnlyDefaultVariant: (p: ProductRec) => hasOnlyDefaultVariant(p),
    hasOutOfStockVariants: (p: ProductRec, _: unknown, ctx: Ctx) => ctx.state.productVariants(p).some((v) => v.tracked && v.inventoryQuantity <= 0),
    tracksInventory: (p: ProductRec, _: unknown, ctx: Ctx) => ctx.state.productVariants(p).some((v) => v.tracked),
    totalInventory: (p: ProductRec, _: unknown, ctx: Ctx) => ctx.state.productVariants(p).reduce((s, v) => s + v.inventoryQuantity, 0),
    onlineStoreUrl: (p: ProductRec, _: unknown, ctx: Ctx) => (p.published && p.status === 'ACTIVE' ? `${ctx.state.shop.primaryDomainUrl}/products/${p.handle}` : null),
    onlineStorePreviewUrl: (p: ProductRec, _: unknown, ctx: Ctx) => `${ctx.state.shop.primaryDomainUrl}/products/${p.handle}?preview_key=fake`,
    publishedOnCurrentPublication: (p: ProductRec) => p.published,
    publishedOnPublication: (p: ProductRec, a: { publicationId: string }) => p.published && safeIdOf(a.publicationId, 'Publication') === ONLINE_STORE_PUBLICATION_ID,
    priceRangeV2: (p: ProductRec, _: unknown, ctx: Ctx) => {
      const prices = ctx.state.productVariants(p).map((v) => Number(v.price));
      const cur = ctx.state.shop.currencyCode;
      return { minVariantPrice: money(prices.length ? Math.min(...prices) : 0, cur), maxVariantPrice: money(prices.length ? Math.max(...prices) : 0, cur) };
    },
    compareAtPriceRange: (p: ProductRec, _: unknown, ctx: Ctx) => {
      const prices = ctx.state.productVariants(p).map((v) => (v.compareAtPrice === null ? null : Number(v.compareAtPrice))).filter((x): x is number => x !== null);
      if (!prices.length) return null;
      const cur = ctx.state.shop.currencyCode;
      return { minVariantCompareAtPrice: money(Math.min(...prices), cur), maxVariantCompareAtPrice: money(Math.max(...prices), cur) };
    },
    options: (p: ProductRec, a: { first?: number | null }) => {
      const list = p.options.map((o, i) => ({ ...o, __product: p, __position: i + 1 }));
      return a.first != null ? list.slice(0, a.first) : list;
    },
    variants: (p: ProductRec, a: ConnArgs & { sortKey?: string }, ctx: Ctx) => {
      let list = ctx.state.productVariants(p);
      if (a.sortKey === 'SKU') list = sortBy(list, (v) => v.sku ?? '', (v) => v.id);
      else if (a.sortKey === 'TITLE' || a.sortKey === 'FULL_TITLE' || a.sortKey === 'NAME') list = sortBy(list, (v) => variantTitle(v), (v) => v.id);
      else if (a.sortKey === 'ID') list = sortBy(list, (v) => v.id, (v) => v.id);
      else if (a.sortKey === 'INVENTORY_QUANTITY') list = sortBy(list, (v) => v.inventoryQuantity, (v) => v.id);
      return paginate(list, a, ctx, (v) => v.id);
    },
    variantsCount: (p: ProductRec) => ({ count: p.variantIds.length, precision: 'EXACT' }),
    media: (p: ProductRec, a: ConnArgs, ctx: Ctx) => {
      const list = p.mediaIds.map((id) => ctx.state.media.get(id)).filter((m): m is MediaRec => Boolean(m));
      return mapConn(paginate(list, a, ctx, (m) => m.id), mediaView);
    },
    mediaCount: (p: ProductRec) => ({ count: p.mediaIds.length, precision: 'EXACT' }),
    featuredMedia: (p: ProductRec, _: unknown, ctx: Ctx) => {
      const m = p.mediaIds.length ? ctx.state.media.get(p.mediaIds[0]) : undefined;
      return m ? mediaView(m) : null;
    },
    images: (p: ProductRec, a: ConnArgs, ctx: Ctx) => {
      const list = p.mediaIds.map((id) => ctx.state.media.get(id)).filter((m): m is MediaRec => Boolean(m) && mediaStatus(m!, ctx) === 'READY');
      return mapConn(paginate(list, a, ctx, (m) => m.id), (m) => imageOf(m, ctx));
    },
    featuredImage: (p: ProductRec, _: unknown, ctx: Ctx) => {
      for (const id of p.mediaIds) {
        const m = ctx.state.media.get(id);
        if (m && mediaStatus(m, ctx) === 'READY') return imageOf(m, ctx);
      }
      return null;
    },
    collections: (p: ProductRec, a: ConnArgs & { query?: string; sortKey?: string }, ctx: Ctx, info: ResolveInfo) => {
      const list = search(sortCollections(ctx.state.productCollections(p), a.sortKey), a.query, collectionSearchSpec(ctx), ctx, info);
      return paginate(list, a, ctx, (c) => c.id);
    },
    inCollection: (p: ProductRec, a: { id: string }, ctx: Ctx) => {
      const id = idOf(a.id, 'Collection');
      const c = id !== null ? ctx.state.collections.get(id) : undefined;
      return c ? ctx.state.collectionProducts(c).some((x) => x.id === p.id) : false;
    },
    ...metafieldResolvers((p: ProductRec) => gid('Product', p.id)),
    translations: (p: ProductRec, a: { locale: string; marketId?: string | null }, ctx: Ctx) => translationsFor(gid('Product', p.id), a.locale, ctx, a.marketId),
  },
  ProductOption: {
    id: (o: OptionRec) => gid('ProductOption', o.id),
    position: (o: any) => o.__position,
    values: (o: OptionRec & { __product: ProductRec }, _: unknown, ctx: Ctx) => {
      const used = new Set(ctx.state.productVariants(o.__product).flatMap((v) => v.selectedOptions.filter((s) => s.name === o.name).map((s) => s.value)));
      return o.values.filter((v) => used.has(v.name)).map((v) => v.name);
    },
    optionValues: (o: OptionRec & { __product: ProductRec }, _: unknown, ctx: Ctx) => {
      const used = new Set(ctx.state.productVariants(o.__product).flatMap((v) => v.selectedOptions.filter((s) => s.name === o.name).map((s) => s.value)));
      return o.values.map((v) => ({ id: gid('ProductOptionValue', v.id), name: v.name, hasVariants: used.has(v.name) }));
    },
  },
  ProductVariant: {
    id: (v: VariantRec) => gid('ProductVariant', v.id),
    legacyResourceId: (v: VariantRec) => String(v.id),
    title: (v: VariantRec) => variantTitle(v),
    displayName: (v: VariantRec, _: unknown, ctx: Ctx) => `${ctx.state.products.get(v.productId)?.title ?? ''} - ${variantTitle(v)}`,
    price: (v: VariantRec) => v.price,
    position: (v: VariantRec, _: unknown, ctx: Ctx) => (ctx.state.products.get(v.productId)?.variantIds.indexOf(v.id) ?? 0) + 1,
    availableForSale: (v: VariantRec, _: unknown, ctx: Ctx) => {
      const p = ctx.state.products.get(v.productId);
      return Boolean(p && p.status === 'ACTIVE' && p.published && (!v.tracked || v.inventoryQuantity > 0 || v.inventoryPolicy === 'CONTINUE'));
    },
    selectedOptions: (v: VariantRec, _: unknown, ctx: Ctx) => {
      const p = ctx.state.products.get(v.productId);
      return v.selectedOptions.map((s) => {
        const opt = p?.options.find((o) => o.name === s.name);
        const val = opt?.values.find((x) => x.name === s.value);
        return { name: s.name, value: s.value, optionValue: { id: gid('ProductOptionValue', val?.id ?? 0), name: s.value, hasVariants: true } };
      });
    },
    inventoryItem: (v: VariantRec, _: unknown, ctx: Ctx) => ({
      id: gid('InventoryItem', v.inventoryItemId),
      sku: v.sku,
      tracked: v.tracked,
      requiresShipping: v.requiresShipping,
      unitCost: v.unitCost !== null ? money(v.unitCost, ctx.state.shop.currencyCode) : null,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    }),
    product: (v: VariantRec, _: unknown, ctx: Ctx) => ctx.state.products.get(v.productId) ?? null,
    media: (v: VariantRec, a: ConnArgs, ctx: Ctx) => {
      const m = v.mediaId ? ctx.state.media.get(v.mediaId) : undefined;
      return mapConn(paginate(m ? [m] : [], a, ctx, (x) => x.id), mediaView);
    },
    image: (v: VariantRec, _: unknown, ctx: Ctx) => {
      const m = v.mediaId ? ctx.state.media.get(v.mediaId) : undefined;
      return m ? imageOf(m, ctx) : null;
    },
    ...metafieldResolvers((v: VariantRec) => gid('ProductVariant', v.id)),
    translations: () => [],
  },
  MediaImage: {
    id: (m: MediaRec) => gid('MediaImage', m.id),
    mediaContentType: () => 'IMAGE',
    status: (m: MediaRec, _: unknown, ctx: Ctx) => mediaStatus(m, ctx),
    fileStatus: (m: MediaRec, _: unknown, ctx: Ctx) => mediaStatus(m, ctx),
    image: (m: MediaRec, _: unknown, ctx: Ctx) => imageOf(m, ctx),
    preview: (m: MediaRec, _: unknown, ctx: Ctx) => ({ image: imageOf(m, ctx), status: mediaStatus(m, ctx) }),
    mediaErrors: (m: MediaRec, _: unknown, ctx: Ctx) =>
      mediaStatus(m, ctx) === 'FAILED' ? [{ code: 'IMAGE_DOWNLOAD_FAILURE', details: 'The staged upload was never received.', message: 'Image could not be downloaded.' }] : [],
    fileErrors: (m: MediaRec, _: unknown, ctx: Ctx) =>
      mediaStatus(m, ctx) === 'FAILED' ? [{ code: 'IMAGE_DOWNLOAD_FAILURE', details: 'The staged upload was never received.', message: 'Image could not be downloaded.' }] : [],
  },
  Image: {
    url: (i: { url: string }) => i.url,
  },
};

/* ------------------------------------------------------------- queries */

export const productQueries = {
  products: (_: unknown, a: ConnArgs & { query?: string; sortKey?: string }, ctx: Ctx, info: ResolveInfo) => {
    const list = search(sortProducts([...ctx.state.products.values()], a.sortKey, ctx), rewriteProductQuery(a.query), productSearchSpec(ctx), ctx, info);
    return paginate(list, a, ctx, (p) => p.id);
  },
  product: (_: unknown, a: { id: string }, ctx: Ctx) => {
    const id = idOf(a.id, 'Product');
    return id !== null ? (ctx.state.products.get(id) ?? null) : null;
  },
  productByIdentifier: (_: unknown, a: { identifier: { id?: string; handle?: string } }, ctx: Ctx) => {
    if (a.identifier.id) {
      const id = idOf(a.identifier.id, 'Product');
      return id !== null ? (ctx.state.products.get(id) ?? null) : null;
    }
    return a.identifier.handle ? (ctx.state.findProductByHandle(a.identifier.handle) ?? null) : null;
  },
  productsCount: (_: unknown, a: { query?: string; limit?: number }, ctx: Ctx, info: ResolveInfo) => {
    const n = search([...ctx.state.products.values()], rewriteProductQuery(a.query), productSearchSpec(ctx), ctx, info).length;
    const limit = a.limit ?? 10000;
    return { count: Math.min(n, limit), precision: n > limit ? 'AT_LEAST' : 'EXACT' };
  },
  productVariants: (_: unknown, a: ConnArgs & { query?: string }, ctx: Ctx, info: ResolveInfo) => {
    const list = search(sortBy([...ctx.state.variants.values()], (v) => v.id, (v) => v.id), a.query, variantSearchSpec(ctx), ctx, info);
    return paginate(list, a, ctx, (v) => v.id);
  },
  productVariant: (_: unknown, a: { id: string }, ctx: Ctx) => {
    const id = idOf(a.id, 'ProductVariant');
    return id !== null ? (ctx.state.variants.get(id) ?? null) : null;
  },
  files: (_: unknown, a: ConnArgs & { query?: string }, ctx: Ctx, info: ResolveInfo) => {
    const spec: SearchSpec<MediaRec> = {
      fields: {
        filename: { kind: 'keyword', get: (m) => m.filename },
        media_type: { kind: 'keyword', get: () => 'IMAGE' },
        status: { kind: 'keyword', get: (m) => mediaStatus(m, ctx) },
        id: { kind: 'number', get: (m) => m.id },
        created_at: { kind: 'date', get: (m) => m.createdAt },
        updated_at: { kind: 'date', get: (m) => m.updatedAt },
        used_in: { kind: 'keyword', get: (m) => ([...ctx.state.products.values()].some((p) => p.mediaIds.includes(m.id)) ? 'product' : 'none') },
      },
      freeText: (m) => [m.filename, m.alt],
    };
    const list = search(sortBy([...ctx.state.media.values()], (m) => m.id, (m) => m.id), a.query, spec, ctx, info);
    return mapConn(paginate(list, a, ctx, (m) => m.id), mediaView);
  },
};

/* ------------------------------------------------------------- mutations */

const MAX_OPTIONS = 3;

function validateCommonProductFields(input: any, errors: UE[]): void {
  if ('title' in input && input.title !== undefined && (input.title === null || String(input.title).trim() === '')) errors.push(ue(['title'], "Title can't be blank"));
  if (input.title && String(input.title).length > 255) errors.push(ue(['title'], 'Title is too long (maximum is 255 characters)'));
  if (input.seo?.title && String(input.seo.title).length > 255) errors.push(ue(['seo', 'title'], 'SEO title is too long (maximum is 255 characters)'));
  if (input.seo?.description && String(input.seo.description).length > 320) errors.push(ue(['seo', 'description'], 'SEO description is too long (maximum is 320 characters)'));
  if (input.tags && input.tags.length > 250) errors.push(ue(['tags'], 'Tags exceeds maximum of 250'));
  if (input.tags && input.tags.some((t: string) => t.length > 255)) errors.push(ue(['tags'], 'Tags is too long (maximum is 255 characters per tag)'));
}

function joinCollections(p: ProductRec, ids: string[] | null | undefined, ctx: Ctx, errors: UE[], field: string, apply: boolean, leave = false): void {
  for (const raw of ids ?? []) {
    const id = safeIdOf(raw, 'Collection');
    const c = id !== null ? ctx.state.collections.get(id) : undefined;
    if (!c) {
      errors.push(ue([field], `Collection ${raw} does not exist`));
      continue;
    }
    if (c.ruleSet) {
      errors.push(ue([field], `Collection ${raw} is a smart collection, products can't be added or removed manually`));
      continue;
    }
    if (!apply) continue;
    if (leave) c.productIds = c.productIds.filter((x) => x !== p.id);
    else if (!c.productIds.includes(p.id)) c.productIds.push(p.id);
    c.updatedAt = isoNow();
  }
}

export function createMediaFromInputs(
  product: ProductRec | null,
  inputs: { originalSource: string; mediaContentType: string; alt?: string | null }[],
  ctx: Ctx,
  fieldPrefix: string,
  validateOnly = false,
): { errors: UE[]; media: MediaRec[] } {
  const errors: UE[] = [];
  inputs.forEach((m, i) => {
    if (m.mediaContentType !== 'IMAGE') {
      errors.push(ue([fieldPrefix, i, 'mediaContentType'], `The Shopify fake only supports IMAGE media (got ${m.mediaContentType}).`, 'INVALID_MEDIA_TYPE'));
    }
    if (!/^https?:\/\/\S+$/.test(m.originalSource)) errors.push(ue([fieldPrefix, i, 'originalSource'], 'Image URL is invalid', 'INVALID'));
    if (m.alt && m.alt.length > 512) errors.push(ue([fieldPrefix, i, 'alt'], 'Alt is too long (maximum is 512 characters)', 'INVALID'));
  });
  if (product && product.mediaIds.length + inputs.length > 250) errors.push(ue([fieldPrefix], 'Product has reached the maximum of 250 media', 'PRODUCT_MEDIA_LIMIT_EXCEEDED'));
  if (errors.length || validateOnly) return { errors, media: [] };
  const media = inputs.map((m) => createMediaRecord(m.originalSource, m.alt ?? '', ctx));
  if (product) product.mediaIds.push(...media.map((m) => m.id));
  return { errors, media };
}

/** Resolves an originalSource (external URL or staged upload) into a media record. */
export function createMediaRecord(originalSource: string, alt: string, ctx: Ctx, filenameOverride?: string): MediaRec {
  const stagedPrefix = `${ctx.state.baseUrl}/__fake/staged-uploads/`;
  let filename = filenameOverride ?? decodeURIComponent(originalSource.split('?')[0].split('/').pop() || 'image.jpg');
  let url: string;
  let mimeType = /\.png$/i.test(filename) ? 'image/png' : /\.webp$/i.test(filename) ? 'image/webp' : /\.gif$/i.test(filename) ? 'image/gif' : 'image/jpeg';
  let failed = false;
  let width = 1024;
  let height = 1024;
  if (originalSource.startsWith(stagedPrefix)) {
    const stagedId = originalSource.slice(stagedPrefix.length).split(/[/?]/)[0];
    const staged = ctx.state.stagedUploads.get(stagedId);
    if (!staged || !staged.body) failed = true;
    if (staged) {
      filename = filenameOverride ?? staged.filename;
      mimeType = staged.mimeType;
      if (staged.body) {
        const dim = imageSize(staged.body);
        if (dim) ({ width, height } = dim);
      }
    }
    url = `${ctx.state.baseUrl}/__fake/cdn/${stagedId}/${encodeURIComponent(filename)}`;
  } else {
    url = `https://cdn.shopify.com/s/files/1/0601/2345/6789/files/${encodeURIComponent(filename)}?v=${Math.floor(Date.now() / 1000)}`;
  }
  const rec = ctx.state.addMedia({ url, alt, filename, mimeType, width, height, originalSource, ready: false });
  rec.failed = failed;
  return rec;
}

/** Reads width/height from PNG, GIF or JPEG headers. */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

function buildOptions(input: any[] | null | undefined, errors: UE[], field: string): { name: string; values: string[] }[] | null {
  if (!input?.length) return null;
  if (input.length > MAX_OPTIONS) errors.push(ue([field], `Can only specify a maximum of ${MAX_OPTIONS} options`, 'OPTIONS_OVER_LIMIT'));
  const names = new Set<string>();
  const out: { name: string; values: string[] }[] = [];
  input.forEach((o, i) => {
    if (!o.name || !String(o.name).trim()) errors.push(ue([field, i, 'name'], "Option name can't be blank"));
    if (names.has(String(o.name).toLowerCase())) errors.push(ue([field, i, 'name'], `Option '${o.name}' already exists.`, 'DUPLICATED_OPTION_NAME'));
    names.add(String(o.name).toLowerCase());
    const values = (o.values ?? []).map((v: any) => String(v.name ?? '')).filter(Boolean);
    if (!values.length) errors.push(ue([field, i, 'values'], 'Option values must be specified'));
    if (new Set(values).size !== values.length) errors.push(ue([field, i, 'values'], 'Duplicated option value.', 'DUPLICATED_OPTION_VALUE'));
    out.push({ name: o.name, values });
  });
  return out;
}

export const productMutations = {
  productCreate: (_: unknown, a: { product?: any; input?: any; media?: any[] }, ctx: Ctx) => {
    const shop = {};
    if (a.product && a.input) return { product: null, shop, userErrors: [ue(null, 'Only one of product or input can be provided')] };
    const input = a.product ?? a.input;
    if (!input) return { product: null, shop, userErrors: [ue(['product'], 'product argument is required')] };
    if (input.id) return { product: null, shop, userErrors: [ue(['id'], 'Product creation does not accept an id')] };
    const errors: UE[] = [];
    if (input.title === undefined || input.title === null) errors.push(ue(['title'], "Title can't be blank"));
    validateCommonProductFields(input, errors);
    let handle: string | null = null;
    if (input.handle != null && input.handle !== '') {
      handle = handleize(input.handle);
      if (!handle) errors.push(ue(['handle'], 'Handle is invalid'));
      else if (ctx.state.handleTaken('product', handle)) errors.push(ue(['handle'], `Handle '${handle}' already in use. Please provide a new handle.`));
    }
    const options = buildOptions(input.productOptions, errors, 'productOptions');
    for (const raw of input.collectionsToJoin ?? []) {
      const id = safeIdOf(raw, 'Collection');
      const c = id !== null ? ctx.state.collections.get(id) : undefined;
      if (!c) errors.push(ue(['collectionsToJoin'], `Collection ${raw} does not exist`));
      else if (c.ruleSet) errors.push(ue(['collectionsToJoin'], `Collection ${raw} is a smart collection, products can't be added or removed manually`));
    }
    const mediaCheck = createMediaFromInputs(null, a.media ?? [], ctx, 'media', true);
    if (mediaCheck.errors.length) errors.push(...mediaCheck.errors);
    if (errors.length) return { product: null, shop, userErrors: errors };

    const p = ctx.state.addProduct({
      title: input.title,
      handle: handle ?? ctx.state.uniqueHandle('product', handleize(input.title) || 'product'),
      descriptionHtml: input.descriptionHtml ?? '',
      status: input.status ?? 'ACTIVE',
      vendor: input.vendor ?? ctx.state.shop.name,
      productType: input.productType ?? '',
      tags: input.tags ?? [],
      seo: input.seo ?? undefined,
      templateSuffix: input.templateSuffix ?? null,
      options: options ?? undefined,
      published: ctx.options.autoPublish,
    });
    p.giftCardTemplateSuffix = input.giftCardTemplateSuffix ?? null;
    p.isGiftCard = Boolean(input.giftCard);
    if (input.metafields?.length) {
      const res = setMetafields(ownerMetafieldInputs(gid('Product', p.id), input.metafields), ctx, (i, n) => ['metafields', i, n]);
      if (res.errors.length) {
        deleteProduct(p, ctx);
        return { product: null, shop, userErrors: res.errors.map((e) => ({ ...e, code: undefined })) };
      }
    }
    joinCollections(p, input.collectionsToJoin, ctx, [], 'collectionsToJoin', true);
    createMediaFromInputs(p, a.media ?? [], ctx, 'media');
    return { product: p, shop, userErrors: [] };
  },

  productUpdate: (_: unknown, a: { product?: any; input?: any; media?: any[]; identifier?: { id?: string; handle?: string } }, ctx: Ctx) => {
    if (a.product && a.input) return { product: null, userErrors: [ue(null, 'Only one of product or input can be provided')] };
    const input = a.product ?? a.input ?? {};
    let p: ProductRec | undefined;
    const rawId = input.id ?? a.identifier?.id;
    if (rawId) {
      const id = safeIdOf(rawId, 'Product');
      p = id !== null ? ctx.state.products.get(id) : undefined;
    } else if (a.identifier?.handle) {
      p = ctx.state.findProductByHandle(a.identifier.handle);
    }
    if (!p) return { product: null, userErrors: [ue(['id'], 'Product does not exist')] };
    const errors: UE[] = [];
    validateCommonProductFields(input, errors);
    let newHandle: string | null = null;
    if ('handle' in input && input.handle !== undefined) {
      newHandle = handleize(input.handle ?? '');
      if (!newHandle) errors.push(ue(['handle'], "Handle can't be blank"));
      else if (ctx.state.handleTaken('product', newHandle, p.id)) errors.push(ue(['handle'], `Handle '${newHandle}' already in use. Please provide a new handle.`));
    }
    joinCollections(p, input.collectionsToJoin, ctx, errors, 'collectionsToJoin', false);
    joinCollections(p, input.collectionsToLeave, ctx, errors, 'collectionsToLeave', false, true);
    const mediaCheck = createMediaFromInputs(p, a.media ?? [], ctx, 'media', true);
    errors.push(...mediaCheck.errors);
    if (input.metafields?.length) {
      // validate first (atomic): run against the real store only if everything else is valid
      const probe = setMetafieldsDryRun(gid('Product', p.id), input.metafields, ctx);
      errors.push(...probe);
    }
    if (errors.length) return { product: p, userErrors: errors };

    const now = isoNow();
    if (input.title !== undefined) p.title = input.title;
    if (newHandle && newHandle !== p.handle) {
      if (input.redirectNewHandle) addRedirect(`/products/${p.handle}`, `/products/${newHandle}`, ctx);
      p.handle = newHandle;
    }
    if (input.descriptionHtml !== undefined) p.descriptionHtml = input.descriptionHtml ?? '';
    if (input.vendor !== undefined) p.vendor = input.vendor ?? '';
    if (input.productType !== undefined) p.productType = input.productType ?? '';
    if (input.status !== undefined && input.status !== null) p.status = input.status;
    if (input.tags !== undefined) p.tags = normalizeTags(input.tags ?? []);
    if (input.seo !== undefined && input.seo !== null) {
      if ('title' in input.seo) p.seo.title = input.seo.title || null;
      if ('description' in input.seo) p.seo.description = input.seo.description || null;
    }
    if (input.templateSuffix !== undefined) p.templateSuffix = input.templateSuffix || null;
    if (input.giftCardTemplateSuffix !== undefined) p.giftCardTemplateSuffix = input.giftCardTemplateSuffix || null;
    joinCollections(p, input.collectionsToJoin, ctx, [], 'collectionsToJoin', true);
    joinCollections(p, input.collectionsToLeave, ctx, [], 'collectionsToLeave', true, true);
    if (input.metafields?.length) setMetafields(ownerMetafieldInputs(gid('Product', p.id), input.metafields), ctx, (i, n) => ['metafields', i, n]);
    createMediaFromInputs(p, a.media ?? [], ctx, 'media');
    p.updatedAt = now;
    return { product: p, userErrors: [] };
  },

  productDelete: (_: unknown, a: { input: { id: string } }, ctx: Ctx) => {
    const id = safeIdOf(a.input.id, 'Product');
    const p = id !== null ? ctx.state.products.get(id) : undefined;
    if (!p) return { deletedProductId: null, shop: {}, userErrors: [ue(['id'], 'Product does not exist')] };
    deleteProduct(p, ctx);
    return { deletedProductId: gid('Product', p.id), shop: {}, userErrors: [] };
  },

  productVariantsBulkUpdate: (_: unknown, a: { productId: string; variants: any[]; media?: any[]; allowPartialUpdates?: boolean }, ctx: Ctx) => {
    const pid = safeIdOf(a.productId, 'Product');
    const p = pid !== null ? ctx.state.products.get(pid) : undefined;
    if (!p) return { product: null, productVariants: null, userErrors: [ue(['productId'], 'Product does not exist', 'PRODUCT_DOES_NOT_EXIST')] };
    const errors: UE[] = [];
    const plans: { v: VariantRec; input: any; i: number; newOptions: { name: string; value: string }[] | null }[] = [];
    const seenIds = new Set<number>();
    a.variants.forEach((input, i) => {
      const before = errors.length;
      if (!input.id) {
        errors.push(ue(['variants', i, 'id'], 'Product variant is missing ID attribute', 'PRODUCT_VARIANT_ID_MISSING'));
        return;
      }
      const vid = safeIdOf(input.id, 'ProductVariant');
      const v = vid !== null ? ctx.state.variants.get(vid) : undefined;
      if (!v || v.productId !== p.id) {
        errors.push(ue(['variants', i, 'id'], 'Product variant does not exist', 'PRODUCT_VARIANT_DOES_NOT_EXIST'));
        return;
      }
      if (seenIds.has(v.id)) errors.push(ue(['variants', i, 'id'], 'Product variant is specified more than once', 'INVALID_INPUT'));
      seenIds.add(v.id);
      validateVariantInput(input, i, errors, 'update');
      let newOptions: { name: string; value: string }[] | null = null;
      if (input.optionValues?.length) {
        newOptions = resolveOptionValues(p, input.optionValues, i, errors, v.selectedOptions);
      }
      if (input.mediaId) {
        const mid = safeIdOf(input.mediaId, 'MediaImage');
        if (mid === null || !p.mediaIds.includes(mid)) errors.push(ue(['variants', i, 'mediaId'], 'Media does not exist on product', 'INVALID_INPUT'));
      }
      if (errors.length === before) plans.push({ v, input, i, newOptions });
    });
    // duplicate option combinations after the update
    const combos = new Map<string, number>();
    for (const v of ctx.state.productVariants(p)) {
      const plan = plans.find((x) => x.v.id === v.id);
      const opts = plan?.newOptions ?? v.selectedOptions;
      const key = opts.map((o) => o.value).join(' / ');
      if (combos.has(key)) {
        const idx = plan?.i ?? 0;
        errors.push(ue(['variants', idx, 'optionValues'], `The variant '${key}' already exists.`, 'VARIANT_ALREADY_EXISTS'));
      }
      combos.set(key, v.id);
    }
    const fail = errors.length > 0 && !a.allowPartialUpdates;
    if (fail) return { product: p, productVariants: null, userErrors: errors };
    const now = isoNow();
    const failedIdx = new Set(errors.map((e) => Number(e.field?.[1])));
    const updated: VariantRec[] = [];
    for (const { v, input, i, newOptions } of plans) {
      if (failedIdx.has(i)) continue;
      applyVariantInput(v, input, ctx);
      if (newOptions) {
        for (const o of newOptions) ensureOptionValue(p, o.name, o.value, ctx);
        v.selectedOptions = newOptions;
      }
      v.updatedAt = now;
      updated.push(v);
    }
    if (a.media?.length) createMediaFromInputs(p, a.media, ctx, 'media');
    p.updatedAt = now;
    return { product: p, productVariants: updated, userErrors: errors };
  },

  productVariantsBulkCreate: (_: unknown, a: { productId: string; variants: any[]; media?: any[]; strategy?: string }, ctx: Ctx) => {
    const pid = safeIdOf(a.productId, 'Product');
    const p = pid !== null ? ctx.state.products.get(pid) : undefined;
    if (!p) return { product: null, productVariants: null, userErrors: [ue(['productId'], 'Product does not exist', 'PRODUCT_DOES_NOT_EXIST')] };
    const errors: UE[] = [];
    const planned: { name: string; value: string }[][] = [];
    const existing = new Set(ctx.state.productVariants(p).map((v) => variantTitle(v)));
    a.variants.forEach((input, i) => {
      if (input.id) errors.push(ue(['variants', i, 'id'], 'Cannot specify id on create', 'INVALID_INPUT'));
      validateVariantInput(input, i, errors, 'create');
      if (!input.optionValues?.length) {
        errors.push(ue(['variants', i, 'optionValues'], 'You need to add option values for all options.', 'MUST_SPECIFY_ALL_OPTION_VALUES'));
        return;
      }
      const opts = resolveOptionValues(p, input.optionValues, i, errors, null);
      if (!opts) return;
      const key = opts.map((o) => o.value).join(' / ');
      if (existing.has(key)) errors.push(ue(['variants', i], `The variant '${key}' already exists.`, 'VARIANT_ALREADY_EXISTS'));
      existing.add(key);
      planned.push(opts);
    });
    if (errors.length) return { product: p, productVariants: null, userErrors: errors };
    const before = ctx.state.productVariants(p);
    const standalone = before.length === 1 && (hasOnlyDefaultVariant(p) || a.strategy === 'REMOVE_STANDALONE_VARIANT');
    const created = a.variants.map((input, i) => {
      for (const o of planned[i]) ensureOptionValue(p, o.name, o.value, ctx);
      const qty = (input.inventoryQuantities ?? []).reduce((s: number, l: any) => s + Number(l.availableQuantity ?? 0), 0);
      const v = ctx.state.addVariant(p, { selectedOptions: planned[i], inventoryQuantity: qty });
      v.createdAt = v.updatedAt = isoNow();
      applyVariantInput(v, input, ctx);
      return v;
    });
    if (standalone && a.strategy !== 'PRESERVE_STANDALONE_VARIANT') {
      const old = before[0];
      ctx.state.variants.delete(old.id);
      p.variantIds = p.variantIds.filter((id) => id !== old.id);
      if (hasDefaultTitleOption(p)) p.options = p.options.filter((o) => o.name !== 'Title');
    }
    if (a.media?.length) createMediaFromInputs(p, a.media, ctx, 'media');
    p.updatedAt = isoNow();
    return { product: p, productVariants: created, userErrors: [] };
  },

  productVariantsBulkDelete: (_: unknown, a: { productId: string; variantsIds: string[] }, ctx: Ctx) => {
    const pid = safeIdOf(a.productId, 'Product');
    const p = pid !== null ? ctx.state.products.get(pid) : undefined;
    if (!p) return { product: null, userErrors: [ue(['productId'], 'Product does not exist', 'PRODUCT_DOES_NOT_EXIST')] };
    const ids = a.variantsIds.map((x) => safeIdOf(x, 'ProductVariant'));
    if (ids.some((id) => id === null || !p.variantIds.includes(id))) {
      return { product: p, userErrors: [ue(['variantsIds'], 'At least one variant does not belong to the product', 'AT_LEAST_ONE_VARIANT_DOES_NOT_BELONG_TO_THE_PRODUCT')] };
    }
    if (new Set(ids).size >= p.variantIds.length) {
      return { product: p, userErrors: [ue(['variantsIds'], 'Cannot delete the last variant of a product', 'CANNOT_DELETE_LAST_VARIANT')] };
    }
    for (const id of ids as number[]) {
      ctx.state.variants.delete(id);
      ctx.state.deleteOwnerData(gid('ProductVariant', id));
    }
    p.variantIds = p.variantIds.filter((id) => !ids.includes(id));
    p.updatedAt = isoNow();
    return { product: p, userErrors: [] };
  },

  productCreateMedia: (_: unknown, a: { productId: string; media: any[] }, ctx: Ctx) => {
    const pid = safeIdOf(a.productId, 'Product');
    const p = pid !== null ? ctx.state.products.get(pid) : undefined;
    if (!p) return { media: null, mediaUserErrors: [ue(['productId'], 'Product does not exist', 'PRODUCT_DOES_NOT_EXIST')], product: null };
    const { errors, media } = createMediaFromInputs(p, a.media, ctx, 'media');
    if (errors.length) return { media: null, mediaUserErrors: errors, product: p };
    p.updatedAt = isoNow();
    return { media: media.map(mediaView), mediaUserErrors: [], product: p };
  },

  productDeleteMedia: (_: unknown, a: { productId: string; mediaIds: string[] }, ctx: Ctx) => {
    const pid = safeIdOf(a.productId, 'Product');
    const p = pid !== null ? ctx.state.products.get(pid) : undefined;
    if (!p) return { deletedMediaIds: null, deletedProductImageIds: null, mediaUserErrors: [ue(['productId'], 'Product does not exist', 'PRODUCT_DOES_NOT_EXIST')], product: null };
    const errors: UE[] = [];
    const ids: number[] = [];
    a.mediaIds.forEach((raw, i) => {
      const id = safeIdOf(raw, 'MediaImage');
      if (id === null || !p.mediaIds.includes(id)) errors.push(ue(['mediaIds', i], `Media id ${raw} does not exist on product`, 'MEDIA_DOES_NOT_EXIST_ON_PRODUCT'));
      else ids.push(id);
    });
    if (errors.length) return { deletedMediaIds: null, deletedProductImageIds: null, mediaUserErrors: errors, product: p };
    const imageIds: string[] = [];
    for (const id of ids) {
      const m = ctx.state.media.get(id);
      if (m) imageIds.push(gid('ProductImage', m.imageId));
      ctx.state.media.delete(id);
      for (const v of ctx.state.variants.values()) if (v.mediaId === id) v.mediaId = null;
    }
    p.mediaIds = p.mediaIds.filter((id) => !ids.includes(id));
    p.updatedAt = isoNow();
    return { deletedMediaIds: ids.map((id) => gid('MediaImage', id)), deletedProductImageIds: imageIds, mediaUserErrors: [], product: p };
  },

  productReorderMedia: (_: unknown, a: { id: string; moves: { id: string; newPosition: string }[] }, ctx: Ctx) => {
    const pid = safeIdOf(a.id, 'Product');
    const p = pid !== null ? ctx.state.products.get(pid) : undefined;
    if (!p) return { job: null, mediaUserErrors: [ue(['id'], 'Product does not exist', 'PRODUCT_DOES_NOT_EXIST')] };
    const errors: UE[] = [];
    a.moves.forEach((m, i) => {
      const id = safeIdOf(m.id, 'MediaImage');
      if (id === null || !p.mediaIds.includes(id)) errors.push(ue(['moves', i, 'id'], `Media id ${m.id} does not exist on product`, 'MEDIA_DOES_NOT_EXIST_ON_PRODUCT'));
    });
    if (errors.length) return { job: null, mediaUserErrors: errors };
    for (const m of a.moves) {
      const id = idOf(m.id, 'MediaImage')!;
      const list = p.mediaIds.filter((x) => x !== id);
      const pos = Math.min(Number(m.newPosition), list.length);
      list.splice(pos, 0, id);
      p.mediaIds = list;
    }
    p.updatedAt = isoNow();
    return { job: newJob(ctx), mediaUserErrors: [] };
  },

  fileCreate: (_: unknown, a: { files: any[] }, ctx: Ctx) => {
    const errors: UE[] = [];
    a.files.forEach((f, i) => {
      if (f.contentType && f.contentType !== 'IMAGE') errors.push(ue(['files', i, 'contentType'], `The Shopify fake only supports IMAGE files (got ${f.contentType}).`, 'INVALID'));
      if (!/^https?:\/\/\S+$/.test(f.originalSource)) errors.push(ue(['files', i, 'originalSource'], 'Original source is invalid', 'INVALID'));
      if (f.alt && f.alt.length > 512) errors.push(ue(['files', i, 'alt'], 'Alt value exceeds the maximum of 512 characters', 'ALT_VALUE_LIMIT_EXCEEDED'));
    });
    if (errors.length) return { files: null, userErrors: errors };
    const files = a.files.map((f) => mediaView(createMediaRecord(f.originalSource, f.alt ?? '', ctx, f.filename ?? undefined)));
    return { files, userErrors: [] };
  },

  fileUpdate: (_: unknown, a: { files: any[] }, ctx: Ctx) => {
    const errors: UE[] = [];
    const recs: MediaRec[] = [];
    a.files.forEach((f, i) => {
      const id = safeIdOf(f.id, 'MediaImage');
      const m = id !== null ? ctx.state.media.get(id) : undefined;
      if (!m) {
        errors.push(ue(['files', i, 'id'], `File id ${f.id} does not exist.`, 'FILE_DOES_NOT_EXIST'));
        return;
      }
      if (mediaStatus(m, ctx) !== 'READY') errors.push(ue(['files', i, 'id'], 'Non-ready files cannot be updated.', 'NON_READY_STATE'));
      if (f.alt != null && f.alt.length > 512) errors.push(ue(['files', i, 'alt'], 'Alt value exceeds the maximum of 512 characters', 'ALT_VALUE_LIMIT_EXCEEDED'));
      if (f.filename != null) {
        const ext = (s: string) => s.split('.').pop()?.toLowerCase();
        if (ext(f.filename) !== ext(m.filename)) errors.push(ue(['files', i, 'filename'], 'The filename extension provided must match the original filename.', 'INVALID_FILENAME_EXTENSION'));
        if (f.originalSource) errors.push(ue(['files', i, 'filename'], 'Cannot update filename and originalSource at the same time.', 'TOO_MANY_ARGUMENTS'));
      }
      if (f.originalSource != null && !/^https?:\/\/\S+$/.test(f.originalSource)) errors.push(ue(['files', i, 'originalSource'], 'Original source is invalid', 'INVALID'));
      for (const key of ['referencesToAdd', 'referencesToRemove'] as const) {
        (f[key] ?? []).forEach((r: string, j: number) => {
          const pid = safeIdOf(r, 'Product');
          if (pid === null || !ctx.state.products.has(pid)) errors.push(ue(['files', i, key, j], `Reference ${r} does not exist.`, 'REFERENCE_TARGET_DOES_NOT_EXIST'));
        });
      }
      recs.push(m);
    });
    if (errors.length) return { files: null, userErrors: errors };
    const now = isoNow();
    a.files.forEach((f, i) => {
      const m = recs[i];
      if (f.alt != null) m.alt = f.alt;
      if (f.filename != null) {
        m.filename = f.filename;
        m.url = m.url.replace(/[^/?]+(\?.*)?$/, `${encodeURIComponent(f.filename)}$1`);
      }
      if (f.originalSource != null) {
        const replacement = createMediaRecord(f.originalSource, m.alt, ctx);
        ctx.state.media.delete(replacement.id);
        Object.assign(m, { url: replacement.url, filename: replacement.filename, mimeType: replacement.mimeType, width: replacement.width, height: replacement.height, originalSource: f.originalSource, createdInRequest: ctx.state.requestSeq, failed: replacement.failed });
      }
      for (const r of f.referencesToAdd ?? []) {
        const p = ctx.state.products.get(idOf(r, 'Product')!);
        if (p && !p.mediaIds.includes(m.id)) p.mediaIds.push(m.id);
      }
      for (const r of f.referencesToRemove ?? []) {
        const p = ctx.state.products.get(idOf(r, 'Product')!);
        if (p) p.mediaIds = p.mediaIds.filter((x) => x !== m.id);
      }
      m.updatedAt = now;
    });
    return { files: recs.map(mediaView), userErrors: [] };
  },

  fileDelete: (_: unknown, a: { fileIds: string[] }, ctx: Ctx) => {
    const errors: UE[] = [];
    const ids: number[] = [];
    a.fileIds.forEach((raw, i) => {
      const id = safeIdOf(raw, 'MediaImage');
      if (id === null || !ctx.state.media.has(id)) errors.push(ue(['fileIds', i], `File id ${raw} does not exist.`, 'FILE_DOES_NOT_EXIST'));
      else ids.push(id);
    });
    if (errors.length) return { deletedFileIds: null, userErrors: errors };
    for (const id of ids) {
      ctx.state.media.delete(id);
      for (const p of ctx.state.products.values()) p.mediaIds = p.mediaIds.filter((x) => x !== id);
      for (const v of ctx.state.variants.values()) if (v.mediaId === id) v.mediaId = null;
    }
    return { deletedFileIds: ids.map((id) => gid('MediaImage', id)), userErrors: [] };
  },

  stagedUploadsCreate: (_: unknown, a: { input: any[] }, ctx: Ctx) => {
    const errors: UE[] = [];
    a.input.forEach((u, i) => {
      if (!u.filename) errors.push(ue(['input', i, 'filename'], "Filename can't be blank"));
      if (!u.mimeType) errors.push(ue(['input', i, 'mimeType'], "Mime type can't be blank"));
      if ((u.resource === 'VIDEO' || u.resource === 'MODEL_3D') && !u.fileSize) errors.push(ue(['input', i, 'fileSize'], `File size is required for ${u.resource} resources`));
      if ((u.resource === 'IMAGE' || u.resource === 'PRODUCT_IMAGE' || u.resource === 'COLLECTION_IMAGE') && u.mimeType && !String(u.mimeType).startsWith('image/')) {
        errors.push(ue(['input', i, 'mimeType'], `Mime type ${u.mimeType} is not allowed for ${u.resource} resources`));
      }
    });
    if (errors.length) return { stagedTargets: null, userErrors: errors };
    const targets = a.input.map((u) => {
      const id = randomUUID();
      const method = (u.httpMethod ?? 'PUT') as 'PUT' | 'POST';
      ctx.state.stagedUploads.set(id, { id, filename: u.filename, mimeType: u.mimeType, resource: u.resource, httpMethod: method, body: null, contentType: null });
      const url = `${ctx.state.baseUrl}/__fake/staged-uploads/${id}`;
      const key = `tmp/${ctx.state.shop.id}/${String(u.resource).toLowerCase()}s/${id}/${u.filename}`;
      const parameters =
        method === 'POST'
          ? [
              { name: 'Content-Type', value: u.mimeType },
              { name: 'success_action_status', value: '201' },
              { name: 'acl', value: 'private' },
              { name: 'key', value: key },
              { name: 'x-goog-date', value: isoNow().replace(/[-:]/g, '') },
              { name: 'x-goog-credential', value: 'fake-credential' },
              { name: 'x-goog-algorithm', value: 'GOOG4-RSA-SHA256' },
              { name: 'x-goog-signature', value: 'fake-signature' },
              { name: 'policy', value: Buffer.from('{"fake":true}').toString('base64') },
            ]
          : [
              { name: 'content_type', value: u.mimeType },
              { name: 'acl', value: 'private' },
            ];
      return { url, resourceUrl: url, parameters };
    });
    return { stagedTargets: targets, userErrors: [] };
  },

  publishablePublish: (_: unknown, a: { id: string; input: { publicationId?: string }[] }, ctx: Ctx) => setPublished(a, ctx, true),
  publishableUnpublish: (_: unknown, a: { id: string; input: { publicationId?: string }[] }, ctx: Ctx) => setPublished(a, ctx, false),
};

function setPublished(a: { id: string; input: { publicationId?: string }[] }, ctx: Ctx, publish: boolean) {
  const errors: UE[] = [];
  a.input.forEach((i, idx) => {
    if (!i.publicationId || safeIdOf(i.publicationId, 'Publication') !== ONLINE_STORE_PUBLICATION_ID) errors.push(ue(['input', idx, 'publicationId'], 'Publication does not exist'));
  });
  const pid = safeIdOf(a.id, 'Product');
  const cid = safeIdOf(a.id, 'Collection');
  const product = pid !== null ? ctx.state.products.get(pid) : undefined;
  const collection = cid !== null ? ctx.state.collections.get(cid) : undefined;
  if (!product && !collection) errors.push(ue(['id'], 'Resource does not exist'));
  if (errors.length) return { publishable: null, shop: {}, userErrors: errors };
  if (product) {
    product.published = publish;
    product.publishedAt = publish ? (product.publishedAt ?? isoNow()) : null;
    return { publishable: productView(product), shop: {}, userErrors: [] };
  }
  collection!.published = publish;
  return { publishable: { ...collection!, __typename: 'Collection' }, shop: {}, userErrors: [] };
}

function hasDefaultTitleOption(p: ProductRec): boolean {
  return p.options.some((o) => o.name === 'Title' && o.values.length === 1 && o.values[0].name === 'Default Title');
}

function validateVariantInput(input: any, i: number, errors: UE[], mode: 'create' | 'update'): void {
  for (const f of ['price', 'compareAtPrice'] as const) {
    if (input[f] != null) {
      if (!isValidMoney(String(input[f]))) errors.push(ue(['variants', i, f], `${f === 'price' ? 'Price' : 'Compare at price'} is invalid`, 'INVALID_INPUT'));
      else if (Number(input[f]) < 0) errors.push(ue(['variants', i, f], `${f === 'price' ? 'Price' : 'Compare at price'} must be greater than or equal to 0`, 'GREATER_THAN_OR_EQUAL_TO'));
      else if (Number(input[f]) >= 1e18) errors.push(ue(['variants', i, f], 'Price must be less than 1000000000000000000', 'INVALID_INPUT'));
    }
  }
  if (input.barcode && String(input.barcode).length > 255) errors.push(ue(['variants', i, 'barcode'], 'Barcode is too long (maximum is 255 characters)', 'TOO_LONG'));
  if (input.inventoryItem?.sku && String(input.inventoryItem.sku).length > 255) errors.push(ue(['variants', i, 'inventoryItem', 'sku'], 'SKU is too long (maximum is 255 characters)', 'TOO_LONG'));
  if (mode === 'update' && input.inventoryQuantities?.length) {
    errors.push(ue(['variants', i, 'inventoryQuantities'], 'Inventory quantities can only be provided during create. To update inventory for existing variants, use inventoryAdjustQuantities.', 'INVALID_INPUT'));
  }
  if (input.mediaSrc?.length && input.mediaId) errors.push(ue(['variants', i, 'mediaId'], 'Cannot specify both mediaId and mediaSrc', 'CANNOT_SPECIFY_BOTH'));
}

function applyVariantInput(v: VariantRec, input: any, ctx: Ctx): void {
  if (input.price !== undefined && input.price !== null) v.price = formatMoney(input.price);
  if (input.compareAtPrice !== undefined) v.compareAtPrice = input.compareAtPrice === null || input.compareAtPrice === '' ? null : formatMoney(input.compareAtPrice);
  if (input.barcode !== undefined) v.barcode = input.barcode || null;
  if (input.taxable !== undefined && input.taxable !== null) v.taxable = input.taxable;
  if (input.inventoryPolicy) v.inventoryPolicy = input.inventoryPolicy;
  if (input.inventoryItem) {
    const ii = input.inventoryItem;
    if (ii.sku !== undefined) v.sku = ii.sku || null;
    if (ii.tracked !== undefined && ii.tracked !== null) v.tracked = ii.tracked;
    if (ii.requiresShipping !== undefined && ii.requiresShipping !== null) v.requiresShipping = ii.requiresShipping;
    if (ii.cost !== undefined) v.unitCost = ii.cost === null ? null : String(ii.cost);
  }
  if (input.mediaId) v.mediaId = idOf(input.mediaId, 'MediaImage');
  if (input.metafields?.length) setMetafields(ownerMetafieldInputs(gid('ProductVariant', v.id), input.metafields), ctx, (i, n) => ['metafields', i, n]);
}

function resolveOptionValues(p: ProductRec, inputs: any[], i: number, errors: UE[], current: { name: string; value: string }[] | null): { name: string; value: string }[] | null {
  const result = new Map<string, string>((current ?? []).map((o) => [o.name, o.value]));
  let ok = true;
  inputs.forEach((ov, j) => {
    let opt: OptionRec | undefined;
    if (ov.optionId) opt = p.options.find((o) => gid('ProductOption', o.id) === ov.optionId);
    else if (ov.optionName) opt = p.options.find((o) => o.name === ov.optionName);
    if (!opt) {
      errors.push(ue(['variants', i, 'optionValues', j], `Option does not exist`, 'OPTION_DOES_NOT_EXIST'));
      ok = false;
      return;
    }
    let value: string | undefined = ov.name;
    if (ov.id) value = opt.values.find((v) => gid('ProductOptionValue', v.id) === ov.id)?.name;
    if (!value) {
      errors.push(ue(['variants', i, 'optionValues', j], 'Option value does not exist', 'OPTION_VALUE_DOES_NOT_EXIST'));
      ok = false;
      return;
    }
    result.set(opt.name, value);
  });
  if (!ok) return null;
  const missing = p.options.filter((o) => !result.has(o.name));
  if (missing.length) {
    errors.push(ue(['variants', i, 'optionValues'], `You need to add option values for ${missing.map((o) => o.name).join(', ')}`, 'NEED_TO_ADD_OPTION_VALUES'));
    return null;
  }
  return p.options.map((o) => ({ name: o.name, value: result.get(o.name)! }));
}

function ensureOptionValue(p: ProductRec, optionName: string, value: string, ctx: Ctx): void {
  const opt = p.options.find((o) => o.name === optionName);
  if (opt && !opt.values.some((v) => v.name === value)) opt.values.push({ id: ctx.state.nextId('ProductOptionValue'), name: value });
}

function setMetafieldsDryRun(ownerGid: string, list: any[], ctx: Ctx): UE[] {
  const res = setMetafields(ownerMetafieldInputs(ownerGid, list), ctx, (i, n) => ['metafields', i, n], { dryRun: true });
  return res.errors.map((e) => ({ field: e.field, message: e.message, code: null }));
}

export function deleteProduct(p: ProductRec, ctx: Ctx): void {
  for (const vid of p.variantIds) {
    ctx.state.variants.delete(vid);
    ctx.state.deleteOwnerData(gid('ProductVariant', vid));
  }
  for (const mid of p.mediaIds) ctx.state.media.delete(mid);
  for (const c of ctx.state.collections.values()) c.productIds = c.productIds.filter((x) => x !== p.id);
  for (const d of ctx.state.discounts.values()) if (d.items.kind === 'products') d.items.productIds = d.items.productIds.filter((x) => x !== p.id);
  ctx.state.deleteOwnerData(gid('Product', p.id));
  for (const o of p.options) ctx.state.deleteOwnerData(gid('ProductOption', o.id));
  ctx.state.products.delete(p.id);
}

export function addRedirect(path: string, target: string, ctx: Ctx): void {
  for (const r of ctx.state.redirects.values()) if (r.path === path) ctx.state.redirects.delete(r.id);
  const id = ctx.state.nextId('UrlRedirect');
  ctx.state.redirects.set(id, { id, path, target });
}

export function newJob(ctx: Ctx): { id: string; done: boolean } {
  const id = randomUUID();
  ctx.state.jobs.set(id, { id, createdInRequest: ctx.state.requestSeq });
  return { id: gid('Job', id), done: false };
}
