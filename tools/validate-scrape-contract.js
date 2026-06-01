const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2).replace(/-([a-z0-9])/g, (_, letter) => letter.toUpperCase());
    if (value == null || value.startsWith("--")) {
      args[name] = true;
      continue;
    }
    args[name] = value;
    index += 1;
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function itemsFromJson(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.products)) return value.products;
  throw new Error("El JSON de scrapeo debe ser un array o contener items[]/products[].");
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function itemName(item) {
  return item.name || item.title || "";
}

function distributorKey(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("ecig")) return "Eciglogistica";
  if (text.includes("vaperalia")) return "Vaperalia";
  return value || "";
}

function checkItem(item, index) {
  const errors = [];
  const warnings = [];
  const label = `${index + 1}: ${item.url || itemName(item) || "sin identificador"}`;

  if (!hasValue(item.distributor)) errors.push(`${label}: falta distributor.`);
  if (!hasValue(item.url)) errors.push(`${label}: falta url.`);
  if (!hasValue(itemName(item))) errors.push(`${label}: falta name/title.`);
  if (!hasValue(item.reference)) warnings.push(`${label}: falta reference; el pipeline usara fallback por URL/titulo si puede.`);
  if (!hasValue(item.variants) || typeof item.variants !== "object" || Array.isArray(item.variants)) {
    warnings.push(`${label}: falta variants como objeto; el pipeline lo tratara como producto sin variantes si procede.`);
  }

  if (!hasValue(item.brand) && !hasValue(item.brandCandidates) && !hasValue(item.commercialBrand)) {
    warnings.push(`${label}: falta senal de marca: brand, brandCandidates o commercialBrand.`);
  }

  if (!hasValue(item.description)) warnings.push(`${label}: falta description.`);
  if (!hasValue(item.metaDescription)) warnings.push(`${label}: falta metaDescription.`);
  if (!hasValue(item.breadcrumbPath)) warnings.push(`${label}: falta breadcrumbPath.`);
  if (hasValue(item.productLine) && !item.derived && !item.derivedJson) {
    warnings.push(`${label}: productLine existe; recordar que debe tratarse como derivado salvo evidencia HTML directa.`);
  }

  return { errors, warnings };
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.input) throw new Error("Uso: node validate-scrape-contract.js --input scrape.json [--out report.json]");

  const inputPath = path.resolve(args.input);
  const items = itemsFromJson(readJson(inputPath));
  const errors = [];
  const warnings = [];
  const distributors = {};

  items.forEach((item, index) => {
    const key = distributorKey(item.distributor);
    if (key) distributors[key] = (distributors[key] || 0) + 1;
    const result = checkItem(item, index);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  });

  for (const required of ["Eciglogistica", "Vaperalia"]) {
    if (!distributors[required]) errors.push(`No hay productos de ${required} en el JSON.`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    input: inputPath,
    ok: errors.length === 0,
    totalItems: items.length,
    distributors,
    errors,
    warnings,
    contract: {
      required: [
        "distributor",
        "url",
        "name/title"
      ],
      stronglyRecommendedForQuality: [
        "reference",
        "brand/brandCandidates/commercialBrand",
        "variants",
        "description",
        "metaDescription",
        "breadcrumbPath"
      ]
    }
  };

  if (args.out) writeJson(path.resolve(args.out), report);
  console.log(JSON.stringify({
    ok: report.ok,
    totalItems: report.totalItems,
    distributors: report.distributors,
    errors: report.errors.length,
    warnings: report.warnings.length
  }, null, 2));

  if (!report.ok) process.exitCode = 2;
}

main();
