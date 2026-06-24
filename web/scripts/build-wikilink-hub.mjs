/**
 * 掃描 Pilot_Reports 內所有 [[wikilink]]，依出現次數取前 500，產生 wikilink-hub-top500.json。
 * 需先執行 build-index.mjs（依賴 reports-index.json 的 sectorSlug）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { writeJsonAtomicWithRetry } from "./lib/write-json-atomic.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(__dirname, "..");
const REPO_ROOT = path.join(WEB_ROOT, "..");
const REPORTS_DIR = path.join(REPO_ROOT, "Pilot_Reports");
const IDX_FILE = path.join(WEB_ROOT, "public", "data", "reports-index.json");
const OUT_FILE = path.join(WEB_ROOT, "public", "data", "wikilink-hub-top500.json");
const TOP_N = 500;

function walkMdFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkMdFiles(full, acc);
    else if (ent.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

function slugifyLabel(text) {
  let s = text
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w\u4e00-\u9fff-]/g, "");
  if (!s) s = "wiki";
  return s.toLowerCase();
}

async function main() {
  if (!existsSync(IDX_FILE)) {
    console.error("Missing reports-index.json — run build-index.mjs first.");
    process.exit(1);
  }
  const idx = JSON.parse(readFileSync(IDX_FILE, "utf8"));
  const byTicker = idx.byTicker || {};

  const linkCount = new Map();
  const linkTickers = new Map();
  const reportLabels = new Map(); // ticker -> Set<label>(該報告出現的實體),供共現計算

  const wikiRe = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

  for (const fp of walkMdFiles(REPORTS_DIR)) {
    const base = path.basename(fp, ".md");
    const m = base.match(/^(\d{4})_(.+)$/);
    if (!m) continue;
    const ticker = m[1];
    const meta = byTicker[ticker];
    if (!meta) continue;

    const content = readFileSync(fp, "utf8");
    wikiRe.lastIndex = 0;
    let w;
    const labelsInReport = new Set();
    while ((w = wikiRe.exec(content)) !== null) {
      const label = w[1].trim();
      if (!label) continue;
      labelsInReport.add(label);
      linkCount.set(label, (linkCount.get(label) || 0) + 1);
      if (!linkTickers.has(label)) linkTickers.set(label, new Map());
      linkTickers.get(label).set(ticker, {
        ticker,
        name: meta.name,
        sector: meta.sector,
        sectorSlug: meta.sectorSlug,
      });
    }
    reportLabels.set(ticker, labelsInReport);
  }

  const sorted = [...linkCount.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, TOP_N);

  const usedSlugs = new Set();
  const entries = top.map(([label, count]) => {
    let slug = slugifyLabel(label);
    let n = 2;
    const baseSlug = slug;
    while (usedSlugs.has(slug)) {
      slug = `${baseSlug}-${n++}`;
    }
    usedSlugs.add(slug);
    const tmap = linkTickers.get(label);
    const tickers = tmap
      ? [...tmap.values()].sort((a, b) => a.ticker.localeCompare(b.ticker))
      : [];
    return { label, slug, count, tickers };
  });

  // 共現:對每個 top 實體,找最常一起出現(同報告)的其他 top 實體 → 供「相關實體」探索。
  // 僅納入同為 top-500 者(才有 wiki 頁可連結);門檻共現 >= 2 篇,取前 8。
  const labelToSlug = new Map(entries.map((e) => [e.label, e.slug]));
  for (const e of entries) {
    const co = new Map();
    const tmap = linkTickers.get(e.label);
    if (tmap) {
      for (const ticker of tmap.keys()) {
        const labs = reportLabels.get(ticker);
        if (!labs) continue;
        for (const ol of labs) {
          if (ol === e.label || !labelToSlug.has(ol)) continue;
          co.set(ol, (co.get(ol) || 0) + 1);
        }
      }
    }
    e.related = [...co.entries()]
      .filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([label, c]) => ({ label, slug: labelToSlug.get(label), count: c }));
  }

  mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  await writeJsonAtomicWithRetry(OUT_FILE, {
    generatedAt: new Date().toISOString(),
    limit: TOP_N,
    entries,
  });
  console.log("Wrote", OUT_FILE, "| entries:", entries.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
