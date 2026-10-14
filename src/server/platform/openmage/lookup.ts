import 'server-only';
// OpenMage: platform-neutral read functions (ShopLookup) via the guarded read client: knowledge base, Search Console, view_image.
import type { PageRef } from '../../features/gsc-map';
import type { ShopLookup } from '../types';
import { relPath } from '../magento/lookup';
import { categoryPath, isActive, omStr, parseMediaId, productPath, type OmRecord } from './map';
import type { OmReader } from './reader';

/** Category IDs including parents (without root 1) from the paths of a product's categories */
export async function categoryIdsWithParents(ro: OmReader, cats: { id: number; path?: string | null }[]): Promise<string[]> {
  const out = new Set<string>();
  for (const c of cats.slice(0, 30)) { const path = c.path ?? (await ro.category(c.id, 'admin').catch(() => null))?.path ?? String(c.id); for (const x of String(path).split('/')) if (x && x !== '1') out.add(x); }
  return [...out];
}

export function omLookup(ro: OmReader): ShopLookup {
  const bases = async () => [await ro.storefrontBase().catch(() => ''), ro.publicUrl, ro.base];
  return {
    async findProducts({ ids = [], numbers = [] }) {
      const found = [...await ro.productsByIds(ids), ...await ro.productsBySkus(numbers)];
      return found.map(p => ({ id: String(p.id), number: p.sku, name: p.name ?? undefined }));
    },
    async findCategories(ids) {
      const out: { id: string; name?: string }[] = [];
      for (const id of ids) { const c = await ro.category(id); if (c) out.push({ id: String(c.id), name: c.name ?? undefined }); }
      return out;
    },
    async getProduct(id) {
      const p = await ro.productByRef(String(id));
      if (!p) return null;
      return { id: String(p.id), number: p.sku, name: p.name ?? undefined, ean: omStr(p, 'ean') ?? omStr(p, 'gtin') ?? undefined, categoryIds: await categoryIdsWithParents(ro, p.categories ?? (p.category_ids ?? []).map(id => ({ id }))) };
    },
    async mediaUrl(id) {
      const m = parseMediaId(id);
      if (!m) return undefined;
      const p = await ro.productById(m.productId, 'admin');
      return ro.mediaUrl(p?.images?.find(e => e.id === m.imageId)?.file);
    },
    async mapUrls(urls, o = {}) {
      const out = new Map<string, PageRef | null>(), bs = await bases();
      for (const url of urls) {
        const path = relPath(url, bs);
        if (path == null) { out.set(url, null); continue; }
        const r = await ro.resolveUrl(path).catch(() => null);
        if (!r) { out.set(url, null); continue; }
        if (r.type === 'HOME') { out.set(url, { kind: 'home' }); continue; }
        if (r.type === 'PRODUCT' && r.id != null) {
          const p = await ro.productById(r.id);
          out.set(url, p ? { kind: 'product', id: String(p.id), name: p.name ?? undefined, number: p.sku, active: isActive(p), ...(o.metas ? { metaTitle: omStr(p, 'meta_title'), metaDescription: omStr(p, 'meta_description') } : {}) } : null);
        } else if (r.type === 'CATEGORY' && r.id != null) {
          const c = await ro.category(r.id);
          out.set(url, c ? { kind: 'category', id: String(c.id), name: c.name ?? undefined, active: !!c.is_active, ...(o.metas ? { metaTitle: omStr(c, 'meta_title'), metaDescription: omStr(c, 'meta_description') } : {}) } : null);
        } else if (r.type === 'CMS_PAGE' && r.id != null) {
          const pg = await ro.cmsPage(r.id).catch(() => null);
          out.set(url, pg ? { kind: 'landing', id: String(pg.id), name: pg.title, active: !!pg.is_active, ...(o.metas ? { metaTitle: pg.title ?? null, metaDescription: pg.meta_description ?? null } : {}) } : null);
        } else out.set(url, null);
      }
      return out;
    },
    async entityPaths(kind, id) {
      const sf = await ro.suffixes(), base = (await bases())[0] || ro.publicUrl;
      let paths: string[] = [];
      if (kind === 'product') { const p = await ro.productByRef(id); const k = p ? productPath(p, sf.product) : null; if (k) paths = [k]; }
      else if (kind === 'category') { const c = await ro.category(id); const k = c ? categoryPath(c, sf.category) : null; if (k) paths = [k]; }
      else { const pg = await ro.cmsPage(id); if (pg?.identifier) paths = [String(pg.identifier)]; }
      return { paths, urls: paths.map(p => `${base.replace(/\/+$/, '')}/${p}`) };
    },
    async current(entity, id): Promise<OmRecord | null> {
      if (entity === 'product') { const p = await ro.productByRef(id); return p ? { id: String(p.id), name: p.name, active: isActive(p), metaTitle: omStr(p, 'meta_title'), metaDescription: omStr(p, 'meta_description'), description: omStr(p, 'description') } : null; }
      if (entity === 'category') { const c = await ro.category(id); return c ? { id: String(c.id), name: c.name, active: !!c.is_active, metaTitle: omStr(c, 'meta_title'), metaDescription: omStr(c, 'meta_description'), description: omStr(c, 'description') } : null; }
      if (entity === 'landing-page') { const pg = await ro.cmsPage(id); return pg ? { id: String(pg.id), name: pg.title, active: !!pg.is_active, metaTitle: pg.title ?? null, metaDescription: pg.meta_description ?? null } : null; }
      return null;
    },
  };
}
