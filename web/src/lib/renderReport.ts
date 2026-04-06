import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

/**
 * 年度／季度關鍵財務表第一欄英文列名 → 中文（僅影響 HTML 呈現；parseReport 仍讀原始英文 md）。
 */
const FIN_TABLE_ROW_EN_TO_ZH: Record<string, string> = {
  "Gross Margin (%)": "毛利率 (%)",
  "Operating Margin (%)": "營業利益率 (%)",
  "Net Margin (%)": "淨利率 (%)",
  "Selling & Marketing Exp": "銷售及行銷費用",
  "General & Admin Exp": "一般及管理費用",
  "Operating Income": "營業利益",
  "Gross Profit": "營業毛利",
  "Net Income": "淨利",
  "Investing Cash Flow": "投資活動之現金流量",
  "Financing Cash Flow": "籌資活動之現金流量",
  "Op Cash Flow": "營業活動之現金流量",
  "R&D Exp": "研發費用",
  Revenue: "營收",
  CAPEX: "資本支出",
};

function translateFinancialTableFirstColumn(md: string): string {
  const sorted = Object.entries(FIN_TABLE_ROW_EN_TO_ZH).sort(
    (a, b) => b[0].length - a[0].length
  );
  return md
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\|(\s*)([^|]+?)(\s*\|)(.*)$/);
      if (!match) return line;
      const first = match[2].trim();
      for (const [en, zh] of sorted) {
        if (first === en) {
          return `| ${zh} |${match[4]}`;
        }
      }
      return line;
    })
    .join("\n");
}

/**
 * Turn [[label]] into markdown links when label matches a TW ticker report name; else styled span.
 */
export function renderReportMarkdown(
  md: string,
  nameToTicker: Record<string, string>
): string {
  const wiki = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  const processed = md.replace(wiki, (_m, raw: string) => {
    const label = raw.trim();
    const t = nameToTicker[label];
    if (t) {
      return `[${label}](/report/${t})`;
    }
    return `<span class="wikilink-none" title="尚無對應上市公司頁面">${label}</span>`;
  });
  const withZhRows = translateFinancialTableFirstColumn(processed);
  return marked.parse(withZhRows) as string;
}
