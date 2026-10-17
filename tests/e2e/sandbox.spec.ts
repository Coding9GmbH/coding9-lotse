import { expect, test } from '@playwright/test';
import { GITHUB_TOKEN } from './support/github';

// Sandbox Coding with the in-memory runner (LOTSE_SANDBOX_RUNNER=fake): off by default, switched on in the settings,
// environment saved (secret value never shown again), "Umgebung prüfen" pulls the image, switched off again.
test('Sandbox Coding: switch on, configure the environment, check, switch off', async ({ page }) => {
  await page.goto('/sandbox-coding');
  await expect(page.getByRole('heading', { level: 2, name: 'Sandbox Coding ist ausgeschaltet' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Sandbox Coding' })).toHaveCount(0);

  await page.getByRole('link', { name: 'Zu den Einstellungen' }).click();
  const card = page.locator('section#sandbox');
  const toggle = card.getByRole('switch', { name: /Sandbox Coding einschalten/ });
  await card.getByText('Sandbox Coding einschalten').click(); // the input itself is visually hidden behind the switch
  await expect(toggle).toBeChecked();
  await expect(card.getByRole('status').filter({ hasText: '✓ Docker fake erreichbar' })).toBeVisible();
  const navLink = page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Sandbox Coding' });
  await expect(navLink).toBeVisible();

  await navLink.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sandbox Coding' })).toBeVisible();
  const env = page.locator('section#sbx-env');
  await expect(env.getByText('Dockware (Shopware)')).toBeVisible();
  await expect(env.getByLabel('Image')).toHaveValue('dockware/shopware:6.7.15.1');

  await env.getByLabel('Image').fill('dockware/shopware:6.7-latest');
  await env.getByRole('button', { name: 'Umgebung speichern' }).click();
  await expect(env.getByRole('status').filter({ hasText: /latest/ })).toBeVisible();
  await env.getByLabel('Image').fill('dockware/shopware:6.7.15.1');

  await env.getByRole('button', { name: 'Variable hinzufügen' }).click();
  await env.getByLabel('Name', { exact: true }).fill('api_token');
  await env.getByLabel('geheim').check();
  await env.getByLabel(/^Wert API_TOKEN/).fill('e2e-geheim-123');
  await env.getByRole('button', { name: 'Befehl hinzufügen' }).click();
  await env.getByLabel('Bezeichnung', { exact: true }).fill('Demodaten');
  await env.getByLabel('Befehl Demodaten', { exact: true }).fill('bin/console framework:demodata');
  await env.getByRole('button', { name: 'Umgebung speichern' }).click();
  await expect(env.getByRole('status').filter({ hasText: 'Gespeichert.' })).toBeVisible();

  await env.getByRole('button', { name: 'Umgebung prüfen' }).click();
  await expect(env.getByRole('status').filter({ hasText: /✓ Image dockware\/shopware:6\.7\.15\.1 geladen/ })).toBeVisible();

  await page.reload();
  await expect(env.getByLabel(/^Wert API_TOKEN/)).toHaveValue('');
  await expect(env.getByLabel(/^Wert API_TOKEN/)).toHaveAttribute('placeholder', /gespeichert/);
  await expect(page.locator('body')).not.toContainText('e2e-geheim-123');
  // unticking "geheim" without a new value would drop the secret: refused with a hint, nothing saved
  await env.getByLabel('geheim').uncheck();
  await expect(env.getByLabel(/^Wert API_TOKEN/)).toHaveAttribute('placeholder', /neuen Wert eingeben/);
  await env.getByRole('button', { name: 'Umgebung speichern' }).click();
  await expect(env.getByRole('status').filter({ hasText: 'API_TOKEN: Neuen Wert eingeben' })).toBeVisible();
  await env.getByLabel('geheim').check();

  await page.goto('/settings/sandbox');
  await page.locator('section#sandbox').getByText('Sandbox Coding einschalten').click();
  await expect(page.locator('section#sandbox').getByRole('switch', { name: /Sandbox Coding einschalten/ })).not.toBeChecked();
  await expect(navLink).toHaveCount(0);
});

// A code task with the fake runner, the GitHub fake and a bare file:// remote: create, the setup reaches "Bereit",
// own commands are steps of their own, pause and resume keep the task, "Aufgabe abschließen" removes the container.
test('Sandbox Coding: create a task, setup reaches ready, pause/resume, finish', async ({ page, request }) => {
  const lotse = { 'x-lotse': '1' };
  expect((await request.put('/api/github', { headers: lotse, data: { token: GITHUB_TOKEN } })).ok()).toBeTruthy();
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: true } })).ok()).toBeTruthy();

  await page.goto('/sandbox-coding');
  const tasks = page.locator('section[aria-labelledby="sbx-tasks"]');
  await expect(tasks.getByText('Noch keine Aufgaben')).toBeVisible();
  await tasks.getByRole('button', { name: 'Neue Aufgabe' }).click();
  const dialog = page.getByRole('dialog', { name: 'Neue Aufgabe' });
  await dialog.getByLabel('Repository').selectOption('acme/shop-theme');
  await expect(dialog.getByLabel('Basis-Branch')).toHaveValue('main');
  await dialog.getByLabel('Titel').fill('Footer grün');
  await dialog.getByLabel('Was soll geändert werden?').fill('Der Footer soll grün werden.');
  await dialog.getByRole('button', { name: 'Aufgabe anlegen' }).click();

  await expect(page).toHaveURL(/\/sandbox-coding\/t_[a-z0-9]{12}$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Footer grün' })).toBeVisible();
  const steps = page.locator('section[aria-labelledby="sbx-steps"]');
  await expect(page.getByText('Bereit', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pausieren' })).toBeVisible();
  await expect(steps.getByText('Theme kompilieren')).toBeVisible();
  await expect(steps.getByText('Demodaten', { exact: true })).toBeVisible(); // own command from the environment = own step
  await expect(steps.getByText('übersprungen')).toBeVisible(); // no dump yet
  await expect(page.getByText(/acme\/shop-theme.*lotse\/footer-gruen-.*Container läuft.*custom\/plugins\/AcmeShopTheme/)).toBeVisible();
  await steps.getByText(/^Protokoll/).nth(5).click(); // install-plugin
  await expect(steps.getByText('$ bin/console plugin:install --activate -- AcmeShopTheme')).toBeVisible();

  // Preview: the task's storefront through /sbx/<id>/ (fake storefront of the container)
  const preview = page.frameLocator('iframe[title="Vorschau der Sandbox-Storefront"]');
  await expect(preview.getByRole('heading', { name: 'Fake-Storefront' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'In neuem Tab öffnen' })).toHaveAttribute('href', /^\/sbx\/t_[a-z0-9]{12}\.[a-f0-9]{20}\/$/);
  // Mark mode as in the shop preview: click an element, note what should change, collected below
  await page.getByRole('button', { name: 'Anmerken' }).click();
  await preview.getByRole('heading', { name: 'Fake-Storefront' }).click();
  await page.getByLabel('Was soll anders sein?').fill('größer');
  await page.getByRole('button', { name: 'Merken' }).click();
  await expect(page.getByRole('region', { name: 'Änderungswünsche' }).getByText('größer')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Wunsch kopieren' })).toBeVisible();
  await page.getByRole('button', { name: 'Verwerfen' }).click();
  await page.getByRole('button', { name: 'Markieren beenden' }).click();

  // Paused: the preview offers to start it again; loading it wakes the task (no new setup)
  await page.getByRole('button', { name: 'Pausieren' }).click();
  await expect(page.getByText(/^Pausiert: Code, Datenbank und Änderungen bleiben erhalten/)).toBeVisible();
  await page.getByRole('button', { name: 'Vorschau laden' }).click();
  await expect(page.getByRole('button', { name: 'Pausieren' })).toBeVisible();
  await expect(preview.getByRole('heading', { name: 'Fake-Storefront' })).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Pausieren' }).click();
  await expect(page.getByText(/^Pausiert: Code, Datenbank und Änderungen bleiben erhalten/)).toBeVisible();
  await page.getByRole('button', { name: 'Fortsetzen' }).click();
  await expect(page.getByRole('button', { name: 'Pausieren' })).toBeVisible();

  await page.getByRole('link', { name: /Alle Aufgaben/ }).click();
  await expect(tasks.getByRole('link', { name: /Footer grün.*Bereit/ })).toBeVisible();
  await tasks.getByRole('link', { name: /Footer grün/ }).click();

  page.once('dialog', d => void d.accept());
  await page.getByRole('button', { name: 'Aufgabe abschließen' }).click();
  await expect(page.getByText(/^Abgeschlossen: Container und Dateien/)).toBeVisible();
  await expect(page.getByText('Kein Container')).toBeVisible();
  page.once('dialog', d => void d.accept());
  await page.getByRole('button', { name: 'Aus der Liste entfernen' }).click();
  await expect(page).toHaveURL(/\/sandbox-coding$/);
  await expect(tasks.getByText('Noch keine Aufgaben')).toBeVisible();
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: false } })).ok()).toBeTruthy();
});
