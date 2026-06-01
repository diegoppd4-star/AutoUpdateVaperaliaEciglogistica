const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    rescue: "outputs/description-rescue-candidates.matches.valid.json",
    decisions: "outputs/reviews/description-rescue-decisions.json",
    aVariants: "../outputs/prepared/eciglogistica__output.variants.csv",
    bVariants: "../outputs/prepared/vaperalia__output.variants.csv",
    out: "outputs/reviewed-rescues.matches.valid.json",
    auditMd: "outputs/audits/reviewed-rescues.audit.md",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2).replace(/-([a-z0-9])/g, (_, letter) => letter.toUpperCase());
    if (value == null || value.startsWith("--")) {
      args[name] = true;
      continue;
    }
    args[name] = value;
    i += 1;
  }
  return args;
}

function variantKey(variant) {
  return `${variant.eciglogistica?.variantId || ""}|||${variant.vaperalia?.variantId || ""}`;
}

function normalizeDecisionValue(value) {
  if (value === "accept") return "accepted";
  if (value === "reject") return "rejected";
  return value;
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

function readCsv(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return parseCsv(fs.readFileSync(filePath, "utf8"));
}

function byBaseId(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!row.baseId) continue;
    if (!map.has(row.baseId)) map.set(row.baseId, []);
    map.get(row.baseId).push(row);
  }
  return map;
}

function sideFromVariant(row) {
  return {
    variantId: row.id,
    title: row.title,
    url: row.url || row.baseUrl || "",
    variant: row.variantLabel || "",
  };
}

function ecigOnlyVariant(row) {
  return {
    status: "ecig_only",
    finalConfidence: 0,
    variantDecision: "a_variant_without_b_variant",
    variantConfidence: 0,
    reason: "Existe en Eciglogistica dentro de un producto base rescatado, pero no se encontro una variante equivalente en Vaperalia.",
    eciglogistica: sideFromVariant(row),
    vaperalia: {
      variantId: "",
      title: "",
      url: "",
      variant: "",
    },
  };
}

function vaperaliaOnlyVariant(row) {
  return {
    status: "vaperalia_only",
    finalConfidence: 0,
    variantDecision: "b_variant_without_a_variant",
    variantConfidence: 0,
    reason: "Existe en Vaperalia dentro de un producto base rescatado, pero no se encontro una variante equivalente en Eciglogistica.",
    eciglogistica: {
      variantId: "",
      title: "",
      url: "",
      variant: "",
    },
    vaperalia: sideFromVariant(row),
  };
}

function buildSummary(products, rejectedCount) {
  const flatVariants = products.flatMap((product) => product.variants || []);
  const flatMatches = flatVariants.filter((variant) => variant.status === "valid" || variant.status === "probable");
  const flatDiscardedVariants = flatVariants.filter((variant) => variant.status !== "valid" && variant.status !== "probable");
  const flatEcigOnlyVariants = flatVariants.filter((variant) => variant.status === "ecig_only");
  const flatVaperaliaOnlyVariants = flatVariants.filter((variant) => variant.status === "vaperalia_only");
  return {
    baseRows: products.length,
    baseMatchesKept: products.length,
    baseProductsVisible: products.length,
    validVariants: flatMatches.filter((variant) => variant.status === "valid").length,
    probableVariants: 0,
    totalVariantsKept: flatMatches.length,
    totalVariantsVisible: flatVariants.length,
    discardedVariantsVisible: flatDiscardedVariants.length + rejectedCount,
    ecigOnlyVariants: flatEcigOnlyVariants.length,
    vaperaliaOnlyVariants: flatVaperaliaOnlyVariants.length,
    discardedBaseMatches: 0,
    discarded: {
      impossible: 0,
      discarded_low_confidence: rejectedCount,
      ecig_only: flatEcigOnlyVariants.length,
      vaperalia_only: flatVaperaliaOnlyVariants.length,
      baseNoMatch: 0,
      variantRowsTotal: flatVariants.length + rejectedCount,
    },
  };
}

function mdLink(label, url) {
  return url ? `[${label}](${url})` : label;
}

function writeAuditMd(filePath, output, rejectedDecisions) {
  const lines = [
    "# Emparejamientos hechos con IA no determinista",
    "",
    `Generado: ${output.generatedAt}`,
    "",
    "Capa no determinista y auditable. No modifica `general.matches.valid.json` ni el pipeline principal.",
    "",
    `- Productos aceptados: ${output.summary.baseRows}`,
    `- Variantes aceptadas: ${output.summary.validVariants}`,
    `- Variantes rechazadas: ${rejectedDecisions.length}`,
    "",
  ];

  for (const product of output.products) {
    lines.push(`## ${product.eciglogistica.title}`);
    lines.push("");
    lines.push(`- Ecig: ${mdLink(product.eciglogistica.title, product.eciglogistica.url)}`);
    lines.push(`- Vaperalia: ${mdLink(product.vaperalia.title, product.vaperalia.url)}`);
    for (const variant of product.variants || []) {
      const left = variant.eciglogistica.title || "Sin equivalente";
      const right = variant.vaperalia.title || "Sin equivalente";
      lines.push(`- Variante: ${left} <> ${right}`);
      lines.push(`- Decision: ${variant.reviewDecision || variant.status} (${variant.reviewConfidence || "n/a"})`);
      lines.push(`- Motivo: ${variant.reason}`);
    }
    lines.push("");
  }

  if (rejectedDecisions.length) {
    lines.push("## Rechazados");
    lines.push("");
    for (const decision of rejectedDecisions) {
      lines.push(`- ${decision.ecigTitle || decision.ecigVariantId} <> ${decision.vaperaliaTitle || decision.vaperaliaVariantId}: ${decision.reviewReason}`);
    }
    lines.push("");
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function main() {
  const args = parseArgs(process.argv);
  const rescue = JSON.parse(fs.readFileSync(args.rescue, "utf8"));
  const review = JSON.parse(fs.readFileSync(args.decisions, "utf8"));
  const aVariantsByBase = byBaseId(readCsv(args.aVariants));
  const bVariantsByBase = byBaseId(readCsv(args.bVariants));
  const decisionByKey = new Map(review.decisions.map((decision) => [
    `${decision.ecigVariantId || ""}|||${decision.vaperaliaVariantId || ""}`,
    decision,
  ]));

  const missing = [];
  const rejectedDecisions = [];
  const products = [];
  for (const product of rescue.products || []) {
    const acceptedVariants = [];
    for (const variant of product.variants || []) {
      const key = variantKey(variant);
      const decision = decisionByKey.get(key);
      if (!decision) {
        missing.push(key);
        continue;
      }
      const decisionValue = normalizeDecisionValue(decision.decision);
      if (decisionValue !== "accepted") {
        rejectedDecisions.push({ ...decision, decision: decisionValue });
        continue;
      }
      acceptedVariants.push({
        ...variant,
        status: "valid",
        finalConfidence: variant.finalConfidence,
        variantDecision: "manual_review_valid",
        variantConfidence: variant.variantConfidence,
        reviewDecision: decision.decision,
        reviewConfidence: decision.reviewConfidence,
        reviewId: decision.reviewId,
        reason: `Validado por revision no determinista. ${decision.reviewReason}`,
      });
    }
    if (!acceptedVariants.length) continue;
    const usedA = new Set(acceptedVariants.map((variant) => variant.eciglogistica?.variantId).filter(Boolean));
    const usedB = new Set(acceptedVariants.map((variant) => variant.vaperalia?.variantId).filter(Boolean));
    const aRows = aVariantsByBase.get(product.eciglogistica?.productId || "") || [];
    const bRows = bVariantsByBase.get(product.vaperalia?.productId || "") || [];
    const acceptedPreparedVariant = aRows.some((row) => usedA.has(row.id))
      && bRows.some((row) => usedB.has(row.id));
    const orphanVariants = [];
    if (acceptedPreparedVariant) {
      for (const row of aRows) {
        if (usedA.has(row.id)) continue;
        orphanVariants.push(ecigOnlyVariant(row));
      }
      for (const row of bRows) {
        if (usedB.has(row.id)) continue;
        orphanVariants.push(vaperaliaOnlyVariant(row));
      }
    }
    products.push({
      ...product,
      status: "base_match",
      sourceDataset: "reviewed-rescues",
      sourceDatasetLabel: "Emparejamientos IA no determinista",
      reviewLayer: {
        sourceDataset: review.sourceDataset,
        reviewedAt: review.reviewedAt,
        reviewer: review.reviewer,
        basis: review.basis,
      },
      variants: [...acceptedVariants, ...orphanVariants]
        .sort((left, right) => (right.finalConfidence || 0) - (left.finalConfidence || 0)),
    });
  }

  if (missing.length) {
    throw new Error(`Faltan decisiones para ${missing.length} variantes:\n${missing.join("\n")}`);
  }

  const flatVariants = products.flatMap((product) => product.variants.map((variant) => ({
    product: {
      eciglogistica: product.eciglogistica.title,
      vaperalia: product.vaperalia.title,
    },
    ...variant,
  })));
  const flatMatches = flatVariants.filter((variant) => variant.status === "valid" || variant.status === "probable");
  const flatDiscardedVariants = flatVariants.filter((variant) => variant.status !== "valid" && variant.status !== "probable");
  const flatEcigOnlyVariants = flatVariants.filter((variant) => variant.status === "ecig_only");
  const flatVaperaliaOnlyVariants = flatVariants.filter((variant) => variant.status === "vaperalia_only");
  const output = {
    generatedAt: new Date().toISOString(),
    sideLabels: rescue.sideLabels,
    source: {
      pipeline: "reviewed-rescues",
      rescueDataset: args.rescue,
      decisions: args.decisions,
      note: "Capa de revision semantica no determinista sobre rescates probables.",
    },
    reviewPolicy: {
      note: "Solo se publican como validas las variantes aceptadas explicitamente en el ledger de revision.",
      acceptedStatus: "valid",
    },
    summary: buildSummary(products, rejectedDecisions.length),
    products,
    flatMatches,
    flatDiscardedVariants,
    flatEcigOnlyVariants,
    flatVaperaliaOnlyVariants,
    discardedBaseMatches: [],
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  writeAuditMd(args.auditMd, output, rejectedDecisions);
  console.log(JSON.stringify(output.summary, null, 2));
  console.log(`Dataset: ${args.out}`);
  console.log(`Auditoria: ${args.auditMd}`);
}

main();
