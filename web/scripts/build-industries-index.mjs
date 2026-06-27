/**
 * 讀 ../industries/*.md(build_industries.py 產出,TPEx 產業價值鏈)+ screener/momentum/reports-index,
 * 產出 public/data/industries-index.json —— 供「產業」section(/sectors)的 TPEx 產業頁
 * (上下游框圖 + 角色分群)使用。與 /map 投資題材(themes-index)完全分離。
 *
 * 每產業:slug / title / category(頂層 tile)/ flat(服務型無上中下游)/ indicators
 *   / companyCount / aggMcap / tiers{u,m,d:[{t,n,s,ss,mc,subcat,revYoy,mom,status}]}
 *
 * 須在 build-index / build-screener-index / build-momentum 之後執行。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(__dirname, "..");
const REPO = path.join(WEB, "..");
const IND_DIR = path.join(REPO, "industries");
const DATA = path.join(WEB, "public", "data");
const REPORTS = path.join(DATA, "reports-index.json");
const SCREENER = path.join(DATA, "screener-index.json");
const MOMENTUM = path.join(DATA, "momentum.json");
const OUT = path.join(DATA, "industries-index.json");

const BULLET_RE = /^\s*-\s*\*\*(\d{4})\s+(.+?)\*\*\s*\(([^)]+)\)(?:\s*\[([^\]]+)\])?/;
const TIER_KEYS = { upstream: "u", midstream: "m", downstream: "d" };
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parseIndicators(raw) {
  if (!raw) return [];
  return raw
    .split("|")
    .map((seg) => {
      const i = seg.indexOf("=");
      if (i < 0) return null;
      const label = seg.slice(0, i).trim();
      const value = seg.slice(i + 1).trim();
      return label && value ? { label, value } : null;
    })
    .filter(Boolean);
}

function parseIndustry(content, fileBase) {
  const slug = fileBase.replace(/\.md$/i, "");
  const lines = content.split(/\r?\n/);
  const h1 = lines.find((l) => l.startsWith("# "));
  const title = h1 ? h1.slice(2).trim() : slug;
  const cm = content.match(/\*\*涵蓋公司數:\*\*\s*(\d+)/);
  const companyCount = cm ? parseInt(cm[1], 10) : 0;
  const descM = content.match(/^>\s*(.+)$/m);
  const desc = descM ? descM[1].trim() : "";
  const catM = content.match(/\*\*分類:\*\*\s*(.+)/);
  const category = catM ? catM[1].trim() : "";
  const flat = /\*\*型態:\*\*\s*flat/.test(content);
  const indM = content.match(/\*\*關鍵指標:\*\*\s*(.+)/);
  const indicators = parseIndicators(indM ? indM[1].trim() : "");

  const tiers = { upstream: [], midstream: [], downstream: [] };
  let current = null;
  for (const line of lines) {
    if (/^##\s*上游/.test(line)) { current = "upstream"; continue; }
    if (/^##\s*中游/.test(line)) { current = "midstream"; continue; }
    if (/^##\s*下游/.test(line)) { current = "downstream"; continue; }
    if (line.startsWith("## ")) { current = null; continue; }
    const bm = line.match(BULLET_RE);
    if (bm && current) {
      tiers[current].push({
        ticker: bm[1], name: bm[2].trim(), sector: bm[3].trim(), subcat: (bm[4] || "").trim(),
      });
    }
  }
  return { slug, title, category, flat, indicators, companyCount, tiers };
}

function main() {
  if (!existsSync(IND_DIR)) {
    console.warn("[industries] industries/ missing, skip");
    return;
  }
  const byTicker = existsSync(REPORTS) ? (JSON.parse(readFileSync(REPORTS, "utf8")).byTicker || {}) : {};
  const fin = {};
  if (existsSync(SCREENER)) {
    for (const r of (JSON.parse(readFileSync(SCREENER, "utf8")).rows) || []) {
      fin[r.t] = { mc: num(r.mc), pe: num(r.pe), revYoy: num(r.revYoy), roe: num(r.roe), nm: num(r.nm) };
    }
  }
  const momByTicker = existsSync(MOMENTUM) ? (JSON.parse(readFileSync(MOMENTUM, "utf8")).mom || {}) : {};

  const out = [];
  for (const name of readdirSync(IND_DIR)) {
    if (!name.endsWith(".md") || name === "README.md") continue;
    const parsed = parseIndustry(readFileSync(path.join(IND_DIR, name), "utf8"), name);
    const tiers = { u: [], m: [], d: [] };
    let aggMcap = 0, leadT = null, leadMc = -1;
    const seen = new Set();
    for (const longKey of ["upstream", "midstream", "downstream"]) {
      const sk = TIER_KEYS[longKey];
      for (const c of parsed.tiers[longKey]) {
        const f = fin[c.ticker] || {};
        const mc = f.mc ?? null;
        const challenge = (f.roe != null && f.roe < 0) || (f.nm != null && f.nm < 0);
        tiers[sk].push({
          t: c.ticker, n: c.name, s: c.sector,
          ss: byTicker[c.ticker]?.sectorSlug || "",
          mc, subcat: c.subcat || "",
          pe: f.pe ?? null,
          revYoy: f.revYoy ?? null,
          mom: momByTicker[c.ticker] || 0,
          status: challenge ? "challenge" : "",
        });
        if (!seen.has(c.ticker)) { seen.add(c.ticker); if (mc != null) aggMcap += mc; }
        if (mc != null && mc > leadMc) { leadMc = mc; leadT = c.ticker; }
      }
    }
    if (leadT) for (const sk of ["u", "m", "d"]) for (const co of tiers[sk]) if (co.t === leadT) co.status = "lead";

    out.push({
      slug: parsed.slug, title: parsed.title, category: parsed.category,
      flat: parsed.flat, indicators: parsed.indicators,
      companyCount: parsed.companyCount, aggMcap: Math.round(aggMcap), tiers,
    });
  }
  out.sort((a, b) => (b.aggMcap ?? 0) - (a.aggMcap ?? 0));

  mkdirSync(DATA, { recursive: true });
  writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), industries: out }), "utf8");
  console.log("[industries] wrote", OUT, "| industries:", out.length);
}

main();
