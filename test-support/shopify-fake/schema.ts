/**
 * Subset of the Shopify Admin GraphQL schema (API version 2026-10) that the
 * fake implements. Type, field, argument and enum names follow shopify.dev.
 * Only fields the fake can answer meaningfully are declared, so a typo in a
 * client query fails here exactly like it would against Shopify
 * ("Field 'x' doesn't exist on type 'Product'").
 *
 * Fake-only SDL directives:
 *   @access(scope: "...")  root field requires that access scope (else ACCESS_DENIED)
 *   @opaque                sub-selection is not validated (used for privacy-denied
 *                          resources whose full types the fake does not model)
 */

const CONN_ARGS = 'first: Int, after: String, last: Int, before: String, reverse: Boolean = false';

function connection(node: string, extra = ''): string {
  return `
type ${node}Connection {
  edges: [${node}Edge!]!
  nodes: [${node}!]!
  pageInfo: PageInfo!
  ${extra}
}
type ${node}Edge {
  cursor: String!
  node: ${node}!
}`;
}

export const SDL = /* GraphQL */ `
scalar DateTime
scalar Date
scalar Money
scalar Decimal
scalar URL
scalar HTML
scalar JSON
scalar UnsignedInt64
scalar FormattedString
scalar Color

interface Node {
  id: ID!
}

interface HasMetafields {
  metafield(namespace: String, key: String!): Metafield
  metafields(namespace: String, keys: [String!], ${CONN_ARGS}): MetafieldConnection!
}

interface Publishable {
  publishedOnCurrentPublication: Boolean!
  publishedOnPublication(publicationId: ID!): Boolean!
}

type Publication implements Node {
  id: ID!
  name: String!
  autoPublish: Boolean!
  supportsFuturePublishing: Boolean!
}

input PublicationInput {
  publicationId: ID
  publishDate: DateTime
}

type PublishablePublishPayload {
  publishable: Publishable
  shop: Shop!
  userErrors: [BasicUserError!]!
}

type PublishableUnpublishPayload {
  publishable: Publishable
  shop: Shop!
  userErrors: [BasicUserError!]!
}

interface UserError {
  field: [String!]
  message: String!
}

interface DisplayableError {
  field: [String!]
  message: String!
}

type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}

type Count {
  count: Int!
  precision: CountPrecision!
}

enum CountPrecision { EXACT AT_LEAST }

type MoneyV2 {
  amount: Decimal!
  currencyCode: CurrencyCode!
}

type MoneyBag {
  shopMoney: MoneyV2!
  presentmentMoney: MoneyV2!
}

enum CurrencyCode { EUR USD GBP CHF DKK SEK NOK PLN CZK HUF CAD AUD JPY }

type SEO {
  title: String
  description: String
}

input SEOInput {
  title: String
  description: String
}

type BasicUserError implements UserError & DisplayableError {
  field: [String!]
  message: String!
}

type Job {
  id: ID!
  done: Boolean!
  query: QueryRoot
}

type QueryRoot {
  shop: Shop!
}

# ---------------------------------------------------------------- shop

type Domain implements Node {
  id: ID!
  host: String!
  url: URL!
  sslEnabled: Boolean!
}

type ShopPlan {
  displayName: String!
  partnerDevelopment: Boolean!
  shopifyPlus: Boolean!
  publicDisplayName: String!
}

type CurrencyFormats {
  moneyFormat: FormattedString!
  moneyWithCurrencyFormat: FormattedString!
}

type Shop implements Node & HasMetafields {
  id: ID!
  name: String!
  email: String!
  contactEmail: String!
  description: String
  myshopifyDomain: String!
  url: URL!
  primaryDomain: Domain!
  currencyCode: CurrencyCode!
  enabledPresentmentCurrencies: [CurrencyCode!]!
  currencyFormats: CurrencyFormats!
  ianaTimezone: String!
  timezoneAbbreviation: String!
  weightUnit: WeightUnit!
  taxesIncluded: Boolean!
  plan: ShopPlan!
  createdAt: DateTime!
  updatedAt: DateTime!
  metafield(namespace: String, key: String!): Metafield
  metafields(namespace: String, keys: [String!], ${CONN_ARGS}): MetafieldConnection!
}

enum WeightUnit { KILOGRAMS GRAMS POUNDS OUNCES }

type ShopLocale {
  locale: String!
  name: String!
  primary: Boolean!
  published: Boolean!
}

type AccessScope {
  handle: String!
  description: String!
}

type AppInstallation implements Node {
  id: ID!
  accessScopes: [AccessScope!]!
}

type Location implements Node {
  id: ID!
  name: String!
  isActive: Boolean!
}
${connection('Location')}
${connection('Publication')}

# ---------------------------------------------------------------- products

enum ProductStatus { ACTIVE ARCHIVED DRAFT UNLISTED }

enum ProductSortKeys { TITLE PRODUCT_TYPE VENDOR INVENTORY_TOTAL UPDATED_AT CREATED_AT PUBLISHED_AT ID RELEVANCE }

enum ProductVariantSortKeys { POSITION TITLE SKU ID INVENTORY_QUANTITY NAME RELEVANCE FULL_TITLE INVENTORY_LEVELS_AVAILABLE INVENTORY_MANAGEMENT INVENTORY_POLICY }

enum ProductVariantInventoryPolicy { DENY CONTINUE }

enum ProductMediaSortKeys { POSITION ID RELEVANCE }

type ProductPriceRangeV2 {
  minVariantPrice: MoneyV2!
  maxVariantPrice: MoneyV2!
}

type ProductOptionValue implements Node {
  id: ID!
  name: String!
  hasVariants: Boolean!
}

type ProductOption implements Node {
  id: ID!
  name: String!
  position: Int!
  values: [String!]!
  optionValues: [ProductOptionValue!]!
}

type SelectedOption {
  name: String!
  value: String!
  optionValue: ProductOptionValue!
}

type InventoryItem implements Node {
  id: ID!
  sku: String
  tracked: Boolean!
  requiresShipping: Boolean!
  unitCost: MoneyV2
  createdAt: DateTime!
  updatedAt: DateTime!
}

type ProductVariant implements Node & HasMetafields {
  id: ID!
  legacyResourceId: UnsignedInt64!
  title: String!
  displayName: String!
  price: Money!
  compareAtPrice: Money
  sku: String
  barcode: String
  position: Int!
  inventoryQuantity: Int
  inventoryPolicy: ProductVariantInventoryPolicy!
  availableForSale: Boolean!
  taxable: Boolean!
  selectedOptions: [SelectedOption!]!
  inventoryItem: InventoryItem!
  product: Product!
  media(${CONN_ARGS}): MediaConnection!
  image: Image
  createdAt: DateTime!
  updatedAt: DateTime!
  metafield(namespace: String, key: String!): Metafield
  metafields(namespace: String, keys: [String!], ${CONN_ARGS}): MetafieldConnection!
  translations(locale: String!, marketId: ID): [Translation!]!
}
${connection('ProductVariant')}

type Product implements Node & HasMetafields & Publishable {
  id: ID!
  legacyResourceId: UnsignedInt64!
  title: String!
  handle: String!
  description(truncateAt: Int): String!
  descriptionHtml: HTML!
  status: ProductStatus!
  vendor: String!
  productType: String!
  tags: [String!]!
  seo: SEO!
  templateSuffix: String
  giftCardTemplateSuffix: String
  isGiftCard: Boolean!
  hasOnlyDefaultVariant: Boolean!
  hasOutOfStockVariants: Boolean!
  tracksInventory: Boolean!
  totalInventory: Int!
  onlineStoreUrl: URL
  onlineStorePreviewUrl: URL
  publishedAt: DateTime
  publishedOnCurrentPublication: Boolean!
  publishedOnPublication(publicationId: ID!): Boolean!
  createdAt: DateTime!
  updatedAt: DateTime!
  priceRangeV2: ProductPriceRangeV2!
  compareAtPriceRange: ProductCompareAtPriceRange
  options(first: Int): [ProductOption!]!
  variants(${CONN_ARGS}, sortKey: ProductVariantSortKeys = POSITION): ProductVariantConnection!
  variantsCount: Count
  media(${CONN_ARGS}, sortKey: ProductMediaSortKeys = POSITION, query: String): MediaConnection!
  mediaCount: Count
  featuredMedia: Media
  images(${CONN_ARGS}): ImageConnection!
  featuredImage: Image
  collections(${CONN_ARGS}, query: String, sortKey: CollectionSortKeys = ID): CollectionConnection!
  inCollection(id: ID!): Boolean!
  metafield(namespace: String, key: String!): Metafield
  metafields(namespace: String, keys: [String!], ${CONN_ARGS}): MetafieldConnection!
  translations(locale: String!, marketId: ID): [Translation!]!
}
${connection('Product')}

type ProductCompareAtPriceRange {
  minVariantCompareAtPrice: MoneyV2!
  maxVariantCompareAtPrice: MoneyV2!
}

input OptionValueCreateInput {
  name: String
  linkedMetafieldValue: String
}

input OptionCreateInput {
  name: String
  position: Int
  values: [OptionValueCreateInput!]
  linkedMetafield: JSON
}

input MetafieldInput {
  id: ID
  namespace: String
  key: String
  value: String
  type: String
  compareDigest: String
}

input ProductCreateInput {
  title: String
  handle: String
  descriptionHtml: String
  vendor: String
  productType: String
  status: ProductStatus
  tags: [String!]
  seo: SEOInput
  templateSuffix: String
  giftCard: Boolean
  giftCardTemplateSuffix: String
  requiresSellingPlan: Boolean
  category: ID
  productOptions: [OptionCreateInput!]
  metafields: [MetafieldInput!]
  collectionsToJoin: [ID!]
  combinedListingRole: String
  claimOwnership: JSON
}

input ProductUpdateInput {
  id: ID
  title: String
  handle: String
  descriptionHtml: String
  vendor: String
  productType: String
  status: ProductStatus
  tags: [String!]
  seo: SEOInput
  templateSuffix: String
  giftCardTemplateSuffix: String
  requiresSellingPlan: Boolean
  category: ID
  metafields: [MetafieldInput!]
  collectionsToJoin: [ID!]
  collectionsToLeave: [ID!]
  redirectNewHandle: Boolean
  deleteConflictingConstrainedMetafields: Boolean = false
}

input ProductInput {
  id: ID
  title: String
  handle: String
  descriptionHtml: String
  vendor: String
  productType: String
  status: ProductStatus
  tags: [String!]
  seo: SEOInput
  templateSuffix: String
  giftCard: Boolean
  giftCardTemplateSuffix: String
  requiresSellingPlan: Boolean
  category: ID
  productOptions: [OptionCreateInput!]
  metafields: [MetafieldInput!]
  collectionsToJoin: [ID!]
  collectionsToLeave: [ID!]
  redirectNewHandle: Boolean
}

input ProductUpdateIdentifiers {
  id: ID
  handle: String
}

input ProductDeleteInput {
  id: ID!
}

input CreateMediaInput {
  originalSource: String!
  mediaContentType: MediaContentType!
  alt: String
}

enum ProductVariantsBulkCreateStrategy { DEFAULT REMOVE_STANDALONE_VARIANT PRESERVE_STANDALONE_VARIANT }

input VariantOptionValueInput {
  id: ID
  name: String
  optionId: ID
  optionName: String
  linkedMetafieldValue: String
}

input InventoryItemInput {
  sku: String
  tracked: Boolean
  requiresShipping: Boolean
  cost: Decimal
  harmonizedSystemCode: String
  countryCodeOfOrigin: String
}

input InventoryLevelInput {
  availableQuantity: Int!
  locationId: ID!
}

input ProductVariantsBulkInput {
  id: ID
  price: Money
  compareAtPrice: Money
  barcode: String
  taxable: Boolean
  inventoryPolicy: ProductVariantInventoryPolicy
  inventoryItem: InventoryItemInput
  inventoryQuantities: [InventoryLevelInput!]
  optionValues: [VariantOptionValueInput!]
  mediaId: ID
  mediaSrc: [String!]
  metafields: [MetafieldInput!]
  requiresComponents: Boolean
  taxCode: String
}

enum ProductVariantsBulkUpdateUserErrorCode {
  INVALID_INPUT PRODUCT_DOES_NOT_EXIST PRODUCT_VARIANT_DOES_NOT_EXIST PRODUCT_VARIANT_ID_MISSING
  GREATER_THAN_OR_EQUAL_TO NO_KEY_ON_CREATE VARIANT_ALREADY_EXISTS OPTION_VALUES_FOR_NUMBER_OF_UNKNOWN_OPTIONS
  NEED_TO_ADD_OPTION_VALUES OPTION_DOES_NOT_EXIST OPTION_VALUE_DOES_NOT_EXIST MUST_SPECIFY_ALL_OPTION_VALUES
  CANNOT_SPECIFY_BOTH INVALID_VALUE BLANK TOO_LONG UNSUPPORTED_COMBINED_LISTING_PARENT_OPERATION
}

type ProductVariantsBulkUpdateUserError implements DisplayableError {
  field: [String!]
  message: String!
  code: ProductVariantsBulkUpdateUserErrorCode
}

enum ProductVariantsBulkCreateUserErrorCode {
  INVALID_INPUT PRODUCT_DOES_NOT_EXIST VARIANT_ALREADY_EXISTS OPTION_DOES_NOT_EXIST OPTION_VALUES_FOR_NUMBER_OF_UNKNOWN_OPTIONS
  MUST_SPECIFY_ALL_OPTION_VALUES GREATER_THAN_OR_EQUAL_TO INVALID TOO_MANY_INVENTORY_LOCATIONS NEED_TO_ADD_OPTION_VALUES
}

type ProductVariantsBulkCreateUserError implements DisplayableError {
  field: [String!]
  message: String!
  code: ProductVariantsBulkCreateUserErrorCode
}

enum ProductVariantsBulkDeleteUserErrorCode { PRODUCT_DOES_NOT_EXIST AT_LEAST_ONE_VARIANT_DOES_NOT_BELONG_TO_THE_PRODUCT CANNOT_DELETE_LAST_VARIANT }

type ProductVariantsBulkDeleteUserError implements DisplayableError {
  field: [String!]
  message: String!
  code: ProductVariantsBulkDeleteUserErrorCode
}

enum ProductUserErrorCode { BLANK TAKEN INVALID NOT_FOUND PRODUCT_DOES_NOT_EXIST TOO_LONG INCLUSION GREATER_THAN_OR_EQUAL_TO INVALID_METAFIELD_VALUE_FOR_LINKED_OPTION OPTION_DOES_NOT_EXIST OPTIONS_OVER_LIMIT DUPLICATED_OPTION_NAME DUPLICATED_OPTION_VALUE }

type UserErrorWithCode implements DisplayableError {
  field: [String!]
  message: String!
  code: ProductUserErrorCode
}

type ProductCreatePayload {
  product: Product
  shop: Shop!
  userErrors: [BasicUserError!]!
}

type ProductUpdatePayload {
  product: Product
  userErrors: [BasicUserError!]!
}

type ProductDeletePayload {
  deletedProductId: ID
  shop: Shop!
  userErrors: [BasicUserError!]!
}

type ProductVariantsBulkUpdatePayload {
  product: Product
  productVariants: [ProductVariant!]
  userErrors: [ProductVariantsBulkUpdateUserError!]!
}

type ProductVariantsBulkCreatePayload {
  product: Product
  productVariants: [ProductVariant!]
  userErrors: [ProductVariantsBulkCreateUserError!]!
}

type ProductVariantsBulkDeletePayload {
  product: Product
  userErrors: [ProductVariantsBulkDeleteUserError!]!
}

# ---------------------------------------------------------------- media / files

enum MediaContentType { IMAGE VIDEO EXTERNAL_VIDEO MODEL_3D }
enum MediaStatus { UPLOADED PROCESSING READY FAILED }
enum FileStatus { UPLOADED PROCESSING READY FAILED }
enum ImageContentType { PNG JPG WEBP }
enum CropRegion { CENTER TOP BOTTOM LEFT RIGHT }

input ImageTransformInput {
  crop: CropRegion
  maxWidth: Int
  maxHeight: Int
  scale: Int = 1
  preferredContentType: ImageContentType
}

type Image {
  id: ID
  url(transform: ImageTransformInput): URL!
  altText: String
  width: Int
  height: Int
  originalSrc: URL!
  src: URL!
  transformedSrc(maxWidth: Int, maxHeight: Int, crop: CropRegion, scale: Int = 1, preferredContentType: ImageContentType): URL!
}
${connection('Image')}

type MediaPreviewImage {
  image: Image
  status: MediaPreviewImageStatus!
}

enum MediaPreviewImageStatus { UPLOADED PROCESSING READY FAILED }

type MediaError {
  code: String!
  details: String
  message: String!
}

interface Media {
  id: ID!
  alt: String
  mediaContentType: MediaContentType!
  status: MediaStatus!
  preview: MediaPreviewImage
  mediaErrors: [MediaError!]!
}
${connection('Media')}

interface File {
  id: ID!
  alt: String
  fileStatus: FileStatus!
  preview: MediaPreviewImage
  createdAt: DateTime!
  updatedAt: DateTime!
  fileErrors: [FileError!]!
}
${connection('File')}

type FileError {
  code: String!
  details: String
  message: String!
}

type MediaImage implements Node & Media & File {
  id: ID!
  alt: String
  mediaContentType: MediaContentType!
  status: MediaStatus!
  fileStatus: FileStatus!
  image: Image
  preview: MediaPreviewImage
  mimeType: String
  mediaErrors: [MediaError!]!
  fileErrors: [FileError!]!
  createdAt: DateTime!
  updatedAt: DateTime!
}

enum MediaUserErrorCode {
  INVALID BLANK PRODUCT_DOES_NOT_EXIST MEDIA_DOES_NOT_EXIST MEDIA_DOES_NOT_EXIST_ON_PRODUCT TOO_MANY_MEDIA_PER_INPUT_PAIR
  MAXIMUM_VARIANT_MEDIA_PAIRS_EXCEEDED INVALID_MEDIA_TYPE PRODUCT_MEDIA_LIMIT_EXCEEDED SHOP_MEDIA_LIMIT_EXCEEDED
  NON_READY_MEDIA MEDIA_CANNOT_BE_MODIFIED VIDEO_THROTTLE_EXCEEDED MODEL3D_THROTTLE_EXCEEDED MODEL3D_VALIDATION_ERROR MODEL3D_PROCESSING_FAILURE
}

type MediaUserError implements DisplayableError {
  field: [String!]
  message: String!
  code: MediaUserErrorCode
}

input MoveInput {
  id: ID!
  newPosition: UnsignedInt64!
}

type ProductCreateMediaPayload {
  media: [Media!]
  mediaUserErrors: [MediaUserError!]!
  product: Product
}

type ProductDeleteMediaPayload {
  deletedMediaIds: [ID!]
  deletedProductImageIds: [ID!]
  mediaUserErrors: [MediaUserError!]!
  product: Product
}

type ProductReorderMediaPayload {
  job: Job
  mediaUserErrors: [MediaUserError!]!
}

enum FileContentType { IMAGE FILE VIDEO EXTERNAL_VIDEO MODEL_3D }
enum FileCreateInputDuplicateResolutionMode { APPEND_UUID RAISE_ERROR REPLACE }

input FileCreateInput {
  originalSource: String!
  contentType: FileContentType
  alt: String
  filename: String
  duplicateResolutionMode: FileCreateInputDuplicateResolutionMode = APPEND_UUID
}

input FileUpdateInput {
  id: ID!
  alt: String
  originalSource: String
  previewImageSource: String
  filename: String
  referencesToAdd: [ID!]
  referencesToRemove: [ID!]
}

enum FilesErrorCode {
  INVALID FILE_DOES_NOT_EXIST FILE_LOCKED UNSUPPORTED_MEDIA_TYPE_FOR_FILENAME_UPDATE INVALID_FILENAME_EXTENSION
  INVALID_FILENAME MISSING_ARGUMENTS TOO_MANY_ARGUMENTS ALT_VALUE_LIMIT_EXCEEDED BLANK_SEARCH NON_READY_STATE
  NON_IMAGE_MEDIA_PER_SHOP_LIMIT_EXCEEDED REFERENCE_TARGET_DOES_NOT_EXIST MISMATCHED_FILENAME_AND_ORIGINAL_SOURCE INVALID_QUERY
}

type FilesUserError implements DisplayableError {
  field: [String!]
  message: String!
  code: FilesErrorCode
}

type FileCreatePayload {
  files: [File!]
  userErrors: [FilesUserError!]!
}

type FileUpdatePayload {
  files: [File!]
  userErrors: [FilesUserError!]!
}

type FileDeletePayload {
  deletedFileIds: [ID!]
  userErrors: [FilesUserError!]!
}

enum StagedUploadTargetGenerateUploadResource {
  IMAGE FILE VIDEO MODEL_3D COLLECTION_IMAGE PRODUCT_IMAGE SHOP_IMAGE BULK_MUTATION_VARIABLES RETURN_LABEL URL_REDIRECT_IMPORT DISPUTE_FILE_UPLOAD
}

enum StagedUploadHttpMethodType { POST PUT }

input StagedUploadInput {
  resource: StagedUploadTargetGenerateUploadResource!
  filename: String!
  mimeType: String!
  httpMethod: StagedUploadHttpMethodType = PUT
  fileSize: UnsignedInt64
}

type StagedUploadParameter {
  name: String!
  value: String!
}

type StagedMediaUploadTarget {
  url: URL
  resourceUrl: URL
  parameters: [StagedUploadParameter!]!
}

type StagedUploadsCreatePayload {
  stagedTargets: [StagedMediaUploadTarget!]
  userErrors: [BasicUserError!]!
}

# ---------------------------------------------------------------- collections

enum CollectionSortKeys { TITLE UPDATED_AT ID RELEVANCE }
enum CollectionSortOrder { ALPHA_ASC ALPHA_DESC BEST_SELLING CREATED CREATED_DESC MANUAL PRICE_ASC PRICE_DESC }
enum ProductCollectionSortKeys { TITLE PRICE BEST_SELLING CREATED ID MANUAL COLLECTION_DEFAULT RELEVANCE }

enum CollectionRuleColumn {
  TAG TITLE TYPE PRODUCT_TAXONOMY_NODE_ID PRODUCT_CATEGORY_ID VENDOR VARIANT_PRICE IS_PRICE_REDUCED VARIANT_COMPARE_AT_PRICE
  VARIANT_WEIGHT VARIANT_INVENTORY VARIANT_TITLE PRODUCT_METAFIELD_DEFINITION VARIANT_METAFIELD_DEFINITION
}

enum CollectionRuleRelation { BOUNDARY_MISMATCH CONTAINS ENDS_WITH EQUALS GREATER_THAN IS_NOT_SET IS_SET LESS_THAN NOT_CONTAINS NOT_EQUALS STARTS_WITH }

type CollectionRule {
  column: CollectionRuleColumn!
  relation: CollectionRuleRelation!
  condition: String!
}

type CollectionRuleSet {
  appliedDisjunctively: Boolean!
  rules: [CollectionRule!]!
}

input CollectionRuleInput {
  column: CollectionRuleColumn!
  relation: CollectionRuleRelation!
  condition: String!
  conditionObjectId: ID
}

input CollectionRuleSetInput {
  appliedDisjunctively: Boolean!
  rules: [CollectionRuleInput!]
}

input ImageInput {
  id: ID
  altText: String
  src: String
}

input CollectionInput {
  id: ID
  title: String
  handle: String
  descriptionHtml: String
  image: ImageInput
  products: [ID!]
  ruleSet: CollectionRuleSetInput
  seo: SEOInput
  sortOrder: CollectionSortOrder
  templateSuffix: String
  metafields: [MetafieldInput!]
  redirectNewHandle: Boolean = false
}

input CollectionDeleteInput {
  id: ID!
}

type Collection implements Node & HasMetafields & Publishable {
  id: ID!
  legacyResourceId: UnsignedInt64!
  title: String!
  handle: String!
  description(truncateAt: Int): String!
  descriptionHtml: HTML!
  sortOrder: CollectionSortOrder!
  templateSuffix: String
  seo: SEO!
  image: Image
  ruleSet: CollectionRuleSet
  products(${CONN_ARGS}, sortKey: ProductCollectionSortKeys = COLLECTION_DEFAULT): ProductConnection!
  productsCount: Count
  hasProduct(id: ID!): Boolean!
  onlineStoreUrl: URL
  publishedOnCurrentPublication: Boolean!
  publishedOnPublication(publicationId: ID!): Boolean!
  updatedAt: DateTime!
  metafield(namespace: String, key: String!): Metafield
  metafields(namespace: String, keys: [String!], ${CONN_ARGS}): MetafieldConnection!
  translations(locale: String!, marketId: ID): [Translation!]!
}
${connection('Collection')}

type CollectionCreatePayload {
  collection: Collection
  userErrors: [BasicUserError!]!
}

type CollectionUpdatePayload {
  collection: Collection
  job: Job
  userErrors: [BasicUserError!]!
}

type CollectionDeletePayload {
  deletedCollectionId: ID
  shop: Shop!
  userErrors: [BasicUserError!]!
}

type CollectionAddProductsPayload {
  collection: Collection
  userErrors: [BasicUserError!]!
}

type CollectionRemoveProductsPayload {
  job: Job
  userErrors: [BasicUserError!]!
}

type CollectionReorderProductsPayload {
  job: Job
  userErrors: [BasicUserError!]!
}

# ---------------------------------------------------------------- pages

enum PageSortKeys { TITLE UPDATED_AT PUBLISHED_AT ID RELEVANCE }

type Page implements Node & HasMetafields {
  id: ID!
  title: String!
  handle: String!
  body: HTML!
  bodySummary: String!
  isPublished: Boolean!
  publishedAt: DateTime
  templateSuffix: String
  createdAt: DateTime!
  updatedAt: DateTime!
  metafield(namespace: String, key: String!): Metafield
  metafields(namespace: String, keys: [String!], ${CONN_ARGS}): MetafieldConnection!
  translations(locale: String!, marketId: ID): [Translation!]!
}
${connection('Page')}

input PageCreateInput {
  title: String!
  handle: String
  body: HTML
  isPublished: Boolean
  publishDate: DateTime
  templateSuffix: String
  metafields: [MetafieldInput!]
}

input PageUpdateInput {
  title: String
  handle: String
  body: HTML
  isPublished: Boolean
  publishDate: DateTime
  templateSuffix: String
  metafields: [MetafieldInput!]
  redirectNewHandle: Boolean
}

enum PageCreateUserErrorCode { BLANK TAKEN TOO_LONG INVALID INVALID_PUBLISH_DATE }
enum PageUpdateUserErrorCode { BLANK TAKEN TOO_LONG INVALID INVALID_PUBLISH_DATE NOT_FOUND }
enum PageDeleteUserErrorCode { NOT_FOUND }

type PageCreateUserError implements DisplayableError {
  field: [String!]
  message: String!
  code: PageCreateUserErrorCode
}

type PageUpdateUserError implements DisplayableError {
  field: [String!]
  message: String!
  code: PageUpdateUserErrorCode
}

type PageDeleteUserError implements DisplayableError {
  field: [String!]
  message: String!
  code: PageDeleteUserErrorCode
}

type PageCreatePayload {
  page: Page
  userErrors: [PageCreateUserError!]!
}

type PageUpdatePayload {
  page: Page
  userErrors: [PageUpdateUserError!]!
}

type PageDeletePayload {
  deletedPageId: ID
  userErrors: [PageDeleteUserError!]!
}

# ---------------------------------------------------------------- metafields

enum MetafieldOwnerType { PRODUCT PRODUCTVARIANT COLLECTION PAGE SHOP }

type Metafield implements Node {
  id: ID!
  namespace: String!
  key: String!
  value: String!
  jsonValue: JSON!
  type: String!
  ownerType: MetafieldOwnerType!
  compareDigest: String!
  createdAt: DateTime!
  updatedAt: DateTime!
}
${connection('Metafield')}

input MetafieldsSetInput {
  ownerId: ID!
  namespace: String
  key: String!
  value: String!
  type: String
  compareDigest: String
}

input MetafieldIdentifierInput {
  ownerId: ID!
  namespace: String!
  key: String!
}

type MetafieldIdentifier {
  ownerId: ID!
  namespace: String!
  key: String!
}

enum MetafieldsSetUserErrorCode {
  BLANK INCLUSION LESS_THAN_OR_EQUAL_TO PRESENT TOO_SHORT TOO_LONG INVALID INVALID_VALUE INVALID_TYPE
  APP_NOT_AUTHORIZED STALE_OBJECT CAPABILITY_VIOLATION
}

type MetafieldsSetUserError implements DisplayableError {
  field: [String!]
  message: String!
  code: MetafieldsSetUserErrorCode
  elementIndex: Int
}

type MetafieldsSetPayload {
  metafields: [Metafield!]
  userErrors: [MetafieldsSetUserError!]!
}

type MetafieldsDeletePayload {
  deletedMetafields: [MetafieldIdentifier]
  userErrors: [BasicUserError!]!
}

# ---------------------------------------------------------------- translations

enum TranslatableResourceType {
  COLLECTION DELIVERY_METHOD_DEFINITION EMAIL_TEMPLATE FILTER LINK METAFIELD METAOBJECT ONLINE_STORE_ARTICLE
  ONLINE_STORE_BLOG ONLINE_STORE_MENU ONLINE_STORE_PAGE ONLINE_STORE_THEME PACKING_SLIP_TEMPLATE PAYMENT_GATEWAY
  PRODUCT PRODUCT_OPTION PRODUCT_OPTION_VALUE SELLING_PLAN SELLING_PLAN_GROUP SHOP SHOP_POLICY
}

enum LocalizableContentType {
  JSON_STRING JSON LIST_MULTI_LINE_TEXT_FIELD LIST_SINGLE_LINE_TEXT_FIELD LIST_URL MULTI_LINE_TEXT_FIELD
  RICH_TEXT_FIELD SINGLE_LINE_TEXT_FIELD STRING URL LINK LIST_LINK HTML URI INLINE_RICH_TEXT FILE_REFERENCE LIST_FILE_REFERENCE
}

type TranslatableContent {
  key: String!
  value: String
  digest: String
  locale: String!
  type: LocalizableContentType!
}

type Translation {
  key: String!
  value: String
  locale: String!
  outdated: Boolean!
  updatedAt: DateTime
}

type TranslatableResource {
  resourceId: ID!
  translatableContent(marketId: ID): [TranslatableContent!]!
  translations(locale: String!, outdated: Boolean, marketId: ID): [Translation!]!
}
${connection('TranslatableResource')}

input TranslationInput {
  locale: String!
  key: String!
  value: String!
  translatableContentDigest: String!
  marketId: ID
}

enum TranslationErrorCode {
  BLANK INVALID RESOURCE_NOT_FOUND RESOURCE_NOT_MARKET_CUSTOMIZABLE TOO_MANY_KEYS_FOR_RESOURCE INVALID_KEY_FOR_MODEL
  FAILS_RESOURCE_VALIDATION INVALID_TRANSLATABLE_CONTENT INVALID_MARKET_LOCALIZABLE_CONTENT INVALID_LOCALE_FOR_SHOP
  INVALID_LOCALE_FOR_MARKET INVALID_CODE INVALID_FORMAT MARKET_CUSTOM_CONTENT_NOT_ALLOWED MARKET_DOES_NOT_EXIST
  MARKET_LOCALE_CREATION_FAILED INVALID_VALUE_FOR_HANDLE_TRANSLATION
}

type TranslationUserError implements DisplayableError {
  field: [String!]
  message: String!
  code: TranslationErrorCode
}

type TranslationsRegisterPayload {
  translations: [Translation!]
  userErrors: [TranslationUserError!]!
}

type TranslationsRemovePayload {
  translations: [Translation!]
  userErrors: [TranslationUserError!]!
}

# ---------------------------------------------------------------- discounts

enum DiscountStatus { ACTIVE EXPIRED SCHEDULED }
enum DiscountClass { PRODUCT ORDER SHIPPING }
enum MerchandiseDiscountClass { PRODUCT ORDER }
enum DiscountBuyerSelection { ALL }
enum CodeDiscountSortKeys { CREATED_AT ENDS_AT ID RELEVANCE STARTS_AT TITLE UPDATED_AT }

type DiscountPercentage {
  percentage: Float!
}

type DiscountAmount {
  amount: MoneyV2!
  appliesOnEachItem: Boolean!
}

type DiscountOnQuantity {
  quantity: DiscountQuantity!
  effect: DiscountEffect!
}

type DiscountQuantity {
  quantity: UnsignedInt64!
}

union DiscountEffect = DiscountPercentage | DiscountAmount
union DiscountCustomerGetsValue = DiscountPercentage | DiscountAmount | DiscountOnQuantity

type AllDiscountItems {
  allItems: Boolean!
}

type DiscountProducts {
  products(${CONN_ARGS}): ProductConnection!
  productVariants(${CONN_ARGS}): ProductVariantConnection!
}

type DiscountCollections {
  collections(${CONN_ARGS}): CollectionConnection!
}

union DiscountItems = AllDiscountItems | DiscountProducts | DiscountCollections

type DiscountCustomerGets {
  value: DiscountCustomerGetsValue!
  items: DiscountItems!
  appliesOnOneTimePurchase: Boolean!
  appliesOnSubscription: Boolean!
}

type DiscountMinimumQuantity {
  greaterThanOrEqualToQuantity: UnsignedInt64!
}

type DiscountMinimumSubtotal {
  greaterThanOrEqualToSubtotal: MoneyV2!
}

union DiscountMinimumRequirement = DiscountMinimumQuantity | DiscountMinimumSubtotal

type DiscountCombinesWith {
  productDiscounts: Boolean!
  orderDiscounts: Boolean!
  shippingDiscounts: Boolean!
}

type DiscountBuyerSelectionAll {
  all: DiscountBuyerSelection!
}

type DiscountCustomerAll {
  allCustomers: Boolean!
}

type Customer implements Node {
  id: ID!
}

type Segment implements Node {
  id: ID!
  name: String!
}

type DiscountCustomers {
  customers: [Customer!]! @opaque
}

type DiscountCustomerSegments {
  segments: [Segment!]!
}

union DiscountContext = DiscountBuyerSelectionAll | DiscountCustomers | DiscountCustomerSegments
union DiscountCustomerSelection = DiscountCustomerAll | DiscountCustomers | DiscountCustomerSegments

type DiscountRedeemCode {
  id: ID!
  code: String!
  asyncUsageCount: Int!
}
${connection('DiscountRedeemCode')}

type DiscountCodeBasic {
  title: String!
  status: DiscountStatus!
  summary: String!
  shortSummary: String!
  startsAt: DateTime!
  endsAt: DateTime
  createdAt: DateTime!
  updatedAt: DateTime!
  usageLimit: Int
  appliesOncePerCustomer: Boolean!
  asyncUsageCount: Int!
  recurringCycleLimit: Int
  tags: [String!]!
  discountClasses: [DiscountClass!]!
  discountClass: MerchandiseDiscountClass!
  codes(${CONN_ARGS}): DiscountRedeemCodeConnection!
  codesCount: Count
  combinesWith: DiscountCombinesWith!
  context: DiscountContext!
  customerSelection: DiscountCustomerSelection!
  customerGets: DiscountCustomerGets!
  minimumRequirement: DiscountMinimumRequirement
  hasTimelineComment: Boolean!
  totalSales: MoneyV2
}

type DiscountCodeFreeShipping {
  title: String!
  status: DiscountStatus!
  summary: String!
  startsAt: DateTime!
  endsAt: DateTime
}

type DiscountCodeBxgy {
  title: String!
  status: DiscountStatus!
  summary: String!
  startsAt: DateTime!
  endsAt: DateTime
}

type DiscountCodeApp {
  title: String!
  status: DiscountStatus!
  startsAt: DateTime!
  endsAt: DateTime
}

union DiscountCode = DiscountCodeBasic | DiscountCodeBxgy | DiscountCodeFreeShipping | DiscountCodeApp

type DiscountCodeNode implements Node & HasMetafields {
  id: ID!
  codeDiscount: DiscountCode!
  metafield(namespace: String, key: String!): Metafield
  metafields(namespace: String, keys: [String!], ${CONN_ARGS}): MetafieldConnection!
}
${connection('DiscountCodeNode')}

input DiscountAmountInput {
  amount: Decimal
  appliesOnEachItem: Boolean
}

input DiscountQuantityInput {
  quantity: UnsignedInt64
}

input DiscountEffectInput {
  percentage: Float
  amount: Decimal
}

input DiscountOnQuantityInput {
  quantity: UnsignedInt64
  effect: DiscountEffectInput
}

input DiscountCustomerGetsValueInput {
  percentage: Float
  discountAmount: DiscountAmountInput
  discountOnQuantity: DiscountOnQuantityInput
}

input DiscountProductsInput {
  productsToAdd: [ID!]
  productsToRemove: [ID!]
  productVariantsToAdd: [ID!]
  productVariantsToRemove: [ID!]
}

input DiscountCollectionsInput {
  add: [ID!]
  remove: [ID!]
}

input DiscountItemsInput {
  all: Boolean
  products: DiscountProductsInput
  collections: DiscountCollectionsInput
}

input DiscountCustomerGetsInput {
  value: DiscountCustomerGetsValueInput
  items: DiscountItemsInput
  appliesOnOneTimePurchase: Boolean
  appliesOnSubscription: Boolean
}

input DiscountMinimumQuantityInput {
  greaterThanOrEqualToQuantity: UnsignedInt64
}

input DiscountMinimumSubtotalInput {
  greaterThanOrEqualToSubtotal: Decimal
}

input DiscountMinimumRequirementInput {
  quantity: DiscountMinimumQuantityInput
  subtotal: DiscountMinimumSubtotalInput
}

input DiscountCombinesWithInput {
  productDiscounts: Boolean
  orderDiscounts: Boolean
  shippingDiscounts: Boolean
}

input DiscountCustomersInput {
  add: [ID!]
  remove: [ID!]
}

input DiscountCustomerSegmentsInput {
  add: [ID!]
  remove: [ID!]
}

input DiscountContextInput {
  all: DiscountBuyerSelection
  customers: DiscountCustomersInput
  customerSegments: DiscountCustomerSegmentsInput
}

input DiscountCustomerSelectionInput {
  all: Boolean
  customers: DiscountCustomersInput
  customerSegments: DiscountCustomerSegmentsInput
}

input DiscountCodeBasicInput {
  title: String
  code: String
  startsAt: DateTime
  endsAt: DateTime
  usageLimit: Int
  appliesOncePerCustomer: Boolean
  recurringCycleLimit: Int
  tags: [String!]
  combinesWith: DiscountCombinesWithInput
  context: DiscountContextInput
  customerSelection: DiscountCustomerSelectionInput
  customerGets: DiscountCustomerGetsInput
  minimumRequirement: DiscountMinimumRequirementInput
}

enum DiscountErrorCode {
  BLANK PRESENT EQUAL_TO GREATER_THAN GREATER_THAN_OR_EQUAL_TO INVALID LESS_THAN LESS_THAN_OR_EQUAL_TO TOO_LONG TOO_SHORT
  TAKEN VALUE_OUTSIDE_RANGE CONFLICT IMPLICIT_DUPLICATE DUPLICATE EXCEEDED_MAX MISSING_ARGUMENT INTERNAL_ERROR
  ACTIVE_PERIOD_OVERLAP INVALID_COMBINES_WITH_FOR_DISCOUNT_CLASS MAX_APP_DISCOUNTS
}

type DiscountUserError implements DisplayableError {
  field: [String!]
  message: String!
  code: DiscountErrorCode
  extraInfo: String
}

type DiscountCodeBasicCreatePayload {
  codeDiscountNode: DiscountCodeNode
  userErrors: [DiscountUserError!]!
}

type DiscountCodeBasicUpdatePayload {
  codeDiscountNode: DiscountCodeNode
  userErrors: [DiscountUserError!]!
}

type DiscountCodeDeletePayload {
  deletedCodeDiscountId: ID
  userErrors: [DiscountUserError!]!
}

type DiscountCodeActivatePayload {
  codeDiscountNode: DiscountCodeNode
  userErrors: [DiscountUserError!]!
}

type DiscountCodeDeactivatePayload {
  codeDiscountNode: DiscountCodeNode
  userErrors: [DiscountUserError!]!
}

# ---------------------------------------------------------------- themes

enum ThemeRole { MAIN UNPUBLISHED DEMO DEVELOPMENT ARCHIVED LOCKED }

type OnlineStoreThemeFileBodyText {
  content: String!
}

type OnlineStoreThemeFileBodyBase64 {
  contentBase64: String!
}

type OnlineStoreThemeFileBodyUrl {
  url: URL!
}

union OnlineStoreThemeFileBody = OnlineStoreThemeFileBodyText | OnlineStoreThemeFileBodyBase64 | OnlineStoreThemeFileBodyUrl

type OnlineStoreThemeFile {
  filename: String!
  body: OnlineStoreThemeFileBody!
  checksumMd5: String
  contentType: String!
  size: UnsignedInt64!
  createdAt: DateTime!
  updatedAt: DateTime!
}

enum OnlineStoreThemeFileResultType { BAD_REQUEST ERROR NOT_FOUND SUCCESS TIMEOUT UNPROCESSABLE_ENTITY }

type OnlineStoreThemeFileReadResult {
  filename: String!
  code: OnlineStoreThemeFileResultType!
}

type OnlineStoreThemeFileEdge {
  cursor: String!
  node: OnlineStoreThemeFile!
}

type OnlineStoreThemeFileConnection {
  edges: [OnlineStoreThemeFileEdge!]!
  nodes: [OnlineStoreThemeFile!]!
  pageInfo: PageInfo!
  userErrors: [OnlineStoreThemeFileReadResult!]!
}

type OnlineStoreTheme implements Node {
  id: ID!
  name: String!
  prefix: String!
  role: ThemeRole!
  processing: Boolean!
  processingFailed: Boolean!
  themeStoreId: Int
  createdAt: DateTime!
  updatedAt: DateTime!
  files(filenames: [String!], first: Int = 50, after: String): OnlineStoreThemeFileConnection
}
${connection('OnlineStoreTheme')}

enum OnlineStoreThemeFileBodyInputType { TEXT BASE64 URL }

input OnlineStoreThemeFileBodyInput {
  type: OnlineStoreThemeFileBodyInputType!
  value: String!
}

input OnlineStoreThemeFilesUpsertFileInput {
  filename: String!
  body: OnlineStoreThemeFileBodyInput!
}

type OnlineStoreThemeFileOperationResult {
  filename: String!
}

enum OnlineStoreThemeFilesUserErrorsCode {
  ACCESS_DENIED ERROR FILE_VALIDATION_ERROR INVALID LESS_THAN_OR_EQUAL_TO NOT_FOUND THROTTLED TOO_MANY_UPDATES
}

type OnlineStoreThemeFilesUserErrors implements DisplayableError {
  field: [String!]
  message: String!
  code: OnlineStoreThemeFilesUserErrorsCode
  filename: String
}

type ThemeFilesUpsertPayload {
  job: Job
  upsertedThemeFiles: [OnlineStoreThemeFileOperationResult!]
  userErrors: [OnlineStoreThemeFilesUserErrors!]!
}

type ThemeFilesDeletePayload {
  deletedThemeFiles: [OnlineStoreThemeFileOperationResult!]
  userErrors: [OnlineStoreThemeFilesUserErrors!]!
}

# ---------------------------------------------------------------- redirects

enum UrlRedirectSortKeys { PATH ID RELEVANCE }

type UrlRedirect implements Node {
  id: ID!
  path: String!
  target: String!
}
${connection('UrlRedirect')}

input UrlRedirectInput {
  path: String
  target: String
}

enum UrlRedirectErrorCode { DOES_NOT_EXIST CREATE_FAILED UPDATE_FAILED DELETE_FAILED }

type UrlRedirectUserError implements DisplayableError {
  field: [String!]
  message: String!
  code: UrlRedirectErrorCode
}

type UrlRedirectCreatePayload {
  urlRedirect: UrlRedirect
  userErrors: [UrlRedirectUserError!]!
}

type UrlRedirectUpdatePayload {
  urlRedirect: UrlRedirect
  userErrors: [UrlRedirectUserError!]!
}

type UrlRedirectDeletePayload {
  deletedUrlRedirectId: ID
  userErrors: [UrlRedirectUserError!]!
}

# ---------------------------------------------------------------- bulk operations

enum BulkOperationStatus { CANCELED CANCELING COMPLETED CREATED EXPIRED FAILED RUNNING }
enum BulkOperationType { QUERY MUTATION }
enum BulkOperationErrorCode { ACCESS_DENIED INTERNAL_SERVER_ERROR TIMEOUT }
enum BulkOperationUserErrorCode { INVALID OPERATION_IN_PROGRESS LIMIT_REACHED NO_SUCH_FILE }

type BulkOperation implements Node {
  id: ID!
  status: BulkOperationStatus!
  type: BulkOperationType!
  errorCode: BulkOperationErrorCode
  createdAt: DateTime!
  completedAt: DateTime
  objectCount: UnsignedInt64!
  rootObjectCount: UnsignedInt64!
  fileSize: UnsignedInt64
  url: URL
  partialDataUrl: URL
  query: String!
}

type BulkOperationUserError implements DisplayableError {
  field: [String!]
  message: String!
  code: BulkOperationUserErrorCode
}

type BulkOperationRunQueryPayload {
  bulkOperation: BulkOperation
  userErrors: [BulkOperationUserError!]!
}

type BulkOperationCancelPayload {
  bulkOperation: BulkOperation
  userErrors: [BulkOperationUserError!]!
}

# ---------------------------------------------------------------- privacy-denied resources (opaque)

type CustomerConnection {
  nodes: [Customer!]!
}

type Order implements Node {
  id: ID!
}

type OrderConnection {
  nodes: [Order!]!
}

type DraftOrder implements Node {
  id: ID!
}

type DraftOrderConnection {
  nodes: [DraftOrder!]!
}

type CustomerMutationPayload {
  customer: Customer
}

type AbandonedCheckoutConnection {
  nodes: [Customer!]!
}

# ---------------------------------------------------------------- roots

type Query {
  shop: Shop!
  shopLocales(published: Boolean): [ShopLocale!]! @access(scope: "read_locales")
  currentAppInstallation: AppInstallation!
  locations(${CONN_ARGS}, query: String, includeInactive: Boolean = false): LocationConnection! @access(scope: "read_locations")
  publications(${CONN_ARGS}, catalogType: String): PublicationConnection! @access(scope: "read_publications")
  node(id: ID!): Node
  nodes(ids: [ID!]!): [Node]!
  job(id: ID!): Job

  products(${CONN_ARGS}, query: String, sortKey: ProductSortKeys = ID, savedSearchId: ID): ProductConnection! @access(scope: "read_products")
  product(id: ID!): Product @access(scope: "read_products")
  productByIdentifier(identifier: ProductUpdateIdentifiers!): Product @access(scope: "read_products")
  productsCount(query: String, limit: Int = 10000): Count @access(scope: "read_products")
  productVariants(${CONN_ARGS}, query: String, sortKey: ProductVariantSortKeys = ID): ProductVariantConnection! @access(scope: "read_products")
  productVariant(id: ID!): ProductVariant @access(scope: "read_products")

  collections(${CONN_ARGS}, query: String, sortKey: CollectionSortKeys = ID): CollectionConnection! @access(scope: "read_products")
  collection(id: ID!): Collection @access(scope: "read_products")
  collectionByHandle(handle: String!): Collection @access(scope: "read_products")
  collectionsCount(query: String, limit: Int = 10000): Count @access(scope: "read_products")

  files(${CONN_ARGS}, query: String): FileConnection! @access(scope: "read_files")

  pages(${CONN_ARGS}, query: String, sortKey: PageSortKeys = ID): PageConnection! @access(scope: "read_content")
  page(id: ID!): Page @access(scope: "read_content")
  pagesCount(limit: Int = 10000): Count @access(scope: "read_content")

  translatableResources(${CONN_ARGS}, resourceType: TranslatableResourceType!): TranslatableResourceConnection! @access(scope: "read_translations")
  translatableResource(resourceId: ID!): TranslatableResource @access(scope: "read_translations")
  translatableResourcesByIds(${CONN_ARGS}, resourceIds: [ID!]!): TranslatableResourceConnection! @access(scope: "read_translations")

  codeDiscountNodes(${CONN_ARGS}, query: String, sortKey: CodeDiscountSortKeys = ID, savedSearchId: ID): DiscountCodeNodeConnection! @access(scope: "read_discounts")
  codeDiscountNode(id: ID!): DiscountCodeNode @access(scope: "read_discounts")
  codeDiscountNodeByCode(code: String!): DiscountCodeNode @access(scope: "read_discounts")

  themes(${CONN_ARGS}, roles: [ThemeRole!], names: [String!]): OnlineStoreThemeConnection @access(scope: "read_themes")
  theme(id: ID!): OnlineStoreTheme @access(scope: "read_themes")

  urlRedirects(${CONN_ARGS}, query: String, sortKey: UrlRedirectSortKeys = ID, savedSearchId: ID): UrlRedirectConnection! @access(scope: "read_online_store_navigation")
  urlRedirect(id: ID!): UrlRedirect @access(scope: "read_online_store_navigation")

  currentBulkOperation(type: BulkOperationType = QUERY): BulkOperation
  bulkOperation(id: ID!): BulkOperation

  customers(${CONN_ARGS}, query: String, sortKey: String): CustomerConnection! @access(scope: "read_customers") @opaque
  customer(id: ID!): Customer @access(scope: "read_customers") @opaque
  customerByIdentifier(identifier: JSON!): Customer @access(scope: "read_customers") @opaque
  customersCount(query: String, limit: Int): Count @access(scope: "read_customers") @opaque
  customerSegmentMembers(${CONN_ARGS}, query: String, segmentId: ID): CustomerConnection! @access(scope: "read_customers") @opaque
  orders(${CONN_ARGS}, query: String, sortKey: String): OrderConnection! @access(scope: "read_orders") @opaque
  order(id: ID!): Order @access(scope: "read_orders") @opaque
  orderByIdentifier(identifier: JSON!): Order @access(scope: "read_orders") @opaque
  ordersCount(query: String, limit: Int): Count @access(scope: "read_orders") @opaque
  draftOrders(${CONN_ARGS}, query: String): DraftOrderConnection! @access(scope: "read_draft_orders") @opaque
  draftOrder(id: ID!): DraftOrder @access(scope: "read_draft_orders") @opaque
  abandonedCheckouts(${CONN_ARGS}, query: String): AbandonedCheckoutConnection! @access(scope: "read_orders") @opaque
}

type Mutation {
  productCreate(product: ProductCreateInput, media: [CreateMediaInput!], input: ProductInput): ProductCreatePayload @access(scope: "write_products")
  productUpdate(product: ProductUpdateInput, media: [CreateMediaInput!], input: ProductInput, identifier: ProductUpdateIdentifiers): ProductUpdatePayload @access(scope: "write_products")
  productDelete(input: ProductDeleteInput!, synchronous: Boolean = true): ProductDeletePayload @access(scope: "write_products")
  productVariantsBulkUpdate(productId: ID!, variants: [ProductVariantsBulkInput!]!, media: [CreateMediaInput!], allowPartialUpdates: Boolean = false): ProductVariantsBulkUpdatePayload @access(scope: "write_products")
  productVariantsBulkCreate(productId: ID!, variants: [ProductVariantsBulkInput!]!, media: [CreateMediaInput!], strategy: ProductVariantsBulkCreateStrategy = DEFAULT): ProductVariantsBulkCreatePayload @access(scope: "write_products")
  productVariantsBulkDelete(productId: ID!, variantsIds: [ID!]!): ProductVariantsBulkDeletePayload @access(scope: "write_products")
  productCreateMedia(productId: ID!, media: [CreateMediaInput!]!): ProductCreateMediaPayload @access(scope: "write_products")
  productDeleteMedia(productId: ID!, mediaIds: [ID!]!): ProductDeleteMediaPayload @access(scope: "write_products")
  productReorderMedia(id: ID!, moves: [MoveInput!]!): ProductReorderMediaPayload @access(scope: "write_products")

  publishablePublish(id: ID!, input: [PublicationInput!]!): PublishablePublishPayload @access(scope: "write_publications")
  publishableUnpublish(id: ID!, input: [PublicationInput!]!): PublishableUnpublishPayload @access(scope: "write_publications")

  fileCreate(files: [FileCreateInput!]!): FileCreatePayload @access(scope: "write_files")
  fileUpdate(files: [FileUpdateInput!]!): FileUpdatePayload @access(scope: "write_files")
  fileDelete(fileIds: [ID!]!): FileDeletePayload @access(scope: "write_files")
  stagedUploadsCreate(input: [StagedUploadInput!]!): StagedUploadsCreatePayload

  collectionCreate(input: CollectionInput!): CollectionCreatePayload @access(scope: "write_products")
  collectionUpdate(input: CollectionInput!): CollectionUpdatePayload @access(scope: "write_products")
  collectionDelete(input: CollectionDeleteInput!): CollectionDeletePayload @access(scope: "write_products")
  collectionAddProducts(id: ID!, productIds: [ID!]!): CollectionAddProductsPayload @access(scope: "write_products")
  collectionRemoveProducts(id: ID!, productIds: [ID!]!): CollectionRemoveProductsPayload @access(scope: "write_products")
  collectionReorderProducts(id: ID!, moves: [MoveInput!]!): CollectionReorderProductsPayload @access(scope: "write_products")

  pageCreate(page: PageCreateInput!): PageCreatePayload @access(scope: "write_content")
  pageUpdate(id: ID!, page: PageUpdateInput!): PageUpdatePayload @access(scope: "write_content")
  pageDelete(id: ID!): PageDeletePayload @access(scope: "write_content")

  metafieldsSet(metafields: [MetafieldsSetInput!]!): MetafieldsSetPayload
  metafieldsDelete(metafields: [MetafieldIdentifierInput!]!): MetafieldsDeletePayload

  translationsRegister(resourceId: ID!, translations: [TranslationInput!]!): TranslationsRegisterPayload @access(scope: "write_translations")
  translationsRemove(resourceId: ID!, translationKeys: [String!]!, locales: [String!]!, marketIds: [ID!]): TranslationsRemovePayload @access(scope: "write_translations")

  discountCodeBasicCreate(basicCodeDiscount: DiscountCodeBasicInput!): DiscountCodeBasicCreatePayload @access(scope: "write_discounts")
  discountCodeBasicUpdate(id: ID!, basicCodeDiscount: DiscountCodeBasicInput!): DiscountCodeBasicUpdatePayload @access(scope: "write_discounts")
  discountCodeDelete(id: ID!): DiscountCodeDeletePayload @access(scope: "write_discounts")
  discountCodeActivate(id: ID!): DiscountCodeActivatePayload @access(scope: "write_discounts")
  discountCodeDeactivate(id: ID!): DiscountCodeDeactivatePayload @access(scope: "write_discounts")

  themeFilesUpsert(themeId: ID!, files: [OnlineStoreThemeFilesUpsertFileInput!]!): ThemeFilesUpsertPayload @access(scope: "write_themes")
  themeFilesDelete(themeId: ID!, files: [String!]!): ThemeFilesDeletePayload @access(scope: "write_themes")

  urlRedirectCreate(urlRedirect: UrlRedirectInput!): UrlRedirectCreatePayload @access(scope: "write_online_store_navigation")
  urlRedirectUpdate(id: ID!, urlRedirect: UrlRedirectInput!): UrlRedirectUpdatePayload @access(scope: "write_online_store_navigation")
  urlRedirectDelete(id: ID!): UrlRedirectDeletePayload @access(scope: "write_online_store_navigation")

  bulkOperationRunQuery(query: String!, groupObjects: Boolean = false): BulkOperationRunQueryPayload
  bulkOperationCancel(id: ID!): BulkOperationCancelPayload

  customerCreate(input: JSON!): CustomerMutationPayload @access(scope: "write_customers") @opaque
  customerUpdate(input: JSON!): CustomerMutationPayload @access(scope: "write_customers") @opaque
}
`;
