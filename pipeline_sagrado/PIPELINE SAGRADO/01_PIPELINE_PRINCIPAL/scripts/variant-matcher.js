const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = { threshold: 0.72 };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2).replace(/-([a-z0-9])/g, (_, letter) => letter.toUpperCase());
    if (value == null || value.startsWith("--")) {
      args[name] = true;
      continue;
    }
    args[name] = ["threshold", "partialCapacityConfidence"].includes(name) ? Number(value) : value;
    i += 1;
  }
  if (!args.baseMatches || !args.aVariants || !args.bVariants || !args.out) {
    throw new Error("Uso: node scripts/variant-matcher.js --base-matches base.csv --a-variants a.variants.csv --b-variants b.variants.csv --out variants.csv");
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

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function writeCsv(filePath, rows) {
  const headers = [
    "base_match_a_id",
    "base_match_b_id",
    "a_variant_id",
    "a_title",
    "a_url",
    "a_variant",
    "b_variant_id",
    "b_title",
    "b_url",
    "b_variant",
    "variant_decision",
    "variant_confidence",
    "reason",
  ];
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((header) => csvEscape(row[header])).join(","));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `\uFEFF${lines.join("\n")}\n`, "utf8");
}

function loadCsv(filePath) {
  return parseCsv(fs.readFileSync(filePath, "utf8"));
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/colour/g, "color")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value) {
  return normalize(value)
    .replace(/\bartic\b/g, "arctic")
    .replace(/graffitti/g, "graffiti")
    .replace(/grey/g, "gray")
    .replace(/[^a-z0-9]+/g, "");
}

function tokens(value) {
  return normalize(value)
    .replace(/\bartic\b/g, "arctic")
    .replace(/graffitti/g, "graffiti")
    .replace(/grey/g, "gray")
    .split(/[^a-z0-9]+/g)
    .filter(Boolean)
    .filter((token) => !["and", "y", "de", "color", "oxva", "uwell", "vaporesso", "voopoo"].includes(token));
}

function parseVariants(row) {
  try {
    return row.variantsJson ? JSON.parse(row.variantsJson) : {};
  } catch {
    return {};
  }
}

function firstMatch(values, regex) {
  for (const value of values) {
    const match = String(value || "").match(regex);
    if (match) return match[1] || match[0];
  }
  return "";
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
  const text = normalize(source);
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

function liquidCapacityParts(row, parsed = {}) {
  const explicitContent = row.contenido_ml || parsed.contenido_ml || row.contenido || parsed.contenido || "";
  const explicitBottle = row.bote_ml || parsed.bote_ml || row.capacidad_bote || parsed.capacidad_bote || "";
  const result = {
    contenido_ml: explicitContent,
    bote_ml: explicitBottle,
  };
  if (!liquidProductType(row.productType)) return result;

  const source = normalize([
    row.variantLabel,
    row.capacidad,
    parsed.capacidad,
    row.title,
    row.baseTitle,
    row.url,
    row.description,
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
  const hasNicotine = liquidContainsNicotine(row.productType, source, compact(row.nicotina || parsed.nicotina));
  const contentNumber = mlNumber(result.contenido_ml);
  if (
    !result.bote_ml &&
    result.contenido_ml &&
    !isLongfill &&
    liquidCanContainNicotine(row.productType) &&
    (!hasNicotine || contentNumber == null || contentNumber <= 10)
  ) {
    result.bote_ml = result.contenido_ml;
  }
  enforceNicotineBottleLimit(result, hasNicotine);

  return result;
}

function derivePodType(row, parsed) {
  const explicit = row.pod_type || parsed.pod_type || "";
  if (explicit) return explicit;
  const text = [
    row.variantLabel,
    row.capacidad || parsed.capacidad,
    row.resistencia || parsed.resistencia,
    row.title,
    row.baseTitle,
    row.url,
  ].filter(Boolean).join(" ");
  const normalized = normalize(text);
  if (/\bdtl\b/.test(normalized)) return "DTL";
  if (/\bmtl\b/.test(normalized)) return "MTL";
  return "";
}

function deriveCapacity(row, parsed) {
  const explicit = row.capacidad || parsed.capacidad || "";
  if (explicit) return explicit;
  const capacityFromContextTypes = new Set([
    "pyrex",
    "atomizer_tank",
    "pod_replacement",
    "eliquid",
    "nicotine_salt",
    "aroma_concentrate",
    "base_booster",
    "disposable",
  ]);
  if (!capacityFromContextTypes.has(row.productType)) return "";
  const sources = [row.variantLabel, row.title, row.baseTitle, row.url];
  if (["pyrex", "atomizer_tank", "pod_replacement"].includes(row.productType)) {
    sources.splice(3, 0, row.reference, row.syntheticReference, row.sku, row.variantKey);
  }
  const value = firstMatch(sources, /(\d+(?:[.,]\d+)?)\s*ml/i);
  return value ? `${value.replace(",", ".")} ml` : "";
}

function contextModifiers(row) {
  const source = [row.variantLabel, row.title, row.baseTitle, row.reference, row.syntheticReference, row.url]
    .filter(Boolean)
    .join(" ");
  return [...modifierTokens(source)].join(" ");
}

function deriveResistance(row, parsed) {
  const explicit = row.resistencia || parsed.resistencia || "";
  if (explicit) {
    if (modifierTokens(explicit).size > 0) return explicit;
    const modifiers = contextModifiers(row);
    return modifiers ? `${explicit} ${modifiers}` : explicit;
  }
  const resistanceFromContextTypes = new Set(["coil", "pod_replacement"]);
  if (!resistanceFromContextTypes.has(row.productType)) return "";
  const text = [row.variantLabel, row.title, row.baseTitle, row.url].filter(Boolean).join(" ");
  const matches = [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:ohm|Ω)/gi)].map((match) => `${match[1].replace(",", ".")} ohm`);
  const value = [...new Set(matches)].join(" - ");
  const modifiers = contextModifiers(row);
  return [value, modifiers].filter(Boolean).join(" ");
}

function variantFields(row) {
  const parsed = parseVariants(row);
  const color = row.color || parsed.color || "";
  const referenceColor = row.reference_color || parsed.reference_color || "";
  const derivedReferenceColor = row.derived_reference_color || parsed.derived_reference_color || "";
  const liquidParts = liquidCapacityParts(row, parsed);
  return {
    color,
    reference_color: referenceColor,
    derived_reference_color: derivedReferenceColor,
    effective_color: referenceColor || derivedReferenceColor || color,
    pod_type: derivePodType(row, parsed),
    nicotina: row.nicotina || parsed.nicotina || "",
    capacidad: deriveCapacity(row, parsed),
    contenido_ml: liquidParts.contenido_ml,
    bote_ml: liquidParts.bote_ml,
    resistencia: deriveResistance(row, parsed),
    base_ratio: row.base_ratio || parsed.base_ratio || "",
    sabor: row.sabor || parsed.sabor || "",
    cafeina: row.cafeina || parsed.cafeina || "",
    tamano: row.tamano || parsed.tamano || "",
  };
}

function valueSimilarity(left, right) {
  const a = compact(left);
  const b = compact(right);
  if (!a && !b) return { score: 1, reason: "ambos vacios" };
  if (!a || !b) return { score: 0.35, reason: "valor ausente en un lado" };
  if (a === b) return { score: 1, reason: "igual" };
  const aTokens = tokens(left);
  const bTokens = tokens(right);
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  const intersection = aTokens.filter((token) => bSet.has(token));
  const union = new Set([...aTokens, ...bTokens]);
  const jaccard = union.size ? intersection.length / union.size : 0;
  const extraA = aTokens.filter((token) => !bSet.has(token));
  const extraB = bTokens.filter((token) => !aSet.has(token));
  const softModifiers = new Set(["dark", "light", "metal", "metallic"]);

  if (jaccard >= 0.8) return { score: 0.95, reason: "tokens casi equivalentes" };
  if (jaccard >= 0.66) return { score: 0.88, reason: "tokens compatibles fuertes" };
  if (jaccard >= 0.5) return { score: 0.72, reason: "tokens parcialmente compatibles" };
  if ((a.includes(b) || b.includes(a)) && [...extraA, ...extraB].every((token) => softModifiers.has(token))) {
    return { score: 0.86, reason: "contenido equivalente con modificador suave" };
  }
  if (a.includes(b) || b.includes(a)) return { score: 0.45, reason: "coincidencia parcial generica" };
  return { score: 0, reason: "distinto" };
}

function numericSet(value, unit) {
  const regex = unit === "ohm"
    ? /(\d+(?:[.,]\d+)?)\s*(?:ohm|Ω)/gi
    : /(\d+(?:[.,]\d+)?)\s*ml/gi;
  return new Set([...String(value || "").matchAll(regex)].map((match) => {
    const number = Number(match[1].replace(",", "."));
    return Number.isFinite(number) ? String(number) : "";
  }).filter(Boolean));
}

function numericSimilarity(left, right, unit, options = {}) {
  const aSet = numericSet(left, unit);
  const bSet = numericSet(right, unit);
  if (!aSet.size || !bSet.size) return null;
  const intersection = [...aSet].filter((value) => bSet.has(value));
  if (intersection.length === aSet.size && intersection.length === bSet.size) {
    return { score: 1, reason: `${unit} equivalente` };
  }
  if (intersection.length > 0) {
    return { score: options.partialIntersectionScore || 0.72, reason: `${unit} parcialmente compatible` };
  }
  return { score: 0, reason: `${unit} distinto` };
}

function modifierTokens(value) {
  return new Set(tokens(value).filter((token) =>
    ["mesh", "dual", "corex", "dtl", "mtl", "lush", "top", "fill"].includes(token)
  ));
}

function isExactly2ml(value) {
  const values = numericSet(value, "ml");
  return values.size === 1 && values.has("2");
}

function scoreField(field, a, b, args = {}) {
  if (["capacidad", "contenido_ml", "bote_ml"].includes(field)) {
    const hasA = Boolean(compact(a[field]));
    const hasB = Boolean(compact(b[field]));
    if (hasA !== hasB) {
      const presentValue = hasA ? a[field] : b[field];
      if (args.assumeMissingCapacity2ml && isExactly2ml(presentValue)) {
        return {
          score: 1,
          reason: `${field}: ${a[field] || "-"} vs ${b[field] || "-"} (2 ml asumido por estandar UE en este tramo)`,
        };
      }
      return {
        score: 0.35,
        reason: `${field}: ${a[field] || "-"} vs ${b[field] || "-"} (valor ausente en un lado)`,
      };
    }
    const numeric = numericSimilarity(a[field], b[field], "ml", {
      partialIntersectionScore: args.partialCapacityConfidence,
    });
    if (numeric) {
      return {
        score: numeric.score,
        reason: `${field}: ${a[field] || "-"} vs ${b[field] || "-"} (${numeric.reason})`,
      };
    }
  }

  if (field === "resistencia") {
    const numeric = numericSimilarity(a[field], b[field], "ohm");
    if (numeric) {
      const aModifiers = modifierTokens(a[field]);
      const bModifiers = modifierTokens(b[field]);
      const sharedModifiers = [...aModifiers].filter((token) => bModifiers.has(token));
      const hardModifierConflict =
        (aModifiers.has("corex") && bModifiers.has("dual")) ||
        (aModifiers.has("dual") && bModifiers.has("corex"));
      const modifierConflict = hardModifierConflict || (aModifiers.size && bModifiers.size && sharedModifiers.length === 0);
      const score = modifierConflict ? Math.min(numeric.score, 0.72) : numeric.score;
      const reason = modifierConflict ? `${numeric.reason}; modificadores distintos` : numeric.reason;
      return {
        score,
        reason: `${field}: ${a[field] || "-"} vs ${b[field] || "-"} (${reason})`,
      };
    }
  }

  const similarity = valueSimilarity(a[field], b[field]);
  return {
    score: similarity.score,
    reason: `${field}: ${a[field] || "-"} vs ${b[field] || "-"} (${similarity.reason})`,
  };
}

function scoreColor(a, b) {
  const hasA = Boolean(compact(a.effective_color));
  const hasB = Boolean(compact(b.effective_color));
  if (!hasA && !hasB) return null;

  if (compact(a.reference_color) || compact(b.reference_color)) {
    const similarity = valueSimilarity(a.effective_color, b.effective_color);
    return {
      score: similarity.score,
      reason: `color referencia: ${a.effective_color || "-"} vs ${b.effective_color || "-"} (${similarity.reason})`,
    };
  }

  if (compact(a.derived_reference_color) || compact(b.derived_reference_color)) {
    const similarity = valueSimilarity(a.effective_color, b.effective_color);
    return {
      score: similarity.score,
      reason: `color referencia derivado: ${a.effective_color || "-"} vs ${b.effective_color || "-"} (${similarity.reason})`,
    };
  }

  const similarity = valueSimilarity(a.color, b.color);
  return {
    score: similarity.score,
    reason: `color url/selector: ${a.color || "-"} vs ${b.color || "-"} (${similarity.reason})`,
  };
}

function scoreVariant(aRow, bRow, args = {}) {
  const a = variantFields(aRow);
  const b = variantFields(bRow);
  const liquidComparison = liquidProductType(aRow.productType) || liquidProductType(bRow.productType);
  const weights = {
    color: 1,
    nicotina: 2,
    capacidad: 1.5,
    contenido_ml: 2,
    bote_ml: 2,
    resistencia: 2,
    base_ratio: 1.5,
    sabor: 2.5,
    cafeina: 1.5,
    tamano: 1,
    pod_type: 4,
  };
  if (liquidComparison) {
    delete weights.capacidad;
  } else {
    delete weights.contenido_ml;
    delete weights.bote_ml;
  }
  let total = 0;
  let score = 0;
  const reasons = [];

  const colorScore = scoreColor(a, b);
  if (colorScore) {
    total += weights.color;
    score += colorScore.score * weights.color;
    reasons.push(colorScore.reason);
  }

  for (const [field, weight] of Object.entries(weights)) {
    if (field === "color") continue;
    const hasA = Boolean(compact(a[field]));
    const hasB = Boolean(compact(b[field]));
    if (!hasA && !hasB) continue;
    total += weight;
    const similarity = scoreField(field, a, b, args);
    score += similarity.score * weight;
    reasons.push(similarity.reason);
  }

  if (total === 0) {
    if (args.acceptBaseOnly) {
      return { confidence: 1, decision: "variant_match", reason: "No hay atributos de variante para comparar; se acepta por match fuerte de producto base en este tramo." };
    }
    return { confidence: 0.75, decision: "base_only", reason: "No hay atributos de variante para comparar; se conserva match de producto base." };
  }

  const confidence = Math.round((score / total) * 100) / 100;
  let decision = "no_variant_match";
  if (confidence >= 0.95) decision = "variant_match";
  else if (confidence >= 0.72) decision = "possible_variant_match";

  return {
    confidence,
    decision,
    reason: reasons.join("; "),
  };
}

function bestVariantFor(aVariant, bVariants, args = {}) {
  let best = null;
  for (const bVariant of bVariants) {
    const scored = scoreVariant(aVariant, bVariant, args);
    if (!best || scored.confidence > best.scored.confidence) {
      best = { bVariant, scored };
    }
  }
  return best;
}

function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const value = row[key];
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return groups;
}

function main() {
  const args = parseArgs(process.argv);
  const baseMatches = loadCsv(args.baseMatches)
    .filter((row) => ["match", "possible_match"].includes(row.decision))
    .filter((row) => row.product_a_id && row.best_match_b_id);
  const aVariantsByBase = groupBy(loadCsv(args.aVariants), "baseId");
  const bVariantsByBase = groupBy(loadCsv(args.bVariants), "baseId");
  const rows = [];

  for (const match of baseMatches) {
    const aVariants = aVariantsByBase.get(match.product_a_id) || [];
    const bVariants = bVariantsByBase.get(match.best_match_b_id) || [];
    if (aVariants.length === 0 || bVariants.length === 0) {
      rows.push({
        base_match_a_id: match.product_a_id,
        base_match_b_id: match.best_match_b_id,
        variant_decision: "missing_variants",
        variant_confidence: 0,
        reason: `Variantes disponibles A=${aVariants.length}, B=${bVariants.length}`,
      });
      continue;
    }

    for (const aVariant of aVariants) {
      const best = bestVariantFor(aVariant, bVariants, args);
      if (!best) continue;
      if (best.scored.confidence < args.threshold) {
        rows.push({
          base_match_a_id: match.product_a_id,
          base_match_b_id: match.best_match_b_id,
          a_variant_id: aVariant.id,
          a_title: aVariant.title,
          a_url: aVariant.url,
          a_variant: aVariant.variantLabel,
          b_variant_id: "",
          b_title: "",
          b_url: "",
          b_variant: "",
          variant_decision: "a_variant_without_b_variant",
          variant_confidence: 0,
          reason: `No se encontro variante equivalente en Vaperalia dentro de la base matcheada. Mejor candidato descartado: ${best.bVariant.variantLabel || best.bVariant.title || best.bVariant.id} (${best.scored.reason}).`,
        });
        continue;
      }
      rows.push({
        base_match_a_id: match.product_a_id,
        base_match_b_id: match.best_match_b_id,
        a_variant_id: aVariant.id,
        a_title: aVariant.title,
        a_url: aVariant.url,
        a_variant: aVariant.variantLabel,
        b_variant_id: best.bVariant.id,
        b_title: best.bVariant.title,
        b_url: best.bVariant.url,
        b_variant: best.bVariant.variantLabel,
        variant_decision: best.scored.decision,
        variant_confidence: best.scored.confidence,
        reason: best.scored.reason,
      });
    }
  }

  writeCsv(args.out, rows);
  console.log(`Base matches: ${baseMatches.length}`);
  console.log(`Variant rows: ${rows.length}`);
  console.log(`Archivo: ${args.out}`);
}

main();
