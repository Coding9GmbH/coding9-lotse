import 'server-only';
// Magento: plattform-neutrale Lesefunktionen (ShopLookup) über den geschützten Lese-Client – Wissensbasis, Search Console, view_image.
import type { PageRef } from '../../features/gsc-map';
import type { ShopLookup } from '../types';
import { attrStr, isActive, parseMediaId, type MRecord } from './map';
import type { MagentoReader } from './reader';

/** Kategorien-IDs inkl. Eltern (ohne Wurzel 1) aus den Pfaden der Kategorien eines Produkts */
async function categoryIdsWithParents(ro: MagentoReader, ids: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const id of ids.slice(0, 30)) { const c = await ro.category(id).catch(() => null); for (const x of String(c?.path ?? id).split('/')) if (x && x !== '1') out.add(x); }
  return [...out];
}
export const productCategoryIds = (p: MRecord): string[] => [...new Set([...((p.extension_attributes?.category_links ?? []) as { category_id: string }[]).map(l => String(l.category_id)), ...(((p.custom_attributes ?? []) as { attribute_code: string; value: unknown }[]).find(a => a.attribute_code === 'category_ids')?.value as string[] | undefined ?? []).map(String)])];

/** Pfad einer Storefront-URL relativ zur Shop-Basis (ohne führenden Slash, ohne Query) */
export function relPath(url: string, bases: string[]): string | null {
  let u: URL; try { u = new URL(url); } catch { return null; }
  for (const b of bases) { if (!b) continue; let bu: URL; try { bu = new URL(b); } catch { continue; } if (bu.host !== u.host) continue; const pre = bu.pathname.replace(/\/+$/, ''); if (u.pathname.startsWith(pre)) return u.pathname.slice(pre.length).replace(/^\/+/, ''); }
  return null;
}

export function magentoLookup(ro: MagentoReader): ShopLookup {
  const suffixes = () => ro.storefrontConfig().catch(() => ({ product_url_suffix: '.html', category_url_suffix: '.html' }));
  const bases = async () => [await ro.storefrontBase().catch(() => ''), ro.publicUrl, ro.base];
  return {
    async findProducts({ ids = [], numbers = [] }) {
      const found = [...await ro.productsByIds(ids), ...await ro.productsBySkus(numbers)];
      return found.map(p => ({ id: String(p.id), number: p.sku, name: p.name }));
    },
    async findCategories(ids) {
      const out: { id: string; name?: string }[] = [];
      for (const id of ids) { const c = await ro.category(id); if (c) out.push({ id: String(c.id), name: c.name }); }
      return out;
    },
    async getProduct(id) {
      const p = await ro.productByRef(String(id));
      if (!p) return null;
      return { id: String(p.id), number: p.sku, name: p.name, ean: attrStr(p, 'ean') ?? attrStr(p, 'gtin') ?? undefined, categoryIds: await categoryIdsWithParents(ro, productCategoryIds(p)) };
    },
    async mediaUrl(id) {
      const m = parseMediaId(id);
      if (!m) return undefined;
      const [p] = await ro.productsByIds([m.productId], 'all');
      return ro.mediaUrl(p?.media_gallery_entries?.find(e => e.id === m.entryId)?.file);
    },
    async mapUrls(urls, o = {}) {
      const out = new Map<string, PageRef | null>(), bs = await bases();
      for (const url of urls) {
        const path = relPath(url, bs);
        if (path == null) { out.set(url, null); continue; }
        if (path === '' || path === 'index.php') { out.set(url, { kind: 'home' }); continue; }
        const r = await ro.resolveUrl(path).catch(() => null);
        if (!r) { out.set(url, null); continue; }
        if (r.type === 'PRODUCT' && r.sku) {
          const p = await ro.product(r.sku);
          out.set(url, p ? { kind: 'product', id: String(p.id), name: p.name, number: p.sku, active: isActive(p), ...(o.metas ? { metaTitle: attrStr(p, 'meta_title'), metaDescription: attrStr(p, 'meta_description') } : {}) } : null);
        } else if (r.type === 'CATEGORY' && r.id != null) {
          const c = await ro.category(r.id);
          out.set(url, c ? { kind: 'category', id: String(c.id), name: c.name, active: !!c.is_active, ...(o.metas ? { metaTitle: attrStr(c, 'meta_title'), metaDescription: attrStr(c, 'meta_description') } : {}) } : null);
        } else if (r.type === 'CMS_PAGE' && r.identifier) {
          const pg = (await ro.cmsPages({ filters: [[{ field: 'identifier', value: r.identifier }]], pageSize: 1 }).catch(() => ({ items: [] as MRecord[] }))).items[0];
          out.set(url, pg ? { kind: 'landing', id: String(pg.id), name: pg.title, active: !!pg.active, ...(o.metas ? { metaTitle: pg.meta_title ?? null, metaDescription: pg.meta_description ?? null } : {}) } : null);
        } else out.set(url, null);
      }
      return out;
    },
    async entityPaths(kind, id) {
      const sf = await suffixes(), base = (await bases())[0] || ro.publicUrl;
      let paths: string[] = [];
      if (kind === 'product') { const p = await ro.productByRef(id); const k = attrStr(p, 'url_key'); if (k) paths = [`${k}${sf.product_url_suffix ?? ''}`]; }
      else if (kind === 'category') { const c = await ro.category(id); const k = attrStr(c, 'url_path') ?? attrStr(c, 'url_key'); if (k) paths = [`${k}${sf.category_url_suffix ?? ''}`]; }
      else { const pg = (await ro.cmsPages({ filters: [[{ field: 'page_id', value: id }]], pageSize: 1 })).items[0]; if (pg?.identifier) paths = [String(pg.identifier)]; }
      return { paths, urls: paths.map(p => `${base.replace(/\/+$/, '')}/${p}`) };
    },
    async current(entity, id) {
      if (entity === 'product') { const p = await ro.productByRef(id); return p ? { id: String(p.id), name: p.name, active: isActive(p), metaTitle: attrStr(p, 'meta_title'), metaDescription: attrStr(p, 'meta_description'), description: attrStr(p, 'description') } : null; }
      if (entity === 'category') { const c = await ro.category(id); return c ? { id: String(c.id), name: c.name, active: !!c.is_active, metaTitle: attrStr(c, 'meta_title'), metaDescription: attrStr(c, 'meta_description'), description: attrStr(c, 'description') } : null; }
      if (entity === 'landing-page') { const pg = (await ro.cmsPages({ filters: [[{ field: 'page_id', value: id }]], pageSize: 1 })).items[0]; return pg ? { id: String(pg.id), name: pg.title, active: !!pg.active, metaTitle: pg.meta_title ?? null, metaDescription: pg.meta_description ?? null } : null; }
      return null;
    },
  };
}
