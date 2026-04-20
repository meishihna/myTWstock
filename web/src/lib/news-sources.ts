/**
 * 台灣財經新聞聚合：多來源 fetch，供 /api/news 使用（僅 Node SSR）。
 */
import { createHash } from "node:crypto";
import Parser from "rss-parser";

export interface NewsArticle {
  id: string;
  title: string;
  summary: string;
  url: string;
  source: string;
  sourceId: NewsSourceId;
  category: NewsCategoryLabel;
  image: string;
  published: string;
}

export type NewsSourceId =
  | "cnyes"
  | "udn"
  | "ctee"
  | "ltn"
  | "technews"
  | "ftech"
  | "businessweekly"
  | "yahoo";

/** Tab / ?category= 對應 */
export type NewsCategoryLabel =
  | "台股"
  | "國際"
  | "科技"
  | "產業"
  | "財經";

export interface NewsResponse {
  articles: NewsArticle[];
  sources: Record<string, { name: string; count: number }>;
  lastUpdated: string;
  total: number;
}

export const SOURCE_LABELS: Record<NewsSourceId, string> = {
  cnyes: "鉅亨網",
  udn: "經濟日報",
  ctee: "工商時報",
  ltn: "自由時報",
  technews: "科技新報",
  ftech: "財經新報",
  businessweekly: "商業周刊",
  yahoo: "Yahoo股市",
};

const FETCH_TIMEOUT_MS = 15_000;

const UA =
  "Mozilla/5.0 (compatible; TWstock/1.0; +https://github.com/meishihna/myTWstock)";

function md5Id(url: string): string {
  return createHash("md5").update(url).digest("hex").slice(0, 12);
}

function stripHtml(html: string): string {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** 從 RSS 內嵌 HTML 取第一張圖（不少來源把圖放在 content） */
export function extractFirstImageUrlFromHtml(html: string): string {
  if (!html) return "";
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (!m?.[1]) return "";
  let u = m[1].trim();
  u = decodeBasicEntities(u);
  if (/^\/\//.test(u)) u = "https:" + u;
  if (!/^https?:\/\//i.test(u)) return "";
  return u;
}

type RssItemLike = Record<string, unknown> & {
  enclosure?: { url?: string; type?: string };
  content?: string;
  contentSnippet?: string;
  itunes?: { image?: string };
};

function extractImageFromRssItemFields(
  item: RssItemLike,
  imageFallback: string
): string {
  const enc = item.enclosure;
  if (enc?.url) {
    const u = String(enc.url).trim();
    const typ = String(enc.type || "").toLowerCase();
    if (
      !typ ||
      typ.startsWith("image/") ||
      /\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(u)
    ) {
      if (/^https?:\/\//i.test(u)) return u;
    }
  }

  const mediaThumb = item["media:thumbnail"] as
    | { $?: { url?: string }; url?: string }
    | undefined;
  if (mediaThumb?.$?.url && /^https?:\/\//i.test(String(mediaThumb.$.url))) {
    return String(mediaThumb.$.url).trim();
  }
  if (typeof mediaThumb?.url === "string" && /^https?:\/\//i.test(mediaThumb.url)) {
    return mediaThumb.url.trim();
  }

  const mc = item["media:content"] as
    | { $?: { url?: string; medium?: string } }
    | { $?: { url?: string; medium?: string } }[]
    | undefined;
  const mcList = Array.isArray(mc) ? mc : mc ? [mc] : [];
  for (const m of mcList) {
    const url = m?.$?.url;
    const medium = String(m?.$?.medium || "").toLowerCase();
    if (!url) continue;
    const u = String(url).trim();
    if (!/^https?:\/\//i.test(u)) continue;
    if (
      medium === "image" ||
      medium.startsWith("image/") ||
      /\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(u)
    ) {
      return u;
    }
  }

  const contentEncoded = item["content:encoded"] ?? item.contentEncoded;
  const htmlSources = [
    typeof item.content === "string" ? item.content : "",
    typeof contentEncoded === "string" ? contentEncoded : "",
    typeof (item as { description?: string }).description === "string"
      ? (item as { description: string }).description
      : "",
  ];
  for (const h of htmlSources) {
    const u = extractFirstImageUrlFromHtml(h);
    if (u) return u;
  }

  if (item.itunes?.image && /^https?:\/\//i.test(String(item.itunes.image))) {
    return String(item.itunes.image).trim();
  }

  if (imageFallback && /^https?:\/\//i.test(imageFallback)) return imageFallback;
  return "";
}

function toIsoFromSecondsOrMs(t: number): string {
  if (!Number.isFinite(t) || t <= 0) return new Date().toISOString();
  const ms = t > 1e12 ? t : t * 1000;
  return new Date(ms).toISOString();
}

async function fetchWithTimeout(
  url: string,
  init?: RequestInit
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers = new Headers(init?.headers);
    if (!headers.has("User-Agent")) headers.set("User-Agent", UA);
    return await fetch(url, {
      ...init,
      signal: ac.signal,
      headers,
    });
  } finally {
    clearTimeout(timer);
  }
}

const rssParser = new Parser({
  timeout: FETCH_TIMEOUT_MS,
  headers: { "User-Agent": UA },
  customFields: {
    item: [
      "media:content",
      "media:thumbnail",
      ["content:encoded", "contentEncoded"],
    ],
  },
});

function articleFromRssItem(
  item: {
    title?: string;
    link?: string;
    pubDate?: string;
    content?: string;
    contentSnippet?: string;
    enclosure?: { url?: string; type?: string };
    itunes?: { image?: string };
    [key: string]: unknown;
  },
  sourceId: NewsSourceId,
  category: NewsCategoryLabel,
  imageFallback = ""
): NewsArticle | null {
  const link = (item.link || "").trim();
  const title = (item.title || "").trim();
  if (!link || !title) return null;
  const summary = stripHtml(
    item.contentSnippet || item.content || ""
  ).slice(0, 500);
  const pub = item.pubDate
    ? new Date(item.pubDate).toISOString()
    : new Date().toISOString();
  const legacyMedia =
    (item as { mediaContent?: { $?: { url?: string } } }).mediaContent?.$?.url ||
    "";
  const image =
    extractImageFromRssItemFields(item as RssItemLike, imageFallback || legacyMedia) ||
    "";

  return {
    id: md5Id(link),
    title,
    summary,
    url: link,
    source: SOURCE_LABELS[sourceId],
    sourceId,
    category,
    image: image || "",
    published: pub,
  };
}

async function parseRssUrl(
  url: string,
  sourceId: NewsSourceId,
  category: NewsCategoryLabel
): Promise<NewsArticle[]> {
  try {
    const feed = await rssParser.parseURL(url);
    const out: NewsArticle[] = [];
    for (const item of feed.items || []) {
      const a = articleFromRssItem(item, sourceId, category);
      if (a) out.push(a);
    }
    return out;
  } catch {
    return [];
  }
}

/** 鉅亨：多 category 並行，結構防禦解析 */
export async function fetchCnyes(): Promise<NewsArticle[]> {
  const endpoints: { path: string; cat: NewsCategoryLabel }[] = [
    { path: "tw_stock", cat: "台股" },
    { path: "tw_stock_news", cat: "台股" },
    { path: "wd_stock", cat: "國際" },
    { path: "tech", cat: "科技" },
    { path: "headline", cat: "財經" },
  ];
  const base =
    "https://api.cnyes.com/media/api/v1/newslist/category";
  const results: NewsArticle[] = [];

  await Promise.all(
    endpoints.map(async ({ path, cat }) => {
      try {
        const url = `${base}/${path}?limit=25&page=1`;
        const res = await fetchWithTimeout(url, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) return;
        const json = (await res.json()) as Record<string, unknown>;
        const items =
          (json as { items?: { data?: unknown[] } }).items?.data ??
          (json as { data?: unknown[] }).data ??
          [];
        if (!Array.isArray(items)) return;

        for (const raw of items) {
          const it = raw as Record<string, unknown>;
          const newsId = it.newsId ?? it.id;
          const title = String(it.title ?? "").trim();
          if (newsId == null || !title) continue;
          const idStr = String(newsId);
          const link = `https://news.cnyes.com/news/id/${idStr}`;
          const summary = stripHtml(String(it.summary ?? it.description ?? ""));
          let pub = "";
          const pa = it.publishAt ?? it.publishedAt ?? it.time;
          if (typeof pa === "number") {
            pub = toIsoFromSecondsOrMs(pa);
          } else if (typeof pa === "string") {
            const n = Number(pa);
            pub = Number.isFinite(n)
              ? toIsoFromSecondsOrMs(n)
              : new Date(pa).toISOString();
          } else {
            pub = new Date().toISOString();
          }
          const cover = it.coverSrc as
            | { xl?: { src?: string }; lg?: { src?: string } }
            | undefined;
          const image =
            cover?.xl?.src || cover?.lg?.src || String(it.imageUrl ?? "");

          const catNames = it.categoryName;
          let bucket: NewsCategoryLabel = cat;
          if (Array.isArray(catNames) && catNames.length) {
            const first = String(catNames[0]);
            if (/國際|美股|全球/.test(first)) bucket = "國際";
            else if (/科技/.test(first)) bucket = "科技";
            else if (/產業/.test(first)) bucket = "產業";
            else if (/台股|證券/.test(first)) bucket = "台股";
          }

          results.push({
            id: md5Id(link),
            title,
            summary: summary.slice(0, 500),
            url: link,
            source: SOURCE_LABELS.cnyes,
            sourceId: "cnyes",
            category: bucket,
            image,
            published: pub,
          });
        }
      } catch {
        /* skip branch */
      }
    })
  );

  return results;
}

export async function fetchUdn(): Promise<NewsArticle[]> {
  const feeds: { url: string; cat: NewsCategoryLabel }[] = [
    {
      url: "https://money.udn.com/rssfeed/news/1001/5590",
      cat: "台股",
    },
    {
      url: "https://money.udn.com/rssfeed/news/1001/5591",
      cat: "產業",
    },
    {
      url: "https://money.udn.com/rssfeed/news/1001/12925",
      cat: "國際",
    },
  ];
  const chunks = await Promise.all(
    feeds.map((f) => parseRssUrl(f.url, "udn", f.cat))
  );
  return chunks.flat();
}

/**
 * 工商時報：官網舊版 /rss/*.xml 已失效（S3 404）。
 * 改以 Google 新聞 `site:ctee.com.tw` 聚合（連結多為 Google 轉址，點入仍導向原文）。
 */
function cteeCategoryFromGoogleTitle(title: string): NewsCategoryLabel {
  const t = title.replace(/\s+/g, " ");
  if (/\s[-–—]\s*證券\s*[-–—]|\s證券\s*-\s*工商|股市/.test(t)) return "台股";
  if (/\s[-–—]\s*科技\s*[-–—]/.test(t) || /科技\s*-\s*工商/.test(t)) return "科技";
  if (/\s[-–—]\s*產業\s*[-–—]/.test(t) || /產業\s*-\s*工商/.test(t)) return "產業";
  if (/國際|美股|歐股|日股/.test(t)) return "國際";
  return "財經";
}

export async function fetchCtee(): Promise<NewsArticle[]> {
  const feedUrl =
    "https://news.google.com/rss/search?q=site:ctee.com.tw&hl=zh-TW&gl=TW&ceid=TW:zh-Hant";
  try {
    const feed = await rssParser.parseURL(feedUrl);
    const out: NewsArticle[] = [];
    for (const item of feed.items || []) {
      const title = (item.title || "").trim();
      const link = (item.link || "").trim();
      if (!title || !link) continue;
      const summary = stripHtml(
        item.contentSnippet || item.content || ""
      ).slice(0, 500);
      const pub = item.pubDate
        ? new Date(item.pubDate).toISOString()
        : new Date().toISOString();
      const img =
        extractFirstImageUrlFromHtml(String(item.content || "")) ||
        extractImageFromRssItemFields(item as RssItemLike, "");
      out.push({
        id: md5Id(link),
        title,
        summary,
        url: link,
        source: SOURCE_LABELS.ctee,
        sourceId: "ctee",
        category: cteeCategoryFromGoogleTitle(title),
        image: img,
        published: pub,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function fetchLtn(): Promise<NewsArticle[]> {
  return parseRssUrl(
    "https://news.ltn.com.tw/rss/business.xml",
    "ltn",
    "財經"
  );
}

/** 科技新報主站（科技類） */
export async function fetchTechnews(): Promise<NewsArticle[]> {
  return parseRssUrl("https://technews.tw/feed/", "technews", "科技");
}

/** 財經新報（finance.technews.tw） */
export async function fetchFinanceTechnews(): Promise<NewsArticle[]> {
  return parseRssUrl(
    "https://finance.technews.tw/feed/",
    "ftech",
    "財經"
  );
}

/**
 * 商業周刊：官網 RSS 多為 HTML 列表頁，改以 Google 新聞 `site:` 聚合（連結可能經 Google 轉址）。
 */
function businessWeeklyCategoryFromGoogleTitle(title: string): NewsCategoryLabel {
  const t = title.replace(/\s+/g, " ");
  if (/科技|半導體|AI|晶片|數位/.test(t)) return "科技";
  if (/產業|企業|公司/.test(t)) return "產業";
  if (/國際|全球|美國|中國|歐洲|日本/.test(t)) return "國際";
  if (/台股|股市|股價|證券/.test(t)) return "台股";
  return "財經";
}

export async function fetchBusinessWeekly(): Promise<NewsArticle[]> {
  const feedUrl =
    "https://news.google.com/rss/search?q=site:businessweekly.com.tw&hl=zh-TW&gl=TW&ceid=TW:zh-Hant";
  try {
    const feed = await rssParser.parseURL(feedUrl);
    const out: NewsArticle[] = [];
    for (const item of feed.items || []) {
      const title = (item.title || "").trim();
      const link = (item.link || "").trim();
      if (!title || !link) continue;
      const summary = stripHtml(
        item.contentSnippet || item.content || ""
      ).slice(0, 500);
      const pub = item.pubDate
        ? new Date(item.pubDate).toISOString()
        : new Date().toISOString();
      const img =
        extractFirstImageUrlFromHtml(String(item.content || "")) ||
        extractImageFromRssItemFields(item as RssItemLike, "");
      out.push({
        id: md5Id(link),
        title,
        summary,
        url: link,
        source: SOURCE_LABELS.businessweekly,
        sourceId: "businessweekly",
        category: businessWeeklyCategoryFromGoogleTitle(title),
        image: img,
        published: pub,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function fetchYahooTw(): Promise<NewsArticle[]> {
  const feeds: { url: string; cat: NewsCategoryLabel }[] = [
    {
      url: "https://tw.stock.yahoo.com/rss?category=tw-stock",
      cat: "台股",
    },
    {
      url: "https://tw.stock.yahoo.com/rss?category=intl-stock",
      cat: "國際",
    },
    {
      url: "https://tw.stock.yahoo.com/rss?category=research",
      cat: "財經",
    },
  ];
  const chunks = await Promise.all(
    feeds.map((f) => parseRssUrl(f.url, "yahoo", f.cat))
  );
  return chunks.flat();
}

function dedupeAndSort(articles: NewsArticle[]): NewsArticle[] {
  const map = new Map<string, NewsArticle>();
  for (const a of articles) {
    if (!map.has(a.id)) map.set(a.id, a);
  }
  return [...map.values()].sort(
    (x, y) =>
      new Date(y.published).getTime() - new Date(x.published).getTime()
  );
}

const ALL_SOURCE_IDS = [
  "cnyes",
  "udn",
  "ctee",
  "ltn",
  "technews",
  "ftech",
  "businessweekly",
  "yahoo",
] as const;

/** ?category= 對應到 NewsCategoryLabel；all 或未知則不篩類別 */
export function articleMatchesCategoryQuery(
  article: NewsArticle,
  categoryParam: string | null
): boolean {
  const p = (categoryParam || "all").trim().toLowerCase();
  if (!p || p === "all") return true;
  const map: Record<string, NewsCategoryLabel> = {
    tw_stock: "台股",
    wd_stock: "國際",
    intl: "國際",
    international: "國際",
    tech: "科技",
    industry: "產業",
    finance: "財經",
  };
  const want = map[p];
  if (!want) return true;
  return article.category === want;
}

/** ?source=cnyes,udn ；空則不篩 */
export function parseSourceFilter(
  sourceParam: string | null
): Set<NewsSourceId> | null {
  const raw = sourceParam?.trim();
  if (!raw) return null;
  const allowed = new Set<NewsSourceId>();
  for (const part of raw.split(",")) {
    const id = part.trim() as NewsSourceId;
    if (ALL_SOURCE_IDS.includes(id as (typeof ALL_SOURCE_IDS)[number])) {
      allowed.add(id);
    }
  }
  return allowed.size > 0 ? allowed : null;
}

/** 僅套用分類／來源篩選，不截斷筆數（供統計各來源與 total） */
export function applyNewsFilters(
  articles: NewsArticle[],
  categoryParam: string | null,
  sourceParam: string | null
): NewsArticle[] {
  const src = parseSourceFilter(sourceParam);
  let list = articles.filter((a) =>
    articleMatchesCategoryQuery(a, categoryParam)
  );
  if (src) {
    list = list.filter((a) => src.has(a.sourceId));
  }
  return list;
}

export function filterArticles(
  articles: NewsArticle[],
  categoryParam: string | null,
  sourceParam: string | null,
  limit: number
): NewsArticle[] {
  return applyNewsFilters(articles, categoryParam, sourceParam).slice(
    0,
    Math.max(0, limit)
  );
}

/** 各來源皆列出筆數，0 表示該篩選條件下無資料或抓取失敗 */
export function countArticlesBySource(
  articles: NewsArticle[]
): NewsResponse["sources"] {
  const out = {} as NewsResponse["sources"];
  for (const id of Object.keys(SOURCE_LABELS) as NewsSourceId[]) {
    out[id] = {
      name: SOURCE_LABELS[id],
      count: articles.filter((a) => a.sourceId === id).length,
    };
  }
  return out;
}

/**
 * 並行抓取全部來源，合併、去重、依時間降序。
 */
export async function fetchAllNews(): Promise<NewsArticle[]> {
  const settled = await Promise.allSettled([
    fetchCnyes(),
    fetchUdn(),
    fetchCtee(),
    fetchLtn(),
    fetchTechnews(),
    fetchFinanceTechnews(),
    fetchBusinessWeekly(),
    fetchYahooTw(),
  ]);

  const all: NewsArticle[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") all.push(...s.value);
  }
  return dedupeAndSort(all);
}
