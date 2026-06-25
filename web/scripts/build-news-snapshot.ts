/**
 * 產生新聞快照給 /news-digest 技能(由 Claude Code 生成每日簡報,無需 API 金鑰)。
 *   cd web && npx tsx scripts/build-news-snapshot.ts
 * 直接抓 8 來源 + 跑本地 NLP,輸出精簡快照到 web/news-snapshot.json(gitignored)。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchAllNews } from "../src/lib/news-sources.ts";
import { enrichArticlesNlp } from "../src/lib/news-nlp.ts";
import { loadNewsNlpDeps } from "../src/lib/news-nlp-data.ts";

const ART_LIMIT = 60;
const CLUSTER_LIMIT = 12;
const MOVER_LIMIT = 12;

function tickerNames(): Record<string, string> {
  try {
    const j = JSON.parse(
      readFileSync(join(process.cwd(), "public", "data", "reports-index.json"), "utf8")
    );
    const out: Record<string, string> = {};
    for (const [t, v] of Object.entries(j.byTicker || {})) {
      out[t] = (v as { name?: string }).name || t;
    }
    return out;
  } catch {
    return {};
  }
}

async function main() {
  const articles = await fetchAllNews();
  const nlp = enrichArticlesNlp(articles, loadNewsNlpDeps());
  const names = tickerNames();

  const counts = { 利多: 0, 中性: 0, 利空: 0 } as Record<string, number>;
  for (const a of articles) {
    const lab = nlp.byId[a.id]?.sentiment.label;
    if (lab) counts[lab] = (counts[lab] || 0) + 1;
  }

  const top = articles.slice(0, ART_LIMIT).map((a) => {
    const f = nlp.byId[a.id];
    return {
      id: a.id,
      t: a.title,
      s: (a.summary || "").slice(0, 140),
      cat: a.category,
      src: a.sourceId,
      sent: f ? f.sentiment.label : "中性",
      score: f ? f.sentiment.score : 0,
      wiki: f ? f.wikilinks.map((w) => w.label) : [],
      cl: f ? f.clusterId : null,
    };
  });

  const byId = new Map(articles.map((a) => [a.id, a]));
  const clusters = nlp.clusters.slice(0, CLUSTER_LIMIT).map((c) => ({
    clusterId: c.clusterId,
    sourceCount: c.sourceCount,
    primaryTitle: byId.get(c.primaryId)?.title || "",
    titles: c.memberIds.map((id) => byId.get(id)?.title || "").filter(Boolean),
  }));

  const movers = Object.values(nlp.tickerSentiment)
    .filter((m) => m.n >= 2)
    .map((m) => ({ ticker: m.ticker, name: names[m.ticker] || m.ticker, net: m.net, n: m.n }));
  const pos = movers.slice().sort((a, b) => b.net - a.net).slice(0, MOVER_LIMIT);
  const neg = movers.slice().sort((a, b) => a.net - b.net).slice(0, MOVER_LIMIT);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    total: articles.length,
    counts,
    articles: top,
    clusters,
    tickerMovers: { pos, neg },
  };

  const out = join(process.cwd(), "news-snapshot.json");
  writeFileSync(out, JSON.stringify(snapshot, null, 2), "utf8");
  console.log(
    `news-snapshot.json: ${articles.length} articles, ${nlp.clusters.length} clusters, ` +
      `sentiment ${JSON.stringify(counts)}, movers ${movers.length}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
