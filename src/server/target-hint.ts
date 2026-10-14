// Hint about the target from the context selection (category, product, landing page) for the first chat message.
// Follows the platform's capabilities: page types unknown to draft_page/publish_page are never suggested.
import type { Target } from '@/lib/protocol';
import type { PlatformCapabilities } from './platform/types';

type Caps = Pick<PlatformCapabilities, 'pageTypes' | 'publishTargets' | 'pageFormat'> & { blocks?: PlatformCapabilities['blocks'] };
const themed = (caps: Caps) => Array.isArray(caps.blocks) && caps.blocks.includes('theme-main');

export function targetHint(target: Target | null | undefined, caps: Caps): string {
  if (!target) return '';
  const name = target.name ?? '', id = target.id ?? '';
  if (target.kind === 'category') {
    if (caps.pageTypes.includes('product_list') && caps.publishTargets.includes('category'))
      return caps.pageFormat === 'cms'
        ? `[Ziel: Kategorie "${name}" (categoryId=${id}) – Layout-Typ product_list, previewCategoryId=${id}]`
        : themed(caps)
          ? `[Ziel: Kategorie "${name}" (categoryId=${id}): Seitentyp product_list = eigene Inhalte über und unter der Produktliste des Themes; genau ein theme-main-Block markiert die Stelle der Produktliste (kein product-listing-Block), previewCategoryId=${id}, veröffentlichen mit publish_page target=category]`
          : `[Ziel: Kategorie "${name}" (categoryId=${id}): Seitentyp product_list = Inhalt der Kategorie aus den verfügbaren Blöcken (die Produktliste liefert das Theme, kein product-listing-Block), previewCategoryId=${id}, veröffentlichen mit publish_page target=category]`;
    return `[Ziel: Kategorie "${name}" (categoryId=${id}): Texte, Daten und SEO der Kategorie über die vorhandenen Werkzeuge; eine eigene Seite dazu nur als freie Landingpage (landingpage)]`;
  }
  if (target.kind === 'product') {
    if (caps.pageTypes.includes('product_detail') && caps.publishTargets.includes('product'))
      return caps.pageFormat === 'cms'
        ? `[Ziel: Produkt "${name}" (productId=${id}) – Layout-Typ product_detail, previewProductId=${id}]`
        : themed(caps)
          ? `[Ziel: Produkt "${name}" (productId=${id}): Seitentyp product_detail = eigene Inhalte über und unter dem Produktbereich des Themes; genau ein theme-main-Block markiert Galerie, Kaufbox und Beschreibung (keine pdp-Blöcke), previewProductId=${id}, veröffentlichen mit publish_page target=product]`
          : `[Ziel: Produkt "${name}" (productId=${id}): Texte, Daten und SEO über die vorhandenen Werkzeuge (z. B. propose_product_changes); gestalteter Inhalt der Produktbeschreibung als Seitentyp product_detail aus den verfügbaren Blöcken (Galerie, Preis und Warenkorb liefert das Theme, keine pdp-Blöcke), previewProductId=${id}, veröffentlichen mit publish_page target=product]`;
    const landing = caps.pageTypes.includes('landingpage') ? `; eine Seite dazu nur als freie Landingpage (landingpage), die das Produkt zeigt (z. B. product-slider mit productIds=["${id}"])` : '';
    return `[Ziel: Produkt "${name}" (productId=${id}): Texte, Daten und SEO des Produkts über die vorhandenen Werkzeuge (z. B. propose_product_changes, falls verfügbar)${landing}. Ein Produktseiten-Layout (product_detail) gibt es auf dieser Plattform nicht]`;
  }
  return '[Ziel: neue freie Landingpage (landingpage)]';
}
