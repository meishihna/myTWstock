/**
 * 新聞本地 NLP 層(純函式、deps 注入、server/client 皆可 import,無 Node 內建)。
 * - 情緒:財經詞典 + 否定/程度/標題加權,tanh 有界。
 * - Wikilink 標籤:對 wikilink-hub label 比對(重用 news-related 的 blocklist/工具)。
 * - 去重/事件聚類:標題 char-shingle Jaccard 貪婪單連結分群(決定性)。
 * 由 api/news.ts 於 fetchAllNews 後、寫 cache 前呼叫一次(每 5 分鐘週期)。
 */
import {
  NAME_MATCH_BLOCKLIST,
  findNeedleStarts,
  rangesOverlap,
  resolveTickersFromText,
  type NewsThemePayload,
} from "./news-related";

// ---- 對外型別 ----------------------------------------------------------------

export type SentimentLabel = "利多" | "中性" | "利空";

export interface SentimentResult {
  label: SentimentLabel;
  score: number; // -1..+1
  hits?: string[]; // 命中極性詞(除錯/tooltip;不一定上線)
}

export interface WikiTag {
  label: string;
  slug: string;
}

export interface NewsNlpFields {
  sentiment: SentimentResult;
  wikilinks: WikiTag[];
  clusterId: string | null;
}

export interface NewsCluster {
  clusterId: string;
  memberIds: string[];
  primaryId: string;
  sourceCount: number;
  sourceIds: string[];
}

export interface TickerSentiment {
  ticker: string;
  net: number; // 平均 score
  pos: number;
  neg: number;
  neu: number;
  n: number;
}

export interface NewsNlpResult {
  byId: Record<string, NewsNlpFields>;
  clusters: NewsCluster[];
  tickerSentiment: Record<string, TickerSentiment>;
}

/** Phase B:LLM 每日簡報(離線批次產出,runtime 只讀) */
export interface NewsDigestCluster {
  clusterId: string;
  name: string;
  oneLine: string;
  sourceCount?: number;
}

export interface NewsDigest {
  generatedAt: string;
  model?: string;
  digest: {
    headline: string;
    marketTone: SentimentLabel;
    bullets: string[];
    sectorsHot: string[];
    sectorsWeak: string[];
  };
  clusters?: NewsDigestCluster[];
}

export interface SentimentLexicon {
  positive: { term: string; weight: number }[];
  negative: { term: string; weight: number }[];
  negators: string[];
  intensifiers: { term: string; mult: number }[];
}

export interface WikiHubEntry {
  label: string;
  slug: string;
  count: number;
}

/** enrichArticlesNlp 需要的最小 article 形狀 */
export interface NlpArticleLike {
  id: string;
  title: string;
  summary: string;
  category: string;
  sourceId: string;
  published: string;
}

export interface NewsNlpDeps {
  lexicon: SentimentLexicon;
  wikilinkEntries: WikiHubEntry[];
  nameToTicker: Record<string, string>;
  validTickers: Set<string>;
  themePayload: NewsThemePayload | null;
}

export const MAX_WIKILINKS_PER_ARTICLE = 5;
const SENTIMENT_DEAD_BAND = 0.15;
const SENTIMENT_K = 4;
const TITLE_WEIGHT = 1.5;
const CLUSTER_JACCARD_MIN = 0.5;
const CLUSTER_TIME_WINDOW_MS = 48 * 60 * 60 * 1000;
/** 來源優先序(canonical 主篇挑選用;與 SOURCE_LABELS 一致) */
const SOURCE_PRIORITY: Record<string, number> = {
  cnyes: 0,
  udn: 1,
  ctee: 2,
  ltn: 3,
  technews: 4,
  ftech: 5,
  businessweekly: 6,
  yahoo: 7,
};

// ---- 共用小工具 --------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const PUNCT_SPLIT = /[，。！？；、,.!?;:：「」『』（）()\[\]【】\s]+/;

/** 取得 pos 之前、同一子句(不跨標點)的最多 maxLen 個字 */
function clauseTailBefore(text: string, pos: number, maxLen: number): string {
  const start = Math.max(0, pos - maxLen);
  const seg = text.slice(start, pos);
  const parts = seg.split(PUNCT_SPLIT);
  return parts[parts.length - 1] || "";
}

function fullwidthToHalfwidth(s: string): string {
  return s.replace(/[！-～]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  );
}

function hasCjk(s: string): boolean {
  return /[一-鿿]/.test(s);
}

// ---- 情緒 -------------------------------------------------------------------

type PolarHit = { start: number; end: number; sign: number; weight: number; term: string };

export function computeSentiment(
  title: string,
  summary: string,
  lex: SentimentLexicon
): SentimentResult {
  const titleText = title || "";
  const text = `${titleText}\n${summary || ""}`;
  const titleLen = titleText.length;

  const hits: PolarHit[] = [];
  const collect = (terms: { term: string; weight: number }[], sign: number) => {
    for (const { term, weight } of terms) {
      if (!term) continue;
      for (const start of findNeedleStarts(text, term)) {
        hits.push({ start, end: start + term.length, sign, weight, term });
      }
    }
  };
  collect(lex.positive, 1);
  collect(lex.negative, -1);

  // 長詞優先,避免「創新高」又計到「新高」
  hits.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);

  const used: [number, number][] = [];
  let raw = 0;
  const matched: string[] = [];
  for (const h of hits) {
    if (rangesOverlap(h.start, h.end, used)) continue;
    used.push([h.start, h.end]);
    const tail = clauseTailBefore(text, h.start, 4);
    let mult = 1;
    for (const it of lex.intensifiers) {
      if (it.term && tail.endsWith(it.term)) {
        mult = it.mult;
        break;
      }
    }
    const negated = lex.negators.some((n) => n && tail.includes(n));
    const sign = negated ? -h.sign : h.sign;
    const titleMult = h.start < titleLen ? TITLE_WEIGHT : 1;
    raw += sign * h.weight * mult * titleMult;
    matched.push((negated ? "¬" : "") + h.term);
  }

  const score = round2(Math.tanh(raw / SENTIMENT_K));
  const label: SentimentLabel =
    score >= SENTIMENT_DEAD_BAND ? "利多" : score <= -SENTIMENT_DEAD_BAND ? "利空" : "中性";
  return { label, score, hits: matched.slice(0, 8) };
}

// ---- Wikilink 標籤 ----------------------------------------------------------

function isWikiLabelEligible(label: string): boolean {
  const t = label.trim();
  if (!t) return false;
  if (NAME_MATCH_BLOCKLIST.has(t)) return false;
  if (hasCjk(t)) return t.replace(/\s+/g, "").length >= 2;
  // 純拉丁/數字(CoWoS、HBM、5G、AI):去掉非英數至少 2 碼
  return t.replace(/[^A-Za-z0-9]/g, "").length >= 2;
}

/** 拉丁標籤:大小寫不敏感、但需詞界(避免 AI 命中 email/Thailand) */
function latinMatch(text: string, label: string, titleLen: number): { hit: boolean; inTitle: boolean } {
  const lt = text.toLowerCase();
  const ll = label.toLowerCase();
  let from = 0;
  let i: number;
  while ((i = lt.indexOf(ll, from)) !== -1) {
    const before = i > 0 ? lt[i - 1] : "";
    const after = lt[i + ll.length] || "";
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) {
      return { hit: true, inTitle: i < titleLen };
    }
    from = i + 1;
  }
  return { hit: false, inTitle: false };
}

type WikiHit = { label: string; slug: string; score: number; len: number };

export function tagWikilinks(
  title: string,
  summary: string,
  entries: WikiHubEntry[],
  limit = MAX_WIKILINKS_PER_ARTICLE
): WikiTag[] {
  const titleText = title || "";
  const fullText = `${titleText}\n${summary || ""}`;
  // CJK 比對用去空白版本(新聞常見「AI伺服器」無空白)
  const normFull = fullwidthToHalfwidth(fullText).replace(/\s+/g, "");
  const normTitle = fullwidthToHalfwidth(titleText).replace(/\s+/g, "");

  const hits: WikiHit[] = [];
  const seenSlug = new Set<string>();
  for (const e of entries) {
    if (!e || !e.label || !e.slug) continue;
    if (seenSlug.has(e.slug)) continue;
    if (!isWikiLabelEligible(e.label)) continue;

    let hit = false;
    let inTitle = false;
    if (hasCjk(e.label)) {
      const norm = fullwidthToHalfwidth(e.label).replace(/\s+/g, "");
      if (norm.length >= 2 && normFull.includes(norm)) {
        hit = true;
        inTitle = normTitle.includes(norm);
      }
    } else {
      const r = latinMatch(fullText, e.label.trim(), titleText.length);
      hit = r.hit;
      inTitle = r.inTitle;
    }
    if (!hit) continue;
    seenSlug.add(e.slug);
    const len = e.label.replace(/\s+/g, "").length;
    const score = Math.log2(2 + (e.count || 0)) * 10 + len * 4 + (inTitle ? 40 : 0);
    hits.push({ label: e.label, slug: e.slug, score, len });
  }

  hits.sort((a, b) => b.score - a.score || b.len - a.len || a.label.localeCompare(b.label));

  // 輕量去重:避免選了長詞又選其子字串(台積電 vs 台積)
  const picked: WikiHit[] = [];
  for (const h of hits) {
    if (picked.length >= limit) break;
    const norm = h.label.replace(/\s+/g, "");
    const contained = picked.some((p) => {
      const pn = p.label.replace(/\s+/g, "");
      return pn.includes(norm) || norm.includes(pn);
    });
    if (contained) continue;
    picked.push(h);
  }
  return picked.map((h) => ({ label: h.label, slug: h.slug }));
}

// ---- 去重 / 事件聚類 --------------------------------------------------------

function normalizeTitle(title: string): string {
  let s = title || "";
  // 去掉 Google News 等尾綴來源:「 - 工商時報」「 | 鉅亨」
  s = s.replace(/\s*[-|｜–—]\s*[^-|｜–—]{2,14}$/u, "");
  s = fullwidthToHalfwidth(s).toLowerCase();
  s = s.replace(/[\s\p{P}]+/gu, "");
  return s;
}

function shingles(norm: string): Set<string> {
  const set = new Set<string>();
  if (norm.length <= 3) {
    if (norm) set.add(norm);
    return set;
  }
  for (let i = 0; i + 3 <= norm.length; i++) set.add(norm.slice(i, i + 3));
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function parseTime(s: string): number {
  const t = Date.parse(s || "");
  return Number.isFinite(t) ? t : NaN;
}

export function clusterArticles(articles: NlpArticleLike[]): NewsCluster[] {
  const n = articles.length;
  const norm = articles.map((a) => normalizeTitle(a.title));
  const shs = norm.map((s) => shingles(s));
  const times = articles.map((a) => parseTime(a.published));

  // union-find
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  for (let i = 0; i < n; i++) {
    if (shs[i].size === 0) continue;
    for (let j = i + 1; j < n; j++) {
      if (shs[j].size === 0) continue;
      const ti = times[i];
      const tj = times[j];
      if (
        Number.isFinite(ti) &&
        Number.isFinite(tj) &&
        Math.abs(ti - tj) > CLUSTER_TIME_WINDOW_MS
      ) {
        continue;
      }
      if (jaccard(shs[i], shs[j]) >= CLUSTER_JACCARD_MIN) union(i, j);
    }
  }

  // 收集群組
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const arr = groups.get(r);
    if (arr) arr.push(i);
    else groups.set(r, [i]);
  }

  const clusters: NewsCluster[] = [];
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    const sourceIds = Array.from(new Set(idxs.map((i) => articles[i].sourceId))).sort();
    if (sourceIds.length < 2) continue; // 僅跨來源才算事件群
    // canonical 主篇:最早發布 → 標題最長 → 來源優先序 → id
    const primaryIdx = idxs.slice().sort((a, b) => {
      const ta = times[a];
      const tb = times[b];
      const va = Number.isFinite(ta) ? ta : Number.POSITIVE_INFINITY;
      const vb = Number.isFinite(tb) ? tb : Number.POSITIVE_INFINITY;
      if (va !== vb) return va - vb;
      const la = (articles[a].title || "").length;
      const lb = (articles[b].title || "").length;
      if (la !== lb) return lb - la;
      const pa = SOURCE_PRIORITY[articles[a].sourceId] ?? 99;
      const pb = SOURCE_PRIORITY[articles[b].sourceId] ?? 99;
      if (pa !== pb) return pa - pb;
      return articles[a].id.localeCompare(articles[b].id);
    })[0];
    const primaryId = articles[primaryIdx].id;
    const memberIds = idxs
      .map((i) => articles[i].id)
      .sort((x, y) => x.localeCompare(y));
    clusters.push({
      clusterId: `cl_${primaryId}`,
      memberIds,
      primaryId,
      sourceCount: sourceIds.length,
      sourceIds,
    });
  }
  // 決定性排序:主篇時間新→舊
  clusters.sort((a, b) => {
    const ia = articles.findIndex((x) => x.id === a.primaryId);
    const ib = articles.findIndex((x) => x.id === b.primaryId);
    const ta = times[ia];
    const tb = times[ib];
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });
  return clusters;
}

// ---- 總成 -------------------------------------------------------------------

export function enrichArticlesNlp(
  articles: NlpArticleLike[],
  deps: NewsNlpDeps
): NewsNlpResult {
  const byId: Record<string, NewsNlpFields> = {};
  const agg: Record<string, TickerSentiment> = {};

  for (const a of articles) {
    const sentiment = computeSentiment(a.title, a.summary, deps.lexicon);
    const wikilinks = tagWikilinks(a.title, a.summary, deps.wikilinkEntries);
    byId[a.id] = { sentiment, wikilinks, clusterId: null };

    const resolved = resolveTickersFromText(
      a.title,
      a.summary,
      deps.nameToTicker,
      deps.validTickers,
      a.category,
      deps.themePayload
    );
    for (const tk of resolved.tickers) {
      const cur =
        agg[tk] || (agg[tk] = { ticker: tk, net: 0, pos: 0, neg: 0, neu: 0, n: 0 });
      cur.n += 1;
      cur.net += sentiment.score; // 暫存總和,最後轉平均
      if (sentiment.label === "利多") cur.pos += 1;
      else if (sentiment.label === "利空") cur.neg += 1;
      else cur.neu += 1;
    }
  }

  const clusters = clusterArticles(articles);
  for (const c of clusters) {
    for (const mid of c.memberIds) {
      if (byId[mid]) byId[mid].clusterId = c.clusterId;
    }
  }

  const tickerSentiment: Record<string, TickerSentiment> = {};
  for (const [tk, v] of Object.entries(agg)) {
    tickerSentiment[tk] = { ...v, net: v.n ? round2(v.net / v.n) : 0 };
  }

  return { byId, clusters, tickerSentiment };
}
