import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEventListeners } from 'node:events';
import '../isolate-data';
/* eslint-disable @typescript-eslint/no-explicit-any -- container spec as loose JSON */

// Template dockware: the container spec is built only from server values (no privileges, binds, devices, no published ports; only the
// internal network lotse-sandbox, in both modes) and passes the allow-list guard; detectLayout for plugin, theme, invalid name, full project.
const { buildSpec, detectLayout, sleep } = await import('../../src/server/sandbox/templates/dockware');
const { assertSafeSpec } = await import('../../src/server/sandbox/guards');

const base = { taskId: 't_abcdefghij12', image: 'dockware/shopware:6.7.15.1', memoryMb: 4096, cpus: 2, env: ['FOO=bar'] };

test('buildSpec: only the internal network + alias, no ports, labels, limits, dropped capabilities', () => {
  const s = buildSpec(base) as any;
  assert.equal(s.name, 'lotse-sbx-t-abcdefghij12');
  assert.equal(s.Image, 'dockware/shopware:6.7.15.1');
  assert.deepEqual(s.Labels, { 'lotse.managed': '1', 'lotse.task': 't_abcdefghij12', 'lotse.template': 'dockware' });
  assert.deepEqual(s.Env, ['FOO=bar']);
  assert.equal(s.HostConfig.NetworkMode, 'lotse-sandbox');
  assert.deepEqual(s.NetworkingConfig.EndpointsConfig['lotse-sandbox'].Aliases, ['lotse-sbx-t-abcdefghij12']);
  assert.equal(s.HostConfig.PortBindings, undefined);
  assert.equal(s.ExposedPorts, undefined);
  assert.equal(s.HostConfig.Memory, 4096 * 1024 * 1024);
  assert.equal(s.HostConfig.NanoCpus, 2e9);
  assert.ok(s.HostConfig.PidsLimit > 0);
  assert.ok(s.HostConfig.CapDrop.includes('NET_RAW'));
  for (const k of ['Privileged', 'Binds', 'Mounts', 'Devices', 'CapAdd', 'SecurityOpt', 'VolumesFrom', 'PidMode', 'IpcMode', 'UsernsMode']) assert.equal(s.HostConfig[k], undefined, k);
  assert.doesNotThrow(() => assertSafeSpec(s));
});

test('buildSpec refuses invalid input; the guard refuses ports, the default bridge and a missing network', () => {
  const s = buildSpec(base) as any;
  assert.throws(() => buildSpec({ ...base, image: 'dockware/shopware:latest' }), /Image/);
  assert.throws(() => buildSpec({ ...base, image: 'evil/image:1.0' }), /Image/);
  assert.throws(() => buildSpec({ ...base, taskId: '../x' }), /Aufgaben-ID/);
  // the guard refuses what the builder never produces
  assert.throws(() => assertSafeSpec({ ...s, HostConfig: { ...s.HostConfig, CapAdd: ['SYS_ADMIN'] } }), /CapAdd/);
  assert.throws(() => assertSafeSpec({ ...s, HostConfig: { ...s.HostConfig, CapDrop: ['ALL; rm'] } }), /CapDrop/);
  assert.throws(() => assertSafeSpec({ ...s, HostConfig: { ...s.HostConfig, NetworkMode: 'bridge' } }), /NetworkMode/);
  assert.throws(() => assertSafeSpec({ ...s, HostConfig: { ...s.HostConfig, NetworkMode: undefined } }), /lotse-sandbox/);
  assert.throws(() => assertSafeSpec({ ...s, HostConfig: { ...s.HostConfig, PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] } } }), /PortBindings/);
  assert.throws(() => assertSafeSpec({ ...s, ExposedPorts: { '80/tcp': {} } }), /ExposedPorts/);
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-layout-'));
const fixture = (name: string, files: Record<string, string>) => {
  const d = path.join(dir, name);
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  return d;
};
const plugin = (cls: string, extra: Record<string, string> = {}) => ({ 'composer.json': JSON.stringify({ type: 'shopware-platform-plugin', extra: { 'shopware-plugin-class': cls } }), ...extra });

test('detectLayout: plugin, theme plugin, invalid name, full project, no plugin, empty repository', () => {
  assert.deepEqual(detectLayout(fixture('plugin', plugin('Acme\\Checkout\\AcmeCheckout'))), { kind: 'plugin', name: 'AcmeCheckout', pluginDir: 'custom/plugins/AcmeCheckout' });
  assert.deepEqual(detectLayout(fixture('theme', plugin('Acme\\Theme\\AcmeTheme', { 'src/Resources/theme.json': '{}' }))), { kind: 'theme', name: 'AcmeTheme', pluginDir: 'custom/plugins/AcmeTheme' });
  assert.throws(() => detectLayout(fixture('bad', plugin('Acme\\x;rm -rf'))), /Ungültiger Plugin-Name/);
  assert.throws(() => detectLayout(fixture('lower', plugin('Acme\\acme'))), /Ungültiger Plugin-Name/);
  assert.throws(() => detectLayout(fixture('noclass', { 'composer.json': JSON.stringify({ type: 'shopware-platform-plugin' }) })), /Kein Shopware-Plugin erkannt/);
  const full = /Vollständige Shopware-Projekte werden von dieser Vorlage noch nicht unterstützt/;
  assert.throws(() => detectLayout(fixture('project', { 'composer.json': JSON.stringify({ type: 'project', require: { 'shopware/core': '6.7.*' } }) })), full);
  assert.throws(() => detectLayout(fixture('project2', { 'composer.json': JSON.stringify({ require: { 'shopware/storefront': '*' } }) })), full);
  assert.throws(() => detectLayout(fixture('nocomposer', { 'bin/console': '#!/usr/bin/env php' })), full);
  assert.throws(() => detectLayout(fixture('other', { 'README.md': '# x', 'index.php': '<?php' })), /Kein Shopware-Plugin erkannt/);
  // only a README: a new plugin (sandbox-new-plugin.test.ts), here without a usable name
  assert.throws(() => detectLayout(fixture('empty', { 'README.md': '# x' })), /Repository ist leer, aber es fehlt ein gültiger technischer Name/);
  assert.equal(detectLayout(fixture('empty2', { 'README.md': '# x' }), { newPluginName: 'AcmeBanner' }).isNew, true);
  assert.throws(() => detectLayout(fixture('broken', { 'composer.json': '{nope' })), /kein gültiges JSON/);
  const link = path.join(dir, 'link'); fs.mkdirSync(link); fs.symlinkSync('/etc/hostname', path.join(link, 'composer.json'));
  assert.throws(() => detectLayout(link), /keine normale Datei/);
});

test('sleep: removes its abort listener after each wait and rejects at once on an aborted signal', async () => {
  const ac = new AbortController();
  for (let i = 0; i < 20; i++) await sleep(1, ac.signal);
  assert.equal(getEventListeners(ac.signal, 'abort').length, 0, 'no listeners pile up during a long poll');
  const pending = sleep(60_000, ac.signal);
  ac.abort();
  await assert.rejects(pending, /Abgebrochen/);
  const t0 = Date.now();
  await assert.rejects(sleep(60_000, ac.signal), /Abgebrochen/);
  assert.ok(Date.now() - t0 < 1000);
});
