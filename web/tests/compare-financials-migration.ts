/**
 * compare-financials-migration.ts — 報告頁財務遷移的【前後對照】硬門檻。
 *
 * 規則:對全部報告個股逐檔逐欄比對「有值格數」,
 *       🔴【任一欄任一檔由有值變空白 → FAIL】。反向(空白變有值)只記錄不擋。
 *
 * 為什麼要腳本:上一輪 screener 遷移時,revYoy 悄悄少了 8 檔(3717/6015/6021 …),
 * 目測與抽樣都沒看出來,是逐檔比對才抓到的。
 *
 * 用法(一律在 web/ 目錄下跑,因為兩個資料來源都以 process.cwd() 為基準):
 *   npx tsx tests/compare-financials-migration.ts --mode current --out before.json
 *   npx tsx tests/compare-financials-migration.ts --mode adapter --out after.json
 *   npx tsx tests/compare-financials-migration.ts --compare before.json after.json
 */
import fs from "node:fs";
import path from "node:path";
import { adaptFinancials, loadStore } from "../src/lib/financialsAdapter";
import type { FinancialsJson, FinancialsJsonBlock } from "../src/lib/financialsJson";

const SERIES_KEYS = [
  "Revenue",
  "Cost of Revenue",
  "Gross Profit",
  "Gross Margin (%)",
  "Selling & Marketing Exp",
  "R&D Exp",
  "General & Admin Exp",
  "Operating Expenses",
  "Operating Income",
  "Operating Margin (%)",
  "Net Income",
  "Net Margin (%)",
  "EPS",
  "Op Cash Flow",
  "Investing Cash Flow",
  "Financing Cash Flow",
  "CAPEX",
] as const;

const SCALAR_KEYS = [
  "marketCap",
  "enterpriseValue",
  "industryType",
  "exchange",
  "listingStatus",
  "valuation.ROE",
  "valuation.Debt/Equity",
] as const;

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function countFinite(block: FinancialsJsonBlock | null | undefined, key: string): number {
  const a = block?.series?.[key];
  return Array.isArray(a) ? a.filter(fin).length : 0;
}

/** 與 financialDashboard.ts 的 showFinancialDashboard 同一條件(刻意複製,避免相依漂移) */
function dashboardShown(j: FinancialsJson | null): boolean {
  if (!j?.annual?.periods?.length) return false;
  const n = j.annual.periods.length;
  const rev = j.annual.series?.Revenue;
  return Array.isArray(rev) && rev.length === n && n >= 2;
}

/** 與 bestQuarterlyBlock 同一條件:季報 Tab 要營收+淨利對齊期數 */
function quarterlyShown(j: FinancialsJson | null): boolean {
  for (const b of [j?.quarterlyCore, j?.quarterly]) {
    const n = b?.periods?.length ?? 0;
    if (!n || !b?.series) continue;
    if (
      ["Revenue", "Net Income"].every(
        (k) => Array.isArray(b.series![k]) && b.series![k]!.length === n
      )
    )
      return true;
  }
  return false;
}

type Record1 = {
  a: Record<string, number>;
  q: Record<string, number>;
  y: Record<string, number>;
  s: Record<string, number>;
  dash: number;
  qtab: number;
};

function snapshotOf(j: FinancialsJson | null): Record1 {
  const a: Record<string, number> = {};
  const q: Record<string, number> = {};
  const y: Record<string, number> = {};
  for (const k of SERIES_KEYS) {
    a[k] = countFinite(j?.annual, k);
    q[k] = countFinite(j?.quarterly ?? j?.quarterlyCore, k);
    y[k] = countFinite(j?.quarterlyYtd, k);
  }
  const jr = (j ?? {}) as Record<string, unknown>;
  const s: Record<string, number> = {
    marketCap: fin(j?.marketCap) ? 1 : 0,
    enterpriseValue: fin(j?.enterpriseValue) ? 1 : 0,
    industryType: j?.industryType ? 1 : 0,
    exchange: typeof jr.exchange === "string" && jr.exchange ? 1 : 0,
    listingStatus: j?.listingStatus ? 1 : 0,
    "valuation.ROE": fin(j?.valuation?.ROE) ? 1 : 0,
    "valuation.Debt/Equity": fin(j?.valuation?.["Debt/Equity"]) ? 1 : 0,
  };
  return { a, q, y, s, dash: dashboardShown(j) ? 1 : 0, qtab: quarterlyShown(j) ? 1 : 0 };
}

function reportTickers(): string[] {
  const p = path.join(process.cwd(), "public/data/reports-index.json");
  const idx = JSON.parse(fs.readFileSync(p, "utf8"));
  return Object.keys(idx.byTicker ?? {})
    .filter((t) => /^\d{4}$/.test(t))
    .sort();
}

function pbMap(): Record<string, number | null> {
  try {
    const p = path.join(process.cwd(), "public/data/valuation-index.json");
    const rows = JSON.parse(fs.readFileSync(p, "utf8")).rows ?? {};
    const out: Record<string, number | null> = {};
    for (const [t, r] of Object.entries(rows as Record<string, { pb?: number | null }>)) {
      out[t] = fin(r?.pb) ? r.pb! : null;
    }
    return out;
  } catch {
    return {};
  }
}

function build(mode: "current" | "adapter") {
  const tickers = reportTickers();
  const pb = mode === "adapter" ? pbMap() : {};
  const rows: Record<string, Record1> = {};
  for (const t of tickers) {
    if (mode === "current") {
      // 現況:報告頁只吃 store 形狀(官方新格式在下游會讀到 undefined,已被形狀檢查擋掉)
      const j = loadStore(t);
      if (j) (j as Record<string, unknown>).exchange = (j as Record<string, unknown>).exchange;
      rows[t] = snapshotOf(j);
    } else {
      rows[t] = snapshotOf(adaptFinancials(t, { pb: pb[t] ?? null }).json);
    }
  }
  return { mode, generatedAt: new Date().toISOString(), count: tickers.length, rows };
}

function compare(beforeFile: string, afterFile: string): number {
  const B = JSON.parse(fs.readFileSync(beforeFile, "utf8"));
  const A = JSON.parse(fs.readFileSync(afterFile, "utf8"));
  const tickers = Object.keys(B.rows);
  type Reg = { field: string; ticker: string; before: number; after: number };
  const regressions: Reg[] = [];
  const gains = new Map<string, number>();
  const totals = new Map<string, { before: number; after: number }>();

  const bump = (field: string, b: number, a: number, t: string) => {
    const cur = totals.get(field) ?? { before: 0, after: 0 };
    cur.before += b;
    cur.after += a;
    totals.set(field, cur);
    if (a < b) regressions.push({ field, ticker: t, before: b, after: a });
    else if (a > b) gains.set(field, (gains.get(field) ?? 0) + 1);
  };

  for (const t of tickers) {
    const b = B.rows[t];
    const a = A.rows[t];
    if (!a) {
      regressions.push({ field: "(整檔消失)", ticker: t, before: 1, after: 0 });
      continue;
    }
    for (const scope of ["a", "q", "y"] as const) {
      for (const k of Object.keys(b[scope])) {
        bump(`${scope}:${k}`, b[scope][k] ?? 0, a[scope][k] ?? 0, t);
      }
    }
    for (const k of Object.keys(b.s)) bump(`scalar:${k}`, b.s[k] ?? 0, a.s[k] ?? 0, t);
    bump("view:財務儀表板", b.dash, a.dash, t);
    bump("view:季報Tab", b.qtab, a.qtab, t);
  }

  console.log(`個股數 before=${tickers.length} after=${Object.keys(A.rows).length}\n`);
  console.log("欄位".padEnd(34), "before".padStart(9), "after".padStart(9), "  變化");
  console.log("-".repeat(72));
  for (const [f, v] of [...totals].sort()) {
    const d = v.after - v.before;
    const mark = d === 0 ? "" : d > 0 ? `  ▲ +${d}` : `  ▼ ${d}`;
    console.log(f.padEnd(34), String(v.before).padStart(9), String(v.after).padStart(9), mark);
  }

  if (regressions.length === 0) {
    console.log("\n✅ PASS:沒有任何欄位在任何個股上由有值變空白");
    return 0;
  }
  const byField = new Map<string, Reg[]>();
  for (const r of regressions) {
    if (!byField.has(r.field)) byField.set(r.field, []);
    byField.get(r.field)!.push(r);
  }
  console.error(`\n❌ FAIL:${regressions.length} 處退化(有值 → 空白/變少)`);
  for (const [f, list] of [...byField].sort()) {
    console.error(`\n  ${f}  —— ${list.length} 檔`);
    for (const r of list.slice(0, 12)) {
      console.error(`      ${r.ticker}: ${r.before} → ${r.after}`);
    }
    if (list.length > 12) console.error(`      …其餘 ${list.length - 12} 檔`);
  }
  return 1;
}

// ── CLI ──
const argv = process.argv.slice(2);
const argOf = (name: string): string | null => {
  const i = argv.indexOf(name);
  // ⚠️ indexOf 回 -1 時 argv[0] 會被誤當成值(踩過:ASOF 變成旗標字串,空跑卻報數字)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
};

const cmpI = argv.indexOf("--compare");
if (cmpI >= 0) {
  const a = argv[cmpI + 1];
  const b = argv[cmpI + 2];
  if (!a || !b) {
    console.error("用法:--compare <before.json> <after.json>");
    process.exit(2);
  }
  process.exit(compare(a, b));
}

const modeArg = argOf("--mode");
const mode: "current" | "adapter" | null =
  modeArg === "current" || modeArg === "adapter" ? modeArg : null;
if (mode == null) {
  console.error("用法:--mode current|adapter [--out <file>]");
  process.exit(2);
  throw new Error("unreachable"); // 沒有 @types/node,TS 不知道 process.exit 是 never
}
const out = argOf("--out") ?? `fin-snapshot-${mode}.json`;
const payload = build(mode);
fs.writeFileSync(out, JSON.stringify(payload), "utf8");
const nonEmpty = Object.values(payload.rows).filter((r) => r.dash === 1).length;
console.log(
  `[${mode}] ${payload.count} 檔 → ${out}(財務儀表板可顯示 ${nonEmpty} 檔)`
);
