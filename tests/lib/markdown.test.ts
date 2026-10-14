import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdown } from '../../src/lib/markdown';

test('escapes HTML completely', () => {
  const out = markdown('<script>alert(1)</script> & <img src=x onerror="y">');
  assert.ok(!out.includes('<script>'));
  assert.ok(!out.includes('<img'));
  assert.equal(out, '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;img src=x onerror=&quot;y&quot;&gt;</p>');
});

test('bold, code and line breaks', () => {
  assert.equal(markdown('**Hallo** `x<y`\nZeile 2'), '<p><b>Hallo</b> <code>x&lt;y</code><br>Zeile 2</p>');
});

test('lists and paragraphs', () => {
  assert.equal(markdown('Intro\n\n- eins\n• zwei'), '<p>Intro</p><ul><li>eins</li><li>zwei</li></ul>');
});

test('tables incl. separator row, cells escaped', () => {
  const out = markdown('| Name | Preis |\n|---|---:|\n| <b>A</b> | **9,99** |');
  assert.ok(out.includes('<thead><tr><th>Name</th><th>Preis</th></tr></thead>'));
  assert.ok(out.includes('<td>&lt;b&gt;A&lt;/b&gt;</td><td><b>9,99</b></td>'));
  assert.ok(!out.includes('---'));
});

test('markup in bold/code cannot break out', () => {
  const out = markdown('**<a href="javascript:x">x</a>**');
  assert.equal(out, '<p><b>&lt;a href=&quot;javascript:x&quot;&gt;x&lt;/a&gt;</b></p>');
});
