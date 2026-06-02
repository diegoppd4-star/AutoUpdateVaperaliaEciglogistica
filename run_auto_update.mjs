#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.dirname(fileURLToPath(import.meta.url));

const args = parseArgs(process.argv.slice(2));
const runName = args.runName || args["run-name"] || "";
const outputRoot = path.resolve(args.outputRoot || args["output-root"] || path.join(root, "runs"));
const runDir = path.join(outputRoot, safeRunName(runName));
const inputDir = path.join(runDir, "input");
const pipelineWorkDir = path.join(runDir, "pipeline-work");
const pipelineRoot = path.join(root, "pipeline_sagrado", "PIPELINE SAGRADO");
const scraperRoot = path.join(root, "scraper");
const toolsRoot = path.join(root, "tools");

const inputJson = args.inputJson || args["input-json"] || "";
const scraperCommand = args.scraperCommand || args["scraper-command"] || "";
const scraperOutputJson = args.scraperOutputJson || args["scraper-output-json"] || "";
const scraperConnector = args.scraperConnector || args["scraper-connector"] || "all";
const scraperLimit = Number(args.scraperLimit || args["scraper-limit"] || 0);
const scraperConcurrency = Number(args.scraperConcurrency || args["scraper-concurrency"] || 5);
const scraperCategories = args.scraperCategories || args["scraper-categories"] || "";
const scraperDebug = Boolean(args.scraperDebug || args["scraper-debug"]);
const skipScraperInstall = Boolean(args.skipScraperInstall || args["skip-scraper-install"]);
const skipPlaywrightInstall = Boolean(args.skipPlaywrightInstall || args["skip-playwright-install"]);
const skipCodexExec = Boolean(args.skipCodexExec || args["skip-codex-exec"]);
const skipBuildMaster = Boolean(args.skipBuildMaster || args["skip-build-master"]);
const loadBdd = Boolean(args.loadBdd || args["load-bdd"]);
const onlyBuildMaster = Boolean(args.onlyBuildMaster || args["only-build-master"]);
const onlyLoadBdd = Boolean(args.onlyLoadBdd || args["only-load-bdd"]);
const loadBddDryRun = Boolean(args.loadBddDryRun || args["load-bdd-dry-run"]);
const skipEanEnrichment = Boolean(args.skipEanEnrichment || args["skip-ean-enrichment"]);
const dryRun = Boolean(args.dryRun || args["dry-run"]);
const codexBatchSize = Number(args.codexBatchSize || args["codex-batch-size"] || 20);
const codexModel = args.codexModel || args["codex-model"] || "";
const bddBatchSize = Number(args.bddBatchSize || args["bdd-batch-size"] || 1000);
const fromRun = args.fromRun || args["from-run"] || "";

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});

async function main() {
  if (args.help || args.h) {
    printHelp();
    return;
  }

  if (onlyBuildMaster) {
    const existingRunDir = resolveExistingRunDir(fromRun);
    runBuildMaster(path.join(existingRunDir, "pipeline-work"));
    return;
  }

  if (onlyLoadBdd) {
    const existingRunDir = resolveExistingRunDir(fromRun);
    const existingWorkDir = path.join(existingRunDir, "pipeline-work");
    ensureMasterJson(existingWorkDir);
    runLoadBdd(existingWorkDir);
    return;
  }

  if (!fs.existsSync(pipelineRoot)) {
    throw new Error(`No se encuentra Pipeline Sagrado autocontenido: ${pipelineRoot}`);
  }

  fs.mkdirSync(inputDir, { recursive: true });

  console.log("AutoUpdateVaperaliaEciglogistica");
  console.log(`RunDir: ${runDir}`);
  console.log(`Node: ${process.execPath}`);
  console.log(`Pipeline: ${pipelineRoot}`);
  console.log(`Scraper integrado: ${scraperRoot}`);

  if (!skipCodexExec && !dryRun) {
    runCodexExecPreflight();
  }

  let scrapeJson = path.join(inputDir, "scrape.json");

  step("Entrada de scrapeo");
  if (inputJson) {
    const resolved = path.resolve(inputJson);
    fs.copyFileSync(resolved, scrapeJson);
    console.log(`Usando JSON ya scrapeado: ${resolved}`);
  } else if (scraperCommand) {
    scrapeJson = scraperOutputJson ? path.resolve(scraperOutputJson) : scrapeJson;
    const env = {
      ...process.env,
      AUTOUPDATE_SCRAPE_OUTPUT_JSON: scrapeJson,
      AUTOUPDATE_RUN_DIR: runDir,
    };
    runShell(scraperCommand, { cwd: root, env });
    if (!fs.existsSync(scrapeJson)) {
      throw new Error(`El scraper externo no genero el JSON esperado: ${scrapeJson}`);
    }
  } else {
    scrapeJson = runBundledScraper(scrapeJson);
  }
  console.log(`Scrape JSON de trabajo: ${scrapeJson}`);

  step("Validacion de contrato del scrapeo");
  const validationReport = path.join(runDir, "validation-report.json");
  runNode(path.join(toolsRoot, "validate-scrape-contract.js"), [
    "--input", scrapeJson,
    "--out", validationReport,
  ]);
  console.log(`Contrato OK: ${validationReport}`);

  if (dryRun) {
    writeSummary({
      mode: "dry-run",
      runDir,
      scrapeJson,
      validationReport,
      pipelineWorkDir,
      codexExec: !skipCodexExec,
    });
    console.log("DryRun activo: se ha validado la entrada, no se ejecutan los pipelines.");
    return;
  }

  runPipeline1(scrapeJson);
  runPipeline2();

  if (skipCodexExec) {
    console.log("SkipCodexExec activo: no se ejecuta la capa IA no determinista.");
  } else {
    runPipeline3(scrapeJson);
  }

  const outputsDir = path.join(pipelineWorkDir, "outputs");
  const masterJsonDir = path.join(outputsDir, "master-json");
  if (skipBuildMaster) {
    console.log("SkipBuildMaster activo: no se generan master JSON para BDD.");
  } else {
    runBuildMaster(pipelineWorkDir);
  }
  if (loadBdd) {
    runLoadBdd(pipelineWorkDir);
  }

  writeSummary({
    mode: "completed",
    runDir,
    scrapeJson,
    validationReport,
    pipelineWorkDir,
    outputsDir,
    generalMatches: path.join(outputsDir, "general.matches.valid.json"),
    descriptionRescueCandidates: path.join(outputsDir, "description-rescue-candidates.matches.valid.json"),
    reviewedRescues: skipCodexExec ? null : path.join(outputsDir, "reviewed-rescues.matches.valid.json"),
    reviewedRescuesAudit: skipCodexExec ? null : path.join(outputsDir, "audits", "reviewed-rescues.audit.md"),
    codexDecisionLedger: skipCodexExec ? null : path.join(outputsDir, "reviews", "description-rescue-decisions.json"),
    masterJsonDir: skipBuildMaster ? null : masterJsonDir,
    masterMatchedBoth: skipBuildMaster ? null : path.join(masterJsonDir, "master_matched_both.json"),
    masterOnlyEciglogistica: skipBuildMaster ? null : path.join(masterJsonDir, "master_only_eciglogistica.json"),
    masterOnlyVaperalia: skipBuildMaster ? null : path.join(masterJsonDir, "master_only_vaperalia.json"),
    bddLoadReport: loadBdd ? path.join(pipelineWorkDir, "sql-loader", "run_output", "sql-loader-report.json") : null,
  });
}

function runBundledScraper(targetScrapeJson) {
  if (!fs.existsSync(scraperRoot)) {
    throw new Error(`No se encuentra el scraper integrado: ${scraperRoot}`);
  }

  const scraperOutputDir = path.join(runDir, "scraper-output");
  const scraperDebugDir = path.join(runDir, "scraper-debug");
  fs.mkdirSync(scraperOutputDir, { recursive: true });

  console.log("Ejecutando scraper integrado.");
  console.log(`Connector: ${scraperConnector}`);
  console.log(`Limit: ${scraperLimit}`);
  console.log(`Concurrency: ${scraperConcurrency}`);
  console.log(`Scraper output: ${scraperOutputDir}`);

  if (!skipScraperInstall && !fs.existsSync(path.join(scraperRoot, "node_modules"))) {
    runCommand(npmCommand(), ["ci"], { cwd: scraperRoot });
  }

  if (!skipPlaywrightInstall) {
    runCommand(npmCommand(), ["exec", "--", "playwright", "install", "chromium"], { cwd: scraperRoot });
  }

  runCommand(npmCommand(), ["run", "build"], { cwd: scraperRoot });

  const scraperArgs = [
    path.join(scraperRoot, "dist", "index.js"),
    "--connector", scraperConnector,
    "--concurrency", String(scraperConcurrency),
    "--output-dir", scraperOutputDir,
  ];
  if (scraperLimit > 0) scraperArgs.push("--limit", String(scraperLimit));
  if (scraperCategories) scraperArgs.push("--categories", scraperCategories);
  if (scraperDebug) scraperArgs.push("--debug", "--debug-dir", scraperDebugDir);

  runCommand(process.execPath, scraperArgs, { cwd: scraperRoot });

  const generated = path.join(scraperOutputDir, "output.json");
  if (!fs.existsSync(generated)) {
    throw new Error(`El scraper integrado no genero el JSON esperado: ${generated}`);
  }
  fs.copyFileSync(generated, targetScrapeJson);
  return targetScrapeJson;
}

function runPipeline1(scrapeJson) {
  step("Pipeline 1 - matching determinista principal");
  if (fs.existsSync(pipelineWorkDir)) {
    throw new Error(`WorkDir ya existe: ${pipelineWorkDir}`);
  }
  fs.mkdirSync(pipelineWorkDir, { recursive: true });
  fs.cpSync(path.join(pipelineRoot, "01_PIPELINE_PRINCIPAL", "scripts"), path.join(pipelineWorkDir, "scripts"), { recursive: true });
  fs.cpSync(path.join(pipelineRoot, "03_INPUTS"), path.join(pipelineWorkDir, "inputs"), { recursive: true });
  fs.mkdirSync(path.join(pipelineWorkDir, "outputs", "prepared"), { recursive: true });

  const scripts = path.join(pipelineWorkDir, "scripts");
  const prepared = path.join(pipelineWorkDir, "outputs", "prepared");
  runNode(path.join(scripts, "prepare-products-json.js"), ["--in", scrapeJson, "--distributor", "Eciglogistica", "--base-out", path.join(prepared, "eciglogistica__output.base.csv"), "--variants-out", path.join(prepared, "eciglogistica__output.variants.csv")], pipelineWorkDir);
  runNode(path.join(scripts, "prepare-products-json.js"), ["--in", scrapeJson, "--distributor", "Vaperalia", "--base-out", path.join(prepared, "vaperalia__output.base.csv"), "--variants-out", path.join(prepared, "vaperalia__output.variants.csv")], pipelineWorkDir);
  runNode(path.join(scripts, "run-fuzzy-hardware-tramos.js"), ["--tramos-file", path.join(pipelineWorkDir, "inputs", "tramos_full_2026-05-14.txt")], pipelineWorkDir);
  runNode(path.join(scripts, "build-inverse-vaperalia-audit.js"), [], pipelineWorkDir);
  runNode(path.join(scripts, "build-catalog-filtered-unmatched.js"), [], pipelineWorkDir);
  runNode(path.join(scripts, "build-dataset-manifest.js"), [], pipelineWorkDir);
  runNode(path.join(scripts, "build-general-dataset.js"), [], pipelineWorkDir);
}

function runPipeline2() {
  step("Pipeline 2 - rescate determinista por descripcion");
  assertFiles([
    path.join(pipelineWorkDir, "outputs", "general.matches.valid.json"),
    path.join(pipelineWorkDir, "outputs", "prepared", "eciglogistica__output.base.csv"),
    path.join(pipelineWorkDir, "outputs", "prepared", "vaperalia__output.base.csv"),
    path.join(pipelineWorkDir, "outputs", "prepared", "eciglogistica__output.variants.csv"),
    path.join(pipelineWorkDir, "outputs", "prepared", "vaperalia__output.variants.csv"),
  ]);
  fs.cpSync(path.join(pipelineRoot, "02_PIPELINE_RESCATE_DESCRIPCION", "scripts"), path.join(pipelineWorkDir, "scripts"), { recursive: true, force: true });

  const scripts = path.join(pipelineWorkDir, "scripts");
  const outputs = path.join(pipelineWorkDir, "outputs");
  const prepared = path.join(outputs, "prepared");
  runNode(path.join(scripts, "rescue-orphans-by-description.js"), [
    "--general", path.join(outputs, "general.matches.valid.json"),
    "--a-base", path.join(prepared, "eciglogistica__output.base.csv"),
    "--b-base", path.join(prepared, "vaperalia__output.base.csv"),
    "--a-variants", path.join(prepared, "eciglogistica__output.variants.csv"),
    "--b-variants", path.join(prepared, "vaperalia__output.variants.csv"),
  ], pipelineWorkDir);
  runNode(path.join(scripts, "build-dataset-manifest.js"), [], pipelineWorkDir);
}

function runPipeline3(scrapeJson) {
  step("Pipeline 3 - capa IA no determinista con CodexExec");
  const outputs = path.join(pipelineWorkDir, "outputs");
  const scripts = path.join(pipelineWorkDir, "scripts");
  const aiRoot = path.join(pipelineRoot, "04_ANEXO_CAPA_IA_NO_DETERMINISTA");
  fs.copyFileSync(path.join(aiRoot, "generate-description-rescue-decisions-codexexec.js"), path.join(scripts, "generate-description-rescue-decisions-codexexec.js"));
  fs.copyFileSync(path.join(aiRoot, "build-reviewed-rescue-layer.js"), path.join(scripts, "build-reviewed-rescue-layer.js"));

  const generateArgs = [
    "--rescue", path.join(outputs, "description-rescue-candidates.matches.valid.json"),
    "--rescue-audit", path.join(outputs, "audits", "description-rescue-candidates.audit.md"),
    "--original-scrape", scrapeJson,
    "--out", path.join(outputs, "reviews", "description-rescue-decisions.json"),
    "--prompt-out", path.join(outputs, "reviews", "description-rescue-codexexec-prompt.json"),
    "--batch-size", String(codexBatchSize),
  ];
  if (codexModel) generateArgs.push("--model", codexModel);

  runNode(path.join(scripts, "generate-description-rescue-decisions-codexexec.js"), generateArgs, pipelineWorkDir);
  runNode(path.join(scripts, "build-reviewed-rescue-layer.js"), [
    "--rescue", path.join(outputs, "description-rescue-candidates.matches.valid.json"),
    "--decisions", path.join(outputs, "reviews", "description-rescue-decisions.json"),
    "--a-variants", path.join(outputs, "prepared", "eciglogistica__output.variants.csv"),
    "--b-variants", path.join(outputs, "prepared", "vaperalia__output.variants.csv"),
    "--out", path.join(outputs, "reviewed-rescues.matches.valid.json"),
    "--audit-md", path.join(outputs, "audits", "reviewed-rescues.audit.md"),
  ], pipelineWorkDir);
  runNode(path.join(scripts, "build-dataset-manifest.js"), [], pipelineWorkDir);
}

function runBuildMaster(workDir) {
  step("Pipeline 5 - master JSON para BDD");
  const outputs = path.join(workDir, "outputs");
  const prepared = path.join(outputs, "prepared");
  const scripts = path.join(workDir, "scripts");
  const masterScript = path.join(pipelineRoot, "05_MASTER_BDD", "scripts", "build-master-seed-jsons.js");
  assertFiles([
    masterScript,
    path.join(scripts, "build-dataset-manifest.js"),
    path.join(scripts, "build-general-dataset.js"),
    path.join(prepared, "eciglogistica__output.base.csv"),
    path.join(prepared, "eciglogistica__output.variants.csv"),
    path.join(prepared, "vaperalia__output.base.csv"),
    path.join(prepared, "vaperalia__output.variants.csv"),
  ]);
  fs.copyFileSync(masterScript, path.join(scripts, "build-master-seed-jsons.js"));
  runNode(path.join(scripts, "build-dataset-manifest.js"), [], workDir);
  runNode(path.join(scripts, "build-general-dataset.js"), [], workDir);
  runNode(path.join(scripts, "build-master-seed-jsons.js"), [
    "--general", path.join(outputs, "general.matches.valid.json"),
    "--ecig-base", path.join(prepared, "eciglogistica__output.base.csv"),
    "--ecig-variants", path.join(prepared, "eciglogistica__output.variants.csv"),
    "--vaperalia-base", path.join(prepared, "vaperalia__output.base.csv"),
    "--vaperalia-variants", path.join(prepared, "vaperalia__output.variants.csv"),
    "--out-dir", path.join(outputs, "master-json"),
  ], workDir);
}

function runLoadBdd(workDir) {
  step(loadBddDryRun ? "Pipeline 6 - carga BDD dry run" : "Pipeline 6 - carga BDD");
  const outputs = path.join(workDir, "outputs");
  const masterDir = path.join(outputs, "master-json");
  const prepared = path.join(outputs, "prepared");
  const loaderSourceRoot = path.join(pipelineRoot, "06_CARGA_BDD", "SQLLoader");
  const loaderRoot = path.join(workDir, "sql-loader");
  const inputMaster = path.join(loaderRoot, "input_master");
  const inputPrepared = path.join(inputMaster, "prepared");
  assertFiles([
    path.join(masterDir, "master_matched_both.json"),
    path.join(masterDir, "master_only_eciglogistica.json"),
    path.join(masterDir, "master_only_vaperalia.json"),
    path.join(prepared, "vaperalia__output.variants.csv"),
    path.join(loaderSourceRoot, "scripts", "load_master_to_postgres.py"),
  ]);

  fs.rmSync(loaderRoot, { recursive: true, force: true });
  fs.cpSync(loaderSourceRoot, loaderRoot, { recursive: true });
  fs.rmSync(inputMaster, { recursive: true, force: true });
  fs.mkdirSync(inputPrepared, { recursive: true });
  fs.copyFileSync(path.join(masterDir, "master_matched_both.json"), path.join(inputMaster, "master_matched_both.json"));
  fs.copyFileSync(path.join(masterDir, "master_only_eciglogistica.json"), path.join(inputMaster, "master_only_eciglogistica.json"));
  fs.copyFileSync(path.join(masterDir, "master_only_vaperalia.json"), path.join(inputMaster, "master_only_vaperalia.json"));
  fs.copyFileSync(path.join(prepared, "vaperalia__output.variants.csv"), path.join(inputPrepared, "vaperalia__output.variants.csv"));

  const loaderArgs = [
    path.join(loaderRoot, "scripts", "load_master_to_postgres.py"),
    "--batch-size", String(bddBatchSize),
  ];
  if (loadBddDryRun) loaderArgs.push("--dry-run");
  if (skipEanEnrichment) loaderArgs.push("--skip-ean-enrichment");
  runCommand("python3", loaderArgs, { cwd: loaderRoot });
}

function ensureMasterJson(workDir) {
  const masterDir = path.join(workDir, "outputs", "master-json");
  const required = [
    path.join(masterDir, "master_matched_both.json"),
    path.join(masterDir, "master_only_eciglogistica.json"),
    path.join(masterDir, "master_only_vaperalia.json"),
  ];
  if (required.every((file) => fs.existsSync(file))) return;
  runBuildMaster(workDir);
}

function runCodexExecPreflight() {
  step("Preflight CodexExec");
  const runner = path.join(pipelineRoot, "04_ANEXO_CAPA_IA_NO_DETERMINISTA", "generate-description-rescue-decisions-codexexec.js");
  const preflightArgs = ["--preflight"];
  if (codexModel) preflightArgs.push("--model", codexModel);
  runNode(runner, preflightArgs, root);
}

function resolveExistingRunDir(value) {
  if (!value) {
    throw new Error("--only-build-master/--only-load-bdd requieren --from-run con nombre de run o ruta absoluta.");
  }
  const direct = path.resolve(value);
  if (fs.existsSync(direct)) return direct;
  const underOutputRoot = path.join(outputRoot, value);
  if (fs.existsSync(underOutputRoot)) return underOutputRoot;
  throw new Error(`No se encuentra la run indicada en --from-run: ${value}`);
}

function writeSummary(summary) {
  const full = {
    generatedAt: new Date().toISOString(),
    runner: "node",
    ...summary,
  };
  const summaryPath = path.join(runDir, "run-summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(full, null, 2), "utf8");
  console.log(`Resumen: ${summaryPath}`);
}

function assertFiles(files) {
  for (const file of files) {
    if (!fs.existsSync(file)) throw new Error(`Falta archivo requerido: ${file}`);
  }
}

function runNode(script, scriptArgs = [], cwd = root) {
  runCommand(process.execPath, [script, ...scriptArgs], { cwd });
}

function runCommand(command, commandArgs = [], options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || root,
    env: options.env || process.env,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Comando fallido (${result.status}): ${command} ${commandArgs.join(" ")}`);
  }
}

function runShell(command, options = {}) {
  const result = spawnSync(command, {
    cwd: options.cwd || root,
    env: options.env || process.env,
    stdio: "inherit",
    shell: true,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Comando shell fallido (${result.status}): ${command}`);
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function safeRunName(name) {
  const stamp = timestamp();
  const raw = name || "autoupdate";
  const safe = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "autoupdate";
  return `${stamp}-${safe}`;
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function step(name) {
  console.log("");
  console.log(`== ${name} ==`);
}

function printHelp() {
  console.log(`Uso:
  node run_auto_update.mjs [opciones]

Flujo normal:
  scraper -> validacion -> pipeline 1 -> pipeline 2 -> CodexExec -> master JSON

Flags de entrada:
  --run-name <nombre>              Nombre de la run.
  --output-root <dir>              Directorio base de runs. Default: ./runs.
  --input-json <file>              Usa un scrape JSON existente.
  --scraper-command <cmd>          Usa un scraper externo.
  --scraper-output-json <file>     Output esperado del scraper externo.

Flags del scraper integrado:
  --scraper-connector <name>       Connector. Default: all.
  --scraper-limit <n>              Limite de productos. Default: 0.
  --scraper-concurrency <n>        Concurrencia. Default: 5.
  --scraper-categories <csv>       Categorias concretas.
  --scraper-debug                  Guarda debug del scraper.
  --skip-scraper-install           Salta npm ci si ya esta preparado.
  --skip-playwright-install        Salta instalacion/verificacion Chromium.

Saltos del pipeline:
  --dry-run                        Valida entrada y no ejecuta pipelines.
  --skip-codex-exec                Salta Pipeline 3 IA/CodexExec.
  --skip-build-master              Salta master JSON final.

CodexExec:
  --codex-batch-size <n>           Tamano de batch. Default: 20.
  --codex-model <model>            Modelo Codex.

BDD:
  --load-bdd                       Carga BDD al final, despues de master JSON.
  --load-bdd-dry-run               Prepara payload/reporte sin insertar.
  --skip-ean-enrichment            Salta enriquecimiento EAN13 del loader.
  --bdd-batch-size <n>             Batch size loader. Default: 1000.
  --only-build-master              Solo genera master JSON desde una run existente.
  --only-load-bdd                  Solo carga BDD desde una run existente.
  --from-run <run|path>            Run usada por --only-build-master/--only-load-bdd.
`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}
