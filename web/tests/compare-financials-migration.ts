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

/**
 * ══════════════════════════════════════════════════════════════════════════
 * 豁免規則:該期【營收 ≤ 0】時,比率欄留白【不計入退化】
 *
 * 比率 = X ÷ 營收。營收 ≤ 0 時算出來的不是資訊,是數學殘骸:
 *   實例 6901 鑽石投資 2023:rev = −2,439.518、gp 完全等於 rev(投資公司無營業成本)
 *   → 毛利率恆為 100%;而 op = −2,601.75 比 rev 還負 → 營業利益率 106.6%。
 *   一家年營收 −24 億的公司顯示「毛利率 100%、營業利益率 106%」—— 留白比它誠實。
 * 因此 officialFinancials.ts 的 ratioSeries() 對【分母 ≤ 0】一律回 null,這是刻意的。
 *
 * 🔴 這是【資料性質】的豁免,所以寫成可推導的規則,不是具名 6901 的清單 ——
 *    下一家公司變負營收時不會再響一次,也不會有人為了讓它變綠而放寬門檻。
 *    規模:全市場負營收 65 格 / 32 檔、零營收 66 格(故規則涵蓋 ≤ 0 兩種)。
 *    對照:若例外是【世界的一次性事實】(如 4130 離開官方涵蓋),才用具名清單 + 證據 + 日期。
 *
 * 🔴 豁免必須【可見】且【可證偽】:
 *    ① 單獨列出並計數,不讓它靜靜消失 —— 豁免看不見就會變成後門
 *    ② 每一格豁免都要回【交付檔】重新推導 rev ≤ 0 的期數來驗證,不信任快照裡的數字。
 *       快照宣稱的豁免數 > 交付檔實際的 rev ≤ 0 期數 → 硬失敗(假豁免)。
 * ══════════════════════════════════════════════════════════════════════════ */
const RATIO_FIELDS = new Set(["Gross Margin (%)", "Operating Margin (%)", "Net Margin (%)"]);

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
  /**
   * 各軸「營收 ≤ 0」的【期別清單】—— 比率欄留白的合法上限(見上方豁免規則)。
   * 存期別而非只存個數:個數無法被否證,期別才能拿去交付檔逐格核對。
   */
  exempt: { a: string[]; q: string[]; y: string[] };
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
  const nonPositiveRev = (blk: FinancialsJsonBlock | null | undefined): string[] => {
    const rev = blk?.series?.Revenue;
    const ps = blk?.periods;
    if (!Array.isArray(rev) || !Array.isArray(ps)) return [];
    const out: string[] = [];
    for (let i = 0; i < rev.length && i < ps.length; i++) {
      if (fin(rev[i]) && (rev[i] as number) <= 0) out.push(String(ps[i]));
    }
    return out;
  };
  const exempt = {
    a: nonPositiveRev(j?.annual),
    q: nonPositiveRev(j?.quarterly ?? j?.quarterlyCore),
    y: nonPositiveRev(j?.quarterlyYtd),
  };
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
  return { a, q, y, s, exempt, dash: dashboardShown(j) ? 1 : 0, qtab: quarterlyShown(j) ? 1 : 0 };
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

/**
 * 從【交付檔】(public/data/financials/{ticker}.json)獨立重新推導各軸的營收。
 * 🔴 不讀快照裡的 exempt —— 那是被檢查的對象,拿它證明自己等於沒檢查。
 * 回 null = 交付檔不存在/無 rev 欄 → 該檔的豁免一律無法證明。
 */
function officialRevByScope(
  ticker: string
): { a: Map<string, number>; q: Map<string, number>; y: Map<string, number> } | null {
  const p = path.join(process.cwd(), "public/data/financials", `${ticker}.json`);
  if (!fs.existsSync(p)) return null;
  let j: {
    fields?: string[];
    annual?: { p?: string[]; v?: (number | null)[][] };
    quarters?: { p?: string[]; v?: (number | null)[][] };
  };
  try {
    j = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
  const i = (j.fields ?? []).indexOf("rev");
  if (i < 0) return null;
  const toMap = (blk?: { p?: string[]; v?: (number | null)[][] }) => {
    const m = new Map<string, number>();
    const ps = blk?.p ?? [];
    const vs = blk?.v ?? [];
    for (let k = 0; k < ps.length && k < vs.length; k++) {
      const v = vs[k]?.[i];
      if (fin(v)) m.set(String(ps[k]), v);
    }
    return m;
  };
  const q = toMap(j.quarters);
  // YTD = 同年度自 Q1 起累計。缺任一前置季 → 不放進 map(寧可判「無法證明」也不猜)
  const y = new Map<string, number>();
  for (const [period, _v] of q) {
    const m = period.match(/^(\d{4})Q([1-4])$/);
    if (!m) continue;
    let sum = 0;
    let ok = true;
    for (let s = 1; s <= Number(m[2]); s++) {
      const cell = q.get(`${m[1]}Q${s}`);
      if (cell == null) { ok = false; break; }
      sum += cell;
    }
    if (ok) y.set(period, sum);
  }
  return { a: toMap(j.annual), q, y };
}

/**
 * 快照的期別是 ISO 日期(`2023-12-31`),交付檔是 `2023` / `2023Q4` —— 兩邊要對上才能逐格核。
 * 只做【純語法】的年/季換算,不含任何數值假設;月份不落在 3/6/9/12 時回 null,
 * 讓它誠實地變成「無法證明」而不是猜一個最近的季。
 * (第一版沒做這層,25 格合法豁免全被判成假豁免 —— 斷言先抓到的是我自己的驗證碼。)
 */
function normalizePeriod(scope: "a" | "q" | "y", p: string): string | null {
  if (/^\d{4}$/.test(p)) return scope === "a" ? p : null;
  if (/^\d{4}Q[1-4]$/.test(p)) return scope === "a" ? null : p;
  const m = p.match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) return null;
  if (scope === "a") return m[1]!;
  const q = { "03": 1, "06": 2, "09": 3, "12": 4 }[m[2]!];
  return q ? `${m[1]}Q${q}` : null;
}

function compare(beforeFile: string, afterFile: string): number {
  const B = JSON.parse(fs.readFileSync(beforeFile, "utf8"));
  const A = JSON.parse(fs.readFileSync(afterFile, "utf8"));
  const tickers = Object.keys(B.rows);
  type Reg = { field: string; ticker: string; before: number; after: number };
  const regressions: Reg[] = [];
  const gains = new Map<string, number>();
  const totals = new Map<string, { before: number; after: number }>();
  /** 豁免必須看得見:逐檔逐欄記下,最後單獨列出並計數 */
  const exempted: { field: string; ticker: string; cells: number; periods: string[] }[] = [];

  const bump = (field: string, b: number, a: number, t: string, scope?: "a" | "q" | "y") => {
    const cur = totals.get(field) ?? { before: 0, after: 0 };
    cur.before += b;
    cur.after += a;
    totals.set(field, cur);
    if (a < b) {
      const key = field.slice(field.indexOf(":") + 1);
      const periods: string[] = (scope && A.rows[t]?.exempt?.[scope]) || [];
      if (RATIO_FIELDS.has(key) && periods.length >= b - a) {
        // 豁免:該期營收 ≤ 0,比率留白是正確行為(ratioSeries 刻意回 null)
        exempted.push({ field, ticker: t, cells: b - a, periods });
        return;
      }
      regressions.push({ field, ticker: t, before: b, after: a });
    } else if (a > b) gains.set(field, (gains.get(field) ?? 0) + 1);
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
        bump(`${scope}:${k}`, b[scope][k] ?? 0, a[scope][k] ?? 0, t, scope);
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

  /* ── 豁免:單獨列出、計數,並【逐格】回交付檔驗證 ─────────────────────── */
  let fakeExempt = 0;
  if (exempted.length) {
    const codes = [...new Set(exempted.map((e) => e.ticker))].sort();
    const cells = exempted.reduce((n, e) => n + e.cells, 0);
    console.log(
      `\n因【該期營收 ≤ 0】豁免:${cells} 格 / ${codes.length} 檔` +
        `(比率欄留白;officialFinancials.ratioSeries 對分母 ≤ 0 刻意回 null)`
    );
    for (const e of [...exempted].sort((x, y) => x.ticker.localeCompare(y.ticker) || x.field.localeCompare(y.field))) {
      console.log(`    ${e.ticker}  ${e.field.padEnd(26)} ${e.cells} 格  [${e.periods.join(", ")}]`);
    }
    // 斷言:每一格豁免的該期 rev 必須【真的】≤ 0,且證據來自交付檔而非清單自述
    const bad: string[] = [];
    for (const t of codes) {
      const off = officialRevByScope(t);
      if (!off) {
        bad.push(`${t}  交付檔讀不到 → 豁免無法證明`);
        continue;
      }
      for (const scope of ["a", "q", "y"] as const) {
        for (const raw of (A.rows[t]?.exempt?.[scope] ?? []) as string[]) {
          const p = normalizePeriod(scope, raw);
          if (p == null) {
            bad.push(`${t} ${scope}:${raw}  期別無法對應到交付檔的年/季 → 無法證明`);
            continue;
          }
          const rev = off[scope].get(p);
          if (rev == null) bad.push(`${t} ${scope}:${raw}(=${p})  交付檔無此期別的 rev → 無法證明`);
          else if (!(rev <= 0)) bad.push(`${t} ${scope}:${raw}(=${p})  交付檔 rev=${rev} > 0 → 假豁免`);
        }
      }
    }
    if (bad.length) {
      fakeExempt = bad.length;
      console.error(`\n❌ 假豁免:${bad.length} 格宣稱豁免,但交付檔不支持`);
      for (const s of bad.slice(0, 20)) console.error(`      ${s}`);
      if (bad.length > 20) console.error(`      …其餘 ${bad.length - 20} 格`);
    } else {
      console.log(`    ✓ 上列每一格都已回交付檔 public/data/financials/*.json 重新推導 rev 驗證,無假豁免`);
    }
  }

  if (regressions.length === 0 && fakeExempt === 0) {
    console.log(
      "\n✅ PASS:沒有任何欄位在任何個股上由有值變空白" +
        (exempted.length ? "(不含上列已逐格驗證的 rev ≤ 0 豁免)" : "")
    );
    return 0;
  }
  if (regressions.length === 0) return 1;
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

/**
 * 豁免規則的自我驗證(注入 + 對照)。
 *
 * 🔴 只證明「合法豁免會被放行」是不夠的 —— 那條路徑永遠回綠,無法區分
 *    「規則有效」與「規則把所有退化都吞掉」。因此四個注入案例各封死一種失效模式:
 *      注入① 假豁免(該期營收其實 > 0)            → 必須被抓
 *      注入② 期別根本不在交付檔                    → 必須被抓(不能因查無而預設通過)
 *      注入③ 退化格數超過豁免額度                  → 超出的部分照樣算退化
 *      注入④ 非比率欄(營收本身)不得享有豁免      → 照樣算退化
 *    對照組則證明規則不是「一律紅」。
 */
function selfTestExempt(): number {
  const dir = path.join(process.cwd(), "node_modules/.cache");
  fs.mkdirSync(dir, { recursive: true });
  const bf = path.join(dir, "fin-selftest-before.json");
  const af = path.join(dir, "fin-selftest-after.json");

  const blank = (): Record<string, number> =>
    Object.fromEntries(SERIES_KEYS.map((k) => [k, 0])) as Record<string, number>;
  const scalars = Object.fromEntries(SCALAR_KEYS.map((k) => [k, 1])) as Record<string, number>;
  const row = (
    field: string,
    n: number,
    exemptPeriods: string[] = [],
    scope: "a" | "q" | "y" = "a"
  ): Record1 => {
    const blocks = { a: blank(), q: blank(), y: blank() };
    blocks[scope][field] = n;
    return {
      ...blocks,
      s: { ...scalars },
      dash: 1,
      qtab: 1,
      exempt: { a: [], q: [], y: [], [scope]: exemptPeriods },
    };
  };

  const GM = "Gross Margin (%)";
  /**
   * 期別一律用【快照真正的形狀】ISO 日期,才會走到 normalizePeriod ——
   * 用交付檔形狀(`2023`)寫自我驗證等於繞過那層,而那層正是第一次跑就出錯的地方。
   * 6901 鑽石投資:交付檔年度 rev 2023/2024/2025 皆 < 0(真實資料,非捏造)
   */
  const NEG = ["2023-12-31", "2024-12-31", "2025-12-31"];
  /** 6901 季:2024 四季 rev 全 < 0;YTD 同期累計亦 < 0 */
  const NEGQ = ["2024-03-31", "2024-06-30", "2024-09-30"];
  /** 2330:交付檔年度 rev 全為正 */
  const POS = ["2024-12-31", "2023-12-31"];

  const cases: { name: string; b: Record<string, Record1>; a: Record<string, Record1>; code: number; must: string[] }[] = [
    {
      name: "對照組:6901 三格比率留白 + 三個真實 rev<0 期別 → 應放行並列出豁免",
      b: { "6901": row(GM, 5) },
      a: { "6901": row(GM, 2, NEG) },
      code: 0,
      must: ["因【該期營收 ≤ 0】豁免:3 格 / 1 檔", "無假豁免", "✅ PASS"],
    },
    {
      name: "注入①:2330 宣稱豁免,但該期 rev > 0 → 必須被抓",
      b: { "2330": row(GM, 5) },
      a: { "2330": row(GM, 3, POS) },
      code: 1,
      must: ["假豁免", "> 0 → 假豁免"],
    },
    {
      name: "對照組(季/YTD):6901 季與 YTD 各三格 → 應放行(走 ISO→Qn 換算與 YTD 同年累計)",
      b: { "6901": { ...row(GM, 8, [], "q"), y: { ...blank(), [GM]: 8 } } },
      a: {
        "6901": {
          ...row(GM, 5, NEGQ, "q"),
          y: { ...blank(), [GM]: 5 },
          exempt: { a: [], q: NEGQ, y: NEGQ },
        },
      },
      code: 0,
      must: ["因【該期營收 ≤ 0】豁免:6 格 / 1 檔", "無假豁免", "✅ PASS"],
    },
    {
      name: "注入②:宣稱的期別不在交付檔 → 必須被抓(查無不得預設通過)",
      b: { "2330": row(GM, 5) },
      a: { "2330": row(GM, 3, ["1999-12-31", "1998-12-31"]) },
      code: 1,
      must: ["假豁免", "交付檔無此期別"],
    },
    {
      name: "注入②b:月份不落在 3/6/9/12 → 不得猜最近的季,必須判無法證明",
      b: { "6901": row(GM, 5, [], "q") },
      a: { "6901": row(GM, 3, ["2024-05-31", "2024-08-31"], "q") },
      code: 1,
      must: ["假豁免", "期別無法對應到交付檔的年/季"],
    },
    {
      name: "注入③:退化 4 格但只有 3 個 rev<0 期別 → 超額部分照樣算退化",
      b: { "6901": row(GM, 5) },
      a: { "6901": row(GM, 1, NEG) },
      code: 1,
      must: ["❌ FAIL", "a:Gross Margin (%)"],
    },
    {
      name: "注入④:非比率欄(Revenue)不得享有豁免 → 照樣算退化",
      b: { "6901": row("Revenue", 5) },
      a: { "6901": row("Revenue", 2, NEG) },
      code: 1,
      must: ["❌ FAIL", "a:Revenue"],
    },
  ];

  let fail = 0;
  for (const c of cases) {
    fs.writeFileSync(bf, JSON.stringify({ rows: c.b }), "utf8");
    fs.writeFileSync(af, JSON.stringify({ rows: c.a }), "utf8");
    const buf: string[] = [];
    const ol = console.log;
    const oe = console.error;
    console.log = (...x: unknown[]) => void buf.push(x.join(" "));
    console.error = (...x: unknown[]) => void buf.push(x.join(" "));
    let code = -1;
    try {
      code = compare(bf, af);
    } finally {
      console.log = ol;
      console.error = oe;
    }
    const out = buf.join("\n");
    const missing = c.must.filter((m) => !out.includes(m));
    const ok = code === c.code && missing.length === 0;
    if (!ok) fail++;
    console.log(`${ok ? "  ✓" : "  ✗"} ${c.name}`);
    console.log(`      退出碼 ${code}(預期 ${c.code})`);
    if (!ok) {
      if (missing.length) console.log(`      缺少預期輸出:${missing.map((m) => JSON.stringify(m)).join(", ")}`);
      console.log(out.split("\n").map((l) => `      | ${l}`).join("\n"));
    }
  }
  try {
    fs.unlinkSync(bf);
    fs.unlinkSync(af);
  } catch {
    /* 清不掉不影響判定 */
  }
  const ctrl = cases.filter((c) => c.code === 0).length;
  console.log(
    fail === 0
      ? `\n✅ 豁免規則自我驗證通過(${ctrl} 對照 + ${cases.length - ctrl} 注入)`
      : `\n❌ 自我驗證失敗 ${fail} / ${cases.length} 項`
  );
  return fail === 0 ? 0 : 1;
}

// ── CLI ──
const argv = process.argv.slice(2);
const argOf = (name: string): string | null => {
  const i = argv.indexOf(name);
  // ⚠️ indexOf 回 -1 時 argv[0] 會被誤當成值(踩過:ASOF 變成旗標字串,空跑卻報數字)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
};

if (argv.includes("--self-test")) process.exit(selfTestExempt());

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
