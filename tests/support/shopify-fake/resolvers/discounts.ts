/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ResolveInfo } from '../graphql';
import { type ConnArgs, type Ctx, idOf, mapConn, metafieldResolvers, money, paginate, safeIdOf, search, sortBy, ue, type UE } from '../context';
import type { SearchSpec } from '../search';
import { gid, isoNow, type CollectionRec, type DiscountRec, type ProductRec, type VariantRec } from '../state';

export function discountStatus(d: DiscountRec): 'ACTIVE' | 'EXPIRED' | 'SCHEDULED' {
  const now = Date.now();
  if (Date.parse(d.startsAt) > now) return 'SCHEDULED';
  if (d.endsAt && Date.parse(d.endsAt) <= now) return 'EXPIRED';
  return 'ACTIVE';
}

function formatAmount(amount: string | number, ctx: Ctx): string {
  const n = Number(amount);
  return ctx.state.shop.currencyCode === 'EUR' ? `€${n.toFixed(2)}` : `${n.toFixed(2)} ${ctx.state.shop.currencyCode}`;
}

function summary(d: DiscountRec, ctx: Ctx): string {
  const value = d.value.kind === 'percentage' ? `${Math.round(d.value.percentage * 10000) / 100}% off` : `${formatAmount(d.value.amount, ctx)} off`;
  let target = 'entire order';
  if (d.items.kind === 'products') {
    const n = d.items.productIds.length + d.items.variantIds.length;
    target = n === 1 ? '1 product' : `${n} products`;
  } else if (d.items.kind === 'collections') {
    const n = d.items.collectionIds.length;
    target = n === 1 ? '1 collection' : `${n} collections`;
  }
  const parts = [`${value} ${target}`];
  if (d.minimumRequirement?.kind === 'subtotal') parts.push(`Minimum purchase of ${formatAmount(d.minimumRequirement.subtotal, ctx)}`);
  if (d.minimumRequirement?.kind === 'quantity') parts.push(`Minimum quantity of ${d.minimumRequirement.quantity} items`);
  if (d.appliesOncePerCustomer) parts.push('One use per customer');
  if (d.usageLimit) parts.push(`Limit of ${d.usageLimit} uses`);
  return parts.join(' • ');
}

const discountSearchSpec: SearchSpec<DiscountRec> = {
  fields: {
    title: { kind: 'text', get: (d) => d.title },
    status: { kind: 'keyword', get: (d) => discountStatus(d) },
    starts_at: { kind: 'date', get: (d) => d.startsAt },
    ends_at: { kind: 'date', get: (d) => d.endsAt },
    created_at: { kind: 'date', get: (d) => d.createdAt },
    updated_at: { kind: 'date', get: (d) => d.updatedAt },
    id: { kind: 'number', get: (d) => d.id },
    type: { kind: 'keyword', get: (d) => (d.value.kind === 'percentage' ? 'percentage' : 'fixed_amount') },
    discount_type: { kind: 'keyword', get: (d) => (d.value.kind === 'percentage' ? 'percentage' : 'fixed_amount') },
    discount_class: { kind: 'keyword', get: (d) => (d.items.kind === 'all' ? 'order' : 'product') },
    times_used: { kind: 'number', get: (d) => d.codes.reduce((s, c) => s + c.asyncUsageCount, 0) },
    combines_with: {
      kind: 'keyword',
      get: (d) => [d.combinesWith.productDiscounts && 'product_discounts', d.combinesWith.orderDiscounts && 'order_discounts', d.combinesWith.shippingDiscounts && 'shipping_discounts'].filter(Boolean) as string[],
    },
  },
  freeText: (d) => [d.title, ...d.codes.map((c) => c.code)],
};

function nodeView(d: DiscountRec) {
  return { __rec: d, __typename: 'DiscountCodeNode' };
}

export const discountTypes = {
  DiscountCodeNode: {
    id: (n: { __rec: DiscountRec }) => gid('DiscountCodeNode', n.__rec.id),
    codeDiscount: (n: { __rec: DiscountRec }) => ({ __rec: n.__rec, __typename: 'DiscountCodeBasic' }),
    ...metafieldResolvers((n: { __rec: DiscountRec }) => gid('DiscountCodeNode', n.__rec.id)),
  },
  DiscountCodeBasic: {
    title: (n: { __rec: DiscountRec }) => n.__rec.title,
    status: (n: { __rec: DiscountRec }) => discountStatus(n.__rec),
    summary: (n: { __rec: DiscountRec }, _: unknown, ctx: Ctx) => summary(n.__rec, ctx),
    shortSummary: (n: { __rec: DiscountRec }, _: unknown, ctx: Ctx) => summary(n.__rec, ctx).split(' • ')[0],
    startsAt: (n: { __rec: DiscountRec }) => n.__rec.startsAt,
    endsAt: (n: { __rec: DiscountRec }) => n.__rec.endsAt,
    createdAt: (n: { __rec: DiscountRec }) => n.__rec.createdAt,
    updatedAt: (n: { __rec: DiscountRec }) => n.__rec.updatedAt,
    usageLimit: (n: { __rec: DiscountRec }) => n.__rec.usageLimit,
    appliesOncePerCustomer: (n: { __rec: DiscountRec }) => n.__rec.appliesOncePerCustomer,
    asyncUsageCount: (n: { __rec: DiscountRec }) => n.__rec.codes.reduce((s, c) => s + c.asyncUsageCount, 0),
    recurringCycleLimit: (n: { __rec: DiscountRec }) => n.__rec.recurringCycleLimit,
    tags: (n: { __rec: DiscountRec }) => n.__rec.tags,
    discountClasses: (n: { __rec: DiscountRec }) => [n.__rec.items.kind === 'all' ? 'ORDER' : 'PRODUCT'],
    discountClass: (n: { __rec: DiscountRec }) => (n.__rec.items.kind === 'all' ? 'ORDER' : 'PRODUCT'),
    codes: (n: { __rec: DiscountRec }, a: ConnArgs, ctx: Ctx) =>
      mapConn(paginate(n.__rec.codes, a, ctx, (c) => c.id), (c) => ({ id: gid('DiscountRedeemCode', c.id), code: c.code, asyncUsageCount: c.asyncUsageCount })),
    codesCount: (n: { __rec: DiscountRec }) => ({ count: n.__rec.codes.length, precision: 'EXACT' }),
    combinesWith: (n: { __rec: DiscountRec }) => n.__rec.combinesWith,
    context: (n: { __rec: DiscountRec }) => {
      const c = n.__rec.context;
      if (c.kind === 'customers') return { __typename: 'DiscountCustomers', customers: c.ids.map((id) => ({ id })) };
      if (c.kind === 'segments') return { __typename: 'DiscountCustomerSegments', segments: c.ids.map((id) => ({ id, name: 'Segment' })) };
      return { __typename: 'DiscountBuyerSelectionAll', all: 'ALL' };
    },
    customerSelection: (n: { __rec: DiscountRec }) => {
      const c = n.__rec.context;
      if (c.kind === 'customers') return { __typename: 'DiscountCustomers', customers: c.ids.map((id) => ({ id })) };
      if (c.kind === 'segments') return { __typename: 'DiscountCustomerSegments', segments: c.ids.map((id) => ({ id, name: 'Segment' })) };
      return { __typename: 'DiscountCustomerAll', allCustomers: true };
    },
    customerGets: (n: { __rec: DiscountRec }, _: unknown, ctx: Ctx) => {
      const d = n.__rec;
      const cur = ctx.state.shop.currencyCode;
      const value =
        d.value.kind === 'percentage'
          ? { __typename: 'DiscountPercentage', percentage: d.value.percentage }
          : { __typename: 'DiscountAmount', amount: money(d.value.amount, cur), appliesOnEachItem: d.value.appliesOnEachItem };
      let items: any = { __typename: 'AllDiscountItems', allItems: true };
      if (d.items.kind === 'products') items = { __typename: 'DiscountProducts', __rec: d };
      if (d.items.kind === 'collections') items = { __typename: 'DiscountCollections', __rec: d };
      return { value, items, appliesOnOneTimePurchase: d.appliesOnOneTimePurchase, appliesOnSubscription: d.appliesOnSubscription };
    },
    minimumRequirement: (n: { __rec: DiscountRec }, _: unknown, ctx: Ctx) => {
      const m = n.__rec.minimumRequirement;
      if (!m) return null;
      if (m.kind === 'quantity') return { __typename: 'DiscountMinimumQuantity', greaterThanOrEqualToQuantity: m.quantity };
      return { __typename: 'DiscountMinimumSubtotal', greaterThanOrEqualToSubtotal: money(m.subtotal, ctx.state.shop.currencyCode) };
    },
    hasTimelineComment: () => false,
    totalSales: (_: unknown, __: unknown, ctx: Ctx) => money(0, ctx.state.shop.currencyCode),
  },
  DiscountProducts: {
    products: (n: { __rec: DiscountRec }, a: ConnArgs, ctx: Ctx) => {
      const ids = n.__rec.items.kind === 'products' ? n.__rec.items.productIds : [];
      return paginate(ids.map((id) => ctx.state.products.get(id)).filter((p): p is ProductRec => Boolean(p)), a, ctx, (p) => p.id);
    },
    productVariants: (n: { __rec: DiscountRec }, a: ConnArgs, ctx: Ctx) => {
      const ids = n.__rec.items.kind === 'products' ? n.__rec.items.variantIds : [];
      return paginate(ids.map((id) => ctx.state.variants.get(id)).filter((v): v is VariantRec => Boolean(v)), a, ctx, (v) => v.id);
    },
  },
  DiscountCollections: {
    collections: (n: { __rec: DiscountRec }, a: ConnArgs, ctx: Ctx) => {
      const ids = n.__rec.items.kind === 'collections' ? n.__rec.items.collectionIds : [];
      return paginate(ids.map((id) => ctx.state.collections.get(id)).filter((c): c is CollectionRec => Boolean(c)), a, ctx, (c) => c.id);
    },
  },
};

export const discountQueries = {
  codeDiscountNodes: (_: unknown, a: ConnArgs & { query?: string; sortKey?: string }, ctx: Ctx, info: ResolveInfo) => {
    let list = [...ctx.state.discounts.values()];
    if (a.sortKey === 'TITLE') list = sortBy(list, (d) => d.title, (d) => d.id);
    else if (a.sortKey === 'CREATED_AT') list = sortBy(list, (d) => d.createdAt, (d) => d.id);
    else if (a.sortKey === 'UPDATED_AT') list = sortBy(list, (d) => d.updatedAt, (d) => d.id);
    else if (a.sortKey === 'STARTS_AT') list = sortBy(list, (d) => d.startsAt, (d) => d.id);
    else if (a.sortKey === 'ENDS_AT') list = sortBy(list, (d) => d.endsAt ?? '9999', (d) => d.id);
    else list = sortBy(list, (d) => d.id, (d) => d.id);
    list = search(list, a.query, discountSearchSpec, ctx, info);
    return mapConn(paginate(list, a, ctx, (d) => d.id), nodeView);
  },
  codeDiscountNode: (_: unknown, a: { id: string }, ctx: Ctx) => {
    const id = idOf(a.id, 'DiscountCodeNode');
    const d = id !== null ? ctx.state.discounts.get(id) : undefined;
    return d ? nodeView(d) : null;
  },
  codeDiscountNodeByCode: (_: unknown, a: { code: string }, ctx: Ctx) => {
    for (const d of ctx.state.discounts.values()) if (d.codes.some((c) => c.code.toLowerCase() === a.code.toLowerCase())) return nodeView(d);
    return null;
  },
};

function codeTaken(code: string, ctx: Ctx, exceptId?: number): boolean {
  for (const d of ctx.state.discounts.values()) if (d.id !== exceptId && d.codes.some((c) => c.code.toLowerCase() === code.toLowerCase())) return true;
  return false;
}

/** Validates DiscountCodeBasicInput and merges it into a (new or existing) record. */
function buildDiscount(input: any, existing: DiscountRec | null, ctx: Ctx): { errors: UE[]; rec: DiscountRec | null } {
  const errors: UE[] = [];
  const f = (...p: (string | number)[]) => ['basicCodeDiscount', ...p];
  const create = !existing;
  const now = isoNow();
  const base: DiscountRec = existing
    ? structuredClone(existing)
    : {
        id: 0,
        title: '',
        codes: [],
        startsAt: '',
        endsAt: null,
        usageLimit: null,
        appliesOncePerCustomer: false,
        recurringCycleLimit: null,
        tags: [],
        combinesWith: { productDiscounts: false, orderDiscounts: false, shippingDiscounts: false },
        context: { kind: 'all' },
        value: { kind: 'percentage', percentage: 0 },
        items: { kind: 'all' },
        appliesOnOneTimePurchase: true,
        appliesOnSubscription: false,
        minimumRequirement: null,
        createdAt: now,
        updatedAt: now,
      };

  if (input.title !== undefined) base.title = input.title ?? '';
  if (create || input.title !== undefined) {
    if (!String(base.title).trim()) errors.push(ue(f('title'), "Title can't be blank", 'BLANK'));
    if (base.title.length > 255) errors.push(ue(f('title'), 'Title is too long (maximum is 255 characters)', 'TOO_LONG'));
  }
  if (input.code !== undefined || create) {
    const code = String(input.code ?? '').trim();
    if (!code) errors.push(ue(f('code'), "Code can't be blank", 'BLANK'));
    else if (code.length > 255) errors.push(ue(f('code'), 'Code is too long (maximum is 255 characters)', 'TOO_LONG'));
    else if (/[\r\n]/.test(code)) errors.push(ue(f('code'), 'Code cannot contain newline characters.', 'INVALID'));
    else if (codeTaken(code, ctx, existing?.id)) errors.push(ue(f('code'), 'Code must be unique. Please try a different code.', 'TAKEN'));
    else if (base.codes.length) base.codes[0].code = code;
    else base.codes.push({ id: ctx.state.nextId('DiscountRedeemCode'), code, asyncUsageCount: 0 });
  }
  if (input.startsAt !== undefined) base.startsAt = input.startsAt ? normalizeDate(input.startsAt) : '';
  if (create && !base.startsAt) errors.push(ue(f('startsAt'), "Starts at can't be blank", 'BLANK'));
  if (input.endsAt !== undefined) base.endsAt = input.endsAt ? normalizeDate(input.endsAt) : null;
  if (base.endsAt && base.startsAt && Date.parse(base.endsAt) <= Date.parse(base.startsAt)) errors.push(ue(f('endsAt'), 'Ends at needs to be after starts_at', 'INVALID'));
  if (input.usageLimit !== undefined) {
    if (input.usageLimit !== null && input.usageLimit < 1) errors.push(ue(f('usageLimit'), 'Usage limit must be greater than 0', 'GREATER_THAN'));
    base.usageLimit = input.usageLimit;
  }
  if (input.appliesOncePerCustomer != null) base.appliesOncePerCustomer = input.appliesOncePerCustomer;
  if (input.recurringCycleLimit !== undefined) base.recurringCycleLimit = input.recurringCycleLimit;
  if (input.tags) base.tags = input.tags;
  if (input.combinesWith) base.combinesWith = { ...base.combinesWith, ...Object.fromEntries(Object.entries(input.combinesWith).filter(([, v]) => v != null)) };

  if (input.context && input.customerSelection) errors.push(ue(f('context'), 'Only one of context or customerSelection can be provided.', 'INVALID'));
  const sel = input.context ?? input.customerSelection;
  const selField = input.context ? 'context' : 'customerSelection';
  if (sel) {
    const kinds = [sel.all ? 'all' : null, sel.customers ? 'customers' : null, sel.customerSegments ? 'segments' : null].filter(Boolean);
    if (kinds.length !== 1) errors.push(ue(f(selField), 'Exactly one buyer selection must be specified.', 'INVALID'));
    else if (kinds[0] === 'all') base.context = { kind: 'all' };
    else if (kinds[0] === 'customers') base.context = { kind: 'customers', ids: sel.customers.add ?? [] };
    else base.context = { kind: 'segments', ids: sel.customerSegments.add ?? [] };
  } else if (create) {
    errors.push(ue(f('context'), 'Context must be specified (use context: { all: ALL } for all buyers).', 'MISSING_ARGUMENT'));
  }

  const cg = input.customerGets;
  if (create && !cg) errors.push(ue(f('customerGets'), "Customer gets can't be blank", 'BLANK'));
  if (cg) {
    if (cg.value) {
      const v = cg.value;
      const given = [v.percentage != null, v.discountAmount != null, v.discountOnQuantity != null].filter(Boolean).length;
      if (given !== 1) errors.push(ue(f('customerGets', 'value'), 'Exactly one discount value type must be specified.', 'INVALID'));
      else if (v.discountOnQuantity) errors.push(ue(f('customerGets', 'value', 'discountOnQuantity'), 'discountOnQuantity is only valid for Buy X Get Y discounts.', 'INVALID'));
      else if (v.percentage != null) {
        if (v.percentage < 0 || v.percentage > 1) errors.push(ue(f('customerGets', 'value', 'percentage'), 'Value must be between 0.0 and 1.0', 'VALUE_OUTSIDE_RANGE'));
        else base.value = { kind: 'percentage', percentage: v.percentage };
      } else {
        const amt = Number(v.discountAmount.amount);
        if (v.discountAmount.amount == null || Number.isNaN(amt)) errors.push(ue(f('customerGets', 'value', 'discountAmount', 'amount'), "Amount can't be blank", 'BLANK'));
        else if (amt <= 0) errors.push(ue(f('customerGets', 'value', 'discountAmount', 'amount'), 'Value must be greater than 0', 'GREATER_THAN'));
        else base.value = { kind: 'amount', amount: String(amt), appliesOnEachItem: Boolean(v.discountAmount.appliesOnEachItem) };
      }
    } else if (create) {
      errors.push(ue(f('customerGets', 'value'), "Value can't be blank", 'BLANK'));
    }
    if (cg.items) {
      const it = cg.items;
      const given = [it.all != null && it.all !== false, it.products != null, it.collections != null].filter(Boolean).length;
      if (given !== 1) errors.push(ue(f('customerGets', 'items'), 'Exactly one item selection must be specified.', 'INVALID'));
      else if (it.all) base.items = { kind: 'all' };
      else if (it.products) {
        const prev = base.items.kind === 'products' ? base.items : { kind: 'products' as const, productIds: [], variantIds: [] };
        const productIds = new Set(prev.productIds);
        const variantIds = new Set(prev.variantIds);
        (it.products.productsToAdd ?? []).forEach((raw: string, i: number) => {
          const id = safeIdOf(raw, 'Product');
          if (id === null || !ctx.state.products.has(id)) errors.push(ue(f('customerGets', 'items', 'products', 'productsToAdd', i), `Product with id: ${raw} is invalid`, 'INVALID'));
          else productIds.add(id);
        });
        (it.products.productVariantsToAdd ?? []).forEach((raw: string, i: number) => {
          const id = safeIdOf(raw, 'ProductVariant');
          if (id === null || !ctx.state.variants.has(id)) errors.push(ue(f('customerGets', 'items', 'products', 'productVariantsToAdd', i), `Product variant with id: ${raw} is invalid`, 'INVALID'));
          else variantIds.add(id);
        });
        for (const raw of it.products.productsToRemove ?? []) productIds.delete(safeIdOf(raw, 'Product') ?? -1);
        for (const raw of it.products.productVariantsToRemove ?? []) variantIds.delete(safeIdOf(raw, 'ProductVariant') ?? -1);
        if (!productIds.size && !variantIds.size) errors.push(ue(f('customerGets', 'items', 'products'), 'At least one product or variant must be selected', 'BLANK'));
        base.items = { kind: 'products', productIds: [...productIds], variantIds: [...variantIds] };
      } else {
        const prev = base.items.kind === 'collections' ? base.items.collectionIds : [];
        const ids = new Set(prev);
        (it.collections.add ?? []).forEach((raw: string, i: number) => {
          const id = safeIdOf(raw, 'Collection');
          if (id === null || !ctx.state.collections.has(id)) errors.push(ue(f('customerGets', 'items', 'collections', 'add', i), `Collection with id: ${raw} is invalid`, 'INVALID'));
          else ids.add(id);
        });
        for (const raw of it.collections.remove ?? []) ids.delete(safeIdOf(raw, 'Collection') ?? -1);
        if (!ids.size) errors.push(ue(f('customerGets', 'items', 'collections'), 'At least one collection must be selected', 'BLANK'));
        base.items = { kind: 'collections', collectionIds: [...ids] };
      }
    } else if (create) {
      errors.push(ue(f('customerGets', 'items'), "Items can't be blank", 'BLANK'));
    }
    if (cg.appliesOnOneTimePurchase != null) base.appliesOnOneTimePurchase = cg.appliesOnOneTimePurchase;
    if (cg.appliesOnSubscription != null) base.appliesOnSubscription = cg.appliesOnSubscription;
  }

  if (input.minimumRequirement !== undefined) {
    const m = input.minimumRequirement;
    if (m === null) base.minimumRequirement = null;
    else if (m.quantity && m.subtotal) errors.push(ue(f('minimumRequirement'), 'Only one minimum requirement can be specified.', 'CONFLICT'));
    else if (m.quantity) {
      const q = Number(m.quantity.greaterThanOrEqualToQuantity);
      if (!Number.isInteger(q) || q < 1) errors.push(ue(f('minimumRequirement', 'quantity', 'greaterThanOrEqualToQuantity'), 'Minimum quantity must be greater than 0', 'GREATER_THAN'));
      else base.minimumRequirement = { kind: 'quantity', quantity: String(q) };
    } else if (m.subtotal) {
      const s = Number(m.subtotal.greaterThanOrEqualToSubtotal);
      if (Number.isNaN(s) || s <= 0) errors.push(ue(f('minimumRequirement', 'subtotal', 'greaterThanOrEqualToSubtotal'), 'Minimum subtotal must be greater than 0', 'GREATER_THAN'));
      else base.minimumRequirement = { kind: 'subtotal', subtotal: String(s) };
    } else {
      base.minimumRequirement = null;
    }
  }
  if (errors.length) return { errors, rec: null };
  base.updatedAt = now;
  return { errors, rec: base };
}

function normalizeDate(v: string): string {
  return new Date(v).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export const discountMutations = {
  discountCodeBasicCreate: (_: unknown, a: { basicCodeDiscount: any }, ctx: Ctx) => {
    const { errors, rec } = buildDiscount(a.basicCodeDiscount, null, ctx);
    if (!rec) return { codeDiscountNode: null, userErrors: errors };
    rec.id = ctx.state.nextId('DiscountCodeNode');
    ctx.state.discounts.set(rec.id, rec);
    return { codeDiscountNode: nodeView(rec), userErrors: [] };
  },
  discountCodeBasicUpdate: (_: unknown, a: { id: string; basicCodeDiscount: any }, ctx: Ctx) => {
    const id = safeIdOf(a.id, 'DiscountCodeNode');
    const existing = id !== null ? ctx.state.discounts.get(id) : undefined;
    if (!existing) return { codeDiscountNode: null, userErrors: [ue(['id'], 'Discount does not exist', 'INVALID')] };
    const { errors, rec } = buildDiscount(a.basicCodeDiscount, existing, ctx);
    if (!rec) return { codeDiscountNode: null, userErrors: errors };
    ctx.state.discounts.set(rec.id, rec);
    return { codeDiscountNode: nodeView(rec), userErrors: [] };
  },
  discountCodeDelete: (_: unknown, a: { id: string }, ctx: Ctx) => {
    const id = safeIdOf(a.id, 'DiscountCodeNode');
    if (id === null || !ctx.state.discounts.has(id)) return { deletedCodeDiscountId: null, userErrors: [ue(['id'], 'Discount does not exist', 'INVALID')] };
    ctx.state.discounts.delete(id);
    ctx.state.deleteOwnerData(gid('DiscountCodeNode', id));
    return { deletedCodeDiscountId: gid('DiscountCodeNode', id), userErrors: [] };
  },
  discountCodeActivate: (_: unknown, a: { id: string }, ctx: Ctx) => {
    const id = safeIdOf(a.id, 'DiscountCodeNode');
    const d = id !== null ? ctx.state.discounts.get(id) : undefined;
    if (!d) return { codeDiscountNode: null, userErrors: [ue(['id'], 'Discount does not exist', 'INVALID')] };
    if (discountStatus(d) !== 'ACTIVE') {
      d.startsAt = Date.parse(d.startsAt) > Date.now() ? isoNow() : d.startsAt;
      d.endsAt = null;
      d.updatedAt = isoNow();
    }
    return { codeDiscountNode: nodeView(d), userErrors: [] };
  },
  discountCodeDeactivate: (_: unknown, a: { id: string }, ctx: Ctx) => {
    const id = safeIdOf(a.id, 'DiscountCodeNode');
    const d = id !== null ? ctx.state.discounts.get(id) : undefined;
    if (!d) return { codeDiscountNode: null, userErrors: [ue(['id'], 'Discount does not exist', 'INVALID')] };
    const now = isoNow();
    if (Date.parse(d.startsAt) > Date.now()) d.startsAt = now;
    d.endsAt = now;
    d.updatedAt = now;
    return { codeDiscountNode: nodeView(d), userErrors: [] };
  },
};
