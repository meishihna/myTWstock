/**
 * 伺服器端(build 時)讀取全市場籌碼面快照 web/public/data/chips-index.json,
 * 模組層快取。供 report/[ticker].astro → FinancialDashboard「籌碼面」分頁使用。
 *
 * 由 scripts/build_chips_snapshot.py 產生(TWSE T86 三大法人 + TWSE/TPEx 融資融券),
 * 盤後在 CI(refresh-snapshots)刷新並提交。檔案缺失或查無 → 回傳 null。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ChipsInst {
  foreign: number | null;
  trust: number | null;
  dealer: number | null;
  net3: number | null;
}
export interface ChipsMargin {
  bal: number | null;
  chg: number | null;
  shortBal: number | null;
  shortChg: number | null;
}
export interface ChipsRow {
  inst: ChipsInst | null;
  margin: ChipsMargin | null;
}

let cache: { rows: Record<string, ChipsRow>; instDate: string | null } | null | undefined;

function load() {
  if (cache !== undefined) return cache;
  cache = null;
  try {
    const file = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../public/data/chips-index.json",
    );
    if (existsSync(file)) {
      const j = JSON.parse(readFileSync(file, "utf8"));
      cache = { rows: (j && j.rows) || {}, instDate: (j && j.instDate) || null };
    }
  } catch {
    cache = null;
  }
  return cache;
}

/** 取單檔籌碼快照;查無或檔案缺失回傳 null。 */
export function chipsSnapshotRow(ticker: string): ChipsRow | null {
  const c = load();
  return (c && c.rows[ticker]) || null;
}

/** 三大法人資料所屬交易日(顯示用);無則 null。 */
export function chipsInstDate(): string | null {
  const c = load();
  return c ? c.instDate : null;
}
