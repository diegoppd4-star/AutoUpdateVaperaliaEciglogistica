#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const workDir = path.resolve(args.workDir || args["work-dir"] || ".");
const outputsDir = path.join(workDir, "outputs");
const auditDir = path.resolve(args.outDir || args["out-dir"] || path.join(outputsDir, "audits"));
const jsonPath = path.join(auditDir, "product-conflicts.json");
const markdownPath = path.join(auditDir, "product-conflicts.md");

const decisionLedger = readJsonIfExists(path.join(outputsDir, "reviews", "description-rescue-decisions.json"));
const cardinalityRejected = readJsonIfExists(path.join(outputsDir, "master-json", "master_one_to_many_rejected.json")) || [];
const loaderReport = readJsonIfExists(path.join(workDir, "sql-loader", "run_output", "sql-loader-report.json"));
const masterRecords = readMasterRecords(path.join(outputsDir, "master-json"));
const masterById = new Map(masterRecords.map((record) => [String(record.id || ""), record]));
const masterByUrl = indexMasterUrls(masterRecords);
const findings = [];

for (const decision of decisionLedger?.decisions || []) {
  if (!new Set(["rejected", "needs_human"]).has(decision.decision)) continue;
  findings.push(normalizeFinding({
    type: decision.decision === "needs_human" ? "model_needs_human" : "model_rejected_match",
    status: decision.decision === "needs_human" ? "needs_human_review" : "kept_separate",
    requiresHumanReview: true,
    source: "codex_identity_review",
    id: decision.reviewId,
    ecigTitle: decision.evidence?.ecig?.title || decision.ecigTitle,
    ecigUrl: decision.evidence?.ecig?.url || decision.ecigUrl,
    vaperaliaTitle: decision.evidence?.vaperalia?.title || decision.vaperaliaTitle,
    vaperaliaUrl: decision.evidence?.vaperalia?.url || decision.vaperaliaUrl,
    reason: decision.reviewReason,
    confidence: decision.modelConfidence ?? decision.reviewConfidence ?? null,
    decisiveEvidence: decision.decisiveEvidence || [],
    ignoredNoise: decision.ignoredNoise || [],
  }));
}

for (const conflict of Array.isArray(cardinalityRejected) ? cardinalityRejected : []) {
  const ecigRecord = findByUrl(masterByUrl, conflict.eciglogistica_url);
  const vaperaliaRecord = findByUrl(masterByUrl, conflict.vaperalia_url);
  findings.push(normalizeFinding({
    type: "master_cardinality_rejected",
    status: "kept_separate",
    requiresHumanReview: true,
    source: "master_one_to_one_guard",
    id: conflict.id,
    ecigTitle: ecigRecord?.title,
    ecigUrl: conflict.eciglogistica_url,
    vaperaliaTitle: vaperaliaRecord?.title,
    vaperaliaUrl: conflict.vaperalia_url,
    reason: conflict.reason,
    confidence: conflict.matchConfidence ?? conflict.baseConfidence ?? null,
    conflictSide: conflict.conflictSide || null,
  }));
}

const dbResult = loaderReport?.dbResult || {};
appendLoaderFindings("database_split_reference_skipped", "load_skipped", true, dbResult.split_reference_conflict_sample);
appendLoaderFindings("database_ambiguous_link_skipped", "load_skipped", true, dbResult.ambiguous_url_variant_conflict_sample);
appendLoaderFindings("database_input_link_skipped", "load_skipped", true, dbResult.ambiguous_input_link_sample);
appendLoaderFindings("database_split_reference_repaired", "automatically_repaired", false, dbResult.split_reference_merge_sample);
appendLoaderFindings("database_ambiguous_link_repaired", "automatically_repaired", false, dbResult.ambiguous_url_variant_repair_sample);

findings.sort((left, right) =>
  Number(right.requiresHumanReview) - Number(left.requiresHumanReview)
  || left.type.localeCompare(right.type)
  || String(left.id).localeCompare(String(right.id))
);

const byType = Object.fromEntries(
  [...new Set(findings.map((finding) => finding.type))]
    .sort()
    .map((type) => [type, findings.filter((finding) => finding.type === type).length])
);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  purpose: "Resumen consolidado para comprobacion humana de conflictos de identidad, cardinalidad y carga.",
  policy: {
    unmatchedCatalogItemsAreNotConflicts: true,
    rejectedMatchesRemainSeparate: true,
    everyFindingIncludesBothUrlFields: true,
  },
  summary: {
    totalFindings: findings.length,
    requiresHumanReview: findings.filter((finding) => finding.requiresHumanReview).length,
    automaticallyResolved: findings.filter((finding) => !finding.requiresHumanReview).length,
    byType,
  },
  findings,
};

fs.mkdirSync(auditDir, { recursive: true });
fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
fs.writeFileSync(markdownPath, renderMarkdown(report), "utf8");
printConsoleSummary(report);

function appendLoaderFindings(type, status, requiresHumanReview, samples) {
  for (const sample of Array.isArray(samples) ? samples : []) {
    const master = masterById.get(String(sample.source_id || ""));
    const linkUrls = extractUrls(sample);
    findings.push(normalizeFinding({
      type,
      status,
      requiresHumanReview,
      source: "postgres_loader",
      id: sample.source_id || null,
      ecigTitle: master?.side === "eciglogistica" || master?.side === "both" ? master.title : null,
      ecigUrl: master?.eciglogistica_url || (master?.side === "eciglogistica" ? master.url : null) || linkUrls.ecig,
      vaperaliaTitle: master?.side === "vaperalia" || master?.side === "both" ? master.title : null,
      vaperaliaUrl: master?.vaperalia_url || (master?.side === "vaperalia" ? master.url : null) || linkUrls.vaperalia,
      reason: loaderReason(type, sample),
      databaseContext: sample,
    }));
  }
}

function normalizeFinding(value) {
  return {
    type: value.type,
    status: value.status,
    requiresHumanReview: Boolean(value.requiresHumanReview),
    source: value.source,
    id: value.id || null,
    products: {
      eciglogistica: {
        title: value.ecigTitle || null,
        url: value.ecigUrl || null,
      },
      vaperalia: {
        title: value.vaperaliaTitle || null,
        url: value.vaperaliaUrl || null,
      },
    },
    reason: value.reason || "Sin motivo detallado.",
    confidence: value.confidence ?? null,
    ...(value.conflictSide ? { conflictSide: value.conflictSide } : {}),
    ...(value.decisiveEvidence?.length ? { decisiveEvidence: value.decisiveEvidence } : {}),
    ...(value.ignoredNoise?.length ? { ignoredNoise: value.ignoredNoise } : {}),
    ...(value.databaseContext ? { databaseContext: value.databaseContext } : {}),
  };
}

function readMasterRecords(masterDir) {
  return ["master_matched_both.json", "master_only_eciglogistica.json", "master_only_vaperalia.json"]
    .flatMap((name) => readJsonIfExists(path.join(masterDir, name)) || []);
}

function indexMasterUrls(records) {
  const index = new Map();
  for (const record of records) {
    for (const url of [record.url, record.eciglogistica_url, record.vaperalia_url]) {
      for (const key of urlKeys(url)) {
        if (!index.has(key)) index.set(key, record);
      }
    }
  }
  return index;
}

function findByUrl(index, url) {
  for (const key of urlKeys(url)) {
    if (index.has(key)) return index.get(key);
  }
  return null;
}

function urlKeys(value) {
  const exact = String(value || "").trim().replace(/\/+$/, "").toLowerCase();
  if (!exact) return [];
  const base = exact.split("#")[0].replace(/\/+$/, "");
  return exact === base ? [exact] : [exact, base];
}

function extractUrls(value) {
  const urls = [];
  walk(value, (key, item) => {
    if (key.toLowerCase() === "url" && typeof item === "string") urls.push(item);
  });
  return {
    ecig: urls.find((url) => url.includes("eciglogistica")) || null,
    vaperalia: urls.find((url) => url.includes("vaperalia")) || null,
  };
}

function walk(value, visit, key = "") {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, key);
  } else if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) walk(child, visit, childKey);
  } else {
    visit(key, value);
  }
}

function loaderReason(type, sample) {
  const reason = sample.merge_blocker?.reason || sample.repair_blocker?.reason || sample.repair;
  if (reason) return reason;
  if (type.endsWith("repaired")) return "Conflicto previo resuelto automaticamente por el loader.";
  return "El loader omitio esta asociacion para evitar una vinculacion ambigua.";
}

function renderMarkdown(report) {
  const lines = [
    "# Conflictos de productos",
    "",
    `Generado: ${report.generatedAt}`,
    "",
    "Este informe reúne los emparejamientos rechazados, los conflictos uno-a-varios y los conflictos detectados durante la carga. Los productos sin pareja no aparecen aquí: no tener pareja no es por sí mismo un conflicto.",
    "",
    "## Resumen",
    "",
    `- Hallazgos: ${report.summary.totalFindings}`,
    `- Recomendados para comprobación humana: ${report.summary.requiresHumanReview}`,
    `- Reparados automáticamente: ${report.summary.automaticallyResolved}`,
    ...Object.entries(report.summary.byType).map(([type, count]) => `- ${type}: ${count}`),
    "",
  ];
  if (!report.findings.length) {
    lines.push("No se detectaron conflictos.", "");
    return `${lines.join("\n")}\n`;
  }
  report.findings.forEach((finding, index) => {
    lines.push(`## ${index + 1}. ${finding.type} — ${finding.status}`, "");
    lines.push(`- Revisión humana: ${finding.requiresHumanReview ? "sí" : "no; reparado automáticamente"}`);
    lines.push(`- Eciglogistica: ${markdownProduct(finding.products.eciglogistica)}`);
    lines.push(`- Vaperalia: ${markdownProduct(finding.products.vaperalia)}`);
    lines.push(`- Motivo: ${finding.reason}`);
    if (finding.confidence != null) lines.push(`- Confianza: ${finding.confidence}`);
    if (finding.conflictSide) lines.push(`- Lado en conflicto: ${finding.conflictSide}`);
    lines.push("");
  });
  return `${lines.join("\n")}\n`;
}

function markdownProduct(product) {
  const title = product.title || "Producto sin título disponible";
  return product.url ? `${title} — <${product.url}>` : `${title} — URL no disponible para este lado`;
}

function printConsoleSummary(report) {
  console.log("Resumen de conflictos de productos");
  console.log(JSON.stringify(report.summary, null, 2));
  for (const finding of report.findings) {
    console.log(`\n[${finding.type}] ${finding.status}: ${finding.reason}`);
    console.log(`  Eciglogistica: ${finding.products.eciglogistica.title || "-"}`);
    console.log(`  URL Eciglogistica: ${finding.products.eciglogistica.url || "-"}`);
    console.log(`  Vaperalia: ${finding.products.vaperalia.title || "-"}`);
    console.log(`  URL Vaperalia: ${finding.products.vaperalia.url || "-"}`);
  }
  console.log(`\nInforme JSON: ${jsonPath}`);
  console.log(`Informe humano: ${markdownPath}`);
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      index += 1;
    }
  }
  return out;
}
