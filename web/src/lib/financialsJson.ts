/**
 * data/financials_store/{ticker}.json（update_financials.py；建置時優先讀此路徑，fallback public）
 */
export type FinancialsJsonBlock = {
  periods: string[];
  series: Record<string, (number | null)[]>;
};

export type IndustryType =
  | "general"
  | "financial_holding"
  | "bank"
  | "insurance"
  | "securities"
  | "other";

export type FinancialsJson = {
  ticker: string;
  schemaVersion?: number;
  updatedAt?: string;
  unit?: string;
  industryType?: IndustryType;
  sector?: string;
  industry?: string;
  marketCap?: number | null;
  enterpriseValue?: number | null;
  yahooSuffix?: string;
  valuation?: Record<string, number | null>;
  annual?: FinancialsJsonBlock | null;
  /** Full merged quarterly (may drop periods when detail rows are all NaN). */
  quarterly?: FinancialsJsonBlock | null;
  /** Core rows only; often more periods for Revenue / margin charts. */
  quarterlyCore?: FinancialsJsonBlock | null;
  /**
   * 同日曆年 YTD 累積（由單季欄位加總；update_financials 產出）。
   * 與 quarterly 同期別對齊；EPS 為同年單季 EPS 加總（近似累積每股）。
   */
  quarterlyYtd?: FinancialsJsonBlock | null;
};

/** 與 JSON 欄位一一對齊（含 null），供近 32 季柱狀圖對齊期數 */
export type NullableFinancialSeries = {
  labels: string[];
  values: (number | null)[];
};

/** 年度營收時序（由舊到新）；保留缺值欄位與季線圖一致，避免期數錯位。 */
export function annualRevenueSeriesFromJson(
  j: FinancialsJson | null
): NullableFinancialSeries | null {
  const block = j?.annual;
  if (!block?.periods?.length || !block.series) return null;
  const rev = block.series.Revenue;
  if (!rev || rev.length !== block.periods.length) return null;
  const values = rev.map((v) =>
    v != null && Number.isFinite(v) ? v : null
  );
  if (!values.some((v) => v != null && Number.isFinite(v))) return null;
  return {
    labels: [...block.periods],
    values,
  };
}

/**
 * 季度指標：保留 periods 全長與 null，與 Markdown 表不同時仍可用於圖表（FinMind 補歷史；圖表再取近 32 季）。
 * periods 為時間由舊到新（與 Python _dataframe_to_json_block 一致）。
 */
function seriesFromQuarterlyBlock(
  block: FinancialsJsonBlock,
  metricKey: "Revenue" | "Gross Margin (%)"
): NullableFinancialSeries | null {
  if (!block?.periods?.length || !block.series) return null;
  const row = block.series[metricKey];
  if (!row || row.length !== block.periods.length) return null;
  return {
    labels: [...block.periods],
    values: row.map((v) =>
      v != null && Number.isFinite(v) ? v : null
    ),
  };
}

function quarterlyBlockHasRevAndGm(block: FinancialsJsonBlock | null | undefined): boolean {
  const n = block?.periods?.length ?? 0;
  if (!n || !block?.series) return false;
  const r = block.series.Revenue;
  const g = block.series["Gross Margin (%)"];
  return (
    Array.isArray(r) &&
    r.length === n &&
    Array.isArray(g) &&
    g.length === n
  );
}

/**
 * 季營收 + 季毛利必須來自「同一個」quarterly / quarterlyCore 區塊，否則會出現
 * 若營收與毛利取自不同區塊導致期數不一致 → 無法走 JSON 圖表，退回 MD 後毛利列若含「-」又會被整列丟棄。
 */
export function quarterlyRevGmSeriesPairFromJson(
  j: FinancialsJson | null
): { rev: NullableFinancialSeries | null; gm: NullableFinancialSeries | null } {
  const candidates: FinancialsJsonBlock[] = [];
  if (j?.quarterly) candidates.push(j.quarterly);
  if (j?.quarterlyCore) candidates.push(j.quarterlyCore);
  const seen = new Set<FinancialsJsonBlock>();
  let best: FinancialsJsonBlock | null = null;
  let bestN = 0;
  for (const b of candidates) {
    if (seen.has(b)) continue;
    seen.add(b);
    if (!quarterlyBlockHasRevAndGm(b)) continue;
    const n = b.periods!.length;
    if (n > bestN) {
      bestN = n;
      best = b;
    }
  }
  if (!best) return { rev: null, gm: null };
  return {
    rev: seriesFromQuarterlyBlock(best, "Revenue"),
    gm: seriesFromQuarterlyBlock(best, "Gross Margin (%)"),
  };
}

/** 單一指標時仍可用；多指標圖表請優先使用 quarterlyRevGmSeriesPairFromJson。 */
export function quarterlyMetricSeriesFromJson(
  j: FinancialsJson | null,
  metricKey: "Revenue" | "Gross Margin (%)"
): NullableFinancialSeries | null {
  const full = j?.quarterly
    ? seriesFromQuarterlyBlock(j.quarterly, metricKey)
    : null;
  const core = j?.quarterlyCore
    ? seriesFromQuarterlyBlock(j.quarterlyCore, metricKey)
    : null;
  if (full && core) {
    return full.labels.length >= core.labels.length ? full : core;
  }
  return full ?? core ?? null;
}

/** 圖表：只保留最近 maxLen 期（舊→新時取尾端）。 */
export function tailNullableSeries(
  s: NullableFinancialSeries,
  maxLen: number
): NullableFinancialSeries {
  if (maxLen <= 0 || s.labels.length <= maxLen) return s;
  const i = s.labels.length - maxLen;
  return {
    labels: s.labels.slice(i),
    values: s.values.slice(i),
  };
}

/** 兩條季線對齊同一期數後取尾端（長度應一致；否則取三者最小長度）。 */
export function tailNullableSeriesPair(
  a: NullableFinancialSeries,
  b: NullableFinancialSeries,
  maxLen: number
): [NullableFinancialSeries, NullableFinancialSeries] {
  const n = Math.min(maxLen, a.labels.length, b.labels.length);
  if (n <= 0) return [a, b];
  const ia = a.labels.length - n;
  const ib = b.labels.length - n;
  return [
    { labels: a.labels.slice(ia), values: a.values.slice(ia) },
    { labels: b.labels.slice(ib), values: b.values.slice(ib) },
  ];
}
