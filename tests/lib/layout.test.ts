import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { popoverLeft } from '../../src/lib/popover';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const rule = (css: string, selector: string) => {
  const hit = css.match(new RegExp(`${selector}\\s*\\{[^}]*\\}`));
  assert.ok(hit, `rule missing: ${selector}`);
  return hit[0];
};

test('popoverLeft clamps to the actual width', () => {
  assert.equal(popoverLeft(100, 320, 800), 100);
  assert.equal(popoverLeft(500, 320, 400), 72);
  assert.equal(popoverLeft(0, 184, 200), 8);
  assert.ok(popoverLeft(180, 184, 200) + 184 <= 200 - 8);
});

test('preview bar wraps within the column, not only at 640px', () => {
  const preview = read('src/components/preview/PreviewPane.module.css');
  const bar = rule(preview, '\\.bar');
  assert.match(bar, /flex-wrap:\s*wrap/);
  const seg = rule(preview, '\\.seg');
  assert.match(seg, /flex:\s*1\s+1\s+180px/);
  assert.doesNotMatch(seg, /(?<![\w-])width:\s*250px/);
  assert.match(rule(read('src/components/workspace/Workspace.module.css'), '\\.pvBar'), /flex-wrap:\s*wrap/);
  assert.match(read('src/components/preview/PreviewPane.tsx'), /popoverLeft\(/);
  assert.match(rule(preview, '\\.pop'), /width:\s*min\(320px,\s*calc\(100%\s*-\s*16px\)\)/);
});

test('short height: the work chat scrolls, the composer stays in the flow', () => {
  const ws = read('src/components/workspace/Workspace.module.css');
  assert.match(ws, /\.app\[data-mode="work"\] \.chat[^{]*\{[^}]*overflow:\s*auto/);
  assert.match(ws, /\.app\[data-mode="pv"\] \.chat[^{]*\{[^}]*overflow:\s*auto/);
  assert.doesNotMatch(ws, /\.app\[data-mode="work"\] \.chat[^{]*\{[^}]*overflow:\s*hidden/);
  assert.doesNotMatch(ws, /\.app\[data-mode="pv"\] \.chat[^{]*\{[^}]*overflow:\s*hidden/);
});

test('dialog and page use dvh, with vh before it', () => {
  const dialog = read('src/components/ui/Dialog.module.css');
  assert.match(dialog, /max-height:\s*88vh;\s*max-height:\s*88dvh/);
  assert.match(dialog, /max-height:\s*62vh;\s*max-height:\s*62dvh/);
  assert.match(read('src/app/globals.css'), /min-height:\s*100vh;\s*min-height:\s*100dvh/);
});

test('menu, close and icon buttons are at least 40px', () => {
  const menu = rule(read('src/components/shell/AppShell.module.css'), '\\.menu');
  assert.match(menu, /min-width:\s*40px/);
  assert.match(menu, /min-height:\s*40px/);
  for (const file of ['src/components/preview/PreviewPane.module.css', 'src/components/context/ContextPanel.module.css']) {
    const close = rule(read(file), '\\.close');
    assert.match(close, /min-width:\s*40px/);
    assert.match(close, /min-height:\s*40px/);
  }
  const icon = rule(read('src/components/shell/SideNav.module.css'), '\\.iconBtn');
  assert.match(icon, /min-width:\s*40px/);
  assert.match(icon, /min-height:\s*40px/);
});

test('delete chat stays visible without hover', () => {
  const css = read('src/components/shell/SideNav.module.css');
  assert.match(css, /@media\s*\(hover:\s*none\)[^{]*\{[^}]*\.del[^{]*\{[^}]*opacity:\s*1/);
});

test('before and after wrap long tokens', () => {
  const css = read('src/components/chat/ChangeSetCard.module.css');
  assert.match(rule(css, '\\.old'), /overflow-wrap:\s*anywhere/);
  assert.match(rule(css, '\\.new'), /overflow-wrap:\s*anywhere/);
});
