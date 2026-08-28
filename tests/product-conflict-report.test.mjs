import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reporter = path.join(root, "tools", "generate-product-conflict-report.mjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("conflict report consolidates decisions and preserves both supplier URLs", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "product-conflict-report-"));
  const workDir = path.join(temp, "pipeline-work");
  const outputs = path.join(workDir, "outputs");
  const ecigUrl = "https://nueva.eciglogistica.com/example-a";
  const vaperaliaUrl = "https://vaperalia.es/example-b#/variant";

  writeJson(path.join(outputs, "reviews", "description-rescue-decisions.json"), {
    decisions: [
      {
        reviewId: "rejected-1",
        decision: "rejected",
        modelConfidence: 99,
        reviewReason: "Different named edition.",
        evidence: {
          ecig: { title: "Example base", url: ecigUrl },
          vaperalia: { title: "Example Green Edition", url: vaperaliaUrl },
        },
      },
      {
        reviewId: "accepted-1",
        decision: "accepted",
        evidence: {
          ecig: { title: "Accepted A", url: "https://nueva.eciglogistica.com/accepted" },
          vaperalia: { title: "Accepted B", url: "https://vaperalia.es/accepted" },
        },
      },
    ],
  });
  writeJson(path.join(outputs, "master-json", "master_one_to_many_rejected.json"), [{
    id: "cardinality-1",
    eciglogistica_url: "https://nueva.eciglogistica.com/crown-v",
    vaperalia_url: "https://vaperalia.es/crown-x",
    reason: "Model generation conflict.",
    conflictSide: "vaperalia",
  }]);
  writeJson(path.join(outputs, "master-json", "master_matched_both.json"), []);
  writeJson(path.join(outputs, "master-json", "master_only_eciglogistica.json"), []);
  writeJson(path.join(outputs, "master-json", "master_only_vaperalia.json"), []);

  try {
    const result = spawnSync(process.execPath, [reporter, "--work-dir", workDir], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const reportPath = path.join(outputs, "audits", "product-conflicts.json");
    const markdownPath = path.join(outputs, "audits", "product-conflicts.md");
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.summary.totalFindings, 2);
    assert.equal(report.summary.requiresHumanReview, 2);
    assert.deepEqual(report.summary.byType, {
      master_cardinality_rejected: 1,
      model_rejected_match: 1,
    });
    const rejected = report.findings.find((finding) => finding.id === "rejected-1");
    assert.equal(rejected.products.eciglogistica.url, ecigUrl);
    assert.equal(rejected.products.vaperalia.url, vaperaliaUrl);
    assert.ok(report.findings.every((finding) =>
      Object.hasOwn(finding.products.eciglogistica, "url")
      && Object.hasOwn(finding.products.vaperalia, "url")
    ));
    const markdown = fs.readFileSync(markdownPath, "utf8");
    assert.match(markdown, new RegExp(ecigUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(markdown, new RegExp(vaperaliaUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(markdown, /Accepted A|Accepted B/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
