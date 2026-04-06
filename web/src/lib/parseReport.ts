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

const VAL_KEYS = [
  { key: "peTtm", labelZh: "本益比", labelEn: "P/E (TTM)" },
  { key: "forwardPe", labelZh: "前瞻本益比", labelEn: "Forward P/E" },
  { key: "psTtm", labelZh: "股價營收比", labelEn: "P/S (TTM)" },
  { key: "pb", labelZh: "股價淨值比", labelEn: "P/B" },
  { key: "evEbitda", labelZh: "企業價值倍數", labelEn: "EV/EBITDA" },
] as const;

export function parseValuation(md: string): ValuationParsed {
  const metrics: Record<string, string> = {};
  const h = md.match(/###\s*估值指標\s*\(([^)]*)\)/);
  const priceLine = h ? h[1].trim() : undefined;

  const idx = md.indexOf("### 估值指標");
  if (idx === -1) return { priceLine, metrics, labels: [] };

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
    cells.slice(0, 5).forEach((v, i) => {
      const k = VAL_KEYS[i]?.key;
      if (k) metrics[k] = v;
    });
  }

  const labels = VAL_KEYS.filter((k) => metrics[k.key]).map((k) => ({
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
    if (line.includes("|") && /\d{4}-\d{2}-\d{2}/.test(line)) {
      headerLine = line;
      break;
    }
  }
  if (!headerLine) return null;

  const headers = headerLine
    .split("|")
    .map((c) => c.trim())
    .filter(Boolean);
  const labels = headers.slice(1);
  if (labels.length === 0) return null;

  for (const line of lines) {
    if (rowPredicate(line)) {
      const cells = line
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
      const rawVals = cells.slice(1, 1 + labels.length);
      const values = rawVals.map((s) => parseFloat(s.replace(/,/g, "")));
      if (values.some((n) => !Number.isFinite(n))) return null;
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

export type RevenueSeries = { labels: string[]; values: number[] };

/** 近 3 年年度表之 Revenue 列（表頭順序）。 */
export function parseAnnualRevenue(md: string): RevenueSeries | null {
  return parseFinancialTableColumnSeries(
    md,
    "### 年度關鍵財務數據",
    (line) => /^\|\s*Revenue\s*\|/i.test(line)
  );
}

/** 近 4 季季度表之 Revenue 列。 */
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

/** 數值單位與報告一致（百萬台幣），僅做可讀性格式化。 */
export function formatRevenueShort(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("zh-TW", { maximumFractionDigits: 2 });
}

export function formatPercent(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${n.toLocaleString("zh-TW", { maximumFractionDigits: 2 })}%`;
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
