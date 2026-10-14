import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHtml } from '../../src/server/html-sanitize';

test('sanitizeHtml: blocklist bypasses are neutralized', () => {
  assert.equal(sanitizeHtml('<svg/onload=alert(1)>'), '');
  assert.equal(sanitizeHtml('<svg><svg></svg><img src=x onerror=alert(1)></svg>ok'), '<img src="x">ok');
  assert.equal(sanitizeHtml('<img src="x"/onerror=alert(1)>'), '<img src="x">');
  assert.equal(sanitizeHtml('<scr<script></script>ipt>alert(1)</script>'), 'ipt&gt;alert(1)');
  assert.equal(sanitizeHtml('<button formaction=javascript:alert(1)>x</button>'), 'x');
  assert.equal(sanitizeHtml('<a href="java&#x09;script:alert(1)" onclick=x style="background:url(x)">l</a>'), '<a href="#">l</a>');
  assert.equal(sanitizeHtml('<img src="data:image/svg+xml,<svg onload=alert(1)>">'), '<img src="#">');
  assert.equal(sanitizeHtml('<a title="x&quot; onmouseover=&quot;alert(1)">t</a>'), '<a title="x&quot; onmouseover=&quot;alert(1)">t</a>');
  assert.equal(sanitizeHtml('<iframe src="https://evil">inner</iframe><object>o</object><style>p{}</style><template><img src=x></template>t'), 't');
  assert.equal(sanitizeHtml('<p>x<script>alert(1)'), '<p>x');
  assert.equal(sanitizeHtml('<p>x<a href="unterminated'), '<p>x');
  assert.equal(sanitizeHtml('<!-- <img src=x onerror=1> --><p>a</p><!doctype html><?php x ?>'), '<p>a</p>');
  assert.equal(sanitizeHtml('a < b > c <3 </ p>'), 'a &lt; b &gt; c &lt;3 &lt;/ p&gt;');
});

test('sanitizeHtml: normal product markup is preserved', () => {
  const ok = '<h2 class="t">Pflege</h2><p>Mit <strong>Liebe</strong>, <em>Sorgfalt</em> &amp; <u>Zeit</u><br>H<sub>2</sub>O m<sup>2</sup></p><ul><li>a</li></ul><ol start="2"><li>b</li></ol>'
    + '<table><thead><tr><th scope="col">Maß</th></tr></thead><tbody><tr><td colspan="2">10&nbsp;cm</td></tr></tbody></table><blockquote>z</blockquote><hr><div><span title="x">s</span></div>'
    + '<a href="https://shop.de/x?a=1&amp;b=2" target="_blank" rel="noopener">l</a><img src="/media/a.jpg" alt="A" width="10" height="20">';
  assert.equal(sanitizeHtml(ok), ok.replace('&nbsp;', '&nbsp;'));
  assert.equal(sanitizeHtml('<P ALIGN=center STYLE="color:red">x</P><font color=red>y</font>'), '<p>x</p>y');
});

test('sanitizeHtml: linear time on adversarial input', () => {
  for (const s of ['<a'.repeat(50_000), '<a x="'.repeat(30_000), '<script>'.repeat(30_000), '<!--'.repeat(50_000), '</'.repeat(50_000), '<a b=1 c=2 '.repeat(20_000)]) {
    const t = Date.now(); sanitizeHtml(s); assert.ok(Date.now() - t < 1000, s.slice(0, 20));
  }
});
