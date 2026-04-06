import type { APIRoute } from "astro";
import YahooFinance from "yahoo-finance2";

export const prerender = false;

/** v3 必須實例化後再呼叫 quote，否則執行期拋錯（前端會顯示「無法取得行情」） */
const yahooFinance = new YahooFinance({
  suppressNotices: ["yahooSurvey"],
});

function extract(q: Record<string, unknown>) {
  const price = q.regularMarketPrice as number | undefined;
  const prev = q.regularMarketPreviousClose as number | undefined;
  const t = q.regularMarketTime as Date | undefined;
  return {
    symbol: q.symbol as string,
    shortName: q.shortName as string | undefined,
    currency: (q.currency as string) ?? "TWD",
    price: typeof price === "number" ? price : null,
    previousClose: typeof prev === "number" ? prev : null,
    marketTime: t instanceof Date ? t.toISOString() : null,
  };
}

async function quoteTwTicker(ticker: string) {
  const candidates = [`${ticker}.TW`, `${ticker}.TWO`];
  let lastErr: unknown;
  for (const symbol of candidates) {
    try {
      const q = await yahooFinance.quote(symbol);
      const row = Array.isArray(q) ? q[0] : q;
      if (!row || typeof row !== "object") continue;
      const o = row as Record<string, unknown>;
      if (typeof o.regularMarketPrice === "number") {
        return extract(o);
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("No quote for candidates");
}

export const GET: APIRoute = async ({ params }) => {
  const raw = params.ticker ?? "";
  if (!/^\d{4}$/.test(raw)) {
    return new Response(JSON.stringify({ error: "invalid_ticker" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const data = await quoteTwTicker(raw);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  } catch {
    return new Response(JSON.stringify({ error: "quote_failed" }), {
      status: 502,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }
};
