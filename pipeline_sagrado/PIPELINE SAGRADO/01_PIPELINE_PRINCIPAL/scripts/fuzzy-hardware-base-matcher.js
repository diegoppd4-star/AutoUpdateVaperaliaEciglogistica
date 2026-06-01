const fs = require("fs");
const path = require("path");
const { getTargetBrands, parseBrandList } = require("./brand-aliases");

function parseArgs(argv) {
  const args = {};
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
  if (!args.a || !args.b || !args.out || args.brand == null || !args.productType) {
    throw new Error(
      "Uso: node scripts/fuzzy-hardware-base-matcher.js --a a.base.csv --b b.base.csv --out matches.csv --brand Voopoo --product-type pod_replacement",
    );
  }
  const explicitBBrand = Boolean(args.bBrand);
  args.aBrand = args.aBrand || args.brand;
  args.aBrands = parseBrandList(args.aBrand);
  args.bBrands = explicitBBrand ? parseBrandList(args.bBrand) : getTargetBrands(args.aBrand, args.productType, "ecig", "vaperalia");
  args.bBrand = args.bBrands.join("|");
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

function writeCsv(filePath, rows) {
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
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((header) => csvEscape(row[header])).join(","));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `\uFEFF${lines.join("\n")}\n`, "utf8");
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

function rowBrandCompacts(row) {
  return new Set(rowBrandValues(row).map(compact).filter(Boolean));
}

function rowText(row) {
  return normalize([
    row.title,
    row.description,
    row.brandCandidates,
    row.commercialBrand,
    row.productLine,
    row.breadcrumbPath,
    row.metaDescription,
    row.reference,
    row.syntheticReference,
    row.baseKey,
    row.url,
    row.variantValues,
  ].join(" "));
}

function primaryText(row) {
  return normalize([
    row.title,
    row.brandCandidates,
    row.commercialBrand,
    row.productLine,
    row.breadcrumbPath,
    row.reference,
    row.syntheticReference,
    row.baseKey,
    row.url,
    row.variantValues,
  ].join(" "));
}

function extractCapacities(value) {
  const text = normalize(value);
  const values = new Set();
  const regex = /\b(\d+(?:[.,]\d+)?)\s*ml\b/g;
  let match;
  while ((match = regex.exec(text))) values.add(String(Number(match[1].replace(",", "."))));
  return values;
}

function extractPacks(value) {
  const text = normalize(value);
  const values = new Set();
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

function hasConflict(left, right) {
  return left.size > 0 && right.size > 0 && !intersects(left, right);
}

function subtype(row, productType) {
  const text = primaryText(row);
  const ref = normalize(row.reference || row.syntheticReference || row.baseKey);
  const startsAsCoil = /^r[-.\s]/.test(ref) || /^\s*resistencia(?:s)?\b/.test(text);
  const hasPodWord = /\b(pod|cartucho|cartridge)\b/.test(text);
  const hasTipWord = /\b(boquilla|boquillas|drip\s*tip|filter\s*tips?|filtro|algodon|pom)\b/.test(text);
  const hasAdapter = /\b(adaptador|adapter)\b/.test(text);
  const hasRba = /\brba\b/.test(text);

  if (productType === "coil") {
    if (hasAdapter) return "adapter";
    if (hasRba) return "rba";
    return "coil";
  }
  if (productType === "pod_replacement") {
    if (startsAsCoil) return "coil";
    if (hasAdapter) return "adapter";
    if (hasTipWord && !hasPodWord) return "tip";
    return "pod";
  }
  if (productType === "pyrex") return "pyrex";
  if (productType === "battery_charger") return "battery_charger";
  return productType;
}

function isCoilLike(row) {
  const text = primaryText(row);
  const ref = normalize(row.reference || row.syntheticReference || row.baseKey);
  const startsAsCoil = /^r[-.\s]/.test(ref) || /^\s*resistencia(?:s)?\b/.test(text);
  const titleHasCoil = /\bcoil(?:s)?\b/.test(text);
  const looksLikePodReplacement =
    /\bpod\b/.test(text) && /\b(replacement|recambio|cartucho|cartridge)\b/.test(text) && !titleHasCoil && !startsAsCoil;
  return startsAsCoil || titleHasCoil || (row.productType === "coil" && !looksLikePodReplacement);
}

function includeRow(row, brands, productType) {
  const allowedBrands = new Set(parseBrandList(brands).map(compact));
  if (![...rowBrandCompacts(row)].some((brand) => allowedBrands.has(brand))) return false;
  if (productType === "coil") return isCoilLike(row);
  if (productType === "pod_replacement") return row.productType === "pod_replacement" && subtype(row, productType) !== "coil";
  if (productType === "pyrex") return row.productType === "pyrex";
  if (productType === "aroma_concentrate") {
    if (row.productType !== "aroma_concentrate") return false;
    const text = primaryText(row);
    if (/\b(nicokit|niko|nicotina|nicotine|base\s*(pack|glicerina|pdo|propilenglicol)|glicerina|propilenglicol)\b/.test(text)) {
      return false;
    }
    return true;
  }
  return row.productType === productType;
}

const GENERIC = new Set([
  "a",
  "al",
  "and",
  "aroma",
  "aromas",
  "bote",
  "by",
  "capacidad",
  "com",
  "cartucho",
  "cartridge",
  "coil",
  "coils",
  "con",
  "de",
  "del",
  "deposito",
  "dl",
  "dla",
  "eciglogistica",
  "el",
  "empty",
  "en",
  "es",
  "fill",
  "for",
  "fruit",
  "full",
  "fum",
  "glass",
  "html",
  "http",
  "https",
  "incluida",
  "incluido",
  "kit",
  "la",
  "las",
  "los",
  "longfill",
  "concentrado",
  "concentrate",
  "edition",
  "limited",
  "mesh",
  "meshed",
  "ml",
  "moon",
  "new",
  "no",
  "nuevo",
  "nueva",
  "ohm",
  "ohmios",
  "mao",
  "o4v",
  "apv",
  "pack",
  "packs",
  "para",
  "pc",
  "pcs",
  "pod",
  "pods",
  "pyrex",
  "recambio",
  "replacement",
  "repuesto",
  "resistencia",
  "resistencias",
  "serie",
  "series",
  "sin",
  "tank",
  "updated",
  "vaperalia",
  "vpm",
  "version",
  "vacio",
  "vacia",
  "bar",
  "with",
  "wonder",
  "y",
]);

function tokenise(row, brands) {
  const brandTokens = new Set(
    [...parseBrandList(brands), ...rowBrandValues(row)]
      .flatMap((brand) => normalize(brand).replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean)),
  );
  const text = normalize([
    row.title,
    row.reference,
    row.syntheticReference,
    row.url,
  ].join(" "))
    .replace(/\b(\d+)[.,](\d+)\s*ml\b/g, " ")
    .replace(/\b\d+(?:[.,]\d+)?\s*ohm\b/g, " ")
    .replace(/\b\d+\s*(?:ml|mah|w|pcs|pc|pzs|unidades)\b/g, " ")
    .replace(/\bpack\s*(?:de\s*)?\d+\b/g, " ");
  const rawTokens = text.replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean);
  const tokens = [];

  for (let token of rawTokens) {
    if (token === "bleu") token = "blue";
    if (token === "colour") token = "color";
    if (token === "cartridges") token = "cartridge";
    if (token === "berries") token = "berry";
    if (token === "grapes") token = "grape";
    if (token === "fruits") token = "fruit";
    if (token === "slices") token = "slice";
    if (token === "resistances") token = "resistencia";
    if (token === "tips") token = "tip";
    if (token === "ii") token = "2";
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
    tokens.push(token);
  }

  return [...new Set(tokens)];
}

function tokenWeight(token) {
  if (["dtl", "ez", "mtl", "rba", "ss"].includes(token)) return 1.45;
  if (/\d/.test(token)) return 1.4;
  if (token.length <= 2) return 0.75;
  return 1;
}

function weightedSum(tokens) {
  return tokens.reduce((sum, token) => sum + tokenWeight(token), 0);
}

function versionTokens(tokens) {
  return new Set(tokens.filter((token) => /^v\d+[a-z]?$/.test(token)));
}

function hasVersionConflict(aTokens, bTokens) {
  const aVersions = versionTokens(aTokens);
  const bVersions = versionTokens(bTokens);
  return hasConflict(aVersions, bVersions);
}

function hasDirectionalConflict(aTokens, bTokens) {
  const groups = [
    ["top", "side"],
    ["dtl", "mtl"],
    ["regular", "pro"],
  ];
  for (const group of groups) {
    const a = group.filter((token) => aTokens.includes(token));
    const b = group.filter((token) => bTokens.includes(token));
    if (a.length && b.length && !a.some((token) => b.includes(token))) return true;
  }
  return false;
}

function formatFlags(row) {
  const text = primaryText(row);
  return {
    salt: /\b(salt|salts|nicotine\s*salt|sales)\b/.test(text),
  };
}

function hasAnchor(common) {
  return common.some((token) => token.length >= 3 || /\d/.test(token));
}

function scorePair(aRow, bRow, args) {
  const aSubtype = subtype(aRow, args.productType);
  const bSubtype = subtype(bRow, args.productType);
  if (aSubtype !== bSubtype) return { score: 0, reason: `subtipo distinto A=${aSubtype} B=${bSubtype}` };

  const aCaps = extractCapacities(primaryText(aRow));
  const bCaps = extractCapacities(primaryText(bRow));
  if (hasConflict(aCaps, bCaps)) {
    return { score: 0, reason: `capacidad distinta A=${[...aCaps].join("/")}ml B=${[...bCaps].join("/")}ml` };
  }

  const aFormats = formatFlags(aRow);
  const bFormats = formatFlags(bRow);
  if (args.productType === "aroma_concentrate" && aFormats.salt !== bFormats.salt) {
    return { score: 0, reason: "formato salt distinto" };
  }

  const aPacks = extractPacks(primaryText(aRow));
  const bPacks = extractPacks(primaryText(bRow));
  if (hasConflict(aPacks, bPacks)) {
    return { score: 0, reason: `pack distinto A=${[...aPacks].join("/")} B=${[...bPacks].join("/")}` };
  }

  const aBaseKey = compact(aRow.baseKey || aRow.syntheticReference || aRow.reference);
  const bBaseKey = compact(bRow.baseKey || bRow.syntheticReference || bRow.reference);
  if (aBaseKey && bBaseKey && aBaseKey === bBaseKey) {
    return { score: 1, reason: `baseKey/referencia igual ${aRow.baseKey || aRow.syntheticReference || aRow.reference}` };
  }

  const aTokens = tokenise(aRow, args.aBrand);
  const bTokens = tokenise(bRow, args.bBrand);
  if (hasVersionConflict(aTokens, bTokens)) return { score: 0, reason: `version distinta` };
  if (hasDirectionalConflict(aTokens, bTokens)) return { score: 0, reason: `terminos direccionales incompatibles` };

  const common = aTokens.filter((token) => bTokens.includes(token));
  if (!hasAnchor(common)) return { score: 0, reason: `sin ancla comun suficiente` };
  if (args.productType === "aroma_concentrate" && common.length < 2) {
    const extraA = aTokens.filter((token) => !common.includes(token));
    const extraB = bTokens.filter((token) => !common.includes(token));
    if (extraA.length || extraB.length) {
      return { score: 0, reason: `sabor ambiguo por tokens extra A=${extraA.join("+")} B=${extraB.join("+")}` };
    }
  }
  if (args.productType === "aroma_concentrate") {
    const extraA = aTokens.filter((token) => !common.includes(token));
    const extraB = bTokens.filter((token) => !common.includes(token));
    if (extraA.length || extraB.length) {
      return { score: 0, reason: `sabor/edicion distinto por tokens extra A=${extraA.join("+")} B=${extraB.join("+")}` };
    }
  }

  const union = [...new Set([...aTokens, ...bTokens])];
  const commonWeight = weightedSum(common);
  const aWeight = weightedSum(aTokens);
  const bWeight = weightedSum(bTokens);
  const unionWeight = weightedSum(union);
  const jaccard = unionWeight ? commonWeight / unionWeight : 0;
  const containment = Math.max(commonWeight / aWeight, commonWeight / bWeight);
  const aCompact = aTokens.join("");
  const bCompact = bTokens.join("");
  const contains = aCompact && bCompact && (aCompact.includes(bCompact) || bCompact.includes(aCompact));
  const refA = compact(aRow.reference || aRow.syntheticReference || aRow.baseKey);
  const refB = compact(bRow.reference || bRow.syntheticReference || bRow.baseKey);
  const refCompatible = refA && refB && (refA.includes(refB) || refB.includes(refA));

  let score = 0.62 * jaccard + 0.28 * containment + (contains ? 0.08 : 0) + (refCompatible ? 0.05 : 0);
  if (common.length >= 2 && commonWeight / Math.min(aWeight, bWeight) >= 0.68) {
    score = Math.max(score, 0.72);
  }
  if (aCaps.size && bCaps.size && intersects(aCaps, bCaps)) score += 0.03;
  if (aPacks.size && bPacks.size && intersects(aPacks, bPacks)) score += 0.02;
  score = Math.min(1, score);

  return {
    score,
    reason: `tokens comunes ${common.join("+")}; subtipo ${aSubtype}; jaccard ${jaccard.toFixed(2)}; cobertura ${containment.toFixed(2)}`,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const productsA = parseCsv(fs.readFileSync(args.a, "utf8")).filter((row) => includeRow(row, args.aBrand, args.productType));
  const productsB = parseCsv(fs.readFileSync(args.b, "utf8")).filter((row) => includeRow(row, args.bBrand, args.productType));
  const threshold = Number(args.threshold || 0.72);
  const rows = [];

  for (const productA of productsA) {
    const candidates = productsB
      .map((productB) => ({ productB, ...scorePair(productA, productB, args) }))
      .filter((candidate) => candidate.score >= threshold)
      .sort((left, right) => right.score - left.score || String(left.productB.title).localeCompare(String(right.productB.title)));

    if (!candidates.length) {
      rows.push({
        product_a_id: productA.id,
        product_a_title: productA.title,
        decision: "no_match",
        best_match_b_id: "",
        best_match_b_title: "",
        confidence: 0,
        reason: `Sin candidato fuzzy aceptado por tokens/modelo dentro de ${args.aBrand} -> ${args.bBrand} + ${args.productType}.`,
        alternatives: "",
      });
      continue;
    }

    const best = candidates[0];
    rows.push({
      product_a_id: productA.id,
      product_a_title: productA.title,
      decision: "match",
      best_match_b_id: best.productB.id,
      best_match_b_title: best.productB.title,
      confidence: best.score.toFixed(2),
      reason: `Match fuzzy hardware. ${best.reason}.`,
      alternatives: candidates.slice(1, 6).map((candidate) => `${candidate.productB.id}:${candidate.score.toFixed(2)}`).join("|"),
    });
  }

  writeCsv(args.out, rows);
  console.log(`Productos A: ${productsA.length}`);
  console.log(`Productos B: ${productsB.length}`);
  console.log(`Matches: ${rows.filter((row) => row.decision === "match").length}`);
  console.log(`No match: ${rows.filter((row) => row.decision !== "match").length}`);
  console.log(`Archivo: ${args.out}`);
}

main();
