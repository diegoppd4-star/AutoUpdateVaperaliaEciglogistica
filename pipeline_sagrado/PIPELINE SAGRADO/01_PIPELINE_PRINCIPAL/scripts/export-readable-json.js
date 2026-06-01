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
  if (!args.baseMatches || !args.variantMatches || !args.out) {
    throw new Error("Uso: node scripts/export-readable-json.js --base-matches base.csv --variant-matches variants.csv --out output.json");
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

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}

function cleanObject(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== "" && value != null));
}

function main() {
  const args = parseArgs(process.argv);
  const baseRows = loadCsv(args.baseMatches);
  const variantRows = loadCsv(args.variantMatches);
  const variantsByBasePair = new Map();

  for (const row of variantRows) {
    const key = `${row.base_match_a_id}|||${row.base_match_b_id}`;
    if (!variantsByBasePair.has(key)) variantsByBasePair.set(key, []);
    variantsByBasePair.get(key).push(cleanObject({
      decision: row.variant_decision,
      confidence: asNumber(row.variant_confidence),
      reason: row.reason,
      eciglogistica: {
        variantId: row.a_variant_id,
        title: row.a_title,
        url: row.a_url,
        variant: row.a_variant,
      },
      vaperalia: {
        variantId: row.b_variant_id,
        title: row.b_title,
        url: row.b_url,
        variant: row.b_variant,
      },
    }));
  }

  const matches = baseRows.map((row) => {
    const key = `${row.product_a_id}|||${row.best_match_b_id}`;
    return cleanObject({
      decision: row.decision,
      confidence: asNumber(row.confidence),
      reason: row.reason,
      alternatives: row.alternatives ? row.alternatives.split("|").filter(Boolean) : [],
      eciglogistica: {
        productId: row.product_a_id,
        title: row.product_a_title,
      },
      vaperalia: row.best_match_b_id
        ? {
            productId: row.best_match_b_id,
            title: row.best_match_b_title,
          }
        : null,
      variants: variantsByBasePair.get(key) || [],
    });
  });

  const output = {
    generatedAt: new Date().toISOString(),
    source: {
      baseMatches: path.resolve(args.baseMatches),
      variantMatches: path.resolve(args.variantMatches),
    },
    summary: {
      baseRows: matches.length,
      baseMatches: matches.filter((match) => match.decision === "match").length,
      basePossibleMatches: matches.filter((match) => match.decision === "possible_match").length,
      baseNoMatches: matches.filter((match) => match.decision === "no_match").length,
      variantRows: variantRows.length,
      variantMatches: variantRows.filter((row) => row.variant_decision === "variant_match").length,
      variantPossibleMatches: variantRows.filter((row) => row.variant_decision === "possible_variant_match").length,
      variantReview: variantRows.filter((row) => row.variant_decision === "review").length,
    },
    matches,
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Archivo: ${args.out}`);
}

main();
