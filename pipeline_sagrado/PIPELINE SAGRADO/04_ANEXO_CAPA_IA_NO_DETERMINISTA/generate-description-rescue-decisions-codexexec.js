const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

function parseArgs(argv) {
  const args = {
    rescue: "outputs/description-rescue-candidates.matches.valid.json",
    rescueAudit: "outputs/audits/description-rescue-candidates.audit.md",
    originalScrape: "",
    out: "outputs/reviews/description-rescue-decisions.json",
    promptOut: "outputs/reviews/description-rescue-codexexec-prompt.json",
    reviewer: "CodexExec",
    batchSize: 25,
    timeoutMs: 20 * 60 * 1000,
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
  args.batchSize = Math.max(1, Number(args.batchSize || 25));
  args.timeoutMs = Number(args.timeoutMs || 20 * 60 * 1000);
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readTextIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8");
}

function normalizeUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();
}

function baseUrl(value) {
  return normalizeUrl(String(value || "").split("#")[0]);
}

function shortText(value, max = 1600) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function indexOriginalScrape(filePath) {
  const empty = { exact: new Map(), base: new Map() };
  if (!filePath || !fs.existsSync(filePath)) return empty;
  const data = readJson(filePath);
  const items = Array.isArray(data) ? data : (data.items || data.products || []);
  const index = { exact: new Map(), base: new Map() };

  for (const item of items) {
    const exactKey = normalizeUrl(item.url);
    const baseKey = baseUrl(item.url);
    if (exactKey) {
      if (!index.exact.has(exactKey)) index.exact.set(exactKey, []);
      index.exact.get(exactKey).push(item);
    }
    if (baseKey) {
      if (!index.base.has(baseKey)) index.base.set(baseKey, []);
      index.base.get(baseKey).push(item);
    }
  }
  return index;
}

function scrapeEvidenceFor(side, originalIndex) {
  const exact = originalIndex.exact.get(normalizeUrl(side.url)) || [];
  const base = originalIndex.base.get(baseUrl(side.url)) || [];
  const item = exact[0] || base[0] || null;
  if (!item) {
    return {
      url: side.url,
      title: side.title,
      variant: side.variant || "",
      foundInOriginalScrape: false,
    };
  }
  return {
    url: item.url || side.url,
    title: item.name || item.title || side.title,
    brand: item.brand || "",
    brandCandidates: item.brandCandidates || [],
    commercialBrand: item.commercialBrand || "",
    reference: item.reference || item.sku || "",
    sku: item.sku || "",
    category: item.category || "",
    breadcrumbPath: item.breadcrumbPath || [],
    variants: item.variants || {},
    derived: item.derived || {},
    description: shortText(item.description, 2200),
    metaDescription: shortText(item.metaDescription, 1400),
    exactOriginalRows: exact.length,
    baseOriginalRows: base.length,
    foundInOriginalScrape: true,
  };
}

function flattenCandidates(rescue, originalIndex) {
  const rows = [];
  let productNumber = 0;
  for (const product of rescue.products || []) {
    productNumber += 1;
    let variantNumber = 0;
    for (const variant of product.variants || []) {
      variantNumber += 1;
      rows.push({
        candidateNumber: rows.length + 1,
        sourceProductNumber: productNumber,
        sourceVariantNumber: variantNumber,
        base: {
          status: product.status,
          baseConfidence: product.baseConfidence,
          reason: product.reason,
          eciglogistica: product.eciglogistica,
          vaperalia: product.vaperalia,
        },
        variant,
        requiredDecisionIdentity: {
          ecigProductId: product.eciglogistica?.productId || "",
          vaperaliaProductId: product.vaperalia?.productId || "",
          ecigVariantId: variant.eciglogistica?.variantId || "",
          vaperaliaVariantId: variant.vaperalia?.variantId || "",
          ecigUrl: variant.eciglogistica?.url || product.eciglogistica?.url || "",
          vaperaliaUrl: variant.vaperalia?.url || product.vaperalia?.url || "",
        },
        evidence: {
          ecig: scrapeEvidenceFor({
            ...(product.eciglogistica || {}),
            ...(variant.eciglogistica || {}),
          }, originalIndex),
          vaperalia: scrapeEvidenceFor({
            ...(product.vaperalia || {}),
            ...(variant.vaperalia || {}),
          }, originalIndex),
        },
      });
    }
  }
  return rows;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function outputSchema() {
  const evidenceSide = {
    type: "object",
    additionalProperties: false,
    required: [
      "reference",
      "brand",
      "brandCandidates",
      "commercialBrand",
      "category",
      "breadcrumbPath",
      "variantsSummary",
      "descriptionSnippet",
      "metaDescriptionSnippet"
    ],
    properties: {
      reference: { type: "string" },
      brand: { type: "string" },
      brandCandidates: { type: "array", items: { type: "string" } },
      commercialBrand: { type: "string" },
      category: { type: "string" },
      breadcrumbPath: { type: "array", items: { type: "string" } },
      variantsSummary: { type: "string" },
      descriptionSnippet: { type: "string" },
      metaDescriptionSnippet: { type: "string" }
    }
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["batchNumber", "notes", "decisions"],
    properties: {
      batchNumber: { type: "integer" },
      notes: { type: "string" },
      decisions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "reviewId",
            "sourceProductNumber",
            "sourceVariantNumber",
            "decision",
            "reviewConfidence",
            "sourceDataset",
            "ecigProductId",
            "vaperaliaProductId",
            "ecigVariantId",
            "vaperaliaVariantId",
            "ecigTitle",
            "vaperaliaTitle",
            "ecigUrl",
            "vaperaliaUrl",
            "reviewedFields",
            "reviewReason",
            "evidence"
          ],
          properties: {
            reviewId: { type: "string" },
            sourceProductNumber: { type: "integer" },
            sourceVariantNumber: { type: "integer" },
            decision: { enum: ["accepted", "rejected", "accept", "reject"] },
            reviewConfidence: { enum: ["high", "medium", "low"] },
            sourceDataset: { type: "string" },
            ecigProductId: { type: "string" },
            vaperaliaProductId: { type: "string" },
            ecigVariantId: { type: "string" },
            vaperaliaVariantId: { type: "string" },
            ecigTitle: { type: "string" },
            vaperaliaTitle: { type: "string" },
            ecigUrl: { type: "string" },
            vaperaliaUrl: { type: "string" },
            reviewedFields: { type: "array", items: { type: "string" } },
            reviewReason: { type: "string" },
            evidence: {
              type: "object",
              additionalProperties: false,
              required: ["ecig", "vaperalia"],
              properties: {
                ecig: evidenceSide,
                vaperalia: evidenceSide
              }
            }
          }
        }
      }
    }
  };
}

function buildPrompt(packet) {
  return [
    "Eres CodexExec ejecutando la capa IA/no determinista del Pipeline Sagrado Eciglogistica/Vaperalia.",
    "",
    "OBJETIVO",
    "Revisar semanticamente candidatos probables generados por el Pipeline 2 y producir un ledger JSON de decisiones.",
    "Esta capa NO modifica el matcher determinista. Solo escribe decisiones auditables.",
    "",
    "REGLA DE SALIDA",
    "- Devuelve SOLO JSON valido.",
    "- No uses markdown.",
    "- Debe haber exactamente una decision por cada candidato del campo candidates.",
    "- Copia literalmente los IDs de requiredDecisionIdentity.",
    "- Usa decision='accepted' o 'rejected'.",
    "- No existe cola humana en esta ejecucion automatizada.",
    "- Si dudas, rechaza: usa decision='rejected'.",
    "",
    "CAMPOS QUE DEBES LEER EN CADA PAR",
    "- URL de Eciglogistica y Vaperalia.",
    "- titulo/base de producto.",
    "- marca, brandCandidates y commercialBrand.",
    "- reference/sku.",
    "- breadcrumbPath/categoria.",
    "- variants concretas.",
    "- description y metaDescription.",
    "- capacidad, nicotina, resistencia/ohm, color, pack, formato, edicion y modelo.",
    "",
    "CRITERIOS PARA ACEPTAR",
    "- Misma marca real o marca comercial equivalente.",
    "- Misma familia/producto base.",
    "- Misma variante real cuando exista: color, nicotina, ohm, capacidad, pack, modelo.",
    "- La descripcion o metaDescription refuerza el mismo producto/receta/modelo.",
    "- Diferencias de orden, traduccion, abreviatura o falta de detalle en un lado son aceptables si no introducen conflicto.",
    "- Una distribuidora puede agrupar variantes en una URL y la otra separarlas, pero la variante concreta debe coincidir.",
    "",
    "CONFLICTOS DUROS QUE OBLIGAN A RECHAZAR",
    "- Nicotina distinta: 10mg contra 20mg, salvo que ambos lados tengan variante exacta 10-10 o 20-20.",
    "- Color distinto real.",
    "- Resistencia distinta: 0.6 ohm contra 0.8 ohm, salvo variante exacta coincidente.",
    "- Capacidad primaria distinta no explicable por longfill.",
    "- Longfill contra aroma normal si solo un lado declara longfill y bote/capacidad no lo resuelve.",
    "- Drip tip/boquilla contra atomizador/tanque completo.",
    "- Kit contra mod suelto.",
    "- Version/modelo distinto: Nano, Mini, Pro, Plus, V2, Max, Lite, Koko, Legend, Primal, etc. cuando diferencian producto real.",
    "- Edicion contradictoria: Sweet Edition contra Green Edition, Dessert Bar contra linea normal, etc.",
    "- Marca incompatible o alias no justificado.",
    "- Descripcion generica de familia que no confirme la variante concreta.",
    "",
    "LONGFILL / NICOTINA",
    "- Longfill: el bote puede ser mucho mayor que el liquido/aroma contenido. No lo rechaces por 30ml/120ml si ambos describen longfill equivalente.",
    "- Producto con nicotina: por ley el bote maximo no debe superar 10ml; si aparece nicotina y bote >10ml, revisa con especial dureza.",
    "",
    "CONFIANZA",
    "- high: nombre propio, marca, formato y variante coinciden; descripcion lo refuerza.",
    "- medium: diferencia de presentacion/nombre, sin conflicto y la descripcion lo resuelve.",
    "- low: insuficiente; debe ser rejected.",
    "",
    "FORMATO DE CADA DECISION",
    "- reviewId: desc-rescue-auto-<candidateNumber>",
    "- sourceProductNumber y sourceVariantNumber desde el candidato.",
    "- sourceDataset: description-rescue-candidates",
    "- reviewedFields: incluye title,url,reference,brandCandidates/commercialBrand,breadcrumbPath/category,variants,description,metaDescription.",
    "- reviewReason: explica senales y conflictos/ausencia de conflictos.",
    "- evidence: objeto con ecig y vaperalia. Cada lado debe tener reference, brand, brandCandidates, commercialBrand, category, breadcrumbPath, variantsSummary, descriptionSnippet y metaDescriptionSnippet.",
    "",
    "PAQUETE DE TRABAJO",
    JSON.stringify(packet, null, 2),
  ].join("\n");
}

function findCodexExecutable(args) {
  if (args.codexPath) return args.codexPath;
  if (process.env.CODEX_EXEC_PATH) return process.env.CODEX_EXEC_PATH;
  const local = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin", "codex.exe");
  if (local && fs.existsSync(local)) return local;
  return "codex";
}

function uniqueExistingDirs(paths) {
  const seen = new Set();
  const dirs = [];
  for (const dir of paths) {
    if (!dir || seen.has(dir) || !fs.existsSync(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}

function sourceCodexHomes() {
  return uniqueExistingDirs([
    process.env.CODEX_HOME,
    process.env.HOME && path.join(process.env.HOME, ".codex"),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, ".codex"),
    path.join(os.homedir(), ".codex"),
  ]);
}

function copyCodexBootstrapFiles(sourceDir, targetDir) {
  const filesToCopy = new Set([
    "auth.json",
    "config.toml",
    "installation_id",
    "models_cache.json",
    "version.json",
  ]);
  let copiedAuth = false;
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !filesToCopy.has(entry.name)) continue;
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    fs.copyFileSync(source, target);
    if (entry.name === "auth.json") copiedAuth = true;
  }
  return copiedAuth;
}

function prepareCodexExecEnv(tmpDir) {
  const homeDir = path.join(tmpDir, "home");
  const codexHome = path.join(homeDir, ".codex");
  const tempDir = path.join(tmpDir, "tmp");
  const xdgRuntimeDir = path.join(tmpDir, "xdg-runtime");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(xdgRuntimeDir, { recursive: true });

  for (const sourceDir of sourceCodexHomes()) {
    if (path.resolve(sourceDir) === path.resolve(codexHome)) continue;
    if (copyCodexBootstrapFiles(sourceDir, codexHome)) break;
  }

  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: path.join(homeDir, ".config"),
    XDG_CACHE_HOME: path.join(homeDir, ".cache"),
    XDG_DATA_HOME: path.join(homeDir, ".local", "share"),
    XDG_STATE_HOME: path.join(homeDir, ".local", "state"),
    XDG_RUNTIME_DIR: xdgRuntimeDir,
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
  };

  if (process.platform === "win32") {
    env.LOCALAPPDATA = path.join(homeDir, "AppData", "Local");
    env.APPDATA = path.join(homeDir, "AppData", "Roaming");
  }

  return env;
}

function runProcess(command, args, stdin, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill();
      reject(new Error(`CodexExec timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`CodexExec exited with code ${code}: ${(stderr || stdout).slice(0, 4000)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1]);
    const object = String(text).match(/\{[\s\S]*\}/);
    if (object) return JSON.parse(object[0]);
    throw new Error("CodexExec response did not contain JSON.");
  }
}

async function callCodexExecPreflight(args) {
  const codexPath = findCodexExecutable(args);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "desc-rescue-codexexec-preflight-"));
  const outputFile = path.join(tmpDir, "preflight.txt");
  try {
    const codexArgs = [
      "--ask-for-approval", "never",
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox", "read-only",
      "--color", "never",
      "--output-last-message", outputFile,
    ];
    if (args.model) codexArgs.push("--model", args.model);
    codexArgs.push("Responde exactamente con esta palabra: CODEX_PREFLIGHT_OK");
    const result = await runProcess(codexPath, codexArgs, "", {
      cwd: process.cwd(),
      env: prepareCodexExecEnv(tmpDir),
      timeoutMs: 2 * 60 * 1000,
    });
    const text = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : result.stdout;
    if (!String(text).includes("CODEX_PREFLIGHT_OK")) {
      throw new Error(`CodexExec preflight no devolvio CODEX_PREFLIGHT_OK. Respuesta: ${String(text).slice(0, 1000)}`);
    }
    console.log(JSON.stringify({ ok: true, codexPath, preflight: "CODEX_PREFLIGHT_OK" }, null, 2));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function callCodexExec(packet, args, batchNumber) {
  const codexPath = findCodexExecutable(args);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "desc-rescue-codexexec-"));
  const outputFile = path.join(tmpDir, `batch-${batchNumber}.json`);
  const schemaFile = path.join(tmpDir, "schema.json");
  try {
    fs.writeFileSync(schemaFile, JSON.stringify(outputSchema(), null, 2), "utf8");
    const codexArgs = [
      "--ask-for-approval", "never",
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox", "read-only",
      "--color", "never",
      "--output-last-message", outputFile,
      "--output-schema", schemaFile,
    ];
    if (args.model) codexArgs.push("--model", args.model);
    codexArgs.push("-");
    const result = await runProcess(codexPath, codexArgs, buildPrompt(packet), {
      cwd: process.cwd(),
      env: prepareCodexExecEnv(tmpDir),
      timeoutMs: args.timeoutMs,
    });
    const text = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : result.stdout;
    return {
      codexPath,
      outputFile,
      stdoutTail: result.stdout.slice(-3000),
      stderrTail: result.stderr.slice(-3000),
      parsed: parseJsonLoose(text),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function decisionKey(decision) {
  return `${decision.ecigVariantId || ""}|||${decision.vaperaliaVariantId || ""}`;
}

function candidateKey(candidate) {
  return `${candidate.requiredDecisionIdentity.ecigVariantId || ""}|||${candidate.requiredDecisionIdentity.vaperaliaVariantId || ""}`;
}

function normalizeDecision(decision, candidate) {
  const identity = candidate.requiredDecisionIdentity;
  const normalized = {
    reviewId: decision.reviewId || `desc-rescue-auto-${String(candidate.candidateNumber).padStart(3, "0")}`,
    sourceProductNumber: Number(decision.sourceProductNumber || candidate.sourceProductNumber),
    sourceVariantNumber: Number(decision.sourceVariantNumber || candidate.sourceVariantNumber),
    decision: decision.decision === "accept" ? "accepted" : decision.decision === "reject" ? "rejected" : decision.decision,
    reviewConfidence: decision.reviewConfidence || "low",
    sourceDataset: "description-rescue-candidates",
    ecigProductId: identity.ecigProductId,
    vaperaliaProductId: identity.vaperaliaProductId,
    ecigVariantId: identity.ecigVariantId,
    vaperaliaVariantId: identity.vaperaliaVariantId,
    ecigTitle: decision.ecigTitle || candidate.variant.eciglogistica?.title || candidate.base.eciglogistica?.title || "",
    vaperaliaTitle: decision.vaperaliaTitle || candidate.variant.vaperalia?.title || candidate.base.vaperalia?.title || "",
    ecigUrl: identity.ecigUrl,
    vaperaliaUrl: identity.vaperaliaUrl,
    reviewedFields: decision.reviewedFields || [
      "title",
      "url",
      "reference",
      "brandCandidates/commercialBrand",
      "breadcrumbPath/category",
      "variants",
      "description",
      "metaDescription",
    ],
    reviewReason: decision.reviewReason || decision.reason || "",
    evidence: decision.evidence || {
      ecig: candidate.evidence.ecig,
      vaperalia: candidate.evidence.vaperalia,
    },
  };
  if (!["accepted", "rejected"].includes(normalized.decision)) {
    throw new Error(`Decision invalida para ${candidateKey(candidate)}: ${decision.decision}`);
  }
  if (!["high", "medium", "low"].includes(normalized.reviewConfidence)) {
    normalized.reviewConfidence = normalized.decision === "accepted" ? "medium" : "low";
  }
  if (!normalized.reviewReason) {
    throw new Error(`Decision sin reviewReason para ${candidateKey(candidate)}`);
  }
  return normalized;
}

function validateAndMerge(batchResponses, candidates) {
  const candidateByKey = new Map(candidates.map((candidate) => [candidateKey(candidate), candidate]));
  const decisions = [];
  for (const response of batchResponses) {
    for (const rawDecision of response.decisions || []) {
      const key = decisionKey(rawDecision);
      const candidate = candidateByKey.get(key);
      if (!candidate) throw new Error(`CodexExec devolvio una decision sin candidato: ${key}`);
      decisions.push(normalizeDecision(rawDecision, candidate));
    }
  }

  const seen = new Set();
  const duplicates = [];
  for (const decision of decisions) {
    const key = decisionKey(decision);
    if (seen.has(key)) duplicates.push(key);
    seen.add(key);
  }
  if (duplicates.length) throw new Error(`Decisiones duplicadas:\n${duplicates.join("\n")}`);

  const missing = [];
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (!seen.has(key)) missing.push(key);
  }
  if (missing.length) throw new Error(`Faltan decisiones para ${missing.length} candidatos:\n${missing.join("\n")}`);
  return decisions;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.preflight) {
    await callCodexExecPreflight(args);
    return;
  }

  const rescue = readJson(args.rescue);
  const auditMd = readTextIfExists(args.rescueAudit);
  const originalIndex = indexOriginalScrape(args.originalScrape);
  let candidates = flattenCandidates(rescue, originalIndex);
  if (args.maxCandidates || args.maxCandidates === 0) {
    candidates = candidates.slice(0, Math.max(0, Number(args.maxCandidates)));
  }
  const chunks = chunkArray(candidates, args.batchSize);

  const promptPacket = {
    generatedAt: new Date().toISOString(),
    task: "description_rescue_non_deterministic_review",
    sourceDataset: "description-rescue-candidates",
    rescueFile: args.rescue,
    rescueAuditFile: args.rescueAudit,
    originalScrapeFile: args.originalScrape || null,
    totalCandidates: candidates.length,
    batchSize: args.batchSize,
    policySummary: {
      noDeterministicMutation: true,
      outputLedger: args.out,
      acceptedStatusExpectedByBuilder: "accepted",
      ifDoubt: "rejected",
      noHumanQueue: true,
    },
    auditExcerpt: shortText(auditMd, 6000),
  };
  fs.mkdirSync(path.dirname(args.promptOut), { recursive: true });
  fs.writeFileSync(args.promptOut, `${JSON.stringify({ ...promptPacket, candidates }, null, 2)}\n`, "utf8");

  if (args.dryRun || args["dry-run"]) {
    console.log(JSON.stringify({
      dryRun: true,
      promptOut: args.promptOut,
      candidates: candidates.length,
      chunks: chunks.length,
    }, null, 2));
    return;
  }

  const batchResponses = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const batchNumber = index + 1;
    const packet = {
      ...promptPacket,
      batchNumber,
      totalBatches: chunks.length,
      candidates: chunks[index],
    };
    console.error(`[codexexec] Revisando batch ${batchNumber}/${chunks.length} (${chunks[index].length} candidatos)`);
    const response = await callCodexExec(packet, args, batchNumber);
    const parsed = response.parsed;
    if (!Array.isArray(parsed.decisions)) throw new Error(`Batch ${batchNumber} no devolvio decisions[]`);
    batchResponses.push(parsed);
  }

  const decisions = validateAndMerge(batchResponses, candidates);
  const summary = {
    productsReviewed: new Set(candidates.map((candidate) => candidate.sourceProductNumber)).size,
      variantsReviewed: candidates.length,
      acceptedVariants: decisions.filter((decision) => decision.decision === "accepted").length,
      rejectedVariants: decisions.filter((decision) => decision.decision === "rejected").length,
      needsHumanVariants: decisions.filter((decision) => decision.decision === "needs_human").length,
    highConfidence: decisions.filter((decision) => decision.reviewConfidence === "high").length,
    mediumConfidence: decisions.filter((decision) => decision.reviewConfidence === "medium").length,
    lowConfidence: decisions.filter((decision) => decision.reviewConfidence === "low").length,
  };
  const ledger = {
    schemaVersion: 1,
    reviewedAt: new Date().toISOString(),
    reviewer: args.reviewer,
    sourceDataset: "description-rescue-candidates",
    basis: "Revision semantica no determinista ejecutada por CodexExec sobre candidatos del Pipeline 2, leyendo titulo, URL, referencia, marca/candidatas, categoria/breadcrumb, variantes, descripcion y metaDescription enriquecidos desde el scrape original cuando esta disponible.",
    policy: "Este ledger no cambia el matcher determinista. Solo eleva a validos revisados los pares aceptados aqui.",
    summary,
    decisions,
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ out: args.out, summary }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
