import 'server-only';
// Shopware: plattform-neutrale Lesefunktionen (ShopLookup) über den geschützten Lese-Client.
import { entityPaths, mapUrls } from '../../features/gsc-map';
import type { ShopReader, SwEntity } from '../../shopware';
import type { ShopLookup } from '../types';

const pname = (p: SwEntity) => p.translated?.name ?? p.name ?? p.productNumber;

export function shopwareLookup(ro: ShopReader): ShopLookup {
  return {
    async findProducts({ ids = [], numbers = [] }) {
      const found: SwEntity[] = [];
      if (ids.length) found.push(...(await ro.search('product', { ids, limit: ids.length })).data);
      if (numbers.length) found.push(...(await ro.search('product', { filter: [{ type: 'equalsAny', field: 'productNumber', value: numbers }], limit: numbers.length })).data);
      return found.map(p => ({ id: p.id, number: p.productNumber, name: pname(p) }));
    },
    async findCategories(ids) {
      if (!ids.length) return [];
      return (await ro.search('category', { ids, limit: ids.length })).data.map(c => ({ id: c.id, name: c.translated?.name ?? c.name }));
    },
    async getProduct(id) {
      const p = await ro.get('product', id);
      return p ? { id: p.id, number: p.productNumber, name: pname(p), ean: p.ean, categoryIds: p.categoryTree ?? [] } : null;
    },
    mediaUrl: async id => (await ro.get('media', id))?.url,
    mapUrls: (urls, o) => mapUrls(ro, urls, o),
    entityPaths: (kind, id) => entityPaths(ro, kind, id),
    current: (entity, id) => ro.get(entity, id),
  };
}

/** Altbestand/Tests: Funktionen, die früher einen Shopware-Lese-Client bekamen, nehmen weiter beides an. */
export const asLookup = (x: ShopReader | ShopLookup): ShopLookup => ('mapUrls' in x && typeof x.mapUrls === 'function' ? x as ShopLookup : shopwareLookup(x as ShopReader));
