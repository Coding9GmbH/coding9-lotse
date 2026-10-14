import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { announceAnswer, markKeySelects } from '../../src/lib/a11y';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const rule = (css: string, selector: string) => {
  const hit = css.match(new RegExp(`${selector}\\s*\\{[^}]*\\}`));
  assert.ok(hit, `rule missing: ${selector}`);
  return hit[0];
};

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function lum(r: number, g: number, b: number): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
/** White with alpha on a surface, then contrast against the surface. */
function contrastOn(hex: string, alpha: number, bg: [number, number, number]): number {
  const n = parseInt(hex.slice(1), 16);
  const fg: [number, number, number] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const mixed = fg.map((c, i) => c * alpha + bg[i] * (1 - alpha)) as [number, number, number];
  const a = lum(...mixed);
  const b = lum(...bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function contrast(fgHex: string, bgHex: string): number {
  return contrastOn(fgHex, 1, [parseInt(bgHex.slice(1, 3), 16), parseInt(bgHex.slice(3, 5), 16), parseInt(bgHex.slice(5, 7), 16)]);
}

test('announceAnswer only for a finished answer', () => {
  assert.equal(announceAnswer(false), null);
  assert.equal(announceAnswer(true), 'Lotse hat geantwortet');
});

test('markKeySelects selects with Enter or Space', () => {
  assert.equal(markKeySelects('Enter'), true);
  assert.equal(markKeySelects(' '), true);
  assert.equal(markKeySelects('Tab'), false);
  assert.equal(markKeySelects('Escape'), false);
});

test('collapsed navigation has the same name as the label', () => {
  const nav = read('src/components/shell/SideNav.tsx');
  for (const key of ['newChat', 'workspace', 'knowledge']) {
    assert.match(nav, new RegExp(`aria-label=\\{tip\\(t\\.${key}\\)\\}[^>]*>\\s*<Icon\\w+ size=\\{\\d+\\} /><span className=\\{styles\\.label\\}>\\{t\\.${key}\\}`));
  }
  assert.match(nav, /aria-label=\{t\.newChatWithContext\}/);
  assert.match(nav, /aria-label=\{tip\(s\.styleguide \? t\.styleguide : t\.styleguideSetup\)\}/);
  assert.match(nav, /aria-label=\{t\.settingsLabel\(st\.shop\.text, st\.ai\.text\)\}/);
  const msgs = read('src/lib/i18n/messages/nav.ts');
  assert.match(msgs, /newChatWithContext: 'Neuer Chat mit Kontext/);
  assert.match(msgs, /settingsLabel: \(shop: string, ai: string\) => `Einstellungen\. \$\{shop\}/);
});

test('annotate names the field and lets targets be selected by keyboard', () => {
  const pane = read('src/components/preview/PreviewPane.tsx');
  assert.match(pane, /aria-label=\{t\.whatDifferent\}/);
  assert.match(pane, /aria-label=\{t\.targets\}/);
  const msgs = read('src/lib/i18n/messages/preview.ts');
  assert.match(msgs, /whatDifferent: 'Was soll anders sein\?'/);
  assert.match(msgs, /targets: 'Elemente in der Vorschau'/);
  assert.match(pane, /markKeySelects/);
  const frame = read('src/lib/preview-frame.ts');
  assert.match(frame, /keydown/);
  assert.match(frame, /tabIndex/);
  assert.match(read('src/components/preview/annotator.ts'), /keydown/);
  assert.match(read('src/components/preview/annotator.ts'), /markKeySelects/);
});

test('home input keeps a visible border on focus', () => {
  const focus = rule(read('src/components/chat/Composer.module.css'), '\\.home textarea:focus');
  assert.doesNotMatch(focus, /border:\s*0/);
  assert.match(focus, /var\(--green\)/);
});

test('contrast: coral, row, error, secondary color, switch, links', () => {
  const dark: [number, number, number] = [0x2e, 0x2e, 0x38];
  assert.ok(contrastOn('#ffffff', 0x80 / 255, dark) >= 4.5);
  assert.ok(contrastOn('#ffffff', 0x7a / 255, dark) < 4.5);
  assert.match(read('src/components/shell/SideNav.module.css'), /--fg-3:\s*#ffffff80/i);
  assert.ok(contrast('#948876', '#ffffff') >= 3);
  assert.ok(contrast('#e9e2d6', '#ffffff') < 3);
  assert.ok(contrast('#cfc4b4', '#ffffff') < 3);
  const settings = read('src/components/settings/Settings.module.css');
  assert.match(rule(settings, '\\.switch'), /background:\s*#948876/);
  assert.doesNotMatch(rule(settings, '\\.switch'), /background:\s*var\(--line\)/);

  const button = read('src/components/ui/Button.module.css');
  assert.doesNotMatch(rule(button, '\\.primary:hover'), /coral-d|#e85a50/);
  assert.doesNotMatch(rule(read('src/components/shell/SideNav.module.css'), '\\.newChat:hover'), /coral-d|#e85a50/);
  assert.doesNotMatch(rule(read('src/components/chat/Home.module.css'), '\\.primaryLink:hover'), /coral-d|#e85a50/);

  const preview = read('src/components/preview/PreviewPane.module.css');
  for (const sel of ['\\.markOn', '\\.notes header span', '\\.notes li i']) {
    const block = rule(preview, sel);
    assert.match(block, /color:\s*(var\(--dark\)|#2e2e38)/);
    assert.doesNotMatch(block, /color:\s*#fff\b/);
  }
  assert.doesNotMatch(preview, /#b8860b|#e85a50|var\(--coral-d\)/);

  const row = rule(read('src/components/chat/ChangeSetCard.module.css'), '\\.off');
  assert.doesNotMatch(row, /opacity/);
  assert.match(row, /color:/);

  const globals = read('src/app/globals.css');
  const link = rule(globals, 'a');
  assert.match(link, /text-decoration:\s*underline/);
  assert.doesNotMatch(link, /text-decoration:\s*none/);
});

test('messages, finished answer, focus trap and comparison columns', () => {
  const msg = read('src/components/chat/Message.tsx');
  assert.match(msg, /visually-hidden">\{t\.chat\.message\.you\}</);
  assert.match(read('src/lib/i18n/messages/chat.ts'), /message: \{ you: 'Du' \}/);
  assert.match(msg, /visually-hidden">Lotse</);
  const log = read('src/components/chat/ChatLog.tsx');
  assert.match(log, /announceAnswer/);
  assert.match(log, /role="status"/);
  assert.doesNotMatch(log, /key=\{item\.text\}/);
  const card = read('src/components/chat/ChangeSetCard.tsx');
  assert.match(card, /role="region" aria-label=\{t\.before\}/);
  assert.match(card, /role="region" aria-label=\{t\.after\}/);
  assert.match(read('src/lib/i18n/messages/chat.ts'), /before: 'Vorher',\n\s*after: 'Nachher'/);
  assert.match(read('src/components/context/ContextPanel.tsx'), /inertExcept/);
  assert.match(read('src/components/shell/AppShell.tsx'), /inertExcept/);
  assert.match(read('src/components/shell/AppShell.tsx'), /focus\(\)/);
});
