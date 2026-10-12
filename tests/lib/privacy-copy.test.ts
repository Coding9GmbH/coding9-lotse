import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EGRESS_NOTICE, GSC_QUERY_NOTICE, chatDeleteQuestion } from '../../src/lib/privacy-copy';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

const CREDENTIALS = 'Zugangsdaten werden verschlüsselt lokal gespeichert und nie an die KI weitergegeben. Gespeicherte Schlüssel werden hier nicht angezeigt.';

test('Einstellungen nennen, was den Rechner verlässt', () => {
  assert.match(EGRESS_NOTICE, /Chat/);
  assert.match(EGRESS_NOTICE, /Produkttexte/);
  assert.match(EGRESS_NOTICE, /CMS-HTML/);
  assert.match(EGRESS_NOTICE, /GPSR/);
  assert.match(EGRESS_NOTICE, /Bild-Prompt/);
  assert.match(EGRESS_NOTICE, /Anthropic/);
  assert.match(EGRESS_NOTICE, /OpenAI/);
  assert.match(EGRESS_NOTICE, /Löschen in Lotse/);
  assert.match(EGRESS_NOTICE, /Kopie/);
  assert.doesNotMatch(EGRESS_NOTICE, /DSGVO-konform/);
  assert.doesNotMatch(EGRESS_NOTICE, /Zugangsdaten werden verschlüsselt/);
});

test('Suchbegriffe gehen an die KI und sind kein Zugangsdatum', () => {
  assert.match(GSC_QUERY_NOTICE, /Suchbegriffe/);
  assert.match(GSC_QUERY_NOTICE, /KI/);
  assert.doesNotMatch(GSC_QUERY_NOTICE, /Zugangsdatum|Kunden-Zugang|updatedAt/);
});

test('Chat-Löschen entfernt nur diesen Chat', () => {
  const q = chatDeleteQuestion('Sommeraktion');
  assert.match(q, /„Sommeraktion“ löschen\?/);
  assert.match(q, /Nur dieser Chat/);
  assert.match(q, /Audit/);
  assert.match(q, /Dateien/);
  assert.match(q, /Anthropic oder OpenAI/);
  assert.match(q, /bleiben/);
});

test('Oberfläche hängt die Sätze an die bestehenden Hinweise', () => {
  const settings = read('src/components/settings/SettingsView.tsx');
  assert.match(settings, new RegExp(CREDENTIALS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(settings, /EGRESS_NOTICE/);
  const gsc = read('src/components/settings/GscSettings.tsx');
  assert.match(gsc, /GSC_QUERY_NOTICE/);
  assert.match(gsc, /Lotse liest nur/);
  assert.match(gsc, /Schlüssel trennen\? Er lässt sich hier nicht wieder anzeigen\./);
  assert.doesNotMatch(gsc, /Zugangsdatum|Kunden-Zugang|updatedAt/);
  const nav = read('src/components/shell/SideNav.tsx');
  assert.match(nav, /chatDeleteQuestion\(/);
});
