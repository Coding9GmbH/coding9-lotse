import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, aggregate, compareEffect, contentGaps, ctrZ, expectedCtr, measureWindow, opportunities, pathRegex, range, relevance } from './gsc-logic';

const row = (keys: string[], clicks: number, impressions: number, position: number) => ({ keys, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });

test('range: endet 3 Tage vor heute, Länge inklusive', () => {
  const r = range(28, new Date('2026-10-10T12:00:00Z'));
  assert.deepEqual(r, { startDate: '2026-09-10', endDate: '2026-10-07', days: 28 });
  assert.equal(range(7, new Date(), '2026-01-07', '2026-01-01').days, 7);
  assert.throws(() => range(7, new Date(), '2026-01-01', '2026-01-05'), /nach endDate/);
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
});

test('expectedCtr: fällt mit der Position, interpoliert, nie negativ', () => {
  assert.equal(expectedCtr(1), 0.28);
  assert.ok(Math.abs(expectedCtr(1.5) - 0.215) < 1e-9);
  assert.ok(expectedCtr(3) > expectedCtr(8) && expectedCtr(8) > expectedCtr(15) && expectedCtr(15) > expectedCtr(40));
  assert.ok(expectedCtr(0.5) === 0.28 && expectedCtr(100) > 0);
});

test('aggregate: Position nach Impressionen gewichtet, CTR neu berechnet', () => {
  const m = aggregate([row(['a'], 10, 100, 2), row(['b'], 0, 300, 10)]);
  assert.equal(m.clicks, 10); assert.equal(m.impressions, 400); assert.equal(m.ctr, 0.025); assert.equal(m.position, 8);
  assert.deepEqual(aggregate([]), { clicks: 0, impressions: 0, ctr: 0, position: 0 });
});

test('opportunities: nur genug Impressionen, Position ≤ 20, CTR deutlich unter Erwartung; nach Potenzial sortiert', () => {
  const rows = [
    row(['https://s.de/gut'], 280, 1000, 1),        // CTR wie erwartet
    row(['https://s.de/schwach'], 10, 2000, 2),     // 0,5 % statt ~15 %
    row(['https://s.de/klein'], 0, 60, 2),          // zu wenig Impressionen
    row(['https://s.de/hinten'], 0, 5000, 35),      // Position zu weit hinten
    row(['https://s.de/mittel'], 5, 1000, 5),       // 0,5 % statt 5 %
  ];
  const o = opportunities(rows);
  assert.deepEqual(o.map(x => x.page), ['https://s.de/schwach', 'https://s.de/mittel']);
  assert.equal(o[0].potentialClicks, Math.round(2000 * (0.15 - 0.005)));
  assert.equal(opportunities(rows, { minImpressions: 50 }).length, 3);
});

test('relevance: Suchwörter im URL-Pfad, Umlaute und Wortstamm', () => {
  assert.equal(relevance('vase steinzeug', 'https://s.de/vase-kiesel-steinzeug-22-cm'), 1);
  assert.equal(relevance('vasen kaufen', 'https://s.de/wohnen/vase-kiesel'), 1);   // „kaufen“ ist Füllwort, „vasen“ ~ „vase“
  assert.equal(relevance('Kuscheldecke grün', 'https://s.de/kuscheldecke-gruen'), 1);
  assert.equal(relevance('kaffeebecher', 'https://s.de/plaid-wolle'), 0);
});

test('contentGaps: keine Seite auf Seite 1 oder unpassende beste Seite; genug Impressionen', () => {
  const rows = [
    row(['wolldecke', 'https://s.de/plaid-wolle'], 1, 400, 14),
    row(['wolldecke', 'https://s.de/wohnaccessoires/'], 0, 100, 25),
    row(['kaffeebecher steinzeug', 'https://s.de/vase-kiesel'], 2, 300, 6),
    row(['vase kiesel', 'https://s.de/vase-kiesel'], 40, 500, 2),
    row(['selten', 'https://s.de/x'], 0, 10, 30),
  ];
  const g = contentGaps(rows);
  assert.deepEqual(g.map(x => [x.query, x.reason]), [['wolldecke', 'keine Seite auf Seite 1'], ['kaffeebecher steinzeug', 'beste Seite passt nicht']]);
  assert.equal(g[0].impressions, 500); assert.equal(g[0].pages, 2); assert.equal(g[0].bestPage, 'https://s.de/plaid-wolle');
});

test('measureWindow: zu früh, vorläufig ab 14 Tagen Daten, vollständig nach Basislänge + Verzögerung', () => {
  const b = { changedAt: '2026-09-01T10:00:00Z', before: { days: 28 } } as Parameters<typeof measureWindow>[0];
  const early = measureWindow(b, new Date('2026-09-10T00:00:00Z'));
  assert.equal(early.status, 'zu früh'); assert.equal(early.measurableFrom, '2026-09-18'); assert.equal(early.completeFrom, '2026-10-02');
  const pre = measureWindow(b, new Date('2026-09-18T00:00:00Z'));
  assert.equal(pre.status, 'vorläufig'); assert.equal(pre.startDate, '2026-09-02'); assert.equal(pre.days, 14);
  const full = measureWindow(b, new Date('2026-10-20T00:00:00Z'));
  assert.equal(full.status, 'vollständig'); assert.equal(full.endDate, '2026-09-29'); assert.equal(full.days, 28);
});

test('compareEffect: signifikanter Anstieg, Rauschen und zu wenig Daten werden ehrlich benannt', () => {
  const before = { clicks: 20, impressions: 2000, ctr: 0.01, position: 4, days: 28 };
  const up = compareEffect(before, { clicks: 60, impressions: 2000, ctr: 0.03, position: 4, days: 28 });
  assert.equal(up.verdict, 'verbessert'); assert.ok(up.zScore > 1.96); assert.equal(up.change.clicksPerDay, '+200 %');
  const noise = compareEffect(before, { clicks: 23, impressions: 2000, ctr: 0.0115, position: 4, days: 28 });
  assert.equal(noise.verdict, 'kein klarer Effekt');
  const tiny = compareEffect({ clicks: 1, impressions: 40, ctr: 0.025, position: 3, days: 28 }, { clicks: 4, impressions: 50, ctr: 0.08, position: 3, days: 28 });
  assert.equal(tiny.verdict, 'zu wenig Daten');
  const season = compareEffect(before, { clicks: 30, impressions: 3000, ctr: 0.01, position: 2, days: 14 }, { before: { clicks: 100, impressions: 10000, ctr: 0.01, position: 8, days: 28 }, after: { clicks: 100, impressions: 10000, ctr: 0.01, position: 8, days: 14 } });
  assert.equal(season.change.shopImpressionsPerDay, '+100 %');
  assert.ok(season.notes.some(n => /ganze Shop/.test(n)) && season.notes.some(n => /Position/.test(n)));
  assert.equal(ctrZ(0, 0, 1, 1), 0);
});

test('pathRegex: exakter Pfad, beliebiger Host, Sonderzeichen maskiert', () => {
  const re = new RegExp(pathRegex(['/vase-kiesel-steinzeug-22-cm', 'detail/abc', 'wohnen/vasen+deko/']));
  assert.ok(re.test('https://www.shop.de/vase-kiesel-steinzeug-22-cm'));
  assert.ok(re.test('http://localhost:8888/wohnen/vasen+deko/'));
  assert.ok(!re.test('https://shop.de/vase-kiesel-steinzeug-22-cm-xl'));
  assert.ok(!re.test('https://shop.de/en/detail/abc/x'));
});

test('pathRegex: Umlaute und Leerzeichen treffen die percent-kodierte URL der Search Console und die rohe Form', () => {
  const re = new RegExp(pathRegex(['küche/vase-kiesel', 'en/Wohnen Deko/']));
  assert.ok(re.test('https://shop.de/k%C3%BCche/vase-kiesel'));
  assert.ok(re.test('https://shop.de/küche/vase-kiesel'));
  assert.ok(re.test('https://shop.de/en/Wohnen%20Deko/'));
  assert.ok(!re.test('https://shop.de/k%C3%BCche/vase-kiesel/2'));
});
