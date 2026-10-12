import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAttachments, attachmentMessage } from '../../src/lib/attachments';
import { ago } from '../../src/lib/format';
import { createLineSplitter } from '../../src/lib/ndjson';
import { liveSrc, shopProxyPath, withBust } from '../../src/lib/urls';

test('NDJSON: Zeilen über Chunk-Grenzen und Umlaute hinweg', () => {
  const lines: string[] = [];
  const sp = createLineSplitter(l => lines.push(l));
  const bytes = new TextEncoder().encode('{"t":"text","text":"Grüße"}\n{"t":"do');
  sp.push(bytes.slice(0, 22)); sp.push(bytes.slice(22));
  sp.push(new TextEncoder().encode('ne","error":null}'));
  sp.end();
  assert.deepEqual(lines.map(l => JSON.parse(l).t), ['text', 'done']);
  assert.equal(JSON.parse(lines[0]).text, 'Grüße');
});

test('Anhänge hin und zurück', () => {
  const msg = attachmentMessage('', [{ mediaId: 'staged:1', url: '/staged/1.png', name: 'Foto' }]);
  const p = parseAttachments(msg);
  assert.equal(p.text, 'Nutze diese Bilder passend in der Seite.');
  assert.deepEqual(p.attachments, [{ mediaId: 'staged:1', url: '/staged/1.png', name: 'Foto' }]);
});

test('URLs', () => {
  assert.equal(liveSrc({ kind: 'product', id: 'p' }, null), '/shop/detail/p');
  assert.equal(liveSrc({ kind: 'landing' }, null), null);
  assert.equal(shopProxyPath('https://x.de/a/b'), '/shop/a/b');
  assert.equal(withBust('/shop/x', 2), '/shop/x?t=2');
});

test('ago', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  assert.equal(ago('2026-01-01T11:59:50Z', now), 'gerade eben');
  assert.equal(ago('2026-01-01T11:30:00Z', now), 'vor 30 Min.');
  assert.equal(ago('2026-01-01T09:00:00Z', now), 'vor 3 Std.');
});

test('Kategoriebaum: Suche, Einklappen, Pfad', async () => {
  const { categoryRows, categoryPath } = await import('../../src/lib/categories');
  const cats = [
    { id: 'r', name: 'Katalog', parentId: null, active: true, type: 'page', cmsPage: null },
    { id: 'a', name: 'Herren', parentId: 'r', active: true, type: 'page', cmsPage: null },
    { id: 'b', name: 'Schuhe', parentId: 'a', active: true, type: 'page', cmsPage: 'X' },
    { id: 'c', name: 'Damen', parentId: 'r', active: false, type: 'page', cmsPage: null },
  ];
  assert.deepEqual(categoryRows(cats, '', new Set()).map(r => `${r.depth}${r.cat.id}`), ['0r', '1a', '2b', '1c']);
  assert.deepEqual(categoryRows(cats, '', new Set(['a'])).map(r => r.cat.id), ['r', 'a', 'c']);
  assert.deepEqual(categoryRows(cats, 'schu', new Set(['a'])).map(r => r.cat.id), ['r', 'a', 'b']);
  assert.equal(categoryPath(cats, cats[2]), 'Herren › Schuhe');
});

test('Anhänge: Datei-Marker, Sonderzeichen im Namen und eigener Text mit „[Anhang:“', () => {
  const names = ['Foto 1.png', 'Grüße.pdf', 'Preis [2026].xlsx', '100%.csv', 'a\nb.txt'];
  for (const name of names) {
    const atts = [{ mediaId: 'm1', url: '/staged/1.png', name }];
    const files = [{ fileId: 'f1', name, mime: 'application/pdf', size: 1234 }];
    const p = parseAttachments(attachmentMessage('Siehe [Anhang: alt] und Datei', atts, files));
    assert.equal(p.text, 'Siehe [Anhang: alt] und Datei', `Text ohne Reste bei „${name}“`);
    assert.deepEqual(p.attachments, atts, name);
    assert.deepEqual(p.files, files, name);
  }
  const onlyFile = parseAttachments(attachmentMessage('', [], [{ fileId: 'f2', name: 'liste.csv', mime: 'text/csv', size: 9 }]));
  assert.equal(onlyFile.text, 'Sieh dir die angehängten Dateien an.');
  assert.deepEqual(onlyFile.attachments, []);
  assert.equal(onlyFile.files[0].size, 9);
  // ältere Chats: Namen unkodiert im Marker
  const old = parseAttachments('Text\n\n[Anhang: mediaId=m1, url=/staged/a.png, name=Foto 1.png]\n[Datei: fileId=f1, typ=text/csv, bytes=3, name=Grüße 2.csv]');
  assert.equal(old.text, 'Text');
  assert.equal(old.attachments[0].name, 'Foto 1.png');
  assert.equal(old.files[0].name, 'Grüße 2.csv');
  assert.equal(parseAttachments('Nur Text').text, 'Nur Text');
});

test('Kategoriebaum: Zyklus und verwaiste Eltern erscheinen genau einmal, großer Baum startet eingeklappt', async () => {
  const { categoryRows, initialCollapsed, BIG_TREE } = await import('../../src/lib/categories');
  const row = (id: string, parentId: string | null) => ({ id, name: id, parentId, active: true, type: 'page', cmsPage: null });
  const cats = [row('a', 'b'), row('b', 'a'), row('k', 'nicht-da'), row('r', null), row('x', 'r')];
  const rows = categoryRows(cats, '', new Set());
  assert.deepEqual(rows.map(r => `${r.depth}${r.cat.id}`).sort(), ['0a', '0k', '0r', '1b', '1x'].sort());
  assert.deepEqual(categoryRows(cats, 'b', new Set()).map(r => r.cat.id), ['a', 'b']);
  assert.deepEqual([...initialCollapsed(cats)], [], 'kleiner Baum: alles offen');

  const big = [row('root', null)];
  for (let i = 0; i < BIG_TREE; i++) { big.push(row(`l1-${i}`, 'root')); big.push(row(`l2-${i}`, `l1-${i}`)); }
  big.push(row('l3', 'l2-0'));
  const folded = initialCollapsed(big);
  assert.ok(!folded.has('root') && folded.has('l1-0') && folded.has('l2-0') && !folded.has('l2-1'), 'Eltern ab Ebene 1 zu, Blätter nicht gelistet');
  const visible = categoryRows(big, '', folded);
  assert.equal(visible.length, 1 + BIG_TREE, 'Wurzel und erste Ebene sichtbar');
  assert.ok(visible.every(r => r.depth <= 1));
});
