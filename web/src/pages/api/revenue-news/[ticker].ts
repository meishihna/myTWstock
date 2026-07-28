import type { APIRoute } from "astro";

export const prerender = false;

/**
 * 個股「相關新聞」即時端點:使用者打開報告頁「相關新聞」頁籤時由前端呼叫,
 * 伺服器端向 FinMind TaiwanStockNews 即時抓取近數日新聞、過濾雜訊、依實質關鍵字排序後回傳。
 *   GET /api/revenue-news/2330
 *   -> { ticker, asOf, heads: [{ d, t, s, u }] }
 *
 * - FinMind 新聞為「單日語意」(start_date 只回當天),故並行抓近 DAYS 日再合併。
 * - 匿名即可(免 token);若 Vercel 有設 FINMIND_TOKEN 環境變數則自動帶上(配額更高)。
 * - 邊快取 s-maxage=3h + stale-while-revalidate,個股新聞不需秒級即時,亦大幅降低 FinMind 呼叫量。
 * - 外部新聞內容不可信 → 僅回傳純文字欄位,前端以 textContent 呈現(不 innerHTML)。
 */

const FINMIND_V4 = "https://api.finmindtrade.com/api/v4/data";
const DAYS = 5;
const MAX_HEADLINES = 8;

const SRC_BLACKLIST = ["CMoney", "facebook", "Facebook", "玩股網", "PTT", "Dcard"];
const TITLE_BLACKLIST = [
  "股市爆料同學會", "期貨服務", "盤前規劃", "盤後", "當沖", "籌碼K線", "技術分析",
  "股東會", "股東常會", "股東人數", "除息", "除權", "配息", "現金股利", "減資", "增資",
  "庫藏股", "買回", "董事會決議", "停牌", "變更交易", "選擇權", "權證",
  "能不能接", "還能買", "該不該", "跌破", "漲破", "回跌", "軋空", "作帳",
];
// 實質營收/營運關鍵字:排序時優先浮上(壓過純股價/籌碼閒聊)
const STRONG = [
  "訂單", "接單", "轉單", "出貨", "拉貨", "擴產", "產能", "漲價", "報價", "調漲",
  "毛利", "營收", "業績", "財報", "財測", "EPS", "純益", "稅後", "需求", "缺貨",
  "得標", "標案", "認證", "打入", "量產", "併購", "旺季", "暢旺", "強勁", "暴增",
  "激增", "年增", "月增", "衰退", "銳減", "轉盈", "轉虧", "去化", "報喜", "法說",
  "展望", "新客戶", "供應鏈", "接獲", "簽約", "合約", "投產", "新廠",
];

function cleanTitle(t: string): string {
  let s = (t || "").trim();
  s = s.replace(/\s*[-–—]\s*[^-–—]{1,20}$/, "").trim(); // 去尾綴「 - 來源」
  s = s.replace(/^\d{4,6}\s+\S+\s*[-–—]\s*/, "").trim(); // 去開頭「2330 台積電 - 」
  return s;
}

function strongScore(t: string): number {
  let n = 0;
  for (const k of STRONG) if (t.includes(k)) n++;
  return n;
}

async function fetchDay(
  ticker: string,
  day: string,
  token: string | undefined,
  signal: AbortSignal,
): Promise<any[]> {
  const url =
    `${FINMIND_V4}?dataset=TaiwanStockNews&data_id=${encodeURIComponent(ticker)}` +
    `&start_date=${day}`;
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = "Bearer " + token;
  try {
    const r = await fetch(url, { headers, signal });
    if (!r.ok) return [];
    const j = await r.json();
    return j && j.status === 200 && Array.isArray(j.data) ? j.data : [];
  } catch {
    return [];
  }
}

function jsonResponse(body: unknown, status: number, cache: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cache,
    },
  });
}

export const GET: APIRoute = async ({ params }) => {
  const ticker = params.ticker ?? "";
  if (!/^\d{4,6}$/.test(ticker)) {
    return jsonResponse({ error: "invalid_ticker" }, 400, "no-store");
  }

  const token =
    (typeof process !== "undefined" ? process.env?.FINMIND_TOKEN : undefined)?.trim() ||
    undefined;

  const today = new Date();
  const days: string[] = [];
  for (let i = 0; i < DAYS; i++) {
    days.push(new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let rows: any[] = [];
  try {
    const batches = await Promise.all(
      days.map((d) => fetchDay(ticker, d, token, controller.signal)),
    );
    rows = batches.flat();
  } finally {
    clearTimeout(timer);
  }

  const seen = new Set<string>();
  const cand: { d: string; t: string; s: string; u: string | null; _st: number }[] = [];
  for (const r of rows) {
    const rawTitle = String(r?.title ?? "");
    const src = String(r?.source ?? "");
    if (SRC_BLACKLIST.some((b) => src.includes(b))) continue;
    if (TITLE_BLACKLIST.some((b) => rawTitle.includes(b))) continue;
    const t = cleanTitle(rawTitle);
    const key = t.replace(/\s+/g, "").slice(0, 24);
    if (!t || seen.has(key)) continue;
    seen.add(key);
    cand.push({
      d: String(r?.date ?? "").slice(0, 10),
      t,
      s: src,
      u: typeof r?.link === "string" && r.link ? r.link : null,
      _st: strongScore(t),
    });
  }
  // 實質關鍵字多者優先,再依日期新→舊
  cand.sort((a, b) => b._st - a._st || (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));
  const heads = cand.slice(0, MAX_HEADLINES).map(({ _st, ...h }) => h);

  return jsonResponse(
    { ticker, asOf: today.toISOString().slice(0, 10), heads },
    200,
    heads.length
      ? "public, max-age=600, s-maxage=10800, stale-while-revalidate=86400"
      : "public, max-age=300, s-maxage=1800",
  );
};
