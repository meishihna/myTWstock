/**
 * 新聞卡片：從標題／摘要解析相關台股代號，以及產業標籤（financials / reports-index）。
 * 供 /news 客戶端腳本與其他模組共用。
 */

export type RelatedCapsuleKind = "stock" | "benchmark";

/** 個股膠囊 */
export type RelatedCapsuleStock = {
  kind: "stock";
  ticker: string;
  /** 顯示用簡稱（Yahoo shortName 或站內公司名） */
  displayName: string;
  /** 括號內產業／板塊文字，優先 industry */
  industryParen: string;
  href: string;
};

/** 無個股時：大盤或分類參考 */
export type RelatedCapsuleBenchmark = {
  kind: "benchmark";
  label: string;
  symbol: string;
};

export type RelatedCapsule = RelatedCapsuleStock | RelatedCapsuleBenchmark;

export type ReportsIndexPayload = {
  byTicker: Record<
    string,
    { ticker: string; name: string; sector: string; sectorSlug?: string }
  >;
  nameToTicker: Record<string, string>;
};

export type QuoteBatchRow = {
  symbol: string;
  shortName?: string;
  price: number | null;
  previousClose: number | null;
  changePct: number | null;
  currency?: string;
};

/** 單則新聞最多顯示的台股代號（四碼／主題／公司名合併去重後） */
export const MAX_RELATED_STOCKS = 50;

/**
 * 產業推斷：僅在無四碼、無公司名、且未命中 `themes` 時套用，避免與既有主題重複或洗版。
 */
export const MAX_INDUSTRY_INFERENCE_STOCKS = 5;

/** 子字串比對：預設至少 3 字；2 字僅允許出現在 allowlist */
export const MIN_SUBSTRING_NAME_LEN = 3;

/**
 * 少數真實兩字公司簡稱（須與 Pilot_Reports 檔名一致）。
 * 空白則不開放任何兩字比對。
 */
export const NAME_MATCH_ALLOWLIST = new Set<string>([
  // 新聞常見兩字品牌（未進 Pilot 簡稱時仍要能命中）
  "王品",
]);

/**
 * 公司檔名／nameToTicker 的 key 若為常見新聞用語（地名、宏觀詞），
 * 子字串比對極易誤判（例：「世界量子日」命中「世界」）。
 * 此處列為精確比對封鎖；非公司名的短詞請優先加進來。
 */
export const NAME_MATCH_BLOCKLIST = new Set<string>([
  // 地理／區域
  "世界",
  "全球",
  "國際",
  "亞洲",
  "歐洲",
  "美洲",
  "非洲",
  "大洋洲",
  "歐盟",
  "北約",
  "東協",
  "東南亞",
  "東北亞",
  "大中華",
  "兩岸",
  "美中",
  "台海",
  "南海",
  "中國",
  "中華",
  "台灣",
  "臺灣",
  "美國",
  "日本",
  "韓國",
  "北韓",
  "南韓",
  "印度",
  "英國",
  "法國",
  "德國",
  "義大利",
  "西班牙",
  "俄羅斯",
  "加拿大",
  "澳洲",
  "澳大利亞",
  "紐西蘭",
  "新加坡",
  "香港",
  "澳門",
  "馬來西亞",
  "泰國",
  "越南",
  "印尼",
  "菲律賓",
  "緬甸",
  "柬埔寨",
  "寮國",
  "汶萊",
  "墨西哥",
  "巴西",
  "阿根廷",
  "智利",
  "南非",
  "埃及",
  "土耳其",
  "伊朗",
  "伊拉克",
  "以色列",
  "沙烏地",
  "阿聯酋",
  // 市場／政策用語（與公司全名重疊機率低）
  "央行",
  "聯準會",
  "金管會",
  "證交所",
  "櫃買",
  "期交所",
  "行政院",
  "立法院",
  "總統府",
  "大盤",
  "加權",
  "台股",
  "美股",
  "港股",
  "陸股",
  "股市",
]);

/**
 * 未在 reports-index 的簡稱 → 代號（仍須為有效上市櫃代號；用於相關行情）。
 * 若日後 Pilot 收錄同名公司，以 reports 的 nameToTicker 為準（merge 時後覆蓋）。
 */
export const NEWS_EXTRA_NAME_TO_TICKER: Record<string, string> = {
  王品: "2727",
  王品集團: "2727",
};

/** 未進 reports-index 時，相關行情顯示名稱 */
export const NEWS_TICKER_DISPLAY_LABEL: Record<string, string> = {
  "2727": "王品集團",
};

export type NewsThemeEntry = {
  id?: string;
  keywords: string[];
  tickers: string[];
};

export type NewsThemePayload = {
  version?: number;
  /** 高信心主題（量子、供應鏈關鍵字等）：命中即注入代號 */
  themes?: NewsThemeEntry[];
  /**
   * 產業／板塊關鍵字：僅在「無四碼、無公司名、且 themes 未命中」時注入代表股，
   * 用於泛談產業、未點名個股的新聞。
   */
  industryInference?: NewsThemeEntry[];
};

function rangesOverlap(
  s: number,
  e: number,
  used: readonly [number, number][]
): boolean {
  for (const [a, b] of used) {
    if (s < b && a < e) return true;
  }
  return false;
}

function findNeedleStarts(text: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let from = 0;
  while (from <= text.length) {
    const i = text.indexOf(needle, from);
    if (i === -1) break;
    out.push(i);
    from = i + 1;
  }
  return out;
}

/** 檔名 key 是否允許參與子字串比對（長度門檻 + blocklist + allowlist） */
export function isNameKeyEligibleForSubstring(name: string): boolean {
  if (name.length < 2) return false;
  if (NAME_MATCH_BLOCKLIST.has(name)) return false;
  if (name.length >= MIN_SUBSTRING_NAME_LEN) return true;
  return NAME_MATCH_ALLOWLIST.has(name);
}

/**
 * 新聞用：兩字簡稱若在 reports-index 有對應代號（豐興、漢翔…）一併允許比對，
 * 否則兩字仍須在 allowlist（避免誤判）。
 */
export function isNameKeyEligibleForNews(
  name: string,
  mergedNameToTicker: Record<string, string>,
  validAugmented: Set<string>
): boolean {
  if (name.length < 2) return false;
  if (NAME_MATCH_BLOCKLIST.has(name)) return false;
  if (name.length >= MIN_SUBSTRING_NAME_LEN) return true;
  if (NAME_MATCH_ALLOWLIST.has(name)) return true;
  const tk = mergedNameToTicker[name];
  if (name.length === 2 && tk && validAugmented.has(tk)) return true;
  return false;
}

function buildLengthHistogram(
  nameToTicker: Record<string, string>,
  mergedNameToTicker: Record<string, string>,
  validAugmented: Set<string>
): Map<number, number> {
  const m = new Map<number, number>();
  for (const name of Object.keys(nameToTicker)) {
    if (!isNameKeyEligibleForNews(name, mergedNameToTicker, validAugmented)) {
      continue;
    }
    const len = name.length;
    m.set(len, (m.get(len) || 0) + 1);
  }
  return m;
}

/** 同長度公司名數量愈多，該長度命中加權略降（降低短名誤判） */
function lengthCrowdingPenalty(nameLen: number, hist: Map<number, number>): number {
  const n = hist.get(nameLen) || 0;
  return Math.log2(2 + n) * 8;
}

function scoreNameOccurrence(
  name: string,
  start: number,
  titleLen: number,
  hist: Map<number, number>
): number {
  const inTitle = start < titleLen;
  let s = name.length * 120;
  if (inTitle) s += 200;
  else {
    s += 35;
    if (name.length === 3) s -= 80;
  }
  s -= lengthCrowdingPenalty(name.length, hist);
  return s;
}

type NameHit = {
  name: string;
  ticker: string;
  start: number;
  end: number;
  score: number;
};

/** 依關鍵字表（長詞優先）收集代號，總數上限由 maxTickers 控制 */
function collectTickersFromKeywordThemes(
  text: string,
  entries: NewsThemeEntry[] | undefined,
  validTickers: Set<string>,
  maxTickers: number
): string[] {
  if (!entries?.length || maxTickers <= 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const th of entries) {
    const kws = [...(th.keywords || [])].sort((a, b) => b.length - a.length);
    let hit = false;
    for (const kw of kws) {
      if (kw && text.includes(kw)) {
        hit = true;
        break;
      }
    }
    if (!hit) continue;
    for (const t of th.tickers || []) {
      const tk = String(t).trim();
      if (!validTickers.has(tk) || seen.has(tk)) continue;
      seen.add(tk);
      out.push(tk);
      if (out.length >= maxTickers) return out;
    }
  }
  return out;
}

function collectThemeTickers(
  text: string,
  payload: NewsThemePayload | null | undefined,
  validTickers: Set<string>
): string[] {
  return collectTickersFromKeywordThemes(
    text,
    payload?.themes,
    validTickers,
    MAX_RELATED_STOCKS
  );
}

function normalizeCompanyNameFromAnnouncement(raw: string): string {
  return raw
    .replace(/\r/g, "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 括號前誤判為公司簡稱（新聞體「耀穎（7772）」除外） */
const NEWS_PAREN_NAME_BLOCKLIST = new Set<string>([
  "本公司",
  "該公司",
  "此公司",
  "集團",
  "臺灣",
  "台灣",
  "董事會",
  "股東會",
  "發言人",
  "總經理",
  "董事長",
  "股份有限公司",
  "有限公司",
  "電動車",
  "半導體",
  "日公告今",
]);

/**
 * 四碼後接「年／年度」多為西元敘述（例：漢翔2025年配息），不應當成上市代號。
 */
function isFourDigitFollowedByYearParticle(
  text: string,
  indexAfterLastDigit: number
): boolean {
  const tail = text.slice(indexAfterLastDigit);
  return /^\s*年/.test(tail) || /^\s*年度/.test(tail);
}

/** 西元日期片段：2025/03、2025-03-15，不當上市代號 */
function isFourDigitWesternDateContinuation(
  text: string,
  indexAfterLastDigit: number
): boolean {
  const c = text.charAt(indexAfterLastDigit);
  return c === "/" || c === "-" || c === ".";
}

/** 「2025會計年度」「2024財報」等敘事用西元，非代號 2025 */
function isFourDigitFollowedByFiscalWord(
  text: string,
  indexAfterLastDigit: number
): boolean {
  const tail = text.slice(indexAfterLastDigit);
  return /^(會計|財務|財報)/.test(tail);
}

/**
 * 中文稿常見「（2025）」指西元年度；與上市代號 2025（千興）同形，括號內且為 2024–2027 時不採為四碼比對。
 * （2330）等一般代號不受影響。
 */
function isFourDigitLikelyCalendarYearInParens(
  text: string,
  indexFirstDigit: number,
  indexAfterLastDigit: number,
  ticker: string
): boolean {
  const n = parseInt(ticker, 10);
  if (!Number.isFinite(n) || n < 2024 || n > 2027) return false;
  const before = indexFirstDigit > 0 ? text.charAt(indexFirstDigit - 1) : "";
  const after = text.charAt(indexAfterLastDigit);
  const inParen =
    (before === "(" || before === "（") &&
    (after === ")" || after === "）");
  return inParen;
}

/**
 * 括號體「日公告今(2025)」等：括號內為西元 2024–2027 且左側像敘事碎片，多為誤判千興(2025)。
 */
function isLikelyYearInParenNoise(
  ticker: string,
  zhRaw: string
): boolean {
  const y = parseInt(ticker, 10);
  if (!Number.isFinite(y) || y < 2020 || y > 2035) return false;
  if (zhRaw.length < 3) return false;
  if (/公告|同期|年度|昨日|今日|本日|說明|較去/.test(zhRaw)) return true;
  return false;
}

/**
 * Yahoo／公開資訊觀測站風格：正文常有「公司名稱：保瑞(6472)」。
 * 此類代號應顯示相關行情，但公司未必已收錄於 reports-index（byTicker），
 * 不可再依 validTickers 過濾；/api/quote-batch 仍會以 6472.TW／TWO 查價。
 * `displayZhByTicker` 供無站內報告時顯示中文公司名（優先於 Yahoo 英文簡稱）。
 *
 * 另支援財經新聞常見「耀穎（7772）」「豐興(2015)」體例（不必有「公司名稱：」）。
 */
function extractExplicitLabeledMeta(text: string): {
  tickers: string[];
  displayZhByTicker: Record<string, string>;
} {
  const tickers: string[] = [];
  const displayZhByTicker: Record<string, string> = {};
  const seen = new Set<string>();

  /** 鉅亨／Yahoo 常見：3363-TW、2330.TW */
  const reTwListed = /(\d{4})[-.](?:TW|TWO)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = reTwListed.exec(text)) !== null) {
    const t = m[1];
    if (!/^\d{4}$/.test(t) || seen.has(t)) continue;
    seen.add(t);
    tickers.push(t);
  }

  const reCompany = /公司名稱[：:]\s*([\s\S]{0,400}?)[（(](\d{4})[）)]/g;
  while ((m = reCompany.exec(text)) !== null) {
    const zh = normalizeCompanyNameFromAnnouncement(m[1] || "");
    const t = m[2];
    if (!/^\d{4}$/.test(t) || !zh) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    tickers.push(t);
    displayZhByTicker[t] = zh;
  }

  const reNewsParen =
    /([\u4e00-\u9fff]{2,12})\s*[（(](\d{4})[）)]/g;
  while ((m = reNewsParen.exec(text)) !== null) {
    const zhRaw = (m[1] || "").trim();
    const t = m[2];
    if (!/^\d{4}$/.test(t) || !zhRaw) continue;
    if (NEWS_PAREN_NAME_BLOCKLIST.has(zhRaw)) continue;
    if (/公司名稱|主旨|說明[:：]/.test(zhRaw)) continue;
    if (isLikelyYearInParenNoise(t, zhRaw)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    tickers.push(t);
    displayZhByTicker[t] = zhRaw;
  }

  const tailPatterns: RegExp[] = [
    /證券(?:代碼|代号)[：:]\s*(\d{4})\b/g,
    /股票代號[：:]\s*(\d{4})\b/g,
  ];
  for (const re of tailPatterns) {
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const t = m[1];
      if (!/^\d{4}$/.test(t) || seen.has(t)) continue;
      seen.add(t);
      tickers.push(t);
    }
  }

  return { tickers, displayZhByTicker };
}

/** `resolveTickersFromText` 回傳：代號列表＋自公告解析之中文名（若有） */
export type ResolvedRelatedTickers = {
  tickers: string[];
  /** 自「公司名稱：…(代號)」等解析，無站內報告時供顯示 */
  displayZhByTicker: Record<string, string>;
};

function mergeTickerLists(
  digits: string[],
  themes: string[],
  names: string[]
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...digits, ...themes, ...names]) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_RELATED_STOCKS) break;
  }
  return out;
}

/** 非台股：國際商品／指數（Yahoo Finance 符號），依標題＋摘要關鍵字顯示 */
export type CommodityBenchmark = {
  symbol: string;
  labelZh: string;
};

/**
 * 標題是否以櫃買／上櫃指數為主題（此時不應被摘要裡的台積電等帶偏個股）。
 */
export function isOtcIndexHeadline(title: string): boolean {
  const t = title || "";
  return (
    /(櫃買|櫃檯|上櫃).{0,16}(指數|加權|市場)/.test(t) ||
    /(櫃買指數|櫃檯指數|櫃買市場|上櫃加權|櫃檯加權|櫃買加權)/.test(t)
  );
}

function twIndexBenchmarksForTitle(title: string): CommodityBenchmark[] {
  if (!isOtcIndexHeadline(title)) return [];
  return [{ symbol: "^TWOII", labelZh: "櫃檯指數" }];
}

/**
 * 新聞若提及金價、油價、貴金屬、貨運、櫃檯指數等，附加對應行情符號（與台股分開，可並存）。
 * 符號需與 /api/quote-batch 相容（含 GC=F、CL=F、^TWOII 等）。
 */
export function resolveCommodityBenchmarks(
  title: string,
  summary: string
): CommodityBenchmark[] {
  const text = `${title || ""}\n${summary || ""}`;
  const out: CommodityBenchmark[] = [];
  const seen = new Set<string>();
  const add = (symbol: string, labelZh: string) => {
    if (seen.has(symbol)) return;
    seen.add(symbol);
    out.push({ symbol, labelZh });
  };

  for (const b of twIndexBenchmarksForTitle(title || "")) {
    add(b.symbol, b.labelZh);
  }

  if (/貴金屬/.test(text)) {
    add("GC=F", "黃金期貨");
    add("SI=F", "白銀期貨");
  }
  if (/鉑金/.test(text)) add("PL=F", "鉑金期貨");
  if (/鈀金/.test(text)) add("PA=F", "鈀金期貨");
  if (/黃金|金價|國際金|金价/.test(text)) add("GC=F", "黃金期貨");
  if (/白銀|銀價|白银/.test(text)) add("SI=F", "白銀期貨");

  if (/(原油|油價|WTI|西德州|西德洲)/i.test(text)) add("CL=F", "WTI 原油");
  if (/布蘭特|布倫特|Brent/i.test(text)) add("BZ=F", "布蘭特原油");

  if (
    /BDI|波羅的海|乾散貨|海運運價|散裝運價|貨櫃運價|貨運價格|運價\b|航運指數|海運指數/.test(
      text
    )
  ) {
    add("BDRY", "乾散貨／海運 ETF（BDRY）");
  }

  return out;
}

/** 從財報 JSON 讀取 GICS 風格 sector／industry（schemaVersion 2） */
export function readFinancialsMeta(data: unknown): {
  sector: string;
  industry: string;
} | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  const sector = typeof o.sector === "string" ? o.sector.trim() : "";
  const industry = typeof o.industry === "string" ? o.industry.trim() : "";
  const bad = (s: string) => !s || s === "N/A";
  if (bad(sector) && bad(industry)) return null;
  return {
    sector: bad(sector) ? "" : sector,
    industry: bad(industry) ? "" : industry,
  };
}

/** 顯示括號內：優先 industry，其次 sector */
export function formatIndustryParen(
  fin: { sector: string; industry: string } | null,
  reportsSector?: string
): string {
  if (fin) {
    if (fin.industry) return fin.industry;
    if (fin.sector) return fin.sector;
  }
  if (reportsSector && reportsSector.trim()) return reportsSector.trim();
  return "";
}

/**
 * 由標題＋摘要解析台股代號與公司名。
 * - 公告／新聞括號：`公司名稱：…(1234)`、`耀穎（7772）`（未收錄於 reports-index 亦採用）。
 * - 四碼：須在 validTickers；**後接「年／年度」視為西元**（如漢翔2025年）不採為代號。
 * - 公司名子字串：**兩字簡稱**若在 Pilot 有代號（豐興、漢翔）可比對；主題／產業籃在**其後**。
 * - **國際**分類：不套用台股 `themes`／`industryInference`（避免國際新聞洗出台股代表股）。
 * - 主題／產業推斷：僅非國際、且無已解析個股／主題命中時，才注入代表股。
 */
export function resolveTickersFromText(
  title: string,
  summary: string,
  nameToTicker: Record<string, string>,
  validTickers: Set<string>,
  category: string,
  themePayload?: NewsThemePayload | null
): ResolvedRelatedTickers {
  const mergedNameToTicker: Record<string, string> = {
    ...NEWS_EXTRA_NAME_TO_TICKER,
    ...nameToTicker,
  };
  const validAugmented = new Set(validTickers);
  for (const t of Object.values(NEWS_EXTRA_NAME_TO_TICKER)) {
    validAugmented.add(t);
  }

  const titlePart = title || "";
  const summaryPart = summary || "";
  const text = `${titlePart}\n${summaryPart}`;
  const titleLen = titlePart.length;
  const isIntl = category === "國際";

  const explicitMeta = !isIntl
    ? extractExplicitLabeledMeta(text)
    : { tickers: [] as string[], displayZhByTicker: {} as Record<string, string> };
  const explicitLabeled = explicitMeta.tickers;
  const displayZhFromAnnouncement = explicitMeta.displayZhByTicker;

  const digitTickers: string[] = [];
  const digitSeen = new Set<string>();
  const used: [number, number][] = [];

  if (!isIntl) {
    const re = /\b(\d{4})\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const t = m[1];
      const idx = m.index ?? 0;
      const endIdx = idx + (m[0]?.length ?? 4);
      if (isFourDigitFollowedByYearParticle(text, endIdx)) continue;
      if (isFourDigitWesternDateContinuation(text, endIdx)) continue;
      const yNum = parseInt(t, 10);
      if (
        Number.isFinite(yNum) &&
        yNum >= 2020 &&
        yNum <= 2035 &&
        isFourDigitFollowedByFiscalWord(text, endIdx)
      ) {
        continue;
      }
      if (isFourDigitLikelyCalendarYearInParens(text, idx, endIdx, t)) {
        continue;
      }
      if (!validAugmented.has(t)) continue;
      if (digitSeen.has(t)) continue;
      if (digitTickers.length >= MAX_RELATED_STOCKS) break;
      digitSeen.add(t);
      digitTickers.push(t);
      used.push([idx, endIdx]);
    }
  }

  const themeList = isIntl
    ? []
    : collectThemeTickers(text, themePayload ?? null, validAugmented);

  const afterExplicitDigit = mergeTickerLists(
    explicitLabeled,
    digitTickers,
    []
  );
  const reserved = new Set(afterExplicitDigit);
  const slotsLeft = MAX_RELATED_STOCKS - afterExplicitDigit.length;

  const hist = buildLengthHistogram(
    mergedNameToTicker,
    mergedNameToTicker,
    validAugmented
  );

  const nameHits: NameHit[] = [];
  for (const name of Object.keys(mergedNameToTicker)) {
    if (!isNameKeyEligibleForNews(name, mergedNameToTicker, validAugmented)) {
      continue;
    }
    if (!text.includes(name)) continue;
    const ticker = mergedNameToTicker[name];
    if (!ticker || !validAugmented.has(ticker)) continue;

    const starts = findNeedleStarts(text, name);
    for (const start of starts) {
      const end = start + name.length;
      const score = scoreNameOccurrence(name, start, titleLen, hist);
      nameHits.push({ name, ticker, start, end, score });
    }
  }

  nameHits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.name.length !== a.name.length) return b.name.length - a.name.length;
    return a.name.localeCompare(b.name, "zh-Hant");
  });

  const nameTickers: string[] = [];
  const usedNameRanges: [number, number][] = [...used];

  for (const h of nameHits) {
    if (nameTickers.length >= slotsLeft) break;
    if (reserved.has(h.ticker)) continue;
    if (rangesOverlap(h.start, h.end, usedNameRanges)) continue;
    reserved.add(h.ticker);
    nameTickers.push(h.ticker);
    usedNameRanges.push([h.start, h.end]);
  }

  const hasExplicitStock =
    explicitLabeled.length > 0 ||
    digitTickers.length > 0 ||
    nameTickers.length > 0;
  const hasCuratedTheme = themeList.length > 0;
  let inferenceList: string[] = [];
  if (!hasExplicitStock && !hasCuratedTheme && !isIntl) {
    inferenceList = collectTickersFromKeywordThemes(
      text,
      themePayload?.industryInference,
      validAugmented,
      MAX_INDUSTRY_INFERENCE_STOCKS
    );
  }

  const tickers = mergeTickerLists(
    mergeTickerLists(
      mergeTickerLists(
        mergeTickerLists(explicitLabeled, digitTickers, []),
        nameTickers,
        []
      ),
      themeList,
      []
    ),
    inferenceList,
    []
  );
  return {
    tickers,
    displayZhByTicker: displayZhFromAnnouncement,
  };
}

export function changeClass(pct: number | null): "up" | "down" | "flat" {
  if (pct == null || !Number.isFinite(pct)) return "flat";
  if (pct > 0) return "up";
  if (pct < 0) return "down";
  return "flat";
}

export const DEFAULT_BENCHMARK_SYMBOL = "^TWII";
