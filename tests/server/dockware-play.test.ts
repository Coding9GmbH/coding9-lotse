import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../isolate-data';
/* eslint-disable @typescript-eslint/no-explicit-any -- container spec as loose JSON */

// Template dockware-play: the container spec is built only from server values (no privileges, binds, devices; ports only on
// loopback in local mode, none in network mode) and passes the allow-list guard; detectLayout for plugin, theme, invalid name, full project.
const { buildSpec, detectLayout } = await import('../../src/server/sandbox/templates/dockware-play');
const { assertSafeSpec } = await import('../../src/server/sandbox/guards');

const base = { taskId: 't_abcdefghij12', image: 'dockware/play:6.7.2.2', memoryMb: 4096, cpus: 2, env: ['FOO=bar'] };

test('buildSpec network mode: own network + alias, no ports, labels, limits, dropped capabilities', () => {
  const s = buildSpec({ ...base, mode: 'network' }) as any;
  assert.equal(s.name, 'lotse-sbx-t-abcdefghij12');
  assert.equal(s.Image, 'dockware/play:6.7.2.2');
  assert.deepEqual(s.Labels, { 'lotse.managed': '1', 'lotse.task': 't_abcdefghij12', 'lotse.template': 'dockware-play' });
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

test('buildSpec local mode: port 80 on 127.0.0.1 only; invalid input refused', () => {
  const s = buildSpec({ ...base, mode: 'local', port: 41234 }) as any;
  assert.equal(s.HostConfig.NetworkMode, 'bridge');
  assert.deepEqual(s.HostConfig.PortBindings, { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '41234' }] });
  assert.equal(s.NetworkingConfig, undefined);
  assert.doesNotThrow(() => assertSafeSpec(s));
  assert.throws(() => buildSpec({ ...base, mode: 'local' }), /Port/);
  assert.throws(() => buildSpec({ ...base, mode: 'network', image: 'dockware/play:latest' }), /Image/);
  assert.throws(() => buildSpec({ ...base, mode: 'network', image: 'evil/image:1.0' }), /Image/);
  assert.throws(() => buildSpec({ ...base, mode: 'network', taskId: '../x' }), /Aufgaben-ID/);
  // the guard refuses what the builder never produces
  assert.throws(() => assertSafeSpec({ ...s, HostConfig: { ...s.HostConfig, CapAdd: ['SYS_ADMIN'] } }), /CapAdd/);
  assert.throws(() => assertSafeSpec({ ...s, HostConfig: { ...s.HostConfig, CapDrop: ['ALL; rm'] } }), /CapDrop/);
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-layout-'));
const fixture = (name: string, files: Record<string, string>) => {
  const d = path.join(dir, name);
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  return d;
};
const plugin = (cls: string, extra: Record<string, string> = {}) => ({ 'composer.json': JSON.stringify({ type: 'shopware-platform-plugin', extra: { 'shopware-plugin-class': cls } }), ...extra });

test('detectLayout: plugin, theme plugin, invalid name, full project, no plugin', () => {
  assert.deepEqual(detectLayout(fixture('plugin', plugin('Acme\\Checkout\\AcmeCheckout'))), { kind: 'plugin', name: 'AcmeCheckout', pluginDir: 'custom/plugins/AcmeCheckout' });
  assert.deepEqual(detectLayout(fixture('theme', plugin('Acme\\Theme\\AcmeTheme', { 'src/Resources/theme.json': '{}' }))), { kind: 'theme', name: 'AcmeTheme', pluginDir: 'custom/plugins/AcmeTheme' });
  assert.throws(() => detectLayout(fixture('bad', plugin('Acme\\x;rm -rf'))), /Ungültiger Plugin-Name/);
  assert.throws(() => detectLayout(fixture('lower', plugin('Acme\\acme'))), /Ungültiger Plugin-Name/);
  assert.throws(() => detectLayout(fixture('noclass', { 'composer.json': JSON.stringify({ type: 'shopware-platform-plugin' }) })), /Kein Shopware-Plugin erkannt/);
  const full = /Vollständige Shopware-Projekte werden von dieser Vorlage noch nicht unterstützt/;
  assert.throws(() => detectLayout(fixture('project', { 'composer.json': JSON.stringify({ type: 'project', require: { 'shopware/core': '6.7.*' } }) })), full);
  assert.throws(() => detectLayout(fixture('project2', { 'composer.json': JSON.stringify({ require: { 'shopware/storefront': '*' } }) })), full);
  assert.throws(() => detectLayout(fixture('nocomposer', { 'bin/console': '#!/usr/bin/env php' })), full);
  assert.throws(() => detectLayout(fixture('empty', { 'README.md': '# x' })), /Kein Shopware-Plugin erkannt/);
  assert.throws(() => detectLayout(fixture('broken', { 'composer.json': '{nope' })), /kein gültiges JSON/);
  const link = path.join(dir, 'link'); fs.mkdirSync(link); fs.symlinkSync('/etc/hostname', path.join(link, 'composer.json'));
  assert.throws(() => detectLayout(link), /keine normale Datei/);
});
