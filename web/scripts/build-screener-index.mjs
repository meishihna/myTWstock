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

/**
 * 舊版 financials_store(yfinance)形狀:{ annual: { periods[], series{} }, valuation{} }。
 * ⚠️ FIN_PUBLIC_DIR 現在放的是【官方 MOPS 新格式】(fields/quarters/annual.v),形狀不同。
 *    若讓它從那裡 fallback,下游讀 ann.series 會是 undefined 而被整檔略過 → 個股靜默消失。
 *    因此這裡只接受【store 形狀】,官方資料走 readOfficialMetrics()。
 */
function readFin(ticker) {
  const storePath = path.join(FIN_STORE_DIR, `${ticker}.json`);
  if (!existsSync(storePath)) return null;
  try {
    const j = JSON.parse(readFileSync(storePath, "utf8"));
    return j?.annual?.series ? j : null;
  } catch {
    return null;
  }
}

/**
 * 官方 MOPS 財務(public/data/financials/{ticker}.json)→ 年度指標 + TTM ROE。
 * 契約:docs/financials-contract.md
 *  - 金額為百萬台幣,eps 為元/股
 *  - gm 一律用 gp(營業毛利淨額)直接算,【不可用「營收 − 營業成本」自推】——
 *    227 個(檔×季)/57 檔因農企業生物資產、關係人未實現銷貨損益而合法不等
 *  - sec / other 業別的 cogs/gp 為 null(其「支出」是成本+費用合計,映射會變成假毛利)
 *  - 🔴 bs 是【時點數】,絕對不可去累計;與 quarters 共用期別軸(sameAxisAs)
 */
function readOfficialMetrics(ticker) {
  const p = path.join(FIN_PUBLIC_DIR, `${ticker}.json`);
  if (!existsSync(p)) return null;
  let j;
  try {
    j = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(j?.fields) || !j?.annual?.p?.length || !Array.isArray(j?.annual?.v)) return null;
  const F = Object.fromEntries(j.fields.map((f, i) => [f, i]));

  // 最新一個「營收有限值」的年度
  const ap = j.annual.p;
  const av = j.annual.v;
  let ai = -1;
  for (let i = ap.length - 1; i >= 0; i--) {
    const r = av[i]?.[F.rev];
    if (r != null && Number.isFinite(r)) {
      ai = i;
      break;
    }
  }
  if (ai < 0) return null;
  const row = av[ai];
  const g = (k) => {
    const i = F[k];
    if (i == null) return null;
    const v = row?.[i];
    return v != null && Number.isFinite(v) ? v : null;
  };
  const rev = g("rev");
  const marginOf = (n) => (n != null && rev != null && rev > 0 ? Math.round((n / rev) * 1000) / 10 : null);

  // ROE(TTM)= 近 4 個【單季】ni 加總 ÷ 【平均】teParent;平均 =(期初+期末)/2 以免增資扭曲。
  // 分子分母皆為【歸屬母公司】口徑(ni 本就定義為歸屬母公司,對應 teParent)。
  let roeTtm = null;
  const qv = j.quarters?.v;
  const bsv = j.bs?.v;
  const BF = Array.isArray(j.bsFields) ? Object.fromEntries(j.bsFields.map((f, i) => [f, i])) : null;
  if (Array.isArray(qv) && qv.length >= 4 && Array.isArray(bsv) && bsv.length === qv.length && BF?.teParent != null) {
    const n = qv.length;
    let sum = 0;
    let ok = true;
    for (let i = n - 4; i < n; i++) {
      const v = qv[i]?.[F.ni];
      if (v == null || !Number.isFinite(v)) {
        ok = false;
        break;
      }
      sum += v;
    }
    // 期初 = 4 季之前那一季的期末權益;bs 是時點數,直接取兩個時點,【不做相減】
    const end = bsv[n - 1]?.[BF.teParent];
    const beg = n >= 5 ? bsv[n - 5]?.[BF.teParent] : null;
    if (ok && end != null && Number.isFinite(end)) {
      const avg = beg != null && Number.isFinite(beg) ? (beg + end) / 2 : end;
      if (avg > 0) roeTtm = Math.round((sum / avg) * 1000) / 10;
    }
  }

  return {
    market: j.market ?? null, // 官方檔自帶 sii(上市)/ otc(上櫃),比外部查 suffix 可靠
    industryType: j.industryType ?? null,
    year: ap[ai],
    rev,
    eps: g("eps"),
    gm: marginOf(g("gp")),
    om: marginOf(g("op")),
    nm: marginOf(g("ni")),
    roeTtm,
    revSeries: av.map((r) => r?.[F.rev] ?? null),
  };
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
    const off = readOfficialMetrics(ticker);
    // 官方檔存在即可入表;舊 store 不存在時 ann/val 退化為空物件(欄位各自 fallback,不整檔略過)
    if (!data && !off) continue;
    const ann = data?.annual ?? {};
    const val = data?.valuation || {};
    const vi = valIndex[ticker] || {}; // 官方估值(優先)
    /* 年度損益指標:【官方 MOPS 優先】,缺則回退舊 store(不得因換來源讓任何檔變空白) */
    const rev = off?.rev != null
      ? { value: off.rev, period: off.year }
      : latest(ann.periods, ann.series, "Revenue");
    const gm = off?.gm != null
      ? { value: off.gm, period: off.year }
      : latest(ann.periods, ann.series, "Gross Margin (%)");
    const om = off?.om != null
      ? { value: off.om, period: off.year }
      : latest(ann.periods, ann.series, "Operating Margin (%)");
    const nm = off?.nm != null
      ? { value: off.nm, period: off.year }
      : latest(ann.periods, ann.series, "Net Margin (%)");
    const eps = off?.eps != null
      ? { value: off.eps, period: off.year }
      : latest(ann.periods, ann.series, "EPS");

    // 營收 YoY(最新年度 vs 前一年度)
    let revYoy = null;
    /* 官方年度序列優先;但部分個股官方只有 1 個年度(如 3717、6015、6021),
       不足以算 YoY → 回退舊 store 的多年序列,否則 revYoy 會由有值變空白(功能減少)。 */
    const fin = (arr) => (arr ?? []).filter((v) => v != null && Number.isFinite(v));
    const revOff = fin(off?.revSeries);
    const revArr = revOff.length >= 2 ? revOff : fin(ann.series?.["Revenue"]);
    if (revArr.length >= 2) {
      const cur = revArr[revArr.length - 1];
      const prev = revArr[revArr.length - 2];
      if (prev) revYoy = Math.round((cur / prev - 1) * 1000) / 10;
      // 近零基期年(某年營收趨近 0)會讓年 YoY 爆成數千%(失真)→ 超過 ±500% 視為不可靠,設 null。
      // 此為所有 revYoy 的唯一源頭;industries/map-index 皆讀此值,故一處修正即全站生效。
      if (revYoy != null && Math.abs(revYoy) > 500) revYoy = null;
    }

    // 月營收訊號(供自選股「營收異動」):最新月 YoY、月增 MoM、加速度(本月 YoY − 近6月均 YoY)
    let mrY = null;
    let mrP = null;
    let mrMoM = null;
    let mrAcc = null;
    /* data 可能為 null(僅存在官方檔的個股)→ 必須 optional chaining,否則整支 build 崩 */
    const mr = data?.monthlyRevenue;
    if (mr?.periods?.length && Array.isArray(mr.yoy)) {
      const P = mr.periods;
      const Y = mr.yoy;
      const R = Array.isArray(mr.revenue) ? mr.revenue : [];
      // 營收 YoY 數學下限 -100%;< -100 或 > 500 多為金融/保險負基期或近零基期失真 → 濾除
      const okYoy = (v) =>
        typeof v === "number" && Number.isFinite(v) && v >= -100 && v <= 500;
      let li = -1;
      for (let i = P.length - 1; i >= 0; i--) {
        if (Y[i] != null && Number.isFinite(Y[i])) {
          li = i;
          break;
        }
      }
      if (li >= 0) {
        mrP = P[li];
        mrY = okYoy(Y[li]) ? Math.round(Y[li] * 10) / 10 : null;
        // 月增 MoM%(本月營收 vs 上月)
        if (
          li >= 1 &&
          Number.isFinite(R[li]) &&
          Number.isFinite(R[li - 1]) &&
          R[li - 1] > 0
        ) {
          const m = (R[li] / R[li - 1] - 1) * 100;
          if (Math.abs(m) <= 500) mrMoM = Math.round(m * 10) / 10;
        }
        // 加速度(pp):本月 YoY − 近 6 月(不含本月)YoY 均值 → 抓「突然轉折」
        if (mrY != null) {
          const win = [];
          for (let i = li - 1; i >= 0 && win.length < 6; i--) {
            if (okYoy(Y[i])) win.push(Y[i]);
          }
          if (win.length >= 3) {
            const avg = win.reduce((a, b) => a + b, 0) / win.length;
            mrAcc = Math.round((mrY - avg) * 10) / 10;
          }
        }
      }
    }

    const peV = num(vi.pe) ?? num(val["P/E (TTM)"]);
    const pbV = num(vi.pb) ?? num(val["P/B"]);
    const revV = rev ? rev.value : null;
    const nmV = nm ? nm.value : null;
    // 市值:優先真實(financials_store);缺則以 本益比 × 淨利(=營收×淨利率)近似,標記 me:1(估算)。
    // pe=股價/EPS=市值/淨利 → 市值≈pe×淨利。僅在有正本益比與正淨利時推算(虧損無 pe)。
    let mc = num(data?.marketCap);
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
      it: data?.industryType || off?.industryType || "general",
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
      /* ROE 優先序:① 官方 TTM(近4單季 ni ÷ 平均 teParent,歸屬母公司口徑)
         ② 舊 store 的 yfinance ROE  ③ 恆等式 pb÷pe(ROE=EPS/每股淨值)
         後兩層【刻意保留】—— 只換來源不保留 fallback 會讓部分個股 roe 變空白 */
      roe:
        off?.roeTtm ??
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
      mrMoM, // 月增 MoM%
      mrAcc, // 加速度(pp):本月 YoY − 近6月均 YoY
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
