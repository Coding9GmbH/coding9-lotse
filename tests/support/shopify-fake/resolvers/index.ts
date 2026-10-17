import type { ResolverFn, Resolvers, Schema } from '../graphql';
import { accessDenied, type Ctx } from '../context';
import { collectionMutations, collectionQueries, collectionTypes } from './collections';
import { discountMutations, discountQueries, discountTypes } from './discounts';
import { metafieldMutations } from './metafields';
import { orderQueries, orderTypes } from './orders';
import { pageMutations, pageQueries, pageTypes } from './pages';
import { productMutations, productQueries, productTypes } from './products';
import { systemMutations, systemQueries, systemTypes } from './system';
import { themeMutations, themeQueries, themeTypes } from './themes';
import { translationMutations, translationQueries, translationTypes } from './translations';

export const DEFAULT_ACCESS_SCOPES = [
  'read_products',
  'write_products',
  'read_content',
  'write_content',
  'read_themes',
  'write_themes',
  'read_translations',
  'write_translations',
  'read_locales',
  'read_discounts',
  'write_discounts',
  'read_files',
  'write_files',
  'read_online_store_navigation',
  'write_online_store_navigation',
  'read_publications',
  'write_publications',
  'read_locations',
];

/** Empty answers for privacy-protected root fields when a test explicitly grants the scope. */
function opaqueFallback(fieldName: string): unknown {
  if (fieldName.endsWith('Count')) return { count: 0, precision: 'EXACT' };
  if (/s$/.test(fieldName) || fieldName === 'customerSegmentMembers') return { nodes: [] };
  return null;
}

export function buildResolvers(schema: Schema): Resolvers {
  const queryImpls: Record<string, ResolverFn> = {
    ...systemQueries,
    ...productQueries,
    ...collectionQueries,
    ...pageQueries,
    ...orderQueries,
    ...translationQueries,
    ...discountQueries,
    ...themeQueries,
  } as Record<string, ResolverFn>;
  const mutationImpls: Record<string, ResolverFn> = {
    ...productMutations,
    ...collectionMutations,
    ...pageMutations,
    ...metafieldMutations,
    ...translationMutations,
    ...discountMutations,
    ...themeMutations,
    ...systemMutations,
  } as Record<string, ResolverFn>;

  const wrapRoot = (typeName: 'Query' | 'Mutation', impls: Record<string, ResolverFn>): Record<string, ResolverFn> => {
    const def = schema.types.get(typeName);
    if (!def || def.kind !== 'OBJECT') return {};
    const out: Record<string, ResolverFn> = {};
    for (const field of def.fields.values()) {
      const access = field.directives.find((d) => d.name === 'access');
      const scopeArg = access?.arguments.find((a) => a.name === 'scope');
      const scope = scopeArg && scopeArg.value.kind === 'String' ? scopeArg.value.value : null;
      const opaque = field.directives.some((d) => d.name === 'opaque');
      const impl = impls[field.name];
      if (!impl && !opaque) throw new Error(`Shopify fake: no resolver for ${typeName}.${field.name}`);
      out[field.name] = (parent, args, ctx: Ctx, info) => {
        if (scope && !ctx.options.accessScopes.has(scope)) throw accessDenied(field.name, scope);
        if (!impl) return opaqueFallback(field.name);
        return impl(parent, args, ctx, info);
      };
    }
    return out;
  };

  return {
    Query: wrapRoot('Query', queryImpls),
    Mutation: wrapRoot('Mutation', mutationImpls),
    ...productTypes,
    ...collectionTypes,
    ...pageTypes,
    ...orderTypes,
    ...translationTypes,
    ...discountTypes,
    ...themeTypes,
    ...systemTypes,
  } as unknown as Resolvers;
}
