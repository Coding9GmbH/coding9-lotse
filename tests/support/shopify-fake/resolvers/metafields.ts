/* eslint-disable @typescript-eslint/no-explicit-any */
import { type Ctx, metafieldView, parseGid, ue, type UE } from '../context';
import { digest, gid, isoNow, type MetafieldRec } from '../state';

export interface MetafieldSetInput {
  ownerId: string;
  namespace?: string | null;
  key: string;
  value: string;
  type?: string | null;
  compareDigest?: string | null;
}

const BASE_TYPES = new Set([
  'single_line_text_field', 'multi_line_text_field', 'rich_text_field', 'json', 'number_integer', 'number_decimal', 'boolean',
  'url', 'date', 'date_time', 'color', 'money', 'weight', 'volume', 'dimension', 'rating', 'link', 'id',
  'product_reference', 'variant_reference', 'collection_reference', 'page_reference', 'file_reference', 'metaobject_reference',
  'mixed_reference', 'customer_reference', 'company_reference',
]);

const LISTABLE = new Set([
  'single_line_text_field', 'number_integer', 'number_decimal', 'url', 'date', 'date_time', 'color', 'weight', 'volume', 'dimension',
  'rating', 'link', 'product_reference', 'variant_reference', 'collection_reference', 'page_reference', 'file_reference',
  'metaobject_reference', 'mixed_reference', 'customer_reference', 'company_reference',
]);

export function isValidMetafieldType(type: string): boolean {
  if (type.startsWith('list.')) return LISTABLE.has(type.slice(5));
  return BASE_TYPES.has(type);
}

/** Returns an error message or null. */
export function validateMetafieldValue(type: string, value: string, ctx: Ctx): string | null {
  if (type.startsWith('list.')) {
    let arr: unknown;
    try {
      arr = JSON.parse(value);
    } catch {
      return 'Value must be a JSON array.';
    }
    if (!Array.isArray(arr)) return 'Value must be a JSON array.';
    const inner = type.slice(5);
    for (const item of arr) {
      const s = typeof item === 'string' ? item : JSON.stringify(item);
      const err = validateMetafieldValue(inner, s, ctx);
      if (err) return `Value at index ${arr.indexOf(item)}: ${err}`;
    }
    return null;
  }
  const json = () => {
    try {
      return { ok: true as const, v: JSON.parse(value) };
    } catch {
      return { ok: false as const, v: undefined };
    }
  };
  const ref = (t: string, exists: (n: number) => boolean) => {
    const m = /^gid:\/\/shopify\/([A-Za-z]+)\/(\d+)$/.exec(value);
    if (!m || m[1] !== t) return `Value must be a valid ${t} reference.`;
    return exists(Number(m[2])) ? null : `Value require that you select a ${t.toLowerCase()}.`;
  };
  switch (type) {
    case 'single_line_text_field':
      return /[\r\n]/.test(value) ? 'Value must be a single line text string.' : null;
    case 'multi_line_text_field':
    case 'id':
      return null;
    case 'rich_text_field': {
      const j = json();
      return j.ok && j.v && j.v.type === 'root' ? null : "Value must be a valid rich text JSON object with type 'root'.";
    }
    case 'json':
      return json().ok ? null : 'Value is invalid JSON: unexpected token.';
    case 'number_integer':
      return /^-?\d+$/.test(value) && Math.abs(Number(value)) <= 9007199254740991 ? null : 'Value must be an integer.';
    case 'number_decimal':
      return /^-?\d+(\.\d+)?$/.test(value) ? null : 'Value must be a decimal.';
    case 'boolean':
      return value === 'true' || value === 'false' ? null : 'Value must be true or false.';
    case 'url':
      return /^(https?:\/\/|mailto:|sms:|tel:|\/)/.test(value) ? null : 'Value must be a valid URL. Allowed schemes: http, https, mailto, sms, tel.';
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) ? null : 'Value must be in YYYY-MM-DD format.';
    case 'date_time':
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/.test(value) && !Number.isNaN(Date.parse(value)) ? null : 'Value must be in ISO 8601 format.';
    case 'color':
      return /^#[0-9a-fA-F]{6}$/.test(value) ? null : 'Value must be a hex color code (e.g. #FFFFFF).';
    case 'money': {
      const j = json();
      return j.ok && j.v && typeof j.v.amount === 'string' && typeof j.v.currency_code === 'string' ? null : 'Value must be a JSON object with amount and currency_code.';
    }
    case 'weight':
    case 'volume':
    case 'dimension': {
      const j = json();
      return j.ok && j.v && typeof j.v.value === 'number' && typeof j.v.unit === 'string' ? null : 'Value must be a JSON object with value and unit.';
    }
    case 'rating': {
      const j = json();
      return j.ok && j.v && j.v.value !== undefined && j.v.scale_min !== undefined && j.v.scale_max !== undefined ? null : 'Value must be a JSON object with value, scale_min and scale_max.';
    }
    case 'link': {
      const j = json();
      return j.ok && j.v && typeof j.v.text === 'string' && typeof j.v.url === 'string' ? null : 'Value must be a JSON object with text and url.';
    }
    case 'product_reference':
      return ref('Product', (n) => ctx.state.products.has(n));
    case 'variant_reference':
      return ref('ProductVariant', (n) => ctx.state.variants.has(n));
    case 'collection_reference':
      return ref('Collection', (n) => ctx.state.collections.has(n));
    case 'page_reference':
      return ref('Page', (n) => ctx.state.pages.has(n));
    case 'file_reference':
      return ref('MediaImage', (n) => ctx.state.media.has(n));
    default:
      return /^gid:\/\/shopify\//.test(value) ? null : 'Value must be a global id.';
  }
}

export function ownerExists(ownerId: string, ctx: Ctx): boolean {
  let g: { type: string; num: number };
  try {
    g = parseGid(ownerId);
  } catch {
    return false;
  }
  switch (g.type) {
    case 'Product':
      return ctx.state.products.has(g.num);
    case 'ProductVariant':
      return ctx.state.variants.has(g.num);
    case 'Collection':
      return ctx.state.collections.has(g.num);
    case 'Page':
      return ctx.state.pages.has(g.num);
    case 'Shop':
      return g.num === ctx.state.shop.id;
    case 'DiscountCodeNode':
      return ctx.state.discounts.has(g.num);
    default:
      return false;
  }
}

/**
 * Validates and (if everything is valid) writes metafields atomically.
 * `fieldPath(i, name)` builds the userError field path for input i.
 */
export function setMetafields(
  inputs: MetafieldSetInput[],
  ctx: Ctx,
  fieldPath: (i: number, name: string) => (string | number)[],
  opts: { withElementIndex?: boolean; dryRun?: boolean } = {},
): { errors: UE[]; records: MetafieldRec[] } {
  const errors: UE[] = [];
  const err = (i: number, name: string, message: string, code: string) =>
    errors.push(ue(fieldPath(i, name), message, code, opts.withElementIndex ? { elementIndex: i } : {}));
  const seen = new Set<string>();
  inputs.forEach((m, i) => {
    if (!ownerExists(m.ownerId, ctx)) {
      err(i, 'ownerId', 'Owner does not exist.', 'INVALID');
      return;
    }
    const ns = m.namespace ?? ctx.options.appNamespace;
    if (ns.length < 2) err(i, 'namespace', 'Namespace is too short (minimum is 2 characters)', 'TOO_SHORT');
    if (ns.length > 255) err(i, 'namespace', 'Namespace is too long (maximum is 255 characters)', 'TOO_LONG');
    if (!/^[A-Za-z0-9_-]+$/.test(ns.replace(/^\$app(:|$)/, 'app'))) err(i, 'namespace', 'Namespace contains one or more invalid characters.', 'INVALID');
    if (m.key.length < 2) err(i, 'key', 'Key is too short (minimum is 2 characters)', 'TOO_SHORT');
    if (m.key.length > 64) err(i, 'key', 'Key is too long (maximum is 64 characters)', 'TOO_LONG');
    if (!/^[A-Za-z0-9_-]+$/.test(m.key)) err(i, 'key', 'Key contains one or more invalid characters.', 'INVALID');
    const dupKey = `${m.ownerId}|${ns}|${m.key}`;
    if (seen.has(dupKey)) err(i, 'key', 'The same metafield was provided more than once.', 'INVALID');
    seen.add(dupKey);
    const existing = ctx.state.findMetafield(m.ownerId, ns, m.key);
    const type = m.type ?? existing?.type ?? null;
    if (!type) {
      err(i, 'type', "Type can't be blank", 'BLANK');
      return;
    }
    if (!isValidMetafieldType(type)) {
      err(i, 'type', `Type '${type}' is not a valid metafield type.`, 'INVALID_TYPE');
      return;
    }
    if (existing && m.type && existing.type !== m.type) {
      err(i, 'type', `Type must be '${existing.type}' to match the existing metafield.`, 'INVALID_TYPE');
      return;
    }
    if (m.compareDigest != null && existing && digest(existing.value) !== m.compareDigest) {
      err(i, 'compareDigest', 'The resource has been updated since it was loaded. Try again with an updated `compareDigest` value.', 'STALE_OBJECT');
    }
    if (m.value === '') {
      err(i, 'value', "Value can't be blank.", 'BLANK');
      return;
    }
    const vErr = validateMetafieldValue(type, m.value, ctx);
    if (vErr) err(i, 'value', vErr, 'INVALID_VALUE');
  });
  if (errors.length || opts.dryRun) return { errors, records: [] };
  const now = isoNow();
  const records = inputs.map((m) => {
    const ns = m.namespace ?? ctx.options.appNamespace;
    const existing = ctx.state.findMetafield(m.ownerId, ns, m.key);
    if (existing) {
      existing.value = m.value;
      existing.type = m.type ?? existing.type;
      existing.updatedAt = now;
      return existing;
    }
    const rec: MetafieldRec = { id: ctx.state.nextId('Metafield'), ownerId: m.ownerId, namespace: ns, key: m.key, type: m.type!, value: m.value, createdAt: now, updatedAt: now };
    ctx.state.metafields.set(rec.id, rec);
    return rec;
  });
  return { errors, records };
}

/** Converts MetafieldInput (used inside productCreate/Update etc.) to set inputs. */
export function ownerMetafieldInputs(ownerGid: string, list: any[] | null | undefined): MetafieldSetInput[] {
  return (list ?? []).map((m) => ({ ownerId: ownerGid, namespace: m.namespace, key: m.key, value: m.value, type: m.type, compareDigest: m.compareDigest }));
}

export const metafieldMutations = {
  metafieldsSet: (_: unknown, args: { metafields: MetafieldSetInput[] }, ctx: Ctx) => {
    if (args.metafields.length > 25) {
      return { metafields: null, userErrors: [ue(['metafields'], 'Exceeded the maximum metafields input limit of 25.', 'LESS_THAN_OR_EQUAL_TO', { elementIndex: null })] };
    }
    const { errors, records } = setMetafields(args.metafields, ctx, (i, n) => ['metafields', i, n], { withElementIndex: true });
    if (errors.length) return { metafields: null, userErrors: errors };
    return { metafields: records.map(metafieldView), userErrors: [] };
  },
  metafieldsDelete: (_: unknown, args: { metafields: { ownerId: string; namespace: string; key: string }[] }, ctx: Ctx) => {
    const deleted = args.metafields.map((m) => {
      const rec = ctx.state.findMetafield(m.ownerId, m.namespace, m.key);
      if (!rec) return null;
      ctx.state.metafields.delete(rec.id);
      ctx.state.translations = ctx.state.translations.filter((t) => t.resourceId !== gid('Metafield', rec.id));
      return { ownerId: m.ownerId, namespace: m.namespace, key: m.key };
    });
    return { deletedMetafields: deleted, userErrors: [] };
  },
};
