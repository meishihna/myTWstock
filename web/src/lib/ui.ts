/** 介面用：中文為主，括號內英文。 */

export function bi(zh: string, en: string): string {
  return `${zh}（${en}）`;
}

export const SITE = {
  name: "My-TW-Coverage",
  taglineZh: "台股覆蓋資料庫",
  taglineEn: "Taiwan listed coverage",
  desc: bi("台股研究報告瀏覽", "Browse equity research reports"),
} as const;

export const NAV = {
  industries: bi("產業", "Industries"),
  graph: bi("供應鏈網路圖", "Supply-chain graph"),
} as const;

export const HOME = {
  title: bi("台股覆蓋資料庫", "Taiwan coverage database"),
  subtitle: bi(
    "依產業瀏覽報告，支援代號／公司名搜尋與 wikilink 跳轉",
    "Browse by sector, search tickers & names, follow wikilinks"
  ),
  searchLabel: bi("搜尋代號或公司名", "Search ticker or company"),
  searchPlaceholder: "2330、台積電 / TSMC…",
  sectorList: bi("產業列表", "Sectors"),
  filesUnit: bi("檔", "reports"),
  noResults: bi("沒有符合項目", "No matches"),
} as const;

export const REPORT = {
  breadcrumbHome: bi("首頁", "Home"),
  breadcrumbSectors: bi("產業", "Industries"),
  summaryAria: bi("摘要", "Summary"),
  board: bi("板塊", "Sector (GICS-style)"),
  industry: bi("產業", "Industry"),
  marketCap: bi("市值", "Market cap"),
  enterpriseValue: bi("企業價值", "Enterprise value"),
  note: bi("備註", "Note"),
  valuationAria: bi("估值指標", "Valuation"),
  annualRevTitle: bi("年度營收趨勢（百萬台幣）", "Annual revenue (NT$ millions)"),
  annualRevAria: bi("年度營收柱狀圖", "Annual revenue bars"),
  quarterlyRevTitle: bi("近四季營收（百萬台幣）", "Last 4 quarters revenue (NT$ millions)"),
  quarterlyRevAria: bi("季度營收柱狀圖", "Quarterly revenue bars"),
  annualGmTitle: bi("年度毛利率（%）", "Annual gross margin (%)"),
  annualGmAria: bi("年度毛利率柱狀圖", "Annual gross margin bars"),
  quarterlyGmTitle: bi("近四季毛利率（%）", "Last 4 quarters gross margin (%)"),
  quarterlyGmAria: bi("季度毛利率柱狀圖", "Quarterly gross margin bars"),
  tocTitle: bi("目錄", "On this page"),
  relatedTitle: bi("相關台股", "Linked TW listings"),
  peersTitle: bi("同產業其他公司", "Peers in same industry"),
  peersMore: bi("查看完整產業列表", "View full sector list"),
  graphCta: bi("供應鏈網路圖", "Supply-chain graph"),
  graphHint: bi(
    "於圖中搜尋公司或關鍵字，檢視共現關係",
    "Search names in the graph to see co-mentions"
  ),
  valuationPriceLoading: bi("正在載入延遲行情股價…", "Loading delayed quote…"),
  valuationPriceFail: bi("無法取得即時股價，下方倍數為報告原文。", "Quote unavailable; ratios are from the report."),
  valuationLiveNote: bi(
    "倍數已依延遲行情股價相對於報告基準股價比例調整（假設財務數字不變）。",
    "Multiples scaled by delayed price vs. the report baseline (fundamentals held constant)."
  ),
} as const;

export const SECTORS_PAGE = {
  breadcrumb: bi("產業", "Industries"),
  title: bi("產業列表", "All sectors"),
  countPrefix: bi("共", "Total"),
  countSuffix: bi("個產業分類", "sectors"),
} as const;

export const SECTOR_DETAIL = {
  tickerCol: bi("代號", "Ticker"),
  companyCol: bi("公司", "Company"),
  reportsUnit: bi("檔", "reports"),
  sectorNote: bi("GICS 風格產業分類", "GICS-style sector name"),
} as const;

export const GRAPH_PAGE = {
  breadcrumb: bi("供應鏈網路圖", "Supply-chain graph"),
  hint: bi(
    "D3 力導向圖：可搜尋節點、懸停高亮、調整共現權重門檻；資料來自全庫 wikilink 共現。",
    "D3 force graph: search nodes, hover highlight, edge-weight threshold; data from wikilink co-mentions."
  ),
} as const;

export const THEMES_PAGE = {
  nav: bi("主題投資", "Thematic investing"),
  title: bi("主題投資供應鏈", "Theme supply chains"),
  lead: bi(
    "依題材彙整上市櫃公司，並區分上游／中游／下游（資料由 build_themes.py 產出）。",
    "Themes with companies grouped upstream / midstream / downstream (from build_themes.py)."
  ),
  countLabel: bi("涵蓋家數", "Companies"),
  related: bi("相關主題", "Related themes"),
  tierUp: bi("上游", "Upstream"),
  tierMid: bi("中游", "Midstream"),
  tierDown: bi("下游", "Downstream"),
  empty: bi("此分類無公司", "No companies"),
  indexEmpty: bi(
    "尚無主題索引（請先執行建置以產生 themes-index.json）。",
    "No theme index yet — run the build to generate themes-index.json."
  ),
} as const;

export const DISCOVER_PAGE = {
  nav: bi("關鍵字探索", "Discover"),
  title: bi("反向探索（關鍵字）", "Reverse discovery"),
  lead: bi(
    "搜尋報告全文，找出提到該關鍵字的上市櫃公司（延遲載入、需 Node 執行 /api）。",
    "Full-text search across reports (loads via API; requires Node for /api/discover)."
  ),
  placeholder: bi("例如：液冷散熱、CPO、CoWoS…", "e.g. liquid cooling, CPO…"),
  searchBtn: bi("搜尋", "Search"),
  noResults: bi("資料庫中無匹配報告。", "No matching reports in the database."),
  /** 以 {n} 取代筆數 */
  foundFormat: bi("共 {n} 筆匹配", "{n} matches"),
  cliHint: bi(
    "若需自動標記 wikilink、重建主題／網路圖，或關鍵字不在庫內時由本機腳本＋ AI 擴充，請在專案根目錄執行：",
    "To tag wikilinks, rebuild themes/network, or enrich via local scripts / AI, run from repo root:"
  ),
  cliCode: 'python scripts/discover.py "關鍵字"   # 可加 --apply --rebuild',
} as const;

export const FOOTER = {
  source: bi("資料來源", "Data source"),
} as const;

/** 延遲行情（Yahoo Finance，需 hybrid + Node 執行 API） */
export const RELATION = {
  title: bi("關係摘要", "Relationship summary"),
  supply: bi("供應鏈位置", "Supply chain"),
  customers: bi("主要客戶", "Key customers"),
  suppliers: bi("主要供應商", "Key suppliers"),
  competitors: bi("主要競爭對手", "Competitors"),
  hint: bi("以下為報告節錄，完整敘述與表格見下方正文。", "Excerpt from the report; full text below."),
} as const;

export const WIKI = {
  nav: bi("Wikilink 索引", "Wikilink hub"),
  title: bi("Wikilink 索引（高頻前 500）", "Top 500 wikilinks"),
  lead: bi(
    "依全庫 [[wikilink]] 出現次數排序，點選可查看相關上市櫃公司。",
    "Sorted by co-mentions across reports; click through for related TW listings."
  ),
  count: bi("次", "mentions"),
  companies: bi("相關公司", "Companies"),
  empty: bi("無資料", "No data"),
} as const;

export const QUOTE = {
  title: bi("延遲行情", "Delayed quote"),
  sourceNote: bi(
    "Yahoo Finance 免費延遲報價（常見約 15–20 分鐘延遲，僅供參考）",
    "Yahoo Finance delayed (~15–20 min typical; indicative only)"
  ),
  loading: bi("載入中…", "Loading…"),
  error: bi("無法取得行情（請稍後再試或檢查網路）", "Quote unavailable"),
  last: bi("最近價", "Last"),
  prevClose: bi("昨收", "Prev close"),
  change: bi("漲跌", "Change"),
  pct: bi("漲跌幅", "Change %"),
  asOf: bi("時間", "As of"),
  na: "—",
} as const;
