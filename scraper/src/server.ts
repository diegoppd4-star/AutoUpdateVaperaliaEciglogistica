import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { spawn, ChildProcess } from "node:child_process";
import { join } from "node:path";
import { VaperaliaConnector } from "./connectors/vaperalia.js";
import { EciglogisticaConnector } from "./connectors/eciglogistica.js";
import { Connector } from "./connectors/connector.js";

const PORT = 8082;
const OUTPUT_DIR = join(import.meta.dirname, "..", "output");

let scraperProcess: ChildProcess | null = null;
let scraperLog: string[] = [];
let scraperRunning = false;

function mime(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".csv")) return "text/csv; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
  return "application/octet-stream";
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

function handleStatic(req: IncomingMessage, res: ServerResponse): boolean {
  let urlPath = req.url?.split("?")[0] ?? "/";
  if (urlPath === "/") urlPath = "/index.html";

  const filePath = join(OUTPUT_DIR, urlPath);
  if (!filePath.startsWith(OUTPUT_DIR) || !existsSync(filePath)) return false;

  try {
    const content = readFileSync(filePath);
    res.writeHead(200, { "Content-Type": mime(filePath), "Cache-Control": "no-store" });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

function startScraper(connector: string, categorySelections: string[]) {
  if (scraperRunning) return;

  scraperRunning = true;
  scraperLog = [
    `[${new Date().toLocaleTimeString()}] Starting scraper (connector: ${connector}${categorySelections.length > 0 ? `, categories: ${categorySelections.join(", ")}` : ""})...\n`,
  ];

  const args = ["start", "--", "--connector", connector];
  if (categorySelections.length > 0) {
    args.push("--categories", categorySelections.join(","));
  }
  scraperProcess = spawn("npm", args, {
    cwd: join(import.meta.dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });

  scraperProcess.stdout?.on("data", (data: Buffer) => {
    scraperLog.push(data.toString());
  });

  scraperProcess.stderr?.on("data", (data: Buffer) => {
    const text = data.toString();
    // Filter out npm notices
    if (!text.includes("npm notice")) {
      scraperLog.push(text);
    }
  });

  scraperProcess.on("close", (code) => {
    scraperLog.push(`\n[${new Date().toLocaleTimeString()}] Scraper finished (exit code: ${code})\n`);
    scraperRunning = false;
    scraperProcess = null;
  });

  scraperProcess.on("error", (err) => {
    scraperLog.push(`\n[ERROR] ${err.message}\n`);
    scraperRunning = false;
    scraperProcess = null;
  });
}

// Dashboard scope: only Vaperalia + Eciglogistica. Other connectors are kept
// in the codebase and runnable via CLI (--connector <name>) but excluded here.
function createConnectors(): Connector[] {
  return [new VaperaliaConnector(), new EciglogisticaConnector()];
}

async function readCategories() {
  const entries = await Promise.all(
    createConnectors().map(async (connector) => [
      connector.name.toLowerCase(),
      await connector.getCategorySeeds(),
    ])
  );
  return Object.fromEntries(entries);
}

interface OutputFile {
  name: string;
  path: string;
  group: "main" | "category";
  size: number;
  mtimeMs: number;
}

function readOutputFiles(): OutputFile[] {
  const files: OutputFile[] = [];

  function addFiles(dir: string, group: OutputFile["group"], urlPrefix: string) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json") && !name.endsWith(".csv")) continue;
      const filePath = join(dir, name);
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;
      files.push({
        name,
        path: `${urlPrefix}/${encodeURIComponent(name)}`,
        group,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  addFiles(OUTPUT_DIR, "main", "");
  addFiles(join(OUTPUT_DIR, "categories"), "category", "/categories");

  return files.sort((a, b) => {
    if (a.group !== b.group) return a.group === "main" ? -1 : 1;
    return b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name);
  });
}

function parseCategorySelections(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const categoriesByConnector = (data as { categoriesByConnector?: unknown })
    .categoriesByConnector;
  if (!categoriesByConnector || typeof categoriesByConnector !== "object") {
    return [];
  }

  const selections: string[] = [];
  for (const [connector, rawIds] of Object.entries(categoriesByConnector)) {
    if (!Array.isArray(rawIds)) continue;
    if (rawIds.length === 0) {
      selections.push(`${connector.toLowerCase()}:__none__`);
      continue;
    }
    for (const rawId of rawIds) {
      if (typeof rawId !== "string" || rawId.trim().length === 0) continue;
      selections.push(`${connector.toLowerCase()}:${rawId.trim()}`);
    }
  }
  return selections;
}

const server = createServer((req, res) => {
  const method = req.method ?? "GET";
  const url = req.url?.split("?")[0] ?? "/";

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // API routes
  if (url === "/api/categories" && method === "GET") {
    readCategories()
      .then((categories) => json(res, 200, categories))
      .catch((err) =>
        json(res, 500, {
          error: err instanceof Error ? err.message : "Could not read categories",
        })
      );
    return;
  }

  if (url === "/api/outputs" && method === "GET") {
    try {
      return json(res, 200, { files: readOutputFiles() });
    } catch (err) {
      return json(res, 500, {
        error: err instanceof Error ? err.message : "Could not read output files",
      });
    }
  }

  if (url === "/api/scrape" && method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (scraperRunning) {
        return json(res, 409, { error: "Scraper already running" });
      }
      let connector = "all";
      let categorySelections: string[] = [];
      try {
        const parsed = JSON.parse(body);
        if (parsed.connector) connector = parsed.connector;
        categorySelections = parseCategorySelections(parsed);
      } catch { /* use default */ }
      startScraper(connector, categorySelections);
      json(res, 200, { status: "started", connector, categories: categorySelections });
    });
    return;
  }

  if (url === "/api/status" && method === "GET") {
    return json(res, 200, {
      running: scraperRunning,
      log: scraperLog.join(""),
      lines: scraperLog.length,
    });
  }

  if (url === "/api/stop" && method === "POST") {
    if (scraperProcess) {
      scraperProcess.kill("SIGTERM");
      scraperLog.push(`\n[${new Date().toLocaleTimeString()}] Scraper stopped by user\n`);
      scraperRunning = false;
    }
    return json(res, 200, { status: "stopped" });
  }

  // Static files
  if (handleStatic(req, res)) return;

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Dashboard server running at http://localhost:${PORT}`);
});
