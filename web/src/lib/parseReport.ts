/**
 * Parse structured snippets from Pilot_Reports markdown for richer UI.
 */

export function slugify(text: string): string {
  const s = text
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w\u4e00-\u9fff-]/g, "");
  return s || "section";
}

export type ReportSummary = {
  board?: string;
  industry?: string;
  marketCap?: string;
  enterpriseValue?: string;
  note?: string;
};

export function parseReportSummary(md: string): ReportSummary {
  const out: ReportSummary = {};
  const lines = md.split(/\r?\n/);
  let inIntro = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("## 業務簡介")) {
      inIntro = true;
      continue;
    }
    if (inIntro && line.startsWith("## ")) break;
    if (!inIntro) continue;

    let m = line.match(/^\*\*板塊:\*\*\s*(.+)$/);
    if (m) out.board = m[1].trim();
    m = line.match(/^\*\*產業:\*\*\s*(.+)$/);
    if (m) out.industry = m[1].trim();
    m = line.match(/^\*\*市值:\*\*\s*(.+)$/);
    if (m) out.marketCap = m[1].trim();
    m = line.match(/^\*\*企業價值:\*\*\s*(.+)$/);
    if (m) out.enterpriseValue = m[1].trim();
    m = line.match(/^\*\*注意:\*\*\s*(.+)$/);
    if (m) out.note = m[1].trim();
  }
  return out;
}

export type ValuationParsed = {
  priceLine?: string;
  metrics: Record<string, string>;
  labels: { key: string; label: string; labelZh: string; labelEn: string }[];
};

/** 報告 Markdown 表格欄序（含 ROE）；解析時跳過 ROE，其餘欄位對齊 Beta、D/E */
const VAL_TABLE_SOURCE_KEYS = [
  "peTtm",
  "forwardPe",
  "psTtm",
  "pb",
  "evEbitda",
  "roe",
  "beta",
  "debtEquity",
] as const;

/** 估值區塊 UI 顯示順序（不含 ROE） */
const VAL_KEYS = [
  { key: "peTtm", labelZh: "本益比", labelEn: "P/E (TTM)" },
  { key: "forwardPe", labelZh: "前瞻本益比", labelEn: "Forward P/E" },
  { key: "psTtm", labelZh: "股價營收比", labelEn: "P/S (TTM)" },
  { key: "pb", labelZh: "股價淨值比", labelEn: "P/B" },
  { key: "evEbitda", labelZh: "企業價值倍數", labelEn: "EV/EBITDA" },
  { key: "beta", labelZh: "Beta", labelEn: "Beta" },
  { key: "debtEquity", labelZh: "負債權益比", labelEn: "Debt/Equity" },
] as const;

export function parseValuation(md: string): ValuationParsed {
  const metrics: Record<string, string> = {};
  const h = md.match(/###\s*估值指標\s*\(([^)]*)\)/);
  const priceLine = h ? h[1].trim() : undefined;

  const idx = md.indexOf("### 估值指標");
  if (idx === -1) {
    const dashMetrics: Record<string, string> = {};
    const dashLabels = VAL_KEYS.map((k) => {
      dashMetrics[k.key] = "—";
      return {
        key: k.key,
        label: `${k.labelZh} ${k.labelEn}`,
        labelZh: k.labelZh,
        labelEn: k.labelEn,
      };
    });
    return { priceLine, metrics: dashMetrics, labels: dashLabels };
  }

  const slice = md.slice(idx, Math.min(idx + 1200, md.length));
  const lines = slice.split(/\r?\n/);
  let dataLine: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    if (/P\/E\s*\(TTM\)/.test(lines[i])) {
      for (let j = i + 1; j < lines.length && j < i + 6; j++) {
        const L = lines[j];
        if (/^\|[\s\d.|+-]+/.test(L) && !/^\|\s*[-:]+/.test(L)) {
          dataLine = L;
          break;
        }
      }
      break;
    }
  }

  if (dataLine) {
    const cells = dataLine
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    const n = Math.min(cells.length, VAL_TABLE_SOURCE_KEYS.length);
    for (let i = 0; i < n; i++) {
      const k = VAL_TABLE_SOURCE_KEYS[i];
      if (k === "roe") continue;
      metrics[k] = cells[i]!;
    }
  }

  for (const k of VAL_KEYS) {
    const v = metrics[k.key];
    if (v == null || v === "" || v === "-") {
      metrics[k.key] = "—";
    }
  }

  const labels = VAL_KEYS.map((k) => ({
    key: k.key,
    label: `${k.labelZh} ${k.labelEn}`,
    labelZh: k.labelZh,
    labelEn: k.labelEn,
  }));
  return { priceLine, metrics, labels };
}

/** 從估值標題列抽出報告編撰時基準股價，供與延遲行情換算倍數用 */
export function parseValuationPriceLine(priceLine?: string): {
  reportPrice: number | null;
  trailingNote: string;
  displayFallback: string;
} {
  if (!priceLine?.trim()) {
    return { reportPrice: null, trailingNote: "", displayFallback: "" };
  }
  const t = priceLine.trim();
  const pm = t.match(/股價\s*\$?\s*([\d,]+(?:\.\d+)?)/);
  const reportPrice = pm ? Number(pm[1].replace(/,/g, "")) : null;
  let trailingNote = t.replace(
    /^股價\s*\$?\s*[\d,]+(?:\.\d+)?(?:\s+as of\s+[^|]+)?\s*(\|\s*)?/i,
    ""
  ).trim();
  if (trailingNote === t) {
    trailingNote = t
      .replace(/^股價\s*\$?\s*[\d,]+(?:\.\d+)?(?:\s+as of\s+[^|]+)?/i, "")
      .trim();
    if (trailingNote.startsWith("|")) trailingNote = trailingNote.slice(1).trim();
  }
  return { reportPrice, trailingNote, displayFallback: t };
}

/** 財務表期別欄：YYYY-MM-DD、單年、或 YYYY Q1…Q4（與 update_financials MD 欄名一致）。 */
function isPeriodHeaderCell(c: string): boolean {
  const t = c.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return true;
  if (/^\d{4}$/.test(t)) return true;
  if (/^\d{4}\s+Q[1-4]$/i.test(t)) return true;
  return false;
}

/** 自財務表區塊截取：表頭含日期欄、指定列名。 */
function parseFinancialTableColumnSeries(
  md: string,
  sectionNeedle: string,
  rowPredicate: (line: string) => boolean
): RevenueSeries | null {
  const idx = md.indexOf(sectionNeedle);
  if (idx === -1) return null;
  const slice = md.slice(idx, idx + 5000);
  const lines = slice.split(/\r?\n/);

  let headerLine = "";
  for (const line of lines) {
    if (!line.includes("|")) continue;
    const parts = line.split("|").map((x) => x.trim());
    const start = parts.findIndex(isPeriodHeaderCell);
    if (start === -1) continue;
    let n = 0;
    for (let i = start; i < parts.length; i++) {
      if (isPeriodHeaderCell(parts[i])) n += 1;
      else if (n > 0) break;
    }
    if (n >= 2) {
      headerLine = line;
      break;
    }
  }
  if (!headerLine) return null;

  // 表頭第一欄常為空白；若先 filter(Boolean) 再 slice(1)，會誤刪第一個日期欄（近四季變三季）。
  const headerParts = headerLine.split("|").map((c) => c.trim());
  const firstDataCol = headerParts.findIndex(isPeriodHeaderCell);
  if (firstDataCol === -1) return null;
  const labels: string[] = [];
  for (let i = firstDataCol; i < headerParts.length; i++) {
    const c = headerParts[i];
    if (isPeriodHeaderCell(c)) labels.push(c);
    else if (labels.length > 0) break;
  }
  if (labels.length === 0) return null;

  for (const line of lines) {
    if (rowPredicate(line)) {
      const parts = line.split("|").map((c) => c.trim());
      const rawVals = parts.slice(firstDataCol, firstDataCol + labels.length);
      if (rawVals.length < labels.length) return null;
      const values: (number | null)[] = rawVals.map((s) => {
        const t = s.replace(/,/g, "").trim();
        if (
          t === "" ||
          t === "-" ||
          t === "—" ||
          t === "–" ||
          /^n\/?a$/i.test(t)
        ) {
          return null;
        }
        const n = parseFloat(t);
        return Number.isFinite(n) ? n : null;
      });
      if (!values.some((n) => n != null && Number.isFinite(n))) return null;
      return { labels, values };
    }
  }
  return null;
}

export type TocItem = { depth: number; text: string; id: string };

export function extractToc(md: string): TocItem[] {
  const raw: TocItem[] = [];
  const re = /^(#{2,3})\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const depth = m[1].length;
    const text = m[2].trim().replace(/\s+#\s*$/, "");
    raw.push({ depth, text, id: slugify(text) });
  }
  const seen = new Map<string, number>();
  return raw.map((item) => {
    const n = (seen.get(item.id) || 0) + 1;
    seen.set(item.id, n);
    const id = n === 1 ? item.id : `${item.id}-${n}`;
    return { ...item, id };
  });
}

export function extractRelatedTw(
  md: string,
  nameToTicker: Record<string, string>
): { ticker: string; name: string }[] {
  const wiki = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  const map = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = wiki.exec(md)) !== null) {
    const label = m[1].trim();
    const t = nameToTicker[label];
    if (t) map.set(t, label);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([ticker, name]) => ({ ticker, name }));
}

export type RevenueSeries = { labels: string[]; values: (number | null)[] };

/** 年度表之 Revenue 列（表頭順序；欄數由 update_financials 決定）。 */
export function parseAnnualRevenue(md: string): RevenueSeries | null {
  return parseFinancialTableColumnSeries(
    md,
    "### 年度關鍵財務數據",
    (line) => /^\|\s*Revenue\s*\|/i.test(line)
  );
}

/** 季度表之 Revenue 列（欄數由 update_financials 決定）。 */
export function parseQuarterlyRevenue(md: string): RevenueSeries | null {
  return parseFinancialTableColumnSeries(
    md,
    "### 季度關鍵財務數據",
    (line) => /^\|\s*Revenue\s*\|/i.test(line)
  );
}

/** 年度表 Gross Margin (%) 列。 */
export function parseAnnualGrossMargin(md: string): RevenueSeries | null {
  return parseFinancialTableColumnSeries(
    md,
    "### 年度關鍵財務數據",
    (line) => /^\|\s*Gross Margin\s*\(%\)\s*\|/i.test(line)
  );
}

/** 季度表 Gross Margin (%) 列。 */
export function parseQuarterlyGrossMargin(md: string): RevenueSeries | null {
  return parseFinancialTableColumnSeries(
    md,
    "### 季度關鍵財務數據",
    (line) => /^\|\s*Gross Margin\s*\(%\)\s*\|/i.test(line)
  );
}

/**
 * Assign ids to h2/h3 in order to match extractToc() sequence.
 */
export function addHeadingAnchors(html: string, toc: TocItem[]): string {
  let i = 0;
  return html.replace(/<h([23])>([^<]*)<\/h\1>/g, (_full, level: string, inner: string) => {
    const text = inner.trim();
    const entry = toc[i];
    i += 1;
    const id = entry && entry.text === text ? entry.id : slugify(text);
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
}

/** 數值單位與報告一致（百萬台幣）；en-US 確保千分位為半形逗號。 */
export function formatRevenueShort(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(n);
}

/** 近三十二季等密集柱狀圖：期別縮寫為 25Q4（仍用 title 顯示完整 ISO 日期）。 */
export function formatCompactQuarterLabel(isoDate: string): string {
  const m = isoDate.trim().match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) return isoDate;
  const yy = m[1]!.slice(2);
  const mo = parseInt(m[2]!, 10);
  const q =
    mo <= 3 ? 1 : mo <= 6 ? 2 : mo <= 9 ? 3 : 4;
  return `${yy}Q${q}`;
}

/**
 * 圖表 X 軸：年度僅西元年；季度為「YYYY Qn」（密集時 25Q4）。
 * 與財務表 MD 欄名（YYYY / YYYY Qn）相容。
 */
export function formatAxisPeriodForChart(
  label: string | undefined,
  mode: "annual" | "quarterly",
  opts?: { compact?: boolean }
): string {
  if (!label?.trim()) return "";
  const s = label.trim();
  if (/^\d{4}$/.test(s)) return s;
  const labeledQ = s.match(/^(\d{4})\s+Q([1-4])$/i);
  if (labeledQ) {
    const y = labeledQ[1]!;
    const q = labeledQ[2]!;
    return opts?.compact ? `${y.slice(2)}Q${q}` : `${y} Q${q}`;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  const y = m[1]!;
  const mo = parseInt(m[2]!, 10);
  const d = parseInt(m[3]!, 10);
  if (mode === "annual") return y;
  const exact =
    mo === 3 && d === 31
      ? 1
      : mo === 6 && d === 30
        ? 2
        : mo === 9 && d === 30
          ? 3
          : mo === 12 && d === 31
            ? 4
            : null;
  const q =
    exact ?? (mo <= 3 ? 1 : mo <= 6 ? 2 : mo <= 9 ? 3 : 4);
  return opts?.compact ? `${y.slice(2)}Q${q}` : `${y} Q${q}`;
}

/** 毛利率柱狀圖縮放：須含負值絕對值，避免 scale 過小造成長條異常。 */
export function marginBarScale(
  values: readonly (number | null | undefined)[]
): number {
  const finite = values.filter(
    (v): v is number => v != null && Number.isFinite(v)
  );
  if (finite.length === 0) return 100;
  const ax = Math.max(...finite.map((v) => Math.abs(v)), 0.01);
  return Math.max(ax * 1.12, 1);
}

/** 密集軸：營收整數千分位（半形逗號）。 */
export function formatRevenueAxisDense(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}

export function formatPercent(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${n.toLocaleString("zh-TW", { maximumFractionDigits: 2 })}%`;
}

/** 相對前一期變動（營收年增／季增）；第一個期間無前期則為 null。 */
export function periodOverPeriodGrowthPct(
  values: readonly (number | null)[]
): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i === 0) {
      out.push(null);
      continue;
    }
    const prev = values[i - 1];
    const cur = values[i];
    if (
      prev == null ||
      cur == null ||
      !Number.isFinite(prev) ||
      !Number.isFinite(cur) ||
      prev === 0
    ) {
      out.push(null);
      continue;
    }
    out.push((cur / prev - 1) * 100);
  }
  return out;
}

export function maxAbsGrowthScale(growth: (number | null)[]): number {
  const xs = growth.filter(
    (x): x is number => x != null && Number.isFinite(x)
  );
  if (xs.length === 0) return 1;
  return Math.max(...xs.map((x) => Math.abs(x)), 1e-6) * 1.12;
}

export function formatPctChange(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toLocaleString("zh-TW", { maximumFractionDigits: 2 })}%`;
}

/** 毛利率等：與前一期差幾個百分點（非年增率%） */
export function periodOverPeriodMarginPpt(
  values: readonly (number | null)[]
): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i === 0) {
      out.push(null);
      continue;
    }
    const prev = values[i - 1];
    const cur = values[i];
    if (
      prev == null ||
      cur == null ||
      !Number.isFinite(prev) ||
      !Number.isFinite(cur)
    ) {
      out.push(null);
      continue;
    }
    out.push(cur - prev);
  }
  return out;
}

export function maxAbsPptScale(deltas: (number | null)[]): number {
  const xs = deltas.filter(
    (x): x is number => x != null && Number.isFinite(x)
  );
  if (xs.length === 0) return 1;
  return Math.max(...xs.map((x) => Math.abs(x)), 1e-6) * 1.12;
}

export function formatPptDelta(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toLocaleString("zh-TW", { maximumFractionDigits: 2 })}`;
}

/** 表頭多為「新→舊」，圖表改為時間由舊到新。 */
export function chronologicalSeries(
  s: RevenueSeries | null
): RevenueSeries | null {
  if (!s || s.values.length === 0) return s;
  return {
    labels: [...s.labels].reverse(),
    values: [...s.values].reverse(),
  };
}

/** 圖表只顯示最近 maxLen 期（時序須為舊→新，取陣列尾端）。 */
export function tailRevenueSeries(
  s: RevenueSeries,
  maxLen: number
): RevenueSeries {
  if (maxLen <= 0 || s.labels.length <= maxLen) return s;
  const i = s.labels.length - maxLen;
  return {
    labels: s.labels.slice(i),
    values: s.values.slice(i),
  };
}

export type RelationBlocks = {
  /** 供應鏈位置整段（Markdown 片段） */
  supplyChain?: string;
  customers?: string;
  suppliers?: string;
  competitors?: string;
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 抽出 ## 供應鏈位置、## 主要客戶及供應商 下各 ###（含主要競爭對手）。
 * 格式不一時可能缺欄，由 UI 隱藏空區塊。
 */
/**
 * 供報告正文渲染用：移除已在 RelationSummary 呈現的區塊，避免頁面重複。
 */
export function stripRelationSectionsForBody(md: string): string {
  let s = md;
  s = s.replace(/(?:^|\n)## 供應鏈位置\s*\n[\s\S]*?(?=\n## )/m, "\n");
  s = s.replace(/(?:^|\n)## 主要客戶及供應商\s*\n[\s\S]*?(?=\n## 財務概況)/m, "\n");
  return s.replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n");
}

/**
 * 移除 `### 估值指標` 與其下 Markdown 表：頁面上方已有估值區塊與 financials JSON，不重複內文表。
 */
export function stripValuationMarkdownSubsection(md: string): string {
  const s = md.replace(
    /(?:^|\r?\n)###\s*估值指標[^\r\n]*\r?\n[\s\S]*?(?=\r?\n###\s*(?:年度|季度)|\r?\n##\s|$)/,
    "",
  );
  return s.replace(/\n{3,}/g, "\n\n");
}

export function parseRelationBlocks(md: string): RelationBlocks {
  const out: RelationBlocks = {};

  const sc = md.match(/## 供應鏈位置\s*\n([\s\S]*?)(?=\n## )/);
  if (sc?.[1]?.trim()) {
    out.supplyChain = sc[1].trim();
  }

  const main = md.match(
    /## 主要客戶及供應商\s*\n([\s\S]*?)(?=\n## 財務概況)/
  );
  if (main?.[1]) {
    const block = main[1];
    const sub = (title: string): string | undefined => {
      const re = new RegExp(
        `###\\s*${escapeRegExp(title)}\\s*\\n([\\s\\S]*?)(?=###\\s|##\\s|\\n## [^#]|$)`
      );
      const m = block.match(re);
      const t = m?.[1]?.trim();
      return t || undefined;
    };
    out.customers = sub("主要客戶");
    out.suppliers = sub("主要供應商");
    out.competitors = sub("主要競爭對手");
  }

  return out;
}
