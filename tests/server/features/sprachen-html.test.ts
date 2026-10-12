import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSeg, configLinks, decode, mapConfigLinks, mapUrl, plain, rebuild, segmentHtml, slotTexts, type LinkIndex } from '../../../src/server/features/sprachen-html';

test('decode: benannte und numerische Entities; ungültige Codepunkte bleiben wörtlich stehen statt zu werfen', () => {
  assert.equal(decode('&auml; &#65; &#x1F600; &amp; x &unknown;'), 'ä A 😀 & x &unknown;');
  assert.equal(plain('a &#x110000; b &#9999999999; c'), 'a &#x110000; b &#9999999999; c');
  assert.doesNotThrow(() => segmentHtml('<p title="&#x110000;">T &#99999999999;</p>'));
});

const HTML = `<div class="aicb-x"><style>.aicb-x h2{color:red}/* Überschrift */</style><section><h2>Häufige Fragen</h2><p>Die Vase ist <strong>wasserdicht</strong> &amp; matt.</p>
<img src="/v.jpg" alt="Vase „Kiesel“"><p>22</p><a class="btn" href="/Wohnaccessoires/" title="Zur Kategorie">Jetzt <b>ansehen</b></a><svg><path d="M0"/></svg></section>
<script type="application/ld+json">{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Häufige Fragen","acceptedAnswer":{"text":"Die Vase ist wasserdicht & matt."}}]}</script><script>root.querySelector('h2').title='Hallo';</script></div>`;

test('segmentHtml: Texte, Inline-Tags und Attribute – CSS/JS/Zahlen bleiben fest, Rückweg ist exakt', () => {
  const s = segmentHtml(HTML);
  assert.deepEqual(s.segs.map(g => [g.kind, g.attr ?? '', g.src]), [
    ['text', '', 'Häufige Fragen'],
    ['text', '', 'Die Vase ist <strong>wasserdicht</strong> &amp; matt.'],
    ['attr', 'alt', 'Vase „Kiesel“'],
    ['attr', 'title', 'Zur Kategorie'],
    ['text', '', 'Jetzt <b>ansehen</b>'],
  ]);
  assert.equal(rebuild(s, () => undefined), HTML);
});

test('rebuild: Übersetzungen einsetzen, Attribute kodieren, JSON-LD über den sichtbaren Text mitübersetzen', () => {
  const s = segmentHtml(HTML);
  const tr = ['Frequently asked questions', 'The vase is <strong>watertight</strong> &amp; matte.', 'Vase "Kiesel"', 'To the category', 'View <b>now</b>'];
  const out = rebuild(s, i => tr[i]);
  assert.match(out, /<h2>Frequently asked questions<\/h2><p>The vase is <strong>watertight<\/strong> &amp; matte\.<\/p>/);
  assert.match(out, /alt="Vase &quot;Kiesel&quot;"/);
  assert.match(out, /title="To the category">View <b>now<\/b><\/a>/);
  assert.match(out, /"name":"Frequently asked questions"/);
  assert.match(out, /"text":"The vase is watertight & matte\."/);
  assert.match(out, /\.aicb-x h2\{color:red\}\/\* Überschrift \*\//);
  assert.match(out, /title='Hallo'/);
});

test('segmentHtml: über Block-Elemente unterbrochene Inline-Tags ergeben ausgeglichene Abschnitte', () => {
  const h = '<ul><li><span class="i"><svg></svg></span><span><b>Innen glasiert</b><small>Wasserdicht.</small></span></li></ul><a class="btn" href="#x">Ansehen <span aria-hidden="true"><svg></svg></span></a>';
  const s = segmentHtml(h);
  assert.deepEqual(s.segs.map(g => g.src), ['<b>Innen glasiert</b><small>Wasserdicht.</small>', 'Ansehen']);
  assert.equal(rebuild(s, () => undefined), h);
});

test('checkSeg: gleiche Inline-Tags, keine Block-Tags, reiner Text in Attributen', () => {
  const [t, , a] = segmentHtml('<p>Die <strong>Vase</strong></p><p>x</p><img alt="Bild einer Vase">').segs;
  assert.equal(checkSeg(t, 'The <strong>vase</strong>'), null);
  assert.match(checkSeg(t, 'The vase')!, /Inline-Tags/);
  assert.match(checkSeg(t, '<p>The <strong>vase</strong></p>')!, /<p> nicht erlaubt/);
  assert.match(checkSeg(t, '  ')!, /leer/);
  assert.equal(checkSeg(a, 'Picture of a vase'), null);
  assert.match(checkSeg(a, '<b>x</b>')!, /kein HTML/);
});

test('slotTexts: nur statische Texte, stabile keys, Rest der Config unverändert', () => {
  const cfg = { title: { source: 'static', value: 'Unsere Favoriten' }, products: { source: 'static', value: ['a'] }, boxLayout: { source: 'static', value: 'standard' }, content: { source: 'mapped', value: 'product.name' } };
  const { segs, apply } = slotTexts(cfg, 's4');
  assert.deepEqual(segs.map(g => [g.key, g.kind, g.src]), [['s4.0', 'value', 'Unsere Favoriten']]);
  assert.deepEqual(apply({ 's4.0': 'Our favourites' }), { ...cfg, title: { source: 'static', value: 'Our favourites' } });
  const html = slotTexts({ content: { source: 'static', value: '<p>Hallo <b>Welt</b></p>' } }, 's1');
  assert.deepEqual(html.segs.map(g => g.key), ['s1.0']);
  assert.equal(html.apply({ 's1.0': 'Hello <b>world</b>' }).content!.value, '<p>Hello <b>world</b></p>');
});

const ix = (domains: LinkIndex['domains']): LinkIndex => ({
  domains, targetLanguageId: 'en', targetLanguageName: 'English',
  bySeoPath: new Map([['Wohnaccessoires/', { routeName: 'frontend.navigation.page', foreignKey: 'c1', salesChannelId: 'sc', seoPathInfo: 'Wohnaccessoires/', languageId: 'de' }]]),
  targetSeo: new Map([['sc|frontend.navigation.page|c1', 'Home-accessories/'], ['sc|frontend.detail.page|' + 'a'.repeat(32), 'Vase-Pebble/HH-VASE-22']]),
});
const both = [{ url: 'http://shop.test', languageId: 'de', salesChannelId: 'sc' }, { url: 'http://shop.test/en', languageId: 'en', salesChannelId: 'sc' }];

test('mapUrl: SEO- und technische Pfade auf die SEO-URL der Zielsprache, Rest bleibt', () => {
  assert.deepEqual(mapUrl('http://shop.test/Wohnaccessoires/?order=name#top', ix(both)), { url: 'http://shop.test/en/Home-accessories/?order=name#top' });
  assert.deepEqual(mapUrl('/Wohnaccessoires', ix(both)), { url: 'http://shop.test/en/Home-accessories/' });
  assert.deepEqual(mapUrl(`/detail/${'a'.repeat(32)}`, ix(both)), { url: 'http://shop.test/en/Vase-Pebble/HH-VASE-22' });
  assert.equal(mapUrl(`/navigation/${'b'.repeat(32)}`, ix(both)).url, `http://shop.test/en/navigation/${'b'.repeat(32)}`);
  assert.deepEqual(mapUrl('https://example.org/x', ix(both)), { url: 'https://example.org/x' });
  assert.deepEqual(mapUrl('#objekte', ix(both)), { url: '#objekte' });
  assert.match(mapUrl('/unbekannt/', ix(both)).note!, /keine Shop-Seite/);
  const noEn = mapUrl('http://shop.test/Wohnaccessoires/', ix([both[0]]));
  assert.equal(noEn.url, 'http://shop.test/Wohnaccessoires/');
  assert.match(noEn.note!, /keine Domain für English/);
});

test('mapConfigLinks: href und url umstellen, unveränderte Links bleiben bytegenau', () => {
  const cfg = { content: { source: 'static', value: '<a href="/Wohnaccessoires/">A</a><a href="https://x.org/?a=1&b=2">B</a>' }, url: { source: 'static', value: '/Wohnaccessoires/' } };
  assert.deepEqual(configLinks(cfg), ['/Wohnaccessoires/', 'https://x.org/?a=1&b=2', '/Wohnaccessoires/']);
  const r = mapConfigLinks(cfg, ix(both));
  assert.equal(r.config.content!.value, '<a href="http://shop.test/en/Home-accessories/">A</a><a href="https://x.org/?a=1&b=2">B</a>');
  assert.equal(r.config.url!.value, 'http://shop.test/en/Home-accessories/');
  assert.equal(r.changed.length, 2);
});

test('checkSeg: Attribute der Inline-Tags bleiben, nur title/alt dürfen sich ändern; kein on*/javascript:', () => {
  const sg = { kind: 'text' as const, src: 'Zur <a href="/x/" class="btn" title="Mehr">Kategorie</a>' };
  assert.equal(checkSeg(sg, 'To the <a class="btn" href="/x/" title="More">category</a>'), null);
  assert.match(checkSeg(sg, 'To the <a href="/y/" class="btn" title="More">category</a>')!, /Attribute/);
  assert.match(checkSeg(sg, 'To the <a href="/x/" class="btn" title="More" style="color:red">category</a>')!, /Attribute/);
  assert.match(checkSeg(sg, 'To the <a href="/x/" class="btn" title="More" onclick="x()">category</a>')!, /Event-Handler/);
  assert.match(checkSeg(sg, 'To the <a href="javascript:alert(1)" class="btn" title="More">category</a>')!, /javascript/);
});

test('configLinks/mapConfigLinks: Links in Listen (sliderItems[].url) werden mit umgestellt', () => {
  const cfg = { sliderItems: { source: 'static', value: [{ mediaId: 'm', url: '/Wohnaccessoires/', newTab: false }, { mediaId: 'n', url: null }] } };
  assert.deepEqual(configLinks(cfg), ['/Wohnaccessoires/']);
  const r = mapConfigLinks(cfg, ix(both));
  assert.deepEqual(r.config.sliderItems!.value, [{ mediaId: 'm', url: 'http://shop.test/en/Home-accessories/', newTab: false }, { mediaId: 'n', url: null }]);
  assert.equal(cfg.sliderItems.value[0].url, '/Wohnaccessoires/');
});
