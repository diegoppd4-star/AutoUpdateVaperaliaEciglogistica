const fs = require("fs");
const path = require("path");
const { getTargetBrands } = require("./brand-aliases");

function parseArgs(argv) {
  const args = {
    aBase: "outputs/prepared/vaperalia__output.base.csv",
    bBase: "outputs/prepared/eciglogistica__output.base.csv",
    datasetsDir: "outputs",
    outBaseCsv: "outputs/base-matches-output.inverse-vaperalia-audit.csv",
    outJson: "outputs/inverse-vaperalia-audit.candidates.json",
    outMd: "outputs/inverse-vaperalia-audit.candidates.md",
    threshold: 0.88,
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
    args[name] = ["threshold"].includes(name) ? Number(value) : value;
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

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, "\"\"")}"`;
  return text;
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bii\b/g, "2")
    .replace(/\biii\b/g, "3")
    .replace(/\biv\b/g, "4")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value) {
  return normalize(value).replace(/[^a-z0-9]+/g, "");
}

function rowBrandValues(row) {
  return [
    row.brand,
    row.brandCandidates,
    row.commercialBrand,
  ].join("|").split(/[|,]/).map((value) => value.trim()).filter(Boolean);
}

function rowBrandKeys(row) {
  return new Set(rowBrandValues(row).map(compact).filter(Boolean));
}

function targetBrandKeys(row, from, to) {
  const keys = new Set();
  for (const brand of rowBrandValues(row)) {
    for (const target of getTargetBrands(brand, row.productType, from, to)) keys.add(compact(target));
  }
  return keys;
}

function uniqueRows(rows) {
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const key = row.id || `${row.title}|${row.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

function baseIdFromVariantId(id) {
  if (!id) return "";
  const marker = ":HTTPS";
  const markerIndex = id.indexOf(marker);
  if (markerIndex < 0) return id.split(":").slice(0, 2).join(":");
  const afterUrl = id.indexOf(":", markerIndex + marker.length);
  return afterUrl > 0 ? id.slice(0, afterUrl) : id;
}

function readDatasets(dir) {
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith(".matches.valid.json"))
    .filter((file) => !file.startsWith("inverse-"))
    .filter((file) => file !== "general.matches.valid.json")
    .map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")));
}

function coveredVaperaliaBaseIds(datasets, vaperaliaBaseIds) {
  const covered = new Set();
  for (const data of datasets) {
    for (const product of data.products || []) {
      const productId = product.vaperalia?.productId || "";
      if (vaperaliaBaseIds.has(productId)) covered.add(productId);
      for (const variant of product.variants || []) {
        const baseId = baseIdFromVariantId(variant.vaperalia?.variantId || "");
        if (vaperaliaBaseIds.has(baseId)) covered.add(baseId);
      }
    }
  }
  return covered;
}

function typeGroup(type) {
  if (["pod_replacement", "coil", "pyrex", "atomizer_tank"].includes(type)) return "hardware_repuesto";
  if (["kit_device", "mod_device"].includes(type)) return "hardware_dispositivo";
  if (["aroma_concentrate", "eliquid", "nicotine_salt", "base_booster"].includes(type)) return "liquidos";
  return type || "unknown";
}

const GENERIC = new Set([
  "a", "al", "and", "aroma", "aromas", "base", "bar", "bote", "by", "capacidad",
  "cartucho", "cartridge", "coil", "coils", "com", "con", "de", "del", "deposito",
  "eciglogistica", "edition", "el", "empty", "en", "es", "fill", "for", "full",
  "glass", "html", "http", "https", "incluida", "incluido", "juice", "kit", "la",
  "las", "limited", "liquid", "liquids", "longfill", "los", "mesh", "meshed", "ml",
  "new", "nic", "nicokit", "no", "nuevo", "nueva", "ohm", "ohmios", "pack", "packs",
  "para", "pc", "pcs", "pod", "pods", "pyrex", "recambio", "replacement", "repuesto",
  "resistencia", "resistencias", "salt", "salts", "serie", "series", "sin", "tank",
  "updated", "vaperalia", "version", "vpm", "vacio", "vacia", "with", "y",
  "black", "blue", "brown", "gold", "gray", "grey", "green", "orange", "pink",
  "purple", "rainbow", "red", "silver", "violet", "white", "yellow",
]);

function rowText(row) {
  return normalize([
    row.title,
    row.brandCandidates,
    row.commercialBrand,
    row.reference,
    row.syntheticReference,
    row.baseKey,
    row.url,
  ].join(" "));
}

function tokens(row, extraBrandKeys = []) {
  const brandTokens = new Set([
    ...rowBrandValues(row).flatMap((brand) => normalize(brand).replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean)),
    ...extraBrandKeys.flatMap((brand) => normalize(brand).replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean)),
  ]);
  const text = rowText(row)
    .replace(/\b(\d+)[.,](\d+)\s*ml\b/g, " ")
    .replace(/\b\d+(?:[.,]\d+)?\s*ohm\b/g, " ")
    .replace(/\b\d+\s*(?:ml|mah|w|pcs|pc|pzs|unidades)\b/g, " ")
    .replace(/\bpack\s*(?:de\s*)?\d+\b/g, " ");
  const raw = text.replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean);
  const out = [];
  for (let token of raw) {
    if (token === "bleu") token = "blue";
    if (token === "berries") token = "berry";
    if (token === "grapes") token = "grape";
    if (token === "fruits") token = "fruit";
    if (token === "slices") token = "slice";
    if (brandTokens.has(token) || GENERIC.has(token)) continue;
    if (/^p\d+$/.test(token)) continue;
    if (/^\d+b$/.test(token)) continue;
    if (/\d+ml/.test(token)) continue;
    if (/^\d+$/.test(token)) {
      const numberIsModelSignal = ["kit_device", "mod_device", "pod_replacement", "atomizer_tank", "pyrex"].includes(row.productType)
        && token.length === 1;
      if (!numberIsModelSignal) continue;
    }
    if (token.length === 1 && !/\d/.test(token) && !["g", "j", "m", "n", "q", "s", "t", "x"].includes(token)) continue;
    out.push(token);
  }
  return [...new Set(out)];
}

function numberSet(value, unit) {
  const regex = unit === "ohm"
    ? /(\d+(?:[.,]\d+)?)\s*(?:ohm|Î©)/gi
    : /(\d+(?:[.,]\d+)?)\s*ml/gi;
  return new Set([...String(value || "").matchAll(regex)].map((match) => {
    const n = Number(match[1].replace(",", "."));
    return Number.isFinite(n) ? String(n) : "";
  }).filter(Boolean));
}

function packSet(value) {
  const values = new Set();
  const text = normalize(value);
  const regexes = [
    /\bpack\s*(?:de\s*)?(\d+)\b/g,
    /\b(\d+)\s*(?:pcs|pc|pzs|unidades)\b/g,
    /(?:^|[\s.-])p(\d+)(?:$|[\s.-])/g,
  ];
  for (const regex of regexes) {
    let match;
    while ((match = regex.exec(text))) values.add(String(Number(match[1])));
  }
  return values;
}

function intersects(left, right) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function conflicts(left, right) {
  return left.size > 0 && right.size > 0 && !intersects(left, right);
}

function tokenWeight(token) {
  if (["dtl", "ez", "mtl", "rba", "ss"].includes(token)) return 1.45;
  if (/\d/.test(token)) return 1.4;
  if (token.length <= 2) return 0.75;
  return 1;
}

function sum(tokenList) {
  return tokenList.reduce((acc, token) => acc + tokenWeight(token), 0);
}

function scorePair(a, b) {
  const aKeys = rowBrandKeys(a);
  const bKeys = rowBrandKeys(b);
  const allowedTargetBrands = targetBrandKeys(a, "vaperalia", "ecig");
  if (aKeys.size && ![...bKeys].some((key) => allowedTargetBrands.has(key))) return { score: 0, reason: "marca distinta" };
  if (!aKeys.size && bKeys.size) return { score: 0, reason: "marca ausente en Vaperalia" };

  const aPromo = /\b(promo|promopack|2x1)\b/i.test(a.title);
  const bPromo = /\b(promo|promopack|2x1)\b/i.test(b.title);
  if (aPromo !== bPromo) return { score: 0, reason: "promopack/2x1 solo en un lado" };

  if (typeGroup(a.productType) !== typeGroup(b.productType) && a.productType !== b.productType) {
    return { score: 0, reason: `grupo de tipo distinto A=${a.productType} B=${b.productType}` };
  }

  if (compact(a.baseKey) && compact(a.baseKey) === compact(b.baseKey)) {
    return { score: 1, reason: `baseKey/referencia igual ${a.baseKey}` };
  }

  const aMl = numberSet(rowText(a), "ml");
  const bMl = numberSet(rowText(b), "ml");
  if (conflicts(aMl, bMl)) return { score: 0, reason: `ml distinto A=${[...aMl].join("/")} B=${[...bMl].join("/")}` };

  const aOhm = numberSet(rowText(a), "ohm");
  const bOhm = numberSet(rowText(b), "ohm");
  if (conflicts(aOhm, bOhm)) return { score: 0, reason: `ohm distinto A=${[...aOhm].join("/")} B=${[...bOhm].join("/")}` };

  const aPack = packSet(rowText(a));
  const bPack = packSet(rowText(b));
  if (conflicts(aPack, bPack)) return { score: 0, reason: `pack distinto A=${[...aPack].join("/")} B=${[...bPack].join("/")}` };

  const aTokens = tokens(a, rowBrandValues(b));
  const bTokens = tokens(b, rowBrandValues(a));
  const common = aTokens.filter((token) => bTokens.includes(token));
  if (!common.some((token) => token.length >= 3 || /\d/.test(token))) return { score: 0, reason: "sin ancla comun" };

  if (typeGroup(a.productType) === "liquidos" && common.length < 2) {
    return { score: 0, reason: `liquido/aroma con sabor ambiguo por tokens comunes ${common.join("+")}` };
  }
  if (a.productType === "aroma_concentrate" || b.productType === "aroma_concentrate") {
    const extraA = aTokens.filter((token) => !common.includes(token));
    const extraB = bTokens.filter((token) => !common.includes(token));
    if (extraA.length || extraB.length) {
      return { score: 0, reason: `sabor/edicion distinto por tokens extra A=${extraA.join("+")} B=${extraB.join("+")}` };
    }
  }

  const union = [...new Set([...aTokens, ...bTokens])];
  const commonWeight = sum(common);
  const jaccard = commonWeight / sum(union);
  const containment = Math.max(commonWeight / sum(aTokens), commonWeight / sum(bTokens));
  const sameTypeBonus = a.productType === b.productType ? 0.08 : 0;
  let value = 0.62 * jaccard + 0.3 * containment + sameTypeBonus;
  if (aMl.size && bMl.size && intersects(aMl, bMl)) value += 0.03;
  if (aOhm.size && bOhm.size && intersects(aOhm, bOhm)) value += 0.03;
  if (aPack.size && bPack.size && intersects(aPack, bPack)) value += 0.02;
  const scoreValue = Math.min(1, Math.round(value * 100) / 100);
  return {
    score: scoreValue,
    reason: `tokens ${common.join("+")}; jaccard ${jaccard.toFixed(2)}; cobertura ${containment.toFixed(2)}; tipos ${a.productType}/${b.productType}`,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const vaperaliaBases = parseCsv(fs.readFileSync(args.aBase, "utf8"));
  const ecigBases = parseCsv(fs.readFileSync(args.bBase, "utf8"));
  const vaperaliaBaseIds = new Set(vaperaliaBases.map((row) => row.id));
  const covered = coveredVaperaliaBaseIds(readDatasets(args.datasetsDir), vaperaliaBaseIds);
  const uncovered = vaperaliaBases.filter((row) => !covered.has(row.id));

  const ecigByBrand = new Map();
  for (const row of ecigBases) {
    for (const key of rowBrandKeys(row)) {
      if (!ecigByBrand.has(key)) ecigByBrand.set(key, []);
      ecigByBrand.get(key).push(row);
    }
  }

  const rows = [];
  const candidatesReport = [];
  for (const source of uncovered) {
    const brandCandidates = uniqueRows([...targetBrandKeys(source, "vaperalia", "ecig")].flatMap((key) => ecigByBrand.get(key) || []));
    const candidates = brandCandidates
      .map((target) => ({ target, ...scorePair(source, target) }))
      .filter((candidate) => candidate.score >= args.threshold)
      .sort((left, right) => right.score - left.score || left.target.title.localeCompare(right.target.title));

    if (!candidates.length) {
      rows.push({
        product_a_id: source.id,
        product_a_title: source.title,
        decision: "no_match",
        best_match_b_id: "",
        best_match_b_title: "",
        confidence: 0,
        reason: "Auditoria inversa: sin candidato Ecig aceptado para esta base Vaperalia no cubierta.",
        alternatives: "",
      });
      continue;
    }

    const best = candidates[0];
    rows.push({
      product_a_id: source.id,
      product_a_title: source.title,
      decision: "match",
      best_match_b_id: best.target.id,
      best_match_b_title: best.target.title,
      confidence: best.score,
      reason: `Auditoria inversa Vaperalia->Ecig. ${best.reason}.`,
      alternatives: candidates.slice(1, 6).map((candidate) => `${candidate.target.id}:${candidate.score}`).join("|"),
    });
    candidatesReport.push({
      vaperalia: {
        id: source.id,
        title: source.title,
        url: source.url,
        brand: source.brand,
        productType: source.productType,
      },
      candidates: candidates.slice(0, 5).map((candidate) => ({
        confidence: candidate.score,
        reason: candidate.reason,
        eciglogistica: {
          id: candidate.target.id,
          title: candidate.target.title,
          url: candidate.target.url,
          brand: candidate.target.brand,
          productType: candidate.target.productType,
        },
      })),
    });
  }

  const headers = [
    "product_a_id",
    "product_a_title",
    "decision",
    "best_match_b_id",
    "best_match_b_title",
    "confidence",
    "reason",
    "alternatives",
  ];
  fs.mkdirSync(path.dirname(args.outBaseCsv), { recursive: true });
  fs.writeFileSync(args.outBaseCsv, `\uFEFF${[headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))].join("\n")}\n`, "utf8");

  const output = {
    generatedAt: new Date().toISOString(),
    threshold: args.threshold,
    summary: {
      vaperaliaBases: vaperaliaBases.length,
      alreadyCoveredBases: covered.size,
      uncoveredBasesReviewed: uncovered.length,
      baseMatches: rows.filter((row) => row.decision === "match").length,
      baseNoMatch: rows.filter((row) => row.decision !== "match").length,
      candidatePairs: candidatesReport.reduce((sum, item) => sum + item.candidates.length, 0),
    },
    results: candidatesReport,
  };
  fs.writeFileSync(args.outJson, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  const lines = [
    "# Auditoria inversa Vaperalia -> Eciglogistica",
    "",
    `Generado: ${output.generatedAt}`,
    "",
    `- Bases Vaperalia: ${output.summary.vaperaliaBases}`,
    `- Ya cubiertas: ${output.summary.alreadyCoveredBases}`,
    `- No cubiertas revisadas: ${output.summary.uncoveredBasesReviewed}`,
    `- Matches base candidatos: ${output.summary.baseMatches}`,
    `- Sin candidato aceptado: ${output.summary.baseNoMatch}`,
    `- Pares candidatos: ${output.summary.candidatePairs}`,
    "",
  ];
  for (const item of candidatesReport) {
    lines.push(`## ${item.vaperalia.title}`);
    lines.push("");
    lines.push(`Vaperalia: ${item.vaperalia.url}`);
    lines.push("");
    for (const candidate of item.candidates) {
      lines.push(`- ${candidate.confidence} | ${candidate.eciglogistica.title}`);
      lines.push(`  - ${candidate.eciglogistica.url}`);
      lines.push(`  - ${candidate.reason}`);
    }
    lines.push("");
  }
  fs.writeFileSync(args.outMd, `${lines.join("\n")}\n`, "utf8");

  console.log(JSON.stringify(output.summary, null, 2));
  console.log(`Base CSV: ${args.outBaseCsv}`);
  console.log(`JSON: ${args.outJson}`);
  console.log(`MD: ${args.outMd}`);
}

main();
