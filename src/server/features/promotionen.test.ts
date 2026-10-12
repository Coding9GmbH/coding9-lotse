import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDay, fmtPeriod, discountText, codeText, limitText, validatePattern, patternCapacity, generateCodes, ruleEntity, ruleRestriction,
  validateDiscount, discountEntity, discountSnapshot, statusFilter, promotionStatus, promotionEntity, buildPromotionChangeSet, buildStatusChangeSet,
  draftWarning, activeText, overlapText, ruleSnapshot, ruleDescription, promotionRulesDelete,
  type CreatePayload, type UpdatePart,
} from './promotionen';
import type { ShopReader, Shopware, SwEntity } from '../shopware';
import { applyChangeSet, undoOps } from '../changes';
import type { UndoOp } from '@/lib/protocol';

const NOW = new Date('2026-09-15T10:00:00Z');
const seq = () => { let n = 0; return () => `id${++n}`; };
/** Karten-Texte ohne lange Gedankenstriche (Repo-Regel, wie shopcheck-rules.test) */
export const noDashes = (cs: { items: { label: string; after: string; warn: string[] }[] }) => { for (const i of cs.items) for (const t of [i.label, i.after, ...i.warn]) assert.doesNotMatch(t, /[–—]/, t); };

/** Fake-Leser: liefert Datensätze je Entität, filtert ids und einfache equals-Filter */
function fakeReader(db: Record<string, SwEntity[]>): ShopReader {
  const search = async (entity: string, c: Record<string, unknown> = {}) => {
    let rows = db[entity] ?? [];
    if (Array.isArray(c.ids)) rows = rows.filter(r => (c.ids as string[]).includes(r.id));
    for (const f of (c.filter as { type: string; field: string; value: unknown }[] | undefined) ?? []) if (f.type === 'equals' && f.field !== 'active' && f.field !== 'payload') rows = rows.filter(r => r[f.field] === f.value);
    return { data: rows, total: rows.length };
  };
  return { base: 'http://shop', search, get: async (e, id) => (await search(e, { ids: [id] })).data[0] ?? null, salesChannels: async () => db['sales-channel'] ?? [], req: async () => null };
}
const baseDb = () => ({
  'sales-channel': [{ id: 'sf', name: 'Storefront', domains: [{ url: 'http://shop' }] }, { id: 'api', name: 'Headless', domains: [] }],
  category: [{ id: 'cat', name: 'Wohnaccessoires' }],
  product: [{ id: 'vase', name: 'Vase', productNumber: 'HH-VASE-22' }],
  promotion: [] as SwEntity[], 'promotion-individual-code': [] as SwEntity[],
});

test('parseDay: Tagesbeginn/-ende in deutscher Zeit (Sommer- und Winterzeit)', () => {
  assert.equal(parseDay('2026-10-01'), '2026-09-30T22:00:00.000Z');
  assert.equal(parseDay('2026-10-31', true), '2026-10-31T22:59:59.000Z');
  assert.equal(parseDay('2026-01-15', true), '2026-01-15T22:59:59.000Z');
  assert.equal(parseDay('2026-10-01T08:00:00Z'), '2026-10-01T08:00:00.000Z');
  assert.throws(() => parseDay('2026-02-30'), /Ungültiges Datum/);
  assert.throws(() => parseDay('1.10.2026'), /JJJJ-MM-TT/);
});

test('fmtPeriod: kompakt im selben Jahr, offene Enden benannt', () => {
  assert.equal(fmtPeriod(parseDay('2026-10-01'), parseDay('2026-10-31', true)), '01.10. bis 31.10.2026');
  assert.equal(fmtPeriod(parseDay('2026-12-20'), parseDay('2027-01-06', true)), '20.12.2026 bis 06.01.2027');
  assert.equal(fmtPeriod(null, parseDay('2026-10-31', true)), 'bis 31.10.2026');
  assert.equal(fmtPeriod(parseDay('2026-10-01'), null), 'ab 01.10.2026, ohne Enddatum');
  assert.equal(fmtPeriod(null, null), 'unbefristet');
});

test('Texte: Rabatt, Code, Limits', () => {
  assert.equal(discountText({ scope: 'cart', type: 'percentage', value: 20, target: 'Wohnaccessoires' }), '20 % auf Wohnaccessoires');
  assert.equal(discountText({ scope: 'cart', type: 'percentage', value: 15, maxValue: 30 }), '15 % auf den Warenkorb (max. 30,00 €)');
  assert.equal(discountText({ scope: 'cart', type: 'absolute', value: 5 }), '5,00 € Rabatt auf den Warenkorb');
  assert.equal(discountText({ scope: 'cart', type: 'fixed_unit', value: 9.9, target: 'Vase' }), 'Stückpreis 9,90 € auf Vase');
  assert.equal(discountText({ scope: 'delivery', type: 'percentage', value: 100 }), 'Versandkostenfrei');
  assert.equal(discountText({ scope: 'setgroup-1', type: 'percentage', value: 10 }), '10 % auf Set-Gruppen');
  assert.equal(codeText({ mode: 'none' }), 'automatisch (ohne Code)');
  assert.equal(codeText({ mode: 'fixed', code: 'HERBST20' }), 'Code HERBST20');
  assert.equal(codeText({ mode: 'individual', pattern: 'H-%s%d', count: 10 }, 'H-A1'), '10 Einzelcodes nach Muster H-%s%d (z. B. H-A1)');
  assert.equal(limitText(null, 1), 'max. 1× pro Kunde');
  assert.equal(limitText(500, 2), 'max. 2× pro Kunde, insgesamt max. 500×');
  assert.equal(limitText(null, null), 'ohne Einlöse-Limit');
});

test('Einzelcodes: Muster prüfen und eindeutig erzeugen', () => {
  assert.equal(patternCapacity('HERBST-%s%s%d%d'), 26 * 26 * 100);
  assert.doesNotThrow(() => validatePattern('HERBST-%s%s%d%d', 1000));
  assert.throws(() => validatePattern('HERBST-%s', 100), /reicht nicht/);
  assert.throws(() => validatePattern('HERBST', 1), /Platzhalter/);
  assert.throws(() => validatePattern('HER BST-%s', 1), /nur Buchstaben/);
  assert.throws(() => validatePattern('H-%x%s', 1), /nur Buchstaben/);
  assert.throws(() => validatePattern('H-%s%s%s%s', 0), /Anzahl/);
  let i = 0; const rand = () => [0, 0, 0.5, 0.95][i++ % 4];
  assert.deepEqual(generateCodes('h-%s%d', 1, new Set(['H-A0']), rand), ['H-N9'], 'vergebene Codes werden übersprungen');
  assert.throws(() => generateCodes('h-%s', 2, new Set(), () => 0), /Nicht genug freie Codes/);
  assert.equal(new Set(generateCodes('X-%s%s%d%d', 300)).size, 300);
  for (const c of generateCodes('X-%s%d', 5)) assert.match(c, /^X-[A-Z]\d$/);
});

test('Regel: Aufbau wie im Admin und Rücklesen der Einschränkung', () => {
  const r = ruleEntity({ id: 'r1', name: 'Lotse: Herbst – Wohnaccessoires', productIds: ['p1'], categoryIds: ['c1'], promotionId: 'promo1' }, seq());
  assert.equal(r.description, ruleDescription('promo1')); assert.match(r.description, /promo1/);
  assert.equal(r.conditions.length, 1);
  assert.equal(r.conditions[0].type, 'orContainer');
  assert.deepEqual(r.conditions[0].children.map(c => c.children[0].type), ['cartLineItem', 'cartLineItemInCategory']);
  assert.deepEqual(r.conditions[0].children[1].children[0].value, { operator: '=', categoryIds: ['c1'] });
  const flat = [r.conditions[0], ...r.conditions[0].children, ...r.conditions[0].children.map(c => c.children[0])];
  assert.deepEqual(ruleRestriction([{ name: r.name, conditions: flat }]), { productIds: ['p1'], categoryIds: ['c1'], other: [] });
  assert.deepEqual(ruleRestriction([{ name: 'Kunden', conditions: [{ type: 'customerCustomerGroup' }] }]).other, ['customerCustomerGroup', 'Regel „Kunden“']);
});

test('Rabatt: Prüfung, Warnungen und Entität', () => {
  assert.deepEqual(validateDiscount({ type: 'percentage', value: 60 }), ['Rabatt über 50 % (60 %)', 'Ohne Höchstbetrag']);
  assert.deepEqual(validateDiscount({ type: 'percentage', value: 20 }), []);
  assert.throws(() => validateDiscount({ type: 'percentage', value: 120 }), /höchstens 100/);
  assert.throws(() => validateDiscount({ type: 'absolute', value: 0 }), /über 0/);
  assert.throws(() => validateDiscount({ type: 'absolute', value: 5, maxValue: 10 }), /nur bei Prozent/);
  assert.throws(() => validateDiscount({ scope: 'delivery', type: 'percentage', value: 10, categoryIds: ['c'] }), /Versand-Rabatt/);
  const e = discountEntity({ id: 'd1', scope: 'cart', type: 'percentage', value: 20, maxValue: null, ruleId: 'r1' }, 'p1');
  assert.equal(e.considerAdvancedRules, true); assert.deepEqual(e.discountRules, [{ id: 'r1' }]);
  assert.equal(e.sorterKey, 'PRICE_ASC'); assert.equal(e.applierKey, 'ALL'); assert.equal(e.usageKey, 'ALL'); assert.equal(e.promotionId, 'p1');
  assert.equal(discountEntity({ id: 'd2', scope: 'delivery', type: 'absolute', value: 3, maxValue: null, ruleId: null }).considerAdvancedRules, false);
  const snap = discountSnapshot({ id: 'd', promotionId: 'p', scope: 'cart', type: 'absolute', value: 5, considerAdvancedRules: true, sorterKey: 'PRICE_ASC', applierKey: 'ALL', usageKey: 'ALL', discountRules: [{ id: 'r', name: 'x' }], promotionDiscountPrices: [{ id: 'pp', currencyId: 'eur', price: 4, createdAt: 'x' }] });
  assert.deepEqual(snap.discountRules, [{ id: 'r' }]); assert.deepEqual(snap.promotionDiscountPrices, [{ id: 'pp', currencyId: 'eur', price: 4 }]); assert.equal(snap.maxValue, null);
});

test('Status und Statusfilter', () => {
  const t = NOW.getTime();
  assert.equal(promotionStatus({ active: false }, t), 'inaktiv');
  assert.equal(promotionStatus({ active: true, validFrom: '2026-10-01T00:00:00Z' }, t), 'geplant');
  assert.equal(promotionStatus({ active: true, validUntil: '2026-09-01T00:00:00Z' }, t), 'abgelaufen');
  assert.equal(promotionStatus({ active: true, maxRedemptionsGlobal: 10, orderCount: 10 }, t), 'ausgeschöpft');
  assert.equal(promotionStatus({ active: true }, t), 'läuft');
  const f = statusFilter('running', NOW.toISOString());
  assert.equal(f.length, 3);
  assert.deepEqual(f[1], { type: 'multi', operator: 'or', queries: [{ type: 'equals', field: 'validFrom', value: null }, { type: 'range', field: 'validFrom', parameters: { lte: NOW.toISOString() } }] });
  assert.deepEqual(statusFilter('all', ''), []);
  assert.doesNotMatch(JSON.stringify(['running', 'scheduled', 'expired', 'inactive'].map(s => statusFilter(s as 'running', 'x'))), /customer|order"/);
});

test('Anlegen: Zusammenfassung, Regel, Warnungen, Payload', async () => {
  const db = baseDb();
  db.promotion.push({ id: 'old', name: 'Sommer', active: true, useCodes: false, validFrom: null, validUntil: null, salesChannels: [{ salesChannelId: 'sf' }] });
  const { cs, payload } = await buildPromotionChangeSet(fakeReader(db), {
    reason: 'Herbstaktion', name: 'Herbst 2026', active: true, validFrom: '2026-10-01', validUntil: '2026-10-31', code: { mode: 'fixed', code: 'herbst20' },
    discounts: [{ type: 'percentage', value: 20, categoryIds: ['cat'] }], maxUsesPerCustomer: 1,
  }, { now: NOW, id: seq() });
  assert.equal(cs.kind, 'promotion'); assert.equal(cs.atomic, true); assert.equal(cs.applyLabel, 'Promotion anlegen');
  assert.ok(cs.items.every(i => i.entity === 'info'));
  assert.equal(cs.items[0].after, '20 % auf Wohnaccessoires, Code HERBST20, 01.10. bis 31.10.2026, max. 1× pro Kunde');
  noDashes(cs);
  assert.match(cs.items[0].warn.join('|'), /Überschneidung mit 1 aktiven Promotion\(en\): „Sommer“ \(automatisch\)/);
  const p = payload as CreatePayload;
  assert.equal(p.mode, 'create'); assert.deepEqual(p.salesChannelIds, ['sf']);
  assert.equal(p.rules.length, 1); assert.equal(p.rules[0].name, 'Lotse: Herbst 2026, Wohnaccessoires'); assert.deepEqual(p.rules[0].categoryIds, ['cat']);
  assert.equal(p.discounts[0].ruleId, p.rules[0].id);
  assert.equal(p.promotion.validFrom, '2026-09-30T22:00:00.000Z'); assert.equal(p.promotion.code, 'HERBST20'); assert.equal(p.promotion.useCodes, true);
  assert.equal(p.rules[0].promotionId, p.promotion.id);
  assert.equal(cs.items.find(i => i.fieldLabel === 'Code')!.after, 'Code HERBST20 (eingegeben „herbst20“, wird in Großbuchstaben angelegt; beim Einlösen ist Groß-/Kleinschreibung egal)');
  assert.match(cs.items.find(i => i.fieldLabel === 'Status & Kombination')!.after, /^aktiv, geplant: startet automatisch am 01\.10\.2026/);
  const ent = promotionEntity(p, seq());
  assert.equal(ent.preventCombination, false); assert.deepEqual(ent.salesChannels, [{ id: 'id1', salesChannelId: 'sf', priority: 1 }]); assert.ok(!('individualCodes' in ent), 'Codes kommen getrennt in Blöcken');
});

test('Anlegen: Pflichtangaben, Kollision, Warnungen ohne Enddatum/>50 %', async () => {
  const db = baseDb();
  db.promotion.push({ id: 'x', name: 'Alt', code: 'HERBST20' });
  const ro = fakeReader(db);
  await assert.rejects(buildPromotionChangeSet(ro, { name: 'A', code: { mode: 'fixed', code: 'HERBST20' }, discounts: [{ type: 'absolute', value: 5 }] }, { now: NOW }), /schon bei Promotion „Alt“/);
  await assert.rejects(buildPromotionChangeSet(ro, { name: 'A', code: { mode: 'none' } }, { now: NOW }), /discounts fehlt/);
  await assert.rejects(buildPromotionChangeSet(ro, { name: 'A', code: { mode: 'none' }, discounts: [{ type: 'absolute', value: 5, productIds: ['nope'] }] }, { now: NOW }), /nicht gefunden: nope/);
  await assert.rejects(buildPromotionChangeSet(ro, { name: 'A', code: { mode: 'none' }, discounts: [{ type: 'absolute', value: 5 }], validFrom: '2026-10-10', validUntil: '2026-10-01' }, { now: NOW }), /vor dem Startdatum/);
  await assert.rejects(buildPromotionChangeSet(ro, { name: 'A', code: { mode: 'none' }, discounts: [{ type: 'absolute', value: 5 }], salesChannelIds: ['zz'] }, { now: NOW }), /Verkaufskanal nicht gefunden/);
  const { cs, payload } = await buildPromotionChangeSet(ro, { name: 'Mega', active: true, code: { mode: 'individual', pattern: 'M-%s%s%d%d', count: 100 }, discounts: [{ type: 'percentage', value: 70, maxValue: 50 }] }, { now: NOW });
  assert.deepEqual(cs.items[0].warn, ['Rabatt über 50 % (70 %)', 'Kein Enddatum']);
  assert.match(cs.items[0].after, /^70 % auf den Warenkorb \(max\. 50,00 €\), 100 Einzelcodes nach Muster M-%s%s%d%d \(z\. B\. M-[A-Z]{2}\d{2}\), unbefristet, ohne Einlöse-Limit$/);
  assert.equal((payload as CreatePayload).codeCount, 100); assert.equal((payload as CreatePayload).promotion.useIndividualCodes, true);
  assert.equal((payload as CreatePayload).promotion.active, true);
  await assert.rejects(buildPromotionChangeSet(ro, { name: 'Leise', code: { mode: 'none' }, discounts: [{ type: 'absolute', value: 5 }] }, { now: NOW }), /active fehlt/, 'kein stiller Entwurf');
  db.promotion.push({ id: 'y', name: 'Newsletter', useIndividualCodes: true, individualCodePattern: 'M-%s%s%d%d' });
  await assert.rejects(buildPromotionChangeSet(ro, { name: 'Neu', active: true, code: { mode: 'individual', pattern: 'm-%S%s%d%D', count: 10 }, discounts: [{ type: 'absolute', value: 5 }] }, { now: NOW }), /Muster M-%s%s%d%d wird schon von Promotion „Newsletter“/);
});

test('Ändern: nur Abweichungen als auswählbare Zeilen mit Teil-Payload', async () => {
  const db = baseDb();
  db.promotion.push({ id: 'p1', name: 'Herbst', active: true, priority: 1, exclusive: false, preventCombination: false, useCodes: true, code: 'HERBST20', useIndividualCodes: false, orderCount: 3,
    validFrom: '2026-09-30T22:00:00.000+00:00', validUntil: '2026-10-31T22:59:59.000+00:00', maxRedemptionsPerCustomer: 1, salesChannels: [{ salesChannelId: 'sf' }],
    discounts: [{ id: 'd1', scope: 'cart', type: 'percentage', value: 20, discountRules: [{ name: 'Lotse: Herbst', conditions: [{ type: 'cartLineItemInCategory', value: { categoryIds: ['cat'] } }] }] }] });
  const { cs, payload } = await buildPromotionChangeSet(fakeReader(db), { id: 'p1', validFrom: '2026-10-01', validUntil: '2026-11-15', code: { mode: 'fixed', code: 'HERBST25' }, discounts: [{ type: 'percentage', value: 25, categoryIds: ['cat'] }], maxUsesPerCustomer: 1, exclusive: true }, { now: NOW, id: seq() });
  assert.deepEqual(payload, { mode: 'update', promotionId: 'p1' });
  assert.deepEqual(cs.items.map(i => i.field), ['period', 'code', 'discounts', 'exclusive']);
  const [period, code, disc, excl] = cs.items;
  assert.equal(period.before, '01.10. bis 31.10.2026'); assert.equal(period.after, '01.10. bis 15.11.2026');
  noDashes(cs);
  assert.deepEqual((period.afterRaw as UpdatePart).patch, { validUntil: '2026-11-15T22:59:59.000Z' }, 'unveränderter Start wird nicht geschrieben');
  assert.match(code.warn[0], /3× eingelöst/);
  assert.equal(disc.before, '20 % auf Wohnaccessoires'); assert.equal(disc.after, '25 % auf Wohnaccessoires');
  assert.equal((disc.afterRaw as UpdatePart).rules?.length, 1);
  assert.deepEqual((excl.afterRaw as UpdatePart).patch, { exclusive: true, preventCombination: true });
  assert.ok(cs.items.every(i => i.entity === 'promotion' && i.entityId === 'p1'));
  await assert.rejects(buildPromotionChangeSet(fakeReader(db), { id: 'p1', name: 'Herbst', active: true }, { now: NOW }), /Keine Änderung nötig/);
  await assert.rejects(buildPromotionChangeSet(fakeReader(db), { id: 'nope', name: 'x' }, { now: NOW }), /nicht gefunden/);
});

test('Status: Masse mit übersprungenen und unveränderten Einträgen', async () => {
  const db = baseDb();
  db.promotion.push({ id: 'a', name: 'A', active: true, useCodes: true, validUntil: '2026-12-31T22:59:59Z' }, { id: 'b', name: 'B', active: false }, { id: 'c', name: 'C', active: true, useCodes: false });
  const ro = fakeReader(db);
  const end = await buildStatusChangeSet(ro, { ids: ['a', 'c', 'zz'], action: 'end' }, NOW);
  assert.equal(end.kind, 'promotion-status'); assert.equal(end.items.length, 2); assert.deepEqual(end.skipped, [{ id: 'zz', reason: 'nicht gefunden' }]);
  assert.deepEqual(end.items[0].afterRaw, { active: false, validUntil: NOW.toISOString() });
  assert.match(end.items[0].warn[0], /Codes funktionieren/);
  const act = await buildStatusChangeSet(ro, { ids: ['a', 'b'], action: 'activate' }, NOW);
  assert.equal(act.items.length, 1); assert.equal(act.unchanged, 1); assert.deepEqual(act.items[0].afterRaw, { active: true });
  assert.deepEqual(act.items[0].warn, ['Kein Enddatum', 'Gilt automatisch ohne Code']);
  await assert.rejects(buildStatusChangeSet(ro, { ids: ['b'], action: 'deactivate' }, NOW), /Keine Änderung nötig/);
});

test('Entwurf vs. geplant: inaktive Promotion mit Zeitraum startet nie von selbst', () => {
  const t = NOW.getTime();
  assert.deepEqual(draftWarning(false, '2026-09-30T22:00:00.000Z', null, t), ['Inaktiv: startet am 01.10.2026 NICHT automatisch; für einen geplanten Start aktiv anlegen']);
  assert.deepEqual(draftWarning(false, null, '2026-10-31T22:00:00.000Z', t), ['Inaktiv: läuft im Zeitraum NICHT automatisch; zum Start aktiv setzen']);
  assert.deepEqual(draftWarning(false, null, null, t), [], 'Entwurf ohne Zeitraum');
  assert.deepEqual(draftWarning(false, null, '2026-09-01T00:00:00Z', t), [], 'abgelaufen');
  assert.deepEqual(draftWarning(true, '2026-09-30T22:00:00.000Z', null, t), []);
  assert.equal(activeText(true, '2026-09-30T22:00:00.000Z', t), 'aktiv, geplant: startet automatisch am 01.10.2026');
  assert.equal(activeText(true, '2026-09-01T00:00:00Z', t), 'sofort aktiv');
  assert.equal(activeText(false, null, t), 'inaktiv (Entwurf)');
});

test('Anlegen als Entwurf: Warnung + Überschneidung als Hinweis', async () => {
  const db = baseDb();
  db.promotion.push({ id: 'old', name: 'Sommer', active: true, useCodes: true, validFrom: null, validUntil: null, salesChannels: [{ salesChannelId: 'sf' }] });
  const { cs } = await buildPromotionChangeSet(fakeReader(db), { reason: 'x', name: 'Herbst', active: false, validFrom: '2026-10-01', validUntil: '2026-10-31', code: { mode: 'fixed', code: 'HERBST20' }, discounts: [{ type: 'percentage', value: 20 }] }, { now: NOW, id: seq() });
  const w = cs.items[0].warn.join('|');
  assert.match(w, /Inaktiv: startet am 01\.10\.2026 NICHT automatisch/);
  noDashes(cs);
  assert.match(w, /Bei Aktivierung: Überschneidung mit 1 aktiven Promotion\(en\): „Sommer“ \(mit Code\)/);
  assert.equal(cs.items.find(i => i.fieldLabel === 'Status & Kombination')!.after.split(' · ')[0], 'inaktiv (Entwurf)');
});

test('Überschneidung: Zeitraum und Kanal', () => {
  const pool = [{ id: 'a', name: 'A', validFrom: '2026-10-10T00:00:00Z', validUntil: null, salesChannels: [{ salesChannelId: 'sf' }] }, { id: 'b', name: 'B', salesChannels: [{ salesChannelId: 'api' }] }];
  assert.deepEqual(overlapText(pool, null, ['2026-10-01T00:00:00Z', '2026-10-05T00:00:00Z'], ['sf']), [], 'endet vor Start von A');
  assert.equal(overlapText(pool, null, ['2026-10-01T00:00:00Z', null], ['sf', 'api']).length, 1);
  assert.deepEqual(overlapText(pool, 'a', [null, null], ['sf']), [], 'sich selbst ignorieren');
});

test('Ändern: neues Einzelcode-Muster, alte Codes bleiben gültig; Entwurf mit neuem Zeitraum', async () => {
  const db = baseDb();
  db.promotion.push({ id: 'p1', name: 'News', active: false, priority: 1, useCodes: true, useIndividualCodes: true, individualCodePattern: 'N-%s%s%d%d', orderCount: 0, salesChannels: [{ salesChannelId: 'sf' }], discounts: [] });
  const { cs } = await buildPromotionChangeSet(fakeReader(db), { id: 'p1', code: { mode: 'individual', pattern: 'N2-%s%s%d%d', count: 10 }, validFrom: '2026-10-01' }, { now: NOW, id: seq() });
  assert.match(cs.items.find(i => i.field === 'code')!.after, /^\+ 10 neue Einzelcodes nach Muster N2-%s%s%d%d .*; die bisherigen Einzelcodes bleiben gültig$/);
  assert.match(cs.items[0].warn.join('|'), /Inaktiv: startet am 01\.10\.2026 NICHT automatisch/);
  noDashes(cs);
});

test('Status aktivieren: Überschneidung mit aktiven und gemeinsam aktivierten Promotionen', async () => {
  const db = baseDb();
  db.promotion.push(
    { id: 'run', name: 'Läuft', active: true, useCodes: false, salesChannels: [{ salesChannelId: 'sf' }] },
    { id: 'n1', name: 'N1', active: false, useCodes: true, validUntil: '2026-12-31T00:00:00Z', salesChannels: [{ salesChannelId: 'sf' }] },
    { id: 'n2', name: 'N2', active: false, useCodes: true, validUntil: '2026-12-31T00:00:00Z', salesChannels: [{ salesChannelId: 'api' }] },
    { id: 'n3', name: 'N3', active: false, useCodes: true, validUntil: '2026-12-31T00:00:00Z', salesChannels: [{ salesChannelId: 'api' }] });
  // Fake-Leser ignoriert den active-Filter → nur aktive in den Pool geben
  const ro = fakeReader(db), search = ro.search;
  ro.search = async (e, c = {}) => { const r = await search(e, c); return c.ids ? r : { ...r, data: r.data.filter(p => p.active), total: r.data.filter(p => p.active).length }; };
  const cs = await buildStatusChangeSet(ro, { ids: ['n1', 'n2', 'n3'], action: 'activate' }, NOW);
  const w = Object.fromEntries(cs.items.map(i => [i.entityId, i.warn.join('|')]));
  assert.match(w.n1, /Überschneidung mit 1 aktiven Promotion\(en\): „Läuft“ \(automatisch\)/);
  assert.match(w.n2, /Überschneidung mit 1 aktiven Promotion\(en\): „N3“ \(mit Code\)/);
});

test('Regel-Sicherung: flache Bedingungen → Baum mit gleichen IDs; Undo der Anlage per Kriterium', () => {
  const snap = ruleSnapshot({ id: 'r', name: 'Lotse: X', priority: 1, description: 'd', conditions: [
    { id: 'c3', parentId: 'c2', type: 'cartLineItem', position: 0, value: { operator: '=', identifiers: ['p'] } },
    { id: 'c1', parentId: null, type: 'orContainer', position: 0, value: null },
    { id: 'c2', parentId: 'c1', type: 'andContainer', position: 0 },
  ] });
  assert.deepEqual(snap.conditions, [{ id: 'c1', type: 'orContainer', position: 0, children: [{ id: 'c2', type: 'andContainer', position: 0, children: [{ id: 'c3', type: 'cartLineItem', position: 0, value: { operator: '=', identifiers: ['p'] }, children: [] }] }] }]);
  const op = promotionRulesDelete('promo1');
  assert.equal(op.op, 'req'); assert.equal(op.path, '/_action/sync');
  assert.deepEqual((op.body as { criteria: unknown }[])[0].criteria, [{ type: 'prefix', field: 'name', value: 'Lotse:' }, { type: 'contains', field: 'description', value: 'promo1' }]);
});

// ---- Executor gegen einen Fake-Shop (Tabellen je Entität, Sync-API für Einzelcodes, DELETE/create wie die Admin-API, auch für undoOps) ----
type SyncOp = { action: string; entity: string; payload?: SwEntity[]; criteria?: { value: string }[] };
function fakeShop(db: Record<string, SwEntity[]>, o: { failSyncAt?: number; takenOnce?: boolean } = {}) {
  const log: string[] = [], tbl = (e: string) => (db[e] ||= []); let syncs = 0, codeQueries = 0, taken: string | null = null;
  const sw = {
    base: 'http://shop',
    search: async (e: string, c: { ids?: string[]; filter?: { type: string; field: string; value: unknown }[] } = {}) => {
      let rows = tbl(e);
      if (c.ids) rows = rows.filter(r => c.ids!.includes(r.id));
      for (const f of c.filter ?? []) {
        if (f.type === 'equalsAny' && f.field === 'code') { codeQueries++; const want = f.value as string[]; if (o.takenOnce && codeQueries === 1) { taken = want[0]; rows = [{ code: taken }]; } else rows = rows.filter(r => want.includes(r.code)); }
        else if (f.type === 'equals' && f.field !== 'active' && f.field !== 'payload') rows = rows.filter(r => r[f.field] === f.value);
      }
      return { data: rows, total: rows.length };
    },
    get: async (e: string, id: string) => { const r = tbl(e).find(x => x.id === id); return r ? (e === 'promotion' ? { ...r, discounts: tbl('promotion-discount').filter(d => d.promotionId === id), salesChannels: tbl('promotion-sales-channel').filter(s => s.promotionId === id) } : r) : null; },
    create: async (e: string, d: SwEntity) => { log.push(`create ${e}`); tbl(e).push({ ...d }); },
    update: async (e: string, id: string, d: SwEntity) => { log.push(`update ${e}`); const r = tbl(e).find(x => x.id === id); if (!r) throw new Error('404'); Object.assign(r, d); },
    req: async (m: string, p: string, body?: SyncOp[]) => {
      if (p === '/_action/sync') {
        const op = body![0], e = op.entity.replace(/_/g, '-'); syncs++; log.push(`sync ${op.action} ${e} ${op.payload?.length ?? 'criteria'}`);
        if (op.action === 'upsert') { if (o.failSyncAt === syncs) throw new Error('Sync fehlgeschlagen'); tbl(e).push(...op.payload!); }
        else if (op.payload) { const ids = new Set(op.payload.map(x => x.id)); db[e] = tbl(e).filter(x => !ids.has(x.id)); }
        else db[e] = tbl(e).filter(r => !(String(r.name).startsWith('Lotse:') && String(r.description ?? '').includes(op.criteria![1].value)));
        return null;
      }
      const [, e, id] = p.split('/'); log.push(`${m} /${e}`);
      if (m === 'DELETE') { const i = tbl(e).findIndex(x => x.id === id); if (i < 0) throw Object.assign(new Error('404'), { status: 404 }); tbl(e).splice(i, 1); if (e === 'promotion') for (const t of ['promotion-discount', 'promotion-individual-code', 'promotion-sales-channel']) db[t] = tbl(t).filter(x => x.promotionId !== id); }
      return null;
    },
  } as unknown as Shopware;
  return { sw, log, takenCode: () => taken, syncs: () => syncs };
}
const all = (cs: { items: { id: string }[] }) => new Set(cs.items.map(i => i.id));

test('Anlegen mit Einzelcodes: Codes in Blöcken, Kollision beim Prüfen wird umgangen, Rückgängig = Regeln per Kriterium + Promotion', async () => {
  const db: Record<string, SwEntity[]> = baseDb();
  const { cs, payload } = await buildPromotionChangeSet(fakeReader(db), { name: 'Codes', active: true, validUntil: '2026-12-31', code: { mode: 'individual', pattern: 'C-%s%s%d%d', count: 1500 }, discounts: [{ type: 'percentage', value: 10, categoryIds: ['cat'] }] }, { now: NOW });
  const shop = fakeShop(db, { takenOnce: true }), ticks: string[][] = [];
  const res = await applyChangeSet(shop.sw, cs, payload, all(cs), { progress: (_d, _t, p) => ticks.push((p?.undo ?? []).map(u => `${u.op} ${u.entity}`)) });
  assert.ok(res.results.every(r => r.ok) && !res.error);
  assert.deepEqual(ticks, [['delete rule'], ['delete rule', 'delete promotion']], 'B1: jeder Schreibschritt sofort als Zwischenstand gemeldet (Absturz mittendrin verliert kein Rückgängig)');
  assert.deepEqual(shop.log.filter(l => l.startsWith('sync')), ['sync upsert promotion-individual-code 1000', 'sync upsert promotion-individual-code 500']);
  const codes = db['promotion-individual-code'].map(c => c.code);
  assert.equal(new Set(codes).size, 1500); assert.ok(shop.takenCode() && !codes.includes(shop.takenCode()!), 'als vergeben gemeldeter Code wird nicht verwendet');
  assert.ok(db['promotion-individual-code'].every(c => c.promotionId === (payload as CreatePayload).promotion.id));
  assert.equal(db.rule.length, 1); assert.equal(db.promotion.length, 1);
  assert.deepEqual(res.undo.map(u => `${u.op} ${u.entity}`), ['req rule', 'delete promotion']);
  // Rückgängig: Promotion samt Codes weg, Lotse-Regel per Kriterium gelöscht
  assert.ok((await undoOps(shop.sw, res.undo)).every(r => r.ok));
  assert.deepEqual([db.promotion.length, db.rule.length, db['promotion-individual-code'].length], [0, 0, 0]);
});

test('Anlegen: scheitert der zweite Code-Block, bleibt nichts zurück (Promotion und Regeln zurückgerollt)', async () => {
  const db: Record<string, SwEntity[]> = baseDb();
  const { cs, payload } = await buildPromotionChangeSet(fakeReader(db), { name: 'Codes', active: true, validUntil: '2026-12-31', code: { mode: 'individual', pattern: 'C-%s%s%d%d', count: 1500 }, discounts: [{ type: 'percentage', value: 10, categoryIds: ['cat'] }] }, { now: NOW });
  const shop = fakeShop(db, { failSyncAt: 2 }), ticks: number[] = [];
  const res = await applyChangeSet(shop.sw, cs, payload, all(cs), { progress: (_d, _t, p) => ticks.push(p?.undo.length ?? -1) });
  assert.equal(res.error, 'Sync fehlgeschlagen'); assert.deepEqual([res.results, res.undo], [[], []]);
  assert.deepEqual(ticks, [1, 2], 'Zwischenstand kannte Regel und Promotion, bevor zurückgerollt wurde');
  assert.deepEqual([db.promotion.length, db.rule.length, db['promotion-individual-code'].length], [0, 0, 0], 'Codes hängen per Kaskade an der Promotion');
  assert.deepEqual(shop.log.slice(-3), ['sync upsert promotion-individual-code 500', 'DELETE /promotion', 'DELETE /rule'], 'rückwärts: Promotion (mit Codes), dann Regel');
});

test('Ändern: Rabatte ersetzen löscht alte Rabatte und verwaiste Lotse-Regel; Rückgängig stellt Regel vor Rabatt wieder her', async () => {
  const db: Record<string, SwEntity[]> = baseDb();
  const r1 = { id: 'r1', name: 'Lotse: Herbst, Wohnaccessoires', description: ruleDescription('p1'), priority: 1, conditions: [{ id: 'c1', parentId: null, type: 'cartLineItemInCategory', position: 0, value: { operator: '=', categoryIds: ['cat'] } }] };
  const d1 = { id: 'd1', promotionId: 'p1', scope: 'cart', type: 'percentage', value: 20, considerAdvancedRules: true, sorterKey: 'PRICE_ASC', applierKey: 'ALL', usageKey: 'ALL', discountRules: [{ id: 'r1', name: r1.name, conditions: r1.conditions }] };
  db.rule = [r1]; db['promotion-discount'] = [d1]; db['promotion-sales-channel'] = [{ id: 'ps1', promotionId: 'p1', salesChannelId: 'sf', priority: 1 }];
  db.promotion.push({ id: 'p1', name: 'Herbst', active: true, useCodes: false, useIndividualCodes: false, orderCount: 0, priority: 1, discounts: [d1], salesChannels: [{ salesChannelId: 'sf' }] });
  const { cs, payload } = await buildPromotionChangeSet(fakeReader(db), { id: 'p1', discounts: [{ type: 'percentage', value: 25, categoryIds: ['cat'] }] }, { now: NOW, id: seq() });
  assert.deepEqual(cs.items.map(i => i.field), ['discounts']);
  const shop = fakeShop(db);
  const res = await applyChangeSet(shop.sw, cs, payload, all(cs));
  assert.ok(res.results.every(r => r.ok) && !res.error, res.error);
  assert.deepEqual(db['promotion-discount'].map(d => [d.value, d.discountRules]), [[25, [{ id: 'id1' }]]]);
  assert.deepEqual(db.rule.map(r => r.id), ['id1'], 'alte Lotse-Regel gelöscht');
  assert.deepEqual(res.undo.map(u => `${u.op} ${u.entity}`), ['delete rule', 'create promotion-discount', 'delete promotion-discount', 'create rule']);
  const back = res.undo.at(-1) as UndoOp;
  assert.equal(back.id, 'r1'); assert.deepEqual((back.data as { conditions: { id: string; children: unknown[] }[] }).conditions.map(c => [c.id, c.children.length]), [['c1', 0]]);
  // Rückgängig (rückwärts): erst Regel r1, dann Rabatt d1 mit Bezug auf r1, dann die neuen Teile weg
  assert.ok((await undoOps(shop.sw, res.undo)).every(r => r.ok));
  assert.deepEqual(shop.log.slice(-4), ['create rule', 'DELETE /promotion-discount', 'create promotion-discount', 'DELETE /rule']);
  assert.deepEqual(db.rule.map(r => r.id), ['r1']);
  assert.deepEqual(db['promotion-discount'].map(d => [d.id, d.value, d.discountRules]), [['d1', 20, [{ id: 'r1' }]]]);
});

test('Ändern: Fehler mitten im Set rollt bereits Geschriebenes zurück', async () => {
  const db: Record<string, SwEntity[]> = baseDb();
  db.promotion.push({ id: 'p1', name: 'Herbst', active: true, useCodes: true, code: 'ALT', useIndividualCodes: false, orderCount: 0, priority: 1, discounts: [], salesChannels: [{ salesChannelId: 'sf' }] });
  db['promotion-sales-channel'] = [{ id: 'ps1', promotionId: 'p1', salesChannelId: 'sf', priority: 1 }];
  const { cs, payload } = await buildPromotionChangeSet(fakeReader(db), { id: 'p1', name: 'Herbst neu', salesChannelIds: ['api'] }, { now: NOW, id: seq() });
  const shop = fakeShop(db), create = shop.sw.create;
  shop.sw.create = async (e: string, d: SwEntity) => { if (e === 'promotion-sales-channel' && d.salesChannelId === 'api') throw new Error('Kanal gesperrt'); return create(e, d); };
  const res = await applyChangeSet(shop.sw, cs, payload, all(cs));
  assert.match(res.error ?? '', /Kanal gesperrt; nichts geändert \(zurückgerollt\)/);
  assert.ok(res.results.every(r => !r.ok)); assert.deepEqual(res.undo, []);
  assert.equal(db.promotion[0].name, 'Herbst', 'Name zurückgesetzt');
  assert.deepEqual(db['promotion-sales-channel'].map(s => s.salesChannelId), ['sf'], 'gelöschter Kanal wieder da');
});
