import { Page } from "playwright";
import { CheerioAPI } from "cheerio";
import { Connector, CategoryResult, CategorySeed, CardExtractionError } from "./connector.js";
import { EnrichmentResult } from "../types.js";
import { buildSyntheticReference } from "../sku-builder.js";

const CATEGORY_SEEDS: CategorySeed[] = [
  { id: "nicotine-salts", name: "Nicotine salts", url: "https://nueva.eciglogistica.com/nicotine-salts" },
  { id: "accesorios", name: "Accesorios", url: "https://nueva.eciglogistica.com/accesorios" },
  { id: "alquimia", name: "Alquimia", url: "https://nueva.eciglogistica.com/alquimia" },
  { id: "atomizadores", name: "Atomizadores", url: "https://nueva.eciglogistica.com/atomizadores" },
  { id: "baterias-y-cargadores", name: "Baterias y cargadores", url: "https://nueva.eciglogistica.com/baterias-y-cargadores" },
  { id: "cbd", name: "CBD", url: "https://nueva.eciglogistica.com/cbd" },
  { id: "coils", name: "Coils", url: "https://nueva.eciglogistica.com/coils" },
  { id: "desechable", name: "Desechable", url: "https://nueva.eciglogistica.com/desechable" },
  { id: "diy", name: "DIY", url: "https://nueva.eciglogistica.com/diy" },
  { id: "liquidos", name: "Liquidos", url: "https://nueva.eciglogistica.com/liquidos" },
  { id: "mods-y-kits", name: "Mods y kits", url: "https://nueva.eciglogistica.com/mods-y-kits" },
  { id: "ngp", name: "NGP", url: "https://nueva.eciglogistica.com/ngp" },
  { id: "pod-systems", name: "Pod systems", url: "https://nueva.eciglogistica.com/pod-systems" },
  { id: "prefilled-pod", name: "Prefilled pod", url: "https://nueva.eciglogistica.com/prefilled-pod" },
];

export class EciglogisticaConnector implements Connector {
  name = "Eciglogistica";
  baseUrl = "https://nueva.eciglogistica.com";
  enrichInline = false;
  phase2FetchMode = "http" as const;
  delayMs = 600;
  failOnListingFailures = true;
  linkedPaginationNotFoundEndsCategory = true;
  failOnEnrichErrors = true;
  phase2Concurrency = 1;

  async getCategorySeeds(categoryIds?: string[]): Promise<CategorySeed[]> {
    if (!categoryIds || categoryIds.length === 0) return CATEGORY_SEEDS;
    const selected = new Set(categoryIds.map((id) => id.toLowerCase()));
    const filtered = CATEGORY_SEEDS.filter((category) =>
      selected.has(category.id.toLowerCase())
    );
    if (filtered.length === 0) {
      console.warn(
        `[Eciglogistica] No selected categories matched: ${categoryIds.join(", ")}`
      );
    }
    return filtered;
  }

  async listProductsFromCategory(
    page: Page,
    categoryUrl: string
  ): Promise<CategoryResult> {
    const products: Array<{ name: string; url: string }> = [];
    const cardExtractionErrors: CardExtractionError[] = [];

    // Product structure: div.product.card-product > form > a.product-header[href] + div.product-body h5
    const cards = await page.$$(".product.card-product");

    for (const [cardIndex, card] of cards.entries()) {
      try {
        const link = await card.$("a.product-header");
        const nameEl = await card.$(".product-body h5");
        if (!link || !nameEl) {
          cardExtractionErrors.push({
            cardIndex,
            reason: !link ? "missing_product_link" : "missing_product_name",
            snippet: shortSnippet(await card.textContent()),
          });
          continue;
        }

        const href = await link.getAttribute("href");
        const name = (await nameEl.textContent())?.trim() ?? "";
        if (href && name) {
          products.push({ name, url: new URL(href, this.baseUrl).toString() });
        } else {
          cardExtractionErrors.push({
            cardIndex,
            reason: !href ? "empty_product_href" : "empty_product_name",
            href: href || undefined,
            name: name || undefined,
            snippet: shortSnippet(await card.textContent()),
          });
        }
      } catch (error) {
        cardExtractionErrors.push({
          cardIndex,
          reason: error instanceof Error ? error.message : String(error),
          snippet: shortSnippet(await card.textContent().catch(() => "")),
        });
      }
    }

    const nextPageUrl = await this.findNextPage(page);
    return { products, nextPageUrl, cardExtractionErrors };
  }

  enrichProductFromHtml(
    $: CheerioAPI,
    _productUrl: string
  ): EnrichmentResult {
    // --- Extract brand and category from gtag analytics script ---
    let brand: string | undefined;
    let category: string | undefined;
    $("script").each((_, el) => {
      const text = $(el).html() || "";
      const bm = text.match(/"brand"\s*:\s*"([^"]+)"/);
      if (bm) brand = bm[1];
      const cm = text.match(/"category"\s*:\s*"([^"]+)"/);
      if (cm) category = cm[1];
    });

    // --- Extract all brand candidates from visible "Marca:" field ---
    const brandCandidates: string[] = brand ? [brand] : [];
    $("p.grey-texts").each((_, el) => {
      if (!$(el).text().includes("Marca:")) return;
      $(el).find("a").each((__, a) => {
        const t = $(a).text().trim();
        if (t && !brandCandidates.includes(t)) brandCandidates.push(t);
      });
    });

    // --- Extract breadcrumb path ---
    const breadcrumbPath: string[] = [];
    $("section.breadcrumb-custom a").each((_, el) => {
      const t = $(el).text().trim();
      if (t && t !== "Inicio") breadcrumbPath.push(t);
    });

    // Enrich brandCandidates with non-category breadcrumb nodes (categories are all-uppercase)
    for (const node of breadcrumbPath) {
      if (node === node.toUpperCase()) continue;
      if (!brandCandidates.includes(node)) brandCandidates.push(node);
    }

    const commercialBrand = brandCandidates.length > 1 ? brandCandidates[1] : undefined;

    // --- Extract meta description ---
    const metaDescription = $('meta[name="description"]').attr("content")?.trim() || undefined;

    // --- Extract reference from visible text ---
    let reference: string | undefined;
    $("p.grey-texts").each((_, el) => {
      const text = $(el).text();
      const m = text.match(/Ref\.?\s*:?\s*(\S+)/i);
      if (m) reference = m[1];
    });

    // --- Extract variants (existing logic) ---
    const variants: Record<string, string[]> = {};
    const placeholders = /^(seleccione|elige|--|\.\.\.|escoge|choose|select)/i;

    // Strategy 1: select.select-attribute-product
    $("select.select-attribute-product").each((_, select) => {
      const $select = $(select);
      let label = "";
      // Primary: label lives in the preceding sibling col (handles multi-select rows
      // where closest("row") would return the shared ancestor and find() the wrong label)
      const labelInSibling = $select.parent().prev()
        .find("p.color-title, .color-title, label").first();
      if (labelInSibling.length) {
        label = labelInSibling.text().trim().replace(/:$/, "");
      } else {
        const $row = $select.closest("div[class*='row']");
        if ($row.length) {
          const labelEl = $row.find("p.color-title, .color-title, label").first();
          label = labelEl.text().trim().replace(/:$/, "");
        }
      }
      // Fallback: use data-id from first option
      if (!label) {
        const firstOpt = $select.find("option[data-id]").first();
        if (firstOpt.length) {
          label = firstOpt.attr("data-id") ?? "";
        }
      }
      if (!label) return;

      const options: string[] = [];
      $select.find("option").each((_, opt) => {
        const dataValue = $(opt).attr("data-value")?.trim();
        const value = dataValue || $(opt).text().trim();
        if (!value || placeholders.test(value)) return;
        options.push(value);
      });

      if (options.length > 0) {
        variants[label] = options;
      }
    });

    // Strategy 2: generic structured groups
    if (Object.keys(variants).length === 0) {
      $(".product-option, .form-group:has(select), .product-attribute").each((_, group) => {
        const $group = $(group);
        const labelEl = $group.find("label, .control-label, .form-label").first();
        const label = labelEl.text().trim().replace(/:$/, "");
        if (!label) return;

        const options: string[] = [];
        $group.find("select option").each((_, opt) => {
          const val = $(opt).attr("value");
          const text = $(opt).text().trim();
          if (!val || val === "" || val === "0") return;
          if (!text || placeholders.test(text)) return;
          options.push(text);
        });

        if (options.length > 0) {
          variants[label] = options;
        }
      });
    }

    // --- Extract price tax excluded from gtag event ---
    let priceTaxExcluded: number | undefined;
    $("script").each((_, el) => {
      const text = $(el).html() || "";
      const m = text.match(/"price"\s*:\s*"([\d.]+)"/);
      if (m) priceTaxExcluded = parseFloat(m[1]);
    });

    // --- Extract description ---
    let description: string | undefined;
    const descEl = $("#description");
    if (descEl.length) {
      const txt = descEl.text().replace(/\s+/g, " ").trim();
      if (txt) description = txt;
    }

    return { variants, brand, brandCandidates, commercialBrand, reference, category, breadcrumbPath: breadcrumbPath.length ? breadcrumbPath : undefined, priceTaxExcluded, description, metaDescription };
  }

  private async findNextPage(page: Page): Promise<string | null> {
    // The "→" arrow is a plain <a> linking to the next page
    const allLinks = await page.$$("a[href*='/pagina/']");

    for (const link of allLinks) {
      const text = (await link.textContent())?.trim();
      if (text === "→") {
        const href = await link.getAttribute("href");
        if (href) {
          // Verify the arrow actually points to a higher page number
          const targetMatch = href.match(/\/pagina\/(\d+)/);
          const currentUrl = page.url();
          const currentMatch = currentUrl.match(/\/pagina\/(\d+)/);
          const currentPage = currentMatch ? parseInt(currentMatch[1]) : 1;
          const targetPage = targetMatch ? parseInt(targetMatch[1]) : 0;

          if (targetPage > currentPage) {
            return new URL(href, this.baseUrl).toString();
          }
        }
      }
    }

    return null;
  }
}

function shortSnippet(value: string | null | undefined): string {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
}
