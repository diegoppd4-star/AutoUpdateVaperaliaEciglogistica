const fs = require("fs");
const path = require("path");

const POLICY = {
  baseAcceptedDecisions: ["match"],
  autoAcceptVariant: {
    decisions: ["variant_match"],
    minConfidence: 0.95,
  },
  probableVariant: {
    decisions: ["possible_variant_match"],
    minConfidence: 0.85,
  },
  discardBelowConfidence: 0.85,
};

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
  if (!args.baseMatches || !args.variantMatches || !args.out) {
    throw new Error("Uso: node scripts/build-valid-matches-json.js --base-matches base.csv --variant-matches variants.csv --out valid.json [--b-variants b.variants.csv]");
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
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
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

function loadCsv(filePath) {
  return parseCsv(fs.readFileSync(filePath, "utf8"));
}

function loadBaseIndex(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return new Map();
  return new Map(loadCsv(filePath).map((row) => [row.id, row]));
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function productSide(productId, title, baseIndex) {
  const base = baseIndex.get(productId) || {};
  return {
    productId,
    title: title || base.title || "",
    url: base.url || "",
    brand: base.brand || "",
    productType: base.productType || "",
  };
}

function classifyVariant(row) {
  const confidence = number(row.variant_confidence);
  if (row.variant_decision === "a_variant_without_b_variant") return "ecig_only";
  if (row.variant_decision === "b_variant_without_a_variant") return "vaperalia_only";

  if (
    POLICY.autoAcceptVariant.decisions.includes(row.variant_decision) &&
    confidence >= POLICY.autoAcceptVariant.minConfidence
  ) {
    return "valid";
  }

  if (
    POLICY.probableVariant.decisions.includes(row.variant_decision) &&
    confidence >= POLICY.probableVariant.minConfidence
  ) {
    return "probable";
  }

  if (confidence <= 0) return "impossible";
  return "discarded_low_confidence";
}

function finalConfidence(baseRow, variantRow) {
  return Math.round(number(baseRow.confidence) * number(variantRow.variant_confidence) * 1000) / 1000;
}

function variantObject(baseRow, variantRow, status) {
  return {
    status,
    finalConfidence: finalConfidence(baseRow, variantRow),
    variantDecision: variantRow.variant_decision,
    variantConfidence: number(variantRow.variant_confidence),
    reason: variantRow.reason,
    eciglogistica: {
      variantId: variantRow.a_variant_id,
      title: variantRow.a_title,
      url: variantRow.a_url,
      variant: variantRow.a_variant,
    },
    vaperalia: {
      variantId: variantRow.b_variant_id,
      title: variantRow.b_title,
      url: variantRow.b_url,
      variant: variantRow.b_variant,
    },
  };
}

function bOnlyVariantObject(baseRow, variantRow) {
  return {
    status: "vaperalia_only",
    finalConfidence: 0,
    variantDecision: "b_variant_without_a_variant",
    variantConfidence: 0,
    reason: "Existe en Vaperalia dentro de un producto base matcheado, pero no se encontro una variante equivalente en Eciglogistica.",
    eciglogistica: {
      variantId: "",
      title: "",
      url: "",
      variant: "",
    },
    vaperalia: {
      variantId: variantRow.id,
      title: variantRow.title,
      url: variantRow.url,
      variant: variantRow.variantLabel,
    },
  };
}

function main() {
  const args = parseArgs(process.argv);
  const baseRows = loadCsv(args.baseMatches);
  const variantRows = loadCsv(args.variantMatches);
  const bVariantRows = args.bVariants ? loadCsv(args.bVariants) : [];
  const aBaseIndex = loadBaseIndex(args.aBase);
  const bBaseIndex = loadBaseIndex(args.bBase);
  const variantsByPair = groupBy(variantRows, (row) => `${row.base_match_a_id}|||${row.base_match_b_id}`);
  const bVariantsByBase = groupBy(bVariantRows, (row) => row.baseId);
  const matchedBVariantIdsGlobal = new Set(variantRows
    .filter((row) => ["valid", "probable"].includes(classifyVariant(row)))
    .map((row) => row.b_variant_id)
    .filter(Boolean));
  const emittedBOnlyVariantIdsGlobal = new Set();
  const products = [];
  const discardedBaseMatches = [];
  const discarded = {
    impossible: 0,
    discarded_low_confidence: 0,
    ecig_only: 0,
    vaperalia_only: 0,
    baseNoMatch: 0,
    variantRowsTotal: variantRows.length,
  };

  for (const baseRow of baseRows) {
    if (!POLICY.baseAcceptedDecisions.includes(baseRow.decision) || !baseRow.best_match_b_id) {
      discarded.baseNoMatch += 1;
      discardedBaseMatches.push({
        status: "base_no_match",
        baseDecision: baseRow.decision,
        baseConfidence: number(baseRow.confidence),
        reason: baseRow.reason,
        eciglogistica: productSide(baseRow.product_a_id, baseRow.product_a_title, aBaseIndex),
        vaperalia: productSide(baseRow.best_match_b_id, baseRow.best_match_b_title, bBaseIndex),
        variants: [],
      });
      continue;
    }

    const pairKey = `${baseRow.product_a_id}|||${baseRow.best_match_b_id}`;
    const variants = [];
    const pairVariants = variantsByPair.get(pairKey) || [];
    for (const variantRow of pairVariants) {
      const status = classifyVariant(variantRow);
      variants.push(variantObject(baseRow, variantRow, status));
      if (status !== "valid" && status !== "probable") {
        discarded[status] = (discarded[status] || 0) + 1;
      }
    }

    for (const bVariant of bVariantsByBase.get(baseRow.best_match_b_id) || []) {
      if (matchedBVariantIdsGlobal.has(bVariant.id)) continue;
      if (emittedBOnlyVariantIdsGlobal.has(bVariant.id)) continue;
      emittedBOnlyVariantIdsGlobal.add(bVariant.id);
      variants.push(bOnlyVariantObject(baseRow, bVariant));
      discarded.vaperalia_only += 1;
    }

    if (variants.length === 0) continue;

    products.push({
      status: "base_match",
      baseConfidence: number(baseRow.confidence),
      reason: baseRow.reason,
      eciglogistica: productSide(baseRow.product_a_id, baseRow.product_a_title, aBaseIndex),
      vaperalia: productSide(baseRow.best_match_b_id, baseRow.best_match_b_title, bBaseIndex),
      variants: variants.sort((left, right) => right.finalConfidence - left.finalConfidence),
    });
  }

  const flatVariants = products.flatMap((product) =>
    product.variants.map((variant) => ({
      product: {
        eciglogistica: product.eciglogistica.title,
        vaperalia: product.vaperalia.title,
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
      left: args.leftLabel || "Eciglogistica",
      right: args.rightLabel || "Vaperalia",
    },
    source: {
      baseMatches: path.resolve(args.baseMatches),
      variantMatches: path.resolve(args.variantMatches),
    },
    confidencePolicy: POLICY,
    summary: {
      baseRows: baseRows.length,
      baseMatchesKept: products.filter((product) =>
        product.variants.some((variant) => variant.status === "valid" || variant.status === "probable")
      ).length,
      baseProductsVisible: products.length,
      validVariants: flatMatches.filter((match) => match.status === "valid").length,
      probableVariants: flatMatches.filter((match) => match.status === "probable").length,
      totalVariantsKept: flatMatches.length,
      totalVariantsVisible: flatVariants.length,
      discardedVariantsVisible: flatDiscardedVariants.length,
      ecigOnlyVariants: flatEcigOnlyVariants.length,
      vaperaliaOnlyVariants: flatVaperaliaOnlyVariants.length,
      discardedBaseMatches: discardedBaseMatches.length,
      discarded,
    },
    products,
    flatMatches,
    flatDiscardedVariants,
    flatEcigOnlyVariants,
    flatVaperaliaOnlyVariants,
    discardedBaseMatches,
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Archivo: ${args.out}`);
  console.log(JSON.stringify(output.summary, null, 2));
}

main();
