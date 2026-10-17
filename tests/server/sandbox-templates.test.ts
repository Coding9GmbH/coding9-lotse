import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../isolate-data';

// Template registry: only dockware (formerly dockware-play), unique steps, i18n for every step and command, strict image pattern,
// allow-listed commands with argument patterns that keep shell syntax and paths outside the plugin out.
const { TEMPLATES, getTemplate, describeTemplate, resolveCommand } = await import('../../src/server/sandbox/templates');
const { messages } = await import('../../src/lib/i18n');
const t = getTemplate('dockware');
const ctx = { pluginDir: 'custom/plugins/AcmeTheme' };

test('registry holds only dockware; step ids unique; custom command slots around theme:compile', () => {
  assert.deepEqual(Object.keys(TEMPLATES), ['dockware']);
  assert.equal(getTemplate('dockware-play'), t, 'old id of stored settings and tasks');
  const ids = t.steps.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(t.commands.map(c => c.id)).size, t.commands.length);
  assert.ok(ids.indexOf('custom-after-db') > ids.indexOf('import-db') && ids.indexOf('custom-after-db') < ids.indexOf('theme-compile'), 'after-db runs before theme:compile');
  assert.ok(ids.indexOf('custom-final') > ids.indexOf('theme-compile') && ids.indexOf('custom-final') < ids.indexOf('ready'), 'final runs before ready');
  assert.deepEqual(t.steps.filter(s => s.custom).map(s => s.custom), ['after-db', 'final']);
  assert.ok(ids.indexOf('version-check') < ids.indexOf('import-db') && ids.indexOf('import-db') < ids.indexOf('set-domain') && ids.indexOf('set-domain') < ids.indexOf('install-plugin') && ids.indexOf('install-plugin') < ids.indexOf('custom-after-db'), 'the dump replaces the database before the plugin is installed into it');
  assert.throws(() => getTemplate('constructor'), /Unbekannte Sandbox-Vorlage/);
});

test('every step, command and the template have texts in de and en', () => {
  for (const locale of ['de', 'en'] as const) {
    const m = messages(locale).sandbox;
    assert.ok(m.templates[t.labelKey], `${locale} template`);
    for (const s of t.steps) assert.ok(m.steps[s.labelKey]?.trim(), `${locale} step ${s.id}`);
    for (const c of t.commands) assert.ok(m.commands[c.labelKey]?.trim(), `${locale} command ${c.id}`);
  }
});

test('image pattern: pinned dockware/shopware (and the older dockware/play) only', () => {
  for (const ok of ['dockware/shopware:6.7.15.1', 'dockware/shopware:6.7.15', 'dockware/shopware:6.7.15.1-amd64', 'dockware/shopware:6.7.15.1-arm64',
    'dockware/play:6.6.10.4', 'dockware/play:6.7.2.2', 'dockware/play:6.7']) assert.ok(t.imagePattern.test(ok), ok);
  for (const bad of ['dockware/shopware:latest', 'dockware/shopware:6.7-latest', 'dockware/shopware:6.7', 'dockware/shopware:6.7.15.1-x86', 'dockware/shopware',
    'dockware/play:latest', 'dockware/play', 'dockware/dev:6.7.2.2', 'docker.io/dockware/play:6.7.2.2', 'ghcr.io/x/dockware/play:6.7.2.2',
    'evil.example:5000/dockware/play:6.7.2.2', 'dockware/play:6.7.2.2@sha256:abc', 'dockware/play:6', 'dockware/play:6.7.2.2 ', 'dockware/play:6.7.2.2\n']) assert.ok(!t.imagePattern.test(bad), bad);
  assert.ok(t.imagePattern.test(t.defaultImage));
});

test('commands: fixed argv; path args reject shell syntax, "..", a leading "-" and absolute paths', () => {
  assert.deepEqual(resolveCommand(t, 'theme-compile', {}, ctx).argv, ['bin/console', 'theme:compile']);
  assert.deepEqual(resolveCommand(t, 'lint-twig', { path: 'src/Resources/views' }, ctx).argv, ['bin/console', 'lint:twig', 'custom/plugins/AcmeTheme/src/Resources/views']);
  assert.deepEqual(resolveCommand(t, 'php-lint', { path: 'src/AcmeTheme.php' }, ctx).argv, ['php', '-l', 'custom/plugins/AcmeTheme/src/AcmeTheme.php']);
  const r = resolveCommand(t, 'cache-clear', {}, ctx);
  assert.equal(r.user, 'www-data');
  assert.equal(r.workdir, '/var/www/html');
  for (const bad of ['a;rm -rf /', '$(id)', '`id`', '../secret', 'src/../../etc', '-rf', '--help', '/etc/passwd', 'a b', 'a|b', 'a&&b', 'x\ny', '']) {
    assert.throws(() => resolveCommand(t, 'lint-twig', { path: bad }, ctx), /Ungültiger Wert/, JSON.stringify(bad));
  }
  assert.throws(() => resolveCommand(t, 'php-lint', { path: 'src/x.twig' }, ctx), /Ungültiger Wert/);
  assert.throws(() => resolveCommand(t, 'lint-twig', {}, ctx), /Ungültiger Wert/, 'missing arg');
  assert.throws(() => resolveCommand(t, 'cache-clear', { path: 'x' }, ctx), /Unbekanntes Argument/);
  assert.throws(() => resolveCommand(t, 'bash', {}, ctx), /nicht erlaubt/);
  assert.throws(() => resolveCommand(t, 'cache-clear', {}, { pluginDir: '../x' }), /Plugin-Verzeichnis/);
  for (const c of t.commands) for (const a of c.args) assert.ok(!a.pattern.test('-x') && !a.pattern.test('/x') && !a.pattern.test('a/../b') && !a.pattern.test('a;b') && !a.pattern.test('$(x)'), `${c.id}.${a.name}`);
});

test('descriptor for the UI: plain data', () => {
  const d = describeTemplate(t);
  assert.equal(d.defaultImage, 'dockware/shopware:6.7.15.1');
  assert.deepEqual(JSON.parse(JSON.stringify(d)), d);
  assert.deepEqual(d.commands.find(c => c.id === 'lint-twig')?.args, ['path']);
});
