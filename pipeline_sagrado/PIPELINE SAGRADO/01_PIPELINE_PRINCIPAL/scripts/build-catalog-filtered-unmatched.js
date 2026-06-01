const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    aBase: "outputs/prepared/eciglogistica__output.base.csv",
    datasetsDir: "outputs",
    out: "outputs/catalog-filtered-unmatched.matches.valid.json",
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

function datasetFiles(dir) {
  const excluded = new Set([
    "catalog-filtered-unmatched.matches.valid.json",
    "general.matches.valid.json",
    "inverse-vaperalia-audit.matches.valid.json",
  ]);
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith(".matches.valid.json"))
    .filter((file) => !excluded.has(file));
}

function coveredEcigIds(dir) {
  const covered = new Set();
  for (const file of datasetFiles(dir)) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    for (const product of data.products || []) {
      if (product.eciglogistica?.productId) covered.add(product.eciglogistica.productId);
    }
    for (const product of data.discardedBaseMatches || []) {
      if (product.eciglogistica?.productId) covered.add(product.eciglogistica.productId);
    }
  }
  return covered;
}

function productSide(row) {
  return {
    productId: row.id,
    title: row.title || "",
    url: row.url || "",
    brand: row.brand || "",
    productType: row.productType || "",
  };
}

function main() {
  const args = parseArgs(process.argv);
  const baseRows = parseCsv(fs.readFileSync(args.aBase, "utf8"));
  const covered = coveredEcigIds(args.datasetsDir);
  const missingRows = baseRows.filter((row) => !covered.has(row.id));
  const discardedBaseMatches = missingRows.map((row) => ({
    status: "base_no_match",
    baseDecision: "no_match",
    baseConfidence: 0,
    reason: "Producto excluido de tramos normales por filtros de seguridad o sin tramo efectivo; queda contabilizado como pendiente sin candidato aceptado.",
    eciglogistica: productSide(row),
    vaperalia: {
      productId: "",
      title: "",
      url: "",
      brand: "",
      productType: "",
    },
    variants: [],
  }));

  const output = {
    generatedAt: new Date().toISOString(),
    sideLabels: {
      left: "Eciglogistica",
      right: "Vaperalia",
    },
    source: {
      aBase: path.resolve(args.aBase),
      datasetsDir: path.resolve(args.datasetsDir),
      note: "Cubre bases Ecig no emitidas por ningun tramo ni rescate.",
    },
    confidencePolicy: {
      note: "Dataset de cobertura, no acepta matches.",
    },
    summary: {
      baseRows: discardedBaseMatches.length,
      baseMatchesKept: 0,
      baseProductsVisible: 0,
      validVariants: 0,
      probableVariants: 0,
      totalVariantsKept: 0,
      totalVariantsVisible: 0,
      discardedVariantsVisible: 0,
      ecigOnlyVariants: 0,
      vaperaliaOnlyVariants: 0,
      discardedBaseMatches: discardedBaseMatches.length,
      discarded: {
        impossible: 0,
        discarded_low_confidence: 0,
        ecig_only: 0,
        vaperalia_only: 0,
        baseNoMatch: discardedBaseMatches.length,
        variantRowsTotal: 0,
      },
    },
    products: [],
    flatMatches: [],
    flatDiscardedVariants: [],
    flatEcigOnlyVariants: [],
    flatVaperaliaOnlyVariants: [],
    discardedBaseMatches,
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ missing: missingRows.length }, null, 2));
  console.log(`Archivo: ${args.out}`);
}

main();
