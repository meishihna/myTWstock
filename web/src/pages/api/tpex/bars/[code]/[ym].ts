/**
 * GET /api/tpex/bars/{code}/{ym} —— 上櫃日K 代理(單月)
 *
 * 為什麼需要代理:TPEx 的 `tradingStock` **沒有 `Access-Control-Allow-Origin`**
 * (實測只有 `Vary: Origin` / `Vary: Access-Control-Request-*`),瀏覽器直抓會被 CORS 擋;
 * 對照 TWSE `STOCK_DAY` 回 `Access-Control-Allow-Origin: *`,所以上市可以直抓、上櫃不行。
 *
 * 為什麼代理不踩「不重散布第三方資料」紅線:TPEx 是【政府機關】(證券櫃檯買賣中心)的
 * 開放資料,依政府資料開放授權條款允許重製、散布、公開傳輸,**須標示來源**(見 X-Data-Source)。
 * 這與 FinMind(私有服務、條款不明、需個人 token)性質不同。
 *
 * 路徑而非 query string 是刻意的:**路徑直接進 CDN 快取鍵**,不必擔心 query 順序或
 * 多餘參數造成快取分裂。
 *
 * ── 上游實測細節(2026-08-04),兩個一定要處理 ──────────────────────────────
 * 🔴 TPEx 回 `Set-Cookie: JSESSIONID=…; SameSite=None; Secure; HttpOnly`
 *    → **絕不可轉發給瀏覽器**(會把上游 session 洩漏給每個訪客,且讓回應變成不可共享快取)
 * 🔴 TPEx 回 `Cache-Control: max-age=600, private, must-revalidate`
 *    → `private` 表示共享快取不該存。**我們自己組給瀏覽器的 Cache-Control,不轉發上游的**
 *
 * ── 與 TWSE 的四處差異(parser 不可共用)──────────────────────────────────
 *   stat 值      "ok"(小寫)          vs TWSE "OK"
 *   資料位置     json.tables[0].data   vs TWSE json.data
 *   成交量單位   成交【張】數          vs TWSE 成交【股】數
 *   日期輸入     2026/07/01            vs TWSE 20260701
 *
 * 🔴 成交量必須 ×1000 換成股數。引擎端的上櫃日K 管線明載「量仟股 ×1000 對齊 TWSE 股」,
 *    已實測驗證(5347 民國115年7月 22 根,TPEx 張數 vs prices/5347.json 的 v,
 *    比值 22/22 全部恰為 1000.00)。若不換算,量能相關的進出場條件會全部錯 1000 倍,
 *    而圖表看起來完全正常 —— 靜默錯誤。
 */
import type { APIRoute } from "astro";

export const prerender = false;

const UPSTREAM = "https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock";
/** JSON body 用的來源標示(可含中文) */
const SOURCE = "證券櫃檯買賣中心 (TPEx) tradingStock";
/**
 * HTTP 標頭用的來源標示。
 * 🔴 標頭值必須是 ByteString(Latin-1)—— 放中文會讓 `new Response()` 直接拋
 * 「Cannot convert argument to a ByteString」,整支路由每次都 500。
 * (本機實測踩到:X-Data-Source 放「證券櫃檯買賣中心」→ 500 Internal Server Error。)
 */
const SOURCE_ASCII = "TPEx tradingStock; www.tpex.org.tw; Open Government Data License";
/** 上游偶發失敗的重試(與 twsebars.mjs 同一套鐵律:失敗的月份絕不可跳過) */
const RETRIES = 3;
const BACKOFF_MS = [700, 1500, 3000];
const UPSTREAM_TIMEOUT_MS = 12_000;
/** TPEx 個股日成交資訊的最早可查月份(比這更早一律 400,避免被拿去爆打上游) */
const MIN_YM = 201501;

type Bar = { d: string; o: number; h: number; l: number; c: number; v: number };
type Ok = { stat: "ok"; code: string; ym: string; unit: "shares"; source: string; bars: Bar[] };
type Err = { stat: "error"; code: string; ym: string; reason: string };

function json(body: Ok | Err, status: number, cache: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cache,
      // 政府資料開放授權條款要求標示來源(標頭只能 ASCII,中文版在 body 的 source 欄)
      "X-Data-Source": SOURCE_ASCII,
    },
  });
}

/** 台北時區(UTC+8)的當月 YYYYMM。用 UTC 判斷會在月初差一天。 */
function currentYmTaipei(): number {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return t.getUTCFullYear() * 100 + (t.getUTCMonth() + 1);
}

/** "115/07/01" → "2026-07-01";格式不符回 null */
function rocToIso(s: unknown): string | null {
  const m = /^(\d{2,3})\/(\d{2})\/(\d{2})$/.exec(String(s ?? "").trim());
  if (!m) return null;
  const y = Number(m[1]) + 1911;
  return `${y}-${m[2]}-${m[3]}`;
}

function num(s: unknown): number | null {
  const v = Number(String(s ?? "").replace(/,/g, "").trim());
  return Number.isFinite(v) ? v : null;
}

/**
 * 解析 tradingStock 回應。
 * 欄序:[日期, 成交張數, 成交仟元, 開, 高, 低, 收, 漲跌, 筆數]
 * 收盤為 `--` / 空 / 0 的無成交日一律剔除(與 TWSE parser 同規則)。
 * 成交量 ×1000(張 → 股)。
 */
function parseTradingStock(j: unknown): Bar[] | null {
  const o = j as {
    stat?: string;
    tables?: { data?: unknown[][] }[];
  };
  if (!o || typeof o.stat !== "string" || o.stat.toLowerCase() !== "ok") return null;
  const rows = o.tables?.[0]?.data;
  if (!Array.isArray(rows)) return null;
  const out: Bar[] = [];
  for (const row of rows) {
    const d = rocToIso(row?.[0]);
    if (!d) continue;
    const lots = num(row?.[1]);
    const op = num(row?.[3]);
    const hi = num(row?.[4]);
    const lo = num(row?.[5]);
    const cl = num(row?.[6]);
    if (op == null || hi == null || lo == null || cl == null) continue;
    if (cl === 0) continue; // 無成交日
    out.push({ d, o: op, h: hi, l: lo, c: cl, v: (lots ?? 0) * 1000 });
  }
  return out;
}

async function fetchUpstreamOnce(code: string, ym: string): Promise<Bar[] | null> {
  const date = `${ym.slice(0, 4)}/${ym.slice(4, 6)}/01`;
  const url = `${UPSTREAM}?code=${encodeURIComponent(code)}&date=${encodeURIComponent(date)}&id=&response=json`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: {
        // 標明是誰在抓,附本站位址 —— 官方要擋或聯絡我們時有跡可循,不做 UA 偽裝輪替
        "User-Agent": "Mozilla/5.0 (compatible; TWstock/1.0; +https://github.com/meishihna/twstock-web)",
        Accept: "application/json",
        Referer: "https://www.tpex.org.tw/",
      },
    });
    if (!r.ok) return null;
    return parseTradingStock(await r.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 併發去重:同一函式實例內,同一個 (code, ym) 只發一次上游請求。
 *
 * 🔴 極限要說清楚:Vercel serverless 是**多實例**的,這個 Map 只在單一實例內有效。
 * 真正的跨實例互斥需要外部鎖(KV/Redis),與「月費 $0」的裁決衝突,故不引入。
 * 冷啟動最壞情況 = 同時有 N 個實例各打一次上游;靠 CDN 快取(歷史月 immutable)
 * 讓這件事只會發生一次,之後全部命中邊快取。此極限為監督者明示可接受。
 */
const inflight = new Map<string, Promise<Bar[] | null>>();

async function getBars(code: string, ym: string): Promise<Bar[] | null> {
  const key = `${code}|${ym}`;
  const hit = inflight.get(key);
  if (hit) return hit;
  const p = (async () => {
    for (let i = 0; i <= RETRIES; i++) {
      const bars = await fetchUpstreamOnce(code, ym);
      if (bars) return bars;
      if (i < RETRIES) await new Promise((r) => setTimeout(r, BACKOFF_MS[i] ?? 3000));
    }
    return null;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export const GET: APIRoute = async ({ params }) => {
  const code = String(params.code ?? "");
  const ym = String(params.ym ?? "");

  // 白名單:只接受 4 碼代號與 YYYYMM,且月份在合理範圍內。
  // 沒有這道,這支路由就是一個可以拿去打任何東西的開放轉發器。
  if (!/^\d{4}$/.test(code)) {
    return json({ stat: "error", code, ym, reason: "bad_code" }, 400, "no-store");
  }
  if (!/^\d{6}$/.test(ym)) {
    return json({ stat: "error", code, ym, reason: "bad_ym" }, 400, "no-store");
  }
  const ymNum = Number(ym);
  const mm = ymNum % 100;
  const cur = currentYmTaipei();
  if (mm < 1 || mm > 12 || ymNum < MIN_YM || ymNum > cur) {
    return json({ stat: "error", code, ym, reason: "ym_out_of_range" }, 400, "no-store");
  }

  const bars = await getBars(code, ym);

  /**
   * 上游失敗 → 大聲回 502,且 no-store。
   * 🔴 絕不可把失敗當成「該月無交易」回 200 空陣列 —— 少一個月 = 視窗不完整 =
   *    數字錯但看起來正常(twsebars.mjs 檔內同一條鐵律)。
   */
  if (bars == null) {
    return json({ stat: "error", code, ym, reason: "upstream_failed" }, 502, "no-store");
  }

  /**
   * 歷史月收盤後不再變 → 可長期共享快取;當月會被更正資料回填 → 短 TTL。
   * max-age=0 讓瀏覽器每次都問一下,實際由 CDN(s-maxage)回應 —— 這樣資料若真需要
   * 更正,清一次邊快取即可全站生效,不必等每個使用者的瀏覽器快取過期。
   */
  const SHORT = "public, max-age=0, s-maxage=600, stale-while-revalidate=3600";
  const LONG = "public, max-age=0, s-maxage=31536000, immutable, stale-while-revalidate=86400";
  /**
   * 🔴 空結果【不吃長快取】,即使是歷史月。
   * 上游 `stat:"ok"` 但 0 列有兩種可能:①該月真的無資料(個股尚未上櫃)②上游短暫異常。
   * 從外部無法區分。若給一年的 immutable,情況②會把一個錯誤鎖住一年;
   * 給短 TTL 則 10 分鐘後自我修復,而情況①重抓的成本極低(真空月本來就很少)。
   * (本機測 9999/202607 時發現:未知代號回 200 空陣列卻拿到 immutable 一年。)
   */
  const isHistory = ymNum < cur;
  const cache = isHistory && bars.length > 0 ? LONG : SHORT;

  // 「該月真的無資料」(個股當時尚未上櫃)→ 200 + 空陣列,與失敗明確區分。
  return json({ stat: "ok", code, ym, unit: "shares", source: SOURCE, bars }, 200, cache);
};
