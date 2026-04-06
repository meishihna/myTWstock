/**
 * Scans ../Pilot_Reports, writes public/data/reports-index.json,
 * copies ../network → public/network for local graph.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(__dirname, "..");
const REPO_ROOT = path.join(WEB_ROOT, "..");
const REPORTS_DIR = path.join(REPO_ROOT, "Pilot_Reports");
const OUT_DIR = path.join(WEB_ROOT, "public", "data");
const OUT_FILE = path.join(OUT_DIR, "reports-index.json");

function walkMdFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkMdFiles(full, acc);
    else if (ent.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

function slugifySector(name) {
  let s = name
    .trim()
    .replace(/&/g, "and")
    .replace(/[^\w\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!s) s = "sector";
  return s.toLowerCase();
}

function assignSectorSlugs(sectorNames) {
  const nameToSlug = {};
  const slugToSector = {};
  const used = new Set();
  for (const name of [...sectorNames].sort()) {
    let base = slugifySector(name);
    let slug = base;
    let i = 2;
    while (used.has(slug)) {
      slug = `${base}-${i++}`;
    }
    used.add(slug);
    nameToSlug[name] = slug;
    slugToSector[slug] = name;
  }
  return { nameToSlug, slugToSector };
}

function main() {
  if (!existsSync(REPORTS_DIR)) {
    console.error("Pilot_Reports not found at:", REPORTS_DIR);
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });

  const files = walkMdFiles(REPORTS_DIR);
  const byTicker = {};
  const nameToTicker = {};
  const sectorCompanies = {};

  for (const fp of files) {
    const rel = path.relative(REPORTS_DIR, fp);
    const sector = path.dirname(rel);
    if (sector === ".") continue;

    const base = path.basename(fp, ".md");
    const m = base.match(/^(\d{4})_(.+)$/);
    if (!m) continue;

    const ticker = m[1];
    const name = m[2];
    const relPath = rel.split(path.sep).join("/");

    if (byTicker[ticker]) {
      console.warn("Duplicate ticker (keep first):", ticker, fp);
      continue;
    }

    byTicker[ticker] = {
      ticker,
      name,
      sector,
      relPath,
    };

    if (nameToTicker[name] && nameToTicker[name] !== ticker) {
      console.warn("Duplicate company name in filenames:", name, nameToTicker[name], ticker);
    } else {
      nameToTicker[name] = ticker;
    }

    if (!sectorCompanies[sector]) sectorCompanies[sector] = [];
    sectorCompanies[sector].push({ ticker, name });
  }

  for (const s of Object.keys(sectorCompanies)) {
    sectorCompanies[s].sort((a, b) => a.ticker.localeCompare(b.ticker));
  }

  const sectorNames = Object.keys(sectorCompanies);
  const { nameToSlug, slugToSector } = assignSectorSlugs(sectorNames);

  const sectors = sectorNames
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      slug: nameToSlug[name],
      count: sectorCompanies[name].length,
    }));

  for (const t of Object.keys(byTicker)) {
    const sec = byTicker[t].sector;
    byTicker[t].sectorSlug = nameToSlug[sec];
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    sectors,
    slugToSector,
    byTicker,
    nameToTicker,
  };

  writeFileSync(OUT_FILE, JSON.stringify(payload), "utf8");
  console.log(
    "Wrote",
    OUT_FILE,
    "| tickers:",
    Object.keys(byTicker).length,
    "| sectors:",
    sectors.length
  );

  const netSrc = path.join(REPO_ROOT, "network");
  const netDest = path.join(WEB_ROOT, "public", "network");
  if (existsSync(netSrc)) {
    mkdirSync(path.dirname(netDest), { recursive: true });
    cpSync(netSrc, netDest, { recursive: true });
    console.log("Copied network/ → public/network/");
  } else {
    console.warn("No network/ folder at repo root (graph page optional).");
  }
}

main();
