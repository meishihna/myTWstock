import type { APIRoute } from "astro";
import { getCorpEvents } from "../../../lib/priceCache";

export const prerender = false;

/**
 * 個股除權息 / 分割事件(近 2 年,與 `/api/bars` 共用同一次 Yahoo 呼叫與快取)。
 *
 *   GET /api/corp-events/2330 -> { ticker, events: [{ date, kind, detail }] }
 *
 * 🔴 用途是【偵測並具名】,不是修正:淨值曲線在配股日前後不可比,
 *    因為股數變動沒有任何紀錄(`trades` 只有買賣)。我們畫出來並標記,不平滑。
 *
 * 🔴 快取**只在記憶體**(`priceCache` 的 5 分鐘 in-process 快取),
 *    不落地到檔案 / DB / KV。理由見 web/docs/portfolio-series-design.md 的紅線一節:
 *    把兩年日線持久化就從「代理」跨進「重散布」。
 */
export const GET: APIRoute = async ({ params }) => {
  const ticker = params.ticker ?? "";
  if (!/^\d{4}$/.test(ticker)) {
    return new Response(JSON.stringify({ error: "invalid_ticker" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const events = await getCorpEvents(ticker);
  return new Response(JSON.stringify({ ticker, events }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
};
