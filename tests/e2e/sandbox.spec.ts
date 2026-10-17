import zlib from 'node:zlib';
import { expect, test } from '@playwright/test';
import { GITHUB_TOKEN } from './support/github';
import { githubUrl } from './support/env';

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

// A sandbox attached to a normal chat (fake runner, GitHub fake, bare file:// remote): "Sandbox" in the chat, the dialog with the
// environment's presets, the right panel shows "Einrichtung" during the setup and switches to "Vorschau" when ready; pause/resume
// in the status line; the "Sandbox Coding" tab lists it and opens its chat; "Aufgabe abschließen" detaches it, the chat stays.
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
  await expect(page.getByRole('button', { name: 'Sandbox', exact: true })).toHaveCount(0); // one sandbox per chat

  await panel.getByRole('tab', { name: 'Einrichtung' }).click();
  const steps = panel.getByRole('tabpanel', { name: 'Einrichtung' });
  await expect(steps.getByText('Theme kompilieren')).toBeVisible();
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
  await expect(panel.getByRole('button', { name: 'Internet: an' })).toHaveAttribute('aria-pressed', 'true');
  await panel.getByRole('button', { name: 'Internet: an' }).click();
  await expect(panel.getByRole('button', { name: 'Internet: aus' })).toHaveAttribute('aria-pressed', 'false');
  page.once('dialog', d => void d.accept());
  await panel.getByRole('button', { name: 'Internet: aus' }).click();
  await expect(panel.getByRole('button', { name: 'Internet: an' })).toBeVisible();

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

  // the tab lists it; a row opens its chat with the sandbox on the right
  await panel.getByRole('link', { name: 'Alle Aufgaben' }).click();
  await expect(tasks.getByRole('link', { name: /Footer grün.*Bereit/ })).toBeVisible();
  await tasks.getByRole('link', { name: /Footer grün/ }).click();
  await expect(panel.getByText('Footer grün')).toBeVisible();

  page.once('dialog', d => void d.accept());
  await panel.getByRole('button', { name: 'Aufgabe abschließen' }).click();
  await expect(panel).toHaveCount(0); // detached: the chat stays, the right side is the normal one again
  await expect(page.getByText(/Sandbox angehängt: acme\/shop-theme @ main/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sandbox', exact: true })).toBeVisible();
  await page.goto('/sandbox-coding');
  await expect(tasks.getByRole('link', { name: /Footer grün.*Abgeschlossen/ })).toBeVisible();
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: false, defaultRepo: '', defaultBranch: '' } })).ok()).toBeTruthy();
});

// Database dump: chunked upload in the "Sandbox starten" dialog, imported during the setup and deleted right afterwards.
test('Sandbox Coding: a .sql.gz dump is uploaded, imported and deleted', async ({ page, request }) => {
  test.setTimeout(120_000);
  const lotse = { 'x-lotse': '1' };
  expect((await request.put('/api/github', { headers: lotse, data: { token: GITHUB_TOKEN } })).ok()).toBeTruthy();
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: true } })).ok()).toBeTruthy();
  await page.goto('/');
  await page.getByRole('button', { name: 'Sandbox', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Sandbox starten' });
  await dialog.getByLabel('Repository').selectOption('acme/shop-theme');
  await expect(dialog.getByLabel('Basis-Branch')).toHaveValue('main');
  await dialog.getByLabel('Titel (optional)').fill('Mit Datenbank');
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
  const importStep = panel.getByRole('listitem').filter({ hasText: 'Datenbank importieren' });
  await expect(importStep.getByText('erledigt')).toBeVisible();
  await expect(importStep.getByText('Dump gelöscht ✓', { exact: true })).toBeVisible();
  await expect(panel.getByText(/Dump: shop\.sql\.gz .*\(importiert\)/)).toBeVisible();
  const meta = await (await request.get(`/api/sandbox/dumps/${dump.id}`)).json() as { dump: { status: string } };
  expect(meta.dump.status).toBe('deleted');

  page.once('dialog', d => void d.accept());
  await panel.getByRole('button', { name: 'Aufgabe abschließen' }).click();
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
  await page.getByRole('button', { name: 'Sandbox', exact: true }).click();
  await page.getByRole('dialog', { name: 'Sandbox starten' }).getByRole('button', { name: 'Sandbox starten' }).click();
  const panel = page.getByRole('region', { name: 'Sandbox' });
  await expect(panel.getByRole('button', { name: 'Pausieren' })).toBeVisible({ timeout: 30_000 });
  const preview = page.frameLocator('iframe[title="Vorschau der Sandbox-Storefront"]');
  await expect(preview.getByText('Lotse Test-Header')).toBeVisible();

  const header = 'src/Resources/views/storefront/layout/header/header.html.twig';
  const input = page.getByRole('textbox', { name: 'Nachricht an Lotse' });
  await input.fill(`Bitte umsetzen. [e2e:replace ${header} Lotse Test-Header|Gratis Versand ab 50 €] [e2e:bash bin/console theme:compile]`);
  await page.getByRole('button', { name: 'Senden' }).click();
  await expect(page.getByRole('group', { name: `Geändert: ${header}, 1 Zeilen hinzu, 1 entfernt` })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('status').filter({ hasText: /Theme kompilieren ✓ [\d,]+ s/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Fertig: 3 Schritte.')).toBeVisible({ timeout: 30_000 });

  // the preview reloaded after the compile: the fake storefront now renders the changed header template
  await expect(preview.getByText('Gratis Versand ab 50 €')).toBeVisible({ timeout: 15_000 });

  await panel.getByRole('tab', { name: /Änderungen/ }).click();
  const changes = panel.getByRole('tabpanel', { name: /Änderungen/ });
  await expect(changes.getByText('1 Datei geändert')).toBeVisible();
  await expect(changes.getByText('+    <div class="lotse-e2e-note">Gratis Versand ab 50 €</div>')).toBeVisible();

  // the chat keeps its sandbox: after a reload both come back
  await page.reload();
  await expect(page.getByRole('group', { name: `Geändert: ${header}, 1 Zeilen hinzu, 1 entfernt` })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Sandbox' }).getByRole('button', { name: 'Pausieren' })).toBeVisible();

  page.once('dialog', d => void d.accept());
  await page.getByRole('region', { name: 'Sandbox' }).getByRole('button', { name: 'Aufgabe abschließen' }).click();
  await expect(page.getByRole('region', { name: 'Sandbox' })).toHaveCount(0);
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: false, defaultRepo: '', defaultBranch: '' } })).ok()).toBeTruthy();
});

// Publishing (scripted model): the AI edits the header and proposes a pull request ([e2e:pr]); the proposal card opens the
// "Pull Request" tab prefilled, only the click there commits, pushes to lotse/… and opens the PR (GitHub fake); the PR card
// shows number and link in the chat and the tab, the task list shows the number.
test('Sandbox Coding: the AI proposes a pull request, the click publishes it, the PR card shows the link', async ({ page, request }) => {
  test.setTimeout(150_000);
  const lotse = { 'x-lotse': '1' };
  expect((await request.put('/api/github', { headers: lotse, data: { token: GITHUB_TOKEN } })).ok()).toBeTruthy();
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: true, defaultRepo: 'acme/shop-theme', defaultBranch: 'main' } })).ok()).toBeTruthy();
  await page.goto('/');
  await page.getByRole('button', { name: 'Sandbox', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Sandbox starten' });
  await dialog.getByLabel('Titel (optional)').fill('Gratis Versand');
  await dialog.getByRole('button', { name: 'Sandbox starten' }).click();
  const panel = page.getByRole('region', { name: 'Sandbox' });
  await expect(panel.getByRole('button', { name: 'Pausieren' })).toBeVisible({ timeout: 30_000 });

  const header = 'src/Resources/views/storefront/layout/header/header.html.twig';
  await page.getByRole('textbox', { name: 'Nachricht an Lotse' }).fill(`Bitte umsetzen. [e2e:replace ${header} Lotse Test-Header|Gratis Versand] [e2e:pr Header: Gratis Versand|Im Header steht jetzt Gratis Versand.]`);
  await page.getByRole('button', { name: 'Senden' }).click();
  await expect(page.getByText('Fertig: 3 Schritte.')).toBeVisible({ timeout: 60_000 });
  const proposal = page.getByRole('region', { name: 'Vorschlag für den Pull Request' });
  await expect(proposal.getByText('Header: Gratis Versand')).toBeVisible();
  const pulls = async () => ((await (await request.get(`${githubUrl}/__fake/calls`)).json()) as { method: string; path: string; body: { head?: string; base?: string; body?: string } }[])
    .filter(c => c.method === 'POST' && c.path === '/repos/acme/shop-theme/pulls');
  const before = (await pulls()).length;
  await proposal.getByRole('button', { name: 'Prüfen und veröffentlichen' }).click();

  await expect(panel.getByRole('tab', { name: 'Pull Request' })).toHaveAttribute('aria-selected', 'true');
  const form = panel.getByRole('form', { name: 'Pull Request' });
  await expect(form.getByLabel('Titel')).toHaveValue('Header: Gratis Versand');
  await expect(form.getByLabel('Beschreibung')).toHaveValue('Im Header steht jetzt Gratis Versand.');
  await expect(form.getByText(header)).toBeVisible();
  await expect(form.getByText(/^lotse\/gratis-versand-[a-z0-9]{6} → main$/)).toBeVisible();
  // before screenshots from the setup next to the after slot (taken when publishing)
  const shots = panel.getByRole('region', { name: 'Vorher / Nachher' });
  await expect(shots.getByRole('img', { name: 'Vorher, Desktop: /' })).toBeVisible();
  await expect(shots.getByRole('img', { name: 'Vorher, Mobil: /' })).toBeVisible();
  await expect(shots.getByText('beim Veröffentlichen').first()).toBeVisible();
  expect((await pulls()).length).toBe(before); // nothing published before the click
  await form.getByLabel('Titel').fill('Header: Gratis Versand ab 50 €');
  await form.getByRole('button', { name: 'Pull Request erstellen' }).click();

  const card = page.getByRole('log').getByRole('region', { name: /^Pull Request #\d+: Header: Gratis Versand ab 50 €$/ });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText(/Pull Request angelegt · 1 Datei/)).toBeVisible();
  await expect(card.getByRole('link', { name: 'Auf GitHub öffnen' })).toHaveAttribute('href', /^https:\/\/github\.com\/acme\/shop-theme\/pull\/\d+$/);
  await expect(card.getByText('offen')).toBeVisible();
  const posted = (await pulls()).slice(before);
  expect(posted).toHaveLength(1);
  expect(posted[0].body.head).toMatch(/^lotse\/gratis-versand-[a-z0-9]{6}$/);
  expect(posted[0].body.base).toBe('main');
  expect(posted[0].body.body).toMatch(/\*\*Screenshots:\*\* Vorher-\/Nachher-Screenshots .* Sie werden nicht auf GitHub hochgeladen\./);
  await expect(shots.getByRole('img', { name: 'Nachher, Mobil: /' })).toBeVisible();
  await expect(panel.getByRole('tab', { name: /Pull Request\s*#\d+/ })).toBeVisible();
  await expect(form.getByRole('button', { name: 'Pull Request aktualisieren' })).toBeVisible();

  // after a reload the card is replayed, the task list shows the number
  await page.reload();
  await expect(page.getByRole('log').getByRole('region', { name: /^Pull Request #\d+:/ })).toBeVisible();
  await page.getByRole('region', { name: 'Sandbox' }).getByRole('link', { name: 'Alle Aufgaben' }).click();
  await expect(page.locator('section[aria-labelledby="sbx-tasks"]').getByRole('link', { name: /^#\d+$/ }).first()).toBeVisible();
  await page.locator('section[aria-labelledby="sbx-tasks"]').getByRole('link', { name: /Gratis Versand/ }).first().click();
  page.once('dialog', d => void d.accept());
  await page.getByRole('region', { name: 'Sandbox' }).getByRole('button', { name: 'Aufgabe abschließen' }).click();
  await expect(page.getByRole('region', { name: 'Sandbox' })).toHaveCount(0);
  expect((await request.put('/api/sandbox/env', { headers: lotse, data: { enabled: false, defaultRepo: '', defaultBranch: '' } })).ok()).toBeTruthy();
});
