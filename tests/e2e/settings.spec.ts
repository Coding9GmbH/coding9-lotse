import { expect, test } from '@playwright/test';
import { SHOP_TOKEN, shopUrl } from './support/helpers';
import { GITHUB_TOKEN } from './support/github';

test('Settings: connect Shopify, auto-save and test connections', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Allgemein' })).toBeVisible();

  const shop = page.locator('section#shop');
  await shop.getByRole('radio', { name: 'Shopify' }).click();
  await shop.getByLabel('Shop-Domain').fill(shopUrl);
  await shop.getByRole('radio', { name: /Admin-API-Token/ }).click();
  await shop.getByLabel('Admin-API-Zugriffstoken').fill(SHOP_TOKEN);
  await shop.getByLabel('Shop-Domain').click(); // secret fields only save on blur

  await expect(page.getByRole('status').filter({ hasText: 'Alles gespeichert' })).toBeVisible();
  await expect(shop.getByText('eingerichtet', { exact: true })).toBeVisible();

  await shop.getByRole('button', { name: 'Verbindung testen' }).click();
  await expect(shop.getByRole('status').filter({ hasText: '✓' })).toBeVisible();

  // AI: the Anthropic fake answers via the real Claude Code process
  const ai = page.locator('section#ai');
  await ai.getByRole('button', { name: 'Verbindung testen' }).click();
  await expect(ai.getByRole('status').filter({ hasText: /✓ KI antwortet/ })).toBeVisible({ timeout: 45_000 });

  // Saved is saved: after reloading the domain is still there, the token only as "gespeichert" (saved)
  await page.reload();
  await expect(page.locator('section#shop').getByLabel('Shop-Domain')).toHaveValue(shopUrl);
  await expect(page.locator('section#shop').getByLabel('Admin-API-Zugriffstoken')).toHaveValue('');
});

test('Settings: connect GitHub with a fine-grained token, never shown again, disconnect', async ({ page }) => {
  await page.goto('/settings/integrationen');
  const gh = page.locator('section#github');
  await gh.getByLabel('Fine-grained Token').fill('ghp_kurz');
  await expect(gh.getByText('Token braucht Contents + Pull requests')).toBeVisible();
  await gh.getByLabel('Fine-grained Token').fill(GITHUB_TOKEN);
  await expect(gh.getByRole('status').filter({ hasText: '✓ Verbunden als octo-lotse' })).toBeVisible();
  await expect(gh.getByText('Ohne Schreibrecht (1): acme/legacy-plugin')).toBeVisible();

  await page.reload();
  const again = page.locator('section#github');
  await expect(again.getByText('Verbunden als octo-lotse', { exact: true })).toBeVisible();
  await expect(again.getByLabel('Fine-grained Token')).toHaveValue('');
  expect(await page.content()).not.toContain(GITHUB_TOKEN);

  page.once('dialog', d => void d.accept());
  await again.getByRole('button', { name: 'Entfernen' }).click();
  await expect(again.getByRole('status').filter({ hasText: 'Verbindung getrennt' })).toBeVisible();
  await expect(again.getByText('gespeichert', { exact: true })).toHaveCount(0);
});
