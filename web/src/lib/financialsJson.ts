/**
 * public/data/financials/{ticker}.json（update_financials.py 產出）
 */
export type FinancialsJsonBlock = {
  periods: string[];
  series: Record<string, (number | null)[]>;
};

export type FinancialsJson = {
  ticker: string;
  updatedAt?: string;
  unit?: string;
  valuation?: Record<string, number | null>;
  annual?: FinancialsJsonBlock | null;
  quarterly?: FinancialsJsonBlock | null;
};

/** 與 JSON 欄位一一對齊（含 null），供近十二季柱狀圖對齊期數 */
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
 * 季度指標：保留 periods 全長與 null，與 Markdown 表不同時仍可用於圖表（FinMind 補歷史；圖表再取近 16 季）。
 * periods 為時間由舊到新（與 Python _dataframe_to_json_block 一致）。
 */
export function quarterlyMetricSeriesFromJson(
  j: FinancialsJson | null,
  metricKey: "Revenue" | "Gross Margin (%)"
): NullableFinancialSeries | null {
  const block = j?.quarterly;
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
