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
const VALUATION = path.join(DATA, "valuation-index.json");
const MOMENTUM = path.join(DATA, "momentum.json");
const WIKIHUB = path.join(DATA, "wikilink-hub-top500.json");
const OUT = path.join(DATA, "map-index.json");
const NARRATIVES = path.join(WEB, "..", "themes", "narratives");

const TIER_KEYS = { upstream: "u", midstream: "m", downstream: "d" };
// 關聯度(供應鏈樞紐度)門檻:被多少份報告以 [[名稱]] 引用
const LINK_HIGH = 100;
const LINK_MID = 30;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// 題材敘事:讀手寫的 themes/narratives/{slug}.md(build_themes.py 不會覆寫);無檔→null。
// 每個 ## 段落 → { title, bullets[], text };bullets 來自 "- " 行,其餘併為 text。
function readNarrative(slug) {
  const p = path.join(NARRATIVES, `${slug}.md`);
  if (!existsSync(p)) return null;
  const secs = [];
  let cur = null;
  for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
    const h = raw.match(/^##\s+(.+?)\s*$/);
    if (h) { cur = { title: h[1].trim(), bullets: [], text: "" }; secs.push(cur); continue; }
    if (!cur) continue;
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("- ")) cur.bullets.push(line.slice(2).trim());
    else cur.text = cur.text ? `${cur.text} ${line}` : line;
  }
  const out = secs.filter((s) => s.bullets.length || s.text);
  return out.length ? out : null;
}

function main() {
  if (!existsSync(THEMES)) {
    console.warn("[map] themes-index.json missing, skip (run build-themes-index first)");
    return;
  }
  const themes = (JSON.parse(readFileSync(THEMES, "utf8")).themes) || [];

  // 個股查找表:ticker -> { mc, revYoy, roe, nm },來自 screener-index(全 1737 檔)
  const fin = {};
  if (existsSync(SCREENER)) {
    for (const r of (JSON.parse(readFileSync(SCREENER, "utf8")).rows) || []) {
      fin[r.t] = { mc: num(r.mc), pe: num(r.pe), eps: num(r.eps), revYoy: num(r.revYoy), roe: num(r.roe), nm: num(r.nm) };
    }
  } else {
    console.warn("[map] screener-index.json missing — tiles will lack market caps");
  }
  // 本益比優先用 valuation-index(TWSE/TPEx 官方、每日),screener(yfinance)為輔 → 與報告頁/產業頁同源
  const valPe = {};
  if (existsSync(VALUATION)) {
    const vr = JSON.parse(readFileSync(VALUATION, "utf8")).rows || {};
    for (const k of Object.keys(vr)) { const p = num(vr[k]?.pe); if (p != null) valPe[k] = p; }
  }

  // 連三月營收年增:ticker -> true(build-momentum.mjs)
  const momByTicker = existsSync(MOMENTUM) ? (JSON.parse(readFileSync(MOMENTUM, "utf8")).mom || {}) : {};

  // 關聯度:公司名 -> 被引用次數(wikilink-hub-top500),→ high/mid/""
  const linkByName = {};
  if (existsSync(WIKIHUB)) {
    for (const e of (JSON.parse(readFileSync(WIKIHUB, "utf8")).entries) || []) {
      if (e && e.label && Number.isFinite(e.count)) linkByName[e.label] = e.count;
    }
  }
  const linkLevel = (name) => {
    const c = linkByName[name];
    if (c == null) return "";
    return c >= LINK_HIGH ? "high" : c >= LINK_MID ? "mid" : "";
  };

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
    let leadT = null, leadMc = -1;
    for (const longKey of ["upstream", "midstream", "downstream"]) {
      const sk = TIER_KEYS[longKey];
      for (const c of t.tiers?.[longKey] || []) {
        const f = fin[c.ticker] || {};
        const mc = f.mc ?? null;
        // 成長挑戰:ROE<0 或 淨利率<0(真實虧損訊號)
        const challenge = (f.roe != null && f.roe < 0) || (f.nm != null && f.nm < 0);
        tiers[sk].push({
          t: c.ticker,
          n: c.name,
          s: c.sector,
          ss: c.sectorSlug || "",
          mc,
          subcat: c.subcat || "",
          eps: f.eps ?? null,
          pe: valPe[c.ticker] ?? f.pe ?? null,
          revYoy: f.revYoy ?? null,
          mom: momByTicker[c.ticker] || 0,
          link: linkLevel(c.name),
          status: challenge ? "challenge" : "",
        });
        if (!seen.has(c.ticker)) {
          seen.add(c.ticker);
          if (mc != null) aggMcap += mc;
        }
        if (mc != null && mc > leadMc) { leadMc = mc; leadT = c.ticker; }
      }
    }
    // 產業龍頭:題材內市值最大者(覆蓋 challenge)
    if (leadT) {
      for (const sk of ["u", "m", "d"]) {
        for (const co of tiers[sk]) if (co.t === leadT) co.status = "lead";
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
      desc: t.desc || "",
      category: t.category || "",
      cagr: t.cagr || "",
      marketSize: t.marketSize || "",
      indicators: t.indicators || [],
      narrative: readNarrative(t.slug),
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
