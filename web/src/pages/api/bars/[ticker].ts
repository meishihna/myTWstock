import type { APIRoute } from "astro";
import { getBars } from "../../../lib/priceCache";

export const prerender = false;

/**
 * 個股日線 OHLCV（近 2 年，Yahoo Chart v8、5 分鐘記憶體快取）。
 * 純 OHLCV、無指標 —— 供前端 Lightweight Charts 使用，亦為未來 TradingView
 * Charting Library Datafeed（getBars）可直接接上的資料端點。
 *   GET /api/bars/2330  ->  { ticker, bars: [{ time, open, high, low, close, volume }] }
 */
export const GET: APIRoute = async ({ params }) => {
  const ticker = params.ticker ?? "";
  if (!/^\d{4}$/.test(ticker)) {
    return new Response(JSON.stringify({ error: "invalid_ticker" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const bars = await getBars(ticker);
  if (!bars || bars.length < 2) {
    return new Response(JSON.stringify({ error: "no_data", bars: [] }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  return new Response(JSON.stringify({ ticker, bars }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
};
