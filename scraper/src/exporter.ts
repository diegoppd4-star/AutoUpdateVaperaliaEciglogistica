import { mkdirSync, writeFileSync } from "node:fs";
import { stringify } from "csv-stringify/sync";
import { Product } from "./types.js";

export function exportResults(products: Product[], outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });

  // JSON
  const jsonPath = `${outputDir}/output.json`;
  writeFileSync(jsonPath, JSON.stringify(products, null, 2), "utf-8");
  console.log(`Wrote ${jsonPath} (${products.length} products)`);

  // CSV
  const csvPath = `${outputDir}/output.csv`;
  const csvData = stringifyProducts(products);
  writeFileSync(csvPath, csvData, "utf-8");
  console.log(`Wrote ${csvPath} (${products.length} products)`);

  exportDistributorResults(products, outputDir);
  exportCategoryResults(products, outputDir);
}

function exportDistributorResults(products: Product[], outputDir: string): void {
  const groups = new Map<string, Product[]>();
  for (const product of products) {
    const key = slugify(product.distributor || "unknown");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(product);
  }

  for (const [key, groupProducts] of groups) {
    const jsonPath = `${outputDir}/${key}.json`;
    writeFileSync(jsonPath, JSON.stringify(groupProducts, null, 2), "utf-8");

    const csvPath = `${outputDir}/${key}.csv`;
    writeFileSync(csvPath, stringifyProducts(groupProducts), "utf-8");

    console.log(`Wrote ${jsonPath} and ${csvPath} (${groupProducts.length} products)`);
  }
}

function exportCategoryResults(products: Product[], outputDir: string): void {
  const categoryDir = `${outputDir}/categories`;
  mkdirSync(categoryDir, { recursive: true });

  const groups = new Map<string, Product[]>();
  for (const product of products) {
    const groupKey = categoryOutputKey(product);
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey)!.push(product);
  }

  for (const [groupKey, groupProducts] of groups) {
    const jsonPath = `${categoryDir}/${groupKey}.json`;
    writeFileSync(jsonPath, JSON.stringify(groupProducts, null, 2), "utf-8");

    const csvPath = `${categoryDir}/${groupKey}.csv`;
    writeFileSync(csvPath, stringifyProducts(groupProducts), "utf-8");

    console.log(`Wrote ${jsonPath} and ${csvPath} (${groupProducts.length} products)`);
  }
}

function stringifyProducts(products: Product[]): string {
  const csvRows = products.map((p) => ({
    sku: p.sku ?? "",
    brand: p.brand ?? "",
    brandCandidates: (p.brandCandidates ?? []).join("|"),
    commercialBrand: p.commercialBrand ?? "",
    productLine: p.productLine ?? "",
    distributor: p.distributor,
    categoryId: p.categoryId ?? "",
    category: p.category ?? "",
    categoryUrl: p.categoryUrl ?? "",
    name: p.name,
    description: p.description ?? "",
    url: p.url,
    variants: p.variants ? JSON.stringify(p.variants) : "",
    reference: p.reference ?? "",
    priceTaxExcluded:
      p.priceTaxExcluded != null ? p.priceTaxExcluded.toFixed(4) : "",
    breadcrumbPath: (p.breadcrumbPath ?? []).join(" > "),
    metaDescription: p.metaDescription ?? "",
    derivedReferenceColor: p.derived?.matchedReferenceColor ?? "",
  }));

  return stringify(csvRows, {
    header: true,
    columns: [
      "sku",
      "brand",
      "brandCandidates",
      "commercialBrand",
      "productLine",
      "distributor",
      "categoryId",
      "category",
      "categoryUrl",
      "name",
      "description",
      "url",
      "variants",
      "reference",
      "priceTaxExcluded",
      "breadcrumbPath",
      "metaDescription",
      "derivedReferenceColor",
    ],
  });
}

function categoryOutputKey(product: Product): string {
  const distributor = slugify(product.distributor || "unknown-distributor");
  const category = slugify(
    product.categoryId || product.category || "unknown-category"
  );
  return `${distributor}__${category}`;
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}
