import { Page } from "playwright";
import { CheerioAPI } from "cheerio";
import { EnrichmentResult } from "../types.js";

export interface CategoryResult {
  products: Array<{ name: string; url: string }>;
  nextPageUrl: string | null;
  cardExtractionErrors?: CardExtractionError[];
}

export interface CardExtractionError {
  cardIndex: number;
  reason: string;
  href?: string;
  name?: string;
  snippet?: string;
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
  /** Phase 2 transport. Browser mode reuses Playwright session/cookies for stricter sites. Defaults to HTTP. */
  phase2FetchMode?: "http" | "browser";
  /** Override inter-product delay (ms) for inline enrichment. Falls back to crawler's DELAY_MS. */
  delayMs?: number;
  /** When true, any final category listing failure makes the crawl fail instead of returning partial data. */
  failOnListingFailures?: boolean;
  /** Accept a 404 from a next-page link as the end of pagination. Seed-page 404s remain failures. */
  linkedPaginationNotFoundEndsCategory?: boolean;
  /** When true, any product detail enrichment failure makes the crawl fail instead of returning partial data. */
  failOnEnrichErrors?: boolean;
  /** Optional maximum Phase 2 workers for this connector. */
  phase2Concurrency?: number;
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
