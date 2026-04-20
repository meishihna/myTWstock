import type { APIRoute } from "astro";
import {
  type NewsArticle,
  type NewsResponse,
  applyNewsFilters,
  countArticlesBySource,
  fetchAllNews,
} from "../../lib/news-sources";
import { enrichNewsArticlesWithOgImages } from "../../lib/news-og-image";

export const prerender = false;

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { articles: NewsArticle[]; timestamp: number } | null = null;

function parseLimit(raw: string | null): number {
  const n = raw != null ? parseInt(String(raw), 10) : 50;
  if (!Number.isFinite(n) || n < 1) return 50;
  return Math.min(n, 200);
}

export const GET: APIRoute = async ({ url }) => {
  const sp = new URL(url).searchParams;
  const category = sp.get("category");
  const source = sp.get("source");
  const limit = parseLimit(sp.get("limit"));

  const now = Date.now();
  if (cache && now - cache.timestamp < CACHE_TTL_MS) {
    const full = applyNewsFilters(cache.articles, category, source);
    const page = full.slice(0, limit);
    const enriched = await enrichNewsArticlesWithOgImages(page);
    const body: NewsResponse = {
      articles: enriched,
      sources: countArticlesBySource(full),
      lastUpdated: new Date().toISOString(),
      total: full.length,
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  }

  let articles: NewsArticle[];
  try {
    articles = await fetchAllNews();
  } catch {
    return new Response(JSON.stringify({ error: "fetch_failed" }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  if (articles.length === 0) {
    return new Response(JSON.stringify({ error: "no_articles" }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  cache = { articles, timestamp: Date.now() };

  const full = applyNewsFilters(articles, category, source);
  const page = full.slice(0, limit);
  const enriched = await enrichNewsArticlesWithOgImages(page);
  const body: NewsResponse = {
    articles: enriched,
    sources: countArticlesBySource(full),
    lastUpdated: new Date().toISOString(),
    total: full.length,
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60",
    },
  });
};
