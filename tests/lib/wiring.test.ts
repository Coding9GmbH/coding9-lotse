// Verdrahtung, die sich ohne Browser nur am Quelltext prüfen lässt (wie a11y/layout): Echtzeit-Verlauf, Sperre ohne Einrichtung,
// Shop-Check-Neuprüfung nach Änderungen und nach Rückgängig.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('neuer Chat erscheint sofort im Verlauf: Abruf beim start-Ereignis der Runde', () => {
  const ws = read('src/components/workspace/Workspace.tsx');
  assert.match(ws, /if \(event\.t === 'start'\) loadHistory\(\)/);
});

test('ohne Shop und KI: Eingabe, Neuer Chat, mit Kontext, Styleguide und Wissen gesperrt', () => {
  const ws = read('src/components/workspace/Workspace.tsx');
  assert.match(ws, /const locked = !shell\.healthFailed && !setupReady\(setup\)/, 'Ladefehler sperrt nicht');
  assert.match(ws, /disabled=\{locked\}/);
  assert.match(ws, /\|\| locked\) return;/, 'send() sendet nicht');
  const composer = read('src/components/chat/Composer.tsx');
  for (const el of ['textarea', 'attach', 'send']) assert.match(composer, new RegExp(`${el}[^>]*disabled=\\{disabled\\}|disabled=\\{disabled\\}[^>]*${el}`));
  const nav = read('src/components/shell/SideNav.tsx');
  assert.match(nav, /const ready = setupReady\(s\.setup\)/);
  assert.equal(nav.match(/disabled=\{!ready\}/g)?.length, 3, 'Neuer Chat, mit Kontext, Styleguide');
  assert.match(nav, /ready \? \(\s*<Link href="\/wissen"/, 'Wissen nur eingerichtet als Link');
});

test('Shop-Check prüft nach angewendeten Änderungen und nach Rückgängig neu', () => {
  assert.match(read('src/server/features/shopcheck.ts'), /onApplied\('shopcheck', \(\) => \{ void recheckShopCheck\(\); \}\)/);
  assert.match(read('src/app/api/changesets/undo/route.ts'), /if \(out\.results\.some\(r => r\.ok\)\) void recheckShopCheck\(\)/);
});

test('Einstellungen: kein Speichern-Knopf mehr, Speicherstand oben', () => {
  const view = read('src/components/settings/SettingsView.tsx');
  assert.doesNotMatch(view, />Speichern</);
  assert.doesNotMatch(view, /savebar/);
  assert.match(view, /<SaveState /);
  assert.doesNotMatch(read('src/components/settings/GscSettings.tsx'), />Speichern</);
});
