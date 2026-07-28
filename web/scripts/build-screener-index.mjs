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
      // 近零基期年(某年營收趨近 0)會讓年 YoY 爆成數千%(失真)→ 超過 ±500% 視為不可靠,設 null。
      // 此為所有 revYoy 的唯一源頭;industries/map-index 皆讀此值,故一處修正即全站生效。
      if (revYoy != null && Math.abs(revYoy) > 500) revYoy = null;
    }

    // 最新月營收 YoY(供自選股「營收異動」提示;>±500% 視為失真設 null)
    let mrY = null;
    let mrP = null;
    const mr = data.monthlyRevenue;
    if (mr?.periods?.length && Array.isArray(mr.yoy)) {
      for (let i = mr.periods.length - 1; i >= 0; i--) {
        const v = mr.yoy[i];
        if (v != null && Number.isFinite(v)) {
          // 營收 YoY 數學下限 -100%(歸零);< -100 或 > 500 多為金融/保險負基期或近零基期失真 → null
          mrY = v < -100 || v > 500 ? null : Math.round(v * 10) / 10;
          mrP = mr.periods[i];
          break;
        }
      }
    }

    const peV = num(vi.pe) ?? num(val["P/E (TTM)"]);
    const pbV = num(vi.pb) ?? num(val["P/B"]);
    const revV = rev ? rev.value : null;
    const nmV = nm ? nm.value : null;
    // 市值:優先真實(financials_store);缺則以 本益比 × 淨利(=營收×淨利率)近似,標記 me:1(估算)。
    // pe=股價/EPS=市值/淨利 → 市值≈pe×淨利。僅在有正本益比與正淨利時推算(虧損無 pe)。
    let mc = num(data.marketCap);
    let mcEst;
    // 極端本益比(如近零盈餘造成 pe 破千)時,官方 pe 與年度淨利基準不一致,估算會嚴重失真 → 只在 pe≤100 時估。
    if (mc == null && peV != null && peV > 0 && peV <= 100 && revV != null && nmV != null && nmV > 0) {
      mc = Math.round((peV * revV * nmV) / 100);
      mcEst = 1;
    }

    rows.push({
      t: ticker,
      n: meta.name,
      s: meta.sector,
      it: data.industryType || "general",
      mc,
      me: mcEst,
      pe: peV,
      fpe: num(val["Forward P/E"]),
      // P/S 缺則以 市值/營收 補(市值為估算時 P/S 亦為估算)
      ps:
        num(val["P/S (TTM)"]) ??
        (mc != null && revV != null && revV > 0
          ? Math.round((mc / revV) * 100) / 100
          : null),
      pb: pbV,
      ev: num(val["EV/EBITDA"]),
      // ROE 缺則以 P/B÷P/E 補(恆等式:ROE=EPS/每股淨值=pb/pe;需正 pe、pb)
      roe:
        num(val["ROE"]) ??
        (peV != null && peV > 0 && pbV != null && pbV > 0
          ? Math.round((pbV / peV) * 1000) / 10
          : null),
      beta: num(vi.beta) ?? num(val["Beta"]),
      de: num(val["Debt/Equity"]),
      rev: rev ? rev.value : null,
      gm: gm ? gm.value : null,
      om: om ? om.value : null,
      nm: nm ? nm.value : null,
      eps: eps ? eps.value : null,
      revYoy,
      yr: rev?.period ? rev.period.slice(0, 4) : null,
      mrY, // 最新月營收 YoY%
      mrP, // 最新月營收月份 YYYY-MM
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
