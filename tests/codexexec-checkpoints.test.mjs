import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generator = path.join(
  root,
  "pipeline_sagrado",
  "PIPELINE SAGRADO",
  "04_ANEXO_CAPA_IA_NO_DETERMINISTA",
  "generate-description-rescue-decisions-codexexec.js"
);

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runGenerator(paths, extraArgs = [], extraEnv = {}) {
  return spawnSync(process.execPath, [
    generator,
    "--rescue", paths.rescue,
    "--rescue-audit", paths.audit,
    "--original-scrape", paths.scrape,
    "--out", paths.out,
    "--prompt-out", paths.prompt,
    "--checkpoint-dir", paths.checkpoints,
    "--batch-size", "1",
    "--codex-path", paths.fakeCodex,
    "--reasoning-effort", "max",
    ...extraArgs,
  ], {
    cwd: root,
    env: {
      ...process.env,
      FAKE_CODEX_COUNTER: paths.counter,
      FAKE_CODEX_LAST_ARGS: paths.lastArgs,
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

test("CodexExec persists, reuses and invalidates batch checkpoints", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codexexec-checkpoint-test-"));
  const paths = {
    rescue: path.join(temp, "rescue.json"),
    audit: path.join(temp, "audit.md"),
    scrape: path.join(temp, "scrape.json"),
    out: path.join(temp, "reviews", "ledger.json"),
    prompt: path.join(temp, "reviews", "prompt.json"),
    checkpoints: path.join(temp, "reviews", "batches"),
    counter: path.join(temp, "counter.txt"),
    lastArgs: path.join(temp, "last-args.json"),
    fakeCodex: path.join(temp, "fake-codex.mjs"),
  };

  writeJson(paths.rescue, {
    products: [{
      status: "probable",
      baseConfidence: 0.8,
      reason: "synthetic",
      eciglogistica: { productId: "ecig-product", title: "Ecig product", url: "https://example.test/ecig" },
      vaperalia: { productId: "vape-product", title: "Vape product", url: "https://example.test/vape" },
      variants: [{
        eciglogistica: { variantId: "ecig-variant", title: "Ecig variant", url: "https://example.test/ecig#one" },
        vaperalia: { variantId: "vape-variant", title: "Vape variant", url: "https://example.test/vape#one" },
      }],
    }],
  });
  writeJson(paths.scrape, []);
  fs.writeFileSync(paths.audit, "synthetic audit\n", "utf8");
  fs.writeFileSync(paths.fakeCodex, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_CODEX_LAST_ARGS, JSON.stringify(args), "utf8");
const output = args[args.indexOf("--output-last-message") + 1];
const counter = process.env.FAKE_CODEX_COUNTER;
const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
fs.writeFileSync(counter, String(count + 1), "utf8");
let input = "";
for await (const chunk of process.stdin) input += chunk;
if (process.env.FAKE_CODEX_FAIL === "1") {
  console.error("fake failure user@example.test api_key=supersecret");
  process.exit(23);
}
const marker = "CANDIDATE_PAIRS_JSON\\n";
const candidates = JSON.parse(input.slice(input.lastIndexOf(marker) + marker.length));
const decisions = candidates.map((candidate) => ({
  id: candidate.id,
  label: "DIFFERENT",
  confidence: 40,
  reason: "synthetic rejection",
  decisiveEvidence: [],
  ignoredNoise: []
}));
fs.writeFileSync(output, JSON.stringify({ decisions }), "utf8");
`, "utf8");
  fs.chmodSync(paths.fakeCodex, 0o755);

  try {
    const first = runGenerator(paths);
    assert.equal(first.status, 0, `${first.error?.stack || ""}\n${first.stderr}\n${first.stdout}`);
    assert.equal(fs.readFileSync(paths.counter, "utf8"), "1");
    assert.ok(JSON.parse(fs.readFileSync(paths.lastArgs, "utf8")).includes('model_reasoning_effort="max"'));
    assert.ok(fs.existsSync(path.join(paths.checkpoints, "batch-001.json")));
    assert.ok(fs.existsSync(paths.out));

    fs.rmSync(paths.out);
    const resumed = runGenerator(paths);
    assert.equal(resumed.status, 0, `${resumed.stderr}\n${resumed.stdout}`);
    assert.match(resumed.stderr, /Reutilizando checkpoint batch 1\/1/);
    assert.equal(fs.readFileSync(paths.counter, "utf8"), "1");
    assert.ok(fs.existsSync(paths.out));

    const invalidated = runGenerator(paths, ["--model", "different-model"]);
    assert.equal(invalidated.status, 0, `${invalidated.stderr}\n${invalidated.stdout}`);
    assert.match(invalidated.stderr, /Checkpoint descartado/);
    assert.equal(fs.readFileSync(paths.counter, "utf8"), "2");

    const effortChanged = runGenerator(paths, ["--model", "different-model", "--reasoning-effort", "high"]);
    assert.equal(effortChanged.status, 0, `${effortChanged.stderr}\n${effortChanged.stdout}`);
    assert.match(effortChanged.stderr, /Checkpoint descartado/);
    assert.equal(fs.readFileSync(paths.counter, "utf8"), "3");

    const failed = runGenerator(paths, ["--model", "failing-model"], { FAKE_CODEX_FAIL: "1" });
    assert.notEqual(failed.status, 0);
    const failurePath = path.join(paths.checkpoints, "batch-001.failure.json");
    const failure = fs.readFileSync(failurePath, "utf8");
    assert.match(failure, /\[EMAIL_REDACTED\]/);
    assert.match(failure, /api_key=\[REDACTED\]/);
    assert.doesNotMatch(failure, /user@example\.test|supersecret/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("CodexExec resolves the exact scrape row for grouped supplier variants", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codexexec-grouped-variant-test-"));
  const rescue = path.join(temp, "rescue.json");
  const audit = path.join(temp, "audit.md");
  const scrape = path.join(temp, "scrape.json");
  const out = path.join(temp, "ledger.json");
  const prompt = path.join(temp, "prompt.json");
  const groupedUrl = "https://supplier.test/ivg-neon";
  const selectedUrl = "https://retailer.test/ivg-neon#/20mg";

  writeJson(rescue, {
    products: [{
      status: "base_match",
      baseConfidence: 0.86,
      reason: "synthetic grouped variant",
      eciglogistica: { productId: "ecig-product", title: "IVG Neon", url: groupedUrl },
      vaperalia: { productId: "vape-product", title: "IVG Neon", url: "https://retailer.test/ivg-neon" },
      variants: [{
        eciglogistica: {
          variantId: "ecig-product:nicotina=20mg",
          title: "IVG Neon - 20mg",
          url: groupedUrl,
          variant: "nicotina: 20mg",
        },
        vaperalia: {
          variantId: "vape-product:nicotina=20mg",
          title: "IVG Neon - 20 mg / 10 ml",
          url: selectedUrl,
          variant: "nicotina: 20 mg; capacidad: 10 ml",
        },
      }],
    }],
  });
  writeJson(scrape, [
    { distributor: "Eciglogistica", name: "IVG Neon - 10mg", url: groupedUrl, variants: { MG: "10mg" } },
    { distributor: "Eciglogistica", name: "IVG Neon - 20mg", url: groupedUrl, variants: { MG: "20mg" } },
    { distributor: "Vaperalia", name: "IVG Neon - 20 mg / 10 ml", url: selectedUrl, variants: { Nicotina: "20 mg", Tamaño: "10 ml" } },
  ]);
  fs.writeFileSync(audit, "synthetic audit\n", "utf8");

  try {
    const result = spawnSync(process.execPath, [
      generator,
      "--rescue", rescue,
      "--rescue-audit", audit,
      "--original-scrape", scrape,
      "--out", out,
      "--prompt-out", prompt,
      "--dry-run",
    ], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const packet = JSON.parse(fs.readFileSync(prompt, "utf8"));
    assert.equal(packet.candidates.length, 1);
    assert.equal(packet.candidates[0].a.variants.MG, "20mg");
    assert.equal(packet.candidates[0].a.selectedBy, "exact_variant_title");
    assert.equal(packet.candidates[0].b.variants.Nicotina, "20 mg");
    assert.match(packet.identityPrompt, /Green Edition/);
    assert.match(packet.identityPrompt, /grouped product pages/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
