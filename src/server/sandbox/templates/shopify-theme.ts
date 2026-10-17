// Shopify theme (prepared, DISABLED): a template without a container. The repository is an Online Store 2.0 theme; Lotse would push
// the workspace to an unpublished theme it creates itself (themeCreate role UNPUBLISHED) and show the storefront with
// ?preview_theme_id=<id>. Writing is the job of a human-triggered executor that does not exist yet; the live theme is never written.
import fs from 'node:fs';
import path from 'node:path';
import type { ContainerlessTemplate } from './types';

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;

export const shopifyTheme: ContainerlessTemplate = {
  id: 'shopify-theme',
  labelKey: 'shopify-theme',
  platform: 'shopify',
  runtime: 'none',
  enabled: false,
  target: 'unpublished-theme',
  previewProvider: {
    kind: 'platform',
    previewUrl: ({ shopDomain, themeId }) => {
      if (!SHOP_DOMAIN.test(shopDomain) || !Number.isSafeInteger(themeId) || themeId < 1) throw new Error('Ungültiger Shop oder ungültige Theme-ID.');
      return `https://${shopDomain}/?preview_theme_id=${themeId}`;
    },
  },
  checkRepo: worktree => {
    for (const f of ['layout/theme.liquid', 'config/settings_schema.json']) {
      if (!fs.existsSync(path.join(worktree, f))) throw new Error(`Kein Shopify-Theme erkannt: ${f} fehlt.`);
    }
  },
};
