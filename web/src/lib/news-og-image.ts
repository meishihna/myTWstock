/**
 * 新聞卡片：RSS 未附圖時，自原文 URL 解析 og:image / twitter:image（僅供 /api/news 伺服端）。
 * Google News 等轉址頁至少可取得 Google 縮圖；不永久快取失敗結果以免永遠無圖。
 */

import type { NewsArticle } from "./news-sources";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 16_000;
/**
 * Google News 等 SPA 會把 og:image 塞在很後面（實測約 57 萬字元後），不能只截前段。
 * 仍設上限避免惡意超大頁面耗盡記憶體。
 */
const MAX_HTML_FOR_OG_PARSE = 2_000_000;

/** v2：舊版曾快取空字串導致永遠無圖，改鍵前綴使舊條目失效 */
const CACHE_PREFIX = "v2:";
const ogCache = new Map<string, string>();

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** @internal 供測試／除錯 */
export function parseOgFromHtml(html: string): string {
  const chunk =
    html.length > MAX_HTML_FOR_OG_PARSE
      ? html.slice(0, MAX_HTML_FOR_OG_PARSE)
      : html;
  const patterns: RegExp[] = [
    /property=["']og:image["'][^>]*?content=["']([^"']+)["']/i,
    /content=["']([^"']+)["'][^>]*?property=["']og:image["']/i,
    /property=["']og:image["']\s+content=["']([^"']+)["']/i,
    /property=["']og:image["']\s+content=([^\s>]+)/i,
    /name=["']twitter:image["'][^>]*?content=["']([^"']+)["']/i,
    /name=["']twitter:image:src["'][^>]*?content=["']([^"']+)["']/i,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = chunk.match(re);
    if (m?.[1]) {
      const raw = m[1].trim();
      if (/^https?:\/\//i.test(raw)) return decodeBasicEntities(raw);
    }
  }
  return "";
}

function isValidImageHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * 抓取單一網頁的 OG／Twitter 圖片 URL；失敗回傳空字串。
 * 成功結果才寫入快取；失敗不寫入，以便下次重試。
 */
export async function fetchOgImageUrl(articleUrl: string): Promise<string> {
  const key = articleUrl.trim();
  if (!key) return "";
  const cacheKey = CACHE_PREFIX + key;
  if (ogCache.has(cacheKey)) return ogCache.get(cacheKey) || "";

  let resolved = "";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(key, {
      signal: ac.signal,
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.7",
      },
    });
    if (!res.ok) {
      return "";
    }
    const html = await res.text();
    resolved = parseOgFromHtml(html);
    if (resolved && !isValidImageHttpUrl(resolved)) {
      resolved = "";
    }
  } catch (e) {
    resolved = "";
  } finally {
    clearTimeout(timer);
  }

  if (resolved) {
    ogCache.set(cacheKey, resolved);
  }
  return resolved;
}

const BATCH = 6;

export async function fetchOgImageUrlsBatch(urls: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
  const map = new Map<string, string>();
  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH);
    const results = await Promise.all(chunk.map((u) => fetchOgImageUrl(u)));
    chunk.forEach((u, j) => {
      const img = results[j];
      if (img) map.set(u, img);
    });
  }
  return map;
}

export function articleHasUsableImage(a: NewsArticle): boolean {
  const s = a.image?.trim() || "";
  if (!s) return false;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * 為缺圖文章批次補上 og:image（不修改傳入物件，回傳新陣列）。
 */
export async function enrichNewsArticlesWithOgImages(
  articles: NewsArticle[]
): Promise<NewsArticle[]> {
  const need = articles.filter((a) => !articleHasUsableImage(a));
  if (need.length === 0) return articles;
  const urls = [...new Set(need.map((a) => a.url))];
  const map = await fetchOgImageUrlsBatch(urls);
  return articles.map((a) => {
    const img = map.get(a.url);
    if (img) return { ...a, image: img };
    return a;
  });
}
