import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterHistory, historyContexts, setupReady } from '../../src/lib/nav';
import type { Target } from '../../src/lib/protocol';

const chat = (title: string, name?: string) => ({ title, target: name ? ({ kind: 'category', id: name, name } as Target) : null });

test('setupReady: gesperrt nur, wenn Shop oder KI sicher fehlen', () => {
  assert.equal(setupReady({ shopware: true, ai: true }), true);
  assert.equal(setupReady({ shopware: true, ai: false }), false);
  assert.equal(setupReady({ shopware: false, ai: true }), false);
  assert.equal(setupReady({ shopware: false, ai: false }), false);
  assert.equal(setupReady(null), true, 'Stand unbekannt: nicht sperren');
  assert.equal(setupReady(undefined), true);
});

test('historyContexts: verschiedene Kontexte, neueste zuerst, erst ab zwei', () => {
  const chats = [chat('a', 'Keramik'), chat('b'), chat('c', 'Wohnaccessoires'), chat('d', 'Keramik')];
  assert.deepEqual(historyContexts(chats), ['Keramik', 'Wohnaccessoires']);
  assert.deepEqual(historyContexts([chat('a', 'Keramik'), chat('b', 'Keramik'), chat('c')]), [], 'nur ein Kontext: kein Filter');
  assert.deepEqual(historyContexts([]), []);
  const many = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map(n => chat(n, n));
  assert.deepEqual(historyContexts(many), ['A', 'B', 'C', 'D', 'E', 'F'], 'höchstens 6');
  assert.deepEqual(historyContexts(many, 3), ['A', 'B', 'C']);
});

test('filterHistory: Kontext exakt, Suchbegriff in Titel oder Kontext, beides kombiniert', () => {
  const chats = [chat('Meta-Descriptions ergänzen', 'Keramik'), chat('Preise senken', 'Wohnaccessoires'), chat('FAQ für alle Produkte')];
  assert.equal(filterHistory(chats, '', null).length, 3);
  assert.deepEqual(filterHistory(chats, '', 'Keramik').map(c => c.title), ['Meta-Descriptions ergänzen']);
  assert.deepEqual(filterHistory(chats, '  PREISE ', null).map(c => c.title), ['Preise senken'], 'ohne Groß-/Kleinschreibung, getrimmt');
  assert.deepEqual(filterHistory(chats, 'wohnacc', null).map(c => c.title), ['Preise senken'], 'auch im Kontextnamen');
  assert.deepEqual(filterHistory(chats, 'preise', 'Keramik'), [], 'Kontext und Suche zusammen');
  assert.deepEqual(filterHistory(chats, '', 'Gibt es nicht'), []);
});
