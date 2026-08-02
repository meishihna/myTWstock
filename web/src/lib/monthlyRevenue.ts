/**
 * 官方月營收(MOPS t21)→ MonthlyRevenueBlock。
 *
 * 取代原本 financials_store/{ticker}.json 內由 FinMind 寫入的 monthlyRevenue 區塊。
 * 來源:公開資訊觀測站 t21 營業收入彙總表(上市+上櫃),免金鑰、0 個資。
 *
 * 契約(docs/financials-contract.md):
 *   官方檔【只存當月營收】,累計 / YoY / MoM 一律由消費端計算。
 *   null = 該月無揭露(不是 0)。
 */
import fs from "node:fs";
import path from "node:path";
import type { MonthlyRevenueBlock } from "./financialsJson";

type MonthlyRevenueFile = {
  schema: string;
  unit: string;
  updatedAt: string;
  /** "YYYY-MM",由舊到新 */
  months: string[];
  /** ticker → 與 months 等長的月營收陣列(百萬台幣;null = 無揭露) */
  rev: Record<string, (number | null)[]>;
};

let cache: MonthlyRevenueFile | null | undefined;

function load(): MonthlyRevenueFile | null {
  if (cache !== undefined) return cache;
  try {
    const p = path.join(process.cwd(), "public/data/monthly-revenue.json");
    cache = fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")) as MonthlyRevenueFile) : null;
  } catch {
    cache = null;
  }
  return cache;
}

/** 年增率 %:與去年同月比。任一邊為 null 或去年同月 <= 0 → null(避免除以 0 或負基期的假數字) */
function yoyOf(rev: (number | null)[], i: number): number | null {
  if (i < 12) return null;
  const cur = rev[i];
  const prev = rev[i - 12];
  if (cur == null || prev == null || prev <= 0) return null;
  return ((cur - prev) / prev) * 100;
}

/**
 * 今年累計(年初至該月)。跨年重置。
 * 該年度內只要有任一月為 null,累計即為 null —— 不可把缺漏當 0,否則累計會低估而看不出來。
 */
function cumOf(months: string[], rev: (number | null)[], i: number): number | null {
  const year = months[i]!.slice(0, 4);
  let sum = 0;
  for (let k = i; k >= 0 && months[k]!.slice(0, 4) === year; k--) {
    const v = rev[k];
    if (v == null) return null;
    sum += v;
  }
  return sum;
}

/**
 * 取單一個股的月營收區塊;查無 → null。
 * @param limit 只取最後 N 期(預設全部)
 */
export function getMonthlyRevenue(ticker: string, limit?: number): MonthlyRevenueBlock | null {
  const f = load();
  const raw = f?.rev?.[ticker];
  if (!f || !raw || !raw.length) return null;

  const months = f.months;
  const yoy = raw.map((_, i) => yoyOf(raw, i));
  const cum = raw.map((_, i) => cumOf(months, raw, i));
  const cumYoy = cum.map((c, i) => {
    if (i < 12) return null;
    const prev = cum[i - 12];
    if (c == null || prev == null || prev <= 0) return null;
    return ((c - prev) / prev) * 100;
  });

  const from = limit && limit > 0 ? Math.max(0, months.length - limit) : 0;
  return {
    periods: months.slice(from),
    revenue: raw.slice(from),
    yoy: yoy.slice(from),
    cum: cum.slice(from),
    cumYoy: cumYoy.slice(from),
    updatedAt: f.updatedAt,
  };
}

/** 資料涵蓋的個股數與期別範圍,供稽核用 */
export function monthlyRevenueMeta(): { count: number; months: string[]; updatedAt: string } | null {
  const f = load();
  if (!f) return null;
  return { count: Object.keys(f.rev).length, months: f.months, updatedAt: f.updatedAt };
}
