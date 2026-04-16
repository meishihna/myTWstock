/**
 * Lists wikilink targets not in nameToTicker → stub pages with backlinks.
 * Writes public/data/wikilink-stubs.json (used by /wiki/[slug]).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(__dirname, "..");
const REPO = path.join(WEB, "..");
const REPORTS = path.join(REPO, "Pilot_Reports");
const IDX = path.join(WEB, "public", "data", "reports-index.json");
const OUT = path.join(WEB, "public", "data", "wikilink-stubs.json");

function sleepMs(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* sync wait for build script retries */
  }
}

/** Windows / OneDrive 常對直接 write 回報 UNKNOWN；先寫 .tmp 再 replace，並短重試。 */
function writeJsonFile(dest, data, maxAttempts = 5) {
  const dir = path.dirname(dest);
  mkdirSync(dir, { recursive: true });
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const tmp = dest + ".tmp";
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      writeFileSync(tmp, body, "utf8");
      if (existsSync(dest)) unlinkSync(dest);
      renameSync(tmp, dest);
      return;
    } catch (e) {
      lastErr = e;
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      if (attempt < maxAttempts) sleepMs(120 * attempt);
    }
  }
  throw lastErr;
}

const WIKI = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

/** 與 build-wikilink-hub.mjs slugifyLabel、src/lib/wikiSlug.ts wikiLinkSlug 一致 */
function wikiLinkSlug(label) {
  let s = label
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w\u4e00-\u9fff-]/g, "");
  if (!s) s = "wiki";
  return s.toLowerCase();
}

function walkMd(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkMd(full, acc);
    else if (ent.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

function main() {
  if (!existsSync(IDX)) {
    console.warn("[wikilink-stubs] reports-index.json missing, skip");
    return;
  }
  const idx = JSON.parse(readFileSync(IDX, "utf8"));
  const nameToTicker = idx.nameToTicker || {};

  /** slug -> { labels: Set, mentions: Map ticker -> {ticker, name} } */
  const buckets = new Map();

  const files = walkMd(REPORTS);
  for (const fp of files) {
    const base = path.basename(fp, ".md");
    const m = base.match(/^(\d{4})_(.+)$/);
    if (!m) continue;
    const ticker = m[1];
    const name = m[2];
    const md = readFileSync(fp, "utf8");
    let wm;
    WIKI.lastIndex = 0;
    while ((wm = WIKI.exec(md)) !== null) {
      const label = wm[1].trim();
      if (!label || nameToTicker[label]) continue;
      const slug = wikiLinkSlug(label);
      if (!buckets.has(slug)) {
        buckets.set(slug, { labels: new Set(), mentions: new Map() });
      }
      const b = buckets.get(slug);
      b.labels.add(label);
      b.mentions.set(ticker, { ticker, name });
    }
  }

  const stubs = [...buckets.entries()]
    .map(([slug, { labels, mentions }]) => ({
      slug,
      labels: [...labels].sort(),
      mentions: [...mentions.values()].sort((a, b) =>
        a.ticker.localeCompare(b.ticker)
      ),
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  const payload = {
    generatedAt: new Date().toISOString(),
    stubs,
  };
  writeJsonFile(OUT, payload);
  console.log("[wikilink-stubs] wrote", OUT, "| stubs:", stubs.length);
}

main();
