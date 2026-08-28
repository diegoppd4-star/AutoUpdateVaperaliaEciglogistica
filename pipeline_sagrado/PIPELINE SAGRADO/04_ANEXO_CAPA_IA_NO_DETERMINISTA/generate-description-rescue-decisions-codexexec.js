const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHash } = require("crypto");
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
  args.checkpointDir = args.checkpointDir || path.join(path.dirname(args.out), "codexexec-batches");
  if (args.reasoningEffort) {
    const allowed = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
    if (!allowed.has(args.reasoningEffort)) {
      throw new Error(`Reasoning effort invalido: ${args.reasoningEffort}`);
    }
  }
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

function normalizeIdentityValue(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function sideVariantValues(side) {
  return String(side.variant || "")
    .split(";")
    .map((part) => part.includes(":") ? part.slice(part.indexOf(":") + 1) : part)
    .map(normalizeIdentityValue)
    .filter(Boolean);
}

function dimensionalValues(side) {
  const values = sideVariantValues(side);
  const text = `${side.title || ""} ${side.variant || ""}`;
  for (const match of text.matchAll(/\b\d+(?:[.,]\d+)?\s*(?:mg|ml|ohm|mah|w)\b/gi)) {
    values.push(normalizeIdentityValue(match[0]));
  }
  return [...new Set(values)];
}

function rowsMatchingValues(candidates, expectedValues) {
  if (!expectedValues.length) return [];
  return candidates.filter((item) => {
    const itemValues = Object.values(item.variants || {}).map(normalizeIdentityValue);
    const itemTitle = normalizeIdentityValue(item.name || item.title);
    return expectedValues.every((value) => itemValues.includes(value) || itemTitle.includes(value));
  });
}

function selectOriginalScrapeRow(side, originalIndex, counterpart = {}) {
  const exact = originalIndex.exact.get(normalizeUrl(side.url)) || [];
  const base = originalIndex.base.get(baseUrl(side.url)) || [];
  const candidates = exact.length ? exact : base;
  if (!candidates.length) return { item: null, exact, base, selectedBy: "not_found" };
  if (candidates.length === 1) return { item: candidates[0], exact, base, selectedBy: "unique_url" };

  const expectedTitle = normalizeIdentityValue(side.title);
  const titleMatches = candidates.filter((item) =>
    normalizeIdentityValue(item.name || item.title) === expectedTitle
  );
  if (titleMatches.length === 1) {
    return { item: titleMatches[0], exact, base, selectedBy: "exact_variant_title" };
  }

  const expectedValues = sideVariantValues(side);
  if (expectedValues.length) {
    const variantMatches = rowsMatchingValues(candidates, expectedValues);
    if (variantMatches.length === 1) {
      return { item: variantMatches[0], exact, base, selectedBy: "exact_variant_values" };
    }
  }

  const counterpartValues = dimensionalValues(counterpart);
  if (counterpartValues.length) {
    const counterpartMatches = rowsMatchingValues(candidates, counterpartValues);
    if (counterpartMatches.length === 1) {
      return { item: counterpartMatches[0], exact, base, selectedBy: "counterpart_variant_values" };
    }
  }

  const variantId = normalizeIdentityValue(side.variantId);
  const skuMatches = candidates.filter((item) => {
    const sku = normalizeIdentityValue(item.sku);
    return sku && variantId.includes(sku);
  });
  if (skuMatches.length === 1) {
    return { item: skuMatches[0], exact, base, selectedBy: "variant_id_sku" };
  }

  throw new Error(
    `No se pudo resolver una fila scrapeada unica para la variante '${side.title || side.variantId || "sin titulo"}' ` +
    `en ${side.url}: ${candidates.length} filas comparten URL.`
  );
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

function scrapeEvidenceFor(side, originalIndex, counterpart = {}) {
  const { item, exact, base, selectedBy } = selectOriginalScrapeRow(side, originalIndex, counterpart);
  if (!item) {
    return {
      url: side.url,
      title: side.title,
      variant: side.variant || "",
      selectedBy,
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
    selectedBy,
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
      const ecigSide = {
        ...(product.eciglogistica || {}),
        ...(variant.eciglogistica || {}),
      };
      const vaperaliaSide = {
        ...(product.vaperalia || {}),
        ...(variant.vaperalia || {}),
      };
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
          ecig: scrapeEvidenceFor(ecigSide, originalIndex, vaperaliaSide),
          vaperalia: scrapeEvidenceFor(vaperaliaSide, originalIndex, ecigSide),
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function checkpointInputSha256(packet, args) {
  const { generatedAt: _generatedAt, ...stablePacket } = packet;
  return sha256(JSON.stringify({
    prompt: buildPrompt(stablePacket, args),
    outputSchema: outputSchema(),
    requestedModel: args.model || null,
    requestedReasoningEffort: args.reasoningEffort || null,
  }));
}

function batchFile(checkpointDir, batchNumber, suffix = "json") {
  return path.join(checkpointDir, `batch-${String(batchNumber).padStart(3, "0")}.${suffix}`);
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function sanitizeDiagnostic(value, max = 16000) {
  return String(value || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL_REDACTED]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, max);
}

function loadCheckpoint(filePath, expectedHash, batchNumber, totalBatches, candidates) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const checkpoint = readJson(filePath);
    if (checkpoint.schemaVersion !== 2) throw new Error("schemaVersion incompatible");
    if (checkpoint.batchNumber !== batchNumber || checkpoint.totalBatches !== totalBatches) {
      throw new Error("numero o total de batches distinto");
    }
    if (checkpoint.inputSha256 !== expectedHash) throw new Error("hash de entrada distinto");
    if (!checkpoint.response || !Array.isArray(checkpoint.response.decisions)) {
      throw new Error("response.decisions ausente");
    }
    validateAndMerge([checkpoint.response], candidates);
    return checkpoint.response;
  } catch (error) {
    console.error(`[codexexec] Checkpoint descartado ${filePath}: ${error.message}`);
    return null;
  }
}

function writeFailureDiagnostic(filePath, metadata, error) {
  writeJsonAtomic(filePath, {
    schemaVersion: 1,
    failedAt: new Date().toISOString(),
    ...metadata,
    error: sanitizeDiagnostic(error?.stack || error?.message || error),
    stdoutTail: sanitizeDiagnostic(error?.stdoutTail || "", 12000),
    stderrTail: sanitizeDiagnostic(error?.stderrTail || "", 12000),
  });
}

function outputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["decisions"],
    properties: {
      decisions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "label", "confidence", "reason", "decisiveEvidence", "ignoredNoise"],
          properties: {
            id: { type: "string" },
            label: { type: "string", enum: ["SAME", "DIFFERENT"] },
            confidence: { type: "integer", minimum: 0, maximum: 100 },
            reason: { type: "string" },
            decisiveEvidence: { type: "array", items: { type: "string" }, maxItems: 5 },
            ignoredNoise: { type: "array", items: { type: "string" }, maxItems: 5 }
          }
        }
      }
    }
  };
}

function defaultIdentityPrompt() {
  return [
    "You are an exact product-identity adjudicator for two distributor catalogues. For every candidate pair, decide whether the two supplied records represent the SAME sellable product variant or DIFFERENT sellable products.",
    "",
    "Use only CANDIDATE_PAIRS_JSON. Do not browse, open URLs, call tools, or substitute a different page. Each side is already the exact scrape row selected for comparison, even when several variants share one base URL.",
    "",
    "Apply these rules in order:",
    "",
    "1. Determine identity from brand, product family, model, generation/version, named edition or recipe, product type, pack count, physical capacity/format, and selected variant attributes such as nicotine strength, resistance, colour, or size.",
    "2. Named editions and generations are hard identity discriminators. In particular, Green Edition, Sweet Edition, Zero, Ice, V2/V3, Pro, Mini, Nano, S3, Corex 2.0, Dual Mesh, and similar qualifiers are not decorative when they distinguish a commercial recipe or model. If one record explicitly identifies an edition/generation and the other identifies the same base name without it, decide DIFFERENT unless the other record independently and explicitly proves that same edition/generation.",
    "3. Conversely, reordered words, translations, accents, punctuation, distributor boilerplate, omitted generic words such as aroma/coil/replacement, and different distributor identifiers are not product differences.",
    "4. For grouped product pages, compare the supplied selected row and its variants, not the page's whole option list or URL. Same base page with a different selected strength, resistance, capacity, colour, or size is a different sellable variant; matching selected attributes support SAME.",
    "5. An exact or similar SKU/reference is supporting evidence only. It never overrides a clear edition, generation, model, capacity, pack-count, or selected-variant contradiction. A different SKU/reference across distributors is normal and does not imply DIFFERENT.",
    "6. Product titles, explicit references, selected variants, and repeated specifications carry more identity weight than one isolated sentence in description or metadata. Treat an isolated copy inconsistency as catalogue noise when all identity-bearing fields agree. Do not dismiss a repeated or title-level discriminator as noise.",
    "7. Compatible-with statements describe use, not necessarily identity. Use them as corroboration. Do not equate a device with its replacement pod, or two different devices merely because both accept the same pod.",
    "8. A minor wording difference about a feature does not create a second product when brand, explicit model/generation, pack, capacity, and selected variant all match and neither page names a distinct revision. A genuinely incompatible hard specification or explicitly different model still means DIFFERENT.",
    "",
    "Return one decision for every input id, preserving input order. Choose exactly SAME or DIFFERENT. Keep the reason concrete and short. In decisiveEvidence name the fields that control the decision. In ignoredNoise list only discrepancies that you deliberately did not treat as identity-bearing; otherwise return an empty array.",
  ].join("\n");
}

function identityPrompt(args) {
  if (!args.identityPrompt) return defaultIdentityPrompt();
  return fs.readFileSync(path.resolve(args.identityPrompt), "utf8").trim();
}

function buildPrompt(packet, args) {
  return [
    identityPrompt(args),
    "",
    "CANDIDATE_PAIRS_JSON",
    JSON.stringify(packet.candidates, null, 2),
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
      const error = new Error(`CodexExec timed out after ${options.timeoutMs}ms`);
      error.stdoutTail = stdout.slice(-12000);
      error.stderrTail = stderr.slice(-12000);
      reject(error);
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
        const error = new Error(`CodexExec exited with code ${code}: ${(stderr || stdout).slice(-12000)}`);
        error.stdoutTail = stdout.slice(-12000);
        error.stderrTail = stderr.slice(-12000);
        reject(error);
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
    if (args.reasoningEffort) codexArgs.push("--config", `model_reasoning_effort="${args.reasoningEffort}"`);
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
    console.log(JSON.stringify({
      ok: true,
      codexPath,
      model: args.model || null,
      reasoningEffort: args.reasoningEffort || null,
      preflight: "CODEX_PREFLIGHT_OK",
    }, null, 2));
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
    if (args.reasoningEffort) codexArgs.push("--config", `model_reasoning_effort="${args.reasoningEffort}"`);
    codexArgs.push("-");
    const result = await runProcess(codexPath, codexArgs, buildPrompt(packet, args), {
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

function reviewIdForCandidate(candidate) {
  return `desc-rescue-auto-${String(candidate.candidateNumber).padStart(3, "0")}`;
}

function promptCandidate(candidate) {
  return {
    id: reviewIdForCandidate(candidate),
    a: candidate.evidence.ecig,
    b: candidate.evidence.vaperalia,
  };
}

function confidenceLabel(value) {
  const confidence = Number(value);
  if (confidence >= 90) return "high";
  if (confidence >= 70) return "medium";
  return "low";
}

function normalizeDecision(decision, candidate) {
  const identity = candidate.requiredDecisionIdentity;
  if (!decision || !["SAME", "DIFFERENT"].includes(decision.label)) {
    throw new Error(`Etiqueta invalida para ${reviewIdForCandidate(candidate)}: ${decision?.label}`);
  }
  if (!decision.reason) {
    throw new Error(`Decision sin reason para ${reviewIdForCandidate(candidate)}`);
  }
  const normalized = {
    reviewId: reviewIdForCandidate(candidate),
    sourceProductNumber: candidate.sourceProductNumber,
    sourceVariantNumber: candidate.sourceVariantNumber,
    decision: decision.label === "SAME" ? "accepted" : "rejected",
    reviewConfidence: confidenceLabel(decision.confidence),
    sourceDataset: "description-rescue-candidates",
    ecigProductId: identity.ecigProductId,
    vaperaliaProductId: identity.vaperaliaProductId,
    ecigVariantId: identity.ecigVariantId,
    vaperaliaVariantId: identity.vaperaliaVariantId,
    ecigTitle: candidate.variant.eciglogistica?.title || candidate.base.eciglogistica?.title || "",
    vaperaliaTitle: candidate.variant.vaperalia?.title || candidate.base.vaperalia?.title || "",
    ecigUrl: identity.ecigUrl,
    vaperaliaUrl: identity.vaperaliaUrl,
    reviewedFields: [
      "title",
      "url",
      "reference",
      "brandCandidates/commercialBrand",
      "breadcrumbPath/category",
      "variants",
      "description",
      "metaDescription",
    ],
    reviewReason: decision.reason,
    decisiveEvidence: Array.isArray(decision.decisiveEvidence) ? decision.decisiveEvidence : [],
    ignoredNoise: Array.isArray(decision.ignoredNoise) ? decision.ignoredNoise : [],
    modelConfidence: Number(decision.confidence),
    evidence: {
      ecig: candidate.evidence.ecig,
      vaperalia: candidate.evidence.vaperalia,
    },
  };
  return normalized;
}

function validateAndMerge(batchResponses, candidates) {
  const candidateById = new Map(candidates.map((candidate) => [reviewIdForCandidate(candidate), candidate]));
  const decisions = [];
  const seen = new Set();
  for (const response of batchResponses) {
    for (const rawDecision of response.decisions || []) {
      const candidate = candidateById.get(rawDecision.id);
      if (!candidate) throw new Error(`CodexExec devolvio una decision sin candidato: ${rawDecision.id}`);
      if (seen.has(rawDecision.id)) throw new Error(`Decision duplicada: ${rawDecision.id}`);
      seen.add(rawDecision.id);
      decisions.push(normalizeDecision(rawDecision, candidate));
    }
  }

  const missing = [];
  for (const candidate of candidates) {
    const id = reviewIdForCandidate(candidate);
    if (!seen.has(id)) missing.push(id);
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
    identityPromptFile: args.identityPrompt ? path.resolve(args.identityPrompt) : null,
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
  fs.writeFileSync(args.promptOut, `${JSON.stringify({
    ...promptPacket,
    identityPrompt: identityPrompt(args),
    candidates: candidates.map(promptCandidate),
  }, null, 2)}\n`, "utf8");

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
  fs.mkdirSync(args.checkpointDir, { recursive: true });
  for (let index = 0; index < chunks.length; index += 1) {
    const batchNumber = index + 1;
    const packet = {
      ...promptPacket,
      batchNumber,
      totalBatches: chunks.length,
      candidates: chunks[index].map(promptCandidate),
    };
    const inputSha256 = checkpointInputSha256(packet, args);
    const checkpointPath = batchFile(args.checkpointDir, batchNumber);
    const failurePath = batchFile(args.checkpointDir, batchNumber, "failure.json");
    const checkpointResponse = loadCheckpoint(
      checkpointPath,
      inputSha256,
      batchNumber,
      chunks.length,
      chunks[index]
    );
    if (checkpointResponse) {
      console.error(`[codexexec] Reutilizando checkpoint batch ${batchNumber}/${chunks.length}`);
      batchResponses.push(checkpointResponse);
      continue;
    }
    console.error(`[codexexec] Revisando batch ${batchNumber}/${chunks.length} (${chunks[index].length} candidatos)`);
    try {
      const response = await callCodexExec(packet, args, batchNumber);
      const parsed = response.parsed;
      if (!Array.isArray(parsed.decisions)) throw new Error(`Batch ${batchNumber} no devolvio decisions[]`);
      validateAndMerge([parsed], chunks[index]);
      writeJsonAtomic(checkpointPath, {
        schemaVersion: 2,
        batchNumber,
        totalBatches: chunks.length,
        inputSha256,
        completedAt: new Date().toISOString(),
        requestedModel: args.model || null,
        requestedReasoningEffort: args.reasoningEffort || null,
        response: parsed,
      });
      if (fs.existsSync(failurePath)) fs.unlinkSync(failurePath);
      batchResponses.push(parsed);
    } catch (error) {
      writeFailureDiagnostic(failurePath, {
        batchNumber,
        totalBatches: chunks.length,
        candidates: chunks[index].length,
        inputSha256,
        requestedModel: args.model || null,
        requestedReasoningEffort: args.reasoningEffort || null,
      }, error);
      console.error(`[codexexec] Diagnostico persistido: ${failurePath}`);
      throw error;
    }
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
    requestedModel: args.model || null,
    requestedReasoningEffort: args.reasoningEffort || null,
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
