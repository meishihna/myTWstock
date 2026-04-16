/**
 * 依 industryType 控制前端儀表板的卡片、表格列、圖表可見性。
 * 後端 financials_store JSON 的 industryType 欄位對應此處鍵值。
 */
import type { IndustryType } from "./financialsJson";

export interface SummaryCardSpec {
  label: string;
  metricKey: string;
  format: "currency" | "percent" | "eps" | "pp";
  yoyMode: "pct" | "pp" | "none";
  emphasize?: boolean;
}

export interface IndustryDisplayConfig {
  revenueLabel: string;
  hiddenMetricRows: Set<string>;
  revenueSeries: string[];
  marginSeries: string[];
  showCapexChart: boolean;
  summaryCardsRow1: SummaryCardSpec[];
  summaryCardsRow2: SummaryCardSpec[];
}

const GENERAL: IndustryDisplayConfig = {
  revenueLabel: "營收",
  hiddenMetricRows: new Set<string>(),
  revenueSeries: ["Revenue", "Gross Profit", "Operating Income", "Net Income"],
  marginSeries: ["Gross Margin (%)", "Operating Margin (%)", "Net Margin (%)"],
  showCapexChart: true,
  summaryCardsRow1: [
    { label: "營收", metricKey: "Revenue", format: "currency", yoyMode: "pct", emphasize: true },
    { label: "毛利率", metricKey: "Gross Margin (%)", format: "percent", yoyMode: "pp", emphasize: true },
    { label: "EPS（元）", metricKey: "EPS", format: "eps", yoyMode: "pct", emphasize: true },
  ],
  summaryCardsRow2: [
    { label: "CAPEX（百萬）", metricKey: "CAPEX", format: "currency", yoyMode: "pct" },
    { label: "營業利益率", metricKey: "Operating Margin (%)", format: "percent", yoyMode: "pp" },
    { label: "淨利率", metricKey: "Net Margin (%)", format: "percent", yoyMode: "pp" },
    { label: "ROE", metricKey: "ROE", format: "percent", yoyMode: "none" },
  ],
};

const FH_BANK_HIDDEN = new Set([
  "Cost of Revenue",
  "Gross Profit",
  "Gross Margin (%)",
  "Selling & Marketing Exp",
  "R&D Exp",
  "Operating Income",
  "Operating Margin (%)",
  "CAPEX",
]);

const FINANCIAL_HOLDING: IndustryDisplayConfig = {
  revenueLabel: "淨收益",
  hiddenMetricRows: FH_BANK_HIDDEN,
  revenueSeries: ["Revenue", "Net Income"],
  marginSeries: ["Net Margin (%)"],
  showCapexChart: false,
  summaryCardsRow1: [
    { label: "淨收益", metricKey: "Revenue", format: "currency", yoyMode: "pct", emphasize: true },
    { label: "淨利率", metricKey: "Net Margin (%)", format: "percent", yoyMode: "pp", emphasize: true },
    { label: "EPS（元）", metricKey: "EPS", format: "eps", yoyMode: "pct", emphasize: true },
  ],
  summaryCardsRow2: [
    { label: "管理費用", metricKey: "General & Admin Exp", format: "currency", yoyMode: "pct" },
    { label: "費用率", metricKey: "_adminExpRatio", format: "percent", yoyMode: "pp" },
    { label: "淨利", metricKey: "Net Income", format: "currency", yoyMode: "pct" },
    { label: "ROE", metricKey: "ROE", format: "percent", yoyMode: "none" },
  ],
};

const BANK: IndustryDisplayConfig = {
  ...FINANCIAL_HOLDING,
  revenueLabel: "淨收益",
  summaryCardsRow1: [
    { label: "淨收益", metricKey: "Revenue", format: "currency", yoyMode: "pct", emphasize: true },
    { label: "淨利率", metricKey: "Net Margin (%)", format: "percent", yoyMode: "pp", emphasize: true },
    { label: "EPS（元）", metricKey: "EPS", format: "eps", yoyMode: "pct", emphasize: true },
  ],
};

const INSURANCE: IndustryDisplayConfig = {
  revenueLabel: "營收",
  hiddenMetricRows: new Set([
    "Gross Profit",
    "Gross Margin (%)",
    "Selling & Marketing Exp",
    "R&D Exp",
    "CAPEX",
  ]),
  revenueSeries: ["Revenue", "Operating Income", "Net Income"],
  marginSeries: ["Operating Margin (%)", "Net Margin (%)"],
  showCapexChart: false,
  summaryCardsRow1: [
    { label: "營收", metricKey: "Revenue", format: "currency", yoyMode: "pct", emphasize: true },
    { label: "營業利益率", metricKey: "Operating Margin (%)", format: "percent", yoyMode: "pp", emphasize: true },
    { label: "EPS（元）", metricKey: "EPS", format: "eps", yoyMode: "pct", emphasize: true },
  ],
  summaryCardsRow2: [
    { label: "管理費用", metricKey: "General & Admin Exp", format: "currency", yoyMode: "pct" },
    { label: "淨利率", metricKey: "Net Margin (%)", format: "percent", yoyMode: "pp" },
    { label: "淨利", metricKey: "Net Income", format: "currency", yoyMode: "pct" },
    { label: "ROE", metricKey: "ROE", format: "percent", yoyMode: "none" },
  ],
};

const SECURITIES: IndustryDisplayConfig = {
  revenueLabel: "營收",
  hiddenMetricRows: new Set([
    "Cost of Revenue",
    "Gross Profit",
    "Gross Margin (%)",
    "Selling & Marketing Exp",
    "R&D Exp",
    "General & Admin Exp",
    "CAPEX",
  ]),
  revenueSeries: ["Revenue", "Operating Income", "Net Income"],
  marginSeries: ["Operating Margin (%)", "Net Margin (%)"],
  showCapexChart: false,
  summaryCardsRow1: [
    { label: "營收", metricKey: "Revenue", format: "currency", yoyMode: "pct", emphasize: true },
    { label: "營業利益率", metricKey: "Operating Margin (%)", format: "percent", yoyMode: "pp", emphasize: true },
    { label: "EPS（元）", metricKey: "EPS", format: "eps", yoyMode: "pct", emphasize: true },
  ],
  summaryCardsRow2: [
    { label: "淨利率", metricKey: "Net Margin (%)", format: "percent", yoyMode: "pp" },
    { label: "淨利", metricKey: "Net Income", format: "currency", yoyMode: "pct" },
    { label: "ROE", metricKey: "ROE", format: "percent", yoyMode: "none" },
  ],
};

const OTHER: IndustryDisplayConfig = {
  revenueLabel: "營收",
  hiddenMetricRows: new Set([
    "Cost of Revenue",
    "Gross Profit",
    "Gross Margin (%)",
    "Selling & Marketing Exp",
    "R&D Exp",
    "General & Admin Exp",
    "Operating Income",
    "Operating Margin (%)",
    "CAPEX",
  ]),
  revenueSeries: ["Revenue", "Net Income"],
  marginSeries: ["Net Margin (%)"],
  showCapexChart: false,
  summaryCardsRow1: [
    { label: "營收", metricKey: "Revenue", format: "currency", yoyMode: "pct", emphasize: true },
    { label: "淨利率", metricKey: "Net Margin (%)", format: "percent", yoyMode: "pp", emphasize: true },
    { label: "EPS（元）", metricKey: "EPS", format: "eps", yoyMode: "pct", emphasize: true },
  ],
  summaryCardsRow2: [
    { label: "淨利", metricKey: "Net Income", format: "currency", yoyMode: "pct" },
    { label: "ROE", metricKey: "ROE", format: "percent", yoyMode: "none" },
  ],
};

const INDUSTRY_CONFIG: Record<IndustryType, IndustryDisplayConfig> = {
  general: GENERAL,
  financial_holding: FINANCIAL_HOLDING,
  bank: BANK,
  insurance: INSURANCE,
  securities: SECURITIES,
  other: OTHER,
};

const VALID_INDUSTRY_TYPES = new Set<string>([
  "general",
  "financial_holding",
  "bank",
  "insurance",
  "securities",
  "other",
]);

/** KPI／圖表版型僅依 industryType；無效或 N/A 字串一律視為 general（不依 sector）。 */
export function normalizeIndustryTypeForDashboard(
  industryType: IndustryType | string | undefined | null,
): IndustryType {
  const t = String(industryType ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (!t || t === "n/a" || t === "na") return "general";
  if (VALID_INDUSTRY_TYPES.has(t)) return t as IndustryType;
  return "general";
}

export function getIndustryConfig(
  industryType: IndustryType | string | undefined | null
): IndustryDisplayConfig {
  const key = normalizeIndustryTypeForDashboard(industryType);
  return INDUSTRY_CONFIG[key] ?? GENERAL;
}

export const REVENUE_LINE_COLORS: Record<string, string> = {
  Revenue: "#378ADD",
  "Gross Profit": "#1D9E75",
  "Operating Income": "#D85A30",
  "Net Income": "#7F77DD",
};

export const REVENUE_LINE_DASHES: Record<string, string | undefined> = {
  Revenue: undefined,
  "Gross Profit": undefined,
  "Operating Income": "5 3",
  "Net Income": "2 2",
};

export const REVENUE_LINE_LABELS: Record<string, string> = {
  Revenue: "營收",
  "Gross Profit": "毛利",
  "Operating Income": "營業利益",
  "Net Income": "淨利",
};

export const MARGIN_LINE_COLORS: Record<string, string> = {
  "Gross Margin (%)": "#1D9E75",
  "Operating Margin (%)": "#D85A30",
  "Net Margin (%)": "#7F77DD",
};

export const MARGIN_LINE_DASHES: Record<string, string | undefined> = {
  "Gross Margin (%)": undefined,
  "Operating Margin (%)": "5 3",
  "Net Margin (%)": "2 2",
};

export const MARGIN_LINE_LABELS: Record<string, string> = {
  "Gross Margin (%)": "毛利率",
  "Operating Margin (%)": "營業利益率",
  "Net Margin (%)": "淨利率",
};
