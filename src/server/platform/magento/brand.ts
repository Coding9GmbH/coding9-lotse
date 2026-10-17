import 'server-only';
// Magento 2: brand signals for the style guide onboarding (get_brand_signals). Magento has no REST interface for the theme's
// design settings, so colors and fonts come from the storefront CSS (core); here only text samples via the protected read client.
import { sampleText, type BrandSources } from '../../styleguide';
import { attr } from './map';
import type { MagentoReader } from './reader';

export const magentoBrandSources = (reader: MagentoReader): BrandSources => ({
  async samples() {
    const [p, c] = await Promise.all([
      reader.products({ filters: [[{ field: 'status', value: 1 }], [{ field: 'visibility', value: [2, 3, 4], condition_type: 'in' }]], pageSize: 6 }),
      reader.categories({ filters: [[{ field: 'level', value: 2, condition_type: 'gteq' }], [{ field: 'is_active', value: 1 }]], pageSize: 6 }),
    ]);
    return {
      products: p.items.map(x => ({ name: String(x.name ?? x.sku), text: sampleText(attr(x, 'description') ?? attr(x, 'short_description')) })),
      categories: c.items.map(x => ({ name: String(x.name ?? x.id), text: sampleText(attr(x, 'description')) })),
    };
  },
});
