/**
 * 完整財務儀表板：由 financials JSON 區塊組線圖／柱狀圖與 KPI（年／季）。
 */
import type { FinancialsJson, FinancialsJsonBlock } from "./financialsJson";

/** 儀表板年表最多欄數（JSON 期別舊→新，取最後 N 年） */
export const DASHBOARD_ANNUAL_MAX_PERIODS = 8;
/** 儀表板季表最多欄數（與 update_financials QUARTERLY_JSON_MAX_COLS 預設對齊） */
export const DASHBOARD_QUARTERLY_MAX_PERIODS = 32;
import {
  getIndustryConfig,
  type SummaryCardSpec,
  type IndustryDisplayConfig,
} from "./industryConfig";

export type TailedBlock = {
  /** 原始期別（與 series 對齊） */
  periods: string[];
  /** X 軸顯示用 */
  xLabels: string[];
  series: Record<string, (number | null)[]>;
};

export function annualXLabel(period: string): string {
  const m = period.match(/^(\d{4})/);
  return m ? m[1]! : period.slice(0, 4);
}

export function quarterXLabel(period: string): string {
  const m = period.trim().match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) return period;
  const y = m[1]!.slice(2);
  const mo = parseInt(m[2]!, 10);
  const q = mo <= 3 ? 1 : mo <= 6 ? 2 : mo <= 9 ? 3 : 4;
  return `${y}Q${q}`;
}

/**
 * 取區塊「最後 maxLen 個期別」（JSON 的 periods 為舊→新）。
 * n ≤ maxLen 時整段保留；僅在 n > maxLen 時截掉最舊的欄位。
 */
export function tailBlock(
  block: FinancialsJsonBlock | null | undefined,
  maxLen: number,
  /** 年資料常為 YYYY-MM-DD：用 `year` 只顯示西元年，季資料維持 `quarter`（yyQn） */
  xLabelMode: "quarter" | "year" = "quarter"
): TailedBlock | null {
  if (!block?.periods?.length || !block.series || maxLen <= 0) return null;
  const n = block.periods.length;
  const start = Math.max(0, n - maxLen);
  const periods = block.periods.slice(start);
  const xLabels = periods.map((p) => {
    const t = p.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
      return xLabelMode === "year" ? annualXLabel(t) : quarterXLabel(p);
    }
    return annualXLabel(p);
  });
  const m = periods.length;
  const series: Record<string, (number | null)[]> = {};
  for (const [k, arr] of Object.entries(block.series)) {
    if (!Array.isArray(arr)) continue;
    let next: (number | null)[];
    if (arr.length === n) {
      next = arr.slice(start);
    } else if (arr.length >= m) {
      next = arr.slice(-m);
    } else {
      const pad = m - arr.length;
      next = [...Array(Math.max(0, pad)).fill(null), ...arr] as (number | null)[];
    }
    if (next.length !== m) continue;
    series[k] = next;
  }
  return { periods, xLabels, series };
}

export function bestQuarterlyBlock(j: FinancialsJson | null): FinancialsJsonBlock | null {
  if (!j) return null;
  /** 優先 quarterlyCore（欄位較完整），再 quarterly */
  const candidates: FinancialsJsonBlock[] = [];
  if (j.quarterlyCore) candidates.push(j.quarterlyCore);
  if (j.quarterly) candidates.push(j.quarterly);
  const seen = new Set<FinancialsJsonBlock>();
  let best: FinancialsJsonBlock | null = null;
  let bestN = 0;
  /** 金融股無毛利／營業利益列：僅要求營收＋淨利對齊期數即可啟用季報 Tab */
  const need = ["Revenue", "Net Income"] as const;
  for (const b of candidates) {
    if (seen.has(b)) continue;
    seen.add(b);
    const n = b.periods?.length ?? 0;
    if (!n || !b.series) continue;
    const ok = need.every((key) => {
      const row = b.series![key];
      return Array.isArray(row) && row.length === n;
    });
    if (!ok) continue;
    if (n > bestN) {
      bestN = n;
      best = b;
    }
  }
  return best;
}

/**
 * Yahoo 年報 EPS 有時誤為「最近一季」；12 月年結年度改以同年曆年單季 EPS 加總，與季表累積至 Q4 對齊。
 */
export function withAnnualEpsFromQuarterlySum(
  annual: TailedBlock,
  financials: FinancialsJson | null
): TailedBlock {
  const qBlock = bestQuarterlyBlock(financials);
  const qEps = qBlock?.series?.EPS;
  const qPeriods = qBlock?.periods;
  if (!qBlock || !qEps || !qPeriods || qEps.length !== qPeriods.length) {
    return annual;
  }
  const aEps = annual.series.EPS;
  if (!aEps || aEps.length !== annual.periods.length) return annual;

  const newEps = aEps.slice();
  for (let i = 0; i < annual.periods.length; i++) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(annual.periods[i]).trim());
    if (!m) continue;
    const y = parseInt(m[1]!, 10);
    const mo = parseInt(m[2]!, 10);
    if (mo !== 12) continue;

    let sum = 0;
    let any = false;
    for (let j = 0; j < qPeriods.length; j++) {
      const qm = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(qPeriods[j]).trim());
      if (!qm) continue;
      if (parseInt(qm[1]!, 10) !== y) continue;
      const v = qEps[j];
      if (v != null && Number.isFinite(v)) {
        sum += v;
        any = true;
      }
    }
    if (any) newEps[i] = sum;
  }
  return {
    ...annual,
    series: { ...annual.series, EPS: newEps },
  };
}

function lastFinitePair(values: (number | null)[]): {
  cur: number;
  prev: number;
  curIdx: number;
} | null {
  let curIdx = -1;
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) continue;
    if (curIdx < 0) {
      curIdx = i;
      continue;
    }
    return { cur: values[curIdx]!, prev: v!, curIdx };
  }
  return null;
}

/** 營收式 YoY % */
export function yoyPct(cur: number, prev: number): number | null {
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) return null;
  return ((cur / prev - 1) * 100);
}

/** 毛利率等：與前期差幾個百分點 */
export function yoyPp(cur: number, prev: number): number | null {
  if (!Number.isFinite(cur) || !Number.isFinite(prev)) return null;
  return cur - prev;
}

export type KpiCard = {
  label: string;
  value: string;
  delta?: string;
  trend?: "up" | "down" | "flat";
  note?: string;
  /** 營收／毛利率／EPS：版面凸顯主數字 */
  emphasize?: boolean;
};

function fmtM(n: number): string {
  return n.toLocaleString("zh-TW", { maximumFractionDigits: 0 });
}

function fmtPct1(n: number): string {
  return `${n.toLocaleString("zh-TW", { maximumFractionDigits: 1 })}%`;
}

/** 解析 JSON valuation 的 ROE（數字或含 % 字串；Yahoo 有時為字串） */
function coerceValuationRoePercent(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const s = String(raw).trim().replace(/%/g, "");
  if (!s || s === "N/A") return null;
  const x = parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(x) ? x : null;
}

function fmtDeltaPct(n: number | null): { text: string; trend: "up" | "down" | "flat" } | null {
  if (n == null || !Number.isFinite(n)) return null;
  const t = n > 0.05 ? "up" : n < -0.05 ? "down" : "flat";
  const sign = n > 0 ? "▲" : n < 0 ? "▼" : "—";
  return { text: `${sign} ${Math.abs(n).toFixed(1)}% YoY`, trend: t };
}

function fmtDeltaPp(n: number | null): { text: string; trend: "up" | "down" | "flat" } | null {
  if (n == null || !Number.isFinite(n)) return null;
  const t = n > 0.05 ? "up" : n < -0.05 ? "down" : "flat";
  const sign = n > 0 ? "▲" : n < 0 ? "▼" : "—";
  return { text: `${sign} ${Math.abs(n).toFixed(1)}pp YoY`, trend: t };
}

function resolveMetricValues(
  spec: SummaryCardSpec,
  annual: TailedBlock,
  valuation: FinancialsJson["valuation"],
): (number | null)[] | null {
  const key = spec.metricKey;
  if (key === "_adminExpRatio") {
    const ga = annual.series["General & Admin Exp"];
    const rev = annual.series.Revenue;
    if (!ga || !rev || ga.length !== rev.length) return null;
    return ga.map((g, i) => {
      const r = rev[i];
      if (g == null || r == null || !Number.isFinite(g) || !Number.isFinite(r) || r === 0) return null;
      return (g / r) * 100;
    });
  }
  if (key === "CAPEX") {
    const raw = annual.series.CAPEX;
    if (!raw || !Array.isArray(raw)) return null;
    return raw.map((v) => {
      const n = typeof v === "number" ? v : v == null ? NaN : Number(v);
      if (n == null || !Number.isFinite(n)) return null;
      return Math.abs(n);
    });
  }
  return annual.series[key] ?? null;
}

function cardFromSpec(
  spec: SummaryCardSpec,
  yl: string,
  annual: TailedBlock,
  valuation: FinancialsJson["valuation"],
): KpiCard | null {
  /** ROE 來自 valuation 單點，非年表序列 */
  if (spec.metricKey === "ROE") {
    const roe = coerceValuationRoePercent(valuation?.ROE);
    if (roe != null) {
      return { label: `${yl} ${spec.label}`, value: fmtPct1(roe), note: "估值資料" };
    }
    return null;
  }

  /** CAPEX：與年表尾端對齊；只要「最新顯示年度」有 finite 值即顯示，YoY 僅在可算時附上 */
  if (spec.metricKey === "CAPEX") {
    const values = resolveMetricValues(spec, annual, valuation);
    if (!values?.length) return null;
    let lastFin: number | null = null;
    for (let i = values.length - 1; i >= 0; i--) {
      const v = values[i];
      if (v != null && Number.isFinite(v)) {
        lastFin = v;
        break;
      }
    }
    if (lastFin == null) return null;
    const p = lastFinitePair(values);
    if (p) {
      const y = spec.yoyMode === "pct" ? yoyPct(p.cur, p.prev) : null;
      const d = y != null ? fmtDeltaPct(y) : null;
      return {
        label: `${yl} ${spec.label}`,
        value: fmtM(p.cur),
        delta: d?.text,
        trend: d?.trend,
        emphasize: spec.emphasize,
      };
    }
    return {
      label: `${yl} ${spec.label}`,
      value: fmtM(lastFin),
      emphasize: spec.emphasize,
    };
  }

  const values = resolveMetricValues(spec, annual, valuation);
  if (!values) return null;

  const p = lastFinitePair(values);

  if (spec.format === "eps") {
    if (p) {
      const y = spec.yoyMode === "pct" ? yoyPct(p.cur, p.prev) : null;
      const d = y != null ? fmtDeltaPct(y) : null;
      return {
        label: `${yl} ${spec.label}`,
        value: `${p.cur.toFixed(2)} 元`,
        delta: d?.text,
        trend: d?.trend,
        emphasize: spec.emphasize,
      };
    }
    return { label: `${yl} ${spec.label}`, value: "—", note: "JSON 未含 EPS", emphasize: spec.emphasize };
  }

  if (!p) return null;

  const isPct = spec.format === "percent" || spec.format === "pp";
  const val = isPct ? fmtPct1(p.cur) : fmtM(p.cur);

  let delta: string | undefined;
  let trend: "up" | "down" | "flat" | undefined;
  if (spec.yoyMode === "pct") {
    const y = yoyPct(p.cur, p.prev);
    const d = fmtDeltaPct(y);
    delta = d?.text;
    trend = d?.trend;
  } else if (spec.yoyMode === "pp") {
    const pp = yoyPp(p.cur, p.prev);
    const d = fmtDeltaPp(pp);
    delta = d?.text;
    trend = d?.trend;
  }

  return { label: `${yl} ${spec.label}`, value: val, delta, trend, emphasize: spec.emphasize };
}

export function buildAnnualKpis(
  annual: TailedBlock,
  valuation: FinancialsJson["valuation"],
  industryType?: string | null,
): { yearLabel: string; primary: KpiCard[]; secondary: KpiCard[] } {
  const yl = annualXLabel(annual.periods[annual.periods.length - 1]!);
  const cfg = getIndustryConfig(industryType);
  const primary: KpiCard[] = [];
  for (const spec of cfg.summaryCardsRow1) {
    const c = cardFromSpec(spec, yl, annual, valuation);
    if (c) primary.push(c);
  }
  const secondary: KpiCard[] = [];
  for (const spec of cfg.summaryCardsRow2) {
    const c = cardFromSpec(spec, yl, annual, valuation);
    if (c) secondary.push(c);
  }
  return { yearLabel: yl, primary, secondary };
}

export function buildQuarterlyKpis(q: TailedBlock): { label: string; cards: KpiCard[] } {
  const lastP = q.periods[q.periods.length - 1] ?? "";
  const ql = quarterXLabel(lastP);
  const cards: KpiCard[] = [];
  const rev = q.series.Revenue;
  const gm = q.series["Gross Margin (%)"];
  if (rev) {
    const p = lastFinitePair(rev);
    if (p) {
      const chg = yoyPct(p.cur, p.prev);
      const d = fmtDeltaPct(chg);
      cards.push({
        label: `${ql} 營收`,
        value: fmtM(p.cur),
        delta: d
          ? d.text.replace("YoY", "QoQ").replace("% YoY", "% QoQ")
          : undefined,
        trend: d?.trend,
      });
    }
  }
  if (gm) {
    const p = lastFinitePair(gm);
    if (p) {
      const pp = yoyPp(p.cur, p.prev);
      const d = fmtDeltaPp(pp);
      cards.push({
        label: `${ql} 毛利率`,
        value: fmtPct1(p.cur),
        delta: d
          ? d.text.replace("YoY", "QoQ").replace("pp YoY", "pp QoQ")
          : undefined,
        trend: d?.trend,
      });
    }
  }
  return { label: ql, cards };
}

/** 線圖：多序列，y 從 0 或資料最小值 */
export type LineSeriesSpec = {
  name: string;
  key: string;
  color: string;
  dashed?: boolean;
};

export function computeLineGeometry(
  xLabels: string[],
  seriesList: { values: (number | null)[]; dashed?: boolean }[],
  width: number,
  height: number,
  pad: { t: number; r: number; b: number; l: number },
  opts?: { minY?: number; maxY?: number; includeZero?: boolean }
): {
  innerW: number;
  innerH: number;
  x: (i: number) => number;
  y: (v: number) => number;
  minY: number;
  maxY: number;
} {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const s of seriesList) {
    for (const v of s.values) {
      if (v == null || !Number.isFinite(v)) continue;
      minY = Math.min(minY, v);
      maxY = Math.max(maxY, v);
    }
  }
  if (!Number.isFinite(minY)) {
    minY = 0;
    maxY = 1;
  }
  if (opts?.includeZero !== false) {
    minY = Math.min(0, minY);
    maxY = Math.max(0, maxY);
  }
  if (opts?.minY !== undefined) minY = opts.minY;
  if (opts?.maxY !== undefined) maxY = opts.maxY;
  const padY = (maxY - minY) * 0.08 || 1;
  minY -= padY;
  maxY += padY;
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const n = Math.max(1, xLabels.length - 1);
  const x = (i: number) => pad.l + (innerW * i) / n;
  const y = (v: number) => pad.t + innerH * (1 - (v - minY) / (maxY - minY || 1));
  return { innerW, innerH, x, y, minY, maxY };
}

export function linePathD(
  values: (number | null)[],
  xFn: (i: number) => number,
  yFn: (v: number) => number
): string {
  const parts: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) continue;
    const px = xFn(i);
    const py = yFn(v);
    parts.push(parts.length === 0 ? `M ${px} ${py}` : `L ${px} ${py}`);
  }
  return parts.join(" ");
}

/** 營收線下方填色區（與 linePathD 相同節點，閉合至圖底） */
export function areaFillUnderLineD(
  values: (number | null)[],
  xFn: (i: number) => number,
  yFn: (v: number) => number,
  bottomY: number
): string {
  const pts: [number, number][] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) continue;
    pts.push([xFn(i), yFn(v)]);
  }
  if (pts.length === 0) return "";
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  let d = `M ${first[0]} ${bottomY} L ${first[0]} ${first[1]}`;
  for (let k = 1; k < pts.length; k++) {
    d += ` L ${pts[k][0]} ${pts[k][1]}`;
  }
  d += ` L ${last[0]} ${bottomY} Z`;
  return d;
}

export function showFinancialDashboard(j: FinancialsJson | null): boolean {
  if (!j?.annual?.periods?.length) return false;
  const n = j.annual.periods.length;
  const rev = j.annual.series?.Revenue;
  return Array.isArray(rev) && rev.length === n && n >= 2;
}
