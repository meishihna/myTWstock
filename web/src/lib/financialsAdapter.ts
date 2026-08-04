/**
 * 官方 MOPS 財務 → 報告頁既有 `FinancialsJson` 形狀的轉接層。
 *
 * 設計原則
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. 【下游零改動】。FinancialDashboard / financialDashboard.ts / industryConfig.ts /
 *    report-financial-tables.js 全部不動,只換供應者。
 * 2. 【欄位級混合,不是整檔二選一】。官方有的用官方,官方沒有的用 store。
 * 3. 🔴【同一張圖表內不得混來源】。以「圖表群組」為單位決定來源:群組內只要有一個 key
 *    拿不到官方,整個群組退回 store —— 否則會出現「營收是官方、毛利是 Yahoo」這種
 *    數字自己打架又不會報錯的圖。
 * 4. 【期別軸以官方為準】,store 序列依期別字串重新對位;對不上的格子為 null,
 *    並記在 `axisMisses` 供稽核 —— 靜默補 0 會產生看起來正常的垃圾。
 *
 * 契約三警告(officialFinancials.ts 有完整說明):
 *   ① 毛利率一律用 `gp`,不可 `rev − cogs`
 *   ② `bs` 是時點數,不可去累計、不可累加成 YTD
 *   ③ `sec`/`other` 的 cogs/gp 是 null 不是 0
 *
 * ⚠️ 本檔目前【只加不接】—— 報告頁尚未改用它(批 3 才接)。
 */
import fs from "node:fs";
import path from "node:path";
import type {
  FinancialsJson,
  FinancialsJsonBlock,
  IndustryType,
} from "./financialsJson";
import {
  annualPeriodToDate,
  bvpsLatest,
  debtToEquity,
  loadOfficial,
  marketCapFrom,
  OFFICIAL_FIELD_TO_SERIES,
  quarterPeriodToDate,
  ratioSeries,
  roeTtm,
  seriesOf,
  type OfficialBlock,
  type OfficialFin,
} from "./officialFinancials";

export type FieldSource = "official" | "store" | "none";

/**
 * 圖表群組 → 它需要的 series key。
 * 來源解析以群組為單位(見設計原則 3)。不屬於任何群組的 key 各自解析。
 */
export const CHART_GROUPS: Record<string, string[]> = {
  /** 營收結構線圖 */
  revenueLines: ["Revenue", "Gross Profit", "Operating Income", "Net Income"],
  /** 利潤率線圖(由 gp/op/ni ÷ rev 推;來源必然跟著 revenueLines) */
  marginLines: ["Gross Margin (%)", "Operating Margin (%)", "Net Margin (%)"],
  /** 費用結構堆疊圖(季度限定,沒有年度版) */
  expenseStack: ["Selling & Marketing Exp", "R&D Exp", "General & Admin Exp"],
  /** 現金流圖 */
  cashFlow: ["Op Cash Flow", "Investing Cash Flow", "Financing Cash Flow"],
  /** CAPEX 卡 + CAPEX 圖 */
  capex: ["CAPEX"],
  /** EPS 柱狀圖 */
  eps: ["EPS"],
};

/** 不屬於任何圖表、只出現在表格裡的列 */
const TABLE_ONLY_KEYS = ["Cost of Revenue", "Operating Expenses"];

/** 官方 industryType 代碼 → 前端版型代碼 */
const INDUSTRY_MAP: Record<string, IndustryType> = {
  general: "general",
  fh: "financial_holding",
  bank: "bank",
  ins: "insurance",
  sec: "securities",
  other: "other",
};

/** 官方 market → 報告頁徽章用的交易所代碼。rotc(興櫃)官方 t163 不涵蓋 → null,不猜。 */
const MARKET_TO_EXCHANGE: Record<string, "TWSE" | "TPEx"> = {
  sii: "TWSE",
  otc: "TPEx",
};

export type AdaptFlags = {
  hasOfficial: boolean;
  hasStore: boolean;
  /**
   * store 的 `General & Admin Exp` 實為【營業費用合計】(推銷+管理+研發),不是管理費用。
   * 鐵證:2330 民國114年度 MOPS t164sb04 推銷 16,918,076 + 管理 82,304,290 +
   * 研發 246,427,264 = 345,649,630 仟元 = 345,649.63 百萬 = store 該欄位逐位相同。
   * 為 true 時,顯示標籤應為「營業費用」而非「一般及管理費用」(批 3 處理)。
   */
  gaIsTotalOpex: boolean;
  /** store 期別對不上官方軸的格數(年 / 季),> 0 要能解釋 */
  axisMisses: { annual: number; quarterly: number };
  /**
   * store 檔自己的 `updatedAt`。
   * 🔴 要標示【store 來源】欄位的資料時點時必須用這個,不可用 `json.updatedAt` ——
   * 後者取的是官方檔時間,會把凍結在 2026-06 的 store 值標上今天的日期。
   * (踩過:企業價值來自 store 卻顯示「靜態值・2026-08-04」。)
   */
  storeUpdatedAt: string | null;
};

export type AdaptResult = {
  /** 下游沿用的形狀;官方與 store 都沒有 → null */
  json: FinancialsJson | null;
  /** series key → 實際來源 */
  sources: Record<string, FieldSource>;
  /** 圖表群組 → 整張圖的來源 */
  charts: Record<string, FieldSource>;
  /** 純量欄位 → 來源 */
  scalars: Record<string, FieldSource>;
  flags: AdaptFlags;
};

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const hasAny = (a: (number | null)[] | null | undefined) =>
  Array.isArray(a) && a.some((v) => fin(v));

// ── store 讀取(建置時優先本地 store,與現行 report/[ticker].astro 同路徑順序)──
let storeDir: string | null | undefined;
function storePath(): string | null {
  if (storeDir !== undefined) return storeDir;
  const p = path.join(process.cwd(), "..", "data", "financials_store");
  const resolved = fs.existsSync(p) ? p : null;
  storeDir = resolved;
  return resolved;
}

export function loadStore(ticker: string): FinancialsJson | null {
  const d = storePath();
  if (!d) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(d, `${ticker}.json`), "utf8"));
    /** 只接受 store 形狀 —— 官方新格式(fields/quarters/annual.v)餵進下游會讀到一堆 undefined */
    return raw?.annual?.series ? (raw as FinancialsJson) : null;
  } catch {
    return null;
  }
}

/**
 * 把 store 的序列依【期別字串】重新對位到目標軸。
 * 對不上的格子填 null 並計數 —— 不可用位置索引硬對齊(期數不同時會整條位移,
 * 而且兩端同錯時回歸測試也抓不到)。
 */
function realign(
  targetPeriods: string[],
  srcPeriods: string[] | undefined,
  srcValues: (number | null)[] | undefined
): { values: (number | null)[]; misses: number } {
  const out: (number | null)[] = new Array(targetPeriods.length).fill(null);
  if (!srcPeriods?.length || !srcValues?.length) {
    return { values: out, misses: 0 };
  }
  const idx = new Map<string, number>();
  for (let i = 0; i < srcPeriods.length; i++) idx.set(String(srcPeriods[i]).trim(), i);
  let hit = 0;
  for (let i = 0; i < targetPeriods.length; i++) {
    const j = idx.get(targetPeriods[i]!);
    if (j == null) continue;
    const v = srcValues[j];
    if (fin(v)) {
      out[i] = v;
      hit++;
    }
  }
  // 來源有值卻一格都對不上 = 軸定義不同(非日曆年結算等),要能被看見
  const srcFinite = srcValues.filter((v) => fin(v)).length;
  return { values: out, misses: srcFinite > 0 && hit === 0 ? srcFinite : 0 };
}

/** 由官方 block 產生 series map(只含官方【真的有】的欄位) */
function officialSeries(
  o: OfficialFin,
  block: OfficialBlock
): Record<string, (number | null)[]> {
  const out: Record<string, (number | null)[]> = {};
  for (const f of o.fields) {
    const key = OFFICIAL_FIELD_TO_SERIES[f];
    if (!key) continue;
    const s = seriesOf(o, block, f);
    if (s) out[key] = s;
  }
  // 🔴 三個率一律由 gp/op/ni ÷ rev 推;毛利率的分子【必須】是 gp 不是 rev−cogs
  const rev = out.Revenue ?? null;
  const gm = ratioSeries(out["Gross Profit"] ?? null, rev);
  const om = ratioSeries(out["Operating Income"] ?? null, rev);
  const nm = ratioSeries(out["Net Income"] ?? null, rev);
  if (gm) out["Gross Margin (%)"] = gm;
  if (om) out["Operating Margin (%)"] = om;
  if (nm) out["Net Margin (%)"] = nm;
  return out;
}

/**
 * 期別軸 =【官方 ∪ store】的聯集,由舊到新排序。
 *
 * ⚠️ 不可只用官方軸:新上市個股的官方 t163 期別可能比 store 短(例:官方只有 3 年、
 * store 有 8 年),只用官方軸會把 store 那幾年整段丟掉 —— 前後對照實測會少 170 格 CAPEX、
 * 340 格現金流、44 檔整個財務儀表板消失。聯集則兩邊都不損失,缺的那一側自然是 null。
 */
function unionPeriods(a: string[] | undefined, b: string[] | undefined): string[] {
  const set = new Set<string>();
  for (const p of a ?? []) if (p) set.add(String(p).trim());
  for (const p of b ?? []) if (p) set.add(String(p).trim());
  return [...set].sort();
}

/**
 * 同年度累加成 YTD。
 * 🔴 只對【損益】列做;`bs` 絕不進來(契約警告 ②)。
 * 🔴 累計毛利率用「累計 gp ÷ 累計 rev」重算,【不可】把單季毛利率相加。
 * 任一季為 null → 該季起的累計為 null(缺漏不可當 0,否則累計會低估而看不出來)。
 */
function cumulateYtd(
  periods: string[],
  series: Record<string, (number | null)[]>
): Record<string, (number | null)[]> {
  const yearOf = (p: string) => String(p).slice(0, 4);
  const out: Record<string, (number | null)[]> = {};
  const RATE_KEYS = new Set([
    "Gross Margin (%)",
    "Operating Margin (%)",
    "Net Margin (%)",
  ]);
  for (const [k, arr] of Object.entries(series)) {
    if (RATE_KEYS.has(k)) continue; // 率不累加,下面重算
    const acc: (number | null)[] = [];
    let sum = 0;
    let broken = false;
    for (let i = 0; i < periods.length; i++) {
      if (i === 0 || yearOf(periods[i]!) !== yearOf(periods[i - 1]!)) {
        sum = 0;
        broken = false;
      }
      const v = arr[i];
      if (v == null || !fin(v)) broken = true;
      else sum += v;
      acc.push(broken ? null : sum);
    }
    out[k] = acc;
  }
  const rev = out.Revenue ?? null;
  const gm = ratioSeries(out["Gross Profit"] ?? null, rev);
  const om = ratioSeries(out["Operating Income"] ?? null, rev);
  const nm = ratioSeries(out["Net Income"] ?? null, rev);
  if (gm) out["Gross Margin (%)"] = gm;
  if (om) out["Operating Margin (%)"] = om;
  if (nm) out["Net Margin (%)"] = nm;
  return out;
}

/** 每個 key 屬於哪個圖表群組(不屬於任何群組者為 undefined) */
const KEY_TO_GROUP = new Map<string, string>();
for (const [g, keys] of Object.entries(CHART_GROUPS)) {
  for (const k of keys) KEY_TO_GROUP.set(k, g);
}

const nFinite = (a: (number | null)[] | null | undefined) =>
  Array.isArray(a) ? a.filter((v) => fin(v)).length : 0;

/**
 * 決定每個圖表群組的來源。
 *
 * 改用官方的條件是【逐檔逐欄】的:群組內每一個 key 的官方有值格數都 ≥ store,
 * 而且至少有一格。只要有一欄比 store 少就整組退回 store。
 *
 * 為什麼不是「官方有值就用官方」:官方 t163 的期別涵蓋【逐檔不同】,新上市或曾更名的
 * 個股可能只有 3 年而 store 有 8 年。逐檔比對實測,寬鬆條件會在 1,854 處讓某檔某欄
 * 由有值變空白 —— 總數看起來還是漲的(+6,205),所以【只看總數會完全看不到這件事】。
 *
 * 為什麼不「用 store 補官方的洞」:那會讓同一條線 2018–2020 是 Yahoo、2021–2025 是官方,
 * 接縫處出現不存在的跳動。寧可整組沿用 store。
 *
 * marginLines 綁定 revenueLines(三個率由那四欄推導,不可各自為政)。
 */
function resolveGroups(
  off: Record<string, (number | null)[]> | null,
  sto: Record<string, (number | null)[]> | null
): Record<string, FieldSource> {
  const res: Record<string, FieldSource> = {};
  for (const [g, keys] of Object.entries(CHART_GROUPS)) {
    const officialWins =
      off != null &&
      keys.every((k) => {
        const oc = nFinite(off[k]);
        return oc > 0 && oc >= nFinite(sto?.[k]);
      });
    if (officialWins) {
      res[g] = "official";
      continue;
    }
    const anyStore = sto != null && keys.some((k) => hasAny(sto[k]));
    res[g] = anyStore ? "store" : off != null && keys.some((k) => hasAny(off[k])) ? "official" : "none";
  }
  if (res.revenueLines) res.marginLines = res.revenueLines;
  return res;
}

/**
 * 組出一個對齊到 `periods`(聯集軸)的 block。
 * 官方與 store 兩側都要 realign —— 聯集軸與任一側的原軸都可能不同,
 * 直接照位置塞會整條位移(而且兩端同錯時回歸測不出來)。
 *
 * `storeFallback` 讓 YTD 走 store 自己的 quarterlyYtd,而不是拿有洞的單季重新累加。
 */
function buildBlock(
  periods: string[],
  officialPeriods: string[] | undefined,
  officialS: Record<string, (number | null)[]> | null,
  storeBlock: FinancialsJsonBlock | null | undefined,
  groups: Record<string, FieldSource>,
  sources: Record<string, FieldSource>
): { block: FinancialsJsonBlock; misses: number; srcByKey: Record<string, FieldSource> } {
  const series: Record<string, (number | null)[]> = {};
  const srcByKey: Record<string, FieldSource> = {};
  let misses = 0;
  const keys = new Set<string>([
    ...Object.values(CHART_GROUPS).flat(),
    ...TABLE_ONLY_KEYS,
  ]);
  for (const key of keys) {
    const group = KEY_TO_GROUP.get(key);
    // 群組內的 key 一律跟著群組決議走(同一張圖不得混來源)
    let src: FieldSource;
    if (group) {
      src = groups[group] ?? "none";
    } else {
      // 表格專屬列(不屬於任何圖表)逐欄決定,但涵蓋度條件與群組相同:
      // 官方有值格數要 ≥ store,否則寧可沿用 store(實測 Cost of Revenue 少了 178 處)
      const oc = nFinite(officialS?.[key]);
      src = oc > 0 && oc >= nFinite(storeBlock?.series?.[key]) ? "official" : "store";
    }

    let values: (number | null)[] | null = null;
    if (src === "official" && officialS?.[key]) {
      const r = realign(periods, officialPeriods, officialS[key]);
      misses += r.misses;
      values = r.values;
    }
    if (!hasAny(values)) {
      const r = realign(periods, storeBlock?.periods, storeBlock?.series?.[key]);
      misses += r.misses;
      values = r.values;
      src = hasAny(r.values) ? "store" : "none";
    }
    // 兩邊都沒有時仍放進 series 保持期數對齊(下游 seriesHasFinite 會自然跳過)
    series[key] = values!;
    srcByKey[key] = src;
    // 同一 key 在年/季可能來源不同;取「較弱」的那個當代表,不誇大覆蓋率
    const prev = sources[key];
    sources[key] =
      prev == null
        ? src
        : prev === src
          ? src
          : prev === "none" || src === "none"
            ? "none"
            : "store";
  }
  return { block: { periods, series }, misses, srcByKey };
}

/**
 * 產出報告頁形狀 + 每個欄位的實際來源。
 *
 * @param opts.pb 由 valuation-index.json 提供的官方股價淨值比(算市值用);缺則市值退回 store
 */
export function adaptFinancials(
  ticker: string,
  opts?: { pb?: number | null }
): AdaptResult {
  const o = loadOfficial(ticker);
  const s = loadStore(ticker);
  const sources: Record<string, FieldSource> = {};
  const scalars: Record<string, FieldSource> = {};
  const flags: AdaptFlags = {
    hasOfficial: o != null,
    hasStore: s != null,
    gaIsTotalOpex: false,
    axisMisses: { annual: 0, quarterly: 0 },
    storeUpdatedAt: typeof s?.updatedAt === "string" ? s.updatedAt : null,
  };

  if (!o && !s) {
    return { json: null, sources, charts: {}, scalars, flags };
  }

  // ── 期別軸:官方 ∪ store(見 unionPeriods 的說明)──
  const annualPeriods = unionPeriods(
    o?.annual.p.map(annualPeriodToDate),
    s?.annual?.periods
  );
  const quarterPeriods = unionPeriods(
    o?.quarters.p.map(quarterPeriodToDate),
    s?.quarterly?.periods ?? s?.quarterlyCore?.periods
  );

  const offAnnual = o ? officialSeries(o, o.annual) : null;
  const offQuarter = o ? officialSeries(o, o.quarters) : null;
  const stoAnnual = s?.annual?.series ?? null;
  const stoQuarterBlock = s?.quarterly ?? s?.quarterlyCore ?? null;

  const groups = resolveGroups(offAnnual, stoAnnual);
  const qGroups = resolveGroups(offQuarter, stoQuarterBlock?.series ?? null);
  // 年/季的群組決議可能不同(例:官方年報已補費用、季報還沒)。
  // 取【交集】—— 兩邊都是 official 才算 official,否則整組 store,避免年季來源不一致。
  const charts: Record<string, FieldSource> = {};
  for (const g of Object.keys(CHART_GROUPS)) {
    const a = groups[g] ?? "none";
    const q = qGroups[g] ?? "none";
    charts[g] = a === q ? a : a === "none" || q === "none" ? "none" : "store";
  }

  const offAnnualPeriods = o?.annual.p.map(annualPeriodToDate);
  const offQuarterPeriods = o?.quarters.p.map(quarterPeriodToDate);
  const ann = buildBlock(
    annualPeriods,
    offAnnualPeriods,
    offAnnual,
    s?.annual,
    charts,
    sources
  );
  const qtr = buildBlock(
    quarterPeriods,
    offQuarterPeriods,
    offQuarter,
    stoQuarterBlock,
    charts,
    sources
  );
  flags.axisMisses.annual = ann.misses;
  flags.axisMisses.quarterly = qtr.misses;

  /**
   * 🔴 quarterlyYtd:只含損益列,`bs` 從頭到尾沒有進來過(契約警告 ②)。
   *
   * 官方來源的欄位 → 由【單季】同年累加。
   * store 來源的欄位 → 用 store 自己的 `quarterlyYtd` 重新對位,【不是】拿已被聯集軸打洞的
   *   單季重新累加 —— 後者會因為某一季缺值而讓整年累計變 null(實測會少 5,425 格現金流)。
   */
  const cumulated = cumulateYtd(quarterPeriods, qtr.block.series);
  const storeYtd: Record<string, (number | null)[]> = {};
  for (const key of Object.keys(cumulated)) {
    storeYtd[key] = realign(
      quarterPeriods,
      s?.quarterlyYtd?.periods,
      s?.quarterlyYtd?.series?.[key]
    ).values;
  }
  /**
   * 累計會被單季的洞放大:某一季 null → 整年累計 null。所以即使單季是官方勝出,
   * 累計後仍可能比 store 自己的 quarterlyYtd 少。以【群組】為單位再比一次涵蓋度,
   * 比較差就整組退回 store(不逐欄挑,否則累計營收與累計毛利可能來自不同來源,
   * 兩者相除的累計毛利率就是假的)。
   */
  const ytdSeries: Record<string, (number | null)[]> = {};
  const ytdGroupSrc: Record<string, FieldSource> = {};
  for (const [g, keys] of Object.entries(CHART_GROUPS)) {
    /**
     * 🔴 涵蓋度必須【每一個 key 都】不比 store 差,不可比群組總和。
     * 踩過兩次的同一類錯誤:總和 >= 而個別欄位變少 → 逐檔退化被總和掩蓋。
     * 實例(2026-08-04 官方擴 14 欄後):cashFlow 群組總和有進步,但
     * `y:Financing Cash Flow` 有 46 檔、`y:Investing Cash Flow` 有 2 檔變少 ——
     * 官方季 `fcf` 有零星缺格,累計時「一季 null → 整年 null」把缺口放大。
     */
    const everyKeyOk = keys.every((k) => nFinite(cumulated[k]) >= nFinite(storeYtd[k]));
    ytdGroupSrc[g] =
      qtr.srcByKey[keys[0]!] === "official" && everyKeyOk ? "official" : "store";
  }
  for (const key of Object.keys(cumulated)) {
    const g = KEY_TO_GROUP.get(key);
    const useOfficial = g
      ? ytdGroupSrc[g] === "official"
      : qtr.srcByKey[key] === "official" &&
        nFinite(cumulated[key]) >= nFinite(storeYtd[key]);
    const pick = useOfficial ? cumulated[key]! : storeYtd[key]!;
    ytdSeries[key] = hasAny(pick) ? pick : (cumulated[key] ?? storeYtd[key]!);
  }
  const ytd: FinancialsJsonBlock = { periods: quarterPeriods, series: ytdSeries };

  // 「一般及管理費用」若不是官方 admin 而是 store 那欄,它實為營業費用合計
  flags.gaIsTotalOpex = sources["General & Admin Exp"] === "store";

  // ── 純量 ──
  const mcOff = o ? marketCapFrom(o, opts?.pb) : null;
  const marketCap = mcOff ?? (fin(s?.marketCap) ? s!.marketCap! : null);
  scalars.marketCap = mcOff != null ? "official" : marketCap != null ? "store" : "none";

  // 企業價值:官方無來源(bsFields 沒有現金及約當現金)→ store,再無則由報告 MD 補
  const enterpriseValue = fin(s?.enterpriseValue) ? s!.enterpriseValue! : null;
  scalars.enterpriseValue = enterpriseValue != null ? "store" : "none";

  const industryType: IndustryType =
    (o && INDUSTRY_MAP[o.industryType]) ??
    (s?.industryType as IndustryType | undefined) ??
    "general";
  scalars.industryType = o && INDUSTRY_MAP[o.industryType] ? "official" : s ? "store" : "none";

  const exchange = o ? (MARKET_TO_EXCHANGE[o.market] ?? null) : null;
  scalars.exchange = exchange ? "official" : "none";
  /**
   * 有官方 market 即代表在 t163 涵蓋內(上市或上櫃)。興櫃(rotc)官方不涵蓋 → 不猜。
   * 官方查無時沿用 store 的值:store 全 1,737 檔都是 "listed",本身沒有資訊量
   * (exchange 全 undefined,徽章從來沒渲染過),但保留它才不會有欄位由有值變空白。
   */
  const listingStatus = exchange ? "listed" : (s?.listingStatus ?? null);
  scalars.listingStatus = exchange ? "official" : listingStatus ? "store" : "none";

  const roe = o ? roeTtm(o) : null;
  const de = o ? debtToEquity(o) : null;
  const storeVal = s?.valuation ?? {};
  const valuation: Record<string, number | null> = { ...storeVal };
  if (roe != null) valuation.ROE = roe;
  if (de != null) valuation["Debt/Equity"] = de;
  scalars.ROE = roe != null ? "official" : storeVal.ROE != null ? "store" : "none";
  scalars["Debt/Equity"] =
    de != null ? "official" : storeVal["Debt/Equity"] != null ? "store" : "none";
  const bvps = o ? bvpsLatest(o) : null;
  if (bvps != null) valuation.BVPS = bvps;
  scalars.BVPS = bvps != null ? "official" : "none";

  const json: FinancialsJson = {
    ticker,
    schemaVersion: 3,
    updatedAt: o?.updatedAt ?? s?.updatedAt,
    unit: s?.unit ?? "Million NTD; margin rows are percent; EPS is TWD per share",
    industryType,
    sector: s?.sector,
    industry: s?.industry,
    marketCap,
    enterpriseValue,
    listingStatus: listingStatus ?? undefined,
    valuation,
    annual: ann.block.periods.length ? ann.block : null,
    quarterly: qtr.block.periods.length ? qtr.block : null,
    quarterlyCore: qtr.block.periods.length ? qtr.block : null,
    quarterlyYtd: ytd.periods.length ? ytd : null,
    monthlyRevenue: null, // 月營收已由 lib/monthlyRevenue.ts 走官方,這裡不重複供應
  };
  // exchange 不在 FinancialsJson 型別上(現行報告頁以 Record 取用),掛成額外屬性
  (json as Record<string, unknown>).exchange = exchange;

  return { json, sources, charts, scalars, flags };
}
