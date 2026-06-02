import { Command } from "commander";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { crawl, USER_AGENT } from "./crawler.js";
import { exportResults } from "./exporter.js";
import { matchProducts } from "./matcher.js";
import { VaperaliaConnector } from "./connectors/vaperalia.js";
import { EciglogisticaConnector } from "./connectors/eciglogistica.js";
import { NuevasTendenciasConnector } from "./connectors/nuevastendencias.js";
import { KmlsConnector } from "./connectors/kmls.js";
import { BudsvapeConnector } from "./connectors/budsvape.js";
import { Connector } from "./connectors/connector.js";
import {
  CardExtractionDiagnostic,
  DiscoveredUrl,
  ListingFailure,
  Product,
} from "./types.js";

const program = new Command();

interface CategorySelection {
  connector: string | null;
  id: string;
}

interface ScrapeDiagnostics {
  discoveredUrls: DiscoveredUrl[];
  listingFailures: ListingFailure[];
  cardExtractionErrors: CardExtractionDiagnostic[];
}

program
  .name("vape-catalog-scraper")
  .description("Crawl vape distributor catalogs and export product URLs")
  .option("--limit <n>", "Stop after N total products (for testing)", "0")
  .option("--debug", "Save sample HTML pages to debug/", false)
  .option("--output-dir <path>", "Directory where output.json/output.csv are written", "output")
  .option("--debug-dir <path>", "Directory where debug HTML is written", "debug")
  .option(
    "--connector <name>",
    "Run one connector: vaperalia | eciglogistica | nuevastendencias | kmls | budsvape | all (all = vaperalia + eciglogistica only)",
    "all"
  )
  .option("--concurrency <n>", "Number of parallel tabs for variant enrichment", "5")
  .option(
    "--categories <ids>",
    "Comma-separated category ids. Prefix with connector for multi-distributor runs, e.g. vaperalia:liquidos-4,eciglogistica:pod-systems"
  )
  .action(async (opts) => {
    const limit = parseInt(opts.limit);
    const debug = opts.debug as boolean;
    const connectorName = (opts.connector as string).toLowerCase();
    const concurrency = parseInt(opts.concurrency);
    const outputDir = opts.outputDir as string;
    const debugDir = opts.debugDir as string;
    const categorySelections = parseCategorySelections(opts.categories);

    const connectors: Connector[] = [];
    if (connectorName === "all" || connectorName === "vaperalia") {
      connectors.push(new VaperaliaConnector());
    }
    if (connectorName === "all" || connectorName === "eciglogistica") {
      connectors.push(new EciglogisticaConnector());
    }
    // Excluded from "all" by choice — code kept, run explicitly via
    // --connector <name> (e.g. --connector kmls).
    if (connectorName === "nuevastendencias") {
      connectors.push(new NuevasTendenciasConnector());
    }
    if (connectorName === "kmls") {
      connectors.push(new KmlsConnector());
    }
    if (connectorName === "budsvape") {
      connectors.push(new BudsvapeConnector());
    }

    const crawlTargets = connectors
      .map((connector) => ({
        connector,
        categoryIds: categoryIdsForConnector(connector, categorySelections),
      }))
      .filter((target) => target.categoryIds !== null) as Array<{
        connector: Connector;
        categoryIds?: string[];
      }>;

    if (connectors.length === 0) {
      console.error(
        `Unknown connector: ${connectorName}. Use vaperalia, eciglogistica, or all.`
      );
      process.exit(1);
    }
    if (crawlTargets.length === 0) {
      console.error("No matching connector/category selection to crawl.");
      process.exit(1);
    }

    console.log(
      `Starting crawl: connectors=[${crawlTargets.map((t) => t.connector.name).join(", ")}], limit=${limit || "none"}, concurrency=${concurrency}, debug=${debug}${categorySelections.length > 0 ? `, categories=${categorySelections.map((s) => `${s.connector ? `${s.connector}:` : ""}${s.id}`).join(",")}` : ""}`
    );

    const refreshedDistributors = new Set(
      crawlTargets.map((target) => target.connector.name)
    );
    const isFullRefresh =
      connectorName === "all" && crawlTargets.length === connectors.length;
    const preservedProducts =
      isFullRefresh
        ? []
        : loadPreservedProducts(`${outputDir}/output.json`, refreshedDistributors);
    const allProducts: Product[] = [];
    const diagnostics: ScrapeDiagnostics = {
      discoveredUrls: [],
      listingFailures: [],
      cardExtractionErrors: [],
    };
    writeScrapeDiagnostics(outputDir, diagnostics);

    const browser = await chromium.launch({ headless: true });

    try {
      for (const { connector, categoryIds } of crawlTargets) {
        const remainingLimit =
          limit > 0 ? Math.max(0, limit - allProducts.length) : 0;
        if (limit > 0 && remainingLimit === 0) break;

        const context = await browser.newContext({
          userAgent: USER_AGENT,
        });

        try {
          const result = await crawl(connector, context, {
            limit: limit > 0 ? remainingLimit : 0,
            debug,
            debugDir,
            concurrency,
            categoryIds,
            onSave: (products) => {
              const currentProducts = [
                ...preservedProducts,
                ...allProducts,
                ...products,
              ];
              if (hasMultipleDistributors(currentProducts)) {
                matchProducts(currentProducts);
              }
              exportResults(currentProducts, outputDir);
            },
          });
          allProducts.push(...result.products);
          diagnostics.discoveredUrls.push(...result.discoveredUrls);
          diagnostics.listingFailures.push(...result.listingFailures);
          diagnostics.cardExtractionErrors.push(...result.cardExtractionErrors);
          writeScrapeDiagnostics(outputDir, diagnostics);

          console.log(
            `[${connector.name}] Summary: ${result.products.length} products, ${result.totalPages} pages, ${result.duplicatesSkipped} dupes`
          );
        } finally {
          await context.close();
        }
      }

      // Phase 3: Match products across distributors
      const finalProducts = [...preservedProducts, ...allProducts];

      if (hasMultipleDistributors(finalProducts)) {
        console.log(`\nPhase 3: Matching products across distributors...`);
        const matchResult = matchProducts(finalProducts);
        console.log(
          `[Matcher] Matched ${matchResult.matchedPairs} pairs, ${matchResult.unmatchedCount} unmatched`
        );
      }

      exportResults(finalProducts, outputDir);
      writeScrapeDiagnostics(outputDir, diagnostics);
      console.log(`\nDone. Total: ${finalProducts.length} products.`);

      const finalListingFailures = diagnostics.listingFailures.filter(
        (failure) => failure.final
      );
      if (finalListingFailures.length > 0) {
        console.error(
          `[Scraper] Definitive listing failures: ${finalListingFailures.length}. Diagnostics written to ${outputDir}/listing_failures.json`
        );
        process.exitCode = 2;
      }
    } finally {
      await browser.close();
    }
  });

program.parse();

function loadPreservedProducts(
  jsonPath: string,
  refreshedDistributors: Set<string>
): Product[] {
  try {
    const raw = readFileSync(jsonPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn(
        `[Output] Existing ${jsonPath} is not an array; not preserving products`
      );
      return [];
    }

    const products = parsed.filter(isProduct).filter(
      (product) => !refreshedDistributors.has(product.distributor)
    );

    if (products.length > 0) {
      console.log(
        `[Output] Preserving ${products.length} products from existing output for other distributors`
      );
    }

    return products;
  } catch (err) {
    const code = err instanceof Error && "code" in err ? String(err.code) : "";
    if (code !== "ENOENT") {
      console.warn(
        `[Output] Could not read existing ${jsonPath}: ${err instanceof Error ? err.message : err}`
      );
    }
    return [];
  }
}

function isProduct(value: unknown): value is Product {
  if (!value || typeof value !== "object") return false;
  const product = value as Partial<Product>;
  return (
    typeof product.distributor === "string" &&
    typeof product.name === "string" &&
    typeof product.url === "string"
  );
}

function hasMultipleDistributors(products: Product[]): boolean {
  return new Set(products.map((product) => product.distributor)).size > 1;
}

function writeScrapeDiagnostics(
  outputDir: string,
  diagnostics: ScrapeDiagnostics
): void {
  mkdirSync(outputDir, { recursive: true });
  writeJson(`${outputDir}/discovered_urls.json`, diagnostics.discoveredUrls);
  writeJson(`${outputDir}/listing_failures.json`, diagnostics.listingFailures);
  writeJson(
    `${outputDir}/card_extraction_errors.json`,
    diagnostics.cardExtractionErrors
  );
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function parseCategorySelections(raw: string | undefined): CategorySelection[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf(":");
      if (separator === -1) return { connector: null, id: part };
      return {
        connector: part.slice(0, separator).toLowerCase(),
        id: part.slice(separator + 1),
      };
    })
    .filter((selection) => selection.id.length > 0);
}

function categoryIdsForConnector(
  connector: Connector,
  selections: CategorySelection[]
): string[] | undefined | null {
  if (selections.length === 0) return undefined;

  const connectorKey = connector.name.toLowerCase();
  const matching = selections
    .filter(
      (selection) =>
        selection.connector === null || selection.connector === connectorKey
    )
    .map((selection) => selection.id);

  if (matching.length > 0) return matching;

  const hasConnectorScopedSelections = selections.some(
    (selection) => selection.connector !== null
  );
  return hasConnectorScopedSelections ? null : undefined;
}
