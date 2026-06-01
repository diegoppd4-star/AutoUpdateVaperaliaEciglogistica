const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    inDir: "outputs",
    manifest: "outputs/datasets.json",
    out: "outputs/general.matches.valid.json",
    aBase: "outputs/prepared/eciglogistica__output.base.csv",
    bBase: "outputs/prepared/vaperalia__output.base.csv",
  };
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
  return args;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (char === "\"" && quoted && next === "\"") {
      cell += "\"";
      i += 1;
    } else if (char === "\"") {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    if (row.some((value) => value.trim() !== "")) rows.push(row);
  }

  const headers = rows.shift().map((header) => header.trim());
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
}

function loadBaseIndex(args) {
  const files = [args.aBase, args.bBase].filter(Boolean);
  const index = new Map();
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    for (const row of parseCsv(fs.readFileSync(file, "utf8"))) {
      index.set(row.id, row);
    }
  }
  return index;
}

function enrichSide(side, baseIndex) {
  if (!side?.productId) return side;
  const base = baseIndex.get(side.productId);
  if (!base) return side;
  return {
    ...side,
    title: side.title || base.title || "",
    url: side.url || base.url || "",
    brand: side.brand || base.brand || "",
    productType: side.productType || base.productType || "",
  };
}

function enrichProduct(product, baseIndex) {
  return {
    ...product,
    eciglogistica: enrichSide(product.eciglogistica, baseIndex),
    vaperalia: enrichSide(product.vaperalia, baseIndex),
  };
}

function sourceKey(product) {
  return product?.eciglogistica?.productId || "";
}

function variantKey(variant) {
  return [
    variant.status,
    variant.eciglogistica?.variantId || "",
    variant.vaperalia?.variantId || "",
    variant.reason || "",
  ].join("|||");
}

function hasAcceptedVariants(product) {
  return (product.variants || []).some((variant) => variant.status === "valid" || variant.status === "probable");
}

function productRank(product) {
  if (hasAcceptedVariants(product)) return 4;
  if ((product.variants || []).length > 0) return 3;
  if (product.status === "base_no_match") return 1;
  return 2;
}

function mergeProduct(existing, incoming) {
  if (!existing) return incoming;
  if (productRank(incoming) > productRank(existing)) return incoming;
  if (productRank(incoming) < productRank(existing)) return existing;

  const merged = {
    ...existing,
    variants: [...(existing.variants || [])],
  };
  const seen = new Set(merged.variants.map(variantKey));
  for (const variant of incoming.variants || []) {
    const key = variantKey(variant);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.variants.push(variant);
  }
  merged.variants.sort((left, right) => (right.finalConfidence || 0) - (left.finalConfidence || 0));
  return merged;
}

function datasetFiles(args) {
  let datasets = [];
  if (fs.existsSync(args.manifest)) {
    datasets = JSON.parse(fs.readFileSync(args.manifest, "utf8"));
  } else {
    datasets = fs.readdirSync(args.inDir)
      .filter((file) => file.endsWith(".matches.valid.json"))
      .map((file) => ({ id: file.replace(/\.matches\.valid\.json$/, ""), label: file, url: `outputs/${file}` }));
  }
  const hasReviewedRescues = datasets.some((dataset) => dataset.id === "reviewed-rescues");

  return datasets
    .filter((dataset) => dataset.id !== "general")
    .filter((dataset) => dataset.id !== "inverse-vaperalia-audit")
    .filter((dataset) => !(hasReviewedRescues && dataset.id === "description-rescue-candidates"))
    .map((dataset) => ({
      ...dataset,
      file: path.join(args.inDir, path.basename(dataset.url)),
    }))
    .filter((dataset) => fs.existsSync(dataset.file));
}

function buildSummary(products, discardedBaseMatches, variantRowsTotal) {
  const flatVariants = products.flatMap((product) => product.variants || []);
  const flatMatches = flatVariants.filter((variant) => variant.status === "valid" || variant.status === "probable");
  const flatDiscardedVariants = flatVariants.filter((variant) => variant.status !== "valid" && variant.status !== "probable");
  const flatEcigOnlyVariants = flatVariants.filter((variant) => variant.status === "ecig_only");
  const flatVaperaliaOnlyVariants = flatVariants.filter((variant) => variant.status === "vaperalia_only");
  const discarded = {
    impossible: flatVariants.filter((variant) => variant.status === "impossible").length,
    discarded_low_confidence: flatVariants.filter((variant) => variant.status === "discarded_low_confidence").length,
    ecig_only: flatEcigOnlyVariants.length,
    vaperalia_only: flatVaperaliaOnlyVariants.length,
    baseNoMatch: discardedBaseMatches.length,
    variantRowsTotal,
  };

  return {
    baseRows: products.length + discardedBaseMatches.length,
    baseMatchesKept: products.filter(hasAcceptedVariants).length,
    baseProductsVisible: products.length,
    validVariants: flatMatches.filter((variant) => variant.status === "valid").length,
    probableVariants: flatMatches.filter((variant) => variant.status === "probable").length,
    totalVariantsKept: flatMatches.length,
    totalVariantsVisible: flatVariants.length,
    discardedVariantsVisible: flatDiscardedVariants.length,
    ecigOnlyVariants: flatEcigOnlyVariants.length,
    vaperaliaOnlyVariants: flatVaperaliaOnlyVariants.length,
    discardedBaseMatches: discardedBaseMatches.length,
    discarded,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const baseIndex = loadBaseIndex(args);
  const productMap = new Map();
  const baseNoMatchMap = new Map();
  let variantRowsTotal = 0;
  const sources = [];

  for (const dataset of datasetFiles(args)) {
    const data = JSON.parse(fs.readFileSync(dataset.file, "utf8"));
    sources.push({ id: dataset.id, label: dataset.label, url: dataset.url });
    variantRowsTotal += data.summary?.discarded?.variantRowsTotal || 0;

    for (const product of data.products || []) {
      const key = sourceKey(product);
      if (!key) continue;
      const enriched = {
        ...enrichProduct(product, baseIndex),
        sourceDataset: dataset.id,
        sourceDatasetLabel: dataset.label,
      };
      productMap.set(key, mergeProduct(productMap.get(key), enriched));
      baseNoMatchMap.delete(key);
    }

    for (const product of data.discardedBaseMatches || []) {
      const key = sourceKey(product);
      if (!key || productMap.has(key) || baseNoMatchMap.has(key)) continue;
      baseNoMatchMap.set(key, {
        ...enrichProduct(product, baseIndex),
        sourceDataset: dataset.id,
        sourceDatasetLabel: dataset.label,
      });
    }
  }

  const products = [...productMap.values()]
    .sort((left, right) => String(left.eciglogistica?.title || "").localeCompare(String(right.eciglogistica?.title || "")));
  const discardedBaseMatches = [...baseNoMatchMap.values()]
    .filter((product) => !productMap.has(sourceKey(product)))
    .sort((left, right) => String(left.eciglogistica?.title || "").localeCompare(String(right.eciglogistica?.title || "")));

  const flatVariants = products.flatMap((product) =>
    (product.variants || []).map((variant) => ({
      product: {
        eciglogistica: product.eciglogistica?.title || "",
        vaperalia: product.vaperalia?.title || "",
      },
      ...variant,
    }))
  );
  const flatMatches = flatVariants.filter((match) => match.status === "valid" || match.status === "probable");
  const flatDiscardedVariants = flatVariants.filter((match) => match.status !== "valid" && match.status !== "probable");
  const flatEcigOnlyVariants = flatVariants.filter((match) => match.status === "ecig_only");
  const flatVaperaliaOnlyVariants = flatVariants.filter((match) => match.status === "vaperalia_only");

  const output = {
    generatedAt: new Date().toISOString(),
    sideLabels: {
      left: "Eciglogistica",
      right: "Vaperalia",
    },
    source: {
      aggregate: true,
      excludedDatasets: ["inverse-vaperalia-audit", "description-rescue-candidates when reviewed-rescues exists"],
      datasets: sources,
    },
    confidencePolicy: {
      note: "Vista agregada de datasets ya calculados; no recalcula confianza.",
    },
    summary: buildSummary(products, discardedBaseMatches, variantRowsTotal),
    products,
    flatMatches,
    flatDiscardedVariants,
    flatEcigOnlyVariants,
    flatVaperaliaOnlyVariants,
    discardedBaseMatches,
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Datasets agregados: ${sources.length}`);
  console.log(`Archivo: ${args.out}`);
  console.log(JSON.stringify(output.summary, null, 2));
}

main();
