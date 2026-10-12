import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { applyHint, undoPlannedFor } from '../../src/lib/apply-hint';
import { approveError } from '../../src/lib/approve-error';
import { PLATFORM_SETTINGS, scopeDisplay } from '../../src/lib/platforms';
import { isShopLoginFailure, shopLoginMessage } from '../../src/lib/shop-login';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('applyHint sagt bei jedem offenen Set, dass der Klick in den Shop schreibt', () => {
  const rows = applyHint({ selectable: true, undoPlanned: true });
  const bare = applyHint({ selectable: false, undoPlanned: false });
  assert.match(rows, /Der Klick schreibt die ausgewählten Zeilen in den verbundenen Shop/);
  assert.match(rows, /Rückgängig stellt die geschriebenen Zeilen auf die vorherigen Werte/);
  assert.match(bare, /Der Klick schreibt/);
  assert.match(bare, /verbundenen Shop/);
  assert.match(bare, /Rückgängig gibt es nur, wenn der Shop die vorherigen Werte zurückgibt/);
  assert.doesNotMatch(rows + bare, /steht nach dem Schreiben an der Karte/);
});

test('undoPlanned: Zeilen, die keine reinen Hinweise sind, lassen sich auf vorherige Werte stellen', () => {
  assert.equal(undoPlannedFor({ items: [{ entity: 'product' }] }), true);
  assert.equal(undoPlannedFor({ items: [{ entity: 'info' }] }), false);
  assert.equal(undoPlannedFor({ items: [] }), false);
});

test('approveError: 404 nach schon angenommener Freigabe ist kein Fehler', () => {
  assert.equal(approveError(404, true), null);
  assert.equal(approveError(404, false), 'Diese Freigabe gibt es nicht mehr.');
  assert.match(approveError(500, true) ?? '', /Freigabe konnte nicht gesendet werden/);
  assert.match(approveError(400, false) ?? '', /Freigabe konnte nicht gesendet werden/);
});

test('shopLoginMessage ist ein fester deutscher Satz ohne Rohbody', () => {
  const body = '{"error":"invalid_grant","raw":"Shop-Geheimnis-XYZ"}';
  const msg = shopLoginMessage(401, body);
  assert.equal(msg, shopLoginMessage(500, 'andere antwort'));
  assert.match(msg, /Zugang abgelehnt/);
  assert.doesNotMatch(msg, /Shop-Geheimnis-XYZ|invalid_grant|\{/);
  assert.equal(isShopLoginFailure('Shopware-Login fehlgeschlagen (401): ' + body), true);
  assert.equal(isShopLoginFailure('Shop nicht erreichbar'), false);
});

test('Shopify- und OpenMage-Hilfe: ein Satz, keine Shell, keine Scope-Liste', () => {
  const shopify = PLATFORM_SETTINGS.shopify.auth.map(a => a.hint ?? '').join('\n');
  const openmage = PLATFORM_SETTINGS.openmage.auth.map(a => a.hint ?? '').join('\n');
  for (const hint of [shopify, openmage]) {
    assert.doesNotMatch(hint, /php shell\/lotse\.php/);
    assert.doesNotMatch(hint, /read_|write_|Kunden- oder Bestellrechte/);
    assert.match(hint, /Kopiere/);
  }
  assert.doesNotMatch(shopify, /Client-Secret aus den Einstellungen[\s\S]*und[\s\S]*Berechtigungen/);
});

test('Bereichsnamen hängen an der Plattform, nicht an Einkaufswelten für jeden Shop', () => {
  const sw = scopeDisplay('shopware', 'cms', { label: 'Einkaufswelten-Layouts', hint: 'Seiten' });
  const sy = scopeDisplay('shopify', 'cms', { label: 'Einkaufswelten-Layouts', hint: 'Produktstreams' });
  const mg = scopeDisplay('magento', 'cms', { label: 'Einkaufswelten-Layouts', hint: 'Verkaufskanäle' });
  const om = scopeDisplay('openmage', 'shop', { label: 'Shop-Grunddaten', hint: 'Verkaufskanäle & Domains' });
  assert.equal(sw.label, 'Einkaufswelten-Layouts');
  assert.doesNotMatch(sy.label, /Einkaufswelten/);
  assert.doesNotMatch(mg.label, /Einkaufswelten/);
  assert.doesNotMatch(sy.hint + mg.hint + om.hint, /Produktstreams|Verkaufskanäle/);
  assert.match(sy.label, /Seiten/);
});

test('Oberfläche: Klick-Texte und keine Roh-JSON-Ansicht', () => {
  const card = read('src/components/chat/ChangeSetCard.tsx');
  assert.match(card, /applyHint\(/);
  assert.doesNotMatch(card, /Es wird erst nach deiner Freigabe geschrieben/);
  assert.match(card, /armed|pendingClick|clickLocked/);
  const shop = read('src/components/chat/ShopCheck.tsx');
  assert.match(shop, /Als Auftrag ins Feld/);
  assert.doesNotMatch(shop, />Beheben</);
  const ws = read('src/components/workspace/Workspace.tsx');
  assert.doesNotMatch(ws, /onPick=\{s => send\(s\)\}/);
  assert.match(ws, /approveError\(/);
  assert.match(read('src/app/api/approve/route.ts'), /Diese Freigabe gibt es nicht mehr/);
  assert.doesNotMatch(read('src/app/api/approve/route.ts'), /unknown approval/);
  assert.match(read('src/app/api/settings/test/route.ts'), /shopLoginMessage\(/);
  const gsc = read('src/components/settings/GscSettings.tsx');
  assert.match(gsc, /Schlüssel trennen\? Er lässt sich hier nicht wieder anzeigen\./);
  const know = read('src/components/knowledge/KnowledgeView.tsx');
  assert.match(know, /Löschen\?/);
  assert.doesNotMatch(know, /onClick=\{\(\) => setLinks\(doc\.links\.filter/);
  assert.match(read('src/components/chat/TargetCard.tsx'), /Im Shop ansehen/);
  assert.doesNotMatch(read('src/components/preview/PreviewPane.tsx'), /label: 'JSON'/);
  assert.doesNotMatch(read('src/components/chat/Steps.tsx'), /JSON\.stringify/);
  assert.match(read('src/components/settings/SettingsView.tsx'), /ChatGPT-Abo/);
  assert.doesNotMatch(read('src/components/settings/SettingsView.tsx'), /ChatGPT-Abo \(Codex\)/);
});
