import zlib from 'node:zlib';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { GITHUB_TOKEN } from './support/github';
import { E2E, githubUrl } from './support/env';
import { connectShop } from './support/helpers';

const aiUrl = `http://127.0.0.1:${E2E.aiPort}`;
/** "Sandbox starten" has three steps (Was? → Code-Quelle → Daten): "Weiter" moves on once the step is complete */
const next = (dialog: Locator) => dialog.getByRole('button', { name: 'Weiter' }).click();
/** "Sandbox starten" opens the choice list (A23: saved environments → "Demo-Shop ohne Projekt" → "Neu einrichten …"); the dialog is the last */
async function openSetup(page: Page) {
  await page.getByRole('button', { name: 'Sandbox starten', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Neu einrichten …', exact: true }).click();
}
/** The choices of a menu, top to bottom, by their accessible names (the second line of an item is its description) */
async function expectChoices(menu: Locator, names: string[]) {
  const items = menu.getByRole('menuitem');
  await expect(items).toHaveCount(names.length);
  for (const [i, n] of names.entries()) await expect(items.nth(i)).toHaveAccessibleName(n);
}

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
  const env = page.locator('#sbx-env');
  await expect(env).toHaveAttribute('open', ''); // first setup (image missing): the environment is unfolded
  await expect(env.getByText('Dockware (Shopware)')).toBeVisible();
  await expect(env.getByLabel('Image')).toHaveValue('dockware/shopware:6.7.15.1');

  await env.getByLabel('Image').fill('dockware/shopware:6.7-latest');
  await env.getByRole('button', { name: 'Sandbox-Umgebung speichern' }).click();
  await expect(env.getByRole('status').filter({ hasText: /latest/ })).toBeVisible();
  await env.getByLabel('Image').fill('dockware/shopware:6.7.15.1');

  await env.getByRole('button', { name: 'Variable hinzufügen' }).click();
  await env.getByLabel('Name', { exact: true }).fill('api_token');
  await env.getByLabel('geheim').check();
  await env.getByLabel(/^Wert API_TOKEN/).fill('e2e-geheim-123');
  await env.getByRole('button', { name: 'Befehl hinzufügen' }).click();
  await env.getByLabel('Bezeichnung', { exact: true }).fill('Demodaten');
  await env.getByLabel('Befehl Demodaten', { exact: true }).fill('bin/console framework:demodata');
  await env.getByRole('button', { name: 'Sandbox-Umgebung speichern' }).click();
  await expect(env.getByRole('status').filter({ hasText: 'Gespeichert.' })).toBeVisible();

  await env.getByRole('button', { name: 'Umgebung prüfen' }).click();
  await expect(env.getByRole('status').filter({ hasText: /✓ Image dockware\/shopware:6\.7\.15\.1 geladen/ })).toBeVisible();

  await page.reload();
  // set up now: the readiness is one line and the environment is folded below the sandboxes
  await expect(page.locator('section[aria-labelledby="sbx-ready"]').getByText(/fehl(t|en) – eine Sandbox kann noch nicht starten/)).toBeVisible(); // GitHub is not connected in this test
  await env.getByRole('heading', { name: 'Sandbox-Umgebung' }).click();
  await expect(env.getByLabel(/^Wert API_TOKEN/)).toHaveValue('');
  await expect(env.getByLabel(/^Wert API_TOKEN/)).toHaveAttribute('placeholder', /gespeichert/);
  await expect(page.locator('body')).not.toContainText('e2e-geheim-123');
  // unticking "geheim" without a new value would drop the secret: refused with a hint, nothing saved
  await env.getByLabel('geheim').uncheck();
  await expect(env.getByLabel(/^Wert API_TOKEN/)).toHaveAttribute('placeholder', /neuen Wert eingeben/);
  await env.getByRole('button', { name: 'Sandbox-Umgebung speichern' }).click();
  await expect(env.getByRole('status').filter({ hasText: 'API_TOKEN: Neuen Wert eingeben' })).toBeVisible();
  await env.getByLabel('geheim').check();

  await page.goto('/settings/sandbox');
  await page.locator('section#sandbox').getByText('Sandbox Coding einschalten').click();
  await expect(page.locator('section#sandbox').getByRole('switch', { name: /Sandbox Coding einschalten/ })).not.toBeChecked();
  await expect(navLink).toHaveCount(0);
});

// A sandbox attached to a normal chat (fake runner, GitHub fake, bare file:// remote): "Sandbox" in the chat, the dialog with the
// environment's presets, the right panel shows "Einrichtung" during the setup and switches to "Vorschau" when ready; pause/resume
// in the status line; the "Sandbox Coding" tab lists it and opens its chat; "Sandbox abschließen" (⋯ menu) detaches it, the chat stays.
test('Sandbox Coding: attach a sandbox to a chat, setup reaches ready, preview, pause/resume, finish', async ({ page, request }) => {
  test.setTimeout(120_000);
  const lotse = { 'x-lotse': '1' };
  expect((await request.put('/api/github', { headers: lotse, data: { token: GITHUB_TOKEN } })).ok()).toBeTruthy();
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: true, defaultRepo: 'acme/shop-theme', defaultBranch: 'main' } })).ok()).toBeTruthy();

  await page.goto('/sandbox-coding');
  const tasks = page.locator('section[aria-labelledby="sbx-tasks"]');
  await expect(tasks.getByText('Noch keine Sandboxes')).toBeVisible();
  // "Neue Sandbox" offers the same choices as the workspace (A23); "Neu einrichten …" opens the dialog in a new chat
  await tasks.getByRole('button', { name: 'Neue Sandbox', exact: true }).click();
  await expectChoices(page.getByRole('menu', { name: 'Neue Sandbox' }), ['Demo-Shop ohne Projekt', 'Neu einrichten …']);
  await page.getByRole('menuitem', { name: 'Neu einrichten …', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Sandbox starten' });
  await expect(dialog.getByLabel('Bestehendes Projekt')).toBeChecked(); // step 1 "Was?": the default
  await dialog.getByLabel('Titel (optional)').fill('Footer grün');
  await next(dialog);
  await expect(dialog.getByLabel('Repository')).toHaveValue('acme/shop-theme'); // preset of the environment
  await expect(dialog.getByLabel('Basis-Branch')).toHaveValue('main');
  await expect(dialog.getByRole('status').filter({ hasText: 'Erkannt: Theme AcmeShopTheme' })).toBeVisible(); // checked before the start
  await next(dialog);
  await expect(dialog.getByLabel('Demo-Daten')).toBeChecked(); // step 3: the default data
  await dialog.getByRole('button', { name: 'Sandbox starten' }).click();

  await expect(page).toHaveURL(/\/$/);
  const panel = page.getByRole('region', { name: 'Sandbox', exact: true });
  await expect(page.getByText(/Sandbox angehängt: acme\/shop-theme @ main/)).toBeVisible();
  await expect(panel.getByText('Footer grün')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Pausieren' })).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByRole('tab', { name: 'Vorschau' })).toHaveAttribute('aria-selected', 'true'); // switched after the setup
  await expect(page.getByRole('button', { name: 'Sandbox starten', exact: true })).toHaveCount(0); // one sandbox per chat
  // header in two lines: title + status, repository and working branch (full in the tooltip)
  await expect(panel.getByText(/^lotse\/footer-gruen-[a-z0-9]{6}$/)).toBeVisible();

  await panel.getByRole('tab', { name: 'Einrichtung' }).click();
  const steps = panel.getByRole('tabpanel', { name: 'Einrichtung' });
  await expect(steps.getByText(/^Eingerichtet in .* ✓$/)).toBeVisible(); // the finished setup is folded into one line
  await steps.getByRole('button', { name: 'Details anzeigen' }).click();
  await expect(steps.getByText('Theme kompilieren')).toBeVisible();
  await expect(steps.getByText('Vorschau aufräumen (Debug-Leiste, Cookie-Hinweis)')).toBeVisible();
  await expect(steps.getByText('Demodaten', { exact: true })).toBeVisible(); // own command from the environment = own step
  await expect(steps.getByText('übersprungen')).toHaveCount(3); // no dump: version check, import and the database snapshot skipped
  await expect(steps.getByText(/lotse\/footer-gruen-.*Container läuft.*custom\/plugins\/AcmeShopTheme/)).toBeVisible();
  await steps.getByRole('listitem').filter({ hasText: 'Plugin installieren und aktivieren' }).getByText(/^Protokoll/).click();
  await expect(steps.getByText('$ bin/console plugin:install --activate -- AcmeShopTheme')).toBeVisible();

  // Preview: the task's storefront through /sbx/<id>/ (fake storefront of the container), mark mode as in the shop preview
  await panel.getByRole('tab', { name: 'Vorschau' }).click();
  const preview = page.frameLocator('iframe[title="Vorschau der Sandbox-Storefront"]');
  await expect(preview.getByRole('heading', { name: 'Fake-Storefront' })).toBeVisible();
  await expect(panel.getByRole('link', { name: 'In neuem Tab öffnen' })).toHaveAttribute('href', /^\/sbx\/t_[a-z0-9]{12}\.[a-f0-9]{20}\/$/);
  await panel.getByRole('button', { name: 'Anmerken' }).click();
  await panel.getByRole('button', { name: 'Überschrift „Fake-Storefront“' }).click(); // the element list (the narrow panel lays it over the frame)
  await page.getByLabel('Was soll anders sein?').fill('größer');
  await page.getByRole('button', { name: 'Merken' }).click();
  await expect(page.getByRole('region', { name: 'Änderungswünsche' }).getByText('größer')).toBeVisible();
  await page.getByRole('button', { name: 'Verwerfen' }).click();
  await panel.getByRole('button', { name: 'Markieren beenden' }).click();

  // Internet only after the user's own click (with a warning); "an" blocks it again, pausing ends it
  page.once('dialog', d => { expect(d.message()).toContain('Live-Shops'); void d.accept(); });
  await panel.getByRole('button', { name: 'Internet: aus' }).click();
  await expect(panel.getByText('Internet: an')).toBeVisible(); // a warn badge, with its own "Sperren"
  await expect(panel.getByRole('button', { name: 'Internet sperren' })).toHaveAttribute('aria-pressed', 'true');
  await panel.getByRole('button', { name: 'Internet sperren' }).click();
  await expect(panel.getByRole('button', { name: 'Internet: aus' })).toHaveAttribute('aria-pressed', 'false');
  page.once('dialog', d => void d.accept());
  await panel.getByRole('button', { name: 'Internet: aus' }).click();
  await expect(panel.getByText('Internet: an')).toBeVisible();

  // Paused: the preview offers to start it again; loading it wakes the task (no new setup)
  await panel.getByRole('button', { name: 'Pausieren' }).click();
  await expect(panel.getByRole('button', { name: 'Fortsetzen' })).toBeVisible();
  await panel.getByRole('button', { name: 'Vorschau laden' }).click();
  await expect(panel.getByRole('button', { name: 'Pausieren' })).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByRole('button', { name: 'Internet: aus' })).toBeVisible(); // woken offline
  await expect(preview.getByRole('heading', { name: 'Fake-Storefront' })).toBeVisible({ timeout: 15_000 });
  await panel.getByRole('button', { name: 'Pausieren' }).click();
  await panel.getByRole('button', { name: 'Fortsetzen' }).click();
  await expect(panel.getByRole('button', { name: 'Pausieren' })).toBeVisible({ timeout: 15_000 });

  // the preview can take the whole width: chat collapsed, then full screen
  await panel.getByRole('button', { name: 'Chat einklappen' }).click();
  await expect(page.getByRole('region', { name: 'Chat' })).toBeHidden();
  await panel.getByRole('button', { name: 'Chat einblenden' }).click();
  await panel.getByRole('button', { name: 'Vollbild', exact: true }).click();
  await expect(panel).toHaveAttribute('data-full', 'true');
  await page.keyboard.press('Escape');
  await expect(panel).not.toHaveAttribute('data-full', 'true');

  // the tab lists it; a row opens its chat with the sandbox on the right
  await panel.getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Alle Sandboxes' }).click();
  await expect(tasks.getByRole('link', { name: /Footer grün.*Bereit/ })).toBeVisible();
  await tasks.getByRole('link', { name: /Footer grün/ }).click();
  await expect(panel.getByText('Footer grün')).toBeVisible();

  page.once('dialog', d => void d.accept());
  await panel.getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Sandbox abschließen' }).click();
  await expect(panel).toHaveCount(0); // detached: the chat stays, the right side is the normal one again
  await expect(page.getByText(/Sandbox angehängt: acme\/shop-theme @ main/)).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Sandbox abgeschlossen. Der Chat bleibt erhalten.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sandbox starten', exact: true })).toBeVisible();
  await page.goto('/sandbox-coding');
  await expect(tasks.getByRole('link', { name: /Footer grün.*Abgeschlossen/ })).toBeVisible();
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: false, defaultRepo: '', defaultBranch: '', screenshots: false } })).ok()).toBeTruthy();
});

// Console (tab "Konsole", fake runner's echo shell): open, type, quick command, a second console, resize with the panel, reattach
// after a reload with the earlier output, closed by a pause (with the reason), opening again wakes the sandbox, closed by the user.
test('Sandbox Coding: console in the container – type, quick commands, reattach after reload, closed on pause', async ({ page, request }) => {
  test.setTimeout(120_000);
  const lotse = { 'x-lotse': '1' };
  expect((await request.put('/api/github', { headers: lotse, data: { token: GITHUB_TOKEN } })).ok()).toBeTruthy();
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: true } })).ok()).toBeTruthy();
  await page.goto('/');
  await openSetup(page);
  const dialog = page.getByRole('dialog', { name: 'Sandbox starten' });
  await dialog.getByLabel('Titel (optional)').fill('Konsole');
  await next(dialog);
  await dialog.getByLabel('Repository').selectOption('acme/shop-theme');
  await next(dialog);
  await dialog.getByRole('button', { name: 'Sandbox starten' }).click();
  const panel = page.getByRole('region', { name: 'Sandbox', exact: true });
  await expect(panel.getByRole('button', { name: 'Pausieren' })).toBeVisible({ timeout: 30_000 });

  await panel.getByRole('tab', { name: 'Konsole' }).click();
  const tab = panel.getByRole('tabpanel', { name: 'Konsole' });
  await expect(tab.getByText(/Benutzer „dockware“ im Shop-Verzeichnis, sudo geht/)).toBeVisible();
  await tab.getByRole('button', { name: 'Konsole öffnen' }).click();
  const term = tab.locator('[data-console]:not([hidden]) .xterm-rows');
  await expect(term).toContainText(/dockware@lotse-sbx-[\w-]+:\/var\/www\/html\$/);
  await tab.locator('[data-console]:not([hidden]) .xterm').click();
  await page.keyboard.type('whoami');
  await page.keyboard.press('Enter');
  await expect(term).toContainText(/whoami\s*www-data/);
  await tab.getByRole('button', { name: 'Plugins anzeigen' }).click();
  await expect(term).toContainText('AcmeTheme');
  await page.keyboard.type('stty size');
  await page.keyboard.press('Enter');
  await expect(term).toContainText(/stty size\s*\d+ \d+/); // the panel's size, not the 100×30 it opened with
  expect(await term.textContent()).not.toMatch(/stty size\s*30 100/);

  // a second console, then back to the first
  await tab.getByRole('button', { name: '+ Neue Konsole' }).click();
  await expect(tab.getByRole('tab', { name: 'Konsole 2' })).toHaveAttribute('aria-selected', 'true');
  await expect(term).toContainText(/dockware@lotse-sbx-[\w-]+:\/var\/www\/html\$/);
  await expect(term).not.toContainText('AcmeTheme');
  await tab.getByRole('button', { name: 'Konsole 2 schließen' }).click();
  await expect(tab.getByRole('tab', { name: 'Konsole 2' })).toHaveCount(0);
  await expect(term).toContainText('AcmeTheme');
  // numbering restarts: the next one is "Konsole 2" again, not "Konsole 3"
  await tab.getByRole('button', { name: '+ Neue Konsole' }).click();
  await expect(tab.getByRole('tab', { name: 'Konsole 2' })).toHaveAttribute('aria-selected', 'true');
  await tab.getByRole('button', { name: 'Konsole 2 schließen' }).click();
  await expect(tab.getByRole('tab', { name: 'Konsole 2' })).toHaveCount(0);

  // reload: the session is still open and shows what was there
  await page.reload();
  await panel.getByRole('tab', { name: 'Konsole' }).click();
  await expect(tab.getByRole('tab', { name: /Konsole \d/ })).toHaveCount(1);
  await expect(term).toContainText('AcmeTheme');
  await tab.locator('[data-console]:not([hidden]) .xterm').click();
  await page.keyboard.type('echo wieder da');
  await page.keyboard.press('Enter');
  await expect.poll(async () => ((await term.textContent()) ?? '').split('wieder da').length - 1).toBe(2); // typed and echoed: input still works

  // pausing closes it and says why; opening again wakes the sandbox
  await panel.getByRole('button', { name: 'Pausieren' }).click();
  await expect(tab.getByRole('status').filter({ hasText: 'Die Sandbox wurde pausiert – Konsole geschlossen.' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Fortsetzen' })).toBeVisible();
  await tab.getByRole('button', { name: 'Neu öffnen' }).click();
  await expect(tab.getByText('Die Sandbox wurde pausiert – Konsole geschlossen.')).toHaveCount(0); // not the old console while it starts
  await expect(panel.getByRole('button', { name: 'Pausieren' })).toBeVisible({ timeout: 15_000 });
  await expect(tab.getByRole('tab', { name: 'Konsole 1' })).toHaveAttribute('aria-selected', 'true');
  await expect(term).toContainText(/dockware@lotse-sbx-[\w-]+:\/var\/www\/html\$/);
  await expect(tab.getByRole('tab', { name: /Konsole \d/ })).toHaveCount(1);
  await tab.getByRole('button', { name: /Konsole \d schließen/ }).click();
  await expect(tab.getByRole('button', { name: 'Konsole öffnen' })).toBeVisible();

  page.once('dialog', d => void d.accept());
  await panel.getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Sandbox abschließen' }).click();
  await expect(panel).toHaveCount(0);
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: false } })).ok()).toBeTruthy();
});

// Database dump: chunked upload in the "Sandbox starten" dialog, not stored (unticked), imported during the setup and deleted right afterwards.
test('Sandbox Coding: a .sql.gz dump is uploaded, imported and deleted', async ({ page, request }) => {
  test.setTimeout(120_000);
  const lotse = { 'x-lotse': '1' };
  expect((await request.put('/api/github', { headers: lotse, data: { token: GITHUB_TOKEN } })).ok()).toBeTruthy();
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: true } })).ok()).toBeTruthy();
  await page.goto('/');
  await openSetup(page);
  const dialog = page.getByRole('dialog', { name: 'Sandbox starten' });
  await dialog.getByLabel('Titel (optional)').fill('Mit Datenbank');
  await next(dialog);
  await dialog.getByLabel('Repository').selectOption('acme/shop-theme');
  await expect(dialog.getByLabel('Basis-Branch')).toHaveValue('main');
  await next(dialog);
  await dialog.getByLabel('Dump hochladen').check(); // step 3: demo data unless chosen
  const keep = dialog.getByLabel('Für weitere Sandboxes speichern');
  await expect(keep).toBeChecked(); // stored by default
  await keep.uncheck();
  await expect(dialog.getByText('Nur bereinigte Dumps ohne Kundendaten. Die Datei wird nach dem Import gelöscht.')).toBeVisible();
  const sql = "-- MySQL dump\nINSERT INTO `migration` VALUES ('Shopware\\\\Core\\\\Migration\\\\V6_7\\\\Migration1700000000Foo',1,NULL,NULL,NULL);\n";
  const completed = page.waitForResponse(r => /\/api\/sandbox\/dumps\/d_[a-z0-9]{16}\/complete$/.test(r.url()));
  await dialog.getByLabel('Datenbank hochladen', { exact: true }).first().setInputFiles({ name: 'shop.sql.gz', mimeType: 'application/gzip', buffer: zlib.gzipSync(Buffer.from(sql)) });
  const { dump } = await (await completed).json() as { dump: { id: string; status: string } };
  expect(dump.status).toBe('ready');
  await expect(dialog.getByText(/shop\.sql\.gz .* ist bereit/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Sandbox starten' }).click();

  const panel = page.getByRole('region', { name: 'Sandbox', exact: true });
  await expect(panel.getByRole('button', { name: 'Pausieren' })).toBeVisible({ timeout: 30_000 });
  await panel.getByRole('tab', { name: 'Einrichtung' }).click();
  await panel.getByRole('button', { name: 'Details anzeigen' }).click();
  const importStep = panel.getByRole('listitem').filter({ hasText: 'Datenbank importieren' });
  await expect(importStep.getByText('erledigt')).toBeVisible();
  await expect(importStep.getByText('Dump gelöscht ✓', { exact: true })).toBeVisible();
  await expect(panel.getByText(/Dump: shop\.sql\.gz .*\(importiert\)/)).toBeVisible();
  const meta = await (await request.get(`/api/sandbox/dumps/${dump.id}`)).json() as { dump: { status: string } };
  expect(meta.dump.status).toBe('deleted');

  page.once('dialog', d => void d.accept());
  await panel.getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Sandbox abschließen' }).click();
  await expect(panel).toHaveCount(0);
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: false } })).ok()).toBeTruthy();
});

// Stored database: uploaded once in the start dialog (stored by default), listed under "Gespeicherte Datenbanken", the first sandbox
// imports it and saves the snapshot, the next one (preselected as the environment's default) takes the snapshot over without
// an import; deleting it removes it from the list.
test('Sandbox Coding: a stored database is reused – snapshot after the first import, restored for the next sandbox, delete', async ({ page, request }) => {
  test.setTimeout(150_000);
  const lotse = { 'x-lotse': '1' };
  expect((await request.put('/api/github', { headers: lotse, data: { token: GITHUB_TOKEN } })).ok()).toBeTruthy();
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: true } })).ok()).toBeTruthy();
  await page.goto('/');
  await openSetup(page);
  let dialog = page.getByRole('dialog', { name: 'Sandbox starten' });
  await dialog.getByLabel('Titel (optional)').fill('Gespeicherte Datenbank 1');
  await next(dialog);
  await dialog.getByLabel('Repository').selectOption('acme/shop-theme');
  await expect(dialog.getByLabel('Basis-Branch')).toHaveValue('main');
  await next(dialog);
  await dialog.getByLabel('Dump hochladen').check();
  await expect(dialog.getByLabel('Für weitere Sandboxes speichern')).toBeChecked();
  await expect(dialog.getByText('Nur bereinigte Dumps ohne Kunden- und Bestelldaten speichern.')).toBeVisible();
  const sql = "-- MySQL dump\nINSERT INTO `migration` VALUES ('Shopware\\\\Core\\\\Migration\\\\V6_7\\\\Migration1700000000Foo',1,NULL,NULL,NULL);\n";
  const completed = page.waitForResponse(r => /\/api\/sandbox\/dumps\/d_[a-z0-9]{16}\/complete$/.test(r.url()));
  await dialog.getByLabel('Datenbank hochladen', { exact: true }).first().setInputFiles({ name: 'stored.sql', mimeType: 'application/sql', buffer: Buffer.from(sql) });
  const { dump } = await (await completed).json() as { dump: { id: string; library: boolean; expiresAt: string | null } };
  expect([dump.library, dump.expiresAt]).toEqual([true, null]);
  await expect(dialog.getByText(/stored\.sql .* ist gespeichert/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Sandbox starten' }).click();
  let panel = page.getByRole('region', { name: 'Sandbox', exact: true });
  await expect(panel.getByRole('button', { name: 'Pausieren' })).toBeVisible({ timeout: 30_000 });
  await panel.getByRole('tab', { name: 'Einrichtung' }).click();
  await expect(panel.getByText(/Gespeicherte Datenbank: stored\.sql .*\(importiert\)/)).toBeVisible();
  await panel.getByRole('button', { name: 'Details anzeigen' }).click();
  await expect(panel.getByRole('listitem').filter({ hasText: 'Datenbank-Snapshot sichern' }).getByText('erledigt')).toBeVisible();
  page.once('dialog', d => void d.accept());
  await panel.getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Sandbox abschließen' }).click();
  await expect(panel).toHaveCount(0);

  // the list: version, size, snapshot ready; preselected as the default of "Sandbox starten"
  await page.goto('/sandbox-coding');
  const card = page.getByRole('region', { name: 'Gespeicherte Datenbanken' });
  const row = card.getByRole('listitem').filter({ hasText: 'stored.sql' });
  await expect(row.getByText(/Shopware 6\.7 · .* MB · hochgeladen .* · zuletzt verwendet/)).toBeVisible();
  await expect(row.getByText('Snapshot bereit')).toBeVisible();
  const env = page.locator('#sbx-env');
  if ((await env.getAttribute('open')) === null) await env.locator('> summary').click();
  await env.getByLabel('Datenbank', { exact: true }).selectOption(dump.id);
  await env.getByRole('button', { name: 'Sandbox-Umgebung speichern' }).click();
  await expect(env.getByRole('status').filter({ hasText: 'Gespeichert.' })).toBeVisible();

  await page.goto('/');
  await openSetup(page);
  dialog = page.getByRole('dialog', { name: 'Sandbox starten' });
  await dialog.getByLabel('Titel (optional)').fill('Gespeicherte Datenbank 2');
  await next(dialog);
  await dialog.getByLabel('Repository').selectOption('acme/shop-theme');
  await next(dialog);
  await expect(dialog.getByLabel('Gespeicherte Datenbank', { exact: true })).toHaveValue(dump.id); // the environment's default, preselected
  await dialog.getByRole('button', { name: 'Sandbox starten' }).click();
  panel = page.getByRole('region', { name: 'Sandbox', exact: true });
  await expect(panel.getByRole('button', { name: 'Pausieren' })).toBeVisible({ timeout: 30_000 });
  await panel.getByRole('tab', { name: 'Einrichtung' }).click();
  await expect(panel.getByText(/Gespeicherte Datenbank: stored\.sql .*\(aus dem Snapshot übernommen\)/)).toBeVisible();
  await panel.getByRole('button', { name: 'Details anzeigen' }).click();
  await expect(panel.getByRole('listitem').filter({ hasText: 'Datenbank-Snapshot sichern' }).getByText('übersprungen')).toBeVisible();
  page.once('dialog', d => void d.accept());
  await panel.getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Sandbox abschließen' }).click();
  await expect(panel).toHaveCount(0);

  // delete (with confirmation): gone from the list
  await page.goto('/sandbox-coding');
  page.once('dialog', d => void d.accept());
  await card.getByRole('button', { name: 'stored.sql löschen' }).click();
  await expect(card.getByText('Noch keine gespeicherte Datenbank.')).toBeVisible();
  expect((await (await request.get(`/api/sandbox/dumps/${dump.id}`)).json() as { dump: { status: string } }).dump.status).toBe('deleted');
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: false } })).ok()).toBeTruthy();
});

// The agent in a chat with a sandbox (scripted model, anthropic-fake, real Claude Code process): it reads and edits the theme's header
// template with Claude Code's own Read/Edit tools in the worktree, runs `bin/console theme:compile` in the (fake) container with
// sandbox_bash, the cards show both, the preview reloads with the new header and the "Freigabe" tab shows the AI's changes (diff).
test('Sandbox Coding: the agent edits the header template natively, compiles the theme with sandbox_bash, the preview shows it', async ({ page, request }) => {
  test.setTimeout(150_000);
  const lotse = { 'x-lotse': '1' };
  expect((await request.put('/api/github', { headers: lotse, data: { token: GITHUB_TOKEN } })).ok()).toBeTruthy();
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: true, defaultRepo: 'acme/shop-theme', defaultBranch: 'main' } })).ok()).toBeTruthy();
  await page.goto('/');
  await openSetup(page);
  const start = page.getByRole('dialog', { name: 'Sandbox starten' });
  await next(start); await next(start);
  await start.getByRole('button', { name: 'Sandbox starten' }).click();
  const panel = page.getByRole('region', { name: 'Sandbox', exact: true });
  await expect(panel.getByRole('button', { name: 'Pausieren' })).toBeVisible({ timeout: 30_000 });
  const preview = page.frameLocator('iframe[title="Vorschau der Sandbox-Storefront"]');
  await expect(preview.getByText('Lotse Test-Header')).toBeVisible();

  const header = 'src/Resources/views/storefront/layout/header/header.html.twig';
  const input = page.getByRole('textbox', { name: 'Nachricht an Lotse' });
  // an empty sandbox chat suggests what a shop operator can ask for; a chip only fills the input
  const examples = page.getByRole('group', { name: 'Vorschläge' });
  await expect(examples.getByRole('button')).toHaveCount(3);
  await examples.getByRole('button', { name: /eigenes Plugin, das auf der Produktseite einen Versandhinweis/ }).click();
  await expect(input).toHaveValue(/^Baue ein eigenes Plugin/);
  await input.fill(`Bitte umsetzen. [e2e:replace ${header} Lotse Test-Header|Gratis Versand ab 50 €] [e2e:bash bin/console theme:compile]`);
  await page.getByRole('button', { name: 'Senden' }).click();
  await expect(page.getByRole('group', { name: `Geändert: ${header}, 1 Zeilen hinzu, 1 entfernt` })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('status').filter({ hasText: /Theme kompilieren ✓ [\d,]+ s/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Fertig: 3 Schritte.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('group', { name: 'Vorschläge' })).toHaveCount(0); // examples only while the chat is empty

  // the preview reloaded after the compile: the fake storefront now renders the changed header template
  await expect(preview.getByText('Gratis Versand ab 50 €')).toBeVisible({ timeout: 15_000 });

  // no separate "Änderungen" tab any more: the AI session's changes sit on top of "Freigabe" (the tab counts the changed files)
  await expect(panel.getByRole('tab', { name: /Änderungen/ })).toHaveCount(0);
  await panel.getByRole('tab', { name: /^Freigabe/ }).click();
  const changes = panel.getByRole('tabpanel', { name: /^Freigabe/ }).getByRole('region', { name: 'Änderungen der KI' });
  await expect(changes.getByText('1 Datei geändert')).toBeVisible();
  await expect(changes.getByRole('region', { name: header })).toBeVisible(); // a section per file, with line numbers
  await expect(changes.getByRole('row').filter({ hasText: '<div class="lotse-e2e-note">Gratis Versand ab 50 €</div>' })).toHaveCount(1);
  await expect(changes.getByText(/^diff --git|^index [0-9a-f]+/)).toHaveCount(0); // git's meta lines are not shown

  // the chat keeps its sandbox: after a reload both come back
  await page.reload();
  await expect(page.getByRole('group', { name: `Geändert: ${header}, 1 Zeilen hinzu, 1 entfernt` })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Sandbox', exact: true }).getByRole('button', { name: 'Pausieren' })).toBeVisible();

  page.once('dialog', d => void d.accept());
  await page.getByRole('region', { name: 'Sandbox', exact: true }).getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Sandbox abschließen' }).click();
  await expect(page.getByRole('region', { name: 'Sandbox', exact: true })).toHaveCount(0);
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: false, defaultRepo: '', defaultBranch: '' } })).ok()).toBeTruthy();
});

// A24: files made inside the container reach the project only by taking them over – through the AI (pull_from_container), there is no
// container comparison in the panel. The user makes some in the console ("Konsole") and asks the AI to take them over: the snippet comes
// over (file card, then under "Freigabe"), a token and .env.local stay out; then the AI changes a file with sandbox_bash and takes it over too.
test('Sandbox Coding: files made in the container – in the console and by the AI – are taken over into the project', async ({ page, request }) => {
  test.setTimeout(150_000);
  const lotse = { 'x-lotse': '1' };
  expect((await request.put('/api/github', { headers: lotse, data: { token: GITHUB_TOKEN } })).ok()).toBeTruthy();
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: true, defaultRepo: 'acme/shop-theme', defaultBranch: 'main' } })).ok()).toBeTruthy();
  await page.goto('/');
  await openSetup(page);
  const start = page.getByRole('dialog', { name: 'Sandbox starten' });
  await start.getByLabel('Titel (optional)').fill('Aus dem Container');
  await next(start); await next(start);
  await start.getByRole('button', { name: 'Sandbox starten' }).click();
  const panel = page.getByRole('region', { name: 'Sandbox', exact: true });
  await expect(panel.getByRole('button', { name: 'Pausieren' })).toBeVisible({ timeout: 30_000 });

  // the user makes files in the container's console: a snippet, a token, a local .env
  const snippet = 'src/Resources/snippet/de_DE/konsole.de-DE.json';
  await panel.getByRole('tab', { name: 'Konsole' }).click();
  const con = panel.getByRole('tabpanel', { name: 'Konsole' });
  await con.getByRole('button', { name: 'Konsole öffnen' }).click();
  const term = con.locator('[data-console]:not([hidden]) .xterm-rows');
  await expect(term).toContainText(/:\/var\/www\/html\$/);
  await con.locator('[data-console]:not([hidden]) .xterm').click();
  for (const line of [`echo Neu aus der Konsole > custom/plugins/AcmeShopTheme/${snippet}`, `echo ${GITHUB_TOKEN} > custom/plugins/AcmeShopTheme/token.txt`, 'echo APP_SECRET=x > custom/plugins/AcmeShopTheme/.env.local']) {
    await page.keyboard.type(line);
    await page.keyboard.press('Enter');
  }
  await expect.poll(async () => ((await term.textContent()) ?? '').split(/:\/var\/www\/html\$/).length - 1).toBe(4); // three commands done, a fresh prompt

  const input = page.getByRole('textbox', { name: 'Nachricht an Lotse' });
  await input.fill('Übernimm die Dateien aus dem Container. [e2e:pull -]');
  await page.getByRole('button', { name: 'Senden' }).click();
  await expect(page.getByRole('group', { name: `Neu: ${snippet}, 1 Zeilen hinzu, 0 entfernt` })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Fertig: 1 Schritte.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('group', { name: /token\.txt|\.env\.local/ })).toHaveCount(0);
  await panel.getByRole('tab', { name: /^Freigabe/ }).click();
  const changes = panel.getByRole('tabpanel', { name: /^Freigabe/ }).getByRole('region', { name: 'Änderungen der KI' });
  await expect(changes.getByText('1 Datei geändert')).toBeVisible();
  await expect(changes.getByText('Noch nicht gespeichert: 1 Datei', { exact: true })).toBeVisible();
  await expect(changes.getByText(GITHUB_TOKEN)).toHaveCount(0);

  // the AI changes a file with a command in the container and takes it over itself
  await input.fill('Bitte übernehmen. [e2e:bash echo Hallo aus dem Container > custom/plugins/AcmeShopTheme/README.md] [e2e:pull README.md]');
  await page.getByRole('button', { name: 'Senden' }).click();
  await expect(page.getByRole('group', { name: 'Geändert: README.md, 1 Zeilen hinzu, 1 entfernt' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Fertig: 2 Schritte.')).toBeVisible({ timeout: 30_000 });
  await changes.getByRole('button', { name: 'Aktualisieren' }).click();
  await expect(changes.getByText('2 Dateien geändert')).toBeVisible();

  page.once('dialog', d => void d.accept());
  await panel.getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Sandbox abschließen' }).click();
  await expect(panel).toHaveCount(0);
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: false, defaultRepo: '', defaultBranch: '' } })).ok()).toBeTruthy();
});

// Publishing (scripted model): the AI edits the header, commits it locally ([e2e:commit], shown under "Freigabe") and proposes a
// pull request ([e2e:pr]); the proposal card opens the "Freigabe" (pull request) tab prefilled (no screenshots: nobody took one), only the
// click there pushes the commit to lotse/… and opens the PR (GitHub fake); the PR card shows number and link in the chat and the
// tab, the task list shows the number; the plugin downloads as ZIP. With "Screenshots" switched on, the preview's "Screenshot" adds one to the tab.
test('Sandbox Coding: the AI proposes a pull request, the click publishes it, the PR card shows the link', async ({ page, request }) => {
  test.setTimeout(150_000);
  const lotse = { 'x-lotse': '1' };
  expect((await request.put('/api/github', { headers: lotse, data: { token: GITHUB_TOKEN } })).ok()).toBeTruthy();
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: true, defaultRepo: 'acme/shop-theme', defaultBranch: 'main' } })).ok()).toBeTruthy();
  await page.goto('/');
  await openSetup(page);
  const dialog = page.getByRole('dialog', { name: 'Sandbox starten' });
  await dialog.getByLabel('Titel (optional)').fill('Gratis Versand');
  await next(dialog); await next(dialog);
  await dialog.getByRole('button', { name: 'Sandbox starten' }).click();
  const panel = page.getByRole('region', { name: 'Sandbox', exact: true });
  await expect(panel.getByRole('button', { name: 'Pausieren' })).toBeVisible({ timeout: 30_000 });

  const header = 'src/Resources/views/storefront/layout/header/header.html.twig';
  await page.getByRole('textbox', { name: 'Nachricht an Lotse' }).fill(`Bitte umsetzen. [e2e:replace ${header} Lotse Test-Header|Gratis Versand] [e2e:commit Gratis Versand im Header anzeigen] [e2e:pr Header: Gratis Versand|Im Header steht jetzt Gratis Versand.]`);
  await page.getByRole('button', { name: 'Senden' }).click();
  await expect(page.getByText('Fertig: 4 Schritte.')).toBeVisible({ timeout: 60_000 });
  // the AI's local commit under "Freigabe": saved, not published, nothing left uncommitted
  await panel.getByRole('tab', { name: /^Freigabe/ }).click();
  const commits = panel.getByRole('region', { name: /Gespeicherte Schritte/ });
  await expect(commits.getByRole('listitem').filter({ hasText: 'Gratis Versand im Header anzeigen' })).toContainText('lokal');
  await expect(panel.getByText(/Noch nicht gespeichert/)).toHaveCount(0);
  const proposal = page.getByRole('region', { name: 'Vorschlag: zur Prüfung freigeben' });
  await expect(proposal.getByText('Header: Gratis Versand')).toBeVisible();
  const pulls = async () => ((await (await request.get(`${githubUrl}/__fake/calls`)).json()) as { method: string; path: string; body: { head?: string; base?: string; body?: string } }[])
    .filter(c => c.method === 'POST' && c.path === '/repos/acme/shop-theme/pulls');
  const before = (await pulls()).length;
  await proposal.getByRole('button', { name: 'Ansehen und freigeben' }).click();

  // plain words in the tab, the technical term as its tooltip
  const prTab = panel.getByRole('tab', { name: 'Freigabe' });
  await expect(prTab).toHaveAttribute('aria-selected', 'true');
  await expect(prTab).toHaveAttribute('title', 'Pull Request');
  const form = panel.getByRole('form', { name: 'Zur Prüfung freigeben' });
  await expect(form.getByLabel('Titel')).toHaveValue('Header: Gratis Versand');
  await expect(form.getByLabel('Beschreibung')).toHaveValue('Im Header steht jetzt Gratis Versand.');
  // the changed files are shown above the form, in the AI session's changes
  await expect(panel.getByRole('region', { name: 'Änderungen der KI' }).getByRole('region', { name: header })).toBeVisible();
  await expect(form.getByText(/^lotse\/gratis-versand-[a-z0-9]{6} → main$/)).toBeVisible();
  // no screenshots: neither the setup nor publishing takes any by itself
  await expect(panel.getByRole('region', { name: 'Screenshots' })).toHaveCount(0);
  expect((await pulls()).length).toBe(before); // nothing published before the click
  await form.getByLabel('Titel').fill('Header: Gratis Versand ab 50 €');
  await expect(form.getByRole('button', { name: 'Zur Prüfung freigeben' })).toHaveAttribute('title', 'Legt einen Pull Request an');
  await form.getByRole('button', { name: 'Zur Prüfung freigeben' }).click();

  const card = page.getByRole('log').getByRole('region', { name: /^Pull Request #\d+: Header: Gratis Versand ab 50 €$/ });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText(/Zur Prüfung freigegeben · 1 Datei/)).toBeVisible();
  await expect(card.getByRole('link', { name: 'Auf GitHub öffnen' })).toHaveAttribute('href', /^https:\/\/github\.com\/acme\/shop-theme\/pull\/\d+$/);
  await expect(card.getByText('offen')).toBeVisible();
  const posted = (await pulls()).slice(before);
  expect(posted).toHaveLength(1);
  expect(posted[0].body.head).toMatch(/^lotse\/gratis-versand-[a-z0-9]{6}$/);
  expect(posted[0].body.base).toBe('main');
  expect(posted[0].body.body).not.toMatch(/Screenshot/);
  await expect(panel.getByRole('region', { name: 'Screenshots' })).toHaveCount(0);
  await expect(panel.getByRole('tab', { name: /Freigabe\s*#\d+/ })).toBeVisible();
  await expect(panel.getByRole('status').filter({ hasText: /✓ Zur Prüfung freigegeben: Pull Request #\d+ angelegt\./ })).toBeVisible(); // success at the top of the tab
  // nothing new since the push: no button that would only send the same state again; editing the title offers the update
  await expect(form.getByText('Alles freigegeben – seit dem letzten Hochladen gibt es keine neuen Änderungen.')).toBeVisible();
  await expect(form.getByRole('button', { name: 'Freigabe aktualisieren' })).toHaveCount(0);
  await form.getByLabel('Titel').fill('Header: Gratis Versand ab 50 € (neu)');
  await expect(form.getByRole('button', { name: 'Freigabe aktualisieren' })).toBeVisible();
  await form.getByLabel('Titel').fill('Header: Gratis Versand ab 50 €');
  // the proposal card now says where it went instead of offering to publish again
  await expect(proposal.getByRole('link', { name: /^Freigegeben als Pull Request #\d+$/ })).toBeVisible();
  await expect(proposal.getByRole('button', { name: 'Ansehen und freigeben' })).toHaveCount(0);

  // "Plugin als ZIP" below the form: name, version and size, the download and where to upload it in the Shopware admin
  const zip = panel.getByRole('region', { name: 'Plugin als ZIP' });
  await expect(zip.getByText(/^AcmeShopTheme 1\.0\.0 · \d+ Dateien · [\d.,]+ (KB|MB)$/)).toBeVisible();
  await expect(zip.getByText(/Erweiterungen → Meine Erweiterungen → „Erweiterung hochladen“/)).toBeVisible();
  const download = page.waitForEvent('download');
  await zip.getByRole('button', { name: 'Plugin als ZIP herunterladen' }).click();
  expect((await download).suggestedFilename()).toBe('AcmeShopTheme-1.0.0.zip');
  await expect(zip.getByRole('status').filter({ hasText: 'AcmeShopTheme-1.0.0.zip gespeichert.' })).toBeVisible();

  // after a reload the card is replayed; "Screenshots" switched on: the preview's button adds a set to the "Freigabe" tab
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { screenshots: true } })).ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByRole('log').getByRole('region', { name: /^Pull Request #\d+:/ })).toBeVisible();
  const sbx = page.getByRole('region', { name: 'Sandbox', exact: true });
  await sbx.getByRole('tab', { name: 'Vorschau' }).click();
  await sbx.getByRole('button', { name: 'Screenshot', exact: true }).click();
  await expect(sbx.getByRole('status').filter({ hasText: 'Screenshot gespeichert' })).toBeVisible({ timeout: 30_000 });
  await sbx.getByRole('tab', { name: /Freigabe/ }).click();
  const shots = sbx.getByRole('region', { name: 'Screenshots' });
  await expect(shots.getByRole('img', { name: /^Screenshot Desktop: \/ / })).toBeVisible();
  await expect(shots.getByRole('img', { name: /^Screenshot Mobil: \/ / })).toBeVisible();
  // the task list shows the number
  await page.getByRole('region', { name: 'Sandbox', exact: true }).getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Alle Sandboxes' }).click();
  await expect(page.locator('section[aria-labelledby="sbx-tasks"]').getByRole('link', { name: /^PR #\d+ · offen$/ }).first()).toBeVisible();
  await page.locator('section[aria-labelledby="sbx-tasks"]').getByRole('link', { name: /Gratis Versand/ }).first().click();
  await expect(page.getByRole('region', { name: 'Sandbox', exact: true })).toBeVisible();

  // a review on GitHub comes back into the chat (the watcher polls every 2 s here); only the click hands it to the AI
  const prNo = Number((await page.getByRole('log').getByRole('link', { name: 'Auf GitHub öffnen' }).first().getAttribute('href'))!.split('/').pop());
  const feedback = (data: object) => request.post(`${githubUrl}/__fake/feedback`, { data: { repo: 'acme/shop-theme', number: prNo, ...data } });
  expect((await feedback({ reviews: [{ id: 9001, user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', body: 'Bitte „Gratis Versand“ fett setzen.' }] })).ok()).toBeTruthy();
  const fb = page.getByRole('log').getByRole('region', { name: `Rückmeldung zu Pull Request #${prNo}` });
  await expect(fb).toBeVisible({ timeout: 30_000 });
  await expect(fb.getByText('Bitte „Gratis Versand“ fett setzen.')).toBeVisible();
  await expect(fb.getByText(/Änderungen angefordert · von @reviewer/)).toBeVisible();
  const aiRequests = async () => (await (await request.get(`${aiUrl}/__fake/requests`)).json()) as { text: string }[];
  expect((await aiRequests()).some(r => r.text.includes('fett setzen'))).toBe(false); // nothing reaches the AI before the click
  await fb.getByRole('button', { name: 'An KI übergeben' }).click();
  await expect(fb.getByText('An die KI übergeben.')).toBeVisible();
  await expect(page.getByRole('log').getByText(`Bitte setze die Rückmeldung zu Pull Request #${prNo} um (1 Punkt).`)).toBeVisible();
  // the AI gets the review as data between delimiters, after the user's line
  await expect.poll(async () => (await aiRequests()).some(r => /\[PR-FEEDBACK\][^]*<pr-feedback-[0-9a-f]{12}>[^]*fett setzen/.test(r.text)), { timeout: 30_000 }).toBe(true);
  await expect(page.getByRole('button', { name: 'Senden' })).toBeVisible({ timeout: 60_000 });

  // merged on GitHub: the card offers to finish the task
  expect((await feedback({ merged: true })).ok()).toBeTruthy();
  const merged = page.getByRole('log').getByRole('region', { name: `Pull Request #${prNo} wurde gemergt` });
  await expect(merged).toBeVisible({ timeout: 30_000 });
  page.once('dialog', d => void d.accept());
  await merged.getByRole('button', { name: 'Sandbox abschließen' }).click();
  await expect(page.getByRole('region', { name: 'Sandbox', exact: true })).toHaveCount(0);
  await expect(merged.getByText(/Die Sandbox ist abgeschlossen/)).toBeVisible();
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: false, defaultRepo: '', defaultBranch: '' } })).ok()).toBeTruthy();
});

// Shop operators without developers: "Neues Projekt anlegen" in the start dialog creates a private repository (GitHub fake) and
// selects it; the empty project becomes a new plugin (technical name suggested from the project name). Plain words with the technical
// term small ("Projekt · GitHub-Repository"). Before the plugin skeleton exists, "Plugin als ZIP" says what is missing and can ask
// the AI; the task list offers "ZIP" too.
test('Sandbox Coding: a new project for a new plugin, the ZIP says what is missing', async ({ page, request }) => {
  test.setTimeout(120_000);
  const lotse = { 'x-lotse': '1' };
  expect((await request.put('/api/github', { headers: lotse, data: { token: GITHUB_TOKEN } })).ok()).toBeTruthy();
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: true } })).ok()).toBeTruthy();
  await page.goto('/');
  await openSetup(page);
  const dialog = page.getByRole('dialog', { name: 'Sandbox starten' });
  await dialog.getByLabel('Neues Plugin').check();
  await next(dialog);
  await expect(dialog.getByText('GitHub-Repository', { exact: true })).toBeVisible(); // the technical term next to "Projekt"
  await dialog.getByRole('button', { name: 'Neues Projekt anlegen' }).click();
  const group = dialog.getByRole('group', { name: 'Neues Projekt anlegen' });
  await expect(group.getByText(/„Administration: Lesen & Schreiben“/)).toBeVisible();
  await expect(group.getByLabel('Konto')).toHaveValue('octo-lotse');
  await expect(group.getByLabel('Konto').locator('option')).toHaveText(['octo-lotse (persönlich)', 'acme (Organisation)']);
  await group.getByLabel('Name des Projekts').fill('versand hinweis');
  await expect(group.getByLabel('Name des Projekts')).toHaveValue('versand-hinweis'); // spaces become hyphens
  await expect(dialog.getByRole('button', { name: 'Weiter' })).toBeDisabled(); // not while the project form is open
  await group.getByRole('button', { name: 'Projekt anlegen' }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Projekt octo-lotse/versand-hinweis angelegt (privat).' })).toBeVisible();
  const created = ((await (await request.get(`${githubUrl}/__fake/calls`)).json()) as { method: string; path: string; body: { name?: string; private?: boolean; auto_init?: boolean } }[])
    .find(c => c.method === 'POST' && c.path === '/user/repos');
  expect(created?.body).toMatchObject({ name: 'versand-hinweis', private: true, auto_init: true });
  await expect(dialog.getByLabel('Repository')).toHaveValue('octo-lotse/versand-hinweis');
  await expect(dialog.getByText('Das Projekt ist noch leer: Die KI baut darin ein neues Shopware-Plugin.')).toBeVisible();
  await expect(dialog.getByLabel('Technischer Name des Plugins')).toHaveValue('VersandHinweis');
  await dialog.getByLabel('Technischer Name des Plugins').fill('OctoVersandHinweis');
  await next(dialog);
  await dialog.getByRole('button', { name: 'Sandbox starten' }).click();

  const panel = page.getByRole('region', { name: 'Sandbox', exact: true });
  await expect(panel.getByRole('button', { name: 'Pausieren' })).toBeVisible({ timeout: 30_000 });
  await panel.getByRole('tab', { name: 'Freigabe' }).click();
  const zip = panel.getByRole('region', { name: 'Plugin als ZIP' });
  await expect(zip.getByText('Für ein ZIP fehlt noch:')).toBeVisible();
  await expect(zip.getByText(/composer\.json fehlt/)).toBeVisible();
  await expect(zip.getByRole('button', { name: 'KI bitten, das zu ergänzen' })).toBeVisible();
  await expect(zip.getByRole('button', { name: 'Plugin als ZIP herunterladen' })).toHaveCount(0);

  // the task list: "ZIP" checks first and says what is missing below the row
  await panel.getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Alle Sandboxes' }).click();
  const tasks = page.locator('section[aria-labelledby="sbx-tasks"]');
  const row = tasks.getByRole('listitem').filter({ hasText: 'octo-lotse/versand-hinweis' });
  await row.getByRole('button', { name: 'Plugin als ZIP herunterladen' }).click();
  await expect(row.getByRole('alert')).toContainText('Kein ZIP: composer.json fehlt');
  await tasks.getByRole('link', { name: /Sandbox versand-hinweis/ }).click();
  page.once('dialog', d => void d.accept());
  await page.getByRole('region', { name: 'Sandbox', exact: true }).getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Sandbox abschließen' }).click();
  await expect(page.getByRole('region', { name: 'Sandbox', exact: true })).toHaveCount(0);
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: false } })).ok()).toBeTruthy();
});

test('Sandbox Coding: a whole Shopware project – plugins, apps and config brought in, what the sandbox switched, ZIP of one plugin', async ({ page, request }) => {
  test.setTimeout(120_000);
  const lotse = { 'x-lotse': '1' };
  expect((await request.put('/api/github', { headers: lotse, data: { token: GITHUB_TOKEN } })).ok()).toBeTruthy();
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: true } })).ok()).toBeTruthy();
  await page.goto('/');
  await openSetup(page);
  const dialog = page.getByRole('dialog', { name: 'Sandbox starten' });
  await expect(dialog.getByText(/ein ganzer Shopware-Shop mit mehreren Plugins und eigener Konfiguration/)).toBeVisible();
  await dialog.getByLabel('Titel (optional)').fill('Ganzer Shop');
  await next(dialog);
  await dialog.getByLabel('Repository').selectOption('acme/shop');
  await expect(dialog.getByRole('status').filter({ hasText: 'Erkannt: ganzer Shopware-Shop (3 Plugins)' })).toBeVisible();
  await next(dialog);
  await dialog.getByRole('button', { name: 'Sandbox starten' }).click();
  const panel = page.getByRole('region', { name: 'Sandbox', exact: true });
  // installed completely: the setup waits for internet (composer install) until the user allows it, offline again afterwards
  await expect(panel.getByText('Wartet auf Internet-Freigabe')).toBeVisible({ timeout: 30_000 });
  page.once('dialog', d => void d.accept());
  await panel.getByRole('button', { name: 'Internet: aus' }).click();
  await expect(panel.getByRole('button', { name: 'Pausieren' })).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByRole('button', { name: 'Internet: aus' })).toBeVisible();

  await panel.getByRole('tab', { name: 'Einrichtung' }).click();
  const steps = panel.getByRole('tabpanel', { name: 'Einrichtung' });
  await expect(steps.getByText(/Container läuft · Shopware-Projekt \(3 Plugins\)/)).toBeVisible();
  await expect(steps.getByText(/^Vollständig installiert: Das ganze Repository liegt im Test-Shop/)).toBeVisible();
  const box = steps.getByRole('region', { name: 'Ganzes Shopware-Projekt' });
  await expect(box.getByText('Shopware 6.7.15.1 (composer.lock) · Theme: AcmeTheme')).toBeVisible();
  await expect(box.getByRole('listitem').filter({ hasText: 'AcmeErpConnector' })).toContainText('statisch');
  await expect(box.getByText('Apps: AcmeHelloApp')).toBeVisible();
  await box.getByText('1 Konfigurationsdatei wird in der Sandbox nicht geladen').click();
  await expect(box.getByText(/config\/packages\/sentry\.yaml/)).toBeVisible();
  await expect(box.getByText(/braucht eine Erweiterung, die das Image nicht hat \(sentry\)/)).toBeVisible();
  await expect(box.getByText(/^Umgebungsvariablen ohne Wert in der Sandbox: .*S3_PUBLIC_BUCKET/)).toBeVisible();
  await box.getByText(/^In der Sandbox umgestellt \(externe Dienste → lokal\)/).click();
  await expect(box.getByText('shopware.cart.storage.type: redis → mysql')).toBeVisible();
  await steps.getByRole('button', { name: 'Details anzeigen' }).click();
  await expect(steps.getByText('Shopware-Projekt erkennen')).toBeVisible();
  await steps.getByRole('listitem').filter({ hasText: 'Projekt einspielen (Plugins, Apps, Konfiguration, Theme)' }).getByText(/^Protokoll/).click();
  await expect(steps.getByText('$ bin/console plugin:install --activate -n -- AcmeStorefrontTweaks AcmeTheme AcmeErpConnector')).toBeVisible();
  await expect(steps.getByText('$ env COMPOSER_NO_INTERACTION=1 COMPOSER_MEMORY_LIMIT=-1 composer install --no-interaction --no-progress --no-scripts --prefer-dist --optimize-autoloader')).toBeVisible();
  await expect(steps.getByText('Internet wieder gesperrt.')).toBeVisible();

  // "Plugin als ZIP": one plugin of the project, chosen in the list
  await panel.getByRole('tab', { name: 'Freigabe' }).click();
  const zip = panel.getByRole('region', { name: 'Plugin als ZIP' });
  const pick = zip.getByLabel('Plugin des Projekts');
  await expect(pick.locator('option')).toHaveText(['AcmeStorefrontTweaks (custom/plugins/AcmeStorefrontTweaks)', 'AcmeTheme (custom/plugins/AcmeTheme)', 'AcmeErpConnector (custom/static-plugins/AcmeErpConnector)']);
  await pick.selectOption('custom/plugins/AcmeTheme');
  await expect(zip.getByText(/^AcmeTheme 1\.0\.0 · \d+ Dateien/)).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), zip.getByRole('button', { name: 'Plugin als ZIP herunterladen' }).click()]);
  expect(download.suggestedFilename()).toBe('AcmeTheme-1.0.0.zip');

  page.once('dialog', d => void d.accept());
  await panel.getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Sandbox abschließen' }).click();
  await expect(page.getByRole('region', { name: 'Sandbox', exact: true })).toHaveCount(0);
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: false } })).ok()).toBeTruthy();
});

// A20: one start dialog for every case. A project with .lotse/sandbox.json: detected before the start (chip), its commands shown and
// allowed with a click, "ändern" → own setup with a target folder (invalid ones refused with the hint) and an own command; the setup
// copies the code there and runs the commands. Then "Ohne Projekt starten": a test shop with a local git, later "Als GitHub-Projekt
// anlegen" in the Freigabe tab. The dialog fits a phone (no horizontal scrolling).
test('Sandbox Coding: start dialog in three steps – repository file with approval, own setup, without a project and GitHub later', async ({ page, request }) => {
  test.setTimeout(150_000);
  const lotse = { 'x-lotse': '1' };
  expect((await request.put('/api/github', { headers: lotse, data: { token: GITHUB_TOKEN } })).ok()).toBeTruthy();
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: true } })).ok()).toBeTruthy();
  await page.goto('/');
  await openSetup(page);
  const dialog = page.getByRole('dialog', { name: 'Sandbox starten' });
  await expect(dialog.getByRole('button', { name: /^Schritt 1 von 3: Was\?/ })).toHaveAttribute('aria-current', 'step');
  await expect(dialog.getByRole('button', { name: /Schritt 3 von 3/ })).toBeDisabled(); // not before the source is complete
  // the text below the cards fits the chosen case
  await expect(dialog.getByRole('note')).toHaveText(/^Lotse holt dein Projekt von GitHub/);
  await dialog.getByLabel('Ohne Projekt starten').check();
  await expect(dialog.getByRole('note')).toHaveText(/ganz ohne GitHub/);
  await dialog.getByLabel('Eigenes Setup').check();
  await expect(dialog.getByRole('note')).toHaveText(/in einen Ordner deiner Wahl/);
  await dialog.getByLabel('Bestehendes Projekt').check();
  await dialog.getByLabel('Titel (optional)').fill('Flex');
  await next(dialog);
  await dialog.getByLabel('Repository').selectOption('acme/flex-plugin');
  await expect(dialog.getByRole('status').filter({ hasText: 'Erkannt: Plugin AcmeFlex' })).toBeVisible();
  const file = dialog.getByRole('region', { name: 'Dieses Projekt möchte beim Einrichten folgende Befehle ausführen' });
  await expect(file.getByText('bin/console framework:demodata')).toBeVisible();
  await expect(file.getByText(/fehlen in der Sandbox-Umgebung: STRIPE_KEY/)).toBeVisible();
  await expect(file.getByRole('button', { name: 'Befehle erlauben' })).toBeInViewport(); // scrolled into view, not below the fold
  await expect(dialog.getByRole('button', { name: 'Weiter' })).toBeDisabled(); // a decision first
  await file.getByRole('button', { name: 'Befehle erlauben' }).click();
  await expect(file.getByText('✓ Befehle erlaubt')).toBeVisible();
  // "ändern": own setup – target folder (checked as typed), an own command for this sandbox
  await dialog.getByRole('button', { name: 'ändern' }).click();
  await dialog.getByLabel(/^Eigenes Setup: Zielordner/).check();
  await expect(dialog.getByText(/Einrichtung liegt in deiner Hand/)).toBeVisible();
  const target = dialog.getByLabel('Zielordner im Container');
  await expect(target).toHaveValue('/opt/flex-plugin');
  await target.fill('/etc/flex');
  await expect(dialog.getByText('Nur unter /var/www, /opt oder /srv (ein Unterordner).')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Weiter' })).toBeDisabled();
  await target.fill('/srv/flex');
  await dialog.getByRole('button', { name: 'Befehl hinzufügen' }).click();
  await dialog.getByLabel('Bezeichnung 1').fill('Bauen');
  await dialog.getByLabel('Befehl 1').fill('make build');
  await next(dialog);
  await expect(dialog.getByText('Bestehendes Projekt · acme/flex-plugin @ main · Demo-Daten')).toBeVisible();
  await dialog.getByRole('button', { name: 'Sandbox starten' }).click();

  const panel = page.getByRole('region', { name: 'Sandbox', exact: true });
  await expect(panel.getByRole('button', { name: 'Pausieren' })).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByLabel('Pfad in der Sandbox')).toHaveValue('/de/'); // the repository's start page right after the setup
  await panel.getByRole('tab', { name: 'Einrichtung' }).click();
  const steps = panel.getByRole('tabpanel', { name: 'Einrichtung' });
  await expect(steps.getByText(/Eigenes Setup: \/srv\/flex/)).toBeVisible();
  await steps.getByRole('button', { name: 'Details anzeigen' }).click();
  await expect(steps.getByText('Code in den Zielordner übertragen')).toBeVisible();
  await expect(steps.getByText('Demodaten anlegen')).toBeVisible(); // the repository's command, allowed above
  await expect(steps.getByText('Bauen', { exact: true })).toBeVisible(); // this sandbox's own command
  page.once('dialog', d => void d.accept());
  await panel.getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Sandbox abschließen' }).click();
  await expect(panel).toHaveCount(0);

  // without a project, on a phone: the steps fit, nothing scrolls sideways
  await page.setViewportSize({ width: 390, height: 844 });
  await openSetup(page);
  await dialog.getByLabel('Ohne Projekt starten').check();
  await dialog.getByLabel('Titel (optional)').fill('Versand Banner');
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await next(dialog);
  await expect(dialog.getByLabel('Technischer Name des Plugins')).toHaveValue('VersandBanner');
  await next(dialog);
  await expect(dialog.getByText('Ohne Projekt starten · Plugin VersandBanner, nur lokales Git · Demo-Daten')).toBeVisible();
  await dialog.getByRole('button', { name: 'Sandbox starten' }).click();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByText(/Sandbox ohne Projekt angehängt/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Pausieren' })).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText('ohne GitHub-Projekt')).toBeVisible();
  await panel.getByRole('tab', { name: 'Freigabe' }).click();
  const gh = panel.getByRole('region', { name: 'Als GitHub-Projekt anlegen' });
  await expect(gh.getByLabel('Name des Projekts')).toHaveValue('versandbanner');
  await gh.getByLabel('Name des Projekts').fill('versand-banner');
  await gh.getByRole('button', { name: 'GitHub-Projekt anlegen' }).click();
  await expect(panel.getByText('octo-lotse/versand-banner').first()).toBeVisible();
  await expect(panel.getByRole('region', { name: 'Als GitHub-Projekt anlegen' })).toHaveCount(0); // the usual "Zur Prüfung freigeben" now
  await expect(panel.getByRole('status').filter({ hasText: 'Projekt octo-lotse/versand-banner angelegt' })).toBeVisible();
  const created = ((await (await request.get(`${githubUrl}/__fake/calls`)).json()) as { method: string; path: string; body: { name?: string; auto_init?: boolean } }[])
    .filter(c => c.method === 'POST' && c.path === '/user/repos').at(-1);
  expect(created?.body).toMatchObject({ name: 'versand-banner', auto_init: false });
  page.once('dialog', d => void d.accept());
  await panel.getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Sandbox abschließen' }).click();
  await expect(panel).toHaveCount(0);
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: false } })).ok()).toBeTruthy();
});

// A22/A23 "Gespeicherte Umgebungen": set up once (save the dialog's choice), then every entry point offers the same list – saved
// environments (default first) → "Demo-Shop ohne Projekt" → "Neu einrichten …" – and every start is a fresh sandbox: two from the same
// environment run side by side (workspace menu and the Sandbox Coding page), the AI's card preselects the one it suggests, the panel
// saves a running sandbox's setup, a broken one opens the dialog prefilled with why (a deleted database: no data preselected); on the
// Sandbox Coding page: edit (the dialog as editor), rename, duplicate, delete.
test('Sandbox Coding: saved environments – the same choices everywhere, fresh sandboxes side by side, the AI card, broken ones, edit and delete', async ({ page, request }) => {
  test.setTimeout(240_000);
  const lotse = { 'x-lotse': '1' };
  expect((await request.put('/api/github', { headers: lotse, data: { token: GITHUB_TOKEN } })).ok()).toBeTruthy();
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: true, defaultRepo: '', defaultBranch: '' } })).ok()).toBeTruthy();
  await connectShop(request); // the AI's card below comes from a normal chat (start_sandbox): it needs a shop
  await page.goto('/');
  // nothing saved yet: the demo shop and "Neu einrichten …", and the way to manage them
  await page.getByRole('button', { name: 'Sandbox starten', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Sandbox starten' });
  await expectChoices(menu, ['Demo-Shop ohne Projekt', 'Neu einrichten …', 'Gespeicherte Umgebungen verwalten']);
  await expect(menu.getByRole('menuitem', { name: 'Demo-Shop ohne Projekt', exact: true })).toHaveAccessibleDescription('Shopware mit Demodaten, kein Repository – ein Klick. Änderungen bleiben im lokalen Git.');
  await menu.getByRole('menuitem', { name: 'Neu einrichten …', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Sandbox starten' });
  await next(dialog);
  await dialog.getByLabel('Repository').selectOption('acme/shop-theme');
  await expect(dialog.getByRole('status').filter({ hasText: 'Erkannt: Theme AcmeShopTheme' })).toBeVisible();
  await dialog.getByText('Erweitert', { exact: true }).click();
  await dialog.getByLabel('Image (Shopware-Version)').fill('6.7.14.0');
  await dialog.getByLabel('Startseite der Vorschau').fill('de/');
  await expect(dialog.getByText('Ein Pfad, der mit / beginnt, ohne Leerzeichen (z. B. /de/).')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Weiter' })).toBeDisabled();
  await dialog.getByLabel('Startseite der Vorschau').fill('/de/');
  await dialog.getByLabel('Hinweise für die KI (nur diese Sandbox)').fill('Footer-Texte stehen in den Snippets.');
  await next(dialog);
  await dialog.getByRole('button', { name: 'Als Umgebung speichern', exact: true }).click();
  await dialog.getByLabel('Name der Umgebung').fill('Theme Demo');
  await dialog.getByLabel('Als Standard (steht oben und ist vorausgewählt)').check();
  await dialog.getByRole('button', { name: 'Umgebung speichern', exact: true }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Als Umgebung „Theme Demo“ gespeichert.' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(dialog).toHaveCount(0);

  // the menu: the saved environment on top (what it uses as its description), one click starts a new sandbox from it
  await page.getByRole('button', { name: 'Sandbox starten', exact: true }).click();
  await expectChoices(menu, ['Theme Demo (Standard)', 'Demo-Shop ohne Projekt', 'Neu einrichten …', 'Gespeicherte Umgebungen verwalten']);
  const item = menu.getByRole('menuitem', { name: 'Theme Demo (Standard)', exact: true });
  await expect(item).toHaveAccessibleDescription('Bestehendes Projekt · acme/shop-theme @ main · Demo-Daten · Image 6.7.14.0');
  await item.click();
  await expect(page.getByText('Neue Sandbox aus „Theme Demo“ gestartet: Bestehendes Projekt · acme/shop-theme @ main · Demo-Daten · Image 6.7.14.0')).toBeVisible();
  const panel = page.getByRole('region', { name: 'Sandbox', exact: true });
  await expect(panel.getByRole('heading', { name: 'Theme Demo' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Pausieren' })).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByLabel('Pfad in der Sandbox')).toHaveValue('/de/'); // the environment's start page
  // ready: the start line stops spinning
  await expect(page.getByText('Neue Sandbox aus „Theme Demo“ gestartet', { exact: false })).toBeHidden();
  // the running sandbox's setup as another environment (the name is taken: say so, then another)
  await panel.getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Setup als Umgebung speichern' }).click();
  const fromTask = page.getByRole('dialog', { name: 'Setup als Umgebung speichern' });
  await expect(fromTask.getByLabel('Name der Umgebung')).toHaveValue('Theme Demo');
  await fromTask.getByRole('button', { name: 'Umgebung speichern', exact: true }).click();
  await expect(fromTask.getByRole('alert')).toContainText('Es gibt schon eine gespeicherte Umgebung „Theme Demo“.');
  await fromTask.getByLabel('Name der Umgebung').fill('Aus der Sandbox');
  await fromTask.getByRole('button', { name: 'Umgebung speichern', exact: true }).click();
  await expect(panel.getByRole('status').filter({ hasText: 'Als Umgebung „Aus der Sandbox“ gespeichert.' })).toBeVisible();

  // a second job from the same environment while the first runs: "Neue Sandbox" on the Sandbox Coding page, same list, a new chat
  await page.goto('/sandbox-coding');
  const tasks = page.locator('section[aria-labelledby="sbx-tasks"]');
  await tasks.getByRole('button', { name: 'Neue Sandbox', exact: true }).click();
  const pageMenu = page.getByRole('menu', { name: 'Neue Sandbox' });
  await expectChoices(pageMenu, ['Theme Demo (Standard)', 'Aus der Sandbox', 'Demo-Shop ohne Projekt', 'Neu einrichten …']);
  await pageMenu.getByRole('menuitem', { name: 'Theme Demo (Standard)', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(panel.getByRole('heading', { name: 'Theme Demo' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Pausieren' })).toBeVisible({ timeout: 30_000 });
  type T = { id: string; title: string; status: string; branch: string; chatId: string | null; container: unknown };
  const running = async () => ((await (await request.get('/api/sandbox/tasks', { headers: lotse })).json()) as { tasks: T[] }).tasks.filter(t => t.title === 'Theme Demo' && t.status !== 'done');
  const both = await running();
  expect(both).toHaveLength(2);
  expect(both.every(t => t.status === 'ready')).toBe(true); // side by side (LOTSE_SANDBOX_MAX 2)
  expect(new Set(both.map(t => t.branch)).size).toBe(2);
  expect(new Set(both.map(t => t.chatId)).size).toBe(2);
  for (const t of both) expect(t.branch).toMatch(/^lotse\/theme-demo-[a-z0-9]{6}$/);
  // a third one pauses the oldest: the new chat says so at once, without a reload
  await page.getByRole('button', { name: 'Neuer Chat', exact: true }).click();
  await page.getByRole('button', { name: 'Sandbox starten', exact: true }).click();
  await menu.getByRole('menuitem', { name: 'Demo-Shop ohne Projekt', exact: true }).click();
  await expect(page.getByText('„Theme Demo“ wurde pausiert, weil höchstens 2 Sandboxes gleichzeitig laufen. Fortsetzen geht jederzeit in ihrem Chat.', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Pausieren' })).toBeVisible({ timeout: 30_000 });
  const all = ((await (await request.get('/api/sandbox/tasks', { headers: lotse })).json()) as { tasks: T[] }).tasks.filter(t => t.status !== 'done');
  expect(all.filter(t => t.title === 'Theme Demo').map(t => t.status).sort()).toEqual(['paused', 'ready']);
  for (const t of all) expect((await request.post(`/api/sandbox/tasks/${t.id}/finish`, { headers: lotse, data: {} })).ok()).toBeTruthy();
  await page.reload();
  await expect(panel).toHaveCount(0);

  // "Demo-Shop ohne Projekt": one click, no repository
  await page.getByRole('button', { name: 'Sandbox starten', exact: true }).click();
  await menu.getByRole('menuitem', { name: 'Demo-Shop ohne Projekt', exact: true }).click();
  // the chat above (a sandbox without a project was attached to it, then finished) can still be open after the reload: its line stays, the new one is the last
  await expect(page.getByText(/^Sandbox ohne Projekt angehängt/).last()).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Demo-Shop' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Pausieren' })).toBeVisible({ timeout: 30_000 });
  page.once('dialog', d => void d.accept());
  await panel.getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Sandbox abschließen' }).click();
  await expect(panel).toHaveCount(0);

  // the AI's card: the same choices, its suggestion preselected; nothing starts before the click, the reason becomes the title
  await page.getByRole('textbox', { name: 'Nachricht an Lotse' }).fill('Bitte eine Sandbox vorschlagen. [e2e:offer Theme Demo|Footer-Link im Theme ergänzen]');
  await page.getByRole('button', { name: 'Senden' }).click();
  const card = page.getByRole('region', { name: 'Vorschlag: Sandbox starten' });
  await expect(card.getByText('Vorschlag der KI: gespeicherte Umgebung „Theme Demo“ – jeder Start ist eine neue Sandbox.')).toBeVisible({ timeout: 30_000 });
  const choices = card.getByRole('group', { name: 'Womit starten?' });
  await expect(choices.getByRole('radio')).toHaveCount(4);
  await expect(choices.getByRole('radio', { name: 'Theme Demo (Standard)' })).toBeChecked();
  await expect(choices.getByRole('radio', { name: 'Demo-Shop ohne Projekt' })).not.toBeChecked();
  await expect(panel).toHaveCount(0);
  await choices.getByRole('radio', { name: 'Neu einrichten …' }).check();
  await expect(card.getByRole('button', { name: 'Neu einrichten …', exact: true })).toBeVisible();
  await choices.getByRole('radio', { name: 'Theme Demo (Standard)' }).check();
  await card.getByRole('button', { name: 'Sandbox starten', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Footer-Link im Theme ergänzen' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Pausieren' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Vorschlag angenommen: Footer-Link im Theme ergänzen')).toBeVisible();
  page.once('dialog', d => void d.accept());
  await panel.getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Sandbox abschließen' }).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: 'Neuer Chat', exact: true }).click();

  // the default is preselected in the dialog
  await openSetup(page);
  await expect(dialog.getByLabel('Gespeicherte Umgebung').locator('option:checked')).toHaveText('Theme Demo (Standard)');
  await next(dialog);
  await expect(dialog.getByLabel('Repository')).toHaveValue('acme/shop-theme');
  await expect(dialog.getByLabel('Startseite der Vorschau')).toHaveValue('/de/');
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();

  // an environment whose project is gone: the dialog opens prefilled with why
  expect((await request.post('/api/sandbox/quick-starts', { headers: lotse, data: { name: 'Kaputt', setup: { kind: 'existing', repo: 'acme/gone', baseBranch: 'main', previewPath: '/kaputt/' } } })).ok()).toBeTruthy();
  await page.getByRole('button', { name: 'Sandbox starten', exact: true }).click();
  await menu.getByRole('menuitem', { name: 'Kaputt', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Die gespeicherte Umgebung „Kaputt“ lässt sich so nicht starten – bitte prüfen und anpassen:');
  await expect(dialog.getByRole('alert')).toContainText('Kein Zugriff auf acme/gone');
  await expect(dialog.getByRole('button', { name: /^Schritt 2 von 3/ })).toHaveAttribute('aria-current', 'step');
  await expect(dialog.getByLabel('Repository')).toHaveValue(''); // not in the list any more: pick another
  await expect(dialog.getByLabel('Startseite der Vorschau')).toHaveValue('/kaputt/'); // the rest is taken over
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(panel).toHaveCount(0); // nothing started

  // an environment whose stored database was deleted: step 3 opens, no data is preselected (not quietly the demo data)
  const sql = Buffer.from("-- MySQL dump\nINSERT INTO `product` VALUES (1);\n");
  const up = ((await (await request.post('/api/sandbox/dumps', { headers: lotse, data: { name: 'weg.sql', size: sql.length, keep: true } })).json()) as { dump: { id: string } }).dump;
  expect((await request.put(`/api/sandbox/dumps/${up.id}?offset=0`, { headers: { ...lotse, 'content-type': 'application/octet-stream' }, data: sql })).ok()).toBeTruthy();
  expect((await request.post(`/api/sandbox/dumps/${up.id}/complete`, { headers: lotse, data: {} })).ok()).toBeTruthy();
  expect((await request.post('/api/sandbox/quick-starts', { headers: lotse, data: { name: 'Ohne DB', setup: { kind: 'existing', repo: 'acme/shop-theme', baseBranch: 'main', dumpId: up.id } } })).ok()).toBeTruthy();
  expect((await request.delete(`/api/sandbox/dumps/${up.id}`, { headers: lotse })).ok()).toBeTruthy();
  await page.getByRole('button', { name: 'Sandbox starten', exact: true }).click();
  await menu.getByRole('menuitem', { name: 'Ohne DB', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Die gespeicherte Datenbank dieser Umgebung gibt es nicht mehr – bitte Daten neu wählen.');
  await expect(dialog.getByRole('button', { name: /^Schritt 3 von 3/ })).toHaveAttribute('aria-current', 'step');
  await expect(dialog.getByRole('status').filter({ hasText: 'Die gespeicherte Datenbank dieser Umgebung gibt es nicht mehr. Bitte Daten wählen – nichts ist vorausgewählt.' })).toBeVisible();
  for (const label of ['Demo-Daten', 'Gespeicherte Datenbank', 'Dump hochladen']) await expect(dialog.getByRole('radio', { name: label })).not.toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Sandbox starten', exact: true })).toBeDisabled();
  await dialog.getByRole('radio', { name: 'Demo-Daten' }).check();
  await expect(dialog.getByRole('button', { name: 'Sandbox starten', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(panel).toHaveCount(0);

  // Sandbox Coding page: list, edit in the dialog, rename, duplicate, delete
  await page.goto('/sandbox-coding');
  const quick = page.locator('section[aria-labelledby="sbx-quick"]');
  const row = quick.getByRole('listitem').filter({ hasText: 'Theme Demo' });
  await expect(row.getByText('Standard', { exact: true })).toBeVisible();
  await expect(row.getByText(/Bestehendes Projekt · acme\/shop-theme @ main · Demo-Daten · Image 6\.7\.14\.0 · zuletzt gestartet/)).toBeVisible();
  await row.getByRole('button', { name: 'Bearbeiten' }).click();
  const editor = page.getByRole('dialog', { name: 'Umgebung bearbeiten: Theme Demo' });
  await expect(editor.getByLabel('Name der Umgebung')).toHaveValue('Theme Demo');
  await next(editor);
  await expect(editor.getByLabel('Repository')).toHaveValue('acme/shop-theme');
  await expect(editor.getByLabel('Image (Shopware-Version)')).toHaveValue('dockware/shopware:6.7.14.0');
  await editor.getByLabel('Image (Shopware-Version)').fill('');
  await next(editor);
  await editor.getByRole('button', { name: 'Umgebung speichern', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(row.getByText(/Bestehendes Projekt · acme\/shop-theme @ main · Demo-Daten · zuletzt/)).toBeVisible();
  // a variable whose value holds a secret of the environment is kept by name: shown in the editor, kept when saving; a secret in
  // another field is refused with the field's name
  const SECRET = 'sk_live_e2e_quickstart_4711';
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { envVars: [{ key: 'STRIPE_KEY', secret: true, value: SECRET }] } })).ok()).toBeTruthy();
  const refRes = await request.post('/api/sandbox/quick-starts', { headers: lotse, data: { name: 'Mit Referenz', setup: { kind: 'existing', repo: 'acme/shop-theme', baseBranch: 'main', env: [{ key: 'API_URL', value: `https://pay.test/?key=${SECRET}` }] } } });
  expect(refRes.ok()).toBeTruthy();
  const refId = ((await refRes.json()) as { quickStart: { id: string } }).quickStart.id;
  await page.reload();
  await quick.getByRole('listitem').filter({ hasText: 'Mit Referenz' }).getByRole('button', { name: 'Bearbeiten' }).click();
  const refEditor = page.getByRole('dialog', { name: 'Umgebung bearbeiten: Mit Referenz' });
  await next(refEditor);
  await expect(refEditor.getByText('Aus der Sandbox-Umgebung (nur der Name, den Wert setzt die Sandbox-Umgebung):')).toBeVisible();
  await expect(refEditor.getByRole('button', { name: 'API_URL nicht mehr aus der Sandbox-Umgebung übernehmen' })).toBeVisible();
  await refEditor.getByLabel('Hinweise für die KI (nur diese Sandbox)').fill(`Zahlung mit ${SECRET}`);
  await next(refEditor);
  await refEditor.getByRole('button', { name: 'Umgebung speichern', exact: true }).click();
  await expect(refEditor.getByRole('alert')).toContainText('Im Feld „Hinweise für die KI“ steht der geheime Wert von STRIPE_KEY.');
  await refEditor.getByRole('button', { name: /^Schritt 2 von 3/ }).click();
  await refEditor.getByLabel('Hinweise für die KI (nur diese Sandbox)').fill('Zahlung mit $STRIPE_KEY');
  await next(refEditor);
  await refEditor.getByRole('button', { name: 'Umgebung speichern', exact: true }).click();
  await expect(refEditor).toHaveCount(0);
  await expect(quick.getByRole('status').filter({ hasText: 'Als Umgebung „Mit Referenz“ gespeichert. Nur als Name gemerkt (der Wert kommt beim Start aus der Sandbox-Umgebung): API_URL' })).toBeVisible();
  const refSaved = (await (await request.get(`/api/sandbox/quick-starts/${refId}`, { headers: lotse })).json()) as { quickStart: { setup: { envRefs?: string[]; notes?: string } } };
  expect(refSaved.quickStart.setup).toMatchObject({ envRefs: ['API_URL'], notes: 'Zahlung mit $STRIPE_KEY' });
  expect(JSON.stringify(refSaved)).not.toContain(SECRET);
  await row.getByRole('button', { name: 'Aktionen für Theme Demo' }).click();
  await page.getByRole('menuitem', { name: 'Umbenennen' }).click();
  await quick.getByLabel('Neuer Name für Theme Demo').fill('Theme Basis');
  await quick.getByRole('button', { name: 'Speichern' }).click();
  const renamed = quick.getByRole('listitem').filter({ hasText: 'Theme Basis' });
  await expect(renamed).toBeVisible();
  await renamed.getByRole('button', { name: 'Aktionen für Theme Basis' }).click();
  await page.getByRole('menuitem', { name: 'Duplizieren' }).click();
  await expect(quick.getByRole('listitem').filter({ hasText: 'Theme Basis (Kopie)' })).toBeVisible();
  for (const name of ['Kaputt', 'Ohne DB', 'Mit Referenz', 'Theme Basis (Kopie)', 'Aus der Sandbox', 'Theme Basis']) {
    page.once('dialog', d => void d.accept());
    await quick.getByRole('button', { name: `Aktionen für ${name}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Löschen' }).click();
    await expect(quick.getByRole('status').filter({ hasText: `„${name}“ gelöscht.` })).toBeVisible();
  }
  await expect(quick.getByText('Noch keine gespeicherten Umgebungen.')).toBeVisible();
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: false, envVars: [] } })).ok()).toBeTruthy();
});
