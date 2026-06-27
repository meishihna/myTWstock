/**
 * build-heatmap-stats.mjs — 熱力圖用「成交額 + 漲跌%」快照(日/週/月)。
 *
 * 對所有題材成分股(map-index 的聯集)抓 yahoo 歷史日線(~45 天),計算:
 *   d(單日) / w(近5交易日) / m(近20交易日) 的:
 *     c = 區間漲跌%(最新收盤 vs 區間起點收盤)
 *     t = 區間成交額(Σ 收盤×成交量,單位:億台幣)
 * 熱力圖磚塊大小依 t、顏色依 c;日/週/月 由前端切換。
 *
 * 輸出 web/public/data/heatmap-stats.json
 *   { generatedAt, stats: { [ticker]: { d:[c,t], w:[c,t], m:[c,t] } } }
 *
 * 需 yahoo 網路;放在 CI refresh-snapshots(盤後)跑,與 top-movers 同性質。
 * 須在 build-map-index.mjs 之後(讀其成分股)。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YahooFinance from "yahoo-finance2";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(__dirname, "..");
const DATA = path.join(WEB, "public", "data");
const MAP = path.join(DATA, "map-index.json");
const IND = path.join(DATA, "industries-index.json");
const OUT = path.join(DATA, "heatmap-stats.json");

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const CONCURRENCY = 8;
const LOOKBACK_DAYS = 48;
const r2 = (n) => Math.round(n * 100) / 100;
const r1 = (n) => Math.round(n * 10) / 10;

function universe() {
  const s = new Set();
  const add = (file, listKey) => {
    if (!existsSync(file)) return;
    const d = JSON.parse(readFileSync(file, "utf8"));
    for (const t of d[listKey] || []) {
      for (const k of ["u", "m", "d"]) for (const c of t.tiers?.[k] || []) {
        if (/^\d{4}$/.test(c.t)) s.add(c.t);
      }
    }
  };
  add(MAP, "themes"); // /map 投資題材成分股
  add(IND, "industries"); // 產業 section TPEx 產業鏈成分股
  if (s.size === 0) console.warn("[heatmap-stats] map/industries index missing, skip");
  return [...s];
}

// 取一檔歷史日線(close, volume);先試 .TW 再試 .TWO
async function fetchRows(ticker, period1, period2) {
  for (const sym of [`${ticker}.TW`, `${ticker}.TWO`]) {
    try {
      const r = await yf.chart(sym, { period1, period2, interval: "1d" });
      const q = (r && r.quotes) || [];
      const rows = q
        .filter((x) => Number.isFinite(x.close) && Number.isFinite(x.volume) && x.close > 0)
        .map((x) => ({ close: x.close, tov: (x.close * x.volume) / 1e8 })); // 億台幣
      if (rows.length >= 2) return rows;
    } catch {
      /* try next suffix */
    }
  }
  return null;
}

// 由日線算 d/w/m 的 [漲跌%, 成交額(億)]
function computeStats(rows) {
  const n = rows.length;
  const last = rows[n - 1].close;
  const span = (back) => {
    const i = Math.max(0, n - 1 - back);
    const base = rows[i].close;
    const c = base > 0 ? r2((last / base - 1) * 100) : null;
    const t = r1(rows.slice(i + 1).reduce((s, x) => s + x.tov, 0) || rows[n - 1].tov);
    return [c, t];
  };
  return {
    d: [r2((last / rows[n - 2].close - 1) * 100), r1(rows[n - 1].tov)],
    w: span(5),
    m: span(20),
  };
}

async function runPool(items, worker) {
  let i = 0, done = 0;
  const out = {};
  async function next() {
    while (i < items.length) {
      const idx = i++;
      const tk = items[idx];
      const res = await worker(tk);
      if (res) out[tk] = res;
      done++;
      if (done % 100 === 0) console.log(`[heatmap-stats] ${done}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, next));
  return out;
}

async function main() {
  const tickers = universe();
  if (tickers.length === 0) return;
  console.log(`[heatmap-stats] fetching ${tickers.length} tickers…`);
  const period2 = new Date();
  const period1 = new Date(Date.now() - LOOKBACK_DAYS * 864e5);

  const stats = await runPool(tickers, async (tk) => {
    const rows = await fetchRows(tk, period1, period2);
    if (!rows) return null;
    try {
      return computeStats(rows);
    } catch {
      return null;
    }
  });

  mkdirSync(DATA, { recursive: true });
  writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), stats }), "utf8");
  console.log(`[heatmap-stats] wrote ${Object.keys(stats).length}/${tickers.length} ->`, OUT);
}

main();
