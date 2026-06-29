/**
 * 伺服器端(build 時)讀取籌碼面走勢 web/public/data/chips-history.json,模組層快取,
 * 取出「單一個股」的序列供報告頁嵌入(走勢圖用)。
 *
 * 由 scripts/build_chips_history.py 產生(三大法人日序列 + 大戶週序列);股價不在此檔,
 * 前端畫圖時另抓 /api/bars/[ticker]。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface ChipsHistory {
  inst:
    | {
        dates: string[];
        foreign: (number | null)[]; // 外資買賣超
        trust: (number | null)[]; // 投信
        dealer: (number | null)[]; // 自營
        net3: (number | null)[]; // 三大法人合計
      }
    | null;
  holdPct: (number | null)[] | null; // 外資持股比率(%),對齊 inst.dates
  holders: { dates: string[]; k1000: (number | null)[]; k400: (number | null)[] } | null;
}

let cache: any | null | undefined;

function load(): any {
  if (cache !== undefined) return cache;
  cache = null;
  try {
    // 以 process.cwd()(=web/)為錨;build 後 import.meta.url 會指向 dist/ 而錯位(與報告頁一致)。
    const file = path.join(process.cwd(), "public", "data", "chips-history.json");
    if (existsSync(file)) cache = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    cache = null;
  }
  return cache;
}

/** 取單檔的三大法人日序列 + 大戶週序列;皆無 → null。 */
export function chipsHistoryForTicker(ticker: string): ChipsHistory | null {
  const j = load();
  if (!j) return null;
  const ir = j.inst?.rows?.[ticker];
  const inst =
    ir && j.inst?.dates
      ? {
          dates: j.inst.dates as string[],
          foreign: ir.f as (number | null)[],
          trust: ir.t as (number | null)[],
          dealer: ir.d as (number | null)[],
          net3: ir.n as (number | null)[],
        }
      : null;
  const holdPct = (j.foreignHold?.rows?.[ticker] as (number | null)[]) || null;
  const hRow = j.holders?.rows?.[ticker];
  const holders =
    hRow && j.holders?.dates
      ? { dates: j.holders.dates as string[], k1000: hRow.k1000, k400: hRow.k400 }
      : null;
  if (!inst && !holders) return null;
  return { inst, holdPct, holders };
}
