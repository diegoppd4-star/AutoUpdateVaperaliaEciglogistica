import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const promptPath = path.resolve(process.argv[2] || path.join(here, "prompts/iteration-01.txt"));
const resultName = process.argv[3] || path.basename(promptPath, path.extname(promptPath));
const dataset = JSON.parse(fs.readFileSync(path.join(here, "dataset.json"), "utf8"));
const instructions = fs.readFileSync(promptPath, "utf8").trim();
const candidates = dataset.pairs.map(({ id, set, a, b }) => ({ id, set, a, b }));
const input = `${instructions}\n\nCANDIDATE_PAIRS_JSON\n${JSON.stringify(candidates)}`;
const rawPath = path.join(here, "results", `${resultName}.raw.json`);
const reportPath = path.join(here, "results", `${resultName}.report.json`);

fs.mkdirSync(path.dirname(rawPath), { recursive: true });
const run = spawnSync("codex", [
  "exec",
  "--ephemeral",
  "--skip-git-repo-check",
  "--sandbox", "read-only",
  "--model", "gpt-5.6-luna",
  "--config", "model_reasoning_effort=\"max\"",
  "--output-schema", path.join(here, "output-schema.json"),
  "--output-last-message", rawPath,
  "-"
], {
  cwd: here,
  input,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024
});

if (run.status !== 0) {
  process.stderr.write(run.stderr || run.stdout || `codex exec failed with status ${run.status}\n`);
  process.exit(run.status || 1);
}

const response = JSON.parse(fs.readFileSync(rawPath, "utf8"));
const byId = new Map(response.decisions.map((decision) => [decision.id, decision]));
const comparisons = dataset.pairs.map((pair) => {
  const decision = byId.get(pair.id);
  return {
    id: pair.id,
    expected: pair.truth,
    actual: decision?.label || "MISSING",
    pass: decision?.label === pair.truth,
    confidence: decision?.confidence ?? null,
    reason: decision?.reason || null
  };
});
const missing = dataset.pairs.filter((pair) => !byId.has(pair.id)).map((pair) => pair.id);
const unexpected = response.decisions.filter((decision) => !dataset.pairs.some((pair) => pair.id === decision.id)).map((decision) => decision.id);
const report = {
  model: "gpt-5.6-luna",
  reasoningEffort: "max",
  prompt: path.relative(here, promptPath),
  total: comparisons.length,
  passed: comparisons.filter((item) => item.pass).length,
  failed: comparisons.filter((item) => !item.pass).length,
  missing,
  unexpected,
  success: comparisons.every((item) => item.pass) && missing.length === 0 && unexpected.length === 0,
  comparisons
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ reportPath, ...report }, null, 2));
