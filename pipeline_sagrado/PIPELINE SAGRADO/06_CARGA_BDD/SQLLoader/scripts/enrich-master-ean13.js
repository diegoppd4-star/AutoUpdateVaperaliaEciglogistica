#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const INPUT_DIR = path.join(ROOT, "input_master");
const CSV_PATH = path.join(ROOT, "Productos_cliente_Diego_Poole_Prieto.csv");
const REPORT_DIR = path.join(ROOT, "run_output");
const BACKUP_DIR = path.join(ROOT, "backups", `ean13-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const TARGET_FILES = ["master_matched_both.json", "master_only_eciglogistica.json"];

function normalizeHeader(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function parseCsv(text, delimiter = ";") {
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
    } else if (char === delimiter && !quoted) {
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
  const normalizedHeaders = headers.map(normalizeHeader);
  return rows.map((values) => Object.fromEntries(normalizedHeaders.map((header, index) => [header, values[index] || ""])));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function cleanReference(value) {
  return String(value || "").trim();
}

function cleanEan(value) {
  return String(value || "").trim().replace(/\.0$/, "");
}

function withEanAfterReference(record, ean13) {
  const out = {};
  let inserted = false;
  for (const [key, value] of Object.entries(record)) {
    if (key === "ean13") continue;
    out[key] = value;
    if (key === "reference") {
      out.ean13 = ean13;
      inserted = true;
    }
  }
  if (!inserted) out.ean13 = ean13;
  return out;
}

function buildEanIndex(csvRows) {
  const byArticle = new Map();
  for (const row of csvRows) {
    const article = cleanReference(row.articulo);
    const ean = cleanEan(row.eanindividual);
    if (!article) continue;
    if (!byArticle.has(article)) byArticle.set(article, new Set());
    if (ean) byArticle.get(article).add(ean);
  }

  const cleanIndex = new Map();
  const conflicts = [];
  const withoutEan = [];
  for (const [article, values] of byArticle.entries()) {
    if (values.size === 1) {
      cleanIndex.set(article, [...values][0]);
    } else if (values.size > 1) {
      conflicts.push({ article, eans: [...values].sort() });
    } else {
      withoutEan.push(article);
    }
  }
  return { cleanIndex, conflicts, withoutEan, totalArticles: byArticle.size };
}

function enrichFile(fileName, eanIndex) {
  const filePath = path.join(INPUT_DIR, fileName);
  const rows = readJson(filePath);
  fs.copyFileSync(filePath, path.join(BACKUP_DIR, fileName));

  const missingReferences = new Set();
  const conflictReferences = new Set();
  const enrichedReferences = new Set();
  const existingEanOverwritten = [];
  let enrichedRows = 0;

  const enriched = rows.map((record) => {
    const reference = cleanReference(record.reference);
    if (!reference) {
      missingReferences.add("");
      return record;
    }
    const ean = eanIndex.cleanIndex.get(reference);
    if (!ean) {
      if (eanIndex.conflictByArticle.has(reference)) conflictReferences.add(reference);
      else missingReferences.add(reference);
      return record;
    }
    if (record.ean13 && record.ean13 !== ean) {
      existingEanOverwritten.push({ id: record.id, reference, previous: record.ean13, next: ean });
    }
    enrichedRows += 1;
    enrichedReferences.add(reference);
    return withEanAfterReference(record, ean);
  });

  writeJson(filePath, enriched);
  return {
    fileName,
    rows: rows.length,
    enrichedRows,
    uniqueReferences: new Set(rows.map((row) => cleanReference(row.reference)).filter(Boolean)).size,
    enrichedReferences: enrichedReferences.size,
    missingReferences: [...missingReferences].filter(Boolean).sort(),
    conflictReferences: [...conflictReferences].sort(),
    existingEanOverwritten,
  };
}

function main() {
  if (!fs.existsSync(CSV_PATH)) throw new Error(`No existe CSV: ${CSV_PATH}`);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const csvRows = parseCsv(fs.readFileSync(CSV_PATH, "utf8"));
  const eanIndex = buildEanIndex(csvRows);
  eanIndex.conflictByArticle = new Map(eanIndex.conflicts.map((item) => [item.article, item.eans]));

  const files = TARGET_FILES.map((fileName) => enrichFile(fileName, eanIndex));
  const report = {
    generatedAt: new Date().toISOString(),
    csvPath: CSV_PATH,
    inputDir: INPUT_DIR,
    backupDir: BACKUP_DIR,
    csvRows: csvRows.length,
    csvArticles: eanIndex.totalArticles,
    csvArticlesWithUniqueEan: eanIndex.cleanIndex.size,
    csvArticlesWithoutEan: eanIndex.withoutEan.length,
    csvArticleConflicts: eanIndex.conflicts.length,
    conflictSample: eanIndex.conflicts.slice(0, 50),
    files,
  };

  const reportJson = path.join(REPORT_DIR, "ean13-enrichment-report.json");
  const reportMd = path.join(REPORT_DIR, "ean13-enrichment-report.md");
  writeJson(reportJson, report);

  const lines = [
    "# Enriquecimiento EAN13",
    "",
    `CSV: \`${CSV_PATH}\``,
    `Backup: \`${BACKUP_DIR}\``,
    "",
    "## Resumen CSV",
    "",
    `- Filas CSV: ${report.csvRows}`,
    `- Articulos CSV: ${report.csvArticles}`,
    `- Articulos con EAN unico: ${report.csvArticlesWithUniqueEan}`,
    `- Articulos sin EAN: ${report.csvArticlesWithoutEan}`,
    `- Articulos con conflicto de EAN: ${report.csvArticleConflicts}`,
    "",
    "## JSON enriquecidos",
    "",
    "| Archivo | Filas | Filas con EAN añadido | Referencias únicas | Referencias únicas enriquecidas | Referencias sin EAN | Conflictos |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const file of files) {
    lines.push(`| ${file.fileName} | ${file.rows} | ${file.enrichedRows} | ${file.uniqueReferences} | ${file.enrichedReferences} | ${file.missingReferences.length} | ${file.conflictReferences.length} |`);
  }
  lines.push("", "## Muestras de referencias sin EAN", "");
  for (const file of files) {
    lines.push(`### ${file.fileName}`, "");
    if (!file.missingReferences.length) {
      lines.push("Sin faltantes.", "");
    } else {
      for (const reference of file.missingReferences.slice(0, 100)) lines.push(`- ${reference}`);
      if (file.missingReferences.length > 100) lines.push(`- ... ${file.missingReferences.length - 100} mas`);
      lines.push("");
    }
  }
  fs.writeFileSync(reportMd, `${lines.join("\n")}\n`, "utf8");
  console.log(JSON.stringify({
    ok: true,
    reportJson,
    reportMd,
    backupDir: BACKUP_DIR,
    files: files.map((file) => ({
      fileName: file.fileName,
      rows: file.rows,
      enrichedRows: file.enrichedRows,
      uniqueReferences: file.uniqueReferences,
      enrichedReferences: file.enrichedReferences,
      missingReferences: file.missingReferences.length,
      conflictReferences: file.conflictReferences.length,
    })),
  }, null, 2));
}

main();
