import 'server-only';
// Shopify: Mutationen + Rückgängig-Schritte. UndoOps sind reine Daten (GraphQL-Mutation + Variablen, ohne Token):
// { op: 'req', path: 'graphql', body: { query, variables } } bzw. { op: 'delete', entity, id } für angelegte Objekte.
import type { UndoOp } from '@/lib/protocol';
import { errMsg } from '../../changes';
import { ShopifyError, type Json, type ShopifyClient } from './client';
import { deleteSectionIfUnused, LOTSE_FILE } from './theme';

export const M = {
  productUpdate: 'mutation ProductUpdate($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id handle } userErrors { field message } } }',
  productCreate: 'mutation ProductCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) { productCreate(product: $product, media: $media) { product { id handle variants(first: 1) { nodes { id } } } userErrors { field message } } }',
  productDelete: 'mutation ProductDelete($id: ID!) { productDelete(input: { id: $id }) { deletedProductId userErrors { field message } } }',
  productMediaAdd: 'mutation ProductMediaAdd($product: ProductUpdateInput!, $media: [CreateMediaInput!]) { productUpdate(product: $product, media: $media) { product { id media(first: 250) { nodes { id } } } userErrors { field message } } }',
  variantsUpdate: 'mutation VariantsUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id } userErrors { field message code } } }',
  variantsCreate: 'mutation VariantsCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkCreate(productId: $productId, variants: $variants) { productVariants { id title } userErrors { field message code } } }',
  variantsCreateStrategy: 'mutation VariantsCreateStrategy($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy) { productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) { productVariants { id title } userErrors { field message code } } }',
  variantsDelete: 'mutation VariantsDelete($productId: ID!, $variantsIds: [ID!]!) { productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) { product { id } userErrors { field message code } } }',
  reorderMedia: 'mutation ReorderMedia($id: ID!, $moves: [MoveInput!]!) { productReorderMedia(id: $id, moves: $moves) { job { id } mediaUserErrors { field message code } } }',
  fileUpdate: 'mutation FileUpdate($files: [FileUpdateInput!]!) { fileUpdate(files: $files) { files { id } userErrors { field message code } } }',
  fileDelete: 'mutation FileDelete($ids: [ID!]!) { fileDelete(fileIds: $ids) { deletedFileIds userErrors { field message code } } }',
  metafieldsSet: 'mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message code } } }',
  metafieldsDelete: 'mutation MetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) { metafieldsDelete(metafields: $metafields) { deletedMetafields { key } userErrors { field message } } }',
  collectionUpdate: 'mutation CollectionUpdate($input: CollectionInput!) { collectionUpdate(input: $input) { collection { id handle } userErrors { field message } } }',
  collectionCreate: 'mutation CollectionCreate($input: CollectionInput!) { collectionCreate(input: $input) { collection { id handle } userErrors { field message } } }',
  collectionDelete: 'mutation CollectionDelete($id: ID!) { collectionDelete(input: { id: $id }) { deletedCollectionId userErrors { field message } } }',
  collectionAdd: 'mutation CollectionAdd($id: ID!, $productIds: [ID!]!) { collectionAddProducts(id: $id, productIds: $productIds) { collection { id } userErrors { field message } } }',
  collectionReorder: 'mutation CollectionReorder($id: ID!, $moves: [MoveInput!]!) { collectionReorderProducts(id: $id, moves: $moves) { job { id } userErrors { field message } } }',
  collectionRemove: 'mutation CollectionRemove($id: ID!, $productIds: [ID!]!) { collectionRemoveProducts(id: $id, productIds: $productIds) { job { id } userErrors { field message } } }',
  publish: 'mutation Publish($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { field message } } }',
  unpublish: 'mutation Unpublish($id: ID!, $input: [PublicationInput!]!) { publishableUnpublish(id: $id, input: $input) { userErrors { field message } } }',
  pageUpdate: 'mutation PageUpdate($id: ID!, $page: PageUpdateInput!) { pageUpdate(id: $id, page: $page) { page { id handle } userErrors { field message code } } }',
  pageDelete: 'mutation PageDelete($id: ID!) { pageDelete(id: $id) { deletedPageId userErrors { field message code } } }',
  translationsRegister: 'mutation TranslationsRegister($resourceId: ID!, $translations: [TranslationInput!]!) { translationsRegister(resourceId: $resourceId, translations: $translations) { translations { key locale } userErrors { field message code } } }',
  translationsRemove: 'mutation TranslationsRemove($resourceId: ID!, $translationKeys: [String!]!, $locales: [String!]!) { translationsRemove(resourceId: $resourceId, translationKeys: $translationKeys, locales: $locales) { translations { key } userErrors { field message code } } }',
  discountCreate: 'mutation DiscountCreate($input: DiscountCodeBasicInput!) { discountCodeBasicCreate(basicCodeDiscount: $input) { codeDiscountNode { id } userErrors { field message code } } }',
  discountUpdate: 'mutation DiscountUpdate($id: ID!, $input: DiscountCodeBasicInput!) { discountCodeBasicUpdate(id: $id, basicCodeDiscount: $input) { codeDiscountNode { id } userErrors { field message code } } }',
  discountDelete: 'mutation DiscountDelete($id: ID!) { discountCodeDelete(id: $id) { deletedCodeDiscountId userErrors { field message code } } }',
  discountActivate: 'mutation DiscountActivate($id: ID!) { discountCodeActivate(id: $id) { codeDiscountNode { id } userErrors { field message code } } }',
  discountDeactivate: 'mutation DiscountDeactivate($id: ID!) { discountCodeDeactivate(id: $id) { codeDiscountNode { id } userErrors { field message code } } }',
  redirectDelete: 'mutation RedirectDelete($id: ID!) { urlRedirectDelete(id: $id) { deletedUrlRedirectId userErrors { field message code } } }',
  pageCreate: 'mutation PageCreate($page: PageCreateInput!) { pageCreate(page: $page) { page { id handle } userErrors { field message code } } }',
  fileCreate: 'mutation FileCreate($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { id fileStatus ... on MediaImage { image { url } } } userErrors { field message code } } }',
  themeFilesUpsert: 'mutation ThemeFilesUpsert($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) { themeFilesUpsert(themeId: $themeId, files: $files) { upsertedThemeFiles { filename } job { id } userErrors { field message code filename } } }',
  themeFilesDelete: 'mutation ThemeFilesDelete($themeId: ID!, $files: [String!]!) { themeFilesDelete(themeId: $themeId, files: $files) { deletedThemeFiles { filename } userErrors { field message code filename } } }',
  stagedUploads: 'mutation StagedUploads($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }',
} as const;

/** erstes Root-Feld einer Mutation (für userErrors-Prüfung) */
export const rootOf = (query: string) => /^\s*mutation\b[^{]*\{\s*(\w+)/.exec(query)?.[1] ?? '';
/** Mutation ausführen (userErrors → Fehler) */
export const run = <T = Json>(client: ShopifyClient, query: string, variables: Json) => client.mutate<T>(query, variables, rootOf(query));

/** Shopify hat nichts geändert (userErrors): dann braucht es keinen Rückgängig-Schritt */
export const isUserError = (e: unknown) => e instanceof ShopifyError && e.code === 'USER_ERROR';
/**
 * Mutation ausführen und ihre Rückgängig-Schritte (Vorher-Werte, VOR der Mutation gebaut) in undo vermerken: nach Erfolg, aber auch
 * wenn der Ausgang unklar ist (Netzfehler, Zeitlimit, 5xx: die Mutation kann trotzdem gewirkt haben). Nur bei userErrors nicht.
 * Jede schreibende Mutation des Adapters läuft hierüber oder über runCreating; run() nur, wo ein früherer Schritt das Rückgängig schon abdeckt.
 */
export async function runRecording<T = Json>(client: ShopifyClient, query: string, variables: Json, undo: UndoOp[], back: UndoOp | UndoOp[]): Promise<T> {
  const ops = Array.isArray(back) ? back : [back];
  try { const r = await run<T>(client, query, variables); undo.push(...ops); return r; }
  catch (e) { if (!isUserError(e)) undo.push(...ops); throw e; }
}
/**
 * Anlegen (ID erst nach der Antwort bekannt): ids() liefert die Kandidaten (z. B. per Titel/Handle) vorher und, bei unklarem Ausgang,
 * nachher; neu hinzugekommene werden zum Löschen vorgemerkt. Nach Erfolg vermerkt der Aufrufer das Löschen der gelieferten ID selbst.
 */
export async function runCreating<T = Json>(client: ShopifyClient, query: string, variables: Json, undo: UndoOp[], entity: keyof typeof DELETE, ids: () => Promise<string[]>): Promise<T> {
  const before = new Set(await ids());
  try { return await run<T>(client, query, variables); }
  catch (e) {
    if (!isUserError(e)) { try { for (const id of await ids()) if (!before.has(id)) undo.push(deleteOp(entity, id)); } catch { /* nicht lesbar: kein Schritt möglich */ } }
    throw e;
  }
}

/** Rückgängig-Schritt als roher GraphQL-Aufruf */
export const reqOp = (entity: string, id: string, query: string, variables: Json): UndoOp => ({ op: 'req', entity, id, method: 'POST', path: 'graphql', body: { query, variables } });
/** angelegtes Objekt wieder löschen */
export const deleteOp = (entity: keyof typeof DELETE, id: string): UndoOp => ({ op: 'delete', entity, id });

const DELETE = {
  product: (id: string) => [M.productDelete, { id }],
  collection: (id: string) => [M.collectionDelete, { id }],
  discount: (id: string) => [M.discountDelete, { id }],
  redirect: (id: string) => [M.redirectDelete, { id }],
  file: (id: string) => [M.fileDelete, { ids: [id] }],
  page: (id: string) => [M.pageDelete, { id }],
} satisfies Record<string, (id: string) => [string, Json]>;
/**
 * Nur diese Dokumente aus M (wortgleich) sind als Rückgängig-Schritt erlaubt: genau die, die ein Executor per reqOp vermerkt. Gespeicherte
 * Schritte können nichts anderes auslösen (kein Anlegen, keine weiteren Root-Felder); publish/unpublish nur für das Sichtbarkeits-Rückgängig.
 */
const UNDO_QUERIES = new Set<string>([M.productUpdate, M.variantsUpdate, M.variantsDelete, M.reorderMedia, M.fileUpdate, M.metafieldsSet, M.metafieldsDelete,
  M.collectionUpdate, M.collectionAdd, M.collectionRemove, M.collectionReorder, M.publish, M.unpublish, M.pageUpdate, M.translationsRegister, M.translationsRemove,
  M.discountUpdate, M.themeFilesUpsert, M.themeFilesDelete]);
/** Theme-Schritte nur für Lotse-eigene Dateien (eine gespeicherte Rückgängig-Liste kann keine fremden Theme-Dateien ändern) */
function themeFilesOk(b: { query: string; variables?: Json }): boolean {
  const r = rootOf(b.query); if (r !== 'themeFilesUpsert' && r !== 'themeFilesDelete') return true;
  const files: unknown[] = b.variables?.files ?? [];
  return files.length > 0 && files.every(f => LOTSE_FILE.test(typeof f === 'string' ? f : String((f as Json)?.filename ?? '')));
}
const GONE = /does not exist|not found|nicht gefunden|existiert nicht|NOT_FOUND|DOES_NOT_EXIST|FILE_DOES_NOT_EXIST/i;

/** Rückgängig-Schritte in umgekehrter Reihenfolge; „schon weg“ beim Löschen gilt als Erfolg */
export async function undoShopify(client: ShopifyClient, ops: UndoOp[]): Promise<{ ok: boolean; error?: string }[]> {
  const out: { ok: boolean; error?: string }[] = [];
  for (const op of [...ops].reverse()) {
    try {
      if (op.op === 'req') {
        const b = op.body as { query?: string; variables?: Json } | undefined;
        if (op.path !== 'graphql' || !b?.query || !UNDO_QUERIES.has(b.query) || !themeFilesOk(b as { query: string; variables?: Json })) throw new Error('Ungültiger Rückgängig-Schritt');
        try { await run(client, b.query, b.variables ?? {}); }
        catch (e) { if (!(rootOf(b.query) === 'themeFilesDelete' && e instanceof ShopifyError && GONE.test(e.message))) throw e; } // Vorlage schon weg = Ziel erreicht
      } else if (op.op === 'delete' && op.entity === 'theme-section') {
        await deleteSectionIfUnused(client, op.id);
      } else if (op.op === 'delete') {
        const fn = DELETE[op.entity as keyof typeof DELETE]; if (!fn) throw new Error(`Löschen von „${op.entity}“ wird nicht unterstützt`);
        const [q, v] = fn(op.id);
        try { await run(client, q, v); } catch (e) { if (!(e instanceof ShopifyError && GONE.test(e.message))) throw e; }
      } else throw new Error(`Rückgängig-Art „${op.op}“ gibt es bei Shopify nicht`);
      out.push({ ok: true });
    } catch (e) { out.push({ ok: false, error: errMsg(e) }); }
  }
  return out;
}
