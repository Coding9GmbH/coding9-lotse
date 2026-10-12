/* eslint-disable @typescript-eslint/no-explicit-any */
import { type ConnArgs, type Ctx, paginate, parseGid, safeIdOf, ue, type UE } from '../context';
import { digest, gid, isoNow, type TranslationRec } from '../state';

export interface TranslatableEntry {
  key: string;
  value: string | null;
  type: string;
}

const TEXT_METAFIELD_TYPES: Record<string, string> = {
  single_line_text_field: 'SINGLE_LINE_TEXT_FIELD',
  multi_line_text_field: 'MULTI_LINE_TEXT_FIELD',
  rich_text_field: 'RICH_TEXT_FIELD',
  url: 'URL',
  'list.single_line_text_field': 'LIST_SINGLE_LINE_TEXT_FIELD',
};

/** Translatable content of a resource, or null if the resource does not exist / is not translatable. */
export function translatableContent(resourceId: string, ctx: Ctx): TranslatableEntry[] | null {
  let g: { type: string; num: number };
  try {
    g = parseGid(resourceId);
  } catch {
    return null;
  }
  const s = ctx.state;
  const metaValue = (owner: string, key: string) => s.findMetafield(owner, 'global', key)?.value ?? null;
  switch (g.type) {
    case 'Product': {
      const p = s.products.get(g.num);
      if (!p) return null;
      const out: TranslatableEntry[] = [
        { key: 'title', value: p.title, type: 'SINGLE_LINE_TEXT_FIELD' },
        { key: 'body_html', value: p.descriptionHtml, type: 'HTML' },
        { key: 'handle', value: p.handle, type: 'URI' },
        { key: 'product_type', value: p.productType || null, type: 'SINGLE_LINE_TEXT_FIELD' },
        { key: 'meta_title', value: p.seo.title, type: 'SINGLE_LINE_TEXT_FIELD' },
        { key: 'meta_description', value: p.seo.description, type: 'MULTI_LINE_TEXT_FIELD' },
      ];
      return out.filter((e) => e.value !== null && e.value !== '');
    }
    case 'Collection': {
      const c = s.collections.get(g.num);
      if (!c) return null;
      const out: TranslatableEntry[] = [
        { key: 'title', value: c.title, type: 'SINGLE_LINE_TEXT_FIELD' },
        { key: 'body_html', value: c.descriptionHtml, type: 'HTML' },
        { key: 'handle', value: c.handle, type: 'URI' },
        { key: 'meta_title', value: c.seo.title, type: 'SINGLE_LINE_TEXT_FIELD' },
        { key: 'meta_description', value: c.seo.description, type: 'MULTI_LINE_TEXT_FIELD' },
      ];
      return out.filter((e) => e.value !== null && e.value !== '');
    }
    case 'Page': {
      const p = s.pages.get(g.num);
      if (!p) return null;
      const owner = gid('Page', p.id);
      const out: TranslatableEntry[] = [
        { key: 'title', value: p.title, type: 'SINGLE_LINE_TEXT_FIELD' },
        { key: 'body_html', value: p.body, type: 'HTML' },
        { key: 'handle', value: p.handle, type: 'URI' },
        { key: 'meta_title', value: metaValue(owner, 'title_tag'), type: 'SINGLE_LINE_TEXT_FIELD' },
        { key: 'meta_description', value: metaValue(owner, 'description_tag'), type: 'MULTI_LINE_TEXT_FIELD' },
      ];
      return out.filter((e) => e.value !== null && e.value !== '');
    }
    case 'Metafield': {
      const m = s.metafields.get(g.num);
      if (!m || !TEXT_METAFIELD_TYPES[m.type]) return null;
      return [{ key: 'value', value: m.value, type: TEXT_METAFIELD_TYPES[m.type] }];
    }
    case 'ProductOption': {
      for (const p of s.products.values()) {
        const o = p.options.find((x) => x.id === g.num);
        if (o) return [{ key: 'name', value: o.name, type: 'SINGLE_LINE_TEXT_FIELD' }];
      }
      return null;
    }
    case 'ProductOptionValue': {
      for (const p of s.products.values()) {
        for (const o of p.options) {
          const v = o.values.find((x) => x.id === g.num);
          if (v) return [{ key: 'name', value: v.name, type: 'SINGLE_LINE_TEXT_FIELD' }];
        }
      }
      return null;
    }
    default:
      return null;
  }
}

function currentDigest(resourceId: string, key: string, ctx: Ctx): string | null {
  const entry = translatableContent(resourceId, ctx)?.find((e) => e.key === key);
  return entry ? digest(entry.value) : null;
}

function translationView(t: TranslationRec, ctx: Ctx) {
  const cur = currentDigest(t.resourceId, t.key, ctx);
  return { key: t.key, value: t.value, locale: t.locale, outdated: cur !== null && cur !== t.sourceDigest, updatedAt: t.updatedAt };
}

export function translationsFor(resourceId: string, locale: string, ctx: Ctx, marketId?: string | null, outdated?: boolean | null) {
  return ctx.state.translations
    .filter((t) => t.resourceId === resourceId && t.locale === locale && (t.marketId ?? null) === (marketId ?? null))
    .map((t) => translationView(t, ctx))
    .filter((t) => outdated == null || t.outdated === outdated);
}

const RESOURCE_TYPE_GID: Record<string, string> = {
  PRODUCT: 'Product',
  COLLECTION: 'Collection',
  ONLINE_STORE_PAGE: 'Page',
  METAFIELD: 'Metafield',
  PRODUCT_OPTION: 'ProductOption',
  PRODUCT_OPTION_VALUE: 'ProductOptionValue',
};

function resourcesOfType(type: string, ctx: Ctx): string[] {
  const s = ctx.state;
  const t = RESOURCE_TYPE_GID[type];
  if (!t) return [];
  let ids: number[] = [];
  if (t === 'Product') ids = [...s.products.keys()];
  if (t === 'Collection') ids = [...s.collections.keys()];
  if (t === 'Page') ids = [...s.pages.keys()];
  if (t === 'Metafield') ids = [...s.metafields.values()].filter((m) => TEXT_METAFIELD_TYPES[m.type]).map((m) => m.id);
  if (t === 'ProductOption') ids = [...s.products.values()].flatMap((p) => p.options.map((o) => o.id));
  if (t === 'ProductOptionValue') ids = [...s.products.values()].flatMap((p) => p.options.flatMap((o) => o.values.map((v) => v.id)));
  return ids.sort((a, b) => a - b).map((id) => gid(t, id));
}

export const translationTypes = {
  TranslatableResource: {
    translatableContent: (r: { resourceId: string }, _: unknown, ctx: Ctx) =>
      (translatableContent(r.resourceId, ctx) ?? []).map((e) => ({ key: e.key, value: e.value, digest: e.value === null ? null : digest(e.value), locale: ctx.state.primaryLocale(), type: e.type })),
    translations: (r: { resourceId: string }, a: { locale: string; outdated?: boolean | null; marketId?: string | null }, ctx: Ctx) =>
      translationsFor(r.resourceId, a.locale, ctx, a.marketId, a.outdated),
  },
};

export const translationQueries = {
  shopLocales: (_: unknown, a: { published?: boolean | null }, ctx: Ctx) => ctx.state.locales.filter((l) => a.published == null || l.published === a.published),
  translatableResources: (_: unknown, a: ConnArgs & { resourceType: string }, ctx: Ctx) => {
    const list = resourcesOfType(a.resourceType, ctx).map((resourceId) => ({ resourceId }));
    return paginate(list, a, ctx, (r) => parseGid(r.resourceId).num);
  },
  translatableResource: (_: unknown, a: { resourceId: string }, ctx: Ctx) => {
    parseGid(a.resourceId);
    return translatableContent(a.resourceId, ctx) ? { resourceId: a.resourceId } : null;
  },
  translatableResourcesByIds: (_: unknown, a: ConnArgs & { resourceIds: string[] }, ctx: Ctx) => {
    const list = a.resourceIds.filter((id) => translatableContent(id, ctx)).map((resourceId) => ({ resourceId }));
    return paginate(list, a, ctx, (r) => parseGid(r.resourceId).num);
  },
};

function checkLocale(locale: string, ctx: Ctx, path: (string | number)[], errors: UE[]): void {
  const l = ctx.state.locales.find((x) => x.locale === locale);
  if (!l) errors.push(ue(path, `Locale ${locale} is not enabled for the shop`, 'INVALID_LOCALE_FOR_SHOP'));
  else if (l.primary) errors.push(ue(path, 'Translations for the primary locale are not allowed', 'INVALID_LOCALE_FOR_SHOP'));
}

export const translationMutations = {
  translationsRegister: (_: unknown, a: { resourceId: string; translations: any[] }, ctx: Ctx) => {
    const content = translatableContent(a.resourceId, ctx);
    if (!content) return { translations: null, userErrors: [ue(['resourceId'], `Resource ${a.resourceId} does not exist`, 'RESOURCE_NOT_FOUND')] };
    if (a.translations.length > 100) return { translations: null, userErrors: [ue(['translations'], 'Too many translation keys for the resource', 'TOO_MANY_KEYS_FOR_RESOURCE')] };
    const errors: UE[] = [];
    a.translations.forEach((t, i) => {
      checkLocale(t.locale, ctx, ['translations', i, 'locale'], errors);
      const entry = content.find((e) => e.key === t.key);
      if (!entry) {
        errors.push(ue(['translations', i, 'key'], `Key ${t.key} is not a valid translatable field`, 'INVALID_KEY_FOR_MODEL'));
        return;
      }
      if (digest(entry.value) !== t.translatableContentDigest) {
        errors.push(ue(['translations', i, 'translatableContentDigest'], 'Translatable content hash is invalid', 'INVALID_TRANSLATABLE_CONTENT'));
      }
      if (t.marketId != null) {
        errors.push(ue(['translations', i, 'marketId'], 'Market does not exist', 'MARKET_DOES_NOT_EXIST'));
      }
      if (String(t.value ?? '').trim() === '') errors.push(ue(['translations', i, 'value'], "Value can't be blank", 'BLANK'));
      if (t.key === 'handle' && t.value && !/^[\p{Ll}\p{Lo}\p{N}_-]+$/u.test(t.value)) {
        errors.push(ue(['translations', i, 'value'], 'Handle translations may only contain lowercase letters, numbers, dashes and underscores', 'INVALID_VALUE_FOR_HANDLE_TRANSLATION'));
      }
    });
    if (errors.length) return { translations: null, userErrors: errors };
    const now = isoNow();
    const saved = a.translations.map((t) => {
      const entry = content.find((e) => e.key === t.key)!;
      const existing = ctx.state.translations.find((x) => x.resourceId === a.resourceId && x.key === t.key && x.locale === t.locale && x.marketId === null);
      if (existing) {
        existing.value = t.value;
        existing.sourceDigest = digest(entry.value);
        existing.updatedAt = now;
        return existing;
      }
      const rec: TranslationRec = { resourceId: a.resourceId, key: t.key, locale: t.locale, value: t.value, sourceDigest: digest(entry.value), marketId: null, updatedAt: now };
      ctx.state.translations.push(rec);
      return rec;
    });
    return { translations: saved.map((t) => translationView(t, ctx)), userErrors: [] };
  },

  translationsRemove: (_: unknown, a: { resourceId: string; translationKeys: string[]; locales: string[]; marketIds?: string[] | null }, ctx: Ctx) => {
    const content = translatableContent(a.resourceId, ctx);
    if (!content) return { translations: null, userErrors: [ue(['resourceId'], `Resource ${a.resourceId} does not exist`, 'RESOURCE_NOT_FOUND')] };
    const errors: UE[] = [];
    a.locales.forEach((l, i) => checkLocale(l, ctx, ['locales', i], errors));
    a.translationKeys.forEach((k, i) => {
      if (!content.some((e) => e.key === k)) errors.push(ue(['translationKeys', i], `Key ${k} is not a valid translatable field`, 'INVALID_KEY_FOR_MODEL'));
    });
    (a.marketIds ?? []).forEach((m, i) => {
      if (safeIdOf(m, 'Market') !== null) errors.push(ue(['marketIds', i], 'Market does not exist', 'MARKET_DOES_NOT_EXIST'));
    });
    if (errors.length) return { translations: null, userErrors: errors };
    const removed: TranslationRec[] = [];
    ctx.state.translations = ctx.state.translations.filter((t) => {
      const hit = t.resourceId === a.resourceId && a.translationKeys.includes(t.key) && a.locales.includes(t.locale);
      if (hit) removed.push(t);
      return !hit;
    });
    return { translations: removed.map((t) => ({ key: t.key, value: t.value, locale: t.locale, outdated: false, updatedAt: t.updatedAt })), userErrors: [] };
  },
};
