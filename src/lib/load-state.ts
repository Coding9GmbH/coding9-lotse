export type CatalogKind = 'loading' | 'error' | 'empty' | 'ready';
export type ShopTone = 'loading' | 'unloaded' | 'disconnected' | 'unreachable' | 'ok';
export type AiTone = 'loading' | 'unloaded' | 'disconnected' | 'ok';

/** Error, not yet loaded, empty and results remain separate states. */
export function catalogState(error: string | null | undefined, items: readonly unknown[] | null): CatalogKind {
  if (error) return 'error';
  if (items == null) return 'loading';
  if (items.length === 0) return 'empty';
  return 'ready';
}

export function shellFlags(input: {
  loadFailed: boolean;
  known?: boolean;
  shopConfigured?: boolean;
  shopOk?: boolean;
  aiConfigured?: boolean;
}): { shopConfigured: boolean; aiConfigured: boolean; shop: ShopTone; ai: AiTone } {
  if (input.loadFailed) return { shopConfigured: false, aiConfigured: false, shop: 'unloaded', ai: 'unloaded' };
  if (!input.known) return { shopConfigured: false, aiConfigured: false, shop: 'loading', ai: 'loading' };
  const shopConfigured = !!input.shopConfigured;
  const aiConfigured = !!input.aiConfigured;
  return {
    shopConfigured,
    aiConfigured,
    shop: !shopConfigured ? 'disconnected' : input.shopOk ? 'ok' : 'unreachable',
    ai: aiConfigured ? 'ok' : 'disconnected',
  };
}
