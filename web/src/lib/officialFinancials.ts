/**
 * 官方 MOPS 財務檔(`web/public/data/financials/{ticker}.json`)的讀取與衍生量。
 *
 * 這一層【只懂官方格式】,不認識報告頁的形狀 —— 形狀轉換在 financialsAdapter.ts。
 * 契約全文:web/docs/financials-contract.md
 *
 * ── 契約三警告(違反任何一條都會產出「看起來正常的垃圾」)────────────────────
 * 🔴 ① 毛利一律直接用 `gp`,【絕不可】由 `rev − cogs` 推算。
 *      227 個(檔×季)、涉及 57 檔合法不等(農企業生物資產利益、關係人未實現銷貨損益)。
 * 🔴 ② `bs`(資產負債表)是【時點數】,【絕不可】去累計、也不可累加成 YTD。
 *      損益表是累計數要相減,資產負債表是某一天的快照 —— 對它做相減會把 Q2 資產變成半年增量。
 * 🔴 ③ `sec`(證券)與 `other` 業別的 `cogs`/`gp` 是 `null`,不是 0。
 *      它們的「支出及費用」是成本+費用合計,映射成 cogs 會讓「rev − cogs」變成營業利益(假毛利)。
 *      前端要保留 null(顯示「—」),【不可】用 0 頂替(0 會畫成毛利率 0% 而非「無此列」)。
 */
import fs from "node:fs";
import path from "node:path";

/** 官方 `market` 代碼。目前實測只有 sii / otc;興櫃 rotc 不在 t163 涵蓋內。 */
export type OfficialMarket = "sii" | "otc" | "rotc";

/** 官方 `industryType` 代碼(與前端 IndustryType 不同,對照表在 adapter) */
export type OfficialIndustry = "general" | "fh" | "bank" | "ins" | "sec" | "other";

export type OfficialBlock = {
  /** 期別。quarters 為 "2017Q1",annual 為 "2017" */
  p: string[];
  /** 與 p 等長;每列的欄序 = fields */
  v: (number | null)[][];
};

export type OfficialFin = {
  schema: string;
  ticker: string;
  market: OfficialMarket;
  industryType: OfficialIndustry;
  updatedAt: string;
  /**
   * 損益欄位名。目前引擎輸出 rev/cogs/gp/opex/op/ni/eps。
   * 【重要】一律以名稱查 index,不可寫死欄序 —— 引擎將補上
   * sell / admin / rd / capex / ocf / icf / fcf,屆時 fields 會變長。
   */
  fields: string[];
  quarters: OfficialBlock;
  annual: OfficialBlock;
  bsFields: string[];
  /** 軸與 quarters 相同(實測 1,973/1,973 完全一致,已共用一條軸) */
  bs: { sameAxisAs?: string; p?: string[]; v: (number | null)[][] };
};

/**
 * 官方欄位 → 報告頁 series key 的正典對照。
 * 【已包含引擎尚未交付的欄位】—— 到貨後不需要改這張表,也不需要改 adapter 介面。
 */
export const OFFICIAL_FIELD_TO_SERIES: Record<string, string> = {
  rev: "Revenue",
  cogs: "Cost of Revenue",
  gp: "Gross Profit",
  op: "Operating Income",
  ni: "Net Income",
  eps: "EPS",
  /** 營業費用合計(推銷+管理+研發)。注意這【不是】管理費用,見 adapter 的標籤說明 */
  opex: "Operating Expenses",
  // ── 以下由引擎後續補上(MOPS t164sb04 / t164sb05,年+季)──
  sell: "Selling & Marketing Exp",
  admin: "General & Admin Exp",
  rd: "R&D Exp",
  capex: "CAPEX",
  ocf: "Op Cash Flow",
  icf: "Investing Cash Flow",
  fcf: "Financing Cash Flow",
};

/** 目前引擎【已經】交付的欄位;其餘要靠 store 補位,直到 backfill 完成 */
export const DELIVERED_FIELDS = ["rev", "cogs", "gp", "opex", "op", "ni", "eps"] as const;

let dirCache: string | null | undefined;
const fileCache = new Map<string, OfficialFin | null>();

function dataDir(): string | null {
  if (dirCache !== undefined) return dirCache;
  const p = path.join(process.cwd(), "public/data/financials");
  const resolved = fs.existsSync(p) ? p : null;
  dirCache = resolved;
  return resolved;
}

/** 讀單一個股的官方檔;查無或格式不符 → null(不拋錯,由呼叫端決定退回 store) */
export function loadOfficial(ticker: string): OfficialFin | null {
  if (fileCache.has(ticker)) return fileCache.get(ticker)!;
  let out: OfficialFin | null = null;
  const d = dataDir();
  if (d) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(d, `${ticker}.json`), "utf8"));
      // 形狀檢查:缺任何一項就整檔判為不可用,不半信半疑地用
      out =
        Array.isArray(raw?.fields) &&
        Array.isArray(raw?.quarters?.p) &&
        Array.isArray(raw?.quarters?.v) &&
        Array.isArray(raw?.annual?.p) &&
        Array.isArray(raw?.annual?.v)
          ? (raw as OfficialFin)
          : null;
    } catch {
      out = null;
    }
  }
  fileCache.set(ticker, out);
  return out;
}

/** 官方檔涵蓋的所有代號(稽核 / 前後對照用) */
export function officialTickers(): string[] {
  const d = dataDir();
  if (!d) return [];
  return (fs.readdirSync(d) as string[])
    .filter((f: string) => /^\d{4}\.json$/.test(f))
    .map((f: string) => f.replace(/\.json$/, ""));
}

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** 取某欄位的整條序列;該欄位不存在 → null(【不是】全 null 的陣列,兩者意義不同) */
export function seriesOf(
  o: OfficialFin,
  block: OfficialBlock,
  field: string
): (number | null)[] | null {
  const i = o.fields.indexOf(field);
  if (i < 0) return null;
  return block.v.map((row) => (fin(row?.[i]) ? (row[i] as number) : null));
}

/** 資產負債表某欄的整條序列(軸同 quarters);查無 → null */
export function bsSeriesOf(o: OfficialFin, field: string): (number | null)[] | null {
  const i = (o.bsFields ?? []).indexOf(field);
  if (i < 0 || !Array.isArray(o.bs?.v)) return null;
  return o.bs.v.map((row) => (fin(row?.[i]) ? (row[i] as number) : null));
}

/** 最新一期的 bs 值(時點數,直接取,不做任何相減) */
export function bsLatest(o: OfficialFin, field: string): number | null {
  const s = bsSeriesOf(o, field);
  if (!s?.length) return null;
  for (let i = s.length - 1; i >= 0; i--) if (s[i] != null) return s[i]!;
  return null;
}

/**
 * ROE(TTM)% = 近 4 個【單季】ni 加總 ÷ 【平均】teParent × 100。
 * 平均 =(期初 + 期末)/ 2,避免增資年度被期末權益稀釋而低估。
 * 分子分母都是【歸屬母公司】口徑(ni 本就定義為歸屬母公司),兩者自然一致。
 * 需要至少 4 季損益 + 5 個 bs 時點(期初要往前推 4 季)。
 */
export function roeTtm(o: OfficialFin): number | null {
  const ni = seriesOf(o, o.quarters, "ni");
  const te = bsSeriesOf(o, "teParent");
  if (!ni || !te) return null;
  const n = Math.min(ni.length, te.length);
  if (n < 5) return null;
  let sum = 0;
  for (let i = n - 4; i < n; i++) {
    if (ni[i] == null) return null;
    sum += ni[i]!;
  }
  const end = te[n - 1];
  const begin = te[n - 5];
  if (end == null || begin == null) return null;
  const avg = (begin + end) / 2;
  if (!(avg > 0)) return null;
  return (sum / avg) * 100;
}

/**
 * 市值(百萬台幣)= PB × teParent。
 *
 * 【不可】走 `bs.cap`:那是【股本】不是股數,除以面額才是股數,而面額非 10 元者(特別股、
 * 無面額)會算錯。用恆等式繞開面額:
 *     PB = 股價 ÷ BVPS,  BVPS = teParent ÷ 股數
 *     ∴ PB × teParent = 股價 × 股數 = 市值
 *
 * 驗證(以生產站即時報價的 previousClose 當裁判,2026-08-02):
 *     PB × BVPS 推得股價 —— 2330 2,205.8 vs 2,205 / 2454 3,235.0 vs 3,235 /
 *     2317 230.1 vs 229.5 / 1304 11.1 vs 11.05 / 1310 7.1 vs 7.06,誤差 < 0.6%。
 *
 * ⚠️ 【不要】拿 financials_store 的 marketCap 當裁判 —— 那份資料 updatedAt 全部凍結在
 *    2026-06,用兩個月前的股價算的。曾因此誤判本推導「平均誤差 17%、不可接受」。
 *    陳舊的一方不能當裁判。
 *
 * @param pb 由 valuation-index.json(TWSE BWIBBU + TPEx 官方)提供
 */
export function marketCapFrom(o: OfficialFin, pb: number | null | undefined): number | null {
  if (!fin(pb) || pb <= 0) return null;
  const te = bsLatest(o, "teParent");
  if (te == null || !(te > 0)) return null;
  return pb * te;
}

/** 負債權益比 = 總負債 ÷ 權益總計(含非控制權益,與 Yahoo 的 Debt/Equity 同口徑) */
export function debtToEquity(o: OfficialFin): number | null {
  const tl = bsLatest(o, "tl");
  const te = bsLatest(o, "te");
  if (tl == null || te == null || !(te > 0)) return null;
  return tl / te;
}

/** 每股淨值:官方直接揭露值,【不要】自推股數(要處理庫藏股/待註銷股本/預收股款三個調整項) */
export function bvpsLatest(o: OfficialFin): number | null {
  return bsLatest(o, "bvps");
}

/**
 * 利潤率 %。分母 <= 0 一律 null —— 負營收/零營收算出來的率是沒有意義的數字,
 * 顯示成 -350% 比留白更誤導。
 *
 * 🔴 毛利率的分子一律用 `gp`,不可用 `rev − cogs`(契約警告 ①)。
 */
export function ratioSeries(
  num: (number | null)[] | null,
  den: (number | null)[] | null
): (number | null)[] | null {
  if (!num || !den || num.length !== den.length) return null;
  return num.map((x, i) => {
    const d = den[i];
    if (x == null || d == null || !(d > 0)) return null;
    return (x / d) * 100;
  });
}

/** "2017Q1" → "2017-03-31";非季別字串原樣回傳 */
export function quarterPeriodToDate(p: string): string {
  const m = /^(\d{4})Q([1-4])$/.exec(String(p).trim());
  if (!m) return p;
  const end = ["03-31", "06-30", "09-30", "12-31"][Number(m[2]) - 1]!;
  return `${m[1]}-${end}`;
}

/** "2017" → "2017-12-31";已是日期就原樣回傳 */
export function annualPeriodToDate(p: string): string {
  const t = String(p).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = /^(\d{4})$/.exec(t);
  return m ? `${m[1]}-12-31` : t;
}
