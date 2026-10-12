/**
 * In-memory store of the Shopify fake, plus the "Haus Holm" seed.
 * Everything is plain data so tests can assert on it directly
 * (`fake.state.products.get(id)`, `fake.state.findProductByHandle(...)`).
 */
import { createHash } from 'node:crypto';

export type ProductStatus = 'ACTIVE' | 'ARCHIVED' | 'DRAFT' | 'UNLISTED';

export interface SeoRec {
  title: string | null;
  description: string | null;
}

export interface OptionValueRec {
  id: number;
  name: string;
}

export interface OptionRec {
  id: number;
  name: string;
  values: OptionValueRec[];
}

export interface VariantRec {
  id: number;
  productId: number;
  price: string;
  compareAtPrice: string | null;
  sku: string | null;
  barcode: string | null;
  inventoryQuantity: number;
  inventoryPolicy: 'DENY' | 'CONTINUE';
  taxable: boolean;
  tracked: boolean;
  requiresShipping: boolean;
  unitCost: string | null;
  inventoryItemId: number;
  /** option name -> value name, in product option order */
  selectedOptions: { name: string; value: string }[];
  mediaId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductRec {
  id: number;
  title: string;
  handle: string;
  descriptionHtml: string;
  status: ProductStatus;
  vendor: string;
  productType: string;
  tags: string[];
  seo: SeoRec;
  templateSuffix: string | null;
  giftCardTemplateSuffix: string | null;
  isGiftCard: boolean;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  /** published to the Online Store publication */
  published: boolean;
  options: OptionRec[];
  /** ordered variant ids */
  variantIds: number[];
  /** ordered media ids */
  mediaIds: number[];
}

export interface MediaRec {
  id: number;
  alt: string;
  url: string;
  filename: string;
  mimeType: string;
  width: number;
  height: number;
  originalSource: string;
  /** request sequence number in which the media was created (processing is simulated per request) */
  createdInRequest: number;
  createdAt: string;
  updatedAt: string;
  imageId: number;
  /** processing will end in FAILED (e.g. staged upload never received) */
  failed?: boolean;
}

export interface RuleRec {
  column: string;
  relation: string;
  condition: string;
}

export interface CollectionRec {
  id: number;
  title: string;
  handle: string;
  descriptionHtml: string;
  sortOrder: string;
  templateSuffix: string | null;
  seo: SeoRec;
  image: { url: string; altText: string | null; id: number } | null;
  ruleSet: { appliedDisjunctively: boolean; rules: RuleRec[] } | null;
  /** manual collections only, in manual order */
  productIds: number[];
  /** published to the Online Store publication */
  published: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PageRec {
  id: number;
  title: string;
  handle: string;
  body: string;
  isPublished: boolean;
  publishedAt: string | null;
  templateSuffix: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MetafieldRec {
  id: number;
  ownerId: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

export interface TranslationRec {
  resourceId: string;
  key: string;
  locale: string;
  value: string;
  /** digest of the source content at registration time (outdated detection) */
  sourceDigest: string;
  marketId: string | null;
  updatedAt: string;
}

export interface DiscountRec {
  id: number;
  title: string;
  codes: { id: number; code: string; asyncUsageCount: number }[];
  startsAt: string;
  endsAt: string | null;
  usageLimit: number | null;
  appliesOncePerCustomer: boolean;
  recurringCycleLimit: number | null;
  tags: string[];
  combinesWith: { productDiscounts: boolean; orderDiscounts: boolean; shippingDiscounts: boolean };
  context: { kind: 'all' } | { kind: 'customers'; ids: string[] } | { kind: 'segments'; ids: string[] };
  value: { kind: 'percentage'; percentage: number } | { kind: 'amount'; amount: string; appliesOnEachItem: boolean };
  items: { kind: 'all' } | { kind: 'products'; productIds: number[]; variantIds: number[] } | { kind: 'collections'; collectionIds: number[] };
  appliesOnOneTimePurchase: boolean;
  appliesOnSubscription: boolean;
  minimumRequirement: { kind: 'quantity'; quantity: string } | { kind: 'subtotal'; subtotal: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ThemeFileRec {
  filename: string;
  /** stored as text when the file is text, otherwise base64 */
  text: string | null;
  base64: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ThemeRec {
  id: number;
  name: string;
  role: 'MAIN' | 'UNPUBLISHED' | 'DEMO' | 'DEVELOPMENT' | 'ARCHIVED' | 'LOCKED';
  themeStoreId: number | null;
  createdAt: string;
  updatedAt: string;
  files: Map<string, ThemeFileRec>;
}

export interface RedirectRec {
  id: number;
  path: string;
  target: string;
}

export interface BulkOperationRec {
  id: number;
  query: string;
  status: 'CREATED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELED';
  createdAt: string;
  completedAt: string | null;
  createdInRequest: number;
  jsonl: string;
  objectCount: number;
  rootObjectCount: number;
  errorCode: string | null;
}

export interface StagedUploadRec {
  id: string;
  filename: string;
  mimeType: string;
  resource: string;
  httpMethod: 'PUT' | 'POST';
  body: Buffer | null;
  contentType: string | null;
}

export interface LocaleRec {
  locale: string;
  name: string;
  primary: boolean;
  published: boolean;
}

export interface ShopRec {
  id: number;
  name: string;
  email: string;
  contactEmail: string;
  description: string;
  myshopifyDomain: string;
  primaryDomainUrl: string;
  currencyCode: string;
  ianaTimezone: string;
  timezoneAbbreviation: string;
  weightUnit: string;
  taxesIncluded: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RequestLogEntry {
  seq: number;
  at: string;
  apiVersion: string;
  operationName: string | null;
  query: string;
  variables: unknown;
  status: number;
  /** the JSON body that was returned */
  response: unknown;
}

export type SeedVariant = Partial<Omit<VariantRec, 'id' | 'productId' | 'inventoryItemId' | 'selectedOptions'>> & { options?: string[] };

export interface FakeStateOptions {
  /** base URL of the running fake, used for CDN/staged URLs */
  baseUrl?: string;
  seed?: boolean;
}

const ID_BASES = {
  Product: 9_100_000_000_001,
  ProductVariant: 51_200_000_000_001,
  InventoryItem: 53_300_000_000_001,
  ProductOption: 11_400_000_000_001,
  ProductOptionValue: 6_500_000_000_001,
  MediaImage: 32_600_000_000_001,
  ProductImage: 41_700_000_000_001,
  Collection: 480_000_000_001,
  Page: 129_000_000_001,
  Metafield: 27_000_000_000_001,
  DiscountCodeNode: 1_480_000_000_001,
  DiscountRedeemCode: 17_000_000_000_001,
  OnlineStoreTheme: 151_000_000_001,
  UrlRedirect: 421_000_000_001,
  BulkOperation: 4_100_000_000_001,
  Job: 1,
} as const;

export type IdKind = keyof typeof ID_BASES;

export function gid(type: string, id: number | string): string {
  return `gid://shopify/${type}/${id}`;
}

export function digest(value: string | null | undefined): string {
  return createHash('sha256').update(value ?? '').digest('hex');
}

/** Shopify-like handleize: ASCII-fold, lowercase, non-alphanumerics -> '-'. */
export function handleize(input: string): string {
  return input
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’"„“”«»]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 255);
}

export function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function formatMoney(v: string | number): string {
  return Number(v).toFixed(2);
}

export class FakeShopifyState {
  baseUrl: string;
  shop!: ShopRec;
  locales: LocaleRec[] = [];
  products = new Map<number, ProductRec>();
  variants = new Map<number, VariantRec>();
  media = new Map<number, MediaRec>();
  collections = new Map<number, CollectionRec>();
  pages = new Map<number, PageRec>();
  metafields = new Map<number, MetafieldRec>();
  translations: TranslationRec[] = [];
  discounts = new Map<number, DiscountRec>();
  themes = new Map<number, ThemeRec>();
  redirects = new Map<number, RedirectRec>();
  bulkOperations = new Map<number, BulkOperationRec>();
  stagedUploads = new Map<string, StagedUploadRec>();
  jobs = new Map<string, { id: string; createdInRequest: number }>();
  locations: { id: number; name: string; isActive: boolean }[] = [];
  requestLog: RequestLogEntry[] = [];
  /** incremented once per GraphQL request; drives simulated async processing */
  requestSeq = 0;
  private counters = new Map<IdKind, number>();

  constructor(opts: FakeStateOptions = {}) {
    this.baseUrl = opts.baseUrl ?? 'http://127.0.0.1';
    this.reset(opts.seed ?? true);
  }

  nextId(kind: IdKind): number {
    const n = this.counters.get(kind) ?? ID_BASES[kind];
    this.counters.set(kind, n + 1);
    return n;
  }

  /** Clears all data (and request log) and optionally re-seeds. */
  reset(seed = true): void {
    this.counters.clear();
    this.products.clear();
    this.variants.clear();
    this.media.clear();
    this.collections.clear();
    this.pages.clear();
    this.metafields.clear();
    this.translations = [];
    this.discounts.clear();
    this.themes.clear();
    this.redirects.clear();
    this.bulkOperations.clear();
    this.stagedUploads.clear();
    this.jobs.clear();
    this.requestLog = [];
    this.requestSeq = 0;
    const t = '2026-01-15T09:00:00Z';
    this.shop = {
      id: 60_123_456_789,
      name: 'Haus Holm',
      email: 'shop@haus-holm.example',
      contactEmail: 'hallo@haus-holm.example',
      description: 'Wohnaccessoires aus Norddeutschland',
      myshopifyDomain: 'haus-holm.myshopify.com',
      primaryDomainUrl: 'https://haus-holm.myshopify.com',
      currencyCode: 'EUR',
      ianaTimezone: 'Europe/Berlin',
      timezoneAbbreviation: 'CEST',
      weightUnit: 'KILOGRAMS',
      taxesIncluded: true,
      createdAt: '2025-11-02T10:00:00Z',
      updatedAt: t,
    };
    this.locales = [
      { locale: 'de', name: 'German', primary: true, published: true },
      { locale: 'en', name: 'English', primary: false, published: true },
    ];
    this.locations = [{ id: 71_000_000_001, name: 'Lager Hamburg', isActive: true }];
    if (seed) this.seed();
  }

  primaryLocale(): string {
    return this.locales.find((l) => l.primary)?.locale ?? 'de';
  }

  /* -------------------------------------------------------- products */

  addProduct(input: {
    title: string;
    handle?: string;
    descriptionHtml?: string;
    status?: ProductStatus;
    vendor?: string;
    productType?: string;
    tags?: string[];
    seo?: Partial<SeoRec>;
    templateSuffix?: string | null;
    options?: { name: string; values: string[] }[];
    variants?: SeedVariant[];
    createdAt?: string;
    published?: boolean;
  }): ProductRec {
    const now = input.createdAt ?? isoNow();
    const id = this.nextId('Product');
    const optionDefs = input.options?.length ? input.options : [{ name: 'Title', values: ['Default Title'] }];
    const options: OptionRec[] = optionDefs.map((o) => ({
      id: this.nextId('ProductOption'),
      name: o.name,
      values: o.values.map((v) => ({ id: this.nextId('ProductOptionValue'), name: v })),
    }));
    const product: ProductRec = {
      id,
      title: input.title,
      handle: input.handle ?? this.uniqueHandle('product', handleize(input.title) || 'product'),
      descriptionHtml: input.descriptionHtml ?? '',
      status: input.status ?? 'ACTIVE',
      vendor: input.vendor ?? this.shop.name,
      productType: input.productType ?? '',
      tags: normalizeTags(input.tags ?? []),
      seo: { title: input.seo?.title ?? null, description: input.seo?.description ?? null },
      templateSuffix: input.templateSuffix ?? null,
      giftCardTemplateSuffix: null,
      isGiftCard: false,
      createdAt: now,
      updatedAt: now,
      publishedAt: input.published ? now : null,
      published: input.published ?? false,
      options,
      variantIds: [],
      mediaIds: [],
    };
    this.products.set(id, product);
    const variantDefs: SeedVariant[] = input.variants?.length ? input.variants : [{ options: options.map((o) => o.values[0].name) }];
    for (const v of variantDefs) {
      this.addVariant(product, {
        ...v,
        selectedOptions: options.map((o, i) => ({ name: o.name, value: v.options?.[i] ?? o.values[0].name })),
      });
    }
    return product;
  }

  addVariant(product: ProductRec, v: Partial<VariantRec> & { selectedOptions: { name: string; value: string }[] }): VariantRec {
    const now = isoNow();
    const rec: VariantRec = {
      id: this.nextId('ProductVariant'),
      productId: product.id,
      price: formatMoney(v.price ?? '0'),
      compareAtPrice: v.compareAtPrice != null ? formatMoney(v.compareAtPrice) : null,
      sku: v.sku ?? null,
      barcode: v.barcode ?? null,
      inventoryQuantity: v.inventoryQuantity ?? 0,
      inventoryPolicy: v.inventoryPolicy ?? 'DENY',
      taxable: v.taxable ?? true,
      tracked: v.tracked ?? true,
      requiresShipping: v.requiresShipping ?? true,
      unitCost: v.unitCost ?? null,
      inventoryItemId: this.nextId('InventoryItem'),
      selectedOptions: v.selectedOptions,
      mediaId: v.mediaId ?? null,
      createdAt: v.createdAt ?? product.createdAt ?? now,
      updatedAt: v.updatedAt ?? product.updatedAt ?? now,
    };
    this.variants.set(rec.id, rec);
    product.variantIds.push(rec.id);
    return rec;
  }

  productVariants(p: ProductRec): VariantRec[] {
    return p.variantIds.map((id) => this.variants.get(id)).filter((v): v is VariantRec => Boolean(v));
  }

  findProductByHandle(handle: string): ProductRec | undefined {
    for (const p of this.products.values()) if (p.handle === handle) return p;
    return undefined;
  }

  findCollectionByHandle(handle: string): CollectionRec | undefined {
    for (const c of this.collections.values()) if (c.handle === handle) return c;
    return undefined;
  }

  findPageByHandle(handle: string): PageRec | undefined {
    for (const p of this.pages.values()) if (p.handle === handle) return p;
    return undefined;
  }

  handleTaken(kind: 'product' | 'collection' | 'page', handle: string, exceptId?: number): boolean {
    const map: Map<number, { id: number; handle: string }> = kind === 'product' ? this.products : kind === 'collection' ? this.collections : this.pages;
    for (const r of map.values()) if (r.handle === handle && r.id !== exceptId) return true;
    return false;
  }

  /** Shopify appends -1, -2 … when a generated handle is already in use. */
  uniqueHandle(kind: 'product' | 'collection' | 'page', base: string, exceptId?: number): string {
    if (!this.handleTaken(kind, base, exceptId)) return base;
    for (let i = 1; ; i++) {
      const h = `${base}-${i}`;
      if (!this.handleTaken(kind, h, exceptId)) return h;
    }
  }

  addMedia(input: { url: string; alt?: string; filename?: string; mimeType?: string; width?: number; height?: number; originalSource?: string; ready?: boolean }): MediaRec {
    const now = isoNow();
    const rec: MediaRec = {
      id: this.nextId('MediaImage'),
      alt: input.alt ?? '',
      url: input.url,
      filename: input.filename ?? input.url.split('/').pop()?.split('?')[0] ?? 'image.jpg',
      mimeType: input.mimeType ?? 'image/jpeg',
      width: input.width ?? 2048,
      height: input.height ?? 2048,
      originalSource: input.originalSource ?? input.url,
      createdInRequest: input.ready ? -1 : this.requestSeq,
      createdAt: now,
      updatedAt: now,
      imageId: this.nextId('ProductImage'),
    };
    this.media.set(rec.id, rec);
    return rec;
  }

  /** Products a collection contains (manual list or evaluated smart rules). */
  collectionProducts(c: CollectionRec): ProductRec[] {
    if (!c.ruleSet) {
      return c.productIds.map((id) => this.products.get(id)).filter((p): p is ProductRec => Boolean(p));
    }
    const rules = c.ruleSet.rules;
    const matches = (p: ProductRec) => {
      const results = rules.map((r) => this.ruleMatches(p, r));
      if (results.length === 0) return false;
      return c.ruleSet!.appliedDisjunctively ? results.some(Boolean) : results.every(Boolean);
    };
    return [...this.products.values()].filter(matches);
  }

  private ruleMatches(p: ProductRec, r: RuleRec): boolean {
    const variants = this.productVariants(p);
    const textCompare = (value: string) => {
      const a = value.toLowerCase();
      const b = r.condition.toLowerCase();
      switch (r.relation) {
        case 'EQUALS':
          return a === b;
        case 'NOT_EQUALS':
          return a !== b;
        case 'CONTAINS':
          return a.includes(b);
        case 'NOT_CONTAINS':
          return !a.includes(b);
        case 'STARTS_WITH':
          return a.startsWith(b);
        case 'ENDS_WITH':
          return a.endsWith(b);
        default:
          return false;
      }
    };
    const numCompare = (value: number | null) => {
      if (value === null) return r.relation === 'IS_NOT_SET';
      const c = Number(r.condition);
      switch (r.relation) {
        case 'EQUALS':
          return value === c;
        case 'NOT_EQUALS':
          return value !== c;
        case 'GREATER_THAN':
          return value > c;
        case 'LESS_THAN':
          return value < c;
        case 'IS_SET':
          return true;
        default:
          return false;
      }
    };
    switch (r.column) {
      case 'TITLE':
        return textCompare(p.title);
      case 'TYPE':
        return textCompare(p.productType);
      case 'VENDOR':
        return textCompare(p.vendor);
      case 'TAG':
        return r.relation === 'NOT_EQUALS' ? !p.tags.some((t) => t.toLowerCase() === r.condition.toLowerCase()) : p.tags.some((t) => textCompare(t));
      case 'VARIANT_TITLE':
        return variants.some((v) => textCompare(v.selectedOptions.map((o) => o.value).join(' / ')));
      case 'VARIANT_PRICE':
        return variants.some((v) => numCompare(Number(v.price)));
      case 'VARIANT_COMPARE_AT_PRICE':
        return variants.some((v) => numCompare(v.compareAtPrice === null ? null : Number(v.compareAtPrice)));
      case 'VARIANT_INVENTORY':
        return variants.some((v) => numCompare(v.inventoryQuantity));
      case 'IS_PRICE_REDUCED': {
        const reduced = variants.some((v) => v.compareAtPrice !== null && Number(v.compareAtPrice) > Number(v.price));
        return r.condition === 'true' ? reduced : !reduced;
      }
      default:
        return false;
    }
  }

  productCollections(p: ProductRec): CollectionRec[] {
    return [...this.collections.values()].filter((c) => this.collectionProducts(c).some((x) => x.id === p.id));
  }

  /* -------------------------------------------------------- metafields */

  ownerMetafields(ownerId: string): MetafieldRec[] {
    return [...this.metafields.values()].filter((m) => m.ownerId === ownerId);
  }

  findMetafield(ownerId: string, namespace: string, key: string): MetafieldRec | undefined {
    for (const m of this.metafields.values()) if (m.ownerId === ownerId && m.namespace === namespace && m.key === key) return m;
    return undefined;
  }

  deleteOwnerData(ownerGid: string): void {
    for (const [id, m] of this.metafields) if (m.ownerId === ownerGid) this.metafields.delete(id);
    this.translations = this.translations.filter((t) => t.resourceId !== ownerGid);
  }

  /* -------------------------------------------------------- themes */

  mainTheme(): ThemeRec | undefined {
    for (const t of this.themes.values()) if (t.role === 'MAIN') return t;
    return undefined;
  }

  themeFileText(themeId: number, filename: string): string | null {
    const f = this.themes.get(themeId)?.files.get(filename);
    if (!f) return null;
    return f.text ?? (f.base64 ? Buffer.from(f.base64, 'base64').toString('utf8') : null);
  }

  /* -------------------------------------------------------- snapshot */

  /** JSON-friendly copy of the whole state (used by GET /__fake/state). */
  snapshot(): Record<string, unknown> {
    const themes = [...this.themes.values()].map((t) => ({ ...t, files: Object.fromEntries([...t.files.entries()].map(([k, v]) => [k, v.text ?? `base64:${v.base64}`])) }));
    return {
      shop: this.shop,
      locales: this.locales,
      products: [...this.products.values()],
      variants: [...this.variants.values()],
      media: [...this.media.values()],
      collections: [...this.collections.values()],
      pages: [...this.pages.values()],
      metafields: [...this.metafields.values()],
      translations: this.translations,
      discounts: [...this.discounts.values()],
      themes,
      redirects: [...this.redirects.values()],
      bulkOperations: [...this.bulkOperations.values()].map((b) => ({ ...b, jsonl: undefined })),
      stagedUploads: [...this.stagedUploads.values()].map((s) => ({ ...s, body: s.body ? `<${s.body.length} bytes>` : null })),
      requestCount: this.requestSeq,
    };
  }

  /* -------------------------------------------------------- seed */

  private seed(): void {
    const t = '2026-01-15T09:00:00Z';
    const cdn = (name: string) => `https://cdn.shopify.com/s/files/1/0601/2345/6789/files/${name}?v=1768467600`;

    const vase = this.addProduct({
      title: 'Vase „Kiesel“',
      handle: 'vase-kiesel',
      descriptionHtml: '<p>Handgedrehte Steinzeugvase mit matter Glasur – jede ein Unikat.</p>',
      vendor: 'Haus Holm',
      productType: 'Vase',
      tags: ['Keramik', 'Wohnen'],
      seo: { title: null, description: null },
      createdAt: t,
      published: true,
      variants: [{ price: '49.00', sku: 'HH-VASE-KIESEL', barcode: '4260123450011', inventoryQuantity: 12 }],
    });
    const vaseMedia = this.addMedia({ url: cdn('vase-kiesel.jpg'), alt: '', filename: 'vase-kiesel.jpg', ready: true });
    vase.mediaIds.push(vaseMedia.id);

    const becher = this.addProduct({
      title: 'Becher „Morgen“',
      handle: 'becher-morgen',
      descriptionHtml: '<p>Steinzeugbecher für den ersten Kaffee des Tages. Spülmaschinenfest.</p>',
      vendor: 'Haus Holm',
      productType: 'Becher',
      tags: ['Keramik', 'Küche'],
      seo: { title: 'Becher Morgen – Steinzeug | Haus Holm', description: 'Handgemachter Steinzeugbecher in drei Farben.' },
      createdAt: t,
      published: true,
      options: [
        { name: 'Farbe', values: ['Sand', 'Salbei', 'Nachtblau'] },
        { name: 'Größe', values: ['250 ml', '350 ml'] },
      ],
      variants: [
        { options: ['Sand', '250 ml'], price: '18.00', sku: 'HH-BECHER-SAND-250', barcode: '4260123450028', inventoryQuantity: 30 },
        { options: ['Sand', '350 ml'], price: '18.00', sku: 'HH-BECHER-SAND-350', barcode: '4260123450035', inventoryQuantity: 18 },
        { options: ['Salbei', '250 ml'], price: '18.00', sku: 'HH-BECHER-SALBEI-250', barcode: '4260123450042', inventoryQuantity: 0 },
        { options: ['Nachtblau', '350 ml'], price: '18.00', compareAtPrice: '22.00', sku: 'HH-BECHER-NACHT-350', barcode: '4260123450059', inventoryQuantity: 7 },
      ],
    });
    const becherMedia1 = this.addMedia({ url: cdn('becher-morgen-sand.jpg'), alt: 'Becher Morgen in Sand', filename: 'becher-morgen-sand.jpg', ready: true });
    const becherMedia2 = this.addMedia({ url: cdn('becher-morgen-nachtblau.jpg'), alt: '', filename: 'becher-morgen-nachtblau.jpg', ready: true });
    becher.mediaIds.push(becherMedia1.id, becherMedia2.id);

    const plaid = this.addProduct({
      title: 'Plaid „Düne“',
      handle: 'plaid-duene',
      descriptionHtml: '<p>Weiches Plaid aus Wolle und Baumwolle, 130 × 170 cm.</p>',
      vendor: 'Haus Holm',
      productType: 'Textil',
      tags: ['Textil', 'Wohnen'],
      seo: { title: null, description: null },
      createdAt: t,
      published: true,
      variants: [{ price: '89.00', sku: 'HH-PLAID-DUENE', barcode: '4260123450066', inventoryQuantity: 5 }],
    });

    const manual: CollectionRec = {
      id: this.nextId('Collection'),
      title: 'Wohnaccessoires',
      handle: 'wohnaccessoires',
      descriptionHtml: '<p>Ausgewählte Stücke für ein ruhiges Zuhause.</p>',
      sortOrder: 'MANUAL',
      templateSuffix: null,
      seo: { title: null, description: null },
      image: null,
      ruleSet: null,
      productIds: [vase.id, becher.id, plaid.id],
      published: true,
      createdAt: t,
      updatedAt: t,
    };
    this.collections.set(manual.id, manual);
    const smart: CollectionRec = {
      id: this.nextId('Collection'),
      title: 'Keramik',
      handle: 'keramik',
      descriptionHtml: '<p>Alles aus Steinzeug.</p>',
      sortOrder: 'BEST_SELLING',
      templateSuffix: null,
      seo: { title: null, description: null },
      image: null,
      ruleSet: { appliedDisjunctively: false, rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'Keramik' }] },
      productIds: [],
      published: true,
      createdAt: t,
      updatedAt: t,
    };
    this.collections.set(smart.id, smart);

    const page: PageRec = {
      id: this.nextId('Page'),
      title: 'Über uns',
      handle: 'ueber-uns',
      body: '<p>Haus Holm ist eine kleine Manufaktur an der Nordsee. Wir gestalten Dinge, die bleiben.</p>',
      isPublished: true,
      publishedAt: t,
      templateSuffix: null,
      createdAt: t,
      updatedAt: t,
    };
    this.pages.set(page.id, page);

    const mf: MetafieldRec = {
      id: this.nextId('Metafield'),
      ownerId: gid('Product', vase.id),
      namespace: 'custom',
      key: 'material',
      type: 'single_line_text_field',
      value: 'Steinzeug',
      createdAt: t,
      updatedAt: t,
    };
    this.metafields.set(mf.id, mf);

    this.translations.push({
      resourceId: gid('Product', becher.id),
      key: 'title',
      locale: 'en',
      value: 'Mug “Morning”',
      sourceDigest: digest(becher.title),
      marketId: null,
      updatedAt: t,
    });

    const main: ThemeRec = { id: this.nextId('OnlineStoreTheme'), name: 'Dawn', role: 'MAIN', themeStoreId: 887, createdAt: t, updatedAt: t, files: new Map() };
    for (const [name, text] of Object.entries(seedThemeFiles())) main.files.set(name, { filename: name, text, base64: null, createdAt: t, updatedAt: t });
    this.themes.set(main.id, main);
    const copy: ThemeRec = { id: this.nextId('OnlineStoreTheme'), name: 'Dawn (Entwurf)', role: 'UNPUBLISHED', themeStoreId: 887, createdAt: t, updatedAt: t, files: new Map() };
    for (const [name, f] of main.files) copy.files.set(name, { ...f });
    this.themes.set(copy.id, copy);
  }
}

export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags.flatMap((t) => t.split(','))) {
    const t = raw.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function section(name: string, settings: unknown[] = [], extra: Record<string, unknown> = {}): string {
  const schema = { name, settings, ...extra };
  return `<div class="section-${handleize(name)}">\n  {{ section.settings.heading }}\n</div>\n\n{% schema %}\n${JSON.stringify(schema, null, 2)}\n{% endschema %}\n`;
}

export function seedThemeFiles(): Record<string, string> {
  const json = (v: unknown) => JSON.stringify(v, null, 2);
  return {
    'layout/theme.liquid':
      '<!doctype html>\n<html lang="{{ request.locale.iso_code }}">\n<head>\n  <title>{{ page_title }}</title>\n  {{ content_for_header }}\n  {{ \'base.css\' | asset_url | stylesheet_tag }}\n</head>\n<body>\n  {% sections \'header-group\' %}\n  <main id="MainContent">{{ content_for_layout }}</main>\n  {% sections \'footer-group\' %}\n</body>\n</html>\n',
    'assets/base.css': ':root { --color-base: #1f2a2e; }\nbody { font-family: system-ui, sans-serif; color: var(--color-base); }\n',
    'sections/header.liquid': section('Header', [{ type: 'link_list', id: 'menu', label: 'Menü', default: 'main-menu' }]),
    'sections/footer.liquid': section('Footer'),
    'sections/header-group.json': json({ type: 'header', name: 'Header group', sections: { header: { type: 'header', settings: {} } }, order: ['header'] }),
    'sections/footer-group.json': json({ type: 'footer', name: 'Footer group', sections: { footer: { type: 'footer', settings: {} } }, order: ['footer'] }),
    'sections/image-banner.liquid': section('Bild-Banner', [{ type: 'image_picker', id: 'image', label: 'Bild' }, { type: 'text', id: 'heading', label: 'Überschrift' }], { presets: [{ name: 'Bild-Banner' }] }),
    'sections/featured-collection.liquid': section('Hervorgehobene Kollektion', [{ type: 'text', id: 'title', label: 'Titel' }, { type: 'collection', id: 'collection', label: 'Kollektion' }, { type: 'range', id: 'products_to_show', min: 2, max: 12, step: 1, default: 4, label: 'Anzahl' }], { presets: [{ name: 'Hervorgehobene Kollektion' }] }),
    'sections/rich-text.liquid': section('Rich Text', [{ type: 'richtext', id: 'text', label: 'Text' }], { presets: [{ name: 'Rich Text' }] }),
    'sections/main-product.liquid': section('Produktinformationen'),
    'sections/main-collection-banner.liquid': section('Kollektionsbanner'),
    'sections/main-collection-product-grid.liquid': section('Produktraster', [{ type: 'range', id: 'products_per_page', min: 8, max: 24, step: 4, default: 16, label: 'Produkte pro Seite' }]),
    'sections/main-page.liquid': section('Seite'),
    'snippets/price.liquid': '<span class="price">{{ product.price | money }}</span>\n',
    'templates/index.json': json({
      sections: {
        image_banner: { type: 'image-banner', settings: { heading: 'Dinge, die bleiben' } },
        featured_collection: { type: 'featured-collection', settings: { title: 'Wohnaccessoires', collection: 'wohnaccessoires', products_to_show: 4 } },
      },
      order: ['image_banner', 'featured_collection'],
    }),
    'templates/product.json': json({ sections: { main: { type: 'main-product', settings: {} } }, order: ['main'] }),
    'templates/collection.json': json({
      sections: { banner: { type: 'main-collection-banner', settings: {} }, product_grid: { type: 'main-collection-product-grid', settings: { products_per_page: 16 } } },
      order: ['banner', 'product_grid'],
    }),
    'templates/page.json': json({ sections: { main: { type: 'main-page', settings: {} } }, order: ['main'] }),
    'config/settings_schema.json': json([{ name: 'theme_info', theme_name: 'Dawn', theme_version: '15.4.0', theme_author: 'Shopify' }]),
    'config/settings_data.json': json({ current: { colors_solid_button_labels: '#ffffff' }, presets: { Default: {} } }),
    'locales/de.default.json': json({ general: { search: 'Suche', cart: 'Warenkorb' } }),
    'locales/en.json': json({ general: { search: 'Search', cart: 'Cart' } }),
  };
}
