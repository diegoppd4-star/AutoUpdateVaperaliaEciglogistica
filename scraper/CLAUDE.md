# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project context

TypeScript CLI that crawls vape distributor catalogs (Vaperalia, Eciglogistica, NuevasTendencias, KMLS, Budsvape), extracts products with variants, and exports to CSV/JSON. Sibling project of VapeItReorder — generates the product URLs that VapeItReorder needs in its `PRODUCTO_DISTRIBUIDORA` table.

## Setup

```bash
npm install
npx playwright install chromium   # Required browser binary
```

## Build & Run

```bash
npm run build          # TypeScript → dist/
npm start              # Full crawl (all distributors + matching + export)
npm start -- --connector vaperalia --limit 10 --debug   # Single connector, limited
npm run serve          # Dashboard server at http://localhost:8082
npm run dev            # Build + run
npm run check          # Sample-validation workflow (30 random products per distributor) → output/comprobacion.json
```

CLI options: `--connector <vaperalia|eciglogistica|nuevastendencias|kmls|budsvape|all>`, `--limit <n>`, `--debug`, `--concurrency <n>`, `--categories <ids>`. **`all` runs only Vaperalia + Eciglogistica** by design; nuevastendencias/kmls/budsvape are kept in the codebase but excluded from `all` — run them explicitly via `--connector <name>`. The dashboard (`server.ts`) is likewise scoped to the two.

No test suite or linter is configured. TypeScript strict mode is on (`tsconfig.json`).

## Module system

ES modules throughout (`"type": "module"` in package.json, `NodeNext` module resolution). All local imports must use `.js` extension (e.g., `import { Product } from "./types.js"`).

## Architecture

Three-phase pipeline: **Crawl → Enrich → Match**.

### Phase 1: List products (Playwright)
`src/crawler.ts` drives a Playwright browser through category pages via connectors. Each connector (`src/connectors/`) implements `getCategorySeeds()`, `listProductsFromCategory()`, and `enrichProductFromHtml()`.

### Phase 2: Enrich product details
Two modes controlled by `connector.enrichInline`:
- **Standard** (Vaperalia): Phase 1 collects URLs only, then Phase 2 fetches each product page via HTTP+Cheerio with concurrent workers. Names are truncated in listings so the full name comes from the `<h1>` on the detail page.
- **Inline** (Eciglogistica): Phase 1 opens a second Playwright tab per product during listing traversal. This avoids Cloudflare blocks by reusing the browser session. No Phase 2 needed.

Both modes call `connector.enrichProductFromHtml()` which returns `EnrichmentResult` with variants, fullName, brand, and reference. The crawler then runs `expandVariants()` — a cartesian product that creates one Product row per variant combination (e.g., 10 colors × 3 nicotine levels = 30 rows).

### Phase 3: Cross-distributor matching (`src/matcher.ts`)
Only runs when multiple connectors are used. Two-level matching:

1. **Base product matching**: TF-IDF cosine similarity on normalized product names with brand-based blocking. Greedy 1:1 assignment, threshold 0.45.
2. **Variant matching**: Within each matched base pair, matches individual variant rows (colors, nicotine levels, etc.) using Jaccard similarity on normalized variant values. Threshold 0.6.

SKU format: `BASE-VARIANT` (e.g., `K-XROS.5.MINI-BLACK`). Base SKU uses Vaperalia's `productReference` when available, otherwise generates `BRAND-hash`.

### SKU builder (`src/sku-builder.ts`)
Builds synthetic Eciglogistica references in Vaperalia's `PREFIX-BODY` format so `matcher.ts` can compare references across distributors. Exports `buildSyntheticReference(title, brand, category)`, `extractReferenceBody(ref)`, and `isHardwareReference(ref)`. Prefix letters: K=kits, R=coils, D=disposables, C=atomizers, B=batteries, A=accessories, W=DIY.

### URL utils (`src/url-utils.ts`)
`canonicalizeUrl(raw)` — strips tracking params (`utm_*`, `fbclid`, etc.) and normalizes trailing slashes. Used to deduplicate product URLs before enrichment.

### Export (`src/exporter.ts`)
Writes three sets of files:
- `output/output.json` and `output/output.csv` — combined (all distributors)
- `output/<distributor>.json` and `output/<distributor>.csv` — one per distributor (e.g. `vaperalia.json`, `eciglogistica.json`, `nuevastendencias.json`)
- `output/categories/<distributor>__<categoryId>.{json,csv}` — one per (distributor, category) pair

The dashboard (`output/index.html`) reads the combined JSON.

### Server (`src/server.ts`)
HTTP server on port 8082. Serves static files from `output/`, exposes `/api/scrape`, `/api/status`, `/api/stop` for triggering crawls from the dashboard.

## Runtime artifacts

- `output/` — final JSON/CSV exports and dashboard HTML
- `debug/` — per-run HTML dumps saved when `--debug` is active
- `docs/CONNECTOR_GUIDE.md` — official guide for building a new connector (read before adding distributors)

## Key design decisions

- **Vaperalia names are truncated** in category listings. The full name must come from the detail page `<h1>`, set BEFORE `expandVariants()` so variant suffixes append to the complete name.
- **Brand extraction differs per distributor**: Vaperalia parses the last segment of `<h1>` after " - "; Eciglogistica extracts from gtag analytics JSON; NuevasTendencias from schema.org JSON-LD `brand.name` (Yoast SEO `@graph` pattern) with WooCommerce attributes table as fallback.
- **Reference extraction**: Vaperalia from `productReference` JS variable; Eciglogistica from `<p class="grey-texts">Ref.: ...`; NuevasTendencias from schema.org `sku` field (accepts number or string).
- **Price extraction**: Vaperalia from `productPriceTaxExcluded` JS variable; Eciglogistica from gtag `"price"`; NuevasTendencias from schema.org `offers[].priceSpecification[].price` (simple) or `offers[].lowPrice` (AggregateOffer/variable).
- **Single-char tokens preserved in tokenizer** (`t.length > 1 || /\d/.test(t)`) because model numbers like "5" in "Xros 5 Mini" are critical for distinguishing product generations.

## Connectors

| Connector | Site | Theme | Enrichment mode | Pagination |
|---|---|---|---|---|
| `vaperalia` | vaperalia.es | PrestaShop | Phase 2 HTTP+Cheerio | `?page=N` or `a.next` |
| `eciglogistica` | nueva.eciglogistica.com | Custom | Inline Playwright (Cloudflare) | `/pagina/N` arrow link |
| `nuevastendencias` | nuevas-tendencias.com | WordPress/WooCommerce (Woodmart) | Phase 2 HTTP+Cheerio | `<link rel="next">` in `<head>` |
| `kmls` | kmls.fr | PrestaShop (B2B) | Phase 2 HTTP+Cheerio | `<link rel="next">` in `<head>` |
| `budsvape` | budsvape-distribution.com | PrestaShop (B2B) | Phase 2 HTTP+Cheerio | `<link rel="next">` in `<head>` |

## Adding a new connector

**Read `docs/CONNECTOR_GUIDE.md` first.** It documents the interface, platform recipes, and field extraction patterns.

Follow the guide. Steps: create `src/connectors/<slug>.ts` implementing `Connector`, register in `src/index.ts` (import + if-block + `--connector` description), run `npm run build`, smoke test with `npm start -- --connector <slug> --limit 10 --debug`.

## Sample validation workflow (`src/comprobacion.ts`)
`npm run check` lists ALL product URLs from each distributor, randomly samples 30 per distributor (Fisher-Yates), enriches just those 60, and writes `output/comprobacion.json`. Used to spot-check connector output without running a full crawl.
