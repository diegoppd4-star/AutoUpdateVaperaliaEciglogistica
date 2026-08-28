export type ProductVariants = Record<string, string>;

export interface Product {
  distributor: string;
  name: string;
  url: string;
  variants?: ProductVariants;
  sku?: string;
  brand?: string;
  brandCandidates?: string[];
  commercialBrand?: string;
  productLine?: string;
  reference?: string;
  syntheticReference?: string;
  categoryId?: string;
  category?: string;
  categoryUrl?: string;
  breadcrumbPath?: string[];
  priceTaxExcluded?: number;
  description?: string;
  metaDescription?: string;
  derived?: {
    matchedReferenceColor?: string;
    matchedBrandAlias?: string;
  };
}

export interface KnownProductSeed {
  distributor?: string;
  name?: string;
  url: string;
  categoryId?: string;
  category?: string;
  categoryUrl?: string;
}

export interface EnrichmentResult {
  variants: Record<string, string[]>;
  variantUrlSegments?: Record<string, Record<string, string>>;
  variantReferenceValues?: Record<string, Record<string, string>>;
  /**
   * Supplier identifiers for complete variant combinations. An explicit empty
   * array means variants exist but no trustworthy per-combination identifier
   * was available; callers must not fall back to the parent product identifier.
   */
  variantSourceReferences?: VariantSourceReference[];
  fullName?: string;
  brand?: string;
  brandCandidates?: string[];
  commercialBrand?: string;
  productLine?: string;
  reference?: string;
  category?: string;
  breadcrumbPath?: string[];
  priceTaxExcluded?: number;
  description?: string;
  metaDescription?: string;
}

export interface VariantSourceReference {
  attributeValues: string[];
  sourceReference: string;
}

export interface CrawlResult {
  products: Product[];
  totalCategories: number;
  totalPages: number;
  duplicatesSkipped: number;
  discoveredUrls: DiscoveredUrl[];
  listingFailures: ListingFailure[];
  cardExtractionErrors: CardExtractionDiagnostic[];
}

export interface DiscoveredUrl {
  connector: string;
  categoryId: string;
  category: string;
  categoryUrl: string;
  listingPageUrl: string;
  productUrl: string;
  productName: string;
  canonicalUrl: string;
  duplicate: boolean;
  discoveredAt: string;
}

export interface ListingFailure {
  connector: string;
  categoryId: string;
  category: string;
  categoryUrl: string;
  listingPageUrl: string;
  phase: "initial" | "retry";
  final: boolean;
  reason: string;
  failedAt: string;
}

export interface CardExtractionDiagnostic {
  connector: string;
  categoryId: string;
  category: string;
  categoryUrl: string;
  listingPageUrl: string;
  cardIndex: number;
  reason: string;
  href?: string;
  name?: string;
  snippet?: string;
  failedAt: string;
}
