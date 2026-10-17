import 'server-only';
// OpenMage: brand signals for the style guide onboarding (get_brand_signals). Magento 1 has no interface for the theme's design
// settings, so colors and fonts come from the storefront CSS (core); here only text samples via the protected read client.
import { sampleText, type BrandSources } from '../../styleguide';
import { omAttr } from './map';
import type { OmReader } from './reader';

export const omBrandSources = (reader: OmReader): BrandSources => ({
  async samples() {
    const [p, flat] = await Promise.all([reader.products({ status: 1, limit: 6, fields: 'description,short_description' }), reader.categoriesFlat()]);
    // the flat list has no texts: read the first active categories below the root one by one (at most 6)
    const cats = (await Promise.all(flat.filter(c => Number(c.level) >= 2 && c.is_active !== false).slice(0, 6).map(c => reader.category(c.id)))).filter(c => c != null);
    return {
      products: p.items.map(x => ({ name: String(x.name ?? x.sku), text: sampleText(omAttr(x, 'description') ?? omAttr(x, 'short_description')) })),
      categories: cats.map(x => ({ name: String(x.name ?? x.id), text: sampleText(omAttr(x, 'description')) })),
    };
  },
});
