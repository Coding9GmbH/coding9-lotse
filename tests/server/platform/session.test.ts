import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatEvent } from '@/lib/protocol';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-session-platform-'));
delete process.env.SHOP_PLATFORM;

const { updateSettings } = await import('../../../src/server/settings');
const { getSession, decideChange, peekSession } = await import('../../../src/server/sessions');
const { buildTools, toolNamesFor } = await import('../../../src/server/tools');

type Res = { isError?: boolean; content: { text: string }[] };
const call = async (tools: ReturnType<typeof buildTools>, name: string, args: Record<string, unknown>) => (await tools.find(t => t.name === name)!.handler(args, {})) as Res;

test('Session auf Shopify: eigene Werkzeuge, Shopware-Lese-Client gesperrt, Entwurf mit generischen Blöcken (auch ohne erreichbaren Shop)', async () => {
  updateSettings({ platform: 'shopify' });
  const s = getSession('chat-shopify');
  assert.equal(s.platform, 'shopify');
  const events: ChatEvent[] = []; s.emit = ev => { events.push(ev); };
  const tools = buildTools(s);
  assert.deepEqual(tools.map(t => t.name), toolNamesFor('shopify'));
  await assert.rejects(s.sw.search('product'), /nur für Shopware/);

  const draft = await call(tools, 'draft_page', { name: 'Sommer', type: 'landingpage', sections: [{ blocks: [{ type: 'text-hero', html: '<h1>Sommer im Garten</h1>' }, { type: 'pattern', pattern: 'faq', data: { title: 'Fragen', items: [{ q: 'A?', a: 'B.' }, { q: 'C?', a: 'D.' }] } }] }] });
  assert.equal(draft.isError ?? false, false, draft.content[0].text);
  assert.ok(events.some(e => e.t === 'draft'));
  assert.match(draft.content[0].text, /Entwurf "Sommer"/);

  const bad = await call(tools, 'draft_page', { name: 'Liste', type: 'product_list', sections: [{ blocks: [{ type: 'product-listing' }] }] });
  assert.equal(bad.isError, true); assert.match(bad.content[0].text, /product-listing gibt es in Shopify nicht/);

  const pub = await call(tools, 'publish_page', { target: 'product' });
  assert.equal(pub.isError, true); assert.match(pub.content[0].text, /passt nicht zu target=product/);
  const pub2 = await call(tools, 'publish_page', { target: 'landingpage' });
  assert.equal(pub2.isError, true, 'ohne erreichbaren Shop kein Änderungsset'); assert.doesNotMatch(pub2.content[0].text, /noch nicht verfügbar/);
});

test('Kategorie-/Kollektionsseite (product_list) aus generischen Blöcken auf Shopify, Magento und OpenMage', async () => {
  for (const platform of ['shopify', 'magento', 'openmage'] as const) {
    updateSettings({ platform });
    const s = getSession(`chat-list-${platform}`);
    const events: ChatEvent[] = []; s.emit = ev => { events.push(ev); };
    const tools = buildTools(s);
    // Shopify: Theme-Vorlage, theme-main markiert die Produktliste (Pflicht); Magento: nur Inhalt, kein theme-main
    const main = platform === 'shopify' ? [{ type: 'theme-main' }] : [];
    const r = await call(tools, 'draft_page', { name: 'Vasen', type: 'product_list', previewCategoryId: 'c1', sections: [{ blocks: [{ type: 'text', html: '<h2>Hallo</h2>' }, ...main, { type: 'pattern', pattern: 'faq', data: { title: 'Fragen', items: [{ q: 'A?', a: 'B.' }, { q: 'C?', a: 'D.' }] } }] }] });
    assert.equal(r.isError ?? false, false, `${platform}: ${r.content[0].text}`);
    assert.ok(events.some(e => e.t === 'draft' && e.pageType === 'product_list'), platform);
    const pdp = await call(tools, 'draft_page', { name: 'P', type: 'product_detail', sections: [{ blocks: [{ type: 'text', html: '<p>x</p>' }] }] });
    if (platform === 'shopify') {
      assert.equal(pdp.isError, true, `${platform}: product_detail ohne theme-main`);
      assert.match(pdp.content[0].text, /genau einen theme-main/);
      const noMain = await call(tools, 'draft_page', { name: 'Vasen', type: 'product_list', sections: [{ blocks: [{ type: 'text', html: '<h2>Hallo</h2>' }] }] });
      assert.equal(noMain.isError, true); assert.match(noMain.content[0].text, /genau einen theme-main/);
      const lpMain = await call(tools, 'draft_page', { name: 'LP', type: 'landingpage', sections: [{ blocks: [{ type: 'theme-main' }] }] });
      assert.equal(lpMain.isError, true); assert.match(lpMain.content[0].text, /theme-main nur bei/);
    } else {
      assert.equal(pdp.isError ?? false, false, `${platform}: Produktinhalt (product_detail) aus generischen Blöcken`);
      const m = await call(tools, 'draft_page', { name: 'Vasen', type: 'product_list', sections: [{ blocks: [{ type: 'theme-main' }] }] });
      assert.equal(m.isError, true); assert.match(m.content[0].text, new RegExp(`theme-main gibt es in ${platform === 'magento' ? 'Magento' : 'OpenMage'} nicht`));
    }
    const pdpBlock = await call(tools, 'draft_page', { name: 'P', type: 'product_detail', sections: [{ blocks: [{ type: 'pdp-gallery-buybox' }, ...main] }] });
    assert.equal(pdpBlock.isError, true, `${platform}: pdp-Blöcke nur in Shopware`);
  }
  updateSettings({ platform: 'shopify' });
});

test('Änderungsset bekommt die Plattform der Session; Plattformwechsel baut ruhende Sessions neu auf', async () => {
  const s = getSession('chat-shopify');
  let approvalId = '';
  s.emit = ev => { s.events.push(ev); if (ev.t === 'changeset') approvalId = ev.approvalId; };
  const cs = { id: 'cs-1', kind: 'products', entity: 'product', title: 'Test', reason: null, atomic: false, skipped: [], items: [{ id: 'i1', entity: 'product', entityId: 'p1', label: 'P', field: 'name', fieldLabel: 'Name', before: 'a', after: 'b', afterRaw: 'b', warn: [] }] };
  const pending = s.requestChange(cs);
  await new Promise(r => setTimeout(r, 5));
  assert.equal((cs as { platform?: string }).platform, 'shopify');
  assert.ok(decideChange('chat-shopify', approvalId, true));
  const out = await pending;
  assert.equal(out.status, 'failed', 'ohne eingerichteten Shop wird nichts geschrieben'); assert.match(JSON.stringify(out.failed), /Ungültige ID|Shop-Domain fehlt/);

  updateSettings({ platform: 'shopware' });
  const again = getSession('chat-shopify');
  assert.equal(again.platform, 'shopware');
  assert.notEqual(again, s);
  assert.equal(peekSession('chat-shopify'), again);
  assert.ok(again.events.some(e => e.t === 'changeset_result'), 'Verlauf bleibt erhalten');
});
