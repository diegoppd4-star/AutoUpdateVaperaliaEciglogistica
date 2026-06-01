import { BrowserContext, Page } from "playwright";
import { load } from "cheerio";
import { Connector } from "./connectors/connector.js";
import { Product, CrawlResult } from "./types.js";
import { canonicalizeUrl } from "./url-utils.js";
import { buildSyntheticReference } from "./sku-builder.js";

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface CrawlOptions {
  limit: number;
  debug: boolean;
  debugDir: string;
  concurrency: number;
  categoryIds?: string[];
  onSave?: (products: Product[]) => void;
}

const DELAY_MS = 1000;
const PHASE2_DELAY_MS = 300;
const MAX_RETRIES = 3;
const MAX_PAGES_PER_CATEGORY = 100;
const SAVE_INTERVAL = 200;
const LOG_INTERVAL = 50;

export async function crawl(
  connector: Connector,
  context: BrowserContext,
  options: CrawlOptions
): Promise<CrawlResult> {
  const products: Product[] = [];
  const seenUrls = new Set<string>();
  let totalPages = 0;
  let duplicatesSkipped = 0;
  let debugSamples = 0;

  const inlineMode = connector.enrichInline === true;
  const inlineProducts: Product[] = [];
  const seeds = await connector.getCategorySeeds(options.categoryIds);

  // Phase 1: crawl category listings (single tab, sequential)
  const listingPage = await context.newPage();
  const detailPage = inlineMode ? await context.newPage() : null;
  try {
    console.log(
      `[${connector.name}] Phase 1: Crawling ${seeds.length} categories${inlineMode ? " (inline enrichment)" : ""}`
    );

    for (const seed of seeds) {
      if (options.limit > 0 && products.length >= options.limit) break;

      const seedUrls = seed.urls && seed.urls.length > 0 ? seed.urls : [seed.url];
      let categoryPageCount = 0;

      for (const seedUrl of seedUrls) {
        if (options.limit > 0 && products.length >= options.limit) break;

        let currentUrl: string | null = seedUrl;
        const visitedInCategory = new Set<string>();

        while (currentUrl) {
          if (options.limit > 0 && products.length >= options.limit) break;
          if (categoryPageCount >= MAX_PAGES_PER_CATEGORY) {
            console.warn(`[${connector.name}] Hit max pages limit for category`);
            break;
          }
          if (visitedInCategory.has(currentUrl)) {
            console.warn(
              `[${connector.name}] Detected pagination loop, stopping category`
            );
            break;
          }
          visitedInCategory.add(currentUrl);

          console.log(
            `[${connector.name}] Fetching: ${currentUrl} (${products.length} products so far)`
          );

          const success = await navigateWithRetry(listingPage, currentUrl);
          if (!success) {
            console.error(
              `[${connector.name}] Failed to load after retries: ${currentUrl}`
            );
            break;
          }

          totalPages++;
          categoryPageCount++;

          if (options.debug && debugSamples < 2) {
            await saveDebugHtml(
              listingPage,
              connector.name,
              debugSamples,
              options.debugDir
            );
            debugSamples++;
          }

          const result = await connector.listProductsFromCategory(
            listingPage,
            currentUrl
          );

          for (const item of result.products) {
            if (options.limit > 0 && products.length >= options.limit) break;

            const canonical = canonicalizeUrl(item.url);
            if (seenUrls.has(canonical)) {
              duplicatesSkipped++;
              continue;
            }
            seenUrls.add(canonical);

            const product: Product = {
              distributor: connector.name,
              name: item.name,
              url: item.url,
              categoryId: seed.id,
              category: seed.name,
              categoryUrl: seed.url,
            };
            products.push(product);

            // Inline enrichment: fetch variants immediately using the detail tab
            if (inlineMode && detailPage) {
              try {
                await delay(connector.delayMs ?? DELAY_MS);
                const navOk = await navigateWithRetry(detailPage, item.url);
                if (navOk) {
                  let rawVariants: Record<string, string[]> = {};

                  const html = await detailPage.content();
                  const $ = load(html);
                  const enrichment = await connector.enrichProductFromHtml($, item.url);
                  rawVariants = enrichment.variants;
                  if (enrichment.brand != null) product.brand = enrichment.brand;
                  if (enrichment.brandCandidates != null) product.brandCandidates = enrichment.brandCandidates;
                  if (enrichment.commercialBrand != null) product.commercialBrand = enrichment.commercialBrand;
                  if (enrichment.productLine) product.productLine = enrichment.productLine;
                  if (enrichment.reference) product.reference = enrichment.reference;
                  if (enrichment.fullName) product.name = enrichment.fullName;
                  if (enrichment.category) product.category = enrichment.category;
                  if (enrichment.breadcrumbPath?.length) product.breadcrumbPath = enrichment.breadcrumbPath;
                  if (enrichment.priceTaxExcluded != null) product.priceTaxExcluded = enrichment.priceTaxExcluded;
                  if (enrichment.description) product.description = enrichment.description;
                  if (enrichment.metaDescription) product.metaDescription = enrichment.metaDescription;
                  if (enrichment.category && enrichment.brand) {
                    const synRef = buildSyntheticReference(product.name, enrichment.brand, enrichment.category);
                    if (synRef) product.syntheticReference = synRef;
                  }

                  const expanded = expandVariants(
                    product,
                    rawVariants,
                    enrichment.variantUrlSegments,
                    enrichment.variantReferenceValues
                  );
                  inlineProducts.push(...expanded);
                } else {
                  console.warn(`[${connector.name}] Inline enrich failed: ${item.url}`);
                  inlineProducts.push({ ...product, variants: {} });
                }
              } catch (err) {
                console.warn(
                  `[${connector.name}] Inline enrich error: ${item.url}: ${err instanceof Error ? err.message : err}`
                );
                inlineProducts.push({ ...product, variants: {} });
              }
            }
          }

          currentUrl = result.nextPageUrl;
          if (currentUrl) {
            await delay(DELAY_MS);
          }
        }

        await delay(DELAY_MS);
      }

      console.log(
        `[${connector.name}] Category done (${categoryPageCount} pages)`
      );
      await delay(DELAY_MS);
    }
  } finally {
    if (detailPage) await detailPage.close();
    await listingPage.close();
  }

  console.log(
    `[${connector.name}] Phase 1 complete: ${products.length} products, ${duplicatesSkipped} duplicates skipped${inlineMode ? `, ${inlineProducts.length} rows after inline expansion` : ""}`
  );

  // Skip Phase 2 for inline-enriched connectors
  if (inlineMode) {
    console.log(
      `[${connector.name}] Phase 2 skipped (inline enrichment already done)`
    );

    if (options.onSave) {
      options.onSave(inlineProducts);
    }

    return {
      products: inlineProducts,
      totalCategories: seeds.length,
      totalPages,
      duplicatesSkipped,
    };
  }

  // Phase 2: enrich products with variants (HTTP + Cheerio)
  const concurrency = Math.min(5, Math.max(1, options.concurrency));
  console.log(
    `[${connector.name}] Phase 2: Enriching ${products.length} products (HTTP+Cheerio, ${concurrency} workers)`
  );

  let enriched = 0;
  let enrichErrors = 0;
  let lastSaveAt = 0;
  const expandedProducts: Product[] = [];

  const queue = products.map((_, i) => i);

  async function enrichWorker() {
    while (queue.length > 0) {
      const idx = queue.shift()!;
      const product = products[idx];

      await delay(PHASE2_DELAY_MS);

      let rawVariants: Record<string, string[]> = {};
      let variantUrlSegments: Record<string, Record<string, string>> | undefined;
      let variantReferenceValues: Record<string, Record<string, string>> | undefined;
      try {
        const html = await fetchHtmlWithRetry(product.url);
        if (html === "NOT_FOUND") {
          console.warn(
            `[${connector.name}] Product not found (404), removing from output: ${product.url}`
          );
          enrichErrors++;
          enriched++;
          continue;
        }
        if (!html) {
          console.warn(
            `[${connector.name}] Enrich failed (fetch): ${product.url}`
          );
          // If listing gave a slug as name, derive human-readable name from the URL path
          if (/^[a-z0-9-]+$/.test(product.name)) {
            const seg = product.url.replace(/\/$/, "").split("/").pop() ?? "";
            if (seg) {
              product.name = seg
                .split("-")
                .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                .join(" ");
            }
          }
          // Extract brand from URL subcategory or name when page is unreachable
          const urlBrand = brandFromUrlOrName(product.url, product.name);
          if (urlBrand) {
            product.brand ??= urlBrand;
            product.commercialBrand ??= urlBrand;
            product.brandCandidates ??= [urlBrand];
          } else {
            product.brand ??= "";
            product.commercialBrand ??= "";
            product.brandCandidates ??= [];
          }
          // Use product name as metaDescription fallback when page is unreachable
          product.metaDescription ??= product.name;
          enrichErrors++;
          enriched++;
          expandedProducts.push({ ...product, variants: {} });
          continue;
        }

        const $ = load(html);
        const enrichment = await connector.enrichProductFromHtml($, product.url);
        rawVariants = enrichment.variants;
        variantUrlSegments = enrichment.variantUrlSegments;
        variantReferenceValues = enrichment.variantReferenceValues;
        if (enrichment.fullName) product.name = enrichment.fullName;
        if (enrichment.brand != null) product.brand = enrichment.brand;
        if (enrichment.brandCandidates != null) product.brandCandidates = enrichment.brandCandidates;
        if (enrichment.commercialBrand != null) product.commercialBrand = enrichment.commercialBrand;
        if (enrichment.productLine) product.productLine = enrichment.productLine;
        if (enrichment.reference) product.reference = enrichment.reference;
        if (enrichment.category) product.category = enrichment.category;
        if (enrichment.breadcrumbPath?.length) product.breadcrumbPath = enrichment.breadcrumbPath;
        if (enrichment.priceTaxExcluded != null) product.priceTaxExcluded = enrichment.priceTaxExcluded;
        if (enrichment.description) product.description = enrichment.description;
        if (enrichment.metaDescription) product.metaDescription = enrichment.metaDescription;
        if (enrichment.category && enrichment.brand) {
          const synRef = buildSyntheticReference(product.name, enrichment.brand, enrichment.category);
          if (synRef) product.syntheticReference = synRef;
        }
        enriched++;
      } catch (err) {
        console.warn(
          `[${connector.name}] Enrich error: ${product.url}: ${err instanceof Error ? err.message : err}`
        );
        enrichErrors++;
        enriched++;
        expandedProducts.push({ ...product, variants: {} });
        continue;
      }

      const expanded = expandVariants(
        product,
        rawVariants,
        variantUrlSegments,
        variantReferenceValues
      );
      expandedProducts.push(...expanded);

      if (enriched % LOG_INTERVAL === 0) {
        console.log(
          `[${connector.name}] Enriched ${enriched}/${products.length} (${enrichErrors} errors, ${expandedProducts.length} rows)`
        );
      }

      if (options.onSave && enriched - lastSaveAt >= SAVE_INTERVAL) {
        lastSaveAt = enriched;
        options.onSave(expandedProducts);
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => enrichWorker());
  await Promise.all(workers);

  // Final save after enrichment
  if (options.onSave) {
    options.onSave(expandedProducts);
  }

  console.log(
    `[${connector.name}] Phase 2 complete: ${enriched} enriched, ${enrichErrors} errors, ${expandedProducts.length} rows after expansion`
  );

  return {
    products: expandedProducts,
    totalCategories: seeds.length,
    totalPages,
    duplicatesSkipped,
  };
}

export function expandVariants(
  product: Product,
  rawVariants: Record<string, string[]>,
  variantUrlSegments?: Record<string, Record<string, string>>,
  variantReferenceValues?: Record<string, Record<string, string>>
): Product[] {
  const dimensions = Object.entries(rawVariants).filter(
    ([, values]) => values.length > 0
  );

  if (dimensions.length === 0) {
    return [{ ...product, variants: {} }];
  }

  // Generate cartesian product of all dimensions
  let combinations: Record<string, string>[] = [{}];
  for (const [key, values] of dimensions) {
    const next: Record<string, string>[] = [];
    for (const combo of combinations) {
      for (const value of values) {
        next.push({ ...combo, [key]: value });
      }
    }
    combinations = next;
  }

  return combinations.map((combo) => {
    const suffix = Object.values(combo).join(" / ");
    const url = buildVariantUrl(product.url, combo, variantUrlSegments);
    const derivedColor = buildDerivedColor(combo, variantReferenceValues);
    return {
      ...product,
      name: `${product.name} - ${suffix}`,
      url,
      variants: combo,
      ...(derivedColor ? { derived: { ...product.derived, matchedReferenceColor: derivedColor } } : {}),
    };
  });
}

function buildDerivedColor(
  combo: Record<string, string>,
  variantReferenceValues?: Record<string, Record<string, string>>
): string | null {
  if (!variantReferenceValues) return null;
  for (const [key, value] of Object.entries(combo)) {
    const ref = variantReferenceValues[key]?.[value];
    if (ref) return ref;
  }
  return null;
}

function buildVariantUrl(
  baseUrl: string,
  combo: Record<string, string>,
  variantUrlSegments?: Record<string, Record<string, string>>
): string {
  if (!variantUrlSegments) return baseUrl;

  const segments = Object.entries(combo)
    .map(([key, value]) => variantUrlSegments[key]?.[value])
    .filter((segment): segment is string => Boolean(segment));

  if (segments.length === 0) return baseUrl;
  const cleanBase = baseUrl.split("#")[0];
  return `${cleanBase}#/${segments.join("/")}`;
}

export async function navigateWithRetry(page: Page, url: string): Promise<boolean> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      return true;
    } catch (err) {
      console.warn(
        `Navigation attempt ${attempt + 1} failed for ${url}: ${err instanceof Error ? err.message : err}`
      );
      if (attempt < MAX_RETRIES) {
        await delay(2000);
      }
    }
  }
  return false;
}

async function saveDebugHtml(
  page: Page,
  connectorName: string,
  index: number,
  debugDir: string
): Promise<void> {
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(debugDir, { recursive: true });
    const html = await page.content();
    const filename = `${debugDir}/${connectorName.toLowerCase()}_sample_${index}.html`;
    writeFileSync(filename, html, "utf-8");
    console.log(`[debug] Saved ${filename}`);
  } catch (err) {
    console.warn(`[debug] Failed to save HTML: ${err}`);
  }
}

export async function fetchHtmlWithRetry(url: string): Promise<string | null | "NOT_FOUND"> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timeout);
      if (!res.ok) {
        if (res.status === 404) {
          console.warn(`HTTP 404 for ${url} — product no longer exists`);
          return "NOT_FOUND";
        }
        if ((res.status === 429 || res.status === 403) && attempt < MAX_RETRIES) {
          const backoff = 5000 * (attempt + 1);
          console.warn(`HTTP ${res.status} for ${url}, retrying in ${backoff}ms...`);
          await delay(backoff);
          continue;
        }
        console.warn(`HTTP ${res.status} for ${url}`);
        return null;
      }
      return await res.text();
    } catch (err) {
      console.warn(
        `Fetch attempt ${attempt + 1} failed for ${url}: ${err instanceof Error ? err.message : err}`
      );
      if (attempt < MAX_RETRIES) {
        await delay(3000 * (attempt + 1));
      }
    }
  }
  return null;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// When a product page is unreachable, try to derive brand from:
// 1. A subcategory URL segment between the category path and product slug
// 2. The first non-stopword capitalized token in the product name
function brandFromUrlOrName(url: string, name: string): string | undefined {
  const STOPWORDS = new Set([
    "vaper", "vapers", "desechable", "desechables", "pack", "sabores", "bote",
    "sales", "de", "del", "la", "el", "los", "las", "un", "una", "y", "e",
    "o", "en", "con", "por", "para", "al", "ml", "nic", "top", "individual",
    "envase", "bolsa", "flores", "aceite", "aroma", "base", "nicokit",
    "cajetilla", "sobre", "sobres", "recargable", "pod", "pods",
  ]);

  // Extract path segments after /producto/
  const m = url.match(/\/producto\/([^?#]+)/);
  if (m) {
    const segs = m[1].split("/").filter(Boolean);
    // If there's a subcategory segment (4+ path parts), second-to-last is the subcategory
    if (segs.length >= 4) {
      const subcatSlug = segs[segs.length - 2];
      const firstToken = subcatSlug.split("-")[0];
      if (firstToken && firstToken.length > 2 && !STOPWORDS.has(firstToken.toLowerCase())) {
        return firstToken.charAt(0).toUpperCase() + firstToken.slice(1);
      }
    }
  }

  // Fallback: first non-stopword capitalized word from the product name
  for (const word of name.split(/\s+/)) {
    const lower = word.toLowerCase().replace(/[^a-záéíóúñ]/g, "");
    if (lower.length > 2 && !STOPWORDS.has(lower) && /^[A-ZÁÉÍÓÚÑ]/.test(word)) {
      return word;
    }
  }

  return undefined;
}
