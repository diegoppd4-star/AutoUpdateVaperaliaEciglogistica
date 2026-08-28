import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const specs = JSON.parse(fs.readFileSync(path.join(here, "pair-specs.json"), "utf8"));
const rows = JSON.parse(fs.readFileSync(path.join(repo, specs.scrape), "utf8"));

const normalize = (value) => String(value ?? "")
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "");

function selectRow(selector, pairId, side) {
  const candidates = rows.filter((row) => row.url === selector.url);
  const selected = candidates.filter((row) => Object.entries(selector.variants || {}).every(
    ([key, value]) => normalize(row.variants?.[key]) === normalize(value)
  ));
  if (selected.length !== 1) {
    throw new Error(`${pairId}.${side}: expected exactly one scrape row, found ${selected.length} of ${candidates.length}`);
  }
  const row = selected[0];
  return {
    distributor: row.distributor,
    name: row.name,
    url: row.url,
    brand: row.brand,
    commercialBrand: row.commercialBrand,
    reference: row.reference,
    sku: row.sku,
    variants: row.variants,
    category: row.category,
    breadcrumbPath: row.breadcrumbPath,
    description: row.description,
    metaDescription: row.metaDescription
  };
}

const dataset = {
  version: specs.version,
  sourceRun: "20260825-120517-matching-from-complete-scrape",
  reviewedAt: specs.reviewedAt,
  reviewMethod: specs.reviewMethod,
  evaluationUnit: "One exact sellable scrape row per side; a grouped product URL is resolved by the selected variant row.",
  pairs: specs.pairs.map((pair) => ({
    id: pair.id,
    set: pair.set,
    deterministicConfidence: pair.deterministicConfidence || null,
    truth: pair.truth,
    truthBasis: pair.truthBasis,
    a: selectRow(pair.a, pair.id, "a"),
    b: selectRow(pair.b, pair.id, "b")
  }))
};

fs.writeFileSync(path.join(here, "dataset.json"), `${JSON.stringify(dataset, null, 2)}\n`);
console.log(`Wrote ${dataset.pairs.length} pairs to ${path.join(here, "dataset.json")}`);
