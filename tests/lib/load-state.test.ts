import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { catalogState, shellFlags } from '../../src/lib/load-state';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('catalogState: an error is neither empty nor "no results"', () => {
  assert.equal(catalogState('netz', null), 'error');
  assert.equal(catalogState('netz', []), 'error');
  assert.equal(catalogState(null, null), 'loading');
  assert.equal(catalogState(undefined, []), 'empty');
  assert.equal(catalogState(null, [{ id: 'a' }]), 'ready');
  assert.notEqual(catalogState('x', []), catalogState(null, []));
});

test('shellFlags: a load error does not mark shop and AI as set up', () => {
  const failed = shellFlags({ loadFailed: true, shopConfigured: true, shopOk: false, aiConfigured: true });
  assert.equal(failed.shopConfigured, false);
  assert.equal(failed.aiConfigured, false);
  assert.equal(failed.shop, 'unloaded');
  assert.equal(failed.ai, 'unloaded');
  assert.equal(shellFlags({ loadFailed: false, known: false }).shop, 'loading');
  const off = shellFlags({ loadFailed: false, known: true, shopConfigured: false, shopOk: false, aiConfigured: false });
  assert.equal(off.shop, 'disconnected');
  assert.equal(off.ai, 'disconnected');
  assert.equal(off.shopConfigured, false);
  const down = shellFlags({ loadFailed: false, known: true, shopConfigured: true, shopOk: false, aiConfigured: true });
  assert.equal(down.shop, 'unreachable');
  assert.equal(down.ai, 'ok');
  assert.equal(down.aiConfigured, true);
  assert.notEqual(failed.shop, off.shop);
  assert.notEqual(failed.shop, down.shop);
});

test('shell does not show a load error as an empty catalog or connected AI', () => {
  const shell = read('src/components/shell/ShellProvider.tsx');
  assert.doesNotMatch(shell, /configured:\s*true/);
  assert.match(shell, /catalogState|chatError|healthFailed/);
  const nav = read('src/components/shell/SideNav.tsx');
  assert.match(nav, /catalogState\(/);
  assert.match(nav, /t\.historyFailed/);
  assert.match(nav, /t\.emptyReady : t\.emptySetup/);
  const msgs = read('src/lib/i18n/messages/nav.ts');
  assert.match(msgs, /nicht geladen/);
  assert.match(msgs, /Noch keine Chats/);
  const picker = read('src/components/context/ContextPicker.tsx');
  assert.match(picker, /catalogState\(/);
  assert.doesNotMatch(picker, /setProducts\(\[\]\)/);
  assert.doesNotMatch(read('src/components/workspace/Workspace.tsx'), /setCategories\(\[\]\)/);
});
