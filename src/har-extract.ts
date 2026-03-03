#!/usr/bin/env node
import * as fs from "fs";
import { promises as fsp } from "fs";
import * as path from "path";
import { URL } from "url";

type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const DEFAULT_EXTS = new Set<string>([
  ".js", ".mjs", ".css",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".webm", ".m4a",
  ".pdf", ".zip", ".gz", ".map",
]);

const MIME_TO_EXT: Record<string, string> = {
  "application/javascript": ".js",
  "text/javascript": ".js",
  "text/css": ".css",
  "application/json": ".json",
  "text/html": ".html",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/x-icon": ".ico",
  "font/woff": ".woff",
  "font/woff2": ".woff2",
  "application/font-woff2": ".woff2",
  "application/pdf": ".pdf",
};

type MatchMode = "exact" | "noquery";
type WhitelistMode = "none" | "url" | "name";

interface Args {
  har: string | null;
  out: string;
  keepDirs: boolean;
  includeAll: boolean;
  exts: string[];
  onlyStatus200: boolean;
  skipEmpty: boolean;
  inputList: string | null; // URLs
  nameList: string | null;  // basenames
  matchMode: MatchMode;
  logLevel: LogLevel;
  logFile: string | null;
  manifest: string | null;
  cleanStart: boolean;
}

interface HarHeader { name?: string; value?: string; }
interface HarContent { mimeType?: string; text?: string; encoding?: string; size?: number; }
interface HarRequest { url?: string; method?: string; }
interface HarResponse { status?: number; headers?: HarHeader[]; content?: HarContent; bodySize?: number; }
interface HarEntry { request?: HarRequest; response?: HarResponse; _resourceType?: string; }
interface HarRoot { log?: { entries?: HarEntry[] } }

interface ManifestItem {
  index: number;
  url: string;
  basename: string;
  method?: string;
  status?: number;
  mimeType: string;
  bytes: number;
  savedAs: string;
  fromContentDisposition: boolean;
  resourceType: string | null;
}

function safeStringify(obj: unknown): string {
  try { return JSON.stringify(obj); } catch { return String(obj); }
}

function makeLogger(level: LogLevel, logFile: string | null) {
  const min = LEVELS[level] ?? LEVELS.info;
  const fileStream = logFile ? fs.createWriteStream(logFile, { flags: "a", encoding: "utf8" }) : null;

  function writeLine(lvl: LogLevel, msg: string, obj?: unknown) {
    const now = new Date().toISOString();
    const line = `[${now}] ${lvl.toUpperCase()} ${msg}${obj ? " " + safeStringify(obj) : ""}`;
    if (lvl === "error" || lvl === "warn") console.error(line);
    else console.log(line);
    if (fileStream) fileStream.write(line + "\n");
  }

  function log(lvl: LogLevel, msg: string, obj?: unknown) {
    if ((LEVELS[lvl] ?? 999) < min) return;
    writeLine(lvl, msg, obj);
  }

  return {
    debug: (m: string, o?: unknown) => log("debug", m, o),
    info: (m: string, o?: unknown) => log("info", m, o),
    warn: (m: string, o?: unknown) => log("warn", m, o),
    error: (m: string, o?: unknown) => log("error", m, o),
    close: () => fileStream?.end(),
  };
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const opts: Args = {
    har: null,
    out: "output",
    keepDirs: false,
    includeAll: false,
    exts: [],
    onlyStatus200: false,
    skipEmpty: false,
    inputList: null,
    nameList: null,
    matchMode: "exact",
    logLevel: "info",
    logFile: null,
    manifest: null,
    cleanStart: false,
  };

  let i = 0;
  while (i < args.length) {
    const a = args[i];

    if (!opts.har && !a.startsWith("--")) {
      opts.har = a;
      i++;
      continue;
    }

    switch (a) {
      case "--out": opts.out = args[++i]; break;
      case "--keep-dirs": opts.keepDirs = true; break;
      case "--include-all": opts.includeAll = true; break;
      case "--ext": opts.exts.push(args[++i]); break;
      case "--only-status-200": opts.onlyStatus200 = true; break;
      case "--skip-empty": opts.skipEmpty = true; break;

      case "--input-list": opts.inputList = args[++i]; break;
      case "--name-list": opts.nameList = args[++i]; break;
      case "--match-mode": opts.matchMode = (args[++i] as MatchMode) ?? "exact"; break;

      case "--log-level": opts.logLevel = (args[++i] as LogLevel) ?? "info"; break;
      case "--log-file": opts.logFile = args[++i]; break;

      case "--manifest": opts.manifest = args[++i]; break;

      case "--clean": opts.cleanStart = true; break;

      default:
        console.error("Unknown arg:", a);
        process.exit(2);
    }
    i++;
  }

  if (!opts.har) {
    // Default to input folder if no HAR path is provided.
    opts.har = path.join("input", "session.har");
  }

  if (!(opts.logLevel in LEVELS)) {
    console.error("Invalid --log-level. Use: debug | info | warn | error");
    process.exit(2);
  }

  if (opts.matchMode !== "exact" && opts.matchMode !== "noquery") {
    console.error('Invalid --match-mode. Use: "exact" or "noquery"');
    process.exit(2);
  }

  if (opts.inputList && opts.nameList) {
    console.error("Use either --input-list OR --name-list (not both).");
    process.exit(2);
  }

  return opts;
}

function safeName(name: string): string {
  const cleaned = (name ?? "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return cleaned || "file";
}

function normalizeExt(e: string): string {
  if (!e) return "";
  return e.startsWith(".") ? e.toLowerCase() : "." + e.toLowerCase();
}

function canonicalUrl(urlStr: string, matchMode: MatchMode): string {
  try {
    const u = new URL(urlStr);
    if (matchMode === "noquery") {
      u.search = "";
      u.hash = "";
    }
    return u.toString();
  } catch {
    return urlStr;
  }
}

function basenameFromUrl(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    const base = path.posix.basename(u.pathname || "/");
    return safeName(decodeURIComponent(base || "index"));
  } catch {
    const parts = String(urlStr).split("/");
    return safeName(parts[parts.length - 1] || "file");
  }
}

function guessPathFromUrl(urlStr: string, keepDirs: boolean): string {
  try {
    const u = new URL(urlStr);
    let pathname = u.pathname || "/";
    if (pathname.endsWith("/")) pathname += "index";
    const parts = pathname.split("/").filter(Boolean).map(p => safeName(decodeURIComponent(p)));
    if (parts.length === 0) parts.push("index");
    return keepDirs ? path.join(...parts) : parts[parts.length - 1];
  } catch {
    return "file";
  }
}

function getHeaderValue(headers: HarHeader[] | undefined, name: string): string | null {
  if (!headers) return null;
  const needle = name.toLowerCase();
  for (const h of headers) {
    if ((h.name || "").toLowerCase() === needle) return h.value ?? null;
  }
  return null;
}

function contentDispositionFilename(headers: HarHeader[] | undefined): string | null {
  const cd = getHeaderValue(headers, "content-disposition");
  if (!cd) return null;

  let m = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (m) return safeName(decodeURIComponent(m[1].replace(/['"]/g, "")));

  m = cd.match(/filename="([^"]+)"/i) || cd.match(/filename=([^;]+)/i);
  if (m) return safeName(m[1].replace(/['"]/g, ""));

  return null;
}

function decodeBody(contentObj: HarContent | undefined): Buffer | null {
  if (!contentObj) return null;
  if (contentObj.text === undefined || contentObj.text === null) return null;

  const encoding = (contentObj.encoding || "").toLowerCase();
  if (encoding === "base64") {
    try {
      return Buffer.from(contentObj.text, "base64");
    } catch {
      const cleaned = String(contentObj.text).replace(/\s+/g, "");
      return Buffer.from(cleaned, "base64");
    }
  }
  return Buffer.from(String(contentObj.text), "utf8");
}

async function ensureUniquePath(fullPath: string): Promise<string> {
  try {
    await fsp.access(fullPath);
    const dir = path.dirname(fullPath);
    const ext = path.extname(fullPath);
    const base = path.basename(fullPath, ext);
    for (let i = 1; i < 10000; i++) {
      const cand = path.join(dir, `${base}__${i}${ext}`);
      try {
        await fsp.access(cand);
      } catch {
        return cand;
      }
    }
    throw new Error(`Too many duplicates for ${fullPath}`);
  } catch {
    return fullPath;
  }
}

async function loadList(filePath: string, mode: "url" | "name", log: ReturnType<typeof makeLogger>): Promise<Set<string>> {
  const abs = path.resolve(filePath);
  let raw: string;

  try {
    raw = await fsp.readFile(abs, "utf8");
  } catch (e: any) {
    log.error("Cannot read list file", { file: abs, error: e?.message });
    process.exit(3);
  }

  const ext = path.extname(abs).toLowerCase();
  let items: string[] = [];

  if (ext === ".json") {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("JSON is not an array");
      items = parsed.map((x: any) => String(x));
    } catch (e: any) {
      log.error("Invalid JSON list file", { file: abs, error: e?.message });
      process.exit(3);
    }
  } else {
    items = raw
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith("#"));
  }

  const set = new Set<string>();
  for (const it of items) {
    set.add(mode === "name" ? safeName(it) : it);
  }

  log.info("Loaded list", { file: abs, count: set.size, mode });
  return set;
}

async function cleanStartArtifacts(opts: Args) {
  const outDir = path.resolve(opts.out);
  const manifestPath = path.resolve(opts.manifest ?? "manifest.json");
  const logPath = path.resolve(opts.logFile ?? "extract.log");

  const targets = [
    { label: "output dir", p: outDir },
    { label: "manifest", p: manifestPath },
    { label: "log file", p: logPath },
  ];

  for (const t of targets) {
    try {
      await fsp.rm(t.p, { recursive: true, force: true });
      console.log(`Cleaned ${t.label}`, t.p);
    } catch (e: any) {
      console.error(`Failed to clean ${t.label}`, { path: t.p, error: e?.message });
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.inputList && !opts.nameList) {
    opts.nameList = path.join("input", "names.txt");
  }
  if (!opts.logFile) {
    opts.logFile = path.join(opts.out, "extract.log");
  }
  if (!opts.manifest) {
    opts.manifest = path.join(opts.out, "manifest.json");
  }
  if (opts.cleanStart) {
    await cleanStartArtifacts(opts);
  }
  await fsp.mkdir(opts.out, { recursive: true });
  if (opts.logFile) {
    await fsp.mkdir(path.dirname(opts.logFile), { recursive: true });
  }
  if (opts.manifest) {
    await fsp.mkdir(path.dirname(opts.manifest), { recursive: true });
  }
  const log = makeLogger(opts.logLevel, opts.logFile);

  const allowedExts = new Set<string>([...DEFAULT_EXTS]);
  for (const e of opts.exts) allowedExts.add(normalizeExt(e));

  let whitelistMode: WhitelistMode = "none";
  let urlWhitelist: Set<string> | null = null;
  let nameWhitelist: Set<string> | null = null;

  if (opts.inputList) {
    whitelistMode = "url";
    const raw = await loadList(opts.inputList, "url", log);
    urlWhitelist = new Set([...raw].map(u => canonicalUrl(u, opts.matchMode)));
    log.info("Prepared URL whitelist", { count: urlWhitelist.size, matchMode: opts.matchMode });
  } else if (opts.nameList) {
    whitelistMode = "name";
    nameWhitelist = await loadList(opts.nameList, "name", log);
  }

  log.info("Starting HAR extraction", {
    har: path.resolve(opts.har!),
    out: path.resolve(opts.out),
    keepDirs: opts.keepDirs,
    includeAll: opts.includeAll,
    onlyStatus200: opts.onlyStatus200,
    skipEmpty: opts.skipEmpty,
    matchMode: opts.matchMode,
    whitelistMode,
    manifest: opts.manifest ? path.resolve(opts.manifest) : null,
  });

  let har: HarRoot;
  try {
    const harRaw = await fsp.readFile(opts.har!, "utf8");
    har = JSON.parse(harRaw) as HarRoot;
  } catch (e: any) {
    log.error("Failed to read/parse HAR", { error: e?.message });
    log.close();
    process.exit(3);
  }

  const entries = har.log?.entries ?? [];
  await fsp.mkdir(opts.out, { recursive: true });

  let saved = 0, skippedNoBody = 0, skippedFilter = 0, skippedWhitelist = 0;
  const manifestItems: ManifestItem[] = [];

  for (let idx = 0; idx < entries.length; idx++) {
    const e = entries[idx] ?? {};
    const req = e.request ?? {};
    const res = e.response ?? {};
    const url = req.url ?? "";

    if (!url) {
      skippedFilter++;
      log.debug("Skip: missing request.url", { index: idx });
      continue;
    }

    // Whitelist
    if (urlWhitelist) {
      const canon = canonicalUrl(url, opts.matchMode);
      if (!urlWhitelist.has(canon)) {
        skippedWhitelist++;
        log.debug("Skip: not in URL whitelist", { index: idx, url: canon });
        continue;
      }
    } else if (nameWhitelist) {
      const base = basenameFromUrl(url);
      if (!nameWhitelist.has(base)) {
        skippedWhitelist++;
        log.debug("Skip: not in NAME whitelist", { index: idx, url, basename: base });
        continue;
      }
    }

    const status = res.status;
    if (opts.onlyStatus200 && status !== 200) {
      skippedFilter++;
      log.debug("Skip: status not 200", { index: idx, url, status });
      continue;
    }

    const contentObj = res.content;
    const body = decodeBody(contentObj);
    if (body === null) {
      skippedNoBody++;
      log.debug("Skip: no response body in HAR (response.content.text missing)", { index: idx, url, status });
      continue;
    }

    if (opts.skipEmpty && body.length === 0) {
      skippedFilter++;
      log.debug("Skip: empty body after decode", { index: idx, url, status });
      continue;
    }

    const mimeRaw = (contentObj?.mimeType ?? "").split(";")[0].trim().toLowerCase();
    const cdName = contentDispositionFilename(res.headers);

    let relPath = cdName ? cdName : guessPathFromUrl(url, opts.keepDirs);

    if (!path.extname(relPath) && MIME_TO_EXT[mimeRaw]) {
      relPath = relPath + MIME_TO_EXT[mimeRaw];
    }

    if (!opts.includeAll) {
      const finalExt = path.extname(relPath).toLowerCase();
      if (!allowedExts.has(finalExt)) {
        skippedFilter++;
        log.debug("Skip: extension not allowed", { index: idx, url, ext: finalExt, mime: mimeRaw });
        continue;
      }
    }

    const safeParts = relPath.split(path.sep).map(p => safeName(p));
    const target = path.join(opts.out, ...safeParts);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const uniqueTarget = await ensureUniquePath(target);

    try {
      await fsp.writeFile(uniqueTarget, body);
      saved++;

      const item: ManifestItem = {
        index: idx,
        url,
        basename: basenameFromUrl(url),
        method: req.method,
        status,
        mimeType: mimeRaw || (contentObj?.mimeType ?? ""),
        bytes: body.length,
        savedAs: path.resolve(uniqueTarget),
        fromContentDisposition: Boolean(cdName),
        resourceType: e._resourceType ?? null,
      };
      manifestItems.push(item);
      log.info("Saved", item);
    } catch (err: any) {
      log.error("Failed to write file", { index: idx, url, target: uniqueTarget, error: err?.message });
    }
  }

  if (opts.manifest) {
    try {
      await fsp.writeFile(
        opts.manifest,
        JSON.stringify({
          sourceHar: path.resolve(opts.har!),
          outputDir: path.resolve(opts.out),
          saved,
          skippedNoBody,
          skippedFilter,
          skippedWhitelist,
          matchMode: opts.matchMode,
          whitelistMode,
          items: manifestItems,
        }, null, 2),
        "utf8"
      );
      log.info("Wrote manifest", { file: path.resolve(opts.manifest), items: manifestItems.length });
    } catch (e: any) {
      log.error("Failed to write manifest", { file: path.resolve(opts.manifest), error: e?.message });
    }
  }

  log.info("Done", {
    entries: entries.length,
    saved,
    skippedNoBody,
    skippedFilter,
    skippedWhitelist,
    out: path.resolve(opts.out),
  });

  log.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(4);
});
