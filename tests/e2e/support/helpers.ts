// Helpers for the E2E tests: set up the shop connection via API and query the Shopify fake directly.
import { expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TOKEN } from '../../support/shopify-fake/server';
import { shopUrl } from './env';

export const SHOP_TOKEN = DEFAULT_TOKEN;
export { shopUrl };
/** Plaid "Düne" in the "Haus Holm" seed: without SEO data */
export const PLAID = { id: '9100000000003', gid: 'gid://shopify/Product/9100000000003', title: 'Plaid „Düne“' };

/** Save the Shopify fake as the active shop (like "Einstellungen → Shop verbinden", just without the UI). */
export async function connectShop(request: APIRequestContext) {
  const res = await request.put('/api/settings', { headers: { 'x-lotse': '1' }, data: { platform: 'shopify', shopify: { storeDomain: shopUrl, accessToken: SHOP_TOKEN } } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

/** Restore the Shopify fake's seed. */
export async function resetShop(request: APIRequestContext) {
  expect((await request.post(`${shopUrl}/__fake/reset`)).ok()).toBeTruthy();
}

/** GraphQL directly against the Shopify fake (bypassing Lotse) to check written values. */
export async function shopQuery<T>(request: APIRequestContext, query: string): Promise<T> {
  const res = await request.post(`${shopUrl}/admin/api/2026-10/graphql.json`, { headers: { 'X-Shopify-Access-Token': SHOP_TOKEN }, data: { query } });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { data: T }).data;
}

export const seoTitle = async (request: APIRequestContext, gid: string) =>
  (await shopQuery<{ product: { seo: { title: string | null } } }>(request, `{ product(id: "${gid}") { seo { title } } }`)).product.seo.title;
