/**
 * 依 reports-index.json + public/data/financials/*.json
 * 計算各產業「最近年度」營收與毛利率分位數（僅含已匯出 JSON 的檔案）。
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(__dirname, "..");
const IDX = path.join(WEB, "public", "data", "reports-index.json");
const FIN_DIR = path.join(WEB, "public", "data", "financials");
const OUT = path.join(WEB, "public", "data", "sector-stats.json");

function latestScalar(periods, series, key) {
  if (!periods?.length || !series?.[key]) return null;
  const arr = series[key];
  for (let i = periods.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v != null && Number.isFinite(v)) return { value: v, period: periods[i] };
  }
  return null;
}

function quantiles(sorted, ps) {
  const out = {};
  if (sorted.length === 0) return out;
  for (const p of ps) {
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    let v;
    if (lo === hi) v = sorted[lo];
    else v = sorted[lo] * (hi - idx) + sorted[hi] * (idx - lo);
    out[`p${Math.round(p * 100)}`] = Math.round(v * 100) / 100;
  }
  return out;
}

/** 在此產業營收樣本中，value 的百分位排名 0–100（高於多少 % 的樣本） */
function percentileRank(sortedAsc, value) {
  if (!sortedAsc.length || value == null) return null;
  let below = 0;
  for (const x of sortedAsc) {
    if (x < value) below += 1;
    else break;
  }
  return Math.round((below / sortedAsc.length) * 1000) / 10;
}

function main() {
  if (!existsSync(IDX)) {
    console.warn("[sector-stats] reports-index.json missing, skip");
    return;
  }
  const idx = JSON.parse(readFileSync(IDX, "utf8"));
  const byTicker = idx.byTicker || {};

  const sectorRevenues = {};
  const sectorMargins = {};

  if (!existsSync(FIN_DIR)) {
    console.warn("[sector-stats] financials/ empty — run python scripts/update_financials.py");
  } else {
    for (const name of readdirSync(FIN_DIR)) {
      if (!name.endsWith(".json")) continue;
      const ticker = name.replace(/\.json$/i, "");
      const meta = byTicker[ticker];
      if (!meta?.sector) continue;
      const sector = meta.sector;
      let data;
      try {
        data = JSON.parse(
          readFileSync(path.join(FIN_DIR, name), "utf8")
        );
      } catch {
        continue;
      }
      const ann = data.annual;
      if (!ann?.periods || !ann.series) continue;
      const rev = latestScalar(ann.periods, ann.series, "Revenue");
      if (rev) {
        if (!sectorRevenues[sector]) sectorRevenues[sector] = [];
        sectorRevenues[sector].push({ ticker, value: rev.value, period: rev.period });
      }
      const gm = latestScalar(ann.periods, ann.series, "Gross Margin (%)");
      if (gm) {
        if (!sectorMargins[sector]) sectorMargins[sector] = [];
        sectorMargins[sector].push({ ticker, value: gm.value, period: gm.period });
      }
    }
  }

  const sectors = {};
  const sectorNames = new Set([
    ...Object.keys(sectorRevenues),
    ...Object.keys(sectorMargins),
  ]);

  for (const sector of [...sectorNames].sort()) {
    const revList = sectorRevenues[sector] || [];
    const revVals = revList.map((r) => r.value).sort((a, b) => a - b);
    const gmList = sectorMargins[sector] || [];
    const gmVals = gmList.map((r) => r.value).sort((a, b) => a - b);
    sectors[sector] = {
      revenueLatest: {
        n: revVals.length,
        ...quantiles(revVals, [0.25, 0.5, 0.75]),
      },
      grossMarginLatest: {
        n: gmVals.length,
        ...quantiles(gmVals, [0.25, 0.5, 0.75]),
      },
      /** ticker -> 營收百分位排名（同產業內） */
      revenuePercentileRank: Object.fromEntries(
        revList.map((r) => [
          r.ticker,
          percentileRank(revVals, r.value),
        ])
      ),
    };
  }

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note:
          "Based on financials/*.json from update_financials.py; sparse if JSON not generated.",
        sectors,
      },
      null,
      2
    ),
    "utf8"
  );
  console.log("[sector-stats] wrote", OUT, "| sectors:", Object.keys(sectors).length);
}

main();
