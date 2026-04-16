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
} from "fs";
import { copyFile, unlink, writeFile } from "fs/promises";
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

/**
 * Windows 上對 Desktop/OneDrive 下既有檔案直接 writeFileSync 可能 errno -4094 UNKNOWN；
 * 先寫 .tmp 再 rename，並短重試（檔案被編輯器或同步鎖住時）。
 */
async function writeJsonAtomicWithRetry(filePath, payload) {
  const json = JSON.stringify(payload);
  const tmp = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.${process.pid}.tmp`
  );
  let lastErr;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await writeFile(tmp, json, "utf8");
      // Windows：直接寫入已存在且被同步/防毒開著的檔易 UNKNOWN；copyFile 覆蓋通常較穩
      await copyFile(tmp, filePath);
      await unlink(tmp);
      return;
    } catch (e) {
      lastErr = e;
      try {
        await unlink(tmp);
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 120 * (attempt + 1)));
    }
  }
  console.error(
    "\n無法寫入",
    filePath,
    "\n常見原因：檔案在編輯器中開著、OneDrive/防毒鎖定。請關閉該檔、暫停同步後重試；或將專案移到非同步資料夾（例如 C:\\dev）。\n"
  );
  throw lastErr;
}

async function main() {
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

  await writeJsonAtomicWithRetry(OUT_FILE, payload);
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
