#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    general: "outputs/general.matches.valid.json",
    ecigBase: "../outputs/prepared/eciglogistica__output.base.csv",
    ecigVariants: "../outputs/prepared/eciglogistica__output.variants.csv",
    vaperaliaBase: "../outputs/prepared/vaperalia__output.base.csv",
    vaperaliaVariants: "../outputs/prepared/vaperalia__output.variants.csv",
    outDir: "outputs/master-json",
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readCsv(filePath) {
  return parseCsv(fs.readFileSync(filePath, "utf8"));
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value) {
  return normalize(value).replace(/[^a-z0-9]+/g, "");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function urlWithoutVariant(url) {
  return String(url || "").split("#")[0];
}

function baseIdFromVariantId(id) {
  if (!id) return "";
  const parts = String(id).split(":");
  return parts.length >= 3 ? parts.slice(0, 3).join(":") : id;
}

function typeGroup(type) {
  if (["pod_replacement", "coil", "pyrex", "atomizer_tank"].includes(type)) return "hardware_repuesto";
  if (["kit_device", "mod_device"].includes(type)) return "hardware_dispositivo";
  if (["aroma_concentrate", "eliquid", "nicotine_salt", "base_booster"].includes(type)) return "liquidos";
  return type || "unknown";
}

function effectiveColor(row) {
  return row.reference_color || row.derived_reference_color || row.color || "";
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const value = row[key] || "";
    if (!map.has(value)) map.set(value, []);
    map.get(value).push(row);
  }
  return map;
}

function byId(rows) {
  return new Map(rows.map((row) => [row.id, row]));
}

function loadSide(basePath, variantsPath) {
  const baseRows = readCsv(basePath);
  const variantRows = readCsv(variantsPath);
  return {
    baseRows,
    variantRows,
    baseById: byId(baseRows),
    variantById: byId(variantRows),
    variantsByBase: groupBy(variantRows, "baseId"),
  };
}

function fallbackVariantRow(info, productInfo, sideName) {
  const variantId = info?.variantId || "";
  const productId = productInfo?.productId || baseIdFromVariantId(variantId);
  return {
    id: variantId || productId,
    baseId: productId,
    distributor: sideName,
    url: info?.url || productInfo?.url || "",
    baseUrl: urlWithoutVariant(info?.url || productInfo?.url || ""),
    title: info?.title || productInfo?.title || "",
    description: "",
    baseTitle: productInfo?.title || info?.title || "",
    category: "",
    brand: productInfo?.brand || "",
    brandCandidates: productInfo?.brand || "",
    commercialBrand: "",
    productLine: "",
    breadcrumbPath: "",
    metaDescription: "",
    productType: productInfo?.productType || "",
    reference: "",
    syntheticReference: "",
    sku: "",
    priceTaxExcluded: "",
    variantSignature: "",
    variantLabel: info?.variant || "",
    color: "",
    reference_color: "",
    pod_type: "",
    nicotina: "",
    capacidad: "",
    contenido_ml: "",
    bote_ml: "",
    resistencia: "",
    base_ratio: "",
    sabor: "",
    cafeina: "",
    tamano: "",
    derived_reference_color: "",
    derivedJson: "",
    variantsJson: "",
    sourceFile: "",
  };
}

function resolveVariant(info, productInfo, sideData, sideName) {
  const variantId = info?.variantId || "";
  if (variantId && sideData.variantById.has(variantId)) {
    const row = sideData.variantById.get(variantId);
    return { row, base: sideData.baseById.get(row.baseId) || {}, resolvedPreparedId: row.id, resolution: "exact_variant_id" };
  }

  const baseId = productInfo?.productId || baseIdFromVariantId(variantId);
  const candidates = sideData.variantsByBase.get(baseId) || [];
  if (candidates.length) {
    const wantedUrl = urlWithoutVariant(info?.url || productInfo?.url || "");
    const sameUrl = wantedUrl ? candidates.filter((row) => urlWithoutVariant(row.url) === wantedUrl || urlWithoutVariant(row.baseUrl) === wantedUrl) : [];
    if (sameUrl.length === 1) {
      const row = sameUrl[0];
      return { row, base: sideData.baseById.get(row.baseId) || {}, resolvedPreparedId: row.id, resolution: "single_url_in_base" };
    }

    const wantedTitle = compact(info?.title || "");
    const sameTitle = wantedTitle ? candidates.filter((row) => compact(row.title) === wantedTitle || compact(row.baseTitle) === wantedTitle) : [];
    if (sameTitle.length === 1) {
      const row = sameTitle[0];
      return { row, base: sideData.baseById.get(row.baseId) || {}, resolvedPreparedId: row.id, resolution: "single_title_in_base" };
    }

    if (candidates.length === 1) {
      const row = candidates[0];
      return { row, base: sideData.baseById.get(row.baseId) || {}, resolvedPreparedId: row.id, resolution: "single_variant_in_base" };
    }
  }

  const fallback = fallbackVariantRow(info, productInfo, sideName);
  return { row: fallback, base: sideData.baseById.get(fallback.baseId) || {}, resolvedPreparedId: "", resolution: "synthetic_output_variant" };
}

function value(row, base, key) {
  const raw = row?.[key];
  if (raw != null && raw !== "") return raw;
  const baseValue = base?.[key];
  return baseValue != null ? baseValue : "";
}

const COMPARISON_FIELDS = [
  "distributor",
  "url",
  "baseUrl",
  "title",
  "description",
  "baseTitle",
  "category",
  "sourceCategories",
  "brand",
  "brandCandidates",
  "commercialBrand",
  "productLine",
  "breadcrumbPath",
  "metaDescription",
  "productType",
  "typeGroup",
  "reference",
  "syntheticReference",
  "baseKey",
  "variantCount",
  "variantSummary",
  "variantValues",
  "sku",
  "priceTaxExcluded",
  "minPriceTaxExcluded",
  "maxPriceTaxExcluded",
  "sourceFiles",
  "variantSignature",
  "variantLabel",
  "color",
  "reference_color",
  "derived_reference_color",
  "effective_color",
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
  "derivedJson",
  "variantsJson",
  "sourceFile",
];

function comparisonHash(record) {
  const payload = {};
  for (const field of COMPARISON_FIELDS) payload[field] = normalize(record[field]);
  return sha256(JSON.stringify(payload));
}

function recordFromRow({ classification, side, row, base, meta = {} }) {
  const productType = value(row, base, "productType");
  const out = {
    id: meta.id || `${classification}:${side}:${row.id || base.id || sha256(JSON.stringify(row)).slice(0, 16)}`,
    classification,
    side,
    matchStatus: meta.matchStatus || classification,
    sourceDataset: meta.sourceDataset || "",
    sourceDatasetLabel: meta.sourceDatasetLabel || "",
    matchConfidence: meta.matchConfidence ?? "",
    baseConfidence: meta.baseConfidence ?? "",
    variantDecision: meta.variantDecision || "",
    variantConfidence: meta.variantConfidence ?? "",
    reason: meta.reason || "",
    productId: base.id || row.baseId || row.id || "",
    variantId: row.id || "",
    baseId: row.baseId || base.id || "",
    eciglogistica_url: meta.eciglogistica_url || (side === "eciglogistica" ? (row.url || base.url || "") : ""),
    vaperalia_url: meta.vaperalia_url || (side === "vaperalia" ? (row.url || base.url || "") : ""),
    distributor: value(row, base, "distributor"),
    url: row.url || base.url || "",
    baseUrl: row.baseUrl || base.url || "",
    title: row.title || base.title || "",
    description: value(row, base, "description"),
    baseTitle: row.baseTitle || base.title || "",
    category: value(row, base, "category"),
    sourceCategories: base.sourceCategories || "",
    brand: value(row, base, "brand"),
    brandCandidates: value(row, base, "brandCandidates"),
    commercialBrand: value(row, base, "commercialBrand"),
    productLine: value(row, base, "productLine"),
    breadcrumbPath: value(row, base, "breadcrumbPath"),
    metaDescription: value(row, base, "metaDescription"),
    productType,
    typeGroup: typeGroup(productType),
    reference: value(row, base, "reference"),
    syntheticReference: value(row, base, "syntheticReference"),
    baseKey: base.baseKey || "",
    variantCount: base.variantCount || "",
    variantSummary: base.variantSummary || "",
    variantValues: base.variantValues || row.variantValues || "",
    sku: row.sku || "",
    priceTaxExcluded: row.priceTaxExcluded || "",
    minPriceTaxExcluded: base.minPriceTaxExcluded || "",
    maxPriceTaxExcluded: base.maxPriceTaxExcluded || "",
    sourceFiles: base.sourceFiles || "",
    variantSignature: row.variantSignature || "",
    variantLabel: row.variantLabel || "",
    color: row.color || "",
    reference_color: row.reference_color || "",
    derived_reference_color: row.derived_reference_color || "",
    effective_color: effectiveColor(row),
    pod_type: row.pod_type || "",
    nicotina: row.nicotina || "",
    capacidad: row.capacidad || "",
    contenido_ml: row.contenido_ml || "",
    bote_ml: row.bote_ml || "",
    resistencia: row.resistencia || "",
    base_ratio: row.base_ratio || "",
    sabor: row.sabor || "",
    cafeina: row.cafeina || "",
    tamano: row.tamano || "",
    derivedJson: row.derivedJson || "",
    variantsJson: row.variantsJson || "",
    sourceFile: row.sourceFile || "",
  };
  out.comparison_hash = comparisonHash(out);
  return out;
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function writeReadme(filePath, summary) {
  const lines = [
    "# JSONs para carga maestra",
    "",
    "Generado desde el resultado final actual del pipeline.",
    "",
    "## Archivos",
    "",
    "- `master_matched_both.json`: referencias aceptadas como presentes en Eciglogistica y Vaperalia.",
    "- `master_only_eciglogistica.json`: referencias de Eciglogistica sin match aceptado.",
    "- `master_only_vaperalia.json`: referencias de Vaperalia sin match aceptado.",
    "- `master_one_to_many_rejected.json`: candidatos descartados por la proteccion uno-a-uno, con ambas URLs para revision humana.",
    "",
    "## Criterio usado",
    "",
    "- Fuente de matches aceptados: `outputs/general.matches.valid.json`.",
    "- Ese `general` ya incluye la capa `reviewed-rescues` aceptada.",
    "- No se usa `outputs/description-rescue-candidates.matches.valid.json`, porque contiene probables previos a la revision IA.",
    "- Estados aceptados como presentes en ambas: `valid` y `probable` del `general` final.",
    "- Todo lo que queda en los CSV preparados sin variante aceptada pasa a `only_eciglogistica` o `only_vaperalia`.",
    "- En `master_matched_both.json`, los campos comparativos de primer nivel salen de Eciglogistica, por decision de negocio indicada.",
    "- De Vaperalia solo se conserva la URL vinculada en `vaperalia_url`.",
    "",
    "## Conteos",
    "",
    `- matched_both: ${summary.matchedBoth}`,
    `- only_eciglogistica: ${summary.onlyEcig}`,
    `- only_vaperalia: ${summary.onlyVaperalia}`,
    `- matches valid: ${summary.matchedValid}`,
    `- matches probable: ${summary.matchedProbable}`,
    `- matches IA no determinista aceptados: ${summary.reviewedAccepted}`,
    `- pares duplicados exactos descartados: ${summary.duplicatePairsSkipped}`,
    `- candidatos uno-a-varios descartados: ${summary.oneToManyCandidatesSkipped}`,
    `- referencias Ecig aceptadas contra mas de una Vaperalia: ${summary.oneToManyEcigLinks}`,
    `- referencias Vaperalia aceptadas contra mas de una Ecig: ${summary.oneToManyVaperaliaLinks}`,
    `- variantes Ecig resueltas desde salida sintetica: ${summary.syntheticEcigMatches}`,
    `- variantes Vaperalia resueltas desde salida sintetica: ${summary.syntheticVaperaliaMatches}`,
    "",
    "## Sobre variantes explicitas",
    "",
    "Una variante explicita aqui significa una fila existente en los CSV preparados de variantes.",
    "Si el output del pipeline tenia una variante sintetica, por ejemplo `:description-rescue`, el generador intento resolverla contra la fila preparada por base, URL o titulo.",
    "Cuando una distribuidora agrupa varias variantes bajo la misma URL, no se considera error: se distinguen por `variantId`, `variantSignature`, `variantLabel` y campos de variante.",
    "",
    "## Campos",
    "",
    "Los campos usados para comparar no van anidados: estan como atributos de primer nivel de cada item.",
    "Se incluye `comparison_hash` como huella determinista de los campos comparativos normalizados.",
    "",
  ];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function duplicateGroups(map) {
  return [...map.entries()]
    .filter(([, items]) => items.length > 1)
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]));
}

const IDENTITY_STOP_WORDS = new Set([
  "a", "and", "aroma", "bote", "botella", "capacidad", "coil", "con", "de", "del",
  "e", "el", "en", "edition", "for", "la", "las", "los", "ml", "mg", "nic", "nicotine",
  "ohm", "pack", "para", "pcs", "pod", "replacement", "resistencia", "salt", "salts", "the",
  "unidades", "uds", "y",
]);

function identityTokens(value) {
  return normalize(value)
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length > 1 && !IDENTITY_STOP_WORDS.has(token));
}

function urlTitleIdentityScore(url, title) {
  const urlTokens = new Set(identityTokens(urlWithoutVariant(url)));
  const titleTokens = [...new Set(identityTokens(title))];
  if (!titleTokens.length) return 0;
  const shared = titleTokens.filter((token) => urlTokens.has(token)).length;
  return shared / titleTokens.length;
}

function candidatePriority(product, variant, ecigResolved, vaperaliaResolved) {
  const reviewed = product.sourceDataset === "reviewed-rescues" || variant.reviewDecision === "accepted";
  const valid = variant.status === "valid";
  const baseConfidence = Number(product.baseConfidence || 0);
  const finalConfidence = Number(variant.finalConfidence || 0);
  const ecigTitle = variant.eciglogistica?.title || ecigResolved.row.title || "";
  const ecigUrl = variant.eciglogistica?.url || ecigResolved.row.url || "";
  const vaperaliaTitle = variant.vaperalia?.title || vaperaliaResolved.row.title || "";
  const vaperaliaUrl = variant.vaperalia?.url || vaperaliaResolved.row.url || "";
  const urlIdentity =
    urlTitleIdentityScore(ecigUrl, vaperaliaTitle)
    + urlTitleIdentityScore(vaperaliaUrl, ecigTitle);
  return [reviewed ? 1 : 0, valid ? 1 : 0, baseConfidence, finalConfidence, urlIdentity];
}

function compareCandidatePriority(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return right[index] - left[index];
  }
  return 0;
}

function writeAudit(filePath, summary, ecigDuplicates, vaperaliaDuplicates) {
  const lines = [
    "# Auditoria generacion JSON maestro",
    "",
    "Esta auditoria no corrige matches. Solo documenta situaciones detectadas al transformar el resultado final en tres JSONs.",
    "",
    "## Resumen",
    "",
    `- matched_both: ${summary.matchedBoth}`,
    `- only_eciglogistica: ${summary.onlyEcig}`,
    `- only_vaperalia: ${summary.onlyVaperalia}`,
    `- duplicados exactos de par descartados: ${summary.duplicatePairsSkipped}`,
    `- Ecig uno-a-varios: ${ecigDuplicates.length}`,
    `- Vaperalia uno-a-varios: ${vaperaliaDuplicates.length}`,
    "",
  ];

  function section(title, groups) {
    lines.push(`## ${title}`);
    lines.push("");
    if (!groups.length) {
      lines.push("Sin casos.");
      lines.push("");
      return;
    }
    for (const [key, items] of groups) {
      lines.push(`### ${key}`);
      lines.push("");
      for (const item of items) {
        lines.push(`- ${item.status} | Ecig: ${item.ecigTitle || "-"} | Vaperalia: ${item.vaperaliaUrl || "-"}`);
      }
      lines.push("");
    }
  }

  section("Referencias Ecig aceptadas contra mas de una Vaperalia", ecigDuplicates);
  section("Referencias Vaperalia aceptadas contra mas de una Ecig", vaperaliaDuplicates);
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function main() {
  const args = parseArgs(process.argv);
  const general = readJson(args.general);
  const ecig = loadSide(args.ecigBase, args.ecigVariants);
  const vaperalia = loadSide(args.vaperaliaBase, args.vaperaliaVariants);

  const acceptedStatuses = new Set(["valid", "probable"]);
  let matchedBoth = [];
  const matchedEcigVariantIds = new Set();
  const matchedVaperaliaVariantIds = new Set();
  const seenPairs = new Set();
  const ecigAcceptedMap = new Map();
  const vaperaliaAcceptedMap = new Map();
  let duplicatePairsSkipped = 0;
  let matchedValid = 0;
  let matchedProbable = 0;
  let reviewedAccepted = 0;
  let syntheticEcigMatches = 0;
  let syntheticVaperaliaMatches = 0;
  let oneToManyCandidatesSkipped = 0;
  const oneToManyRejected = [];

  for (const product of general.products || []) {
    for (const variant of product.variants || []) {
      if (!acceptedStatuses.has(variant.status)) continue;

      const ecigResolved = resolveVariant(variant.eciglogistica || {}, product.eciglogistica || {}, ecig, "Eciglogistica");
      const vaperaliaResolved = resolveVariant(variant.vaperalia || {}, product.vaperalia || {}, vaperalia, "Vaperalia");
      const ecigKey = ecigResolved.resolvedPreparedId || variant.eciglogistica?.variantId || "";
      const vaperaliaKey = vaperaliaResolved.resolvedPreparedId || variant.vaperalia?.variantId || "";
      const pairKey = `${ecigKey}|||${vaperaliaKey}`;
      if (seenPairs.has(pairKey)) {
        duplicatePairsSkipped += 1;
        continue;
      }
      seenPairs.add(pairKey);

      const ecigAcceptedKey = ecigResolved.resolvedPreparedId || variant.eciglogistica?.variantId || "";
      const vaperaliaAcceptedKey = vaperaliaResolved.resolvedPreparedId || variant.vaperalia?.variantId || "";
      const auditItem = {
        status: variant.status,
        ecigTitle: variant.eciglogistica?.title || ecigResolved.row.title || "",
        ecigUrl: variant.eciglogistica?.url || ecigResolved.row.url || "",
        vaperaliaTitle: variant.vaperalia?.title || vaperaliaResolved.row.title || "",
        vaperaliaUrl: variant.vaperalia?.url || vaperaliaResolved.row.url || "",
      };
      const record = recordFromRow({
        classification: "matched_both",
        side: "both",
        row: ecigResolved.row,
        base: ecigResolved.base,
        meta: {
          id: `matched_both:${sha256(pairKey).slice(0, 24)}`,
          matchStatus: variant.status,
          sourceDataset: product.sourceDataset || "general",
          sourceDatasetLabel: product.sourceDatasetLabel || "",
          matchConfidence: variant.finalConfidence ?? "",
          baseConfidence: product.baseConfidence ?? "",
          variantDecision: variant.variantDecision || "",
          variantConfidence: variant.variantConfidence ?? "",
          reason: variant.reason || product.reason || "",
          eciglogistica_url: variant.eciglogistica?.url || ecigResolved.row.url || "",
          vaperalia_url: variant.vaperalia?.url || vaperaliaResolved.row.url || "",
        },
      });
      record.__candidate = {
        pairKey,
        ecigAcceptedKey,
        vaperaliaAcceptedKey,
        ecigResolvedPreparedId: ecigResolved.resolvedPreparedId || "",
        vaperaliaResolvedPreparedId: vaperaliaResolved.resolvedPreparedId || "",
        auditItem,
        priority: candidatePriority(product, variant, ecigResolved, vaperaliaResolved),
        reviewed: product.sourceDataset === "reviewed-rescues" || variant.reviewDecision === "accepted",
        syntheticEcig: ecigResolved.resolution === "synthetic_output_variant",
        syntheticVaperalia: vaperaliaResolved.resolution === "synthetic_output_variant",
      };
      matchedBoth.push(record);
    }
  }

  const usedEcigKeys = new Set();
  const usedVaperaliaKeys = new Set();
  const selected = [];
  for (const record of [...matchedBoth].sort((left, right) => {
    const priority = compareCandidatePriority(left.__candidate.priority, right.__candidate.priority);
    return priority || left.__candidate.pairKey.localeCompare(right.__candidate.pairKey);
  })) {
    const candidate = record.__candidate;
    const ecigConflict = candidate.ecigAcceptedKey && usedEcigKeys.has(candidate.ecigAcceptedKey);
    const vaperaliaConflict = candidate.vaperaliaAcceptedKey && usedVaperaliaKeys.has(candidate.vaperaliaAcceptedKey);
    if (ecigConflict || vaperaliaConflict) {
      oneToManyCandidatesSkipped += 1;
      oneToManyRejected.push({
        id: record.id,
        eciglogistica_url: record.eciglogistica_url,
        vaperalia_url: record.vaperalia_url,
        sourceDataset: record.sourceDataset,
        matchConfidence: record.matchConfidence,
        baseConfidence: record.baseConfidence,
        reason: record.reason,
        conflictSide: ecigConflict && vaperaliaConflict ? "both" : ecigConflict ? "eciglogistica" : "vaperalia",
      });
      continue;
    }
    if (candidate.ecigAcceptedKey) usedEcigKeys.add(candidate.ecigAcceptedKey);
    if (candidate.vaperaliaAcceptedKey) usedVaperaliaKeys.add(candidate.vaperaliaAcceptedKey);
    if (candidate.ecigResolvedPreparedId) matchedEcigVariantIds.add(candidate.ecigResolvedPreparedId);
    if (candidate.vaperaliaResolvedPreparedId) matchedVaperaliaVariantIds.add(candidate.vaperaliaResolvedPreparedId);
    if (candidate.ecigAcceptedKey) {
      if (!ecigAcceptedMap.has(candidate.ecigAcceptedKey)) ecigAcceptedMap.set(candidate.ecigAcceptedKey, []);
      ecigAcceptedMap.get(candidate.ecigAcceptedKey).push(candidate.auditItem);
    }
    if (candidate.vaperaliaAcceptedKey) {
      if (!vaperaliaAcceptedMap.has(candidate.vaperaliaAcceptedKey)) vaperaliaAcceptedMap.set(candidate.vaperaliaAcceptedKey, []);
      vaperaliaAcceptedMap.get(candidate.vaperaliaAcceptedKey).push(candidate.auditItem);
    }
    if (candidate.syntheticEcig) syntheticEcigMatches += 1;
    if (candidate.syntheticVaperalia) syntheticVaperaliaMatches += 1;
    if (record.matchStatus === "valid") matchedValid += 1;
    if (record.matchStatus === "probable") matchedProbable += 1;
    if (candidate.reviewed) reviewedAccepted += 1;
    delete record.__candidate;
    selected.push(record);
  }
  matchedBoth = selected;

  const onlyEcig = [];
  for (const row of ecig.variantRows) {
    if (matchedEcigVariantIds.has(row.id)) continue;
    onlyEcig.push(recordFromRow({
      classification: "only_eciglogistica",
      side: "eciglogistica",
      row,
      base: ecig.baseById.get(row.baseId) || {},
      meta: {
        matchStatus: "only_eciglogistica",
        sourceDataset: "prepared_unmatched",
        sourceDatasetLabel: "Referencia sin match aceptado en Vaperalia",
        reason: "No existe match aceptado para esta referencia en el resultado final.",
      },
    }));
  }

  const onlyVaperalia = [];
  for (const row of vaperalia.variantRows) {
    if (matchedVaperaliaVariantIds.has(row.id)) continue;
    onlyVaperalia.push(recordFromRow({
      classification: "only_vaperalia",
      side: "vaperalia",
      row,
      base: vaperalia.baseById.get(row.baseId) || {},
      meta: {
        matchStatus: "only_vaperalia",
        sourceDataset: "prepared_unmatched",
        sourceDatasetLabel: "Referencia sin match aceptado en Eciglogistica",
        reason: "No existe match aceptado para esta referencia en el resultado final.",
      },
    }));
  }

  matchedBoth.sort((left, right) => String(left.brand).localeCompare(String(right.brand)) || String(left.title).localeCompare(String(right.title)) || String(left.variantLabel).localeCompare(String(right.variantLabel)));
  onlyEcig.sort((left, right) => String(left.brand).localeCompare(String(right.brand)) || String(left.title).localeCompare(String(right.title)) || String(left.variantLabel).localeCompare(String(right.variantLabel)));
  onlyVaperalia.sort((left, right) => String(left.brand).localeCompare(String(right.brand)) || String(left.title).localeCompare(String(right.title)) || String(left.variantLabel).localeCompare(String(right.variantLabel)));

  fs.mkdirSync(args.outDir, { recursive: true });
  writeJson(path.join(args.outDir, "master_matched_both.json"), matchedBoth);
  writeJson(path.join(args.outDir, "master_only_eciglogistica.json"), onlyEcig);
  writeJson(path.join(args.outDir, "master_only_vaperalia.json"), onlyVaperalia);
  writeJson(path.join(args.outDir, "master_one_to_many_rejected.json"), oneToManyRejected);
  const ecigDuplicates = duplicateGroups(ecigAcceptedMap);
  const vaperaliaDuplicates = duplicateGroups(vaperaliaAcceptedMap);
  const summary = {
    matchedBoth: matchedBoth.length,
    onlyEcig: onlyEcig.length,
    onlyVaperalia: onlyVaperalia.length,
    matchedValid,
    matchedProbable,
    reviewedAccepted,
    duplicatePairsSkipped,
    oneToManyCandidatesSkipped,
    oneToManyEcigLinks: ecigDuplicates.length,
    oneToManyVaperaliaLinks: vaperaliaDuplicates.length,
    syntheticEcigMatches,
    syntheticVaperaliaMatches,
  };
  writeReadme(path.join(args.outDir, "README.md"), summary);
  writeAudit(path.join(args.outDir, "AUDIT.md"), summary, ecigDuplicates, vaperaliaDuplicates);

  console.log(JSON.stringify({
    outDir: args.outDir,
    matched_both: matchedBoth.length,
    only_eciglogistica: onlyEcig.length,
    only_vaperalia: onlyVaperalia.length,
    matched_valid: matchedValid,
    matched_probable: matchedProbable,
    reviewed_accepted: reviewedAccepted,
    duplicate_pairs_skipped: duplicatePairsSkipped,
    one_to_many_candidates_skipped: oneToManyCandidatesSkipped,
    one_to_many_ecig_links: ecigDuplicates.length,
    one_to_many_vaperalia_links: vaperaliaDuplicates.length,
    synthetic_ecig_matches: syntheticEcigMatches,
    synthetic_vaperalia_matches: syntheticVaperaliaMatches,
  }, null, 2));
}

main();
