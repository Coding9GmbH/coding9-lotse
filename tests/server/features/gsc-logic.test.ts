import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, aggregate, cannibalization, compareEffect, contentGaps, ctrZ, declines, expectedCtr, measureWindow, opportunities, pathRegex, range, relevance, strikingDistance } from '../../../src/server/features/gsc-logic';

const row = (keys: string[], clicks: number, impressions: number, position: number) => ({ keys, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });

test('range: ends 3 days before today, length inclusive', () => {
  const r = range(28, new Date('2026-10-10T12:00:00Z'));
  assert.deepEqual(r, { startDate: '2026-09-10', endDate: '2026-10-07', days: 28 });
  assert.equal(range(7, new Date(), '2026-01-07', '2026-01-01').days, 7);
  assert.throws(() => range(7, new Date(), '2026-01-01', '2026-01-05'), /nach endDate/);
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
});

test('expectedCtr: falls with position, interpolated, never negative', () => {
  assert.equal(expectedCtr(1), 0.28);
  assert.ok(Math.abs(expectedCtr(1.5) - 0.215) < 1e-9);
  assert.ok(expectedCtr(3) > expectedCtr(8) && expectedCtr(8) > expectedCtr(15) && expectedCtr(15) > expectedCtr(40));
  assert.ok(expectedCtr(0.5) === 0.28 && expectedCtr(100) > 0);
});

test('aggregate: position weighted by impressions, CTR recalculated', () => {
  const m = aggregate([row(['a'], 10, 100, 2), row(['b'], 0, 300, 10)]);
  assert.equal(m.clicks, 10); assert.equal(m.impressions, 400); assert.equal(m.ctr, 0.025); assert.equal(m.position, 8);
  assert.deepEqual(aggregate([]), { clicks: 0, impressions: 0, ctr: 0, position: 0 });
});

test('opportunities: only enough impressions, position ≤ 20, CTR well below expectation; sorted by potential', () => {
  const rows = [
    row(['https://s.de/gut'], 280, 1000, 1),        // CTR as expected
    row(['https://s.de/schwach'], 10, 2000, 2),     // 0.5 % instead of ~15 %
    row(['https://s.de/klein'], 0, 60, 2),          // too few impressions
    row(['https://s.de/hinten'], 0, 5000, 35),      // position too far back
    row(['https://s.de/mittel'], 5, 1000, 5),       // 0.5 % instead of 5 %
  ];
  const o = opportunities(rows);
  assert.deepEqual(o.map(x => x.page), ['https://s.de/schwach', 'https://s.de/mittel']);
  assert.equal(o[0].potentialClicks, Math.round(2000 * (0.15 - 0.005)));
  assert.equal(opportunities(rows, { minImpressions: 50 }).length, 3);
});

test('relevance: search words in the URL path, umlauts and word stem', () => {
  assert.equal(relevance('vase steinzeug', 'https://s.de/vase-kiesel-steinzeug-22-cm'), 1);
  assert.equal(relevance('vasen kaufen', 'https://s.de/wohnen/vase-kiesel'), 1);   // "kaufen" is a filler word, "vasen" ~ "vase"
  assert.equal(relevance('Kuscheldecke grün', 'https://s.de/kuscheldecke-gruen'), 1);
  assert.equal(relevance('kaffeebecher', 'https://s.de/plaid-wolle'), 0);
});

test('contentGaps: no page on page 1 or unsuitable best page; enough impressions', () => {
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

test('measureWindow: too early, preliminary from 14 days of data, complete after baseline length + delay', () => {
  const b = { changedAt: '2026-09-01T10:00:00Z', before: { days: 28 } } as Parameters<typeof measureWindow>[0];
  const early = measureWindow(b, new Date('2026-09-10T00:00:00Z'));
  assert.equal(early.status, 'zu früh'); assert.equal(early.measurableFrom, '2026-09-18'); assert.equal(early.completeFrom, '2026-10-02');
  const pre = measureWindow(b, new Date('2026-09-18T00:00:00Z'));
  assert.equal(pre.status, 'vorläufig'); assert.equal(pre.startDate, '2026-09-02'); assert.equal(pre.days, 14);
  const full = measureWindow(b, new Date('2026-10-20T00:00:00Z'));
  assert.equal(full.status, 'vollständig'); assert.equal(full.endDate, '2026-09-29'); assert.equal(full.days, 28);
});

test('compareEffect: significant increase, noise and too little data are named honestly', () => {
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

test('pathRegex: exact path, any host, special characters escaped', () => {
  const re = new RegExp(pathRegex(['/vase-kiesel-steinzeug-22-cm', 'detail/abc', 'wohnen/vasen+deko/']));
  assert.ok(re.test('https://www.shop.de/vase-kiesel-steinzeug-22-cm'));
  assert.ok(re.test('http://localhost:8888/wohnen/vasen+deko/'));
  assert.ok(!re.test('https://shop.de/vase-kiesel-steinzeug-22-cm-xl'));
  assert.ok(!re.test('https://shop.de/en/detail/abc/x'));
});

test('pathRegex: umlauts and spaces match the percent-encoded Search Console URL and the raw form', () => {
  const re = new RegExp(pathRegex(['küche/vase-kiesel', 'en/Wohnen Deko/']));
  assert.ok(re.test('https://shop.de/k%C3%BCche/vase-kiesel'));
  assert.ok(re.test('https://shop.de/küche/vase-kiesel'));
  assert.ok(re.test('https://shop.de/en/Wohnen%20Deko/'));
  assert.ok(!re.test('https://shop.de/k%C3%BCche/vase-kiesel/2'));
});

test('just short of page 1: queries at positions 4 to 15 grouped per page, sorted by potential', () => {
  const S = 'https://shop.de/vasen/', P = 'https://shop.de/becher';
  const rows = [
    row(['vasen steinzeug', S], 6, 400, 6.2), row(['vase gross', S + '?p=2'], 2, 120, 9), // parameter counts as the same page
    row(['becher', P], 3, 300, 12), row(['becher set', P], 40, 500, 2.1), // position 2: already at the top, no candidate
    row(['vasen', S], 1, 30, 7), // too little demand
    row(['tasse', P], 0, 900, 25), // too far back
  ];
  const s = strikingDistance(rows);
  assert.deepEqual(s.map(x => x.page), [S, P]);
  assert.deepEqual(s[0].queries.map(q => q.query), ['vasen steinzeug', 'vase gross']);
  assert.equal(s[0].potentialClicks, Math.round(400 * (expectedCtr(3) - 6 / 400)) + Math.round(120 * (expectedCtr(3) - 2 / 120)));
});

test('cannibalization: two own pages share a query, none ranks at the top', () => {
  const C = 'https://shop.de/vasen/', P = 'https://shop.de/vase-kiesel';
  const split = [row(['vase steinzeug', C], 4, 300, 8), row(['vase steinzeug', P], 3, 200, 11), row(['vase steinzeug', 'https://shop.de/blog'], 0, 20, 40)];
  const c = cannibalization(split);
  assert.equal(c.length, 1); assert.deepEqual(c[0].pages.map(p => p.page), [C, P], 'small shares and far back don\'t count');
  assert.equal(c[0].pages[0].share, 0.58);
  assert.equal(cannibalization([row(['vase', C], 90, 400, 2), row(['vase', P], 2, 200, 9)]).length, 0, 'one page clearly at the top: no problem');
  assert.equal(cannibalization([row(['vase', C], 5, 300, 8), row(['vase', C + '?sort=price'], 2, 200, 9)]).length, 0, 'parameter variants are the same page');
  assert.equal(cannibalization([row(['x', C], 1, 40, 8), row(['x', P], 1, 40, 9)]).length, 0, 'too few impressions');
});

test('declines: clearly fewer clicks, more than the whole shop', () => {
  const A = 'https://shop.de/a', B = 'https://shop.de/b', C = 'https://shop.de/c';
  const before = [row([A], 100, 2000, 3), row([B], 100, 2000, 3), row([C], 15, 300, 5)];
  const after = [row([A], 40, 1800, 6), row([B], 85, 2000, 3), row([C], 2, 300, 9)];
  const d = declines(before, after);
  assert.deepEqual(d.map(x => x.page), [A], 'B: small decline; C: too few clicks before');
  assert.equal(d[0].change, -0.6);
  // whole shop drops just as much (season): no single page stands out
  assert.equal(declines([row([A], 100, 1, 3), row([B], 100, 1, 3)], [row([A], 45, 1, 3), row([B], 40, 1, 3)]).length, 0);
  assert.equal(declines(before, []).length, 2, 'page with no clicks at all afterwards counts as a decline');
});
