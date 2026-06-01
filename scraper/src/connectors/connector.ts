import { Page } from "playwright";
import { CheerioAPI } from "cheerio";
import { EnrichmentResult } from "../types.js";

export interface CategoryResult {
  products: Array<{ name: string; url: string }>;
  nextPageUrl: string | null;
}

export interface CategorySeed {
  id: string;
  name: string;
  url: string;
  urls?: string[];
}

export interface Connector {
  name: string;
  baseUrl: string;
  /** When true, variants are extracted during Phase 1 using a second Playwright tab (same session/cookies). */
  enrichInline?: boolean;
  /** Override inter-product delay (ms) for inline enrichment. Falls back to crawler's DELAY_MS. */
  delayMs?: number;
  getCategorySeeds(categoryIds?: string[]): Promise<CategorySeed[]>;
  listProductsFromCategory(
    page: Page,
    categoryUrl: string
  ): Promise<CategoryResult>;
  enrichProductFromHtml(
    $: CheerioAPI,
    productUrl: string
  ): EnrichmentResult | Promise<EnrichmentResult>;
}
