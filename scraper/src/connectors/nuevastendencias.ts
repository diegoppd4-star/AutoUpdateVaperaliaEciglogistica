import { Page } from "playwright";
import { CheerioAPI } from "cheerio";
import { Connector, CategorySeed, CategoryResult } from "./connector.js";
import { EnrichmentResult } from "../types.js";

const CATEGORY_SEEDS: CategorySeed[] = [
  {
    id: "pods-desechables",
    name: "Vapers/Pods Desechables",
    url: "https://www.nuevas-tendencias.com/comprar/pods-vapers-cigarrillos-electronicos/pods-vapers-desechables-vapeadores-y-e-cigarrillos/",
  },
  {
    id: "vapers-recargable",
    name: "Vapers Pods Recargables",
    url: "https://www.nuevas-tendencias.com/comprar/pods-vapers-cigarrillos-electronicos/vapers-pods-recargable/",
  },
  {
    id: "capsulas-precargadas",
    name: "Cápsulas Precargadas",
    url: "https://www.nuevas-tendencias.com/comprar/pods-vapers-cigarrillos-electronicos/vapers-pods-capsulas-precargadas-desechables/",
  },
  {
    id: "sales-de-nicotina",
    name: "Sales de Nicotina",
    url: "https://www.nuevas-tendencias.com/comprar/pods-vapers-cigarrillos-electronicos/sales-de-nicotina/",
  },
  {
    id: "aroma-concentrado",
    name: "Aromas Concentrados",
    url: "https://www.nuevas-tendencias.com/comprar/pods-vapers-cigarrillos-electronicos/aroma-concentrado/",
  },
  {
    id: "base-y-nicokit",
    name: "Bases y Nicokits",
    url: "https://www.nuevas-tendencias.com/comprar/pods-vapers-cigarrillos-electronicos/base-y-nicokit/",
  },
  {
    id: "cbd",
    name: "Productos CBD",
    url: "https://www.nuevas-tendencias.com/comprar/productos-cbd-weed-smoker/",
  },
];

export class NuevasTendenciasConnector implements Connector {
  name = "NuevasTendencias";
  baseUrl = "https://www.nuevas-tendencias.com";

  async getCategorySeeds(categoryIds?: string[]): Promise<CategorySeed[]> {
    if (!categoryIds || categoryIds.length === 0) return CATEGORY_SEEDS;
    const selected = new Set(categoryIds.map((id) => id.toLowerCase()));
    const filtered = CATEGORY_SEEDS.filter((s) => selected.has(s.id.toLowerCase()));
    if (filtered.length === 0) {
      console.warn(`[NuevasTendencias] No categories matched: ${categoryIds.join(", ")}`);
    }
    return filtered;
  }

  async listProductsFromCategory(page: Page, _categoryUrl: string): Promise<CategoryResult> {
    const products: Array<{ name: string; url: string }> = [];
    const seen = new Set<string>();

    // WooCommerce + Woodmart: products in div.product-grid-item, link is a.product-image-link
    const links = await page.$$(".product-grid-item a.product-image-link");
    for (const link of links) {
      try {
        const href = await link.getAttribute("href");
        if (!href) continue;
        const canonical = new URL(href, this.baseUrl).toString();
        if (seen.has(canonical)) continue;
        seen.add(canonical);

        const img = await link.$("img");
        const alt = img ? (await img.getAttribute("alt"))?.trim() ?? "" : "";
        // Fall back to URL slug when alt is empty — phase 2 enrichment replaces with real H1
        const name = alt || canonical.replace(/\/$/, "").split("/").pop() || "";
        if (name) {
          products.push({ name, url: canonical });
        }
      } catch {
        // skip
      }
    }

    // Next page: WP/WooCommerce emits <link rel="next" href="..."> in the <head>
    const nextPageUrl = await page
      .$eval('link[rel="next"]', (el) => el.getAttribute("href"))
      .catch(() => null);

    return { products, nextPageUrl };
  }

  async enrichProductFromHtml($: CheerioAPI, _productUrl: string): Promise<EnrichmentResult> {
    // Full name from WooCommerce H1
    const fullName =
      $("h1.product_title, .product_title").first().text().trim() ||
      $("h1").first().text().trim() ||
      $('meta[property="og:title"]').attr("content")?.trim() ||
      $("title").first().text().trim().split(/\s*[|–-]\s*/)[0].trim() ||
      undefined;

    // Brand, SKU, price from schema.org JSON-LD (@graph pattern from Yoast SEO)
    let brand: string | undefined;
    let reference: string | undefined;
    let priceTaxExcluded: number | undefined;

    $('script[type="application/ld+json"]').each((_, el) => {
      const text = $(el).html() || "";
      try {
        const raw: unknown = JSON.parse(text);
        const items = resolveGraphItems(raw);
        for (const item of items) {
          if (!item || typeof item !== "object") continue;
          const obj = item as Record<string, unknown>;
          if (obj["@type"] !== "Product") continue;

          if (!brand && obj.brand && typeof obj.brand === "object") {
            const b = obj.brand as Record<string, unknown>;
            if (typeof b.name === "string") brand = b.name;
          }

          if (!reference && obj.sku != null) {
            const skuVal = String(obj.sku).trim();
            if (skuVal) reference = skuVal;
          }

          if (priceTaxExcluded === undefined && obj.offers) {
            const offerList = Array.isArray(obj.offers) ? obj.offers : [obj.offers];
            for (const offer of offerList) {
              if (!offer || typeof offer !== "object") continue;
              const o = offer as Record<string, unknown>;

              // Simple product: offers[].priceSpecification[].price
              if (Array.isArray(o.priceSpecification)) {
                for (const spec of o.priceSpecification) {
                  if (spec && typeof spec === "object") {
                    const s = spec as Record<string, unknown>;
                    const p = parseFloat(String(s.price ?? ""));
                    if (!isNaN(p) && p > 0) { priceTaxExcluded = p; break; }
                  }
                }
              }

              // Variable product: AggregateOffer uses lowPrice
              if (priceTaxExcluded === undefined && typeof o.lowPrice === "string") {
                const p = parseFloat(o.lowPrice);
                if (!isNaN(p) && p > 0) priceTaxExcluded = p;
              }

              if (priceTaxExcluded !== undefined) break;
            }
          }
        }
      } catch {
        // ignore malformed JSON
      }
    });

    // Fallback: brand from WooCommerce product attributes table
    if (!brand) {
      $(".woocommerce-product-attributes-item").each((_, row) => {
        const label = $(row)
          .find(".woocommerce-product-attributes-item__label")
          .text()
          .trim();
        if (/^marca$/i.test(label)) {
          brand = $(row)
            .find(".woocommerce-product-attributes-item__value")
            .text()
            .trim();
        }
      });
    }

    // Tier 3: " de [Brand]" at end of product name
    if (!brand && fullName) {
      const m = fullName.match(
        / de ([A-ZÁÉÍÓÚÑ][A-Za-záéíóúÁÉÍÓÚñÑ]+(?:[ ][A-ZÁÉÍÓÚÑ][A-Za-záéíóúÁÉÍÓÚñÑ]+)*)$/
      );
      if (m) brand = m[1];
    }

    // Tier 3b: all-caps token at end of name (e.g. "... acrílico ORIO")
    const ALL_CAPS_EXCLUSIONS = new Set([
      "CBD", "HHC", "THC", "CBG", "CBN", "ZEN", "TOP", "PRO", "MAX", "NIC", "VPG",
    ]);
    if (!brand && fullName) {
      const m = fullName.match(/\b([A-Z]{3,})\s*$/);
      if (m && !ALL_CAPS_EXCLUSIONS.has(m[1])) brand = m[1];
    }

    // Breadcrumb from WooCommerce nav
    const breadcrumbPath: string[] = [];
    $("nav.woocommerce-breadcrumb a.breadcrumb-link").each((_, el) => {
      const t = $(el).text().trim();
      if (t && t.toLowerCase() !== "inicio") breadcrumbPath.push(t);
    });

    // Tier 4: third breadcrumb level as brand proxy
    if (!brand && breadcrumbPath.length >= 3) {
      brand = breadcrumbPath[2];
    }

    // Meta description
    const metaDescription =
      $('meta[name="description"]').attr("content")?.trim() || undefined;

    // Description (short description or tab)
    let description: string | undefined;
    const descEl = $(
      ".woocommerce-product-details__short-description, #tab-description, .product-description"
    ).first();
    if (descEl.length) {
      const txt = descEl.text().replace(/\s+/g, " ").trim();
      if (txt) description = txt;
    }

    return {
      variants: {},
      fullName,
      brand: brand ?? "",
      brandCandidates: brand
        ? [brand]
        : reference?.startsWith("IS-")
        ? ["Iguana Smoke"]
        : [],
      commercialBrand: brand ?? "",
      reference,
      priceTaxExcluded,
      breadcrumbPath: breadcrumbPath.length ? breadcrumbPath : undefined,
      metaDescription,
      description,
    };
  }
}

// Handles both bare Product objects and Yoast SEO @graph arrays
function resolveGraphItems(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj["@graph"])) return obj["@graph"] as unknown[];
    return [raw];
  }
  return [];
}
