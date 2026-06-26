/**
 * 今日漲幅排行(強勢/弱勢股):用 yahoo 批次抓全市場個股當日漲跌,輸出 top N。
 * 宇宙:screener-index.json(有財報的 ~1700 檔)。
 * 後綴:financials_store 的 yahooSuffix 一律 .TW 不可靠,故兩段式 —— 先 .TW、抓不到的再 .TWO。
 * 輸出 web/public/data/top-movers.json(提交入庫;每日快照,首頁讀取)。
 *
 *   cd web && node scripts/build-top-movers.mjs
 *
 * 週/月排行待後續(需歷史價或每日累積)。
 */
import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YahooFinance from "yahoo-finance2";

// yahoo-finance2 v3:需實例化(預設匯出為 class)
const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(__dirname, "..");
const DATA = path.join(WEB, "public", "data");
const OUT = path.join(DATA, "top-movers.json");

const CHUNK = 40;
const TOP = 15;

let _loggedErr = false;
async function quoteChunk(symbols) {
  try {
    const q = await yahooFinance.quote(symbols);
    return Array.isArray(q) ? q : q ? [q] : [];
  } catch (e) {
    if (!_loggedErr) {
      console.error("\n  chunk error (退回逐檔):", e?.message);
      _loggedErr = true;
    }
    const out = [];
    for (const s of symbols) {
      try {
        const one = await yahooFinance.quote(s);
        if (one) out.push(one);
      } catch {
        /* skip bad symbol */
      }
    }
    return out;
  }
}

/** items: [{t,n}] → Map(t -> {t,n,price,pct});只收有效報價 */
async function quoteAll(items, suffix) {
  const bySym = new Map(items.map((u) => [u.t + suffix, u]));
  const syms = [...bySym.keys()];
  const got = new Map();
  for (let i = 0; i < syms.length; i += CHUNK) {
    const arr = await quoteChunk(syms.slice(i, i + CHUNK));
    for (const r of arr) {
      const u = bySym.get(r.symbol);
      if (!u) continue;
      const price = r.regularMarketPrice;
      const prev = r.regularMarketPreviousClose;
      if (typeof price !== "number" || typeof prev !== "number" || !(prev > 0)) continue;
      got.set(u.t, { t: u.t, n: u.n, price, pct: Math.round(((price - prev) / prev) * 10000) / 100 });
    }
    process.stderr.write(`\r  ${suffix} ${Math.min(i + CHUNK, syms.length)}/${syms.length}`);
  }
  process.stderr.write("\n");
  return got;
}

async function main() {
  const scr = JSON.parse(readFileSync(path.join(DATA, "screener-index.json"), "utf8"));
  const rows = (scr.rows || []).filter((r) => /^\d{4}$/.test(r.t)).map((r) => ({ t: r.t, n: r.n }));
  console.log(`universe: ${rows.length} tickers`);

  const tw = await quoteAll(rows, ".TW");
  const missing = rows.filter((r) => !tw.has(r.t));
  console.log(`  .TW 命中 ${tw.size};以 .TWO 重試 ${missing.length} 檔`);
  const two = await quoteAll(missing, ".TWO");

  const merged = new Map([...tw, ...two]);
  const results = [...merged.values()];
  results.sort((a, b) => b.pct - a.pct);
  const gainers = results.slice(0, TOP);
  const losers = results.slice(-TOP).reverse();

  const payload = {
    generatedAt: new Date().toISOString(),
    count: results.length,
    gainers,
    losers,
  };
  const tmp = `${OUT}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload), "utf8");
  if (existsSync(OUT)) unlinkSync(OUT);
  renameSync(tmp, OUT);
  console.log(`wrote ${OUT} | 有效報價 ${results.length}`);
  console.log("  漲幅 top3:", gainers.slice(0, 3).map((g) => `${g.n} +${g.pct}%`).join(", "));
  console.log("  跌幅 top3:", losers.slice(0, 3).map((g) => `${g.n} ${g.pct}%`).join(", "));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
