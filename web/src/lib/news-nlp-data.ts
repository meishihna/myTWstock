/**
 * Server-only:讀取並 module-cache 新聞 NLP 所需的 public/data JSON 字典,
 * 讓 news-nlp.ts 保持純函式(deps 注入)。亦提供 Phase B 每日簡報的讀取(缺檔 → null)。
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { NewsThemePayload } from "./news-related";
import type {
  NewsDigest,
  NewsNlpDeps,
  SentimentLexicon,
  WikiHubEntry,
} from "./news-nlp";

const DATA_DIR = join(process.cwd(), "public", "data");
const DEPS_TTL_MS = 5 * 60 * 1000;

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(DATA_DIR, file), "utf8")) as T;
  } catch {
    return fallback;
  }
}

let depsCache: NewsNlpDeps | null = null;
let depsCachedAt = 0;

export function loadNewsNlpDeps(): NewsNlpDeps {
  const now = Date.now();
  if (depsCache && now - depsCachedAt < DEPS_TTL_MS) return depsCache;

  const lexicon = readJson<SentimentLexicon>("news-sentiment-lexicon.json", {
    positive: [],
    negative: [],
    negators: [],
    intensifiers: [],
  });
  const hub = readJson<{ entries: WikiHubEntry[] }>("wikilink-hub-top500.json", {
    entries: [],
  });
  const reports = readJson<{
    byTicker: Record<string, unknown>;
    nameToTicker: Record<string, string>;
  }>("reports-index.json", { byTicker: {}, nameToTicker: {} });
  const themePayload = readJson<NewsThemePayload>("news-theme-tickers.json", {});

  depsCache = {
    lexicon,
    wikilinkEntries: Array.isArray(hub.entries) ? hub.entries : [],
    nameToTicker: reports.nameToTicker || {},
    validTickers: new Set(Object.keys(reports.byTicker || {})),
    themePayload: themePayload || null,
  };
  depsCachedAt = now;
  return depsCache;
}

// ---- Phase B:每日簡報(缺檔/壞檔 → null,頁面照常) ----
let digestCache: NewsDigest | null = null;
let digestMtime = -1;
let digestCheckedAt = 0;

export function loadNewsDigest(): NewsDigest | null {
  const now = Date.now();
  // 最多每 30 秒檢查一次 mtime,變動才重讀
  if (now - digestCheckedAt < 30_000) return digestCache;
  digestCheckedAt = now;
  const path = join(DATA_DIR, "news-digest.json");
  try {
    const mtime = statSync(path).mtimeMs;
    if (mtime !== digestMtime) {
      digestMtime = mtime;
      digestCache = JSON.parse(readFileSync(path, "utf8")) as NewsDigest;
    }
  } catch {
    digestMtime = -1;
    digestCache = null;
  }
  return digestCache;
}
