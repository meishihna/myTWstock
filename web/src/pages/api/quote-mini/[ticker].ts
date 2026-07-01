import type { APIRoute } from "astro";
import { getMiniQuote } from "../../../lib/priceCache";

export const prerender = false;

/**
 * 自選股小卡用:當日盤中分時走勢 + 最新報價 + 市場狀態。
 *   GET /api/quote-mini/2330
 *   -> { ticker, points:[…5分收盤], latest, prevClose, change, changePct, state, time }
 */
export const GET: APIRoute = async ({ params }) => {
  const ticker = params.ticker ?? "";
  if (!/^\d{4}$/.test(ticker)) {
    return new Response(JSON.stringify({ error: "invalid_ticker" }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  const q = await getMiniQuote(ticker);
  if (!q) {
    return new Response(JSON.stringify({ error: "no_data" }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  return new Response(JSON.stringify({ ticker, ...q }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=120",
    },
  });
};
