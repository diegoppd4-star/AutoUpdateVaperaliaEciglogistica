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
}
