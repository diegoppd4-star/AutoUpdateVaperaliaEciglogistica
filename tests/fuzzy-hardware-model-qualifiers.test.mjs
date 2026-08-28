import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const matcher = path.join(
  root,
  "pipeline_sagrado",
  "PIPELINE SAGRADO",
  "01_PIPELINE_PRINCIPAL",
  "scripts",
  "fuzzy-hardware-base-matcher.js"
);

const headers = [
  "id",
  "title",
  "brand",
  "brandCandidates",
  "commercialBrand",
  "productLine",
  "breadcrumbPath",
  "description",
  "metaDescription",
  "reference",
  "syntheticReference",
  "baseKey",
  "url",
  "variantValues",
  "productType",
];

function csvValue(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(filePath, rows) {
  fs.writeFileSync(filePath, [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvValue(row[header])).join(",")),
  ].join("\n"), "utf8");
}

function readCsvRows(filePath) {
  const [header, ...lines] = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").trim().split("\n");
  const keys = header.split(",");
  return lines.map((line) => Object.fromEntries(keys.map((key, index) => [key, line.split(",")[index]])));
}

test("fuzzy hardware rejects a missing S3 generation qualifier", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fuzzy-model-qualifier-"));
  const a = path.join(temp, "a.csv");
  const b = path.join(temp, "b.csv");
  const out = path.join(temp, "out.csv");
  const common = { brand: "Lost Vape", brandCandidates: "Lost Vape", productType: "kit_device" };
  writeCsv(a, [{
    ...common,
    id: "s3",
    title: "Lost Vape Ursa Nano S3 Pod Kit",
    url: "https://supplier.test/lost-vape-ursa-nano-s3-pod-kit",
  }]);
  writeCsv(b, [{
    ...common,
    id: "original",
    title: "Ursa Nano 800mAh - Lost Vape",
    url: "https://retailer.test/ursa-nano-800mah",
  }]);

  try {
    const run = spawnSync(process.execPath, [
      matcher,
      "--a", a,
      "--b", b,
      "--out", out,
      "--brand", "Lost Vape",
      "--a-brand", "Lost Vape",
      "--b-brand", "Lost Vape",
      "--product-type", "kit_device",
      "--threshold", "0.1",
    ], { cwd: root, encoding: "utf8" });
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    const rows = readCsvRows(out);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].decision, "no_match");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("fuzzy hardware keeps equal S3 generation qualifiers matchable", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fuzzy-model-control-"));
  const a = path.join(temp, "a.csv");
  const b = path.join(temp, "b.csv");
  const out = path.join(temp, "out.csv");
  const common = { brand: "Lost Vape", brandCandidates: "Lost Vape", productType: "kit_device" };
  writeCsv(a, [{ ...common, id: "left", title: "Lost Vape Ursa Nano S3 Pod Kit", url: "https://a.test/ursa-nano-s3" }]);
  writeCsv(b, [{ ...common, id: "right", title: "Ursa Nano S3 Kit - Lost Vape", url: "https://b.test/ursa-nano-s3" }]);

  try {
    const run = spawnSync(process.execPath, [
      matcher,
      "--a", a,
      "--b", b,
      "--out", out,
      "--brand", "Lost Vape",
      "--a-brand", "Lost Vape",
      "--b-brand", "Lost Vape",
      "--product-type", "kit_device",
      "--threshold", "0.1",
    ], { cwd: root, encoding: "utf8" });
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    const rows = readCsvRows(out);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].decision, "match");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
