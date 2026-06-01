import { Page } from "playwright";
import { CheerioAPI } from "cheerio";
import { Connector, CategoryResult, CategorySeed } from "./connector.js";
import { EnrichmentResult } from "../types.js";

const VAPERALIA_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CATEGORY_SEEDS: CategorySeed[] = [
  {
    id: "kits-y-mods",
    name: "Kits y Mods",
    url: "https://vaperalia.es/kits-cigarrillos-electronicos-3",
    urls: [
      "https://vaperalia.es/kits-cigarrillos-electronicos-3",
      "https://vaperalia.es/mods-y-baterias-1069",
    ],
  },
  { id: "atomizadores-14", name: "Atomizadores", url: "https://vaperalia.es/atomizadores-14" },
  {
    id: "pod-system-868",
    name: "Pod System",
    url: "https://vaperalia.es/pod-system-868",
    urls: [
      "https://vaperalia.es/pod-system-868",
      "https://vaperalia.es/kits-y-baterias-pod-system-869",
      "https://vaperalia.es/pods-870",
      "https://vaperalia.es/resistencias-para-pods-872",
      "https://vaperalia.es/pods-precargados-1626",
    ],
  },
  { id: "pods-desechables-871", name: "Pods Desechables", url: "https://vaperalia.es/pods-desechables-871" },
  {
    id: "liquidos-4",
    name: "Líquidos",
    url: "https://vaperalia.es/liquidos-4",
    urls: [
      "https://vaperalia.es/liquidos-4",
      "https://vaperalia.es/europa-1036",
      "https://vaperalia.es/america-1037",
      "https://vaperalia.es/sales-de-nicotina-913",
    ],
  },
  {
    id: "bases-aromas-y-alquimia-5",
    name: "Alquimia",
    url: "https://vaperalia.es/bases-aromas-y-alquimia-5",
    urls: [
      "https://vaperalia.es/bases-aromas-y-alquimia-5",
      "https://vaperalia.es/aromas-224",
      "https://vaperalia.es/aromas-longfill-1658",
      "https://vaperalia.es/bases-223",
      "https://vaperalia.es/nicokits-467",
    ],
  },
  {
    id: "resistencias-1059",
    name: "Resistencias",
    url: "https://vaperalia.es/resistencias-1059",
    urls: [
      "https://vaperalia.es/resistencias-1059",
      "https://vaperalia.es/resistencias-comerciales-25",
    ],
  },
  {
    id: "pilas-y-cargadores-1054",
    name: "Pilas y Cargadores",
    url: "https://vaperalia.es/pilas-y-cargadores-1054",
    urls: [
      "https://vaperalia.es/pilas-y-cargadores-1054",
      "https://vaperalia.es/pilas-para-mods-46",
      "https://vaperalia.es/cargadores-34",
    ],
  },
  {
    id: "accesorios-y-repuestos-16",
    name: "Accesorios y Repuestos",
    url: "https://vaperalia.es/accesorios-y-repuestos-16",
    urls: [
      "https://vaperalia.es/accesorios-y-repuestos-16",
      "https://vaperalia.es/depositos-de-pyrex-y-acero-343",
    ],
  },
  { id: "pouches-1769", name: "Pouches", url: "https://vaperalia.es/pouches-1769" },
];

export class VaperaliaConnector implements Connector {
  name = "Vaperalia";
  baseUrl = "https://vaperalia.es";

  async getCategorySeeds(categoryIds?: string[]): Promise<CategorySeed[]> {
    return filterCategorySeeds(CATEGORY_SEEDS, categoryIds);
  }

  async listProductsFromCategory(
    page: Page,
    categoryUrl: string
  ): Promise<CategoryResult> {
    const products: Array<{ name: string; url: string }> = [];

    // PrestaShop product listings: each product is inside an element
    // with class .product-container, containing h5 > a with name and href
    const items = await page.$$(".product-container");

    for (const item of items) {
      try {
        const link = await item.$("h5 a, .product-name a");
        if (!link) {
          // The .product-container itself might be an <a> tag
          const href = await item.getAttribute("href");
          const nameEl = await item.$("h5, .product-name");
          const name = nameEl
            ? (await nameEl.textContent())?.trim() ?? ""
            : "";
          if (href && name) {
            products.push({ name, url: new URL(href, this.baseUrl).toString() });
          }
          continue;
        }

        const href = await link.getAttribute("href");
        const name = (await link.textContent())?.trim() ?? "";
        if (href && name) {
          products.push({ name, url: new URL(href, this.baseUrl).toString() });
        }
      } catch {
        // Skip individual product extraction errors
      }
    }

    // If no .product-container found, try alternative selectors
    if (products.length === 0) {
      const altLinks = await page.$$("ul.product_list li a[href*='.html'], .products-grid a[href*='.html']");
      for (const link of altLinks) {
        try {
          const href = await link.getAttribute("href");
          const nameEl = await link.$("h5, .product-name, span");
          const name = nameEl
            ? (await nameEl.textContent())?.trim() ?? ""
            : (await link.getAttribute("title"))?.trim() ?? "";
          if (href && name && !products.some((p) => p.url === href)) {
            products.push({ name, url: new URL(href, this.baseUrl).toString() });
          }
        } catch {
          // Skip
        }
      }
    }

    // Pagination: look for next page link
    // PrestaShop uses ?page=N; check for a "next" link or higher page number
    const nextPageUrl = await this.findNextPage(page, categoryUrl);

    return { products, nextPageUrl };
  }

  async enrichProductFromHtml(
    $: CheerioAPI,
    productUrl: string
  ): Promise<EnrichmentResult> {
    // --- Extract full product name from <h1> ---
    const fullName = $("h1").first().text().trim() || undefined;
    const attributeSegments = extractAttributeUrlSegments($);

    // --- Extract productReference from inline JS ---
    let reference: string | undefined;
    $("script").each((_, el) => {
      const text = $(el).html() || "";
      const m = text.match(/productReference\s*=\s*'([^']+)'/);
      if (m) reference = m[1];
    });

    // --- Extract brand from full name: "ProductName - Brand" ---
    let brand: string | undefined;
    if (fullName) {
      const parts = fullName.split(" - ");
      if (parts.length >= 2) {
        brand = parts[parts.length - 1].trim();
      }
    }

    // --- Extract breadcrumb path ---
    const breadcrumbPath: string[] = [];
    const seenBreadcrumb = new Set<string>();
    $(".miga-pan a:not(.home), ol.breadcrumb li a, #breadcrumb li a, .breadcrumb li a, nav[aria-label='breadcrumb'] a").each((_, el) => {
      const t = $(el).text().trim();
      if (t && t.toLowerCase() !== "inicio" && !seenBreadcrumb.has(t)) {
        seenBreadcrumb.add(t);
        breadcrumbPath.push(t);
      }
    });

    // --- Extract meta description ---
    const metaDescription = $('meta[name="description"]').attr("content")?.trim() || undefined;

    // --- Extract variants (existing logic) ---
    const variants: Record<string, string[]> = {};
    const variantUrlSegments: Record<string, Record<string, string>> = {};

    // Strategy 1: PrestaShop fieldsets
    const fieldsets = $("fieldset.attribute_fieldset, .product-variants .product-variants-item");
    fieldsets.each((_, fieldset) => {
      const $fieldset = $(fieldset);
      const labelEl = $fieldset.find(".attribute_label, .control-label, label").first();
      const label = labelEl.text().trim().replace(/\s+$/, "").replace(/:$/, "");
      if (!label) return;

      const options: string[] = [];

      // Radio buttons
      $fieldset.find(".attribute_list ul li span").each((_, span) => {
        const text = $(span).text().trim();
        if (!text) return;
        options.push(text);

        const attributeId = $(span)
          .closest("li")
          .find("input[type='radio']")
          .attr("value");
        addVariantUrlSegment(variantUrlSegments, label, text, attributeId, attributeSegments);
      });

      // Fallback: select options
      if (options.length === 0) {
        $fieldset.find("select option").each((_, opt) => {
          const val = $(opt).attr("value");
          const text = $(opt).text().trim();
          if (val && text && val !== "" && val !== "0") {
            options.push(text);
            addVariantUrlSegment(variantUrlSegments, label, text, val, attributeSegments);
          }
        });
      }

      // Fallback: color swatches (a.color_pick[title] or input[type='radio'][title])
      if (options.length === 0) {
        $fieldset.find("a.color_pick[title], input[type='radio'][title]").each((_, swatch) => {
          const title = $(swatch).attr("title")?.trim();
          if (!title) return;
          options.push(title);

          const id = $(swatch).attr("id") ?? "";
          const attributeId = id.match(/(\d+)$/)?.[1] ?? $(swatch).attr("value");
          addVariantUrlSegment(variantUrlSegments, label, title, attributeId, attributeSegments);
        });
      }

      if (options.length > 0) {
        variants[label] = options;
      }
    });

    // Strategy 2: fallback — loose selects
    if (Object.keys(variants).length === 0) {
      $(".product-actions select, #attributes select, .product_attributes select").each((_, select) => {
        const $select = $(select);
        const id = $select.attr("id");
        const name = $select.attr("name");
        let label = "";
        if (id) {
          const labelEl = $(`label[for="${id}"]`);
          label = labelEl.length ? labelEl.text().trim().replace(/:$/, "") : "";
        }
        if (!label) {
          label = name?.replace(/^group\[|\]$/g, "") ?? `option_${id ?? "unknown"}`;
        }

        const options: string[] = [];
        $select.find("option").each((_, opt) => {
          const val = $(opt).attr("value");
          const text = $(opt).text().trim();
          if (val && text && val !== "" && val !== "0") {
            options.push(text);
            addVariantUrlSegment(variantUrlSegments, label, text, val, attributeSegments);
          }
        });

        if (options.length > 0) {
          variants[label] = options;
        }
      });
    }

    const variantReferenceValues = await fetchVariantReferenceValues(
      $,
      productUrl,
      reference,
      variants
    );

    // --- Extract price tax excluded from inline JS ---
    let priceTaxExcluded: number | undefined;
    $("script").each((_, el) => {
      const text = $(el).html() || "";
      const m = text.match(/productPriceTaxExcluded\s*=\s*([\d.]+)/);
      if (m) priceTaxExcluded = parseFloat(m[1]);
    });

    // --- Extract description ---
    let description: string | undefined;
    const descEl = $("[itemprop='description'], #description, .product-description, #product-description").first();
    if (descEl.length) {
      const txt = descEl.text().replace(/\s+/g, " ").trim();
      if (txt) description = txt;
    }

    return {
      variants,
      variantUrlSegments:
        Object.keys(variantUrlSegments).length > 0 ? variantUrlSegments : undefined,
      variantReferenceValues:
        Object.keys(variantReferenceValues).length > 0
          ? variantReferenceValues
          : undefined,
      fullName,
      brand,
      brandCandidates: buildVaperaliaBrandCandidates(brand, breadcrumbPath),
      commercialBrand: brand,
      reference,
      breadcrumbPath: breadcrumbPath.length ? breadcrumbPath : undefined,
      metaDescription,
      priceTaxExcluded,
      description,
    };
  }

  private async findNextPage(
    page: Page,
    currentUrl: string
  ): Promise<string | null> {
    // Look for pagination links — PrestaShop typically uses .pagination or #pagination
    // Try to find a "next" arrow or the next page number link
    const nextLink = await page.$(
      'a.next, a[rel="next"], li.pagination_next a, .pagination a.next'
    );
    if (nextLink) {
      const href = await nextLink.getAttribute("href");
      if (href) return new URL(href, this.baseUrl).toString();
    }

    // Fallback: parse "X - Y de Z" and compute next page
    const paginationText = await page
      .locator(".showing, .product-count, .pagination-summary")
      .first()
      .textContent()
      .catch(() => null);

    if (paginationText) {
      const match = paginationText.match(/(\d+)\s*-\s*(\d+)\s+de\s+(\d+)/i);
      if (match) {
        const end = parseInt(match[2]);
        const total = parseInt(match[3]);
        if (end < total) {
          const url = new URL(currentUrl);
          const currentPage = parseInt(url.searchParams.get("page") ?? "1");
          url.searchParams.set("page", String(currentPage + 1));
          return url.toString();
        }
      }
    }

    return null;
  }
}

function extractAttributeUrlSegments($: CheerioAPI): Map<string, string> {
  const segments = new Map<string, string>();

  $("script").each((_, el) => {
    const text = $(el).html() || "";
    const match = text.match(/attributesCombinations\s*=\s*(\[[\s\S]*?\]);/);
    if (!match) return;

    try {
      const combinations = JSON.parse(match[1]) as Array<{
        id_attribute?: string;
        attribute?: string;
        group?: string;
      }>;

      for (const combination of combinations) {
        if (
          !combination.id_attribute ||
          !combination.group ||
          !combination.attribute
        ) {
          continue;
        }

        segments.set(
          String(combination.id_attribute),
          `${combination.id_attribute}-${combination.group}-${combination.attribute}`
        );
      }
    } catch {
      // Ignore malformed inline JS and keep the base URL.
    }
  });

  return segments;
}

function addVariantUrlSegment(
  target: Record<string, Record<string, string>>,
  label: string,
  value: string,
  attributeId: string | undefined,
  attributeSegments: Map<string, string>
): void {
  if (!attributeId) return;
  const segment = attributeSegments.get(String(attributeId));
  if (!segment) return;
  target[label] ??= {};
  target[label][value] = segment;
}

interface VaperaliaCombination {
  attributes_values?: Record<string, string>;
  reference?: string;
}

async function fetchVariantReferenceValues(
  $: CheerioAPI,
  productUrl: string,
  baseReference: string | undefined,
  variants: Record<string, string[]>
): Promise<Record<string, Record<string, string>>> {
  const colorLabels = Object.keys(variants).filter((label) =>
    /^color$/i.test(label.trim())
  );
  if (colorLabels.length === 0 || !baseReference) return {};

  const productId = extractProductId($, productUrl);
  if (!productId) return {};

  const endpoint = new URL("/index.php", productUrl);
  endpoint.searchParams.set("controller", "product");
  endpoint.searchParams.set("id_product", productId);
  endpoint.searchParams.set("ajax", "1");
  endpoint.searchParams.set("action", "getCombinations");

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(endpoint.toString(), {
      headers: { "User-Agent": VAPERALIA_USER_AGENT },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);
    if (!res.ok) return {};

    const payload: unknown = await res.json();
    const combinations = collectCombinations(payload);
    const byColorValue = new Map<string, string>();

    for (const combination of combinations) {
      if (!combination.reference || !combination.attributes_values) continue;
      const referenceColor = extractReferenceVariantValue(
        combination.reference,
        baseReference
      );
      if (!referenceColor) continue;

      for (const value of Object.values(combination.attributes_values)) {
        byColorValue.set(normalizeVariantLookup(value), referenceColor);
      }
    }

    const result: Record<string, Record<string, string>> = {};
    for (const label of colorLabels) {
      for (const value of variants[label]) {
        const referenceColor = byColorValue.get(normalizeVariantLookup(value));
        if (!referenceColor) continue;
        result[label] ??= {};
        result[label][value] = referenceColor;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function collectCombinations(payload: unknown): VaperaliaCombination[] {
  if (!payload || typeof payload !== "object") return [];

  if (isCombination(payload)) return [payload];

  if (Array.isArray(payload)) {
    return payload.flatMap((item) => collectCombinations(item));
  }

  const obj = payload as Record<string, unknown>;
  if (obj.value && typeof obj.value === "object") {
    return collectCombinations(obj.value);
  }

  return Object.values(obj).flatMap((value) => collectCombinations(value));
}

function isCombination(value: unknown): value is VaperaliaCombination {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.reference === "string" &&
    !!obj.attributes_values &&
    typeof obj.attributes_values === "object"
  );
}

function extractProductId($: CheerioAPI, productUrl: string): string | null {
  const fromUrl = productUrl.match(/-(\d+)\.html(?:[?#].*)?$/)?.[1];
  if (fromUrl) return fromUrl;

  const bodyClass = $("body").attr("class") ?? "";
  const fromBody = bodyClass.match(/\bproduct-(\d+)\b/)?.[1];
  if (fromBody) return fromBody;

  let id: string | null = null;
  $("script").each((_, el) => {
    const text = $(el).html() || "";
    id ??= text.match(/\bid_product\s*=\s*['"]?(\d+)['"]?/)?.[1] ?? null;
  });
  return id;
}

function extractReferenceVariantValue(
  fullReference: string,
  baseReference: string
): string | null {
  const prefix = `${baseReference}-`;
  if (!fullReference.startsWith(prefix)) return null;

  const suffix = fullReference.slice(prefix.length).trim();
  if (!suffix) return null;

  return suffix
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function normalizeVariantLookup(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildVaperaliaBrandCandidates(brand: string | undefined, breadcrumbPath: string[]): string[] {
  const candidates: string[] = brand ? [brand] : [];
  if (!brand) return candidates;
  const brandLower = brand.toLowerCase();
  for (const node of breadcrumbPath) {
    const nodeLower = node.toLowerCase();
    if (
      (brandLower.includes(nodeLower) || nodeLower.includes(brandLower)) &&
      !candidates.includes(node)
    ) {
      candidates.push(node);
    }
  }
  return candidates;
}

function filterCategorySeeds(
  categories: CategorySeed[],
  categoryIds?: string[]
): CategorySeed[] {
  if (!categoryIds || categoryIds.length === 0) return categories;
  const selected = new Set(categoryIds.map((id) => id.toLowerCase()));
  const filtered = categories.filter((category) =>
    selected.has(category.id.toLowerCase())
  );
  if (filtered.length === 0) {
    console.warn(
      `[Vaperalia] No selected categories matched: ${categoryIds.join(", ")}`
    );
  }
  return filtered;
}
