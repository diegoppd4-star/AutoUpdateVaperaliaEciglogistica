# VapeCatalogScraper — Architecture Reference

This document is a complete technical reference for any agent or developer who needs to understand, debug, or modify the scraper. It covers every stage of the pipeline with exact file paths, function names, and data flow.

---

## Overview

Three-phase pipeline: **Crawl → Enrich → Match → Export**.

```
npm start
  └─ index.ts            CLI parse, orchestration
       └─ crawler.ts      Phase 1 (listing) + Phase 2 (enrichment)
            └─ connector  Per-distributor extraction logic
       └─ matcher.ts      Phase 3: cross-distributor product matching
       └─ exporter.ts     JSON + CSV output
```

Output is a flat array of `Product` rows — one row per variant combination (e.g., 10 colors × 3 nic levels = 30 rows from 1 product page).

---

## Extraction contract from distributor HTML

This section records scraping rules that must be treated as data-contract requirements, based on live product-page HTML observed on 2026-05-13 from both distributors.

### General principle

The scraper must preserve **all visible identity signals** separately. Do not collapse them into a single `brand` string too early.

Required identity fields on every enriched product/profile:

```ts
{
  brand?: string                 // primary/manufacturer brand used by the site
  brandCandidates?: string[]     // all visible manufacturer/commercial aliases usable for matching
  commercialBrand?: string       // visible commercial/sub-brand when different from primary brand
  productLine?: string           // optional derived collection/line; never use as brand by itself
  breadcrumbPath?: string[]      // product detail breadcrumb, cleaned
  metaDescription?: string       // meta description, as weak descriptive text
}
```

Matching should use `brandCandidates` intersection. `brand`, `commercialBrand`, and `productLine` are not interchangeable.

`productLine` is not a required raw HTML field. Fill it only when the page explicitly exposes a line/collection or when it can be derived conservatively from title/breadcrumb with clear evidence. Otherwise leave it empty and let the downstream normalizer derive line candidates if needed.

Examples:

- Eciglogistica `A&L Ultimate Sweet Edition Oni Aroma 30ml`
  - `brand`: `Aromes et liquides`
  - `brandCandidates`: `["Aromes et liquides", "A&L"]`
  - `commercialBrand`: `A&L`
  - `productLine`: `Ultimate Sweet Edition` (derived from title/breadcrumb evidence, not a standalone raw field)
  - `breadcrumbPath`: `["ALQUIMIA", "AROMAS", "Aromes et liquides", "A&L", "A&L Ultimate Sweet Edition Oni Aroma 30ml"]`
- Vaperalia `Aroma Green Oasis 30ml - A&L Hidden Potion`
  - `brand`: `A&L Hidden Potion`
  - `brandCandidates`: `["A&L Hidden Potion", "A&L"]`
  - `commercialBrand`: `A&L Hidden Potion`

### Do not treat product lines as brands

Terms such as `Ultimate Sweet Edition`, `Hidden Potion`, `Dessert Bar`, `Fruitfull Bar`, `Iconic`, `King Bar`, etc. may be useful for product-line comparison, but they must not replace manufacturer/commercial brand fields unless the page explicitly presents them as a brand/sub-brand.

Store them in `productLine` or `lineCandidates` only when there is clear evidence, not as the sole `brand`.

### Scraped vs derived values

Every value must be either scraped from the page or explicitly marked as derived.

Do not write derived/matched values into normal variant fields as if they were scraped from the distributor. If a later matcher derives a richer alias, store it in a derived field such as:

```ts
derived?: {
  matchedReferenceColor?: string
  matchedBrandAlias?: string
}
```

This matters because Vaperalia often exposes simplified color labels in public HTML (`Black`, `Silver`) while Eciglogistica exposes richer commercial colors (`GRAPHITE BLACK`, `TITANIUM SILVER`). If Vaperalia HTML does not contain `GRAPHITE BLACK`, the scraper must not claim it scraped that value.

---

## Entry point: `src/index.ts`

### CLI options

| Flag | Default | Description |
|------|---------|-------------|
| `--connector` | `all` | `vaperalia` \| `eciglogistica` \| `all` |
| `--limit <n>` | `0` (unlimited) | Stop after N unique base products |
| `--debug` | `false` | Dump first 2 category pages to `debug/` |
| `--concurrency <n>` | `5` | Phase 2 parallel HTTP workers |
| `--categories <ids>` | (all) | Comma-separated category IDs, optionally prefixed with `vaperalia:` or `eciglogistica:` |

### Startup logic

1. Builds `connectors[]` based on `--connector` flag.
2. If not a full refresh, calls `loadPreservedProducts()` — reads `output/output.json` and keeps rows from distributors NOT being re-crawled. This avoids re-crawling Vaperalia when only re-crawling Eciglogistica.
3. Launches a single Playwright browser (Chromium, headless). Each connector gets its own `BrowserContext`.
4. Calls `crawl()` for each connector. Within each crawl, calls `onSave()` callback periodically → runs matching + export while crawl is still running.
5. After all connectors finish: final `matchProducts()` + `exportResults()`.

### Preserved products caveat

Preserved products come from the existing JSON and may **not** have `brandCandidates` if they were scraped before that field was added. The matcher falls back to `normalizedBrand` for those rows.

---

## Connector interface: `src/connectors/connector.ts`

```ts
interface Connector {
  name: string;
  baseUrl: string;
  enrichInline?: boolean;            // true = Phase 2 runs inside Phase 1 (Playwright)
  getCategorySeeds(ids?: string[]): Promise<CategorySeed[]>;
  listProductsFromCategory(page: Page, url: string): Promise<CategoryResult>;
  enrichProductFromHtml($: CheerioAPI, url: string): EnrichmentResult | Promise<EnrichmentResult>;
}
```

`enrichInline: true` means the connector uses Playwright (same browser session/cookies) to load product detail pages during Phase 1. Required for sites with Cloudflare or cookie-based anti-bot (Eciglogistica).

`enrichInline: false` (default) means Phase 2 fetches product pages via plain HTTP + Cheerio. Used by Vaperalia.

---

## Phase 1: Category listing (`src/crawler.ts` → `crawl()`)

### Flow

```
for each seed URL:
  while has next page:
    navigateWithRetry(listingPage, url)         # Playwright
    connector.listProductsFromCategory(page)     # Returns [{name, url}] + nextPageUrl
    
    for each product URL:
      canonicalizeUrl() → dedup by canonical URL
      push to products[]
      
      if enrichInline:
        navigateWithRetry(detailPage, productUrl)
        load(html) → Cheerio
        connector.enrichProductFromHtml($, url)  # Returns EnrichmentResult
        apply brand, brandCandidates, reference, category, price, description to product
        expandVariants(product, rawVariants)      # Cartesian product → multiple rows
        push expanded rows to inlineProducts[]
```

### Key constants (`src/crawler.ts` top)

```ts
DELAY_MS = 1000          // ms between page navigations
PHASE2_DELAY_MS = 300    // ms between Phase 2 HTTP requests per worker
MAX_RETRIES = 3          // navigation retries before giving up
MAX_PAGES_PER_CATEGORY = 100
SAVE_INTERVAL = 200      // products enriched between intermediate saves
LOG_INTERVAL = 50
```

### `expandVariants()` (`src/crawler.ts:314`)

Takes a base `Product` and a `rawVariants: Record<string, string[]>` (e.g., `{Color: ["Black","White"], "Nic Level": ["3mg","6mg"]}`).

Generates cartesian product → one `Product` row per combination. Each row:
- `name` = `"${baseName} - ${value1} / ${value2}"`
- `url` = appended with `#/${urlSegment1}/{urlSegment2}` if `variantUrlSegments` provided
- `variants` = `{Color: "Black", "Nic Level": "3mg"}` + optional `Reference Color` fields

If no variants: returns single row with `variants: {}`.

### `navigateWithRetry()` (`src/crawler.ts:384`)

Playwright `page.goto(url, {waitUntil: "domcontentloaded", timeout: 30000})`. Retries up to `MAX_RETRIES` with 2s backoff.

### `fetchHtmlWithRetry()` (`src/crawler.ts:419`)

Plain `fetch()` for Phase 2. 15s timeout via `AbortController`. Handles 429/403 with exponential backoff (5s × attempt). Returns `null` on failure.

---

## Phase 2: Product enrichment (standard mode only)

Only runs when `enrichInline !== true`. Vaperalia uses this path.

Runs `concurrency` parallel async workers. Each worker:
1. Pops a product URL from the queue.
2. `fetchHtmlWithRetry(url)` → raw HTML string.
3. `load(html)` (Cheerio).
4. `connector.enrichProductFromHtml($, url)` → `EnrichmentResult`.
5. Applies fields to product, calls `expandVariants()`.

---

## Connector: Vaperalia (`src/connectors/vaperalia.ts`)

### `getCategorySeeds()`

Returns hardcoded list of category URLs from Vaperalia. Categories include kits, atomizadores, pod-system, desechables, liquidos, aromas/alquimia, resistencias, pilas, accesorios, pouches.

### `listProductsFromCategory(page)`

Playwright. Extracts product cards from the listing page. Returns `{name, url}[]` + `nextPageUrl` (pagination link).

**Important:** Product names on listing pages are **truncated**. The full name only appears on the product detail page `<h1>`. The crawler sets `product.name = enrichment.fullName` in Phase 2 **before** calling `expandVariants()`.

### `enrichProductFromHtml($, url)` — Vaperalia

```
Input: Cheerio-loaded detail page HTML

1. fullName   ← $("h1").first().text()
2. reference  ← /productReference\s*=\s*'([^']+)'/ from <script> tags
3. brand      ← fullName.split(" - ").last()   (Vaperalia format: "ProductName - Brand")
4. brandCandidates ← [brand]
5. variants   ← PrestaShop fieldsets (fieldset.attribute_fieldset, etc.)
               → variantUrlSegments (for URL fragment building)
               → variantReferenceValues (for "Reference Color" fields)
6. priceTaxExcluded ← not extracted (Vaperalia doesn't expose it in a stable location)
7. description ← #product-description-short or similar
```

**Brand extraction quirk:** Vaperalia puts brand as the last segment after ` - ` in the product title. E.g., `"Xros 5 Mini Pod Kit - Vaporesso"` → brand = `"Vaporesso"`. This can break if the product name itself contains ` - `.

### Variants — Vaperalia

PrestaShop-style fieldsets. Each fieldset = one dimension (Color, Nic Level, etc.). Values come from `<li>` items or `<select>` options. `variantUrlSegments` maps each variant value to its URL hash fragment for deep-linking.

### Vaperalia extraction refinements from live HTML

Observed product pages expose useful data in three places:

1. `<h1>` for full product title.
2. Visible breadcrumb for category and parent brand/sub-brand.
3. PrestaShop JavaScript variables and attribute fieldsets:

```html
<fieldset class="attribute_fieldset">
  <label class="attribute_label">Color</label>
  <a id="color_437" name="Black" class="color_pick" title="Black"></a>
</fieldset>
<script>
var attributesCombinations = [
  {"id_attribute":"437","id_attribute_group":"2","attribute":"black","group":"color"}
];
var productReference = 'K-XROS.4.NANO';
</script>
```

Required extraction behavior:

- `reference`: extract from `var productReference = '...'`.
- `priceTaxExcluded`: extract from `var productPriceTaxExcluded = ...` when present.
- `breadcrumbPath`: extract the visible product breadcrumb, excluding Home and duplicate current product text.
- `brand`: keep the suffix after the final ` - ` in `<h1>` as primary Vaperalia brand.
- `brandCandidates`: include `brand` plus useful brand-like breadcrumb nodes. If `<h1>` is `Aroma Green Oasis 30ml - A&L Hidden Potion` and breadcrumb contains `A&L`, store `["A&L Hidden Potion", "A&L"]`.
- `commercialBrand`: store the visible sub-brand/commercial brand when different from the manufacturer/parent brand.
- `productLine`: optional derived field. Vaperalia does not consistently expose a dedicated product-line field in product detail HTML; infer only when title/breadcrumb clearly contains a known collection/line. Leave empty when uncertain.
- `description`: prefer the real product description block; if it is absent from the normal tab, fallback to hidden `#new_comment_form .product_desc`; then fallback to meta description.
- Variants:
  - Display values come from DOM text/title/name: color swatches use `name` or `title`; radio options use sibling `<span>`.
  - URL fragments come from `attributesCombinations`: `#/{id_attribute}-{group}-{attribute}`.
  - Keep both display value and slug value when they differ.

Important limitation:

- Vaperalia public HTML often exposes simplified color labels only. Example: Xros 4 Nano exposes `Black`/`Silver` in DOM and `black`/`silver` in `attributesCombinations`; it does not expose `GRAPHITE BLACK`/`TITANIUM SILVER` in the fetched HTML.
- Therefore, do not scrape or output `Reference Color: GRAPHITE BLACK` as if it came from Vaperalia unless that exact text exists in the page. If a later matching stage maps `Black` to Eciglogistica `GRAPHITE BLACK`, store that under a derived field, not in raw `variants`.

Normalize these common groups, preserving the original label too:

- `Color` / `color`
- `Ohmios` / `ohmios`
- `Capacidad` / `capacidad_del_tanque`
- `Tamaño` / `capacidad_bote`

---

## Connector: Eciglogistica (`src/connectors/eciglogistica.ts`)

### `getCategorySeeds()`

Returns 14 hardcoded category URLs:
- nicotine-salts, accesorios, alquimia, atomizadores, baterias-y-cargadores, cbd, coils, desechable, diy, liquidos, mods-y-kits, ngp, pod-systems, prefilled-pod

### `listProductsFromCategory(page)`

Playwright. Scrapes product name + URL from category listing. Handles pagination via `→` link (`a[href*='/pagina/']` with next page number).

### `enrichProductFromHtml($, url)` — Eciglogistica

`enrichInline: true` — called from Phase 1 with a live Playwright page content (not a fresh HTTP fetch). Same Playwright session avoids Cloudflare blocks.

```
Input: Cheerio-loaded detail page HTML

1. brand      ← "brand" key from gtag analytics <script> JSON
                Regex: /"brand"\s*:\s*"([^"]+)"/
                → last match wins (iterates all <script> tags)

2. brandCandidates ← [brand (from gtag)]
                   + all <a> text inside <p class="grey-texts"> that contains "Marca:"
                   → deduped, brand always first
                   e.g., ["Aromes et liquides", "A&L"]

3. category   ← "category" key from gtag analytics <script> JSON
                → uppercase, e.g., "ALQUIMIA"

4. reference  ← text match /Ref\.?\s*:?\s*(\S+)/i in <p class="grey-texts">
                e.g., "Ref.: 99644031" → reference = "99644031"

5. variants   ← <select class="select-attribute-product">
                Label: from preceding sibling's <p.color-title> or <label>
                Values: from <option data-value="..."> or option text

6. priceTaxExcluded ← "price" key from gtag analytics <script> JSON
                      Regex: /"price"\s*:\s*"([\d.]+)"/

7. description ← $("#description").text()
```

**Multi-brand HTML structure:**
```html
<p class="grey-texts m-0 mt-lg-2 mt-3 mb-3" style="font-size: 14px;">Marca:
  <a href="https://nueva.eciglogistica.com/aromes-et-liquides">Aromes et liquides</a>,
  <a href="https://nueva.eciglogistica.com/al">A&L</a>
</p>
```
The `brandCandidates` extraction reads all `<a>` tags inside that `<p>`.

### Eciglogistica extraction refinements from live HTML

Observed product pages expose identity and variants in these areas:

1. Analytics script inside `#attribute-ajax`, e.g. `"brand": "Aromes et liquides"`, `"category": "ALQUIMIA"`, `"price": "7.6835"`.
2. Visible product block inside `#attribute-ajax`:

```html
<p class="grey-texts">Ref.: 99644031</p>
<h1 class="product-title">A&L Ultimate Sweet Edition Oni Aroma 30ml</h1>
<p class="grey-texts">Marca:
  <a href="/aromes-et-liquides">Aromes et liquides</a>,
  <a href="/a-amp-l">A&L</a>
</p>
```

3. Visible detail breadcrumb:

```html
Inicio > ALQUIMIA > AROMAS > Aromes et liquides > A&L > A&L Ultimate Sweet Edition Oni Aroma 30ml
```

4. Variant selects:

```html
<p class="color-title">COLOR:</p>
<select class="select-attribute-product">
  <option data-id="Color" data-value="GRAPHITE BLACK" data-stock="505">GRAPHITE BLACK</option>
</select>
```

Required extraction behavior:

- `reference`: extract from the visible `Ref.:` line. Fallback: `twitter:data2`/meta reference, stripping leading category letters such as `C` only if the remaining value matches the numeric reference.
- `brand`: keep the analytics/script brand or first visible brand as primary.
- `brandCandidates`: merge, dedupe, and preserve order from:
  - analytics `brand`;
  - all anchors in the visible `Marca:` line;
  - brand-like breadcrumb nodes after category nodes and before the current product.
- `commercialBrand`: if a second visible brand/sub-brand appears (`A&L` under `Aromes et liquides`), store it separately and also include it in `brandCandidates`.
- `productLine`: optional derived field. Detect collection terms from title/breadcrumb only when evidence is clear, but never use them as sole brand. Example: `Ultimate Sweet Edition` may be a line signal, not the manufacturer brand.
- `breadcrumbPath`: persist the cleaned breadcrumb path.
- `category`: prefer analytics category, but also persist full breadcrumb categories because detail pages can be more precise than the seed category.
- `description`: extract `#description` text and preserve feature lines such as `Formato`, `Capacidad de bote`, `Sabor`, `Nicotina`, `Resistencias`, `Compatible con`, `Pack`.
- `metaDescription`: store meta description as weak fallback text; do not use it to override visible description.
- Variants:
  - Label comes from nearest `.color-title`/label/preceeding text, normalized to keys such as `Color`, `MG`, `Ohm`, `Capacidad`.
  - Value must come from `option[data-value]` when present; fallback to option text.
  - Keep `data-stock` as stock metadata if present.
  - Do not invent URL hashes for Eciglogistica variants. The canonical product URL remains the base page; variant identity lives in `variants`.

Variant color rule:

- Eciglogistica often exposes the full commercial color in option `data-value`/text (`GRAPHITE BLACK`, `TITANIUM SILVER`, `WUKONG`). This is the authoritative Ecig variant color and should be preserved exactly.
- Do not reduce it to URL/simple color tokens.

### Synthetic reference (`src/sku-builder.ts`)

After enrichment, if `category` and `brand` are available and category is a hardware category, `buildSyntheticReference(name, brand, category)` creates a structured reference like `K-XROS.5.MINI` that can be matched against Vaperalia's `productReference`.

Hardware categories (from `HARDWARE_CATEGORIES` set): MODS Y KITS, POD SYSTEMS, COILS, ACCESORIOS, ATOMIZADORES, DESECHABLE, PREFILLED POD, BATERIAS Y CARGADORES, NGP, DIY.

Prefix letters: `K`=kits, `R`=coils, `D`=disposables, `C`=atomizers, `B`=batteries, `A`=accessories, `W`=DIY.

---

## Data types: `src/types.ts`

### `Product`
```ts
{
  distributor: string          // "Vaperalia" | "Eciglogistica"
  name: string                 // Full name including variant suffix
  url: string                  // Canonical product URL (with variant hash if applicable)
  variants?: Record<string,string>   // e.g., {Color: "Black", "Nic Level": "3mg"}
  sku?: string                 // Assigned by matcher: "K-XROS.5.MINI-BLACK"
  brand?: string               // Primary brand (from gtag or name suffix)
  brandCandidates?: string[]   // All brand aliases found on page
  reference?: string           // Vaperalia productReference or Ecig Ref.
  syntheticReference?: string  // Ecig-only: constructed reference body for matching
  categoryId?: string          // Seed category ID (URL slug)
  category?: string            // Display name of category
  categoryUrl?: string         // URL of the category listing page
  priceTaxExcluded?: number    // Price before tax
  description?: string         // Product description text
  metaDescription?: string     // Meta description, weak fallback only
  commercialBrand?: string     // Visible sub-brand/commercial brand
  productLine?: string         // Collection/line, not a brand by itself
  breadcrumbPath?: string[]    // Cleaned detail breadcrumb path
  derived?: {
    matchedReferenceColor?: string
    matchedBrandAlias?: string
  }
}
```

### `EnrichmentResult`
```ts
{
  variants: Record<string, string[]>                    // dimension → values
  variantUrlSegments?: Record<string, Record<string, string>>  // dim → value → URL segment
  variantReferenceValues?: Record<string, Record<string, string>>
  fullName?: string
  brand?: string
  brandCandidates?: string[]
  reference?: string
  category?: string
  priceTaxExcluded?: number
  description?: string
  metaDescription?: string
  commercialBrand?: string
  productLine?: string
  breadcrumbPath?: string[]
}
```

---

## Phase 3: Matching (`src/matcher.ts`)

### Purpose

Assigns shared `sku` values to the same physical product sold by both distributors. Enables price comparison and stock checking in VapeItReorder.

### `matchProducts(allProducts: Product[]): MatchResult`

#### Step 1: Deduplicate by URL → Profiles

One `Profile` per unique URL (base product, not variant rows). Profiles are the matching unit.

```ts
interface Profile {
  url, baseName, normalizedName, tokens, tfidf
  brand?, normalizedBrand?
  brandCandidates?, normalizedBrandCandidates?
  reference?, syntheticReference?
  distributor
}
```

`baseName` = product name with variant suffix stripped (e.g., strips `" - Black / 3mg"`).

#### Step 2: Name normalization (`normalizeNameForMatching()`, line 26)

Applied to `baseName` before TF-IDF. Removes:
- Spec units: `ml`, `mah`, `w`, `puffs`, `mg`, `ohm`, `pcs`, `pack N`
- All entries in `brandCandidates[]` (strips all aliases, not just primary brand)
- Generic product-type words: `kit`, `pod`, `mod`, `coil`, `resistencias`, etc.
- Spanish noise words: `para`, `con`, `de`, `del`, etc.
- Punctuation → spaces

#### Step 3: Brand normalization (`normalizeBrand()`, line 15)

Removes liquid-type suffixes: `e-liquids`, `nic salts`, `salts`, `vapes`, `labs`, `liquids`, `flavours`. Lowercases + trims.

#### Step 4: TF-IDF (`computeIdf()`, `computeTfidf()`, lines 96–127)

Standard TF-IDF over all profiles (both distributors combined). Used for cosine similarity. Single-char tokens preserved — model numbers like `"5"` in `"Xros 5 Mini"` are load-bearing.

#### Step 5: Body-match pre-pass (lines 287–329)

For hardware products only. Matches Vaperalia's `productReference` body against Eciglogistica's `syntheticReference` body.

```
vapBodyIndex: Map<body → vapProfile index>
for each ecig profile with syntheticReference:
  body = extractReferenceBody(syntheticReference)  // e.g., "XROS.5.MINI"
  if vapBodyIndex.has(body):
    verify brand intersection (see brand matching below)
    → body match, score = 1.0
```

Brand verification in pre-pass uses **candidate intersection**: `vCands.some(v => eCands.some(e => match(v,e)))`. A match is: exact equality OR substring containment (length > 2).

Body-matched products are excluded from the TF-IDF pass.

#### Step 6: Brand-based blocking (lines 344–387)

`ecigByBrand`: Map from **normalized brand candidate** → list of ecig profile indices.
- Indexes ALL `normalizedBrandCandidates` (not just primary brand). If "A&L" and "Aromes et liquides" are both candidates, both appear as keys pointing to the same ecig products.

For each Vaperalia profile, `findBrandCandidates()` (line 205):
- Iterates all of Vaperalia's `normalizedBrandCandidates` (falls back to `normalizedBrand` if no candidates set).
- For each candidate: exact lookup in `ecigByBrand` + substring containment scan.
- Returns `Set<number>` of ecig candidate indices, or `null` if no brand overlap.

If `null` → product is skipped entirely (no TF-IDF comparison attempted). This prevents cross-brand false matches and is the main source of "skipped (no brand match)" in logs.

#### Step 7: TF-IDF cosine similarity (lines 358–405)

For each Vaperalia profile with brand candidates:
- Compare against all ecig profiles in the brand-blocked candidate set.
- `cosineSimilarity(vp.tfidf, ep.tfidf)` → score 0–1.
- Track best score + index.
- If `score >= MATCH_THRESHOLD (0.45)` → raw match.

#### Step 8: Greedy 1:1 assignment (lines 411–427)

Raw matches sorted by score descending. Assign greedily — each profile can appear in at most one final match pair.

#### Step 9: Variant-level matching and SKU assignment (lines 436–541)

For each matched base pair (vap URL ↔ ecig URL):
1. `baseSku = vap.reference || generateSku(vap.brand, vap.normalizedName)`
2. Collect all product rows for each URL (the variant rows from `expandVariants`).
3. Compute `getVariantSignature()` per row: joins variant values (sorted by key), strips spec units.
4. `variantSimilarity()`: max of Jaccard and containment score × 0.85.
5. Greedy 1:1 variant assignment at threshold `VARIANT_MATCH_THRESHOLD (0.6)`.
6. Matched pairs → shared `sku = "${baseSku}-${slugifiedVariant}"`.
7. Unmatched rows → own SKU with same base.

For unmatched base products (only one distributor):
- `baseSku = p.reference || generateSku(p.brand, p.normalizedName)`
- Each variant row gets `sku = "${baseSku}-${suffix}"`.

#### Step 10: Brand propagation (lines 553–568)

After matching, propagates `brand` and `brandCandidates` to all variant rows (they only exist on the first row per URL from `expandVariants`).

#### SKU format

```
BASE-VARIANT
K-XROS.5.MINI-BLACK
│ └─────────────┘│└───┘
│   body         │ variant slug
└─ prefix        └─ hyphen separator
```

Base comes from Vaperalia `productReference` if available (e.g., `K-XROS.5.MINI`), otherwise `generateSku()` which uses `brand-sha256hash[:8]`.

---

## URL utilities: `src/url-utils.ts`

`canonicalizeUrl(raw)` — strips tracking params (`utm_*`, `fbclid`, etc.), normalizes trailing slashes. Applied before URL deduplication in Phase 1.

---

## Export: `src/exporter.ts`

`exportResults(products, outputDir)`:
1. Writes `output/output.json` — full array, pretty-printed.
2. Writes `output/output.csv` — flat CSV via `csv-stringify`.
3. Calls `exportCategoryResults()` → per-category files in `output/categories/` named `{distributor}__{categorySlug}.json/.csv`.

### CSV columns (in order)

`sku`, `brand`, `brandCandidates` (pipe-separated), `distributor`, `categoryId`, `category`, `categoryUrl`, `name`, `description`, `url`, `variants` (JSON string), `reference`, `priceTaxExcluded`

---

## Dashboard / Server: `src/server.ts`

HTTP server on port 8082. Serves static files from `output/`. API endpoints:
- `GET /api/scrape` — triggers a crawl (calls the same pipeline as `npm start`)
- `GET /api/status` — crawl progress
- `GET /api/stop` — abort current crawl

`output/index.html` — dashboard that reads `output.json` via fetch, renders product table with filtering.

---

## Tuning knobs (where to change thresholds)

| What to change | Where | Current value |
|---|---|---|
| Base match threshold | `matcher.ts:230` `MATCH_THRESHOLD` | `0.45` |
| Variant match threshold | `matcher.ts:231` `VARIANT_MATCH_THRESHOLD` | `0.6` |
| Brand substring min length | `matcher.ts:findBrandCandidates()` inline | `> 2` chars |
| Delay between page navigations | `crawler.ts:20` `DELAY_MS` | `1000ms` |
| Delay between Phase 2 requests | `crawler.ts:21` `PHASE2_DELAY_MS` | `300ms` |
| Phase 2 concurrency | CLI `--concurrency` or `crawler.ts:212` min/max clamp | `5` |
| Max pages per category | `crawler.ts:23` `MAX_PAGES_PER_CATEGORY` | `100` |
| Intermediate save interval | `crawler.ts:24` `SAVE_INTERVAL` | `200` |

---

## Adding a new distributor

1. Create `src/connectors/<name>.ts` implementing `Connector`.
2. Register in `src/index.ts` (add to `connectors[]` check).
3. Set `enrichInline: true` if site blocks plain HTTP (Cloudflare, etc.).
4. Implement:
   - `getCategorySeeds()` → hardcoded or scraped category URLs
   - `listProductsFromCategory()` → product name+URL list + next page URL
   - `enrichProductFromHtml()` → variants, brand, brandCandidates, reference, price, description
5. `brandCandidates` should include all brand aliases visible on page (improves matcher accuracy).
6. For hardware products: ensure `category` from gtag matches one of `HARDWARE_CATEGORIES` entries so `buildSyntheticReference()` fires.

---

## Common failure modes

| Symptom | Likely cause | Where to look |
|---|---|---|
| `skipped (no brand match): N` high | Vaperalia brands not found in ecig `ecigByBrand` map | Check `brandCandidates` on ecig products; check brand normalization |
| Low match count | Threshold too high, or brand blocking filtering too aggressively | Lower `MATCH_THRESHOLD`, inspect profile `normalizedName` values |
| Wrong base SKU | Vaperalia `reference` not extracted, falling back to hash | Check `productReference` JS variable in page source |
| Variant rows missing `brand` | Propagation step in `matcher.ts:553` not running | Only runs after matching; single-connector runs skip it |
| A&L matched as "Aromes et liquides" in Vaperalia, missed | Old preserved products lack `brandCandidates` | Re-crawl Vaperalia to pick up new field |
| `expandVariants` returns 1 row per product | No variants found in HTML | Check `<select class="select-attribute-product">` selector for ecig; check fieldsets for vaperalia |
| Navigation loop warning | Pagination URL doesn't change | `findNextPage()` returning same URL; check `→` link logic in connector |
 
---

## Scraper QA checklist for matching-critical fields

Run this spot-check after connector changes and before producing a full catalog file.

1. For at least 10 random Eciglogistica pages and 10 random Vaperalia pages, persist a compact debug JSON with:
   - URL
   - `fullName`
   - `brand`
   - `brandCandidates`
   - `commercialBrand`
   - `productLine` if present/derived with clear evidence
   - `breadcrumbPath`
   - `reference`
   - `variants`
   - `variantUrlSegments`
   - `description` length and first 300 chars
2. Assert that every product with a visible `Marca:` line on Eciglogistica has all linked brand names inside `brandCandidates`.
3. Assert that Vaperalia sub-brands retain parent brand candidates when breadcrumb exposes them, e.g. `A&L Hidden Potion` also includes `A&L`.
4. Assert that raw scraped values do not contain derived matcher values unless they are present in HTML.
5. Assert that liquid/aroma descriptions preserve structured terms: `Formato`, `Capacidad de bote`, `Sabor`, `Nicotina`, `VG/PG`.
6. Assert that hardware descriptions preserve structured terms: `Ohm`, `Capacidad`, `mAh`, `W`, `Pack`, `Compatible con`.
7. Re-crawl both distributors after adding new fields. Do not rely on preserved products from older JSONs unless a migration fills the new fields.

Additional failure modes to watch:

| Symptom | Likely cause | Where to look |
|---|---|---|
| Ecig product has secondary brand on page but output only has parent brand | Scraper only kept analytics `brand` and ignored visible `Marca:` anchors/breadcrumb | Check `brandCandidates`, `commercialBrand`, `breadcrumbPath` on Ecig detail enrichment |
| Product line appears as brand | Title/breadcrumb line terms were promoted to `brand` | Store line terms in `productLine`; keep manufacturer/commercial brands in `brandCandidates` |
| Vaperalia shows `Reference Color` that is not in page HTML | Derived/matched value was written as raw scraped variant | Move to `derived.matchedReferenceColor`; raw Vaperalia `variants.Color` must remain DOM value |
