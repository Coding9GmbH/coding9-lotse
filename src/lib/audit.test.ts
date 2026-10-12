import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupAudit, normalizeCheck, scoreClass } from './audit';
import type { AuditCheck, DraftAudit } from './protocol';

test('normalizeCheck versteht beide Prüfpunkt-Formate', () => {
  assert.deepEqual(normalizeCheck({ area: 'seo', w: 3, msg: 'Titel fehlt', ok: false, hint: 'Titel setzen' } as unknown as AuditCheck),
    { area: 'SEO', ok: false, important: true, text: 'Titel fehlt', hint: 'Titel setzen' });
  assert.deepEqual(normalizeCheck({ area: 'CRO', label: 'CTA vorhanden', weight: 1, level: 'wichtig', ok: true, hint: 'egal' } as unknown as AuditCheck),
    { area: 'CRO', ok: true, important: true, text: 'CTA vorhanden', hint: undefined });
  const other = normalizeCheck({ area: 'foo', label: 'x', weight: 2, ok: false } as unknown as AuditCheck);
  assert.equal(other.area, 'other');
  assert.equal(other.important, false);
  assert.equal(normalizeCheck({ area: 'ux', msg: 'y' } as unknown as unknown as AuditCheck).text, 'y');
  assert.equal(normalizeCheck({} as unknown as unknown as AuditCheck).ok, false);
});

test('groupAudit gruppiert nach Bereich in fester Reihenfolge und lässt leere Bereiche weg', () => {
  const a = { score: 70, warnings: [], stats: { words: 1, h1: 1, internalLinks: 0 }, checks: [
    { area: 'UX', label: 'u', weight: 1, ok: true }, { area: 'seo', msg: 's', w: 5, ok: false }, { area: '?', msg: 'o', ok: true },
  ] } as unknown as DraftAudit;
  const g = groupAudit(a);
  assert.deepEqual(g.map(x => x.area), ['SEO', 'UX', 'other']);
  assert.equal(g[0].rows[0].important, true);
  assert.deepEqual(groupAudit({ ...a, checks: undefined } as unknown as DraftAudit), []);
  assert.deepEqual([scoreClass(85), scoreClass(70), scoreClass(10)], ['hi', 'mid', 'lo']);
});
