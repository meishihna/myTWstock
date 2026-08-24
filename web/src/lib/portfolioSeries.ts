/**
 * 逐日部位 / 淨值曲線 / 回撤 / TWR / 對標 —— **純函式,不 fetch、不碰 DOM**
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 這一輪唯一的新東西是【逐日位置】。所以對照必須驗位置,不能只驗總量。
 *
 *   A. 末點(用最後收盤價)重算成即時報價 → 必須精確等於頭條淨值   ← 驗末點
 *   B. 逐日現金變動累加 == 現在的現金水位                        ← 🔴 只驗總量
 *   C. 無外部資金流時 TWR == (末/初 − 1)                        ← 驗連乘
 *   D. 內部抽點:指定日期的現金與逐檔股數                        ← 🔴 驗位置
 *
 * 🔴 **B 是望遠鏡恆等式。** 把每一筆現金流都放到錯的日子,累加總額還是一樣 ——
 *    它在「日期歸屬全錯」的假設下照樣成立。
 *    (同族:`Σ四單季 == Q4累計` 在正確與錯誤的解累計假設下都成立。)
 *    B 保留,但**必須標明它只驗總量**,不可拿來當位置正確的證據。
 *
 * 🔴 為什麼沒有做 SQL 的「逐日累積股數」對照檢視:
 *    它與本檔讀同一份 `trade_date`、做同一個累加 —— 兩邊會一致,
 *    **即使軸的對位邏輯是錯的**,因為那個檢視根本沒有軸。
 *    那是空洞的對照(見 `vacuous-pass-patterns`),而且要多套一次 migration。
 *    位置的裁判是 D 與合成夾具的逐日對位。
 *
 * 🔴 不需要 FIFO:淨值只要「D 日持有股數 × D 日價格」。股數是純累加。
 *    FIFO 只有「逐日已實現」才需要,那不在本輪。
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { Trade } from "./fifo";
import { EXTERNAL_KINDS, tradeCashImpact, type CashFlowRow } from "./equity";

/* ── 輸入 ───────────────────────────────────────────────────────────── */

export type DailyBar = { time: string; close: number };
/** ticker → 日線(遞增)。來源:`/api/bars/[ticker]`(未還原的實際成交價) */
export type SeriesMap = Map<string, DailyBar[]>;

/**
 * 向前填補上限(交易日)。
 * 🔴 釘死成常數並在測試裡斷言 —— 放寬它必須是刻意行為。
 */
export const CARRY_MAX_DAYS = 5;

/* ── 逐日部位 ───────────────────────────────────────────────────────── */

export type DayPosition = {
  date: string;
  /** ticker → 股數(只含 > 0) */
  shares: Record<string, number>;
  /** 該日收盤後的現金 */
  cash: number;
};

/**
 * 逐日重建部位與現金。
 *
 * 🔴 判準是 `trade_date <= 軸日`,**不是「軸日等於 trade_date」**。
 *    交易日期可能落在沒有價格棒的日子(停牌、休市、或來源把日期記成假日)——
 *    那時若只在軸日上套用當天的交易,那筆會被【延後或丟掉】,
 *    而部位少一筆在畫面上看起來完全正常。
 */
export function rebuildDaily(axis: string[], trades: Trade[], cashFlows: CashFlowRow[]): DayPosition[] {
  const ts = [...trades].sort((a, b) =>
    a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : a.seq - b.seq
  );
  const cf = [...cashFlows].sort((a, b) => (a.flow_date < b.flow_date ? -1 : a.flow_date > b.flow_date ? 1 : 0));

  const shares: Record<string, number> = {};
  let cash = 0;
  let ti = 0;
  let ci = 0;
  const out: DayPosition[] = [];

  for (const date of axis) {
    while (ti < ts.length && ts[ti]!.trade_date <= date) {
      const t = ts[ti]!;
      const sign = t.side === "buy" ? 1 : -1;
      shares[t.ticker] = (shares[t.ticker] ?? 0) + sign * t.shares;
      cash += tradeCashImpact([t]);
      ti++;
    }
    while (ci < cf.length && cf[ci]!.flow_date <= date) {
      cash += cf[ci]!.amount;
      ci++;
    }
    const snap: Record<string, number> = {};
    for (const [k, v] of Object.entries(shares)) if (v > 0) snap[k] = v;
    out.push({ date, shares: snap, cash });
  }
  return out;
}

/** D 用的抽點:指定日期的部位與現金(取 <= date 的最後一個軸日) */
export function positionAt(days: DayPosition[], date: string): DayPosition | null {
  let hit: DayPosition | null = null;
  for (const d of days) {
    if (d.date <= date) hit = d;
    else break;
  }
  return hit;
}

/* ── 交易日軸 ───────────────────────────────────────────────────────── */

/**
 * 軸 = 所有(曾)持有標的的價格日期【聯集】,裁到 [from, to]。
 *
 * ⚠️ 用聯集而不是交集:交集會在任一檔停牌那天整條斷掉。
 *    聯集的代價是某些日子有標的缺價 —— 那由填補規則處理,並且**要計數**。
 */
export function buildAxis(series: SeriesMap, from: string, to: string): string[] {
  const set = new Set<string>();
  for (const bars of series.values()) {
    for (const b of bars) if (b.time >= from && b.time <= to) set.add(b.time);
  }
  return [...set].sort();
}

/* ── 淨值曲線 ───────────────────────────────────────────────────────── */

export type NavPoint = {
  date: string;
  /** 證券市值。🔴 有標的填不到價時為 null(不以 0 代替) */
  securities: number | null;
  cash: number;
  nav: number | null;
  /** 該日用了幾檔的填補價 */
  carried: number;
  /** 缺價且超出填補上限的檔 */
  missing: string[];
};

export type NavResult = {
  points: NavPoint[];
  /** 全期用了幾次填補 —— 🔴 必須顯示。填補會把問題抹平 */
  carriedTotal: number;
  /** 有幾天算不出淨值 */
  unknownDays: number;
  /**
   * 🔴 末點是否因缺價而未定價。
   * 末點【不得使用填補值】:A 會拿它去比即時報價,
   * 用舊價比即時價會產生**不是 bug 的差額**,而那種假失敗會訓練人忽略 A。
   */
  lastPointUnpriced: boolean;
};

/** 建索引:ticker → (date → close),並保留排序後的日期供填補回溯 */
function indexSeries(series: SeriesMap) {
  const idx = new Map<string, { dates: string[]; byDate: Map<string, number> }>();
  for (const [tk, bars] of series) {
    const dates: string[] = [];
    const byDate = new Map<string, number>();
    for (const b of [...bars].sort((a, b2) => (a.time < b2.time ? -1 : 1))) {
      dates.push(b.time);
      byDate.set(b.time, b.close);
    }
    idx.set(tk, { dates, byDate });
  }
  return idx;
}

/**
 * 取 `date` 當天的收盤價;沒有就往前找,最多 `carryMax` 個【該檔自己的】交易日。
 * 回傳 `carried` 表示這一格是填補來的。
 */
function priceOn(
  s: { dates: string[]; byDate: Map<string, number> } | undefined,
  date: string,
  carryMax: number
): { price: number | null; carried: boolean } {
  if (!s) return { price: null, carried: false };
  const exact = s.byDate.get(date);
  if (exact != null) return { price: exact, carried: false };
  /* 往前回溯:只數【該檔有棒的日子】,不數日曆日 */
  let back = 0;
  for (let i = s.dates.length - 1; i >= 0; i--) {
    const d = s.dates[i]!;
    if (d > date) continue;
    back++;
    if (back > carryMax) break;
    const p = s.byDate.get(d);
    if (p != null) return { price: p, carried: true };
  }
  return { price: null, carried: false };
}

export function buildNav(
  days: DayPosition[],
  series: SeriesMap,
  opts: { carryMax?: number } = {}
): NavResult {
  const carryMax = opts.carryMax ?? CARRY_MAX_DAYS;
  const idx = indexSeries(series);
  const points: NavPoint[] = [];
  let carriedTotal = 0;
  let unknownDays = 0;

  days.forEach((d, i) => {
    const isLast = i === days.length - 1;
    let sec = 0;
    let carried = 0;
    const missing: string[] = [];
    for (const [tk, sh] of Object.entries(d.shares)) {
      const { price, carried: c } = priceOn(idx.get(tk), d.date, carryMax);
      /* 🔴 末點不得使用填補值 —— 見 NavResult.lastPointUnpriced */
      if (price == null || (isLast && c)) {
        missing.push(tk);
        continue;
      }
      if (c) carried++;
      sec += price * sh;
    }
    carriedTotal += carried;
    const ok = missing.length === 0;
    if (!ok) unknownDays++;
    points.push({
      date: d.date,
      securities: ok ? sec : null,
      cash: d.cash,
      nav: ok ? sec + d.cash : null,
      carried,
      missing,
    });
  });

  return {
    points,
    carriedTotal,
    unknownDays,
    lastPointUnpriced: points.length > 0 && points[points.length - 1]!.nav == null,
  };
}

/* ── 回撤 ───────────────────────────────────────────────────────────── */

export type DrawdownPoint = { date: string; dd: number | null };

/**
 * 自高點回落 %(負值或 0)。
 * ⚠️ 高點只由【算得出淨值的日子】更新 —— 缺價的日子不更新也不回報,
 *    否則一個「未知」會被當成新高或當成回落。
 */
export function drawdownSeries(points: NavPoint[]): { series: DrawdownPoint[]; maxDrawdown: number | null } {
  let peak = -Infinity;
  let worst: number | null = null;
  const series = points.map((p) => {
    if (p.nav == null) return { date: p.date, dd: null };
    if (p.nav > peak) peak = p.nav;
    const dd = peak > 0 ? ((p.nav - peak) / peak) * 100 : 0;
    if (worst == null || dd < worst) worst = dd;
    return { date: p.date, dd };
  });
  return { series, maxDrawdown: worst };
}

/* ── TWR ────────────────────────────────────────────────────────────── */

export type TwrResult = {
  /** 累積報酬 %(時間加權);算不出來時 null */
  pct: number | null;
  /** 參與連乘的天數 */
  linkedDays: number;
  /** 跳過的天數(缺價)—— 🔴 必須顯示,跨過缺口是假設不是事實 */
  skippedDays: number;
  /** 分母為 0 或負而無法計算的天數 */
  degenerateDays: number;
};

/**
 * 逐日連乘的 TWR。外部資金流視為【當日期初】投入:
 *
 *     r_d = NAV_d / (NAV_{d-1} + F_d) − 1
 *     TWR = Π(1 + r_d) − 1
 *
 * 🔴 `F_d` 只取【外部】資金流,而且**直接沿用 `equity.ts` 的 `EXTERNAL_KINDS`** ——
 *    不在本檔另列一份 kind 清單。TWR 的正確性完全建立在那個分母只含
 *    deposit / withdraw 上;兩處各寫一份必然會漂(見 `RECON_FIELDS` 那個手法)。
 */
export function externalFlowByDate(cashFlows: CashFlowRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of cashFlows) {
    if (!EXTERNAL_KINDS.includes(r.kind)) continue;
    m.set(r.flow_date, (m.get(r.flow_date) ?? 0) + r.amount);
  }
  return m;
}

export function twr(points: NavPoint[], flows: Map<string, number>): TwrResult {
  let acc = 1;
  let linked = 0;
  let skipped = 0;
  let degenerate = 0;
  /** 上一個【算得出淨值】的點 —— 跨過缺口時沿用它(並計數) */
  let prev: number | null = null;
  /** 缺口期間累積的外部資金流,跨過去時要一併計入分母 */
  let pendingFlow = 0;

  for (const p of points) {
    const f = flows.get(p.date) ?? 0;
    if (p.nav == null) {
      skipped++;
      pendingFlow += f;
      continue;
    }
    if (prev == null) {
      prev = p.nav;
      pendingFlow = 0;
      continue;
    }
    const denom = prev + f + pendingFlow;
    if (!(denom > 0)) {
      /* 🔴 分母 ≤ 0:當日報酬無定義。不可當 0 帶過 —— 那會讓連乘看起來正常。 */
      degenerate++;
      prev = p.nav;
      pendingFlow = 0;
      continue;
    }
    acc *= p.nav / denom;
    linked++;
    prev = p.nav;
    pendingFlow = 0;
  }

  return {
    pct: linked > 0 ? (acc - 1) * 100 : null,
    linkedDays: linked,
    skippedDays: skipped,
    degenerateDays: degenerate,
  };
}

/* ── 對標(0050)───────────────────────────────────────────────────── */

/**
 * 買進並持有的對標報酬 %:`末/初 − 1`,軸與投組同一條(缺價往前填補)。
 * 🔴 對標與投組必須用【同一條軸】,否則比的是不同期間。
 */
export function benchmarkReturn(bars: DailyBar[], axis: string[], carryMax = CARRY_MAX_DAYS): number | null {
  if (!bars.length || !axis.length) return null;
  const s = indexSeries(new Map([["_b", bars]])).get("_b")!;
  const first = priceOn(s, axis[0]!, carryMax).price;
  const last = priceOn(s, axis[axis.length - 1]!, carryMax).price;
  if (first == null || last == null || first <= 0) return null;
  return (last / first - 1) * 100;
}

/* ── 除權息事件:偵測並具名,不靜默 ────────────────────────────────── */

export type CorporateEvent = { ticker: string; date: string; kind: "dividend" | "split"; detail: string };

/**
 * 🔴 持有期間內的除權息/分割事件 → **具名標示「該日前後不可比」**。
 *
 * 為什麼不能靜默:
 *   · **現金股息**:未還原價在除息日下跌 + `cash_flows(dividend)` 現金上升 → 自洽,
 *     **前提是使用者有登記那筆股息**。沒登記的話曲線會在該日出現一個假的下跌。
 *   · **股票股利(配股)**:股數變動【沒有任何紀錄】(`trades` 只有買賣)——
 *     曲線在除權日前後失真。
 *
 * 我們不猜、不修正、不平滑:**畫出來,並在該日標記不可比。**
 */
export function eventsInHolding(
  events: CorporateEvent[],
  days: DayPosition[]
): CorporateEvent[] {
  const held = new Map<string, Set<string>>(); // ticker → 持有的日期集合
  for (const d of days) {
    for (const tk of Object.keys(d.shares)) {
      if (!held.has(tk)) held.set(tk, new Set());
      held.get(tk)!.add(d.date);
    }
  }
  return events.filter((e) => held.get(e.ticker)?.has(e.date));
}
