/**
 * TWSE 原始日K 抓取與解析(瀏覽器 / Node 共用)
 *
 * ⚠️ 一律抓【原始未還原】日K 餵給 runBacktest,絕不可用 /data/prices/*.json —— 後者為顯示用、
 *    已捨入到小數 4 位,實測 6.7% 的組合統計會不同(分支翻轉,非誤差累積)。
 *
 * 逐月回傳,5 年視窗 = 61 次請求 → 必須節流序列化。
 *
 * ── 兩個市場、兩條路徑(2026-08-05)──────────────────────────────────────
 *   上市 twse → 直連 TWSE STOCK_DAY(實測回 `Access-Control-Allow-Origin: *`,可直抓)
 *   上櫃 tpex → 走本站代理 `/api/tpex/bars/{code}/{ym}`
 *               (實測 TPEx `tradingStock` **無** ACAO 標頭,瀏覽器直抓被 CORS 擋)
 *
 * 🔴 TPEx 的格式差異【全部留在代理端】,本模組不重複實作。
 *    代理已處理:`stat:"ok"` 小寫、資料在 `tables[0].data`、日期輸入 `2026/07/01`、
 *    以及**成交量 張數 ×1000 換成股數**(契約:「量仟股 ×1000 對齊 TWSE 股」;
 *    實測 5347 民國115年7月 22 根,比值 22/22 恰為 1000.00)。
 *    → 代理回的 bars 已是本模組的最終形狀,這裡只讀 `json.bars`。
 *    若在兩邊各寫一份 parser,量綱遲早會漂掉,而量能條件錯 1000 倍時圖表看起來完全正常。
 */

const STOCK_DAY = "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY";
/** 上櫃代理(同源相對路徑,故瀏覽器與 Node 測試都可用;Node 測試一律注入 fetchImpl) */
const TPEX_PROXY = "/api/tpex/bars";

/** 市場別。未指定時視為上市(維持既有呼叫端行為不變)。 */
export const MARKET_TWSE = "twse";
export const MARKET_TPEX = "tpex";

/** 民國 `115/07/31` → `2026-07-31`;格式不符回 null */
export function rocToIso(s) {
  const m = String(s ?? "").trim().match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  const y = Number(m[1]) + 1911;
  return `${y}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

function num(s) {
  const v = parseFloat(String(s ?? "").replace(/,/g, ""));
  return Number.isFinite(v) ? v : null;
}

/**
 * 解析 STOCK_DAY 回應為 K 棒陣列。
 * 欄位順序:[日期, 成交股數, 成交金額, 開, 高, 低, 收, 漲跌, 筆數]
 * 收盤為 `--` / 空 / 0 的無成交日一律剔除。
 */
export function parseStockDay(json) {
  if (!json || json.stat !== "OK" || !Array.isArray(json.data)) return [];
  const out = [];
  for (const row of json.data) {
    const d = rocToIso(row?.[0]);
    if (!d) continue;
    const v = num(row?.[1]);
    const o = num(row?.[3]);
    const h = num(row?.[4]);
    const l = num(row?.[5]);
    const c = num(row?.[6]);
    if (o == null || h == null || l == null || c == null) continue;
    if (c === 0) continue; // 無成交日
    out.push({ d, o, h, l, c, v: v ?? 0 });
  }
  return out;
}

/** 以 asof 為錨,回推 months 個月,回傳 ["202107", ...] 由舊到新 */
export function monthKeys(asof, months) {
  const [y, m] = String(asof).split("-").map(Number);
  const keys = [];
  for (let i = months - 1; i >= 0; i--) {
    const dt = new Date(Date.UTC(y, m - 1 - i, 1));
    keys.push(`${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return keys;
}

export function monthUrl(code, ym, market = MARKET_TWSE, proxyBase = "") {
  if (market === MARKET_TPEX) {
    /**
     * `proxyBase` 預設空字串 = 同源相對路徑(瀏覽器用)。
     * Node 端(對帳腳本)沒有 origin、fetch 不吃相對路徑 → 須傳入如 http://localhost:4330。
     */
    return `${proxyBase}${TPEX_PROXY}/${encodeURIComponent(code)}/${encodeURIComponent(ym)}`;
  }
  return `${STOCK_DAY}?date=${ym}01&stockNo=${encodeURIComponent(code)}&response=json`;
}

/**
 * 解析本站上櫃代理的回應。代理已把 TPEx 的格式差異與量綱處理完,這裡只做形狀檢查。
 * 回 null = 失敗(與「該月無交易」的空陣列必須區分,見 fetchMonth 的說明)。
 */
export function parseProxyBars(json) {
  if (!json || json.stat !== "ok" || !Array.isArray(json.bars)) return null;
  const out = [];
  for (const b of json.bars) {
    if (!b || typeof b.d !== "string") continue;
    const o = num(b.o);
    const h = num(b.h);
    const l = num(b.l);
    const c = num(b.c);
    if (o == null || h == null || l == null || c == null) continue;
    if (c === 0) continue; // 無成交日(代理已剔除,此處為雙重保險)
    out.push({ d: b.d, o, h, l, c, v: num(b.v) ?? 0 });
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 抓單月。失敗回 null(與「該月無交易資料」的空陣列區分開)——
 * 兩者混用會讓抓取失敗被誤當成「這個月沒開市」而靜默算出短視窗的錯結果。
 */
export async function fetchMonth(
  code,
  ym,
  { signal, fetchImpl = fetch, market = MARKET_TWSE, proxyBase = "" } = {}
) {
  try {
    const r = await fetchImpl(monthUrl(code, ym, market, proxyBase), { signal });
    if (market === MARKET_TPEX) {
      /**
       * 代理的契約:200 + `stat:"ok"` = 成功(bars 可為空陣列 = 該月真的無交易);
       * 502 = 上游失敗 → 回 null 讓上層重試。
       * 🔴 【不可】把 502 當成「該月無交易」—— 少一個月 = 視窗不完整 = 數字錯但看起來正常。
       */
      if (!r.ok) return null;
      return parseProxyBars(await r.json());
    }
    if (!r.ok) return null;
    const j = await r.json();
    if (j?.stat && j.stat !== "OK") {
      // 官方對「查無資料」也回非 OK;無法從外部區分查無與異常 → 交由呼叫端依整體結果判斷
      return [];
    }
    return parseStockDay(j);
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    return null;
  }
}

/**
 * 抓取 asof 回推 months 個月的原始日K。
 *
 * @param {object} opts
 *   asof       "2026-07-31" 視窗錨定日(只保留 d <= asof 的列)
 *   months     預設 61
 *   gapMs      節流間隔,預設 350
 *   signal     AbortSignal
 *   onProgress ({done, total, ym}) => void
 *   getCached  async (ym) => bars[] | null   逐月快取讀(歷史月份不會再變)
 *   putCached  async (ym, bars) => void      逐月快取寫
 *   retries    單月失敗重試次數,預設 3(指數退避 2s/4s/8s)
 *
 * 為什麼要重試且退避拉長:實測連抓 61 個月時,官方端點會【間歇性】失敗 ——
 *   2327 的 202209、2317 的 202203 都在整批中失敗,但**失敗後立刻單獨 curl 同一網址回 200/stat OK**,
 *   代表不是硬性封鎖,而是持續連續請求下的偶發拒絕。1s/2s/4s 曾不足,改為 2s/4s/8s。
 *
 * ⚠️ 失敗的月份【絕不可跳過】—— 少一個月 = 視窗不完整 = 算出來的數字是錯的但看起來正常。
 *   因此這裡選擇拋錯中止。搭配逐月快取,使用者按「重試」時已抓到的月份不會重抓,
 *   只補缺的那幾個月(實測 2327 重跑時 61 個月中 14 個命中快取)。
 */
export async function fetchRawBars(code, opts = {}) {
  const {
    asof,
    months = 61,
    gapMs = 350,
    signal,
    onProgress,
    getCached,
    putCached,
    retries = 3,
    fetchImpl = fetch,
    alwaysUseCache = false,
    /** "twse"(直連官方)或 "tpex"(走本站代理);未指定 = 上市,維持既有呼叫端行為 */
    market = MARKET_TWSE,
    /** 上櫃代理的基底 URL;瀏覽器留空(同源),Node 對帳腳本須傳入 */
    proxyBase = "",
  } = opts;
  if (!asof) throw new Error("fetchRawBars: asof required");

  const yms = monthKeys(asof, months);
  // 當月可能還有新交易日 → 線上一律重抓。
  // alwaysUseCache 只給【離線對帳測試】用:讓當月也走夾具,測試才能完全不連網。
  const curYm = alwaysUseCache ? null : String(asof).slice(0, 7).replace("-", "");
  const all = [];
  let networkCalls = 0;
  let retried = 0;
  let cacheHits = 0;

  for (let i = 0; i < yms.length; i++) {
    const ym = yms[i];
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");

    let bars = null;
    if (getCached && ym !== curYm) {
      bars = await getCached(ym);
      if (bars) cacheHits++;
    }

    if (!bars) {
      let attempt = 0;
      for (;;) {
        bars = await fetchMonth(code, ym, { signal, fetchImpl, market, proxyBase });
        networkCalls++;
        if (bars !== null) break;
        if (attempt >= retries) throw new Error(`fetch_failed:${ym}`);
        await sleep(2000 * 2 ** attempt); // 2s / 4s / 8s
        attempt++;
        retried++;
      }
      if (putCached && ym !== curYm) await putCached(ym, bars);
      if (i < yms.length - 1) await sleep(gapMs);
    }

    all.push(...bars);
    onProgress?.({ done: i + 1, total: yms.length, ym });
  }

  // 只保留 <= asof,去重(月界重疊保險),由舊到新
  const seen = new Set();
  const bars = all
    .filter((b) => b.d <= asof)
    .filter((b) => (seen.has(b.d) ? false : (seen.add(b.d), true)))
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));

  return { bars, stats: { networkCalls, cacheHits, retried, months: yms.length } };
}
