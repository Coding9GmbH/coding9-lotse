// Wiring that can only be checked against the source without a browser (like a11y/layout): real-time history, lock without setup,
// shop check re-run after changes and after undo.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('new chat appears in the history immediately: fetch on the turn\'s start event', () => {
  const ws = read('src/components/workspace/Workspace.tsx');
  assert.match(ws, /if \(event\.t === 'start'\) loadHistory\(\)/);
});

test('without shop and AI: input, new chat, with context, style guide and knowledge base locked', () => {
  const ws = read('src/components/workspace/Workspace.tsx');
  assert.match(ws, /const locked = !shell\.healthFailed && !setupReady\(setup\)/, 'load error does not lock');
  assert.match(ws, /disabled=\{locked\}/);
  assert.match(ws, /\|\| locked\) return;/, 'send() does not send');
  const composer = read('src/components/chat/Composer.tsx');
  for (const el of ['textarea', 'attach', 'send']) assert.match(composer, new RegExp(`${el}[^>]*disabled=\\{disabled\\}|disabled=\\{disabled\\}[^>]*${el}`));
  const nav = read('src/components/shell/SideNav.tsx');
  assert.match(nav, /const ready = setupReady\(s\.setup\)/);
  assert.equal(nav.match(/disabled=\{!ready\}/g)?.length, 3, 'new chat, with context, style guide');
  assert.match(nav, /ready \? \(\s*<Link href="\/wissen"/, 'knowledge base is a link only when set up');
});

test('shop check re-runs after applied changes and after undo', () => {
  assert.match(read('src/server/features/shopcheck.ts'), /onApplied\('shopcheck', \(\) => \{ void recheckShopCheck\(\); \}\)/);
  assert.match(read('src/app/api/changesets/undo/route.ts'), /if \(out\.results\.some\(r => r\.ok\)\) void recheckShopCheck\(\)/);
});

test('settings: no save button anymore, save status at the top', () => {
  const view = read('src/components/settings/SettingsView.tsx');
  assert.doesNotMatch(view, />Speichern</);
  assert.doesNotMatch(view, /savebar/);
  assert.match(view, /<SaveState /);
  assert.doesNotMatch(read('src/components/settings/GscSettings.tsx'), />Speichern</);
});

test('Sandbox Coding: nav entry only while switched on (no shop needed), own settings section', () => {
  const nav = read('src/components/shell/SideNav.tsx');
  assert.match(nav, /\{s\.sandbox && \(/);
  assert.match(nav, /<Link href="\/sandbox-coding"/);
  assert.match(read('src/components/shell/ShellProvider.tsx'), /const sandbox = health \? !!health\.sandbox\?\.enabled : !!initial\?\.sandbox;/);
  const view = read('src/components/settings/SettingsView.tsx');
  assert.match(view, /sandbox: '\/settings\/sandbox'/);
  assert.match(view, /section === 'sandbox' && <SandboxSettings \/>/);
  assert.match(read('src/app/api/sandbox/env/check/route.ts'), /const off = sandboxForbidden\(\);\s+if \(off\) return off;/);
});
