/**
 * 產生「今日熱門題材」資料(純數值、免 API 金鑰):
 *   抓 8 來源新聞 → 本地 NLP 得 tickerSentiment → 依 map-index 的題材成分股彙整出
 *   每題材 mentions / 情緒分 / 聲量分 / heatBase,寫 public/data/today-themes.json(追蹤入庫)。
 *   執行:cd web && npx tsx scripts/build-today-themes.ts
 *   runtime(首頁 / /themes)再疊加即時報價算出最終 heat 與漲跌。
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchAllNews } from "../src/lib/news-sources.ts";
import { enrichArticlesNlp } from "../src/lib/news-nlp.ts";
import { loadNewsNlpDeps } from "../src/lib/news-nlp-data.ts";

const DATA = join(process.cwd(), "public", "data");
const OUT = join(DATA, "today-themes.json");
const TOP_CONS = 8;
const MIN_KEEP = 6;

type MapCo = { t: string; n: string; mc: number | null };
type MapTheme = {
  slug: string;
  title: string;
  companyCount: number;
  tiers: { u: MapCo[]; m: MapCo[]; d: MapCo[] };
};

async function main() {
  const mapPath = join(DATA, "map-index.json");
  if (!existsSync(mapPath)) {
    console.error("map-index.json missing — run `node scripts/build-data.mjs` first");
    process.exit(1);
  }
  const themes = (JSON.parse(readFileSync(mapPath, "utf8")).themes || []) as MapTheme[];

  const articles = await fetchAllNews();
  const nlp = enrichArticlesNlp(articles, loadNewsNlpDeps());
  const ts = nlp.tickerSentiment;

  const rows = themes.map((th) => {
    const seen = new Set<string>();
    const cons: MapCo[] = [];
    for (const k of ["u", "m", "d"] as const) {
      for (const c of th.tiers[k]) {
        if (seen.has(c.t)) continue;
        seen.add(c.t);
        cons.push(c);
      }
    }

    let mentions = 0,
      wnet = 0;
    for (const c of cons) {
      const s = ts[c.t];
      if (!s) continue;
      mentions += s.n;
      wnet += s.n * s.net;
    }
    const rawSent = mentions > 0 ? wnet / mentions : 0; // -1..1
    const sentScore = Math.round(100 * rawSent * Math.tanh(mentions / 6));
    const volScore = Math.round(100 * Math.tanh(mentions / 8));
    const heatBase = Math.round(0.6 * sentScore + 0.4 * volScore);
    const tone = sentScore >= 15 ? "利多" : sentScore <= -15 ? "利空" : "中性";

    const topCons = cons
      .slice()
      .sort((a, b) => (b.mc ?? -1) - (a.mc ?? -1))
      .slice(0, TOP_CONS)
      .map((c) => ({ t: c.t, n: c.n, mc: c.mc }));

    return {
      slug: th.slug,
      title: th.title,
      companyCount: th.companyCount,
      mentions,
      sentScore,
      volScore,
      heatBase,
      tone,
      cons: topCons,
    };
  });

  let kept = rows.filter((r) => r.mentions >= 1).sort((a, b) => b.heatBase - a.heatBase);
  const withNews = kept.length;
  if (kept.length < MIN_KEEP) {
    const extra = rows
      .filter((r) => r.mentions < 1)
      .sort((a, b) => b.companyCount - a.companyCount)
      .slice(0, MIN_KEEP - kept.length);
    kept = kept.concat(extra);
  }

  const payload = { generatedAt: new Date().toISOString(), themes: kept };
  const tmp = `${OUT}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload), "utf8");
  if (existsSync(OUT)) unlinkSync(OUT);
  renameSync(tmp, OUT);
  console.log(
    `today-themes.json: ${kept.length} themes (with news: ${withNews}), from ${articles.length} articles`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
