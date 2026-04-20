/** 介面用：中文為主，括號內英文。 */

export function bi(zh: string, en: string): string {
  return `${zh}（${en}）`;
}

export const SITE = {
  name: "TWstock",
  taglineZh: "台股研究資料庫",
  taglineEn: "Taiwan equity research",
  desc: bi("台股研究報告瀏覽", "Browse equity research reports"),
} as const;

/** 全站頂部行情橫幅（/api/market-ticker） */
export const MARKET_TICKER = {
  ariaRegion: bi(
    "主要指數、櫃檯、匯率、商品與加密資產（延遲行情；橫幅自動捲動）",
    "Indices, OTC, FX, commodities, crypto (delayed; auto-scrolling ticker)"
  ),
  loading: bi("載入市場行情中…", "Loading market data…"),
  unavailable: "—",
} as const;

export const NAV = {
  industries: "產業",
  graph: "供應鏈網路圖",
} as const;

export const HOME = {
  title: bi("台股研究資料庫", "Taiwan equity research database"),
  subtitle: bi(
    "依產業瀏覽研究報告，支援代號／公司名搜尋與 wikilink 跳轉",
    "Browse sectors, search tickers and names, follow wikilinks"
  ),
  searchLabel: bi("搜尋代號或公司名", "Search ticker or company"),
  searchPlaceholder: "2330、台積電 / TSMC…",
  sectorList: bi("產業列表", "Sectors"),
  filesUnit: bi("檔", "reports"),
  noResults: bi("沒有符合的項目", "No matches"),
  indexLoading: bi("正在載入公司索引…", "Loading company index…"),
  indexError: bi("無法載入搜尋索引，請重新整理頁面。", "Could not load search index. Refresh the page."),
} as const;

export const REPORT = {
  breadcrumbHome: bi("首頁", "Home"),
  breadcrumbSectors: bi("產業", "Industries"),
  summaryAria: bi("摘要", "Summary"),
  businessIntroAria: bi("業務簡介", "Business introduction"),
  board: bi("板塊", "Sector (GICS-style)"),
  industry: bi("產業", "Industry"),
  marketCap: bi("市值", "Market cap"),
  enterpriseValue: bi("企業價值", "Enterprise value"),
  note: bi("備註", "Note"),
  valuationAria: bi("估值指標", "Valuation"),
  annualRevTitle: bi("年度營收趨勢（百萬台幣）", "Annual revenue (NT$ millions)"),
  annualRevAria: bi("年度營收柱狀圖", "Annual revenue bars"),
  /** 來自 financials/{ticker}.json，欄位可較 Markdown 表多 */
  annualRevJsonTitle: bi(
    "年度營收（結構化資料，多年）",
    "Annual revenue from structured data (multi-year)"
  ),
  annualRevJsonAria: bi(
    "依 yfinance 匯出之 JSON 年度營收",
    "Annual revenue bars (financials JSON)"
  ),
  sectorPeerRevenueHint: bi(
    "同產業最近年度營收（百萬台幣）參考：P25 {p25} · 中位數 {p50} · P75 {p75}（樣本 {n} 檔）",
    "Sector latest annual revenue (NT$M): P25 {p25} · median {p50} · P75 {p75} (n={n})"
  ),
  sectorPeerRevenueRank: bi(
    "本檔最近年度營收約高於同產業 {pct}% 的樣本（僅含已匯出 financials JSON 者）。",
    "This report’s latest annual revenue is above ~{pct}% of sector peers with financials JSON."
  ),
  quarterlyRevTitle: bi("近三十二季營收（百萬台幣）", "Last 32 quarters revenue (NT$ millions)"),
  quarterlyRevAria: bi("季度營收柱狀圖", "Quarterly revenue bars"),
  annualGmTitle: bi("年度毛利率（%）", "Annual gross margin (%)"),
  annualGmAria: bi("年度毛利率柱狀圖", "Annual gross margin bars"),
  quarterlyGmTitle: bi("近三十二季毛利率（%）", "Last 32 quarters gross margin (%)"),
  quarterlyGmAria: bi("季度毛利率柱狀圖", "Quarterly gross margin bars"),
  chartRevenueToggleLabel: bi(
    "顯示相對前期變動（%）",
    "Show change vs prior period (%)"
  ),
  annualRevGrowthTitle: bi(
    "年度營收：相對前一年變動（%）",
    "Annual revenue YoY change (%)"
  ),
  annualRevGrowthAria: bi(
    "年度營收年增率柱狀圖",
    "Annual revenue YoY change bars"
  ),
  quarterlyRevGrowthTitle: bi(
    "季度營收：相對前一季變動（%）",
    "Quarterly revenue QoQ change (%)"
  ),
  quarterlyRevGrowthAria: bi(
    "季度營收季增率柱狀圖",
    "Quarterly revenue QoQ change bars"
  ),
  jsonAnnualRevGrowthTitle: bi(
    "年度營收（JSON）：相對前一年變動（%）",
    "Annual revenue YoY from JSON (%)"
  ),
  jsonAnnualRevGrowthAria: bi(
    "JSON 年度營收年增率",
    "Annual revenue YoY bars from JSON"
  ),
  chartMarginToggleLabel: bi(
    "顯示與前期差（百分點）",
    "Show change vs prior (percentage points)"
  ),
  annualGmPptTitle: bi(
    "年度毛利率：與前一年差（百分點）",
    "Annual gross margin YoY change (ppt)"
  ),
  annualGmPptAria: bi("毛利率年變動（百分點）柱狀圖", "Gross margin YoY change (ppt) bars"),
  quarterlyGmPptTitle: bi(
    "季度毛利率：與前一季差（百分點）",
    "Quarterly gross margin QoQ change (ppt)"
  ),
  quarterlyGmPptAria: bi(
    "毛利率季變動（百分點）柱狀圖",
    "Gross margin QoQ change (ppt) bars"
  ),
  /** 財務表上方說明（僅中文） */
  finTableKeyHint:
    "年度表最多 8 年、季度表最多 32 季（有 financials JSON 時由 JSON 欄位重建）；欄位由新到舊（最新在左）。「當季合併」：各欄皆為該季單季數據，EPS 為該季每股盈餘（元／股）。「累積合併」：同日曆年內自第一季起逐季加總（例：Q2 欄＝Q1＋Q2）；EPS 為同年單季 EPS 加總之近似值（股數各季不同時與財報加權 EPS 可能不同）。可切換「金額」或「占營收%」。金額單位百萬台幣；假設來源季表為單季口徑。三項費用若單季金額為負且附「*」，多為公開資訊觀測站累計口徑反累計後之年末調整／重分類，可將滑鼠移至該格查看說明。",
  /** 財務表分段切換：金額（僅中文，避免按鈕過寬貼邊） */
  finTableModeAmount: "金額",
  /** 財務表分段切換：占營收% */
  finTableModePct: "占營收%",
  /** 財務表切換群組（無障礙標籤，僅中文） */
  finTableModeAria: "切換顯示金額或占營收%",
  /** 季度表：單季合併口徑 */
  finTableConsolidationSingle: "當季合併",
  /** 季度表：同日曆年累積 YTD */
  finTableConsolidationYtd: "累積合併",
  /** 季度表當季／累積切換（無障礙） */
  finTableConsolidationAria: "切換當季合併或累積合併財務數據",
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
  valuationPriceFail: bi("無法取得延遲行情股價，下方倍數為報告原文。", "Delayed quote unavailable; ratios are from the report."),
  valuationLiveNote: bi(
    "倍數已依延遲行情股價相對於報告基準股價比例調整（假設財務數字不變）。",
    "Multiples scaled by delayed price vs. the report baseline (fundamentals held constant)."
  ),
  /** 估值卡片互動說明（鍵盤可聚焦；觸控裝置可點按顯示說明） */
  valuationInteractHint: bi(
    "將游標移至卡片或鍵盤聚焦可查看說明；觸控裝置可點按卡片切換說明。",
    "Hover or focus a card for a short definition; tap to toggle on touch devices."
  ),
  /** Yahoo/JSON 缺值、改由 MD 估值表補上時之說明前綴（後接 mdBaselineLabel） */
  valuationMdFallbackIntro: bi(
    "※ 標有「估值」之欄位取自報告內 MD 估值表；資料基準：",
    "※ Fields tagged “Valuation” are from the MD table in the report; baseline: "
  ),
  /** 小標僅顯示「估值」，不加英文括號 */
  valuationMdChipBadge: "估值",
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
  nav: "主題投資",
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
  nav: "關鍵字探索",
  title: bi("反向探索（關鍵字）", "Reverse discovery"),
  lead: bi(
    "搜尋報告全文，找出提到該關鍵字的上市櫃公司（延遲載入、需 Node 執行 /api）。",
    "Full-text search across reports (loads via API; requires Node for /api/discover)."
  ),
  placeholder: bi("例如：液冷散熱、CPO、CoWoS…", "e.g. liquid cooling, CPO…"),
  searchBtn: bi("搜尋", "Search"),
  searching: bi("搜尋中…", "Searching…"),
  tooShort: bi("請至少輸入 2 個字元。", "Enter at least 2 characters."),
  noResults: bi("資料庫中無匹配報告。", "No matching reports in the database."),
  /** 以 {n} 取代筆數 */
  foundFormat: bi("共 {n} 筆匹配", "{n} matches"),
  cliHint: bi(
    "若需自動標記 wikilink、重建主題／網路圖，或關鍵字不在庫內時由本機腳本＋ AI 擴充，請在專案根目錄執行：",
    "To tag wikilinks, rebuild themes/network, or enrich via local scripts / AI, run from repo root:"
  ),
  cliCode: 'python scripts/discover.py "關鍵字"   # 可加 --apply --rebuild',
  apiError: bi(
    "搜尋服務暫時無法使用。靜態託管環境沒有 API 時，請以本機執行 npm run dev／preview，或改用下方指令列工具。",
    "Search API unavailable. Use npm run dev or preview locally, or the CLI below on static hosting."
  ),
} as const;

/** 財經新聞聚合（/news、/api/news） */
export const NEWS_PAGE = {
  nav: "新聞",
  title: "財經新聞",
  lead: "聚合台灣主要財經媒體即時標題（來源為第三方 RSS／公開 API；完整內容與版權以原站為準）。",
  loading: "載入新聞中…",
  error: "暫時無法載入新聞，請稍後再試。",
  loadMore: "載入更多",
  sourceFilterAria: "新聞來源篩選",
  categoryAll: "全部",
  categoryTw: "台股",
  categoryIntl: "國際",
  categoryTech: "科技",
  categoryIndustry: "產業",
  categoryFinance: "財經",
  updated: "更新",
  sourceStatsLabel: "各來源筆數（篩選後）",
  noMatch: "目前沒有符合篩選條件的新聞。",
  relatedMarket: bi("相關行情", "Related quotes"),
  readOriginal: "閱讀原文",
  disclaimer:
    "本頁僅聚合公開連結與摘要，不儲存全文；新聞內容、圖像與商標歸各媒體所有。",
} as const;

export const FOOTER = {
  source: bi("資料來源", "Data source"),
  disclaimer: bi(
    "本網站內容僅供資訊參考，不構成投資建議或買賣邀約。財務與股價資料可能有誤差、延遲或遺漏，使用時請自行查證。",
    "For information only — not investment advice. Financial and price data may be delayed, incomplete, or inaccurate; verify before acting."
  ),
} as const;

/** 延遲行情（Yahoo Finance，需 hybrid + Node 執行 API） */
export const RELATION = {
  title: "關係摘要",
  supply: bi("供應鏈位置", "Supply chain"),
  customers: bi("主要客戶", "Key customers"),
  suppliers: bi("主要供應商", "Key suppliers"),
  revenue: bi("營收結構", "Revenue structure"),
  competitors: bi("主要競爭對手", "Competitors"),
  hint: bi("以下為報告節錄，完整敘述與表格見下方正文。", "Excerpt from the report; full text below."),
} as const;

export const WIKI_STUB = {
  nav: bi("實體索引", "Entity index"),
  badge: bi("非上市公司／無個股報告", "Not a listed TW ticker report"),
  aliases: bi("詞彙變體", "Label variants"),
  mentions: bi("提及此主題的上市櫃報告", "Reports that mention this topic"),
  backToWiki: bi("返回 Wikilink 索引", "Back to wikilink index"),
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
  loading: bi("載入行情資料中…", "Loading quote…"),
  error: bi("暫時無法取得行情，請稍後再試或檢查網路連線。", "Quote temporarily unavailable. Retry later or check your connection."),
  last: bi("最近價", "Last"),
  prevClose: bi("昨收", "Prev close"),
  change: bi("漲跌", "Change"),
  pct: bi("漲跌幅", "Change %"),
  asOf: bi("時間", "As of"),
  na: "—",
  delayedShort: bi("延遲約 15 分鐘", "delayed ~15 min"),
  peShort: bi("本益比", "P/E"),
  pbShort: bi("股價淨值比", "P/B"),
  evEbitdaShort: bi("企業價值倍數", "EV/EBITDA"),
  chartTitle: bi("近九十日收盤走勢", "90-day closing price"),
  chartUnavailable: bi("無法載入走勢資料", "Price chart unavailable"),
  chartHigh90: bi("近90日高", "90d high"),
  chartLow90: bi("近90日低", "90d low"),
  chartAvgVol: bi("區間均量", "Avg volume"),
  chartLastDate: bi("最後交易日", "Last session"),
  /** QuoteStrip 頂部：Yahoo quoteSummary（卡片標題僅中文） */
  insiderHold: "內部人持股",
  instHold: "機構持股",
  divYield: "殖利率",
  holdingsStripAria: bi(
    "內部人持股、機構持股、殖利率（Yahoo quoteSummary）",
    "Insider / institutional ownership and dividend yield (Yahoo quoteSummary)"
  ),
  /** QuoteStrip：最後一根 K 線 OHLC + 量 */
  midOpen: bi("開", "O"),
  midHigh: bi("高", "H"),
  midLow: bi("低", "L"),
  midClose: bi("收", "C"),
  midVol: bi("成交量", "vol"),
  range90Label: bi("90日區間", "90d range"),
  /** K 線圖均線圖例（與圖上顏色對應） */
  ma5Leg: bi("5 日均線", "5-day MA"),
  ma10Leg: bi("10 日均線", "10-day MA"),
  ma20Leg: bi("20 日均線", "20-day MA"),
} as const;
