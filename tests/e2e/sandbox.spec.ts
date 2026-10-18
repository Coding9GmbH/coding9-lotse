import zlib from 'node:zlib';
import { expect, test } from '@playwright/test';
import { GITHUB_TOKEN } from './support/github';
import { E2E, githubUrl } from './support/env';

const aiUrl = `http://127.0.0.1:${E2E.aiPort}`;

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
  // set up now: the readiness is one line and the environment is folded below the sandboxes
  await expect(page.locator('section[aria-labelledby="sbx-ready"]').getByText(/fehl(t|en) – eine Sandbox kann noch nicht starten/)).toBeVisible(); // GitHub is not connected in this test
  await env.getByRole('heading', { name: 'Umgebung' }).click();
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
  await tasks.getByRole('button', { name: 'Sandbox in neuem Chat' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sandbox starten' });
  await expect(dialog.getByLabel('Repository')).toHaveValue('acme/shop-theme'); // preset of the environment
  await expect(dialog.getByLabel('Basis-Branch')).toHaveValue('main');
  await dialog.getByLabel('Titel (optional)').fill('Footer grün');
  await dialog.getByRole('button', { name: 'Sandbox starten' }).click();

  await expect(page).toHaveURL(/\/$/);
  const panel = page.getByRole('region', { name: 'Sandbox' });
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
  await expect(steps.getByText('übersprungen')).toHaveCount(2); // no dump: version check and import skipped
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
  await page.getByRole('button', { name: 'Sandbox starten', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Sandbox starten' });
  await dialog.getByLabel('Repository').selectOption('acme/shop-theme');
  await dialog.getByLabel('Titel (optional)').fill('Konsole');
  await dialog.getByRole('button', { name: 'Sandbox starten' }).click();
  const panel = page.getByRole('region', { name: 'Sandbox' });
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

// Database dump: chunked upload in the "Sandbox starten" dialog, imported during the setup and deleted right afterwards.
test('Sandbox Coding: a .sql.gz dump is uploaded, imported and deleted', async ({ page, request }) => {
  test.setTimeout(120_000);
  const lotse = { 'x-lotse': '1' };
  expect((await request.put('/api/github', { headers: lotse, data: { token: GITHUB_TOKEN } })).ok()).toBeTruthy();
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: true } })).ok()).toBeTruthy();
  await page.goto('/');
  await page.getByRole('button', { name: 'Sandbox starten', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Sandbox starten' });
  await dialog.getByLabel('Repository').selectOption('acme/shop-theme');
  await expect(dialog.getByLabel('Basis-Branch')).toHaveValue('main');
  await dialog.getByLabel('Titel (optional)').fill('Mit Datenbank');
  await dialog.getByText('Datenbank-Dump hinzufügen (optional)').click(); // optional: behind a disclosure
  await expect(dialog.getByText('Nur bereinigte Dumps ohne Kundendaten. Die Datei wird nach dem Import gelöscht.')).toBeVisible();
  const sql = "-- MySQL dump\nINSERT INTO `migration` VALUES ('Shopware\\\\Core\\\\Migration\\\\V6_7\\\\Migration1700000000Foo',1,NULL,NULL,NULL);\n";
  const completed = page.waitForResponse(r => /\/api\/sandbox\/dumps\/d_[a-z0-9]{16}\/complete$/.test(r.url()));
  await dialog.getByLabel('Datenbank-Dump (optional)', { exact: true }).first().setInputFiles({ name: 'shop.sql.gz', mimeType: 'application/gzip', buffer: zlib.gzipSync(Buffer.from(sql)) });
  const { dump } = await (await completed).json() as { dump: { id: string; status: string } };
  expect(dump.status).toBe('ready');
  await expect(dialog.getByText(/shop\.sql\.gz .* ist bereit/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Sandbox starten' }).click();

  const panel = page.getByRole('region', { name: 'Sandbox' });
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

// The agent in a chat with a sandbox (scripted model, anthropic-fake, real Claude Code process): it reads and edits the theme's header
// template with Claude Code's own Read/Edit tools in the worktree, runs `bin/console theme:compile` in the (fake) container with
// sandbox_bash, the cards show both, the preview reloads with the new header and the "Änderungen" tab shows the diff.
test('Sandbox Coding: the agent edits the header template natively, compiles the theme with sandbox_bash, the preview shows it', async ({ page, request }) => {
  test.setTimeout(150_000);
  const lotse = { 'x-lotse': '1' };
  expect((await request.put('/api/github', { headers: lotse, data: { token: GITHUB_TOKEN } })).ok()).toBeTruthy();
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: true, defaultRepo: 'acme/shop-theme', defaultBranch: 'main' } })).ok()).toBeTruthy();
  await page.goto('/');
  await page.getByRole('button', { name: 'Sandbox starten', exact: true }).click();
  await page.getByRole('dialog', { name: 'Sandbox starten' }).getByRole('button', { name: 'Sandbox starten' }).click();
  const panel = page.getByRole('region', { name: 'Sandbox' });
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

  await panel.getByRole('tab', { name: /Änderungen/ }).click();
  const changes = panel.getByRole('tabpanel', { name: /Änderungen/ });
  await expect(changes.getByText('1 Datei geändert')).toBeVisible();
  await expect(changes.getByRole('region', { name: header })).toBeVisible(); // a section per file, with line numbers
  await expect(changes.getByRole('row').filter({ hasText: '<div class="lotse-e2e-note">Gratis Versand ab 50 €</div>' })).toHaveCount(1);
  await expect(changes.getByText(/^diff --git|^index [0-9a-f]+/)).toHaveCount(0); // git's meta lines are not shown

  // the chat keeps its sandbox: after a reload both come back
  await page.reload();
  await expect(page.getByRole('group', { name: `Geändert: ${header}, 1 Zeilen hinzu, 1 entfernt` })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Sandbox' }).getByRole('button', { name: 'Pausieren' })).toBeVisible();

  page.once('dialog', d => void d.accept());
  await page.getByRole('region', { name: 'Sandbox' }).getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Sandbox abschließen' }).click();
  await expect(page.getByRole('region', { name: 'Sandbox' })).toHaveCount(0);
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: false, defaultRepo: '', defaultBranch: '' } })).ok()).toBeTruthy();
});

// Publishing (scripted model): the AI edits the header, commits it locally ([e2e:commit], shown in "Änderungen") and proposes a
// pull request ([e2e:pr]); the proposal card opens the "Freigabe" (pull request) tab prefilled (no screenshots: nobody took one), only the
// click there pushes the commit to lotse/… and opens the PR (GitHub fake); the PR card shows number and link in the chat and the
// tab, the task list shows the number; the plugin downloads as ZIP. With "Screenshots" switched on, the preview's "Screenshot" adds one to the tab.
test('Sandbox Coding: the AI proposes a pull request, the click publishes it, the PR card shows the link', async ({ page, request }) => {
  test.setTimeout(150_000);
  const lotse = { 'x-lotse': '1' };
  expect((await request.put('/api/github', { headers: lotse, data: { token: GITHUB_TOKEN } })).ok()).toBeTruthy();
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: true, defaultRepo: 'acme/shop-theme', defaultBranch: 'main' } })).ok()).toBeTruthy();
  await page.goto('/');
  await page.getByRole('button', { name: 'Sandbox starten', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Sandbox starten' });
  await dialog.getByLabel('Titel (optional)').fill('Gratis Versand');
  await dialog.getByRole('button', { name: 'Sandbox starten' }).click();
  const panel = page.getByRole('region', { name: 'Sandbox' });
  await expect(panel.getByRole('button', { name: 'Pausieren' })).toBeVisible({ timeout: 30_000 });

  const header = 'src/Resources/views/storefront/layout/header/header.html.twig';
  await page.getByRole('textbox', { name: 'Nachricht an Lotse' }).fill(`Bitte umsetzen. [e2e:replace ${header} Lotse Test-Header|Gratis Versand] [e2e:commit Gratis Versand im Header anzeigen] [e2e:pr Header: Gratis Versand|Im Header steht jetzt Gratis Versand.]`);
  await page.getByRole('button', { name: 'Senden' }).click();
  await expect(page.getByText('Fertig: 4 Schritte.')).toBeVisible({ timeout: 60_000 });
  // the AI's local commit in "Änderungen": saved, not published, nothing left uncommitted
  await panel.getByRole('tab', { name: /Änderungen/ }).click();
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
  await expect(form.getByText(header)).toBeVisible();
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
  const sbx = page.getByRole('region', { name: 'Sandbox' });
  await sbx.getByRole('tab', { name: 'Vorschau' }).click();
  await sbx.getByRole('button', { name: 'Screenshot', exact: true }).click();
  await expect(sbx.getByRole('status').filter({ hasText: 'Screenshot gespeichert' })).toBeVisible({ timeout: 30_000 });
  await sbx.getByRole('tab', { name: /Freigabe/ }).click();
  const shots = sbx.getByRole('region', { name: 'Screenshots' });
  await expect(shots.getByRole('img', { name: /^Screenshot Desktop: \/ / })).toBeVisible();
  await expect(shots.getByRole('img', { name: /^Screenshot Mobil: \/ / })).toBeVisible();
  // the task list shows the number
  await page.getByRole('region', { name: 'Sandbox' }).getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Alle Sandboxes' }).click();
  await expect(page.locator('section[aria-labelledby="sbx-tasks"]').getByRole('link', { name: /^PR #\d+ · offen$/ }).first()).toBeVisible();
  await page.locator('section[aria-labelledby="sbx-tasks"]').getByRole('link', { name: /Gratis Versand/ }).first().click();
  await expect(page.getByRole('region', { name: 'Sandbox' })).toBeVisible();

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
  await expect(page.getByRole('region', { name: 'Sandbox' })).toHaveCount(0);
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
  await page.getByRole('button', { name: 'Sandbox starten', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Sandbox starten' });
  await expect(dialog.getByText('GitHub-Repository', { exact: true })).toBeVisible(); // the technical term next to "Projekt"
  await dialog.getByRole('button', { name: 'Neues Projekt anlegen' }).click();
  const group = dialog.getByRole('group', { name: 'Neues Projekt anlegen' });
  await expect(group.getByText(/„Administration: Lesen & Schreiben“/)).toBeVisible();
  await expect(group.getByLabel('Konto')).toHaveValue('octo-lotse');
  await expect(group.getByLabel('Konto').locator('option')).toHaveText(['octo-lotse (persönlich)', 'acme (Organisation)']);
  await group.getByLabel('Name des Projekts').fill('versand hinweis');
  await expect(group.getByLabel('Name des Projekts')).toHaveValue('versand-hinweis'); // spaces become hyphens
  await expect(dialog.getByRole('button', { name: 'Sandbox starten' })).toBeDisabled(); // not while the project form is open
  await group.getByRole('button', { name: 'Projekt anlegen' }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Projekt octo-lotse/versand-hinweis angelegt (privat).' })).toBeVisible();
  const created = ((await (await request.get(`${githubUrl}/__fake/calls`)).json()) as { method: string; path: string; body: { name?: string; private?: boolean; auto_init?: boolean } }[])
    .find(c => c.method === 'POST' && c.path === '/user/repos');
  expect(created?.body).toMatchObject({ name: 'versand-hinweis', private: true, auto_init: true });
  await expect(dialog.getByLabel('Repository')).toHaveValue('octo-lotse/versand-hinweis');
  await expect(dialog.getByText('Das Projekt ist noch leer: Die KI baut darin ein neues Shopware-Plugin.')).toBeVisible();
  await expect(dialog.getByLabel('Technischer Name des Plugins')).toHaveValue('VersandHinweis');
  await dialog.getByLabel('Technischer Name des Plugins').fill('OctoVersandHinweis');
  await dialog.getByRole('button', { name: 'Sandbox starten' }).click();

  const panel = page.getByRole('region', { name: 'Sandbox' });
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
  await page.getByRole('region', { name: 'Sandbox' }).getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Sandbox abschließen' }).click();
  await expect(page.getByRole('region', { name: 'Sandbox' })).toHaveCount(0);
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: false } })).ok()).toBeTruthy();
});
