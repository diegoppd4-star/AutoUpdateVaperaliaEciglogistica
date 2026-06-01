import { Page } from "playwright";
import { CheerioAPI } from "cheerio";
import { Connector, CategoryResult, CategorySeed } from "./connector.js";
import { EnrichmentResult } from "../types.js";

const CATEGORY_SEEDS: CategorySeed[] = [
  {
    id: "saveurs-gourmandes",
    name: "E-liquides Saveurs Gourmandes",
    url: "https://budsvape-distribution.com/18-e-liquides-saveurs-gourmandes",
  },
  {
    id: "saveurs-menthe",
    name: "E-liquides Saveurs Menthe",
    url: "https://budsvape-distribution.com/19-e-liquides-saveurs-menthe",
  },
  {
    id: "saveurs-classic",
    name: "E-liquides Saveurs Classic",
    url: "https://budsvape-distribution.com/20-e-liquides-saveurs-classic",
  },
  {
    id: "saveurs-fruitees",
    name: "E-liquides Saveurs Fruitées",
    url: "https://budsvape-distribution.com/21-e-liquides-saveurs-fruitees",
  },
  {
    id: "knoks",
    name: "KNOKS",
    url: "https://budsvape-distribution.com/308-knoks",
  },
  {
    id: "diy-lab",
    name: "DIY Lab",
    url: "https://budsvape-distribution.com/103-diy-lab",
  },
  {
    id: "packs-implantations",
    name: "Packs Implantations",
    url: "https://budsvape-distribution.com/327-packs-implantations",
  },
  {
    id: "cocorico",
    name: "Cocorico",
    url: "https://budsvape-distribution.com/554-Nos-cocorico",
  },
];

// EAN-13 at the tail of every Budsvape product URL slug, e.g.
//   /bad-ass/1444-bad-ass-pop-demon-50ml-3116103484375.html
//                                       ^^^^^^^^^^^^^
const EAN13_FROM_URL = /-(\d{13})\.html(?:$|[?#])/i;

// Decode HTML entities (Budsvape ships unescaped &#039; etc. into og:title).
function decodeEntities(s: string): string {
  return s
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

export class BudsvapeConnector implements Connector {
  name = "Budsvape";
  baseUrl = "https://budsvape-distribution.com";

  async getCategorySeeds(categoryIds?: string[]): Promise<CategorySeed[]> {
    if (!categoryIds || categoryIds.length === 0) return CATEGORY_SEEDS;
    const selected = new Set(categoryIds.map((id) => id.toLowerCase()));
    const filtered = CATEGORY_SEEDS.filter((s) =>
      selected.has(s.id.toLowerCase())
    );
    if (filtered.length === 0) {
      console.warn(
        `[Budsvape] No selected categories matched: ${categoryIds.join(", ")}`
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

    // Standard PrestaShop product cards
    const cards = await page.$$(".product-miniature.js-product-miniature");

    for (const card of cards) {
      try {
        // Budsvape product cards contain only <a><img alt="Full name"></a>
        // — no h2/h3, no title attribute on the anchor, no text. Pull the
        // first non-quickview link, then read the nested img[alt].
        const links = await card.$$("a[href]:not([href='#']):not([data-link-action='quickview'])");
        const link = links[0] ?? (await card.$("a[href]"));
        if (!link) continue;

        const href = await link.getAttribute("href");
        if (!href || href === "#") continue;
        // Strip PrestaShop variant fragments ("#/1-contenance-10ml/...") so
        // every variant of the same product folds into a single base URL.
        // Variant dimensions are recovered from <select> blocks in
        // enrichProductFromHtml.
        const absolute = new URL(href, this.baseUrl).toString().split("#")[0];
        if (seen.has(absolute)) continue;
        seen.add(absolute);

        // Prefer img alt (always populated for Budsvape product images),
        // then anchor title attribute, then anchor text.
        const img = await link.$("img[alt]");
        const altAttr = img ? (await img.getAttribute("alt"))?.trim() ?? "" : "";
        const titleAttr = (await link.getAttribute("title"))?.trim() ?? "";
        const text = (await link.textContent())?.trim() ?? "";
        const name = altAttr || titleAttr || text;

        if (name) {
          products.push({ name, url: absolute });
        }
      } catch {
        // Skip individual extraction errors
      }
    }

    // Fallback selector if the main one missed everything
    if (products.length === 0) {
      const fallback = await page.$$(".product_list_item a[href*='.html']");
      for (const link of fallback) {
        try {
          const href = await link.getAttribute("href");
          if (!href) continue;
          const absolute = new URL(href, this.baseUrl).toString();
          if (seen.has(absolute)) continue;
          seen.add(absolute);
          const title = (await link.getAttribute("title"))?.trim() ?? "";
          const text = (await link.textContent())?.trim() ?? "";
          const name = title || text;
          if (name) products.push({ name, url: absolute });
        } catch {
          // skip
        }
      }
    }

    // Pagination via <link rel="next"> emitted in <head> by PrestaShop
    const nextPageUrl = await page
      .$eval('link[rel="next"]', (el) => el.getAttribute("href"))
      .catch(() => null);

    return { products, nextPageUrl };
  }

  async enrichProductFromHtml(
    $: CheerioAPI,
    productUrl: string
  ): Promise<EnrichmentResult> {
    // Full name from H1: typically "Product Name - Brand"
    const h1 = $("h1").first().text().trim();

    // og:title is "Knoks - Bad Ass - Pop Demon 50ml - Grossiste - Fabricant"
    // — strip the "Grossiste - Fabricant" marketing suffix.
    const ogTitleRaw = $('meta[property="og:title"]').attr("content")?.trim();
    const ogTitle = ogTitleRaw
      ? decodeEntities(ogTitleRaw)
          .replace(/\s*-\s*Grossiste\s*-\s*Fabricant\s*$/i, "")
          .trim()
      : undefined;

    const fullName = h1 || ogTitle || undefined;

    // Breadcrumb via schema.org BreadcrumbList microdata
    const breadcrumbPath: string[] = [];
    const seenBreadcrumb = new Set<string>();
    $('nav.breadcrumb_nav [itemprop="itemListElement"]').each((_, el) => {
      const t = $(el).find('[itemprop="name"]').first().text().trim();
      if (!t) return;
      if (t.toLowerCase() === "accueil") return;
      if (seenBreadcrumb.has(t)) return;
      seenBreadcrumb.add(t);
      breadcrumbPath.push(t);
    });

    // Brand-like breadcrumb nodes (drop the last = product title, drop
    // generic category labels).
    const isGenericCategory = (s: string) =>
      /^e-?liquides?(\s|$)/i.test(s) ||
      /^saveurs?(\s|$)/i.test(s) ||
      /^diy(\s|$)/i.test(s) ||
      /^packs?(\s|$)/i.test(s) ||
      /^nouveaux?(\s|$)/i.test(s) ||
      /^bon\s+plan/i.test(s);

    const breadcrumbBrands = breadcrumbPath
      .slice(0, -1)
      .filter((n) => !isGenericCategory(n));

    // Reject pack-size / volume strings as a brand — H1s on Budsvape often
    // end with a packaging suffix (e.g. "Pack d'implantation Xtaz - 50ml
    // (6+2)") instead of the brand. When the trailing token looks like a
    // size/pack spec, walk back through the " - " segments.
    const looksLikeSizeOrPack = (s: string) =>
      /^\d+\s*ml\b/i.test(s) ||
      /^pack\s+(?:de\s+)?\d+/i.test(s) ||
      /^\(\d+\s*\+\s*\d+\)$/.test(s) ||
      /^(?:mini\s+pack|\d+\s*x\s*\d+)$/i.test(s) ||
      /\b\d+\s*ml\s*\(/i.test(s);

    // Brand: last non-size segment of H1 split by " - ", but only trust it
    // if it also appears (case-insensitive) in the breadcrumb. Otherwise
    // fall back to the deepest non-category breadcrumb node, which is the
    // sub-brand on Budsvape.
    let brand: string | undefined;
    if (fullName) {
      const parts = fullName.split(" - ").map((p) => p.trim()).filter(Boolean);
      // Walk from the tail, skipping size/pack tokens.
      for (let i = parts.length - 1; i >= 1; i--) {
        if (!looksLikeSizeOrPack(parts[i])) {
          brand = parts[i];
          break;
        }
      }
    }

    // If the H1-derived brand isn't supported by the breadcrumb, prefer the
    // breadcrumb's deepest brand node (it's structured by KNOKS hierarchy
    // and is more reliable for pack/product-line edge cases).
    const breadcrumbLowerSet = new Set(
      breadcrumbBrands.map((n) => n.toLowerCase())
    );
    if (!brand || !breadcrumbLowerSet.has(brand.toLowerCase())) {
      if (breadcrumbBrands.length > 0) {
        brand = breadcrumbBrands[breadcrumbBrands.length - 1];
      }
    }

    // Brand candidates: H1-derived brand + every brand-like breadcrumb node.
    // Budsvape breadcrumbs include manufacturer (e.g. "KNOKS") AND
    // sub-brand (e.g. "Bad Ass"); keep both for matcher brand-blocking.
    const brandCandidates: string[] = [];
    if (brand) brandCandidates.push(brand);
    for (const node of breadcrumbBrands) {
      if (!brandCandidates.includes(node)) brandCandidates.push(node);
    }

    const commercialBrand = brand;

    // Reference: 13-digit EAN embedded at the tail of the URL slug
    let reference: string | undefined;
    const m = productUrl.match(EAN13_FROM_URL);
    if (m) reference = m[1];

    // Description: PrestaShop short description block (itemprop="description")
    let description: string | undefined;
    const descEl = $(
      "[id^='product-description-short'][itemprop='description'], #product-description-short, .product-description-short, #product-description, [itemprop='description']"
    ).first();
    if (descEl.length) {
      const txt = descEl.text().replace(/\s+/g, " ").trim();
      if (txt) description = txt;
    }

    // og:description as fallback (Budsvape sets it cleanly)
    if (!description) {
      const ogDesc = $('meta[property="og:description"]').attr("content")?.trim();
      if (ogDesc) description = decodeEntities(ogDesc);
    }

    const metaDescription =
      $('meta[name="description"]').attr("content")?.trim() || undefined;

    // Variants: PrestaShop variant pickers on Budsvape ship as
    //   <div class="product-variants-item">
    //     <span class="control-label">Taux de Nicotine</span>
    //     <select id="group_N"><option value="..." title="...">06mg</option>...
    //   </div>
    // attributesCombinations JS is not exposed (B2B login-gated), so we
    // only collect display values per dimension.
    const variants: Record<string, string[]> = {};
    const PLACEHOLDER = /^(s[eé]lectionnez|choisir|--|\.\.\.|--$)/i;
    $(".product-variants-item").each((_, item) => {
      const $item = $(item);
      const label = $item
        .find(".control-label, label")
        .first()
        .text()
        .trim()
        .replace(/:$/, "");
      if (!label) return;

      const options: string[] = [];
      $item.find("select option").each((_, opt) => {
        const val = $(opt).attr("value");
        const text = $(opt).text().trim();
        if (!val || val === "" || val === "0") return;
        if (!text || PLACEHOLDER.test(text)) return;
        if (!options.includes(text)) options.push(text);
      });

      if (options.length > 0) variants[label] = options;
    });

    return {
      variants,
      fullName,
      brand,
      brandCandidates: brandCandidates.length ? brandCandidates : undefined,
      commercialBrand,
      reference,
      breadcrumbPath: breadcrumbPath.length ? breadcrumbPath : undefined,
      description,
      metaDescription,
      // priceTaxExcluded intentionally omitted: Budsvape is a B2B wholesaler
      // that hides prices behind a professional login. The public HTML
      // ships an empty .pro_price_block, so we surface nothing rather than
      // a placeholder zero.
    };
  }
}
