import { expect, test } from '@playwright/test';
import { SHOP_TOKEN, shopUrl } from './support/helpers';

test('Einstellungen: Shopify verbinden, automatisch speichern und Verbindungen testen', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeVisible();

  const shop = page.locator('section#shop');
  await shop.getByRole('radio', { name: 'Shopify' }).click();
  await shop.getByLabel('Shop-Domain').fill(shopUrl);
  await shop.getByRole('radio', { name: /Admin-API-Token/ }).click();
  await shop.getByLabel('Admin-API-Zugriffstoken').fill(SHOP_TOKEN);
  await shop.getByLabel('Shop-Domain').click(); // Geheimnis-Felder speichern erst beim Verlassen

  await expect(page.getByRole('status').filter({ hasText: 'Alles gespeichert' })).toBeVisible();
  await expect(shop.getByText('eingerichtet', { exact: true })).toBeVisible();

  await shop.getByRole('button', { name: 'Verbindung testen' }).click();
  await expect(shop.getByRole('status').filter({ hasText: '✓' })).toBeVisible();

  // KI: der Anthropic-Fake antwortet über den echten Claude-Code-Prozess
  const ai = page.locator('section#ai');
  await ai.getByRole('button', { name: 'Verbindung testen' }).click();
  await expect(ai.getByRole('status').filter({ hasText: /✓ KI antwortet/ })).toBeVisible({ timeout: 45_000 });

  // Gespeichert ist gespeichert: nach dem Neuladen steht die Domain noch da, das Token nur als „gespeichert“
  await page.reload();
  await expect(page.locator('section#shop').getByLabel('Shop-Domain')).toHaveValue(shopUrl);
  await expect(page.locator('section#shop').getByLabel('Admin-API-Zugriffstoken')).toHaveValue('');
});
