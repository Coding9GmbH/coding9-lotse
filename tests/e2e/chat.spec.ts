import { expect, test, type Page } from '@playwright/test';
import { PLAID, connectShop, resetShop, seoTitle } from './support/helpers';

// Das Test-Modell (tests/support/anthropic-fake) ruft bei „[e2e:propose <id> <feld>=<wert>]“ propose_product_changes auf.
const propose = (title: string) => `Bitte setz den Meta-Title. [e2e:propose ${PLAID.id} metaTitle=${title}]`;

async function send(page: Page, text: string) {
  const input = page.getByRole('textbox', { name: 'Nachricht an Lotse' });
  await input.fill(text);
  await input.press('Enter');
}

test.beforeEach(async ({ request }) => {
  await resetShop(request);
  await connectShop(request);
});

test('Änderungsset: Vorschlag → Anwenden → Shop geändert → Rückgängig', async ({ page, request }) => {
  const title = 'Plaid Düne aus Wolle | Haus Holm';
  expect(await seoTitle(request, PLAID.gid)).toBeFalsy();

  await page.goto('/');
  await send(page, propose(title));

  const card = page.getByRole('region', { name: /^Änderungsset: / });
  await expect(card).toBeVisible({ timeout: 45_000 });
  await expect(card.getByText(title)).toBeVisible();
  await expect(card.getByRole('checkbox', { name: /^Plaid „Düne“.*: Meta-Title \(SEO\) übernehmen$/ })).toBeChecked();

  // Vor der Freigabe ist nichts geschrieben
  expect(await seoTitle(request, PLAID.gid)).toBeFalsy();

  await card.getByRole('button', { name: '1 Änderung anwenden' }).click();
  await expect(card.getByRole('status').filter({ hasText: '✓ 1 angewendet' })).toBeVisible();
  await expect.poll(() => seoTitle(request, PLAID.gid)).toBe(title);
  // Das Modell bekommt das Ergebnis des Werkzeugs zurück und antwortet
  await expect(page.getByText('Erledigt: applied')).toBeVisible();

  // Nach dem Neuladen ist das Ergebnis noch da (aus der Datenbank) und Rückgängig weiterhin möglich
  await page.reload();
  const saved = page.getByRole('region', { name: /^Änderungsset: / });
  await expect(saved.getByRole('status').filter({ hasText: '✓ 1 angewendet' })).toBeVisible();

  // Rückgängig fragt vorher nach (window.confirm)
  page.once('dialog', d => void d.accept());
  await saved.getByRole('button', { name: 'Rückgängig machen' }).click();
  await expect(saved.getByRole('button', { name: 'Rückgängig gemacht ✓' })).toBeDisabled();
  await expect.poll(() => seoTitle(request, PLAID.gid)).toBeFalsy();
});

test('Änderungsset ablehnen: nichts wird geschrieben', async ({ page, request }) => {
  await page.goto('/');
  await send(page, propose('Abgelehnter Titel'));

  const card = page.getByRole('region', { name: /^Änderungsset: / });
  await expect(card).toBeVisible({ timeout: 45_000 });
  await card.getByRole('button', { name: 'Ablehnen' }).click();
  await expect(card.getByRole('status').filter({ hasText: 'Abgelehnt. Es wurde nichts geschrieben.' })).toBeVisible();
  await expect(page.getByText('Erledigt: rejected')).toBeVisible();
  expect(await seoTitle(request, PLAID.gid)).toBeFalsy();
});

test('Chatliste: neue Chats erscheinen und lassen sich wieder öffnen', async ({ page }) => {
  await page.goto('/');
  await send(page, 'Hallo Lotse, kurzer Test der Chatliste');
  await expect(page.getByText('Hallo aus dem Test-Modell.')).toBeVisible({ timeout: 45_000 });

  const chats = await page.request.get('/api/chats');
  expect(chats.ok()).toBeTruthy();
  const list = (await chats.json()) as { title: string }[];
  expect(list.some(c => c.title.startsWith('Hallo Lotse, kurzer Test der Chatliste'))).toBeTruthy();

  await page.goto('/');
  await page.getByRole('button', { name: /Hallo Lotse, kurzer Test der Chatliste/ }).first().click();
  await expect(page.getByText('Hallo aus dem Test-Modell.')).toBeVisible();
});
