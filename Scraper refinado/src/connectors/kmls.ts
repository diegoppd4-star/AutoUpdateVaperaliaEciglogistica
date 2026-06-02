import { Page } from "playwright";
import { CheerioAPI } from "cheerio";
import { Connector, CategoryResult, CategorySeed } from "./connector.js";
import { EnrichmentResult } from "../types.js";

const CATEGORY_SEEDS: CategorySeed[] = [
  {
    id: "e-liquide",
    name: "E-liquides",
    url: "https://www.kmls.fr/fr/7-e-liquide",
  },
  {
    id: "cigarettes-electroniques",
    name: "Cigarettes électroniques",
    url: "https://www.kmls.fr/fr/2-cigarettes-electroniques",
  },
  {
    id: "cartouches-pre-remplies",
    name: "Cartouches pré-remplies",
    url: "https://www.kmls.fr/fr/1160-cartouches-pre-remplies",
  },
  {
    id: "diy",
    name: "DIY",
    url: "https://www.kmls.fr/fr/165-diy",
  },
  {
    id: "accessoires",
    name: "Accessoires",
    url: "https://www.kmls.fr/fr/10-accessoires",
  },
  {
    id: "cbd",
    name: "CBD",
    url: "https://www.kmls.fr/fr/998-cbd",
  },
];

// KMLS labels brands inside JSON-LD and breadcrumbs with French category
// prefixes (e.g. "E-liquides French Riviera" instead of "French Riviera").
// Strip these so brand-blocking in the matcher can intersect with brands
// extracted by the other connectors.
const KMLS_BRAND_PREFIXES = [
  /^Grossiste\s+/i,
  /^E-?liquides?\s+/i,
  /^Cigarettes?\s+électroniques?\s+/i,
  /^Cartouches?\s+(?:pré-?remplies?\s+)?/i,
  /^Accessoires?\s+/i,
  /^DIY\s+/i,
  /^CBD\s+/i,
];

function normalizeKmlsBrand(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let out = raw.trim();
  // Apply each prefix once, repeatedly, in case multiple stack
  // (e.g. "Grossiste E-liquides Foo" → "Foo")
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of KMLS_BRAND_PREFIXES) {
      const next = out.replace(re, "").trim();
      if (next !== out) {
        out = next;
        changed = true;
      }
    }
  }
  return out || undefined;
}

export class KmlsConnector implements Connector {
  name = "Kmls";
  baseUrl = "https://www.kmls.fr";

  async getCategorySeeds(categoryIds?: string[]): Promise<CategorySeed[]> {
    if (!categoryIds || categoryIds.length === 0) return CATEGORY_SEEDS;
    const selected = new Set(categoryIds.map((id) => id.toLowerCase()));
    const filtered = CATEGORY_SEEDS.filter((s) =>
      selected.has(s.id.toLowerCase())
    );
    if (filtered.length === 0) {
      console.warn(
        `[Kmls] No selected categories matched: ${categoryIds.join(", ")}`
      );
    }
    return filtered;
  }

  async listProductsFromCategory(
    page: Page,
    _categoryUrl: string
  ): Promise<CategoryResult> {
    const products: Array<{ name: string; url: string }> = [];
    const seen = new Set<string>();

    // KMLS custom PrestaShop theme: products live inside .product-card
    const cards = await page.$$(".product-card");

    for (const card of cards) {
      try {
        const link = await card.$("a[href]");
        if (!link) continue;

        const href = await link.getAttribute("href");
        if (!href) continue;

        const absolute = new URL(href, this.baseUrl).toString();
        if (seen.has(absolute)) continue;
        seen.add(absolute);

        // Prefer .product-card-title text; fall back to anchor title attribute
        const titleEl = await card.$(".product-card-title");
        const titleText = titleEl
          ? (await titleEl.textContent())?.trim() ?? ""
          : "";
        const titleAttr = (await link.getAttribute("title"))?.trim() ?? "";
        const name = titleText || titleAttr;

        if (name) {
          products.push({ name, url: absolute });
        }
      } catch {
        // Skip individual extraction errors
      }
    }

    // Pagination: PrestaShop emits <link rel="next" href="..."> in <head>
    const nextPageUrl = await page
      .$eval('link[rel="next"]', (el) => el.getAttribute("href"))
      .catch(() => null);

    return { products, nextPageUrl };
  }

  async enrichProductFromHtml(
    $: CheerioAPI,
    _productUrl: string
  ): Promise<EnrichmentResult> {
    // Full name from H1 (KMLS uppercases it on the page) or og:title
    const h1Text = $("h1").first().text().trim();
    const ogTitle = $('meta[property="og:title"]').attr("content")?.trim();
    const fullName = h1Text || ogTitle || undefined;

    // Brand, reference (gtin13), description from JSON-LD Product schema
    let brand: string | undefined;
    let reference: string | undefined;
    let descriptionFromJsonLd: string | undefined;
    let nameFromJsonLd: string | undefined;

    $('script[type="application/ld+json"]').each((_, el) => {
      const text = $(el).html() || "";
      try {
        const raw: unknown = JSON.parse(text);
        const items = Array.isArray(raw) ? raw : [raw];
        for (const item of items) {
          if (!item || typeof item !== "object") continue;
          const obj = item as Record<string, unknown>;
          if (obj["@type"] !== "Product") continue;

          if (!brand && obj.brand && typeof obj.brand === "object") {
            const b = obj.brand as Record<string, unknown>;
            if (typeof b.name === "string") {
              brand = normalizeKmlsBrand(b.name);
            }
          }

          if (!reference && typeof obj.gtin13 === "string" && obj.gtin13.trim()) {
            reference = obj.gtin13.trim();
          }

          if (!descriptionFromJsonLd && typeof obj.description === "string") {
            descriptionFromJsonLd = obj.description.trim();
          }

          if (!nameFromJsonLd && typeof obj.name === "string") {
            nameFromJsonLd = obj.name.trim();
          }
        }
      } catch {
        // ignore malformed JSON-LD
      }
    });

    // Prefer JSON-LD name (mixed case) over H1 (uppercased by theme)
    const finalName = nameFromJsonLd || fullName;

    // Breadcrumb via schema.org BreadcrumbList microdata
    const breadcrumbPath: string[] = [];
    $('nav.breadcrumbs-wrapper [itemprop="itemListElement"]').each((_, el) => {
      const t = $(el).find('[itemprop="name"]').first().text().trim();
      if (t && t.toUpperCase() !== "KMLS") breadcrumbPath.push(t);
    });

    // Brand fallback: third breadcrumb level often is brand on this site
    // (e.g. "KMLS > Grossiste E-liquides > Grossiste E-liquides Mexican Cartel")
    if (!brand && breadcrumbPath.length >= 2) {
      brand = normalizeKmlsBrand(breadcrumbPath[breadcrumbPath.length - 1]);
    }

    // Description: prefer real description block, fall back to JSON-LD then meta
    let description: string | undefined;
    const descEl = $(
      ".product-description, #product-description, [itemprop='description']"
    ).first();
    if (descEl.length) {
      const txt = descEl.text().replace(/\s+/g, " ").trim();
      if (txt) description = txt;
    }
    if (!description && descriptionFromJsonLd) {
      description = descriptionFromJsonLd;
    }

    const metaDescription =
      $('meta[name="description"]').attr("content")?.trim() || undefined;

    return {
      variants: {},
      fullName: finalName,
      brand,
      brandCandidates: brand ? [brand] : [],
      commercialBrand: brand,
      reference,
      breadcrumbPath: breadcrumbPath.length ? breadcrumbPath : undefined,
      description,
      metaDescription,
      // priceTaxExcluded intentionally omitted: KMLS is a B2B wholesale site
      // that gates prices behind professional login; JSON-LD reports "price":"0"
      // until authenticated, so we do not surface a misleading price.
    };
  }
}
