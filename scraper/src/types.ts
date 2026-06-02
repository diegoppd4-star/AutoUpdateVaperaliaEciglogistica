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

export interface EnrichmentResult {
  variants: Record<string, string[]>;
  variantUrlSegments?: Record<string, Record<string, string>>;
  variantReferenceValues?: Record<string, Record<string, string>>;
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
