/**
 * Reads ../themes/*.md (excl. README), writes public/data/themes-index.json
 * for /themes pages. Requires reports-index.json for sectorSlug on links.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(__dirname, "..");
const REPO_ROOT = path.join(WEB_ROOT, "..");
const THEMES_DIR = path.join(REPO_ROOT, "themes");
const OUT_DIR = path.join(WEB_ROOT, "public", "data");
const OUT_FILE = path.join(OUT_DIR, "themes-index.json");
const IDX_FILE = path.join(OUT_DIR, "reports-index.json");

const BULLET_RE = /^\s*-\s*\*\*(\d{4})\s+(.+?)\*\*\s*\(([^)]+)\)/;

function parseTheme(content, fileBase) {
  const slug = fileBase.replace(/\.md$/i, "");
  const lines = content.split(/\r?\n/);
  const h1 = lines.find((l) => l.startsWith("# "));
  const title = h1 ? h1.slice(2).trim() : slug;
  let companyCount = 0;
  const cm = content.match(/\*\*涵蓋公司數:\*\*\s*(\d+)/);
  if (cm) companyCount = parseInt(cm[1], 10);

  const relM = content.match(/\*\*相關主題:\*\*\s*(.+)/);
  const relatedRaw = relM ? relM[1].trim() : "";

  const tiers = { upstream: [], midstream: [], downstream: [] };
  let current = null;
  for (const line of lines) {
    if (/^##\s*上游/.test(line)) {
      current = "upstream";
      continue;
    }
    if (/^##\s*中游/.test(line)) {
      current = "midstream";
      continue;
    }
    if (/^##\s*下游/.test(line)) {
      current = "downstream";
      continue;
    }
    if (line.startsWith("## ")) {
      current = null;
      continue;
    }
    const bm = line.match(BULLET_RE);
    if (bm && current) {
      tiers[current].push({
        ticker: bm[1],
        name: bm[2].trim(),
        sector: bm[3].trim(),
      });
    }
  }

  return { slug, title, companyCount, relatedRaw, tiers };
}

function main() {
  if (!existsSync(THEMES_DIR)) {
    console.error("themes/ not found:", THEMES_DIR);
    process.exit(1);
  }
  if (!existsSync(IDX_FILE)) {
    console.error("Run build-index.mjs first (missing reports-index.json)");
    process.exit(1);
  }

  const idx = JSON.parse(readFileSync(IDX_FILE, "utf8"));
  const byTicker = idx.byTicker || {};

  const themes = [];
  for (const name of readdirSync(THEMES_DIR)) {
    if (!name.endsWith(".md") || name === "README.md") continue;
    const fp = path.join(THEMES_DIR, name);
    const raw = readFileSync(fp, "utf8");
    const t = parseTheme(raw, name);
    for (const key of ["upstream", "midstream", "downstream"]) {
      for (const row of t.tiers[key]) {
        const meta = byTicker[row.ticker];
        row.sectorSlug = meta?.sectorSlug ?? "";
      }
    }
    themes.push(t);
  }

  themes.sort((a, b) => a.title.localeCompare(b.title, "zh-Hant"));

  mkdirSync(OUT_DIR, { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    themes,
  };
  writeFileSync(OUT_FILE, JSON.stringify(payload), "utf8");
  console.log("Wrote", OUT_FILE, "| themes:", themes.length);
}

main();
