import 'server-only';
// Shopify: brand signals for the style guide onboarding (get_brand_signals). Theme settings from config/settings_data.json of the
// published theme (only design values: colors, fonts, radii, buttons; fixed query via the privileged client, never app settings)
// and text samples of products and collections via the AI's protected read client.
import { getSettings } from '../../settings';
import { plainFields, sampleText, type BrandSources } from '../../styleguide';
import type { Json, ShopifyClient } from './client';
import type { ShopifyReader } from './reader';
import { mainTheme, readThemeFiles } from './theme';

const SETTINGS = 'config/settings_data.json';
/** Design keys of common themes (Dawn & co.): colors, color schemes, typography, radii, buttons, borders, spacing */
const DESIGN = /colou?r|scheme|gradient|font|type_|heading|body_scale|radius|button|border|shadow|spacing|logo_width|page_width/i;

/** Current settings of settings_data.json (current is the object itself or the name of a preset); color schemes flattened */
export function themeDesign(text: string): Record<string, unknown> {
  const j: Json = JSON.parse(String(text ?? '').replace(/^\s*\/\*[\s\S]*?\*\/\s*/, ''));
  const cur: Json = typeof j.current === 'string' ? j.presets?.[j.current] ?? {} : j.current ?? {};
  const flat: Record<string, unknown> = { ...cur };
  for (const [id, sc] of Object.entries((cur.color_schemes ?? {}) as Json)) for (const [k, v] of Object.entries(((sc as Json)?.settings ?? {}) as Json)) flat[`color_schemes.${id}.${k}`] = v;
  return plainFields(flat, k => DESIGN.test(k));
}

export const shopifyBrandSources = (reader: ShopifyReader, client: () => ShopifyClient): BrandSources => ({
  async theme() {
    if (getSettings().scopes.shop === false) return null; // theme settings belong to "Shop-Grunddaten" like on Shopware
    const t = await mainTheme(client()), raw = (await readThemeFiles(client(), t.id, [SETTINGS])).get(SETTINGS);
    reader.noteRead('theme', 1); // fixed query via the privileged client: still in the access log, like on Shopware
    return { name: t.name, fields: raw ? themeDesign(raw) : {} };
  },
  async samples() {
    const d = await reader.query<Json>('query BrandSamples { products(first: 6, query: "status:active") { nodes { title descriptionHtml } } collections(first: 6) { nodes { title descriptionHtml } } }');
    const rows = (c: Json) => ((c?.nodes ?? []) as Json[]).map(x => ({ name: x.title, text: sampleText(x.descriptionHtml) }));
    return { products: rows(d.products), categories: rows(d.collections) };
  },
});
