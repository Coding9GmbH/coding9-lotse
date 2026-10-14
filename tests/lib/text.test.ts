import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attr, closed, decodeEntities, HEADINGS, htmlToText, stripBlocks } from '../../src/lib/text';

const fast = (label: string, f: () => unknown, ms = 1000) => { const t = Date.now(); f(); const d = Date.now() - t; assert.ok(d < ms, `${label}: ${d} ms`); };

test('stripBlocks: drops closed blocks with content, case-insensitive, only whole tag names', () => {
  assert.equal(stripBlocks('a<script>x()</script>b<STYLE type="t">p{}</Style >c'), 'a b c');
  assert.equal(stripBlocks('<scripts>keep</scripts>'), '<scripts>keep</scripts>');
  assert.equal(stripBlocks('a<nav>n</nav><header>h</header>b', ['header', 'nav']), 'a  b');
  assert.equal(stripBlocks('a<noscript>n</noscript>b'), 'a<noscript>n</noscript>b', 'default is script/style only');
});

test('stripBlocks: an unclosed tag swallows the rest instead of rescanning (linear)', () => {
  assert.equal(stripBlocks('text<script>evil'), 'text ');
  fast('100k unclosed <script', () => stripBlocks('<script'.repeat(100_000)));
  fast('100k unclosed <nav', () => stripBlocks('<nav x>'.repeat(100_000), ['header', 'footer', 'nav']));
  fast('htmlToText on 100k <script', () => htmlToText('<script'.repeat(100_000)));
  fast('htmlToText on 100k bare <', () => htmlToText('<'.repeat(100_000)));
});

test('htmlToText: tags → space, &nbsp;, whitespace collapse; optional entity decoding', () => {
  assert.equal(htmlToText('<p>Hallo&nbsp;<b>Welt</b></p>\n<script>x</script> &amp;'), 'Hallo Welt &amp;');
  assert.equal(htmlToText('<svg>i</svg>A&amp;B &#39;x&#039; &apos;', { tags: ['svg'], decode: true, apos: '’' }), 'A&B ’x’ ’');
});

test('decodeEntities: single pass, so &amp;lt; stays &lt;', () => {
  assert.equal(decodeEntities('&amp;lt;b&amp;gt; &lt;i&gt; &quot;q&quot; &amp;amp; &nbsp;'), '&lt;b&gt; <i> "q" &amp;  ');
  assert.equal(decodeEntities('&#39;a&apos;'), "'a'");
  assert.equal(decodeEntities('&#39;', '’'), '’');
  assert.equal(decodeEntities('&unknown; &AMP;'), '&unknown; &AMP;');
});

test('attr: quoted values, undefined when missing; closed: only matches ending in the close tag', () => {
  assert.equal(attr('<a href="/x" rel=\'nofollow\'>', 'href'), '/x');
  assert.equal(attr('<a href="/x" rel=\'nofollow\'>', 'rel'), 'nofollow');
  assert.equal(attr('<a data-href="/x">', 'href'), undefined);
  assert.equal(attr('<img alt="">', 'alt'), '');
  assert.equal(closed('<a>x</A>', 'a'), '<a>x</A>');
  assert.equal(closed('<a>x', 'a'), undefined);
  assert.equal(closed(undefined, 'a'), undefined);
});

test('HEADINGS: level and content; mismatched or unclosed headings do not swallow later ones; linear', () => {
  const hs = [...'<h2>Kaputt</h3><h1 class="x">Eins <b>fett</b></h1><h3>Drei'.matchAll(HEADINGS)].map(m => [m[1], m[2]]);
  assert.deepEqual(hs, [['1', 'Eins <b>fett</b>']]);
  fast('100k unclosed <h1>', () => [...'<h1>'.repeat(100_000).matchAll(HEADINGS)]);
});
