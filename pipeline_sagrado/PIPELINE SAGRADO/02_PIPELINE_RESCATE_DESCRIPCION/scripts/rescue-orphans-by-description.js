const fs = require("fs");
const path = require("path");
const { compact: compactBrand, getTargetBrands } = require("./brand-aliases");

function parseArgs(argv) {
  const args = {
    general: "outputs/general.matches.valid.json",
    aBase: "../outputs/prepared/eciglogistica__output.base.csv",
    bBase: "../outputs/prepared/vaperalia__output.base.csv",
    aVariants: "../outputs/prepared/eciglogistica__output.variants.csv",
    bVariants: "../outputs/prepared/vaperalia__output.variants.csv",
    out: "outputs/description-rescue-candidates.matches.valid.json",
    auditJson: "outputs/audits/description-rescue-candidates.audit.json",
    auditMd: "outputs/audits/description-rescue-candidates.audit.md",
    maxBaseCandidatesPerProduct: 120,
    maxOutput: 250,
    baseThreshold: 0.78,
    variantThreshold: 0.74,
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
    args[name] = [
      "maxBaseCandidatesPerProduct",
      "maxOutput",
      "baseThreshold",
      "variantThreshold",
    ].includes(name) ? Number(value) : value;
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

function readCsv(filePath) {
  return parseCsv(fs.readFileSync(filePath, "utf8"));
}

function byId(rows) {
  return new Map(rows.map((row) => [row.id, row]));
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

const STOP = new Set([
  "a", "al", "and", "aroma", "aromas", "base", "bote", "botella", "by", "capacidad",
  "caracteristicas", "cartucho", "con", "de", "del", "descripcion", "distribuidor",
  "edition", "el", "en", "es", "este", "formato", "html", "http", "https", "la",
  "las", "liquido", "liquidos", "los", "marca", "marcas", "meta", "ml", "para",
  "pod", "producto", "que", "referencia", "scrapeada", "sin", "sweet", "the",
  "ultimate", "un", "una", "vapeo", "vaperalia", "eciglogistica", "venta", "y",
]);

const NAME_STOP = new Set([
  ...STOP,
  "additif", "bar", "classic", "classique", "concentrado", "concentrados", "creations",
  "dessert", "desserts", "francia", "fresh", "fruit", "fruits", "fruitfull", "gama",
  "green", "les", "liquid", "longfill", "nicotine", "nicotina", "premium", "salt",
  "salts", "sales", "series", "sweets", "valores", "variante", "variantes", "version",
]);

const HARD_LINE_TOKENS = new Set([
  "zero", "primal", "legend", "legends", "limited", "v2", "pro", "mini", "nano", "max", "plus", "x",
]);

function words(...values) {
  return normalize(values.filter(Boolean).join(" "))
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => token.length > 1)
    .filter((token) => !STOP.has(token));
}

function tokenSet(...values) {
  return new Set(words(...values));
}

function isMeasureToken(token) {
  return /^\d+(?:ml|mg|pcs?|ohm|w|mah)?$/.test(token) || /^\d+(?:[.,]\d+)?$/.test(token);
}

function nameTokenSet(row) {
  const brandTokens = new Set(words(...brandValues(row)));
  const values = [
    row.title,
    row.baseTitle,
    row.variantLabel,
    row.variantValues,
    row.reference,
    row.syntheticReference,
  ];
  const tokens = words(...values)
    .filter((token) => !NAME_STOP.has(token))
    .filter((token) => !brandTokens.has(token))
    .filter((token) => !isMeasureToken(token));
  const raw = normalize(values.filter(Boolean).join(" "));
  if (/\bx\b/.test(raw)) tokens.push("x");
  return new Set(tokens);
}

function intersection(left, right) {
  return [...left].filter((value) => right.has(value));
}

function numericSet(regex, ...values) {
  const out = new Set();
  for (const value of values) {
    for (const match of String(value || "").matchAll(regex)) {
      const number = Number(match[1].replace(",", "."));
      if (Number.isFinite(number)) out.add(String(number));
    }
  }
  return out;
}

function mlSetFromPrimaryFields(row) {
  return numericSet(
    /(\d+(?:[.,]\d+)?)\s*ml/gi,
    row.title,
    row.baseTitle,
    row.variantLabel,
    row.variantValues,
    row.capacidad,
    row.contenido_ml,
    row.bote_ml,
    row.reference,
    row.syntheticReference,
    row.url,
  );
}

function nicotineSetFromPrimaryFields(row) {
  return numericSet(
    /(\d+(?:[.,]\d+)?)\s*mg/gi,
    row.title,
    row.baseTitle,
    row.variantLabel,
    row.variantValues,
    row.nicotina,
    row.reference,
    row.syntheticReference,
    row.url,
  );
}

function ohmSetFromPrimaryFields(row) {
  return numericSet(
    /(\d+(?:[.,]\d+)?)\s*(?:ohm|Ω|Î©|ÃŽÂ©)/gi,
    row.title,
    row.baseTitle,
    row.variantLabel,
    row.variantValues,
    row.resistencia,
    row.reference,
    row.syntheticReference,
    row.url,
  );
}

function editionMarkers(row) {
  const text = normalize([
    row.title,
    row.baseTitle,
    row.variantLabel,
    row.variantValues,
    row.reference,
    row.syntheticReference,
    row.url,
  ].filter(Boolean).join(" "));
  const markers = new Set();
  if (/\bsweet\s+edition\b|\bsweet\b/.test(text)) markers.add("sweet");
  if (/\bgreen\s+edition\b|\bgreen\b/.test(text)) markers.add("green");
  return markers;
}

function primaryText(row) {
  return normalize([
    row.title,
    row.baseTitle,
    row.variantLabel,
    row.variantValues,
    row.reference,
    row.syntheticReference,
    row.brandCandidates,
    row.commercialBrand,
    row.breadcrumbPath,
    row.url,
  ].filter(Boolean).join(" "));
}

function hasLongfillSignal(row) {
  const text = primaryText(row);
  return /\blong\s*fill\b|\blongfill\b|\b\d+\s*ml\s*\/\s*\d+\b|\bbote\s+de\s+\d+\s*ml\b/.test(text);
}

function hasDripTipSignal(row) {
  const text = primaryText(row);
  return /\bdrip\s*tip\b|\bboquilla\b|\bboquillas\b/.test(text);
}

function setConflict(left, right) {
  if (!left.size || !right.size) return false;
  return intersection(left, right).length === 0;
}

function typeGroup(type) {
  if (["pod_replacement", "coil", "pyrex", "atomizer_tank"].includes(type)) return "hardware_repuesto";
  if (["kit_device", "mod_device"].includes(type)) return "hardware_dispositivo";
  if (["aroma_concentrate", "eliquid", "nicotine_salt", "base_booster"].includes(type)) return "liquidos";
  return type || "unknown";
}

function brandValues(row) {
  return [row.brand, row.brandCandidates, row.commercialBrand]
    .join("|")
    .split(/[|,]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function brandCompatible(a, b) {
  const bBrands = new Set(brandValues(b).map(compactBrand));
  const targets = new Set();
  for (const brand of brandValues(a)) {
    for (const target of getTargetBrands(brand, a.productType, "ecig", "vaperalia")) {
      targets.add(compactBrand(target));
    }
  }
  if (!targets.size || !bBrands.size) return "unknown";
  return [...bBrands].some((brand) => targets.has(brand)) ? "yes" : "no";
}

function titleText(row) {
  return [
    row.title,
    row.baseTitle,
    row.variantLabel,
    row.variantValues,
    row.reference,
    row.syntheticReference,
    row.baseKey,
    row.url,
  ].filter(Boolean).join(" ");
}

function descriptionText(row) {
  return [
    row.title,
    row.description,
    row.metaDescription,
    row.breadcrumbPath,
    row.variantValues,
    row.reference,
    row.syntheticReference,
    row.url,
  ].filter(Boolean).join(" ");
}

function colorValue(row) {
  const direct = row.reference_color || row.derived_reference_color || row.color || "";
  if (direct) return compact(direct);
  const match = String(row.variantLabel || row.title || "").match(/color\s*:?\s*([^;|,/]+)/i);
  return match ? compact(match[1]) : "";
}

function modelMarkers(row) {
  const text = normalize([row.title, row.baseTitle, row.reference, row.syntheticReference, row.url].filter(Boolean).join(" "));
  const markers = new Set();
  const patterns = [
    /\b([a-z]{2,})\s*-?\s*(\d+[a-z]?)\b/g,
    /\b([a-z]{1,3})\s*-?\s*(mini|nano|max|pro|plus)\b/g,
    /\b(pm)\s*-?\s*(\d+)\b/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) {
      const marker = compact(`${match[1]}${match[2]}`);
      if (!["pack2", "pack3", "pack5", "p2", "p3", "p5"].includes(marker)) markers.add(marker);
    }
  }
  return markers;
}

function lineTokenConflict(aTokens, bTokens) {
  const a = [...aTokens].filter((token) => HARD_LINE_TOKENS.has(token));
  const b = [...bTokens].filter((token) => HARD_LINE_TOKENS.has(token));
  if (!a.length || !b.length) return false;
  return !a.some((token) => b.includes(token));
}

function scoreRows(a, b, context = {}) {
  const aTitle = tokenSet(titleText(a));
  const bTitle = tokenSet(titleText(b));
  const aDesc = tokenSet(descriptionText(a));
  const bDesc = tokenSet(descriptionText(b));
  const aNames = nameTokenSet(a);
  const bNames = nameTokenSet(b);
  const titleCommon = intersection(aTitle, bTitle);
  const descCommon = intersection(aDesc, bDesc);
  const nameCommon = intersection(aNames, bNames);
  const titleCoverage = titleCommon.length / Math.max(1, Math.min(aTitle.size, bTitle.size));
  const descCoverage = descCommon.length / Math.max(1, Math.min(aDesc.size, bDesc.size));
  const sameType = a.productType && a.productType === b.productType;
  const sameGroup = typeGroup(a.productType) === typeGroup(b.productType);
  const brand = brandCompatible(a, b);
  const isLiquid = typeGroup(a.productType) === "liquidos" || typeGroup(b.productType) === "liquidos";
  const isHardware = ["hardware_repuesto", "hardware_dispositivo"].includes(typeGroup(a.productType))
    || ["hardware_repuesto", "hardware_dispositivo"].includes(typeGroup(b.productType));

  const mlConflict = setConflict(mlSetFromPrimaryFields(a), mlSetFromPrimaryFields(b));
  const aOhms = ohmSetFromPrimaryFields(a);
  const bOhms = ohmSetFromPrimaryFields(b);
  const commonOhms = intersection(aOhms, bOhms);
  const ohmConflict = setConflict(aOhms, bOhms);
  const nicotineConflict = setConflict(nicotineSetFromPrimaryFields(a), nicotineSetFromPrimaryFields(b));
  const aColor = colorValue(a);
  const bColor = colorValue(b);
  const colorConflict = Boolean(aColor && bColor && aColor !== bColor);
  const modelConflict = isHardware && setConflict(modelMarkers(a), modelMarkers(b));
  const dripTipConflict = isHardware && (hasDripTipSignal(a) !== hasDripTipSignal(b));
  const hardLineConflict = isLiquid && lineTokenConflict(aTitle, bTitle);
  const nameCommonSet = new Set(nameCommon);
  const aNameExtra = [...aNames].filter((token) => !nameCommonSet.has(token));
  const bNameExtra = [...bNames].filter((token) => !nameCommonSet.has(token));
  const hardNameA = [...aNames].filter((token) => HARD_LINE_TOKENS.has(token));
  const hardNameB = [...bNames].filter((token) => HARD_LINE_TOKENS.has(token));
  const asymmetricHardNameConflict = !context.sameBase && isLiquid
    && [...new Set([...hardNameA, ...hardNameB])].some((token) => aNames.has(token) !== bNames.has(token));
  const divergentNameConflict = !context.sameBase && isLiquid
    && nameCommon.length <= 1
    && aNameExtra.length > 0
    && bNameExtra.length > 0;
  const singleAnchorExtraConflict = !context.sameBase && isLiquid
    && nameCommon.length === 1
    && (aNameExtra.length > 0 || bNameExtra.length > 0);
  const missingNameAnchor = !context.sameBase && (isLiquid || isHardware) && nameCommon.length === 0;
  const editionConflict = !context.sameBase && isLiquid && setConflict(editionMarkers(a), editionMarkers(b));
  const longfillConflict = isLiquid && (hasLongfillSignal(a) !== hasLongfillSignal(b));
  const hardConflict = mlConflict || ohmConflict || nicotineConflict || colorConflict || modelConflict
    || dripTipConflict || hardLineConflict || asymmetricHardNameConflict || divergentNameConflict
    || singleAnchorExtraConflict || missingNameAnchor || editionConflict || longfillConflict;

  let score = 0;
  const reasons = [];
  if (context.splitBaseVariant) {
    score += 0.12;
    reasons.push("variante contra ficha base no cubierta");
  }
  if (context.sameBase) {
    score += 0.2;
    reasons.push("misma base ya matcheada");
  }
  if (sameType) {
    score += 0.14;
    reasons.push(`mismo productType ${a.productType}`);
  } else if (sameGroup) {
    score += 0.08;
    reasons.push(`mismo grupo ${typeGroup(a.productType)}`);
  }
  if (brand === "yes") {
    score += 0.16;
    reasons.push("marca compatible");
  } else if (brand === "no") {
    score -= 0.16;
    reasons.push("marca distinta");
  }
  if (titleCommon.length) {
    score += Math.min(0.24, titleCoverage * 0.24);
    reasons.push(`titulo comparte ${titleCommon.slice(0, 8).join("+")}`);
  }
  if (nameCommon.length) {
    reasons.push(`ancla nombre ${nameCommon.slice(0, 6).join("+")}`);
  }
  if (descCommon.length) {
    score += Math.min(0.32, descCoverage * 0.32);
    reasons.push(`descripcion comparte ${descCommon.slice(0, 10).join("+")}`);
  }
  if (!ohmConflict && commonOhms.length) {
    score += 0.08;
    reasons.push(`resistencia exacta ${commonOhms.join("/")} ohm`);
  }

  const distinctiveTitle = nameCommon.filter((token) => !["color", "pack", "p2", "p3", "p5"].includes(token));
  const distinctiveDesc = descCommon.filter((token) => token.length >= 4);
  if (!hardConflict && isLiquid && sameGroup && brand === "yes" && distinctiveTitle.length >= 1 && distinctiveDesc.length >= 3) {
    score = Math.max(score, 0.86);
    reasons.push("rescate fuerte liquido/aroma por marca, ancla de producto y receta en descripcion");
  }
  if (!hardConflict && context.sameBase && sameGroup && (titleCommon.length >= 2 || descCommon.length >= 6)) {
    score = Math.max(score, 0.82);
    reasons.push("rescate de variante dentro de base ya matcheada");
  }

  if (mlConflict) reasons.push("ml en conflicto");
  if (ohmConflict) reasons.push("ohm en conflicto");
  if (nicotineConflict) reasons.push("nicotina en conflicto");
  if (colorConflict) reasons.push(`color en conflicto (${a.reference_color || a.color || a.variantLabel || "-"} vs ${b.reference_color || b.color || b.variantLabel || "-"})`);
  if (modelConflict) reasons.push("modelo hardware en conflicto");
  if (dripTipConflict) reasons.push("drip tip/boquilla no equivale a atomizador/tanque completo");
  if (hardLineConflict) reasons.push("linea/edicion dura en conflicto");
  if (asymmetricHardNameConflict) reasons.push("marcador duro de nombre presente solo en un lado");
  if (divergentNameConflict) reasons.push(`nombre divergente (${aNameExtra.slice(0, 5).join("+") || "-"} vs ${bNameExtra.slice(0, 5).join("+") || "-"})`);
  if (singleAnchorExtraConflict) reasons.push(`ancla unica con detalle extra (${aNameExtra.slice(0, 5).join("+") || "-"} vs ${bNameExtra.slice(0, 5).join("+") || "-"})`);
  if (missingNameAnchor) reasons.push("sin ancla comun de nombre de producto");
  if (editionConflict) reasons.push("edicion distinta (sweet/green)");
  if (longfillConflict) reasons.push("formato longfill presente solo en un lado");

  score = Math.max(0, Math.min(1, score));
  return {
    score: Math.round(score * 100) / 100,
    accepted: !hardConflict && score >= (context.sameBase || context.splitBaseVariant ? context.variantThreshold : context.baseThreshold),
    reasons,
    conflicts: {
      ml: mlConflict,
      ohm: ohmConflict,
      nicotine: nicotineConflict,
      color: colorConflict,
      model: modelConflict,
      dripTip: dripTipConflict,
      hardLine: hardLineConflict,
      hardName: asymmetricHardNameConflict,
      divergentName: divergentNameConflict,
      singleAnchorExtra: singleAnchorExtraConflict,
      missingNameAnchor,
      edition: editionConflict,
      longfill: longfillConflict,
    },
    anchors: [...new Set([...nameCommon, ...titleCommon, ...descCommon])].filter((token) => token.length >= 3).slice(0, 16),
  };
}

function baseIdFromVariantId(id) {
  if (!id) return "";
  const marker = ":HTTPS";
  const markerIndex = id.indexOf(marker);
  if (markerIndex < 0) return id.split(":").slice(0, 2).join(":");
  const afterUrl = id.indexOf(":", markerIndex + marker.length);
  return afterUrl > 0 ? id.slice(0, afterUrl) : id;
}

function coveredVaperaliaIds(data) {
  const ids = new Set();
  for (const product of data.products || []) {
    if (product.vaperalia?.productId) ids.add(product.vaperalia.productId);
    for (const variant of product.variants || []) {
      const id = baseIdFromVariantId(variant.vaperalia?.variantId || "");
      if (id) ids.add(id);
    }
  }
  return ids;
}

function buildIndex(rows) {
  const index = new Map();
  for (const row of rows) {
    for (const token of tokenSet(row.title, row.metaDescription, row.description, row.reference, row.syntheticReference, row.variantValues, row.url)) {
      if (token.length < 3) continue;
      if (!index.has(token)) index.set(token, []);
      index.get(token).push(row);
    }
  }
  return index;
}

function candidateRows(row, index, maxRows) {
  const counts = new Map();
  for (const token of tokenSet(row.title, row.metaDescription, row.description, row.reference, row.syntheticReference, row.variantValues, row.url)) {
    const rows = index.get(token) || [];
    if (rows.length > 400) continue;
    for (const candidate of rows) counts.set(candidate, (counts.get(candidate) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, maxRows)
    .map(([candidate]) => candidate);
}

function sideFromBase(row) {
  return {
    productId: row.id,
    title: row.title,
    url: row.url,
    brand: row.brand || row.brandCandidates || row.commercialBrand || "",
    productType: row.productType || "",
  };
}

function neutralizeNicotineTitle(title) {
  return String(title || "")
    .replace(/\s+-\s*\d+(?:[.,]\d+)?\s*mg\s*\/\s*\d+(?:[.,]\d+)?\s*ml\b/gi, "")
    .replace(/\s+-\s*\d+(?:[.,]\d+)?\s*mg\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function sideFromVariant(row) {
  return {
    variantId: row.id,
    title: row.title,
    url: row.url || row.baseUrl || "",
    variant: row.variantLabel || "",
  };
}

function rescueReason(source, audit) {
  return `Rescate por descripcion (${source}). ${audit.reasons.join("; ")}. Anclas: ${audit.anchors.join(", ") || "-"}.`;
}

function productFromCandidate(candidate, index) {
  const variantPairs = candidate.variantPairs || [{
    audit: candidate.audit,
    eciglogistica: candidate.eciglogistica.variant,
    vaperalia: candidate.vaperalia.variant,
    source: candidate.source,
  }];
  const confidence = Math.min(candidate.audit.score, ...variantPairs.map((pair) => pair.audit.score));
  const reason = rescueReason(candidate.source, candidate.audit);
  const product = {
    status: "base_match",
    baseConfidence: confidence,
    reason,
    sourceDataset: "description-rescue-candidates",
    sourceDatasetLabel: "Rescates por descripcion",
    eciglogistica: candidate.eciglogistica.product,
    vaperalia: candidate.vaperalia.product,
    variants: variantPairs.map((pair) => {
      const variantConfidence = Math.min(candidate.audit.score, pair.audit.score);
      const variantReason = pair.source === candidate.source
        ? rescueReason(pair.source, pair.audit)
        : `${reason} Variante exacta: ${rescueReason(pair.source, pair.audit)}`;
      return {
        status: "probable",
        finalConfidence: variantConfidence,
        variantDecision: "probable_por_descripcion",
        variantConfidence,
        reason: variantReason,
        eciglogistica: pair.eciglogistica,
        vaperalia: pair.vaperalia,
      };
    }),
  };
  if (!product.eciglogistica.productId) product.eciglogistica.productId = `description-rescue-ecig-${index}`;
  return product;
}

function candidateVariantPairs(candidate) {
  return candidate.variantPairs || [{
    eciglogistica: candidate.eciglogistica.variant,
    vaperalia: candidate.vaperalia.variant,
  }];
}

function isVariantScopedCandidate(candidate) {
  return ["variant_orphan_description_rescue", "split_base_variant_description_rescue"].includes(candidate.source);
}

function uniqueCandidates(candidates) {
  const seenAProducts = new Set();
  const seenBProducts = new Set();
  const seenAVariants = new Set();
  const seenBVariants = new Set();
  const result = [];
  for (const candidate of candidates.sort((left, right) => right.audit.score - left.audit.score)) {
    if (isVariantScopedCandidate(candidate)) {
      const pairs = candidateVariantPairs(candidate);
      const aVariants = pairs.map((pair) => pair.eciglogistica?.variantId).filter(Boolean);
      const bVariants = pairs.map((pair) => pair.vaperalia?.variantId).filter(Boolean);
      if (aVariants.some((id) => seenAVariants.has(id)) || bVariants.some((id) => seenBVariants.has(id))) continue;
      aVariants.forEach((id) => seenAVariants.add(id));
      bVariants.forEach((id) => seenBVariants.add(id));
      result.push(candidate);
      continue;
    }

    const a = candidate.eciglogistica.product.productId;
    const b = candidate.vaperalia.product.productId;
    const pair = `${a}|||${b}`;
    if (seenAProducts.has(a) || seenBProducts.has(b) || result.some((item) => `${item.eciglogistica.product.productId}|||${item.vaperalia.product.productId}` === pair)) continue;
    seenAProducts.add(a);
    seenBProducts.add(b);
    result.push(candidate);
  }
  return result;
}

function buildSummary(products, sourceCounts) {
  const flatVariants = products.flatMap((product) => product.variants || []);
  return {
    baseRows: products.length,
    baseMatchesKept: products.length,
    baseProductsVisible: products.length,
    validVariants: 0,
    probableVariants: flatVariants.filter((variant) => variant.status === "probable").length,
    totalVariantsKept: flatVariants.length,
    totalVariantsVisible: flatVariants.length,
    discardedVariantsVisible: 0,
    ecigOnlyVariants: 0,
    vaperaliaOnlyVariants: 0,
    discardedBaseMatches: 0,
    rescueSourceCounts: sourceCounts,
    discarded: {
      impossible: 0,
      discarded_low_confidence: 0,
      ecig_only: 0,
      vaperalia_only: 0,
      baseNoMatch: 0,
      variantRowsTotal: flatVariants.length,
    },
  };
}

function mdLink(label, url) {
  return url ? `[${label}](${url})` : label;
}

function writeAuditMd(filePath, output) {
  const lines = [
    "# Rescates candidatos por descripcion",
    "",
    `Generado: ${output.generatedAt}`,
    "",
    "Dataset separado. No modifica `general.matches.valid.json`.",
    "",
    `- Candidatos publicados: ${output.summary.baseRows}`,
    `- Probables por descripcion: ${output.summary.probableVariants}`,
    `- Origen base sin match: ${output.summary.rescueSourceCounts.base}`,
    `- Origen variantes solo/solo: ${output.summary.rescueSourceCounts.variant}`,
    "",
  ];
  for (const product of output.products.slice(0, 120)) {
    const variant = product.variants[0] || {};
    lines.push(`## ${product.eciglogistica.title}`);
    lines.push("");
    lines.push(`- Score: ${variant.finalConfidence}`);
    lines.push(`- Ecig: ${mdLink(product.eciglogistica.title, product.eciglogistica.url)}`);
    lines.push(`- Vaperalia: ${mdLink(product.vaperalia.title, product.vaperalia.url)}`);
    lines.push(`- Motivo: ${variant.reason}`);
    lines.push("");
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function hasNicotineSignal(row) {
  return nicotineSetFromPrimaryFields(row).size > 0
    || /\bnicotina\b|\bnicotine\b|\bsalt\b|\bsalts\b|\bsales\b/i.test([
      row.title,
      row.baseTitle,
      row.variantLabel,
      row.variantValues,
      row.productType,
      row.category,
      row.breadcrumbPath,
      row.description,
    ].filter(Boolean).join(" "));
}

function bestOneToOnePairs(pairs) {
  const usedA = new Set();
  const usedB = new Set();
  const selected = [];
  for (const pair of pairs.sort((left, right) => right.audit.score - left.audit.score)) {
    const aId = pair.eciglogistica.variantId;
    const bId = pair.vaperalia.variantId;
    if (usedA.has(aId) || usedB.has(bId)) continue;
    usedA.add(aId);
    usedB.add(bId);
    selected.push(pair);
  }
  return selected;
}

function buildNicotineVariantCandidate(aRow, bRow, baseAudit, aVariantsByBase, bVariantsByBase, args) {
  const aVariants = aVariantsByBase.get(aRow.id) || [];
  const bVariants = bVariantsByBase.get(bRow.id) || [];
  const requiresExactNicotine = typeGroup(aRow.productType) === "liquidos"
    && typeGroup(bRow.productType) === "liquidos"
    && (
      hasNicotineSignal(aRow)
      || hasNicotineSignal(bRow)
      || aVariants.some(hasNicotineSignal)
      || bVariants.some(hasNicotineSignal)
    );
  if (!requiresExactNicotine) return { required: false };

  const aRows = (aVariants.length ? aVariants : [aRow]).filter((row) => nicotineSetFromPrimaryFields(row).size > 0);
  const bRows = (bVariants.length ? bVariants : [bRow]).filter((row) => nicotineSetFromPrimaryFields(row).size > 0);
  if (!aRows.length || !bRows.length) return { required: true, candidate: null };

  const pairs = [];
  for (const aVariant of aRows) {
    const aNicotine = nicotineSetFromPrimaryFields(aVariant);
    for (const bVariant of bRows) {
      const bNicotine = nicotineSetFromPrimaryFields(bVariant);
      const commonNicotine = intersection(aNicotine, bNicotine);
      if (!commonNicotine.length) continue;
      const audit = scoreRows(aVariant, bVariant, {
        sameBase: true,
        variantThreshold: args.variantThreshold,
        baseThreshold: args.baseThreshold,
      });
      if (!audit.accepted) continue;
      audit.reasons.push(`nicotina exacta ${commonNicotine.join("/")} mg`);
      pairs.push({
        audit,
        source: "base_orphan_description_rescue_nicotine_variant",
        eciglogistica: sideFromVariant(aVariant),
        vaperalia: sideFromVariant(bVariant),
      });
    }
  }

  const variantPairs = bestOneToOnePairs(pairs);
  if (!variantPairs.length) return { required: true, candidate: null };
  const aProduct = sideFromBase(aRow);
  const bProduct = sideFromBase(bRow);
  aProduct.title = neutralizeNicotineTitle(aProduct.title);
  bProduct.title = neutralizeNicotineTitle(bProduct.title);
  return {
    required: true,
    candidate: {
      source: "base_orphan_description_rescue",
      audit: baseAudit,
      variantPairs,
      eciglogistica: {
        product: aProduct,
        variant: variantPairs[0].eciglogistica,
      },
      vaperalia: {
        product: bProduct,
        variant: variantPairs[0].vaperalia,
      },
    },
  };
}

function main() {
  const args = parseArgs(process.argv);
  const data = JSON.parse(fs.readFileSync(args.general, "utf8"));
  const aBase = readCsv(args.aBase);
  const bBase = readCsv(args.bBase);
  const aVariants = readCsv(args.aVariants);
  const bVariants = readCsv(args.bVariants);
  const aBaseIndex = byId(aBase);
  const bBaseIndex = byId(bBase);
  const aVariantIndex = byId(aVariants);
  const bVariantIndex = byId(bVariants);
  const aVariantsByBase = byBaseId(aVariants);
  const bVariantsByBase = byBaseId(bVariants);
  const candidates = [];
  const coveredB = coveredVaperaliaIds(data);
  const bUncovered = bBase.filter((row) => !coveredB.has(row.id));
  const bUncoveredIds = new Set(bUncovered.map((row) => row.id));
  const bUncoveredVariants = bVariants.filter((row) => bUncoveredIds.has(row.baseId));
  const bUncoveredVariantIndex = buildIndex(bUncoveredVariants);

  for (const product of data.products || []) {
    const ecigOnly = (product.variants || []).filter((variant) => variant.status === "ecig_only");
    const vaperaliaOnly = (product.variants || []).filter((variant) => variant.status === "vaperalia_only");
    for (const left of ecigOnly) {
      const aRow = aVariantIndex.get(left.eciglogistica?.variantId || "");
      if (!aRow) continue;
      for (const right of vaperaliaOnly) {
        const bRow = bVariantIndex.get(right.vaperalia?.variantId || "");
        if (!bRow) continue;
        const audit = scoreRows(aRow, bRow, {
          sameBase: true,
          variantThreshold: args.variantThreshold,
          baseThreshold: args.baseThreshold,
        });
        if (!audit.accepted) continue;
        const aProduct = aBaseIndex.get(aRow.baseId) || {};
        const bProduct = bBaseIndex.get(bRow.baseId) || {};
        candidates.push({
          source: "variant_orphan_description_rescue",
          audit,
          eciglogistica: {
            product: sideFromBase(aProduct.id ? aProduct : aRow),
            variant: sideFromVariant(aRow),
          },
          vaperalia: {
            product: sideFromBase(bProduct.id ? bProduct : bRow),
            variant: sideFromVariant(bRow),
          },
        });
      }
    }
  }

  for (const product of data.products || []) {
    const ecigOnly = (product.variants || []).filter((variant) => variant.status === "ecig_only");
    for (const left of ecigOnly) {
      const aRow = aVariantIndex.get(left.eciglogistica?.variantId || "");
      if (!aRow || typeGroup(aRow.productType) !== "hardware_repuesto") continue;
      const aOhm = ohmSetFromPrimaryFields(aRow);
      for (const bRow of candidateRows(aRow, bUncoveredVariantIndex, args.maxBaseCandidatesPerProduct)) {
        if (aRow.productType && bRow.productType && aRow.productType !== bRow.productType) continue;
        if (typeGroup(aRow.productType) !== typeGroup(bRow.productType)) continue;
        const bOhm = ohmSetFromPrimaryFields(bRow);
        if (aOhm.size && bOhm.size && !intersection(aOhm, bOhm).length) continue;
        const audit = scoreRows(aRow, bRow, {
          splitBaseVariant: true,
          variantThreshold: args.variantThreshold,
          baseThreshold: args.baseThreshold,
        });
        if (!audit.accepted) continue;
        audit.reasons.push("Vaperalia separa esta variante en otra URL base");
        const aProduct = aBaseIndex.get(aRow.baseId) || {};
        const bProduct = bBaseIndex.get(bRow.baseId) || {};
        candidates.push({
          source: "split_base_variant_description_rescue",
          audit,
          eciglogistica: {
            product: sideFromBase(aProduct.id ? aProduct : aRow),
            variant: sideFromVariant(aRow),
          },
          vaperalia: {
            product: sideFromBase(bProduct.id ? bProduct : bRow),
            variant: sideFromVariant(bRow),
          },
        });
      }
    }
  }

  const bIndex = buildIndex(bUncovered);
  for (const product of data.discardedBaseMatches || []) {
    const aRow = aBaseIndex.get(product.eciglogistica?.productId || "");
    if (!aRow) continue;
    let best = null;
    for (const bRow of candidateRows(aRow, bIndex, args.maxBaseCandidatesPerProduct)) {
      const audit = scoreRows(aRow, bRow, {
        sameBase: false,
        variantThreshold: args.variantThreshold,
        baseThreshold: args.baseThreshold,
      });
      if (!audit.accepted) continue;
      if (!best || audit.score > best.audit.score) best = { bRow, audit };
    }
    if (!best) continue;
    const nicotineCandidate = buildNicotineVariantCandidate(
      aRow,
      best.bRow,
      best.audit,
      aVariantsByBase,
      bVariantsByBase,
      args,
    );
    if (nicotineCandidate.required) {
      if (nicotineCandidate.candidate) candidates.push(nicotineCandidate.candidate);
      continue;
    }
    candidates.push({
      source: "base_orphan_description_rescue",
      audit: best.audit,
      eciglogistica: {
        product: sideFromBase(aRow),
        variant: {
          variantId: `${aRow.id}:description-rescue`,
          title: aRow.title,
          url: aRow.url,
          variant: "",
        },
      },
      vaperalia: {
        product: sideFromBase(best.bRow),
        variant: {
          variantId: `${best.bRow.id}:description-rescue`,
          title: best.bRow.title,
          url: best.bRow.url,
          variant: "",
        },
      },
    });
  }

  const selected = uniqueCandidates(candidates).slice(0, args.maxOutput);
  const products = selected.map(productFromCandidate);
  const flatMatches = products.flatMap((product) => product.variants.map((variant) => ({
    product: {
      eciglogistica: product.eciglogistica.title,
      vaperalia: product.vaperalia.title,
    },
    ...variant,
  })));
  const sourceCounts = selected.reduce((acc, candidate) => {
    if (candidate.source.startsWith("base_orphan_description_rescue")) acc.base += 1;
    else acc.variant += 1;
    return acc;
  }, { base: 0, variant: 0 });

  const output = {
    generatedAt: new Date().toISOString(),
    sideLabels: {
      left: "Eciglogistica",
      right: "Vaperalia",
    },
    source: {
      pipeline: "description-rescue-candidates",
      general: args.general,
      note: "Segunda fase determinista para huerfanos. No modifica el dataset general.",
    },
    confidencePolicy: {
      note: "Todos los rescates se publican como probable para revision humana.",
      status: "probable",
      baseThreshold: args.baseThreshold,
      variantThreshold: args.variantThreshold,
    },
    summary: buildSummary(products, sourceCounts),
    products,
    flatMatches,
    flatDiscardedVariants: [],
    flatEcigOnlyVariants: [],
    flatVaperaliaOnlyVariants: [],
    discardedBaseMatches: [],
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  fs.mkdirSync(path.dirname(args.auditJson), { recursive: true });
  fs.writeFileSync(args.auditJson, `${JSON.stringify({ generatedAt: output.generatedAt, candidates: selected }, null, 2)}\n`, "utf8");
  writeAuditMd(args.auditMd, output);
  console.log(JSON.stringify(output.summary, null, 2));
  console.log(`Dataset: ${args.out}`);
  console.log(`Auditoria: ${args.auditMd}`);
}

main();
