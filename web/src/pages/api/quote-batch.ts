import type { APIRoute } from "astro";
import YahooFinance from "yahoo-finance2";
import type { QuoteBatchRow } from "../../lib/news-related";

export const prerender = false;

const yahooFinance = new YahooFinance({
  suppressNotices: ["yahooSurvey"],
});

const CACHE_TTL_MS = 60_000;
let cache: { key: string; body: string; ts: number } | null = null;

function extractRow(o: Record<string, unknown>, symbol: string): QuoteBatchRow {
  const price = o.regularMarketPrice as number | undefined;
  const prev = o.regularMarketPreviousClose as number | undefined;
  const rawPct = o.regularMarketChangePercent as number | undefined;
  let changePct: number | null = null;
  if (typeof rawPct === "number" && Number.isFinite(rawPct)) {
    changePct = Math.round(rawPct * 100) / 100;
  } else if (
    typeof price === "number" &&
    typeof prev === "number" &&
    prev !== 0
  ) {
    changePct = Math.round(((price - prev) / prev) * 10000) / 100;
  }

  return {
    symbol,
    shortName: o.shortName as string | undefined,
    currency: ((o.currency as string) ?? undefined) || undefined,
    price: typeof price === "number" ? price : null,
    previousClose: typeof prev === "number" ? prev : null,
    changePct,
  };
}

async function quoteOneYahooSymbol(symbol: string): Promise<QuoteBatchRow | null> {
  try {
    const q = await yahooFinance.quote(symbol);
    const row = Array.isArray(q) ? q[0] : q;
    if (!row || typeof row !== "object") return null;
    const o = row as Record<string, unknown>;
    if (typeof o.regularMarketPrice !== "number") return null;
    const sym = (o.symbol as string) || symbol;
    return extractRow(o, sym);
  } catch {
    return null;
  }
}

async function quoteTwFourDigit(ticker: string): Promise<QuoteBatchRow | null> {
  const candidates = [`${ticker}.TW`, `${ticker}.TWO`];
  for (const symbol of candidates) {
    const r = await quoteOneYahooSymbol(symbol);
    if (r) return { ...r, symbol: ticker };
  }
  return null;
}

function parseSymbolsParam(raw: string | null): string[] {
  if (!raw?.trim()) return [];
  const parts = raw.split(/[,，\s]+/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const s = p.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= 120) break;
  }
  return out;
}

export const GET: APIRoute = async ({ url }) => {
  const sp = new URL(url).searchParams;
  const symbols = parseSymbolsParam(sp.get("symbols") || sp.get("tickers"));
  if (symbols.length === 0) {
    return new Response(JSON.stringify({ error: "missing_symbols", quotes: {} }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const cacheKey = symbols.slice().sort().join(",");
  const now = Date.now();
  if (cache && cache.key === cacheKey && now - cache.ts < CACHE_TTL_MS) {
    return new Response(cache.body, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  }

  const quotes: Record<string, QuoteBatchRow> = {};

  await Promise.all(
    symbols.map(async (sym) => {
      if (/^\d{4}$/.test(sym)) {
        const r = await quoteTwFourDigit(sym);
        if (r) quotes[sym] = r;
        return;
      }
      const r = await quoteOneYahooSymbol(sym);
      if (r) quotes[sym] = r;
    })
  );

  const body = JSON.stringify({ quotes, fetchedAt: new Date().toISOString() });
  cache = { key: cacheKey, body, ts: now };

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60",
    },
  });
};
