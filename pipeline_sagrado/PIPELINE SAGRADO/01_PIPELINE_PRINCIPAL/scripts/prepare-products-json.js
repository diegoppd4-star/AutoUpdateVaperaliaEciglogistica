const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (value == null || value.startsWith("--")) {
      args[name] = true;
      continue;
    }
    args[name] = value;
    i += 1;
  }
  if ((!args.in && !args.inDir) || (!args.baseOut && !args.variantsOut && !args.out)) {
    throw new Error("Uso: node scripts/prepare-products-json.js --in input.json --base-out base.csv --variants-out variants.csv");
  }
  if (args.out && !args.baseOut) args.baseOut = args.out;
  return args;
}

function findJsonFiles(dirPath) {
  const files = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) files.push(...findJsonFiles(fullPath));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) files.push(fullPath);
  }
  return files;
}

function parseJsonLenient(text, filePath) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const repaired = text.replace(/,\s*([\]}])/g, "$1");
    try {
      return JSON.parse(repaired);
    } catch {
      error.message = `${error.message} (${filePath})`;
      throw error;
    }
  }
}

function loadProducts(args) {
  const files = args.in
    ? [args.in]
    : findJsonFiles(args.inDir).filter((filePath) => {
        if (!args.contains) return true;
        return path.basename(filePath).toLowerCase().includes(String(args.contains).toLowerCase());
      });

  const products = [];
  for (const filePath of files.sort()) {
    const parsed = parseJsonLenient(fs.readFileSync(filePath, "utf8"), filePath);
    if (!Array.isArray(parsed)) continue;
    for (const product of parsed) {
      if (args.distributor && normalizeText(product.distributor) !== normalizeText(args.distributor)) continue;
      products.push({
        ...product,
        __sourceFile: path.basename(filePath),
      });
    }
  }
  return { files, products };
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function writeCsv(filePath, headers, rows) {
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((header) => csvEscape(row[header])).join(","));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `\uFEFF${lines.join("\n")}\n`, "utf8");
}

function normalizeRef(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function normalizeVariantKey(key) {
  const value = normalizeText(key);
  if (["color", "colour"].includes(value)) return "color";
  if (["reference color", "reference colour", "color referencia", "colour reference", "color de referencia"].includes(value)) return "reference_color";
  if (["tipo de pod", "tipo pod", "pod type", "type of pod"].includes(value)) return "pod_type";
  if (["ohm", "ohmios", "resistencia"].includes(value)) return "resistencia";
  if (["capacidad", "ml", "tamano", "tamaño", "size"].includes(value)) return "capacidad";
  if (["nicotina", "mg", "sales de nicotina"].includes(value)) return "nicotina";
  if (["vgpg", "pgvg", "vg/pg", "pg/vg", "compuesto base"].includes(value)) return "base_ratio";
  if (["elige sabor", "sabor", "flavor", "flavour"].includes(value)) return "sabor";
  if (["cafeina", "cafeína"].includes(value)) return "cafeina";
  if (["tamano", "tamaño", "size"].includes(value)) return "tamano";
  return value || "variante";
}

function referencePrefix(product) {
  const normalized = normalizeText(product.reference);
  const match = normalized.match(/^([a-z])[\s.-]/);
  if (match) return match[1];
  return "";
}

function classifyProductType(product) {
  const text = normalizeText([
    product.name,
    product.category,
    product.categoryId,
    product.reference,
    product.syntheticReference,
  ].filter(Boolean).join(" "));
  const variantText = normalizeText(Object.entries(product.variants || {})
    .map(([key, value]) => `${key} ${value}`)
    .join(" "));
  const hasResistanceVariant = /\b(ohm|ohmios|resistencia)\b/.test(variantText);
  const refPrefix = referencePrefix(product);

  if (/\b(pouch|pouches|nicotine pouch)\b/.test(text)) return "pouch";
  if (/\b(cbd)\b/.test(text)) return "cbd";
  if (/\b(aroma|aromas|concentrado|concentrate|longfill|shortfill|shake and vape|alquimia|diy)\b/.test(text)) return "aroma_concentrate";
  if (/\b(base|bases|booster|nicokit|nicokit|base neutra)\b/.test(text)) return "base_booster";
  if (/\b(sales|salts|nic salt|nicotine salts|salt nic|sales de nicotina)\b/.test(text)) return "nicotine_salt";
  if (/\b(liquido|liquidos|liquid|liquids|e-liquid|eliquid|e liquid)\b/.test(text)) return "eliquid";
  if (/\bpod\b/.test(text) && /\b(\d+\s*pcs|\d+\s*pc|\d+\s*unidades?|pack\s*\d+)\b/.test(text) && hasResistanceVariant) return "pod_replacement";
  if (refPrefix === "k") return "kit_device";
  if (/\+\s*(itank|xtank|tank|atomizador|clearomizador|rta|rdta|rda)|\bcon\s+(itank|xtank|tank|atomizador|clearomizador)\b/.test(text)) return "kit_device";
  if (/\b(pyrex|glass|cristal)\b|deposito\s+de\s+pyrex/.test(text)) return "pyrex";
  if (/\b(atomizador|atomizadores|tank|tanks|clearomizador|rta|rda|rdta)\b/.test(text)) return "atomizer_tank";
  if (/\b(coil|coils|resistencia|resistencias)\b/.test(text)) return "coil";
  if (/\b(empty pod|replacement pod|pod replacement|cartridge|cartucho|pods? vacios?|pods? recambio|pack ?\d+|\d+\s*pcs|\d+\s*pc)\b/.test(text)) return "pod_replacement";
  if (refPrefix === "m") return "mod_device";
  if (/\b(mod\b|mods\b|box mod|solo mod)\b/.test(text) && !/\b(kit|pod kit|starter kit)\b/.test(text)) return "mod_device";
  if (/\b(pod kit|kit pod|starter kit|kit\b|pod system|dispositivo|device|aio)\b/.test(text)) return "kit_device";
  if (/\b(desechable|disposable)\b/.test(text)) return "disposable";
  if (/\b(bateria|battery|cargador|charger|pila)\b/.test(text)) return "battery_charger";
  if (/\b(algodon|cotton|drip tip|boquilla|accesorio|adapter|adaptador)\b/.test(text)) return "accessory";
  return "unknown";
}

function urlWithoutVariant(url) {
  return String(url || "").split("#")[0];
}

function baseKey(product) {
  const ref = normalizeRef(product.syntheticReference || product.reference);
  if (ref) return ref;
  return normalizeRef(urlWithoutVariant(product.url));
}

function baseProductId(product, title) {
  const key = baseKey(product) || normalizeRef(title);
  const urlKey = normalizeRef(urlWithoutVariant(product.url)).slice(-80);
  return `${product.distributor || "SRC"}:${key}:${urlKey}`;
}

function stripVariantFromName(name, variants) {
  let result = String(name || "").trim();
  const values = Object.values(variants || {})
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  for (const value of values) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`\\s+-\\s+${escaped}$`, "i"), "");
  }

  return result.replace(/\s+/g, " ").trim() || name || "";
}

function unique(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value || "").trim();
    const key = normalizeText(text).replace(/[^a-z0-9]+/g, "");
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function listValue(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (value == null || value === "") return [];
  return String(value).split(/[|,]/).map((item) => item.trim()).filter(Boolean);
}

function lastUsefulBreadcrumbBrand(product) {
  const breadcrumb = listValue(product.breadcrumbPath || product.breadcrumb || product.breadcrumbs);
  const generic = new Set([
    "inicio",
    "productos",
    "producto",
    "alquimia",
    "aromas",
    "aroma",
    "liquidos",
    "liquidos electronicos",
    "sales",
    "sales de nicotina",
    "kits",
    "kits pod system",
    "pod system",
    "pods",
    "resistencias",
    "recambios",
    "desechables",
    "mods",
    "mod electronico",
    "atomizadores",
    "accesorios",
  ]);
  for (const part of [...breadcrumb].reverse()) {
    if (!generic.has(normalizeText(part))) return part;
  }
  return "";
}

function inferBrandCandidates(product, primaryBrand) {
  return unique([
    ...listValue(product.brandCandidates),
    product.commercialBrand,
    primaryBrand,
    lastUsefulBreadcrumbBrand(product),
  ]);
}

function derivedField(product, key) {
  const derived = product.derived && typeof product.derived === "object" ? product.derived : {};
  return derived[key] ?? "";
}

function inferBrand(product) {
  const candidates = listValue(product.brandCandidates);
  if (candidates.length) return candidates[0];
  if (product.commercialBrand) return product.commercialBrand;
  if (product.brand) return product.brand;
  const withoutVariant = stripVariantFromName(product.name, product.variants);
  const normalizedDashName = withoutVariant.replace(/[\u2013\u2014]/g, "-");
  const parts = normalizedDashName
    .split(/\s+[-–]\s+|[-–]\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  while (parts.length >= 2 && /\b(\d+\s*(mg|ml|mah|ohm|w)|\d+\s*\/\s*\d+)\b/i.test(parts[parts.length - 1])) {
    parts.pop();
  }
  if (parts.length >= 2) return parts[parts.length - 1];
  return lastUsefulBreadcrumbBrand(product);
}

function normalizedVariants(product) {
  const result = {};
  for (const [key, value] of Object.entries(product.variants || {})) {
    const normalizedKey = normalizeVariantKey(key);
    if (value != null && String(value).trim()) result[normalizedKey] = String(value).trim();
  }
  return result;
}

function liquidProductType(productType) {
  return ["aroma_concentrate", "eliquid", "nicotine_salt", "base_booster"].includes(productType);
}

function mlValue(value) {
  const number = Number(String(value || "").replace(",", "."));
  if (!Number.isFinite(number)) return "";
  return `${Number.isInteger(number) ? number : number.toString()} ml`;
}

function mlNumber(value) {
  const match = String(value || "").match(/(\d+(?:[.,]\d+)?)\s*ml/i);
  if (!match) return null;
  const number = Number(match[1].replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function hasLongfillSignal(source) {
  return /\b(longfill|shortfill|shake\s*(?:and|&)?\s*vape)\b/i.test(source);
}

function hasNicotineSignal(source) {
  const text = normalizeText(source);
  if (/\b(sin|without)\s+nicotina\b|\b0\s*mg\b/.test(text)) return false;
  return /\b(nicotine|sales|salts|\d+(?:[.,]\d+)?\s*mg)\b/.test(text);
}

function liquidCanContainNicotine(productType) {
  return ["eliquid", "nicotine_salt", "base_booster"].includes(productType);
}

function liquidContainsNicotine(productType, source, variantNicotine) {
  if (variantNicotine && !/\b0\s*mg\b|\bsin\s+nicotina\b/i.test(String(variantNicotine))) return true;
  if (!liquidCanContainNicotine(productType)) return false;
  if (["nicotine_salt", "base_booster"].includes(productType)) return true;
  return hasNicotineSignal(source);
}

function enforceNicotineBottleLimit(result, hasNicotine) {
  if (!hasNicotine) return;
  const bottleNumber = mlNumber(result.bote_ml);
  if (bottleNumber == null || bottleNumber <= 10) return;

  const contentNumber = mlNumber(result.contenido_ml);
  result.bote_ml = contentNumber != null && contentNumber <= 10 ? result.contenido_ml : "";
}

function liquidCapacityParts(product, variants, productType, baseTitle) {
  const result = {
    contenido_ml: variants.contenido_ml || variants.contenido || "",
    bote_ml: variants.bote_ml || variants.capacidad_bote || "",
  };
  if (!liquidProductType(productType)) return result;

  const source = normalizeText([
    variantLabel(variants),
    variants.capacidad,
    product.name,
    baseTitle,
    product.url,
    product.description,
  ].filter(Boolean).join(" "));

  function setContent(value) {
    if (!result.contenido_ml) result.contenido_ml = mlValue(value);
  }

  function setBottle(value) {
    if (!result.bote_ml) result.bote_ml = mlValue(value);
  }

  const compactBottle = source.match(/(\d+(?:[.,]\d+)?)\s*ml\s*\/\s*(\d+(?:[.,]\d+)?)\s*(?:ml|\b(?=\s*(?:longfill|shortfill|shake|\(|$)))/i);
  if (compactBottle) {
    setContent(compactBottle[1]);
    setBottle(compactBottle[2]);
  }

  const labelBottle = source.match(/(\d+(?:[.,]\d+)?)\s*ml\s+en\s+(?:bote|botella)\s+de\s+(\d+(?:[.,]\d+)?)\s*ml/i);
  if (labelBottle) {
    setContent(labelBottle[1]);
    setBottle(labelBottle[2]);
  }

  const bottleWithContent = source.match(/(?:botella|bote)\s+de\s+(\d+(?:[.,]\d+)?)\s*ml\s+con\s+(\d+(?:[.,]\d+)?)\s*ml/i);
  if (bottleWithContent) {
    setBottle(bottleWithContent[1]);
    setContent(bottleWithContent[2]);
  }

  const bottleCapacity = source.match(/capacidad\s+del\s+bote\s*:?\s*(\d+(?:[.,]\d+)?)\s*ml/i)
    || source.match(/(?:botella|bote)\s+de\s+(\d+(?:[.,]\d+)?)\s*ml/i);
  if (bottleCapacity) setBottle(bottleCapacity[1]);

  const content = source.match(/(?:formato|contenido|aroma)\s*:?\s*(\d+(?:[.,]\d+)?)\s*ml/i);
  if (content) setContent(content[1]);

  const firstMl = source.match(/(\d+(?:[.,]\d+)?)\s*ml/i);
  if (firstMl) setContent(firstMl[1]);

  const isLongfill = hasLongfillSignal(source);
  const hasNicotine = liquidContainsNicotine(productType, source, variants.nicotina);
  const contentNumber = mlNumber(result.contenido_ml);
  if (
    !result.bote_ml &&
    result.contenido_ml &&
    !isLongfill &&
    liquidCanContainNicotine(productType) &&
    (!hasNicotine || contentNumber == null || contentNumber <= 10)
  ) {
    result.bote_ml = result.contenido_ml;
  }
  enforceNicotineBottleLimit(result, hasNicotine);

  return result;
}

function variantSignature(variants) {
  return Object.entries(variants)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${normalizeText(value).replace(/[^a-z0-9]+/g, "")}`)
    .join("|");
}

function variantLabel(variants) {
  return Object.entries(variants)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}: ${value}`)
    .join("; ");
}

function summarizeVariants(products) {
  const byKey = new Map();
  for (const product of products) {
    for (const [key, value] of Object.entries(normalizedVariants(product))) {
      if (!byKey.has(key)) byKey.set(key, new Set());
      byKey.get(key).add(value);
    }
  }

  const parts = [];
  const values = [];
  for (const [key, set] of byKey) {
    const sorted = [...set].sort((left, right) => left.localeCompare(right));
    parts.push(`${key}: ${sorted.length}`);
    values.push(`${key}: ${sorted.join(" | ")}`);
  }
  return {
    summary: parts.join("; "),
    values: values.join("; "),
  };
}

function summarizeSources(products) {
  return [...new Set(products.map((product) => product.__sourceFile).filter(Boolean))].sort().join(" | ");
}

function summarizeCategories(products) {
  return [...new Set(products.map((product) => product.category).filter(Boolean))].sort().join(" | ");
}

function pickRepresentative(products) {
  return [...products].sort((left, right) => {
    const leftName = stripVariantFromName(left.name, left.variants);
    const rightName = stripVariantFromName(right.name, right.variants);
    return leftName.length - rightName.length || String(left.name).localeCompare(String(right.name));
  })[0];
}

function groupProducts(products) {
  const groups = new Map();
  for (const product of products) {
    const brand = inferBrand(product) || "NO_BRAND";
    const key = [
      product.distributor || "",
      brand,
      baseKey(product),
      urlWithoutVariant(product.url),
    ].join("::");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(product);
  }
  return groups;
}

function buildBaseRows(groups) {
  return [...groups.values()].map((items) => {
    const rep = pickRepresentative(items);
    const variants = summarizeVariants(items);
    const prices = items.map((item) => Number(item.priceTaxExcluded)).filter((value) => Number.isFinite(value));
    const title = stripVariantFromName(rep.name, rep.variants);
    const brand = inferBrand(rep);
    const brandCandidates = inferBrandCandidates(rep, brand);
    const ref = rep.reference || "";
    const syntheticRef = rep.syntheticReference || "";
    const key = baseKey(rep);
    const baseId = baseProductId(rep, title);
    const productType = classifyProductType(rep);

    return {
      id: baseId,
      distributor: rep.distributor || "",
      url: urlWithoutVariant(rep.url),
      title,
      description: [
        title,
        rep.description ? `Descripcion scrapeada: ${rep.description}` : "",
        rep.metaDescription ? `Meta descripcion: ${rep.metaDescription}` : "",
        brand ? `Marca: ${brand}` : "",
        brandCandidates.length ? `Marcas candidatas: ${brandCandidates.join(" | ")}` : "",
        rep.commercialBrand ? `Marca comercial: ${rep.commercialBrand}` : "",
        rep.productLine ? `Linea: ${rep.productLine}` : "",
        listValue(rep.breadcrumbPath).length ? `Breadcrumb: ${listValue(rep.breadcrumbPath).join(" > ")}` : "",
        rep.category ? `Categoria: ${rep.category}` : "",
        ref ? `Referencia: ${ref}` : "",
        syntheticRef ? `Referencia sintetica: ${syntheticRef}` : "",
        variants.summary ? `Variantes: ${variants.summary}` : "",
        variants.values ? `Valores de variantes: ${variants.values}` : "",
      ].filter(Boolean).join(". "),
      category: rep.category || "",
      sourceCategories: summarizeCategories(items),
      brand,
      brandCandidates: brandCandidates.join(" | "),
      commercialBrand: rep.commercialBrand || "",
      productLine: rep.productLine || "",
      breadcrumbPath: listValue(rep.breadcrumbPath).join(" > "),
      metaDescription: rep.metaDescription || "",
      productType,
      reference: ref,
      syntheticReference: syntheticRef,
      baseKey: key,
      variantCount: items.length,
      variantSummary: variants.summary,
      variantValues: variants.values,
      minPriceTaxExcluded: prices.length ? Math.min(...prices) : "",
      maxPriceTaxExcluded: prices.length ? Math.max(...prices) : "",
      sourceFiles: summarizeSources(items),
    };
  }).sort((left, right) => {
    return String(left.brand).localeCompare(String(right.brand)) || String(left.title).localeCompare(String(right.title));
  });
}

function buildVariantRows(groups) {
  const rows = [];
  for (const items of groups.values()) {
    const rep = pickRepresentative(items);
    const baseTitle = stripVariantFromName(rep.name, rep.variants);
    const baseId = baseProductId(rep, baseTitle);
    const brand = inferBrand(rep);
    const brandCandidates = inferBrandCandidates(rep, brand);
    const productType = classifyProductType(rep);
    for (const item of items) {
      const variants = normalizedVariants(item);
      const signature = variantSignature(variants);
      const liquidParts = liquidCapacityParts(item, variants, productType, baseTitle);
      rows.push({
        id: `${baseId}:${signature || normalizeRef(item.sku || item.url || item.name)}`,
        baseId,
        distributor: item.distributor || "",
        url: item.url || "",
        baseUrl: urlWithoutVariant(item.url),
        title: item.name || "",
        description: item.description || "",
        baseTitle,
        category: item.category || "",
        brand,
        brandCandidates: brandCandidates.join(" | "),
        commercialBrand: item.commercialBrand || "",
        productLine: item.productLine || "",
        breadcrumbPath: listValue(item.breadcrumbPath).join(" > "),
        metaDescription: item.metaDescription || "",
        productType,
        reference: item.reference || "",
        syntheticReference: item.syntheticReference || "",
        sku: item.sku || "",
        priceTaxExcluded: item.priceTaxExcluded ?? "",
        variantSignature: signature,
        variantLabel: variantLabel(variants),
        color: variants.color || "",
        reference_color: variants.reference_color || "",
        pod_type: variants.pod_type || "",
        nicotina: variants.nicotina || "",
        capacidad: variants.capacidad || "",
        contenido_ml: liquidParts.contenido_ml,
        bote_ml: liquidParts.bote_ml,
        resistencia: variants.resistencia || "",
        base_ratio: variants.base_ratio || "",
        sabor: variants.sabor || "",
        cafeina: variants.cafeina || "",
        tamano: variants.tamano || "",
        derived_reference_color: derivedField(item, "matchedReferenceColor"),
        derivedJson: item.derived ? JSON.stringify(item.derived) : "",
        variantsJson: JSON.stringify(variants),
        sourceFile: item.__sourceFile || "",
      });
    }
  }
  return rows.sort((left, right) => {
    return String(left.brand).localeCompare(String(right.brand))
      || String(left.baseTitle).localeCompare(String(right.baseTitle))
      || String(left.variantLabel).localeCompare(String(right.variantLabel));
  });
}

function main() {
  const args = parseArgs(process.argv);
  const { files, products } = loadProducts(args);
  if (!products.length) throw new Error("No se encontraron productos JSON.");

  const groups = groupProducts(products);
  const baseRows = buildBaseRows(groups);
  const variantRows = buildVariantRows(groups);

  if (args.baseOut) {
    writeCsv(args.baseOut, [
      "id",
      "distributor",
      "url",
      "title",
      "description",
      "category",
      "sourceCategories",
      "brand",
      "brandCandidates",
      "commercialBrand",
      "productLine",
      "breadcrumbPath",
      "metaDescription",
      "productType",
      "reference",
      "syntheticReference",
      "baseKey",
      "variantCount",
      "variantSummary",
      "variantValues",
      "minPriceTaxExcluded",
      "maxPriceTaxExcluded",
      "sourceFiles",
    ], baseRows);
  }

  if (args.variantsOut) {
    writeCsv(args.variantsOut, [
      "id",
      "baseId",
      "distributor",
      "url",
      "baseUrl",
      "title",
      "description",
      "baseTitle",
      "category",
      "brand",
      "brandCandidates",
      "commercialBrand",
      "productLine",
      "breadcrumbPath",
      "metaDescription",
      "productType",
      "reference",
      "syntheticReference",
      "sku",
      "priceTaxExcluded",
      "variantSignature",
      "variantLabel",
      "color",
      "reference_color",
      "pod_type",
      "nicotina",
      "capacidad",
      "contenido_ml",
      "bote_ml",
      "resistencia",
      "base_ratio",
      "sabor",
      "cafeina",
      "tamano",
      "derived_reference_color",
      "derivedJson",
      "variantsJson",
      "sourceFile",
    ], variantRows);
  }

  console.log(`Archivos: ${files.length}`);
  console.log(`Entrada: ${products.length} filas`);
  console.log(`Productos base: ${baseRows.length}`);
  console.log(`Variantes: ${variantRows.length}`);
  if (args.baseOut) console.log(`Base: ${args.baseOut}`);
  if (args.variantsOut) console.log(`Variantes: ${args.variantsOut}`);
}

main();
