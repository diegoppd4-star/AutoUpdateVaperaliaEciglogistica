import { chromium, BrowserContext } from "playwright";
import { load } from "cheerio";
import { writeFileSync, mkdirSync } from "node:fs";
import { VaperaliaConnector } from "./connectors/vaperalia.js";
import { EciglogisticaConnector } from "./connectors/eciglogistica.js";
import { Connector, CategorySeed } from "./connectors/connector.js";
import { canonicalizeUrl } from "./url-utils.js";
import { expandVariants, fetchHtmlWithRetry, navigateWithRetry, delay } from "./crawler.js";
import { Product } from "./types.js";

const SAMPLE_SIZE = 30;
const VAPERALIA_CONCURRENCY = 5;
const MAX_PAGES_PER_CATEGORY = 100;

function randomSample<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

interface ListedItem {
  name: string;
  url: string;
  categoryId: string;
  category: string;
  categoryUrl: string;
}

async function listAllUrls(connector: Connector, context: BrowserContext): Promise<ListedItem[]> {
  const page = await context.newPage();
  const seen = new Set<string>();
  const results: ListedItem[] = [];

  const seeds: CategorySeed[] = await connector.getCategorySeeds();

  for (const seed of seeds) {
    const seedUrls = seed.urls ?? [seed.url];
    for (const seedUrl of seedUrls) {
      let currentUrl: string | null = seedUrl;
      let pageCount = 0;

      while (currentUrl && pageCount < MAX_PAGES_PER_CATEGORY) {
        const ok = await navigateWithRetry(page, currentUrl);
        if (!ok) break;

        const result = await connector.listProductsFromCategory(page, currentUrl);

        for (const item of result.products) {
          const canonical = canonicalizeUrl(item.url);
          if (!seen.has(canonical)) {
            seen.add(canonical);
            results.push({
              name: item.name,
              url: item.url,
              categoryId: seed.id,
              category: seed.name,
              categoryUrl: seedUrl,
            });
          }
        }

        currentUrl = result.nextPageUrl;
        pageCount++;

        if (currentUrl) await delay(1000);
      }
    }
  }

  await page.close();
  return results;
}

async function enrichVaperalia(
  items: ListedItem[],
  connector: VaperaliaConnector
): Promise<Product[]> {
  const results: Product[] = [];

  for (let i = 0; i < items.length; i += VAPERALIA_CONCURRENCY) {
    const batch = items.slice(i, i + VAPERALIA_CONCURRENCY);
    const batchProducts = await Promise.all(
      batch.map(async (item): Promise<Product[]> => {
        const base: Product = {
          distributor: connector.name,
          name: item.name,
          url: item.url,
          categoryId: item.categoryId,
          category: item.category,
          categoryUrl: item.categoryUrl,
        };

        const html = await fetchHtmlWithRetry(item.url);
        if (html === "NOT_FOUND") return [];
        if (!html) return [{ ...base, variants: {} }];

        const $ = load(html);
        try {
          const enrichment = await connector.enrichProductFromHtml($, item.url);
          if (enrichment.fullName) base.name = enrichment.fullName;
          if (enrichment.brand) base.brand = enrichment.brand;
          if (enrichment.brandCandidates?.length) base.brandCandidates = enrichment.brandCandidates;
          if (enrichment.commercialBrand) base.commercialBrand = enrichment.commercialBrand;
          if (enrichment.productLine) base.productLine = enrichment.productLine;
          if (enrichment.reference) base.reference = enrichment.reference;
          if (enrichment.category) base.category = enrichment.category;
          if (enrichment.breadcrumbPath) base.breadcrumbPath = enrichment.breadcrumbPath;
          if (enrichment.priceTaxExcluded !== undefined) base.priceTaxExcluded = enrichment.priceTaxExcluded;
          if (enrichment.description) base.description = enrichment.description;
          if (enrichment.metaDescription) base.metaDescription = enrichment.metaDescription;
          return expandVariants(
            base,
            enrichment.variants,
            enrichment.variantUrlSegments,
            enrichment.variantReferenceValues
          );
        } catch (err) {
          console.warn(`[vaperalia] enrich failed ${item.url}: ${err instanceof Error ? err.message : err}`);
          return [{ ...base, variants: {} }];
        }
      })
    );

    for (const products of batchProducts) results.push(...products);
    console.log(`[vaperalia] enriched ${Math.min(i + VAPERALIA_CONCURRENCY, items.length)}/${items.length}`);
  }

  return results;
}

async function enrichEcig(
  items: ListedItem[],
  connector: EciglogisticaConnector,
  context: BrowserContext
): Promise<Product[]> {
  const results: Product[] = [];
  const detailPage = await context.newPage();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const base: Product = {
      distributor: connector.name,
      name: item.name,
      url: item.url,
      categoryId: item.categoryId,
      category: item.category,
      categoryUrl: item.categoryUrl,
    };

    await delay(connector.delayMs ?? 600);
    const ok = await navigateWithRetry(detailPage, item.url);

    if (!ok) {
      results.push({ ...base, variants: {} });
      console.warn(`[eciglogistica] nav failed ${item.url}`);
      continue;
    }

    try {
      const html = await detailPage.content();
      const $ = load(html);
      const enrichment = await connector.enrichProductFromHtml($, item.url);
      if (enrichment.fullName) base.name = enrichment.fullName;
      if (enrichment.brand) base.brand = enrichment.brand;
      if (enrichment.brandCandidates?.length) base.brandCandidates = enrichment.brandCandidates;
      if (enrichment.commercialBrand) base.commercialBrand = enrichment.commercialBrand;
      if (enrichment.productLine) base.productLine = enrichment.productLine;
      if (enrichment.reference) base.reference = enrichment.reference;
      if (enrichment.category) base.category = enrichment.category;
      if (enrichment.breadcrumbPath) base.breadcrumbPath = enrichment.breadcrumbPath;
      if (enrichment.priceTaxExcluded !== undefined) base.priceTaxExcluded = enrichment.priceTaxExcluded;
      if (enrichment.description) base.description = enrichment.description;
      if (enrichment.metaDescription) base.metaDescription = enrichment.metaDescription;
      results.push(...expandVariants(base, enrichment.variants));
    } catch (err) {
      console.warn(`[eciglogistica] enrich failed ${item.url}: ${err instanceof Error ? err.message : err}`);
      results.push({ ...base, variants: {} });
    }

    console.log(`[eciglogistica] enriched ${i + 1}/${items.length}`);
  }

  await detailPage.close();
  return results;
}

async function main(): Promise<void> {
  const vaperalia = new VaperaliaConnector();
  const ecig = new EciglogisticaConnector();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  try {
    console.log("=== Phase 1: listing URLs ===");

    console.log("[vaperalia] listing all product URLs...");
    const vaperaliaPool = await listAllUrls(vaperalia, context);
    console.log(`[vaperalia] pool: ${vaperaliaPool.length} URLs`);

    console.log("[eciglogistica] listing all product URLs...");
    const ecigPool = await listAllUrls(ecig, context);
    console.log(`[eciglogistica] pool: ${ecigPool.length} URLs`);

    console.log("\n=== Phase 2: random sample ===");
    const vaperaliaItems = randomSample(vaperaliaPool, SAMPLE_SIZE);
    const ecigItems = randomSample(ecigPool, SAMPLE_SIZE);
    console.log(`sampled ${vaperaliaItems.length} vaperalia + ${ecigItems.length} eciglogistica`);

    console.log("\n=== Phase 3: enrichment ===");

    console.log("[vaperalia] enriching...");
    const vaperaliaProducts = await enrichVaperalia(vaperaliaItems, vaperalia);

    console.log("[eciglogistica] enriching...");
    const ecigProducts = await enrichEcig(ecigItems, ecig, context);

    console.log("\n=== Phase 4: export ===");
    const allProducts: Product[] = [...vaperaliaProducts, ...ecigProducts];
    mkdirSync("output", { recursive: true });
    writeFileSync("output/comprobacion.json", JSON.stringify(allProducts, null, 2), "utf-8");

    console.log(
      `Done. ${allProducts.length} rows (${vaperaliaProducts.length} vaperalia, ${ecigProducts.length} eciglogistica)`
    );
    console.log("Written to: output/comprobacion.json");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
