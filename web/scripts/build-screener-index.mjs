/**
 * 產生選股器索引:掃 data/financials_store(fallback public/data/financials)+ reports-index.json,
 * 每檔輸出一筆精簡列(估值 + 最新年度損益指標 + 營收 YoY)。前端 /screener 讀此檔做篩選/排序。
 * 短鍵以縮小體積(1737 列)。輸出 minified。
 */
import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(__dirname, "..");
const REPO_ROOT = path.join(WEB, "..");
const IDX = path.join(WEB, "public", "data", "reports-index.json");
const FIN_STORE_DIR = path.join(REPO_ROOT, "data", "financials_store");
const FIN_PUBLIC_DIR = path.join(WEB, "public", "data", "financials");
const OUT = path.join(WEB, "public", "data", "screener-index.json");
const VAL_IDX = path.join(WEB, "public", "data", "valuation-index.json");

function readFin(ticker) {
  const storePath = path.join(FIN_STORE_DIR, `${ticker}.json`);
  const publicPath = path.join(FIN_PUBLIC_DIR, `${ticker}.json`);
  const p = existsSync(storePath)
    ? storePath
    : existsSync(publicPath)
      ? publicPath
      : null;
  if (!p) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** 最新一個有限值(由新到舊) */
function latest(periods, series, key) {
  const arr = series?.[key];
  if (!periods?.length || !arr) return null;
  for (let i = periods.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v != null && Number.isFinite(v)) return { value: v, period: periods[i] };
  }
  return null;
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

function main() {
  if (!existsSync(IDX)) {
    console.warn("[screener] reports-index.json missing, skip");
    return;
  }
  const byTicker = (JSON.parse(readFileSync(IDX, "utf8")).byTicker) || {};

  // 官方 TWSE/TPEx 估值(valuation-index:pe/pb/殖利率/beta,涵蓋最廣 ~1733 檔)。
  // financials_store 的 yfinance 估值對台股中小型覆蓋差 → 以官方為優先、yfinance 為輔。
  let valIndex = {};
  if (existsSync(VAL_IDX)) {
    try {
      valIndex = JSON.parse(readFileSync(VAL_IDX, "utf8")).rows || {};
    } catch {
      /* ignore */
    }
  }

  const rows = [];

  for (const ticker of Object.keys(byTicker)) {
    const meta = byTicker[ticker];
    const data = readFin(ticker);
    if (!data) continue;
    const ann = data.annual;
    if (!ann?.periods || !ann.series) continue;
    const val = data.valuation || {};
    const vi = valIndex[ticker] || {}; // 官方估值(優先)
    const rev = latest(ann.periods, ann.series, "Revenue");
    const gm = latest(ann.periods, ann.series, "Gross Margin (%)");
    const om = latest(ann.periods, ann.series, "Operating Margin (%)");
    const nm = latest(ann.periods, ann.series, "Net Margin (%)");
    const eps = latest(ann.periods, ann.series, "EPS");

    // 營收 YoY(最新年度 vs 前一年度)
    let revYoy = null;
    const revArr = (ann.series["Revenue"] || []).filter(
      (v) => v != null && Number.isFinite(v),
    );
    if (revArr.length >= 2) {
      const cur = revArr[revArr.length - 1];
      const prev = revArr[revArr.length - 2];
      if (prev) revYoy = Math.round((cur / prev - 1) * 1000) / 10;
    }

    rows.push({
      t: ticker,
      n: meta.name,
      s: meta.sector,
      it: data.industryType || "general",
      mc: num(data.marketCap),
      pe: num(vi.pe) ?? num(val["P/E (TTM)"]),
      fpe: num(val["Forward P/E"]),
      ps: num(val["P/S (TTM)"]),
      pb: num(vi.pb) ?? num(val["P/B"]),
      ev: num(val["EV/EBITDA"]),
      roe: num(val["ROE"]),
      beta: num(vi.beta) ?? num(val["Beta"]),
      de: num(val["Debt/Equity"]),
      rev: rev ? rev.value : null,
      gm: gm ? gm.value : null,
      om: om ? om.value : null,
      nm: nm ? nm.value : null,
      eps: eps ? eps.value : null,
      revYoy,
      yr: rev?.period ? rev.period.slice(0, 4) : null,
    });
  }

  // 預設依市值由大到小
  rows.sort((a, b) => (b.mc ?? -1) - (a.mc ?? -1));

  const payload = JSON.stringify({
    generatedAt: new Date().toISOString(),
    count: rows.length,
    rows,
  });
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
  console.log("[screener] wrote", OUT, "| rows:", rows.length);
}

main();
