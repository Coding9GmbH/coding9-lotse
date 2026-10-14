import { expect, test } from '@playwright/test';

test('knowledge base: upload a document, it appears in the list, delete it', async ({ page }) => {
  const name = `pflegehinweise-${Date.now()}.txt`;
  await page.goto('/wissen');
  await expect(page.getByRole('heading', { level: 1, name: 'Wissen' })).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({
    name, mimeType: 'text/plain',
    buffer: Buffer.from('Pflegehinweise für das Plaid „Düne“: bei 30 Grad im Wollprogramm waschen, liegend trocknen.\n'),
  });
  const docs = page.getByRole('region', { name: 'Dokumente' });
  const del = docs.getByRole('button', { name: new RegExp(`„${name.replace('.txt', '')}.*“ löschen`) });
  await expect(del).toBeVisible();

  await page.reload();
  await expect(del).toBeVisible();
  await del.click();
  await docs.getByRole('button', { name: 'Löschen', exact: true }).click();
  await expect(del).toHaveCount(0);
});
