import type { APIRoute } from "astro";
import {
  type NewsArticle,
  type NewsResponse,
  applyNewsFilters,
  countArticlesBySource,
  fetchAllNews,
} from "../../lib/news-sources";
import { enrichNewsArticlesWithOgImages } from "../../lib/news-og-image";
import { enrichArticlesNlp, type NewsNlpResult } from "../../lib/news-nlp";
import { loadNewsDigest, loadNewsNlpDeps } from "../../lib/news-nlp-data";

export const prerender = false;

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { articles: NewsArticle[]; nlp: NewsNlpResult; timestamp: number } | null =
  null;

function parseLimit(raw: string | null): number {
  const n = raw != null ? parseInt(String(raw), 10) : 50;
  if (!Number.isFinite(n) || n < 1) return 50;
  return Math.min(n, 200);
}

/** 把已算好的 NLP 欄位掛到本頁 article 上 */
function withNlp(page: NewsArticle[], nlp: NewsNlpResult): NewsArticle[] {
  return page.map((a) => {
    const f = nlp.byId[a.id];
    if (!f) return a;
    return {
      ...a,
      sentiment: f.sentiment,
      wikilinks: f.wikilinks,
      clusterId: f.clusterId,
    };
  });
}

/** 僅回傳成員出現在本頁的事件群,避免回應膨脹 */
function clustersForPage(page: NewsArticle[], nlp: NewsNlpResult) {
  const ids = new Set(page.map((a) => a.id));
  return nlp.clusters.filter((c) => c.memberIds.some((m) => ids.has(m)));
}

async function buildBody(
  full: NewsArticle[],
  limit: number,
  nlp: NewsNlpResult
): Promise<NewsResponse> {
  const page = full.slice(0, limit);
  const enriched = await enrichNewsArticlesWithOgImages(page);
  return {
    articles: withNlp(enriched, nlp),
    sources: countArticlesBySource(full),
    lastUpdated: new Date().toISOString(),
    total: full.length,
    clusters: clustersForPage(enriched, nlp),
    tickerSentiment: nlp.tickerSentiment,
    digest: loadNewsDigest(),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(status === 200 ? { "Cache-Control": "public, max-age=60" } : {}),
    },
  });
}

export const GET: APIRoute = async ({ url }) => {
  const sp = new URL(url).searchParams;
  const category = sp.get("category");
  const source = sp.get("source");
  const limit = parseLimit(sp.get("limit"));

  const now = Date.now();
  if (cache && now - cache.timestamp < CACHE_TTL_MS) {
    const full = applyNewsFilters(cache.articles, category, source);
    return jsonResponse(await buildBody(full, limit, cache.nlp));
  }

  let articles: NewsArticle[];
  try {
    articles = await fetchAllNews();
  } catch {
    return jsonResponse({ error: "fetch_failed" }, 502);
  }

  if (articles.length === 0) {
    return jsonResponse({ error: "no_articles" }, 502);
  }

  // 每 5 分鐘週期算一次 NLP(情緒/wikilink/聚類/個股彙總),與 articles 一併入 cache
  let nlp: NewsNlpResult;
  try {
    nlp = enrichArticlesNlp(articles, loadNewsNlpDeps());
  } catch {
    nlp = { byId: {}, clusters: [], tickerSentiment: {} };
  }
  cache = { articles, nlp, timestamp: Date.now() };

  const full = applyNewsFilters(articles, category, source);
  return jsonResponse(await buildBody(full, limit, nlp));
};
