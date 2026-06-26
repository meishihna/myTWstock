/**
 * 讀 public/data/themes-index.json + screener-index.json,
 * 產出精簡的 public/data/map-index.json —— 供 /map(熱力圖磚塊大小、題材內個股小熱力圖)
 * 與主題頁(供應鏈卡片 / SVG 流向圖)共用。
 *
 * 每主題:slug / title / companyCount / aggMcap(成分股市值合計,百萬)
 *   / related[{label,slug}](由 relatedRaw 解析,slug 可為 null=純顯示)
 *   / tiers{ u,m,d: [{t,n,s,ss,mc}] }(上/中/下游;mc=該股市值,供排版與卡片)
 *
 * 須在 build-themes-index.mjs + build-screener-index.mjs 之後執行(讀其輸出)。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(__dirname, "..");
const DATA = path.join(WEB, "public", "data");
const THEMES = path.join(DATA, "themes-index.json");
const SCREENER = path.join(DATA, "screener-index.json");
const OUT = path.join(DATA, "map-index.json");

const TIER_KEYS = { upstream: "u", midstream: "m", downstream: "d" };

function main() {
  if (!existsSync(THEMES)) {
    console.warn("[map] themes-index.json missing, skip (run build-themes-index first)");
    return;
  }
  const themes = (JSON.parse(readFileSync(THEMES, "utf8")).themes) || [];

  // 市值查找表:ticker -> marketCap(百萬台幣),來自 screener-index
  const mcByTicker = {};
  if (existsSync(SCREENER)) {
    for (const r of (JSON.parse(readFileSync(SCREENER, "utf8")).rows) || []) {
      if (r.mc != null && Number.isFinite(r.mc)) mcByTicker[r.t] = r.mc;
    }
  } else {
    console.warn("[map] screener-index.json missing — tiles will lack market caps");
  }

  // 主題標題/slug -> slug,供 relatedRaw 解析為相關主題連結
  const titleToSlug = {};
  for (const t of themes) {
    titleToSlug[t.title] = t.slug;
    titleToSlug[t.title.replace(/\s+/g, "")] = t.slug;
    titleToSlug[t.slug] = t.slug;
  }

  const out = themes.map((t) => {
    const tiers = { u: [], m: [], d: [] };
    const seen = new Set();
    let aggMcap = 0;
    for (const longKey of ["upstream", "midstream", "downstream"]) {
      const sk = TIER_KEYS[longKey];
      for (const c of t.tiers?.[longKey] || []) {
        const mc = mcByTicker[c.ticker] ?? null;
        tiers[sk].push({ t: c.ticker, n: c.name, s: c.sector, ss: c.sectorSlug || "", mc });
        if (!seen.has(c.ticker)) {
          seen.add(c.ticker);
          if (mc != null) aggMcap += mc;
        }
      }
    }

    const related = [];
    const seenRel = new Set();
    const re = /\[\[([^\]]+)\]\]/g;
    let m;
    while ((m = re.exec(t.relatedRaw || "")) !== null) {
      const label = m[1].trim();
      if (!label || seenRel.has(label)) continue;
      seenRel.add(label);
      const slug = titleToSlug[label] || titleToSlug[label.replace(/\s+/g, "")] || null;
      related.push({ label, slug });
    }

    return {
      slug: t.slug,
      title: t.title,
      companyCount: t.companyCount,
      aggMcap: Math.round(aggMcap),
      related,
      tiers,
    };
  });

  // 依成分股市值合計由大到小(熱力圖與卡牆預設排序)
  out.sort((a, b) => (b.aggMcap ?? 0) - (a.aggMcap ?? 0));

  mkdirSync(DATA, { recursive: true });
  const payload = JSON.stringify({ generatedAt: new Date().toISOString(), themes: out });
  const tmp = `${OUT}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, payload, "utf8");
  try {
    if (existsSync(OUT)) unlinkSync(OUT);
    renameSync(tmp, OUT);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
  console.log("[map] wrote", OUT, "| themes:", out.length);
}

main();
