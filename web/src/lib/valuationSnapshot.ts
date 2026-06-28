/**
 * 伺服器端(build 時)讀取全市場估值快照 web/public/data/valuation-index.json,
 * 並以模組層快取,避免每個報告頁重複讀檔。供 report/[ticker].astro 使用。
 *
 * 快照由 scripts/build_valuation_snapshot.py 產生(TWSE/TPEx 官方 + Yahoo Beta),
 * 盤後在 CI(refresh-snapshots)刷新並提交。檔案缺失時回傳 null(報告頁顯示「—」)。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ValuationSnapshotRow {
  pe?: number | null;
  pb?: number | null;
  yield?: number | null;
  beta?: number | null;
}

let cache: Record<string, ValuationSnapshotRow> | null | undefined;

function load(): Record<string, ValuationSnapshotRow> | null {
  if (cache !== undefined) return cache;
  cache = null;
  try {
    const file = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../public/data/valuation-index.json",
    );
    if (existsSync(file)) {
      const j = JSON.parse(readFileSync(file, "utf8"));
      cache = (j && j.rows) || {};
    }
  } catch {
    cache = null;
  }
  return cache;
}

/** 取單檔估值快照;查無或檔案缺失回傳 null。 */
export function valuationSnapshotRow(ticker: string): ValuationSnapshotRow | null {
  const rows = load();
  return (rows && rows[ticker]) || null;
}
