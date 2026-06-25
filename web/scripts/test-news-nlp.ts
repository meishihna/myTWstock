/**
 * 新聞本地 NLP 回歸測試:node 執行
 *   npm run test:news-nlp
 */
import assert from "node:assert/strict";
import {
  clusterArticles,
  computeSentiment,
  enrichArticlesNlp,
  tagWikilinks,
  type NlpArticleLike,
  type SentimentLexicon,
  type WikiHubEntry,
} from "../src/lib/news-nlp.ts";

const lex: SentimentLexicon = {
  positive: [
    { term: "創新高", weight: 3 },
    { term: "新高", weight: 2 },
    { term: "成長", weight: 1 },
    { term: "看好", weight: 2 },
  ],
  negative: [
    { term: "重挫", weight: 3 },
    { term: "衰退", weight: 2 },
    { term: "虧損", weight: 2 },
  ],
  negators: ["不", "未"],
  intensifiers: [
    { term: "大幅", mult: 1.6 },
    { term: "略", mult: 0.6 },
  ],
};

// ---- 情緒 ----
function testSentimentBasics() {
  assert.equal(computeSentiment("台積電營收創新高", "", lex).label, "利多");
  assert.equal(computeSentiment("面板報價重挫", "", lex).label, "利空");
  assert.equal(computeSentiment("公司召開股東常會", "", lex).label, "中性");
  assert.equal(computeSentiment("公司召開股東常會", "", lex).score, 0);
}

function testSentimentNegationFlips() {
  const r = computeSentiment("法人對後市不看好", "", lex);
  assert.equal(r.label, "利空", "不看好 應為利空");
}

function testSentimentIntensifierScales() {
  const strong = computeSentiment("營收大幅成長", "", lex).score;
  const plain = computeSentiment("營收成長", "", lex).score;
  assert.ok(strong > plain, `大幅成長(${strong}) 應 > 成長(${plain})`);
}

function testSentimentOverlapNoDoubleCount() {
  const r = computeSentiment("創新高", "", lex);
  assert.ok(r.hits!.includes("創新高"));
  assert.ok(!r.hits!.includes("新高"), "創新高 不應同時計入子字串 新高");
}

function testSentimentTanhBounded() {
  const r = computeSentiment("創新高創新高成長看好", "創新高成長看好", lex);
  assert.ok(r.score <= 1 && r.score > 0, `score 應 ∈ (0,1]:${r.score}`);
  // 極強訊號仍有界(tanh 不會爆量)
  const huge = computeSentiment("創新高".repeat(20), "", lex);
  assert.ok(huge.score <= 1, `tanh 應有界:${huge.score}`);
}

function testSentimentTitleWeighting() {
  const inTitle = computeSentiment("成長", "", lex).score;
  const inSummary = computeSentiment("", "成長", lex).score;
  assert.ok(inTitle > inSummary, `標題加權:${inTitle} 應 > 摘要:${inSummary}`);
}

// ---- Wikilink 標籤 ----
const hub: WikiHubEntry[] = [
  { label: "台積電", slug: "台積電", count: 561 },
  { label: "台積", slug: "台積", count: 50 },
  { label: "AI", slug: "ai", count: 271 },
  { label: "台灣", slug: "台灣", count: 100 },
  { label: "CoWoS", slug: "cowos", count: 102 },
];

function testWikiBlocklistRejected() {
  const tags = tagWikilinks("台灣經濟前景", "", hub);
  assert.ok(!tags.some((t) => t.label === "台灣"), "台灣 應被 blocklist 擋下");
}

function testWikiLongestWinsDedup() {
  const tags = tagWikilinks("台積電宣布擴產", "", hub);
  assert.ok(tags.some((t) => t.label === "台積電"));
  assert.ok(!tags.some((t) => t.label === "台積"), "台積電 命中時不應再列子字串 台積");
}

function testWikiLatinBoundary() {
  assert.equal(
    tagWikilinks("請寄到我的email信箱", "", [{ label: "AI", slug: "ai", count: 271 }]).length,
    0,
    "AI 不應命中 email 內的 ai"
  );
  const ok = tagWikilinks("AI 伺服器需求強", "", [{ label: "AI", slug: "ai", count: 271 }]);
  assert.equal(ok.length, 1);
  assert.equal(ok[0].slug, "ai");
}

function testWikiCowosAndSlugPassthrough() {
  const tags = tagWikilinks("CoWoS 先進封裝產能滿載", "", hub);
  const c = tags.find((t) => t.label === "CoWoS");
  assert.ok(c, "CoWoS 應命中");
  assert.equal(c!.slug, "cowos");
}

function testWikiExcludeCompanies() {
  const tags = tagWikilinks(
    "台積電擴產 CoWoS",
    "",
    hub,
    5,
    new Set(["台積電", "台積"])
  );
  assert.ok(!tags.some((t) => t.label === "台積電"), "排除清單中的公司不應出現");
  assert.ok(tags.some((t) => t.label === "CoWoS"), "非公司題材 CoWoS 仍應出現");
}

// ---- 去重 / 事件聚類 ----
function mkArt(
  id: string,
  title: string,
  sourceId: string,
  published: string
): NlpArticleLike {
  return { id, title, summary: "", category: "台股", sourceId, published };
}

function testClusterCrossSourceMerge() {
  const arts = [
    mkArt("a", "台積電法說會釋出樂觀展望", "cnyes", "2026-06-25T01:00:00Z"),
    mkArt("b", "台積電法說會釋出樂觀展望", "yahoo", "2026-06-25T01:05:00Z"),
    mkArt("c", "散裝航運運價指數走勢分析報導", "udn", "2026-06-25T01:10:00Z"),
  ];
  const clusters = clusterArticles(arts);
  assert.equal(clusters.length, 1, "應有 1 個跨來源事件群");
  assert.equal(clusters[0].sourceCount, 2);
  assert.deepEqual(clusters[0].memberIds.slice().sort(), ["a", "b"]);
  assert.equal(clusters[0].primaryId, "a", "最早發布者為主篇");
  assert.equal(clusters[0].clusterId, "cl_a");
}

function testClusterSameSourceNotMerged() {
  const arts = [
    mkArt("a", "完全相同的標題內容測試一致", "cnyes", "2026-06-25T01:00:00Z"),
    mkArt("b", "完全相同的標題內容測試一致", "cnyes", "2026-06-25T01:05:00Z"),
  ];
  assert.equal(clusterArticles(arts).length, 0, "同來源不算跨來源事件群");
}

function testClusterDeterministic() {
  const arts = [
    mkArt("a", "台積電法說會釋出樂觀展望", "cnyes", "2026-06-25T01:00:00Z"),
    mkArt("b", "台積電法說會釋出樂觀展望", "yahoo", "2026-06-25T01:05:00Z"),
    mkArt("c", "聯發科手機晶片新品發表會登場", "udn", "2026-06-25T02:00:00Z"),
    mkArt("d", "聯發科手機晶片新品發表會登場", "ltn", "2026-06-25T02:03:00Z"),
  ];
  const a = JSON.stringify(clusterArticles(arts));
  const b = JSON.stringify(clusterArticles(arts));
  assert.equal(a, b, "聚類結果應具決定性");
}

// ---- 總成 ----
function testEnrichEndToEnd() {
  const arts = [
    mkArt("a", "台積電營收創新高，CoWoS 與 AI 需求強", "cnyes", "2026-06-25T01:00:00Z"),
  ];
  const r = enrichArticlesNlp(arts, {
    lexicon: lex,
    wikilinkEntries: hub,
    nameToTicker: { 台積電: "2330" },
    validTickers: new Set(["2330"]),
    themePayload: null,
  });
  assert.equal(r.byId["a"].sentiment.label, "利多");
  // 公司(台積電)應排除,改由相關行情顯示;題材 CoWoS/AI 保留
  assert.ok(
    !r.byId["a"].wikilinks.some((w) => w.label === "台積電"),
    "wikilink chips 不應含公司"
  );
  assert.ok(
    r.byId["a"].wikilinks.some((w) => w.label === "CoWoS" || w.label === "AI"),
    "應保留題材標籤"
  );
  assert.ok(r.tickerSentiment["2330"], "應仍彙總 2330 情緒(由公司名解析)");
  assert.equal(r.tickerSentiment["2330"].pos, 1);
}

testSentimentBasics();
testSentimentNegationFlips();
testSentimentIntensifierScales();
testSentimentOverlapNoDoubleCount();
testSentimentTanhBounded();
testSentimentTitleWeighting();
testWikiBlocklistRejected();
testWikiLongestWinsDedup();
testWikiLatinBoundary();
testWikiCowosAndSlugPassthrough();
testWikiExcludeCompanies();
testClusterCrossSourceMerge();
testClusterSameSourceNotMerged();
testClusterDeterministic();
testEnrichEndToEnd();

console.log("news-nlp (sentiment / wikilink / cluster / enrich): ok");
