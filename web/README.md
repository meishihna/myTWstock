# myTWstock Web（Astro 前端）

依 [規劃](../README.md) 的 Phase A：產業列表、公司報告頁、`[[wikilink]]` 對應台股檔案名時轉為連結、首頁代號／公司名搜尋、內嵌 `network/` 圖。

## 需求

- Node.js 18+（建議 **20+**；`yahoo-finance2` v3 官方建議 Node 22+）
- 上層目錄須為完整 clone（含 `Pilot_Reports/`；`network/` 可選，會複製到 `public/network`）
- **延遲行情**：專案為 **hybrid**（`output: "hybrid"` + `@astrojs/node`），報告頁會呼叫 **`GET /api/quote/[代號]`**，後端向 **Yahoo Finance** 取延遲免費報價；**純靜態託管（如僅上傳 `dist/client`）無法使用此 API**，需以 Node 執行 build 產物（見下）。

## 正式網址（canonical / OG / sitemap）

建置與部署前建議設定環境變數 **`PUBLIC_SITE_URL`**（含 `https://`、**不要**結尾斜線），例如：

```bash
set PUBLIC_SITE_URL=https://your-domain.com
npm run build
```

- `astro.config.mjs` 會用此值作為 `site`（canonical、Open Graph 絕對網址）。
- **`postbuild`** 會執行 `scripts/generate-sitemap.mjs`：掃描 `dist/client` 內已輸出的 HTML，寫入 **`dist/client/sitemap.xml`**，並覆寫 **`dist/client/robots.txt`**（內含 `Sitemap: …/sitemap.xml`）。未設定時預設為 `http://localhost:4321`，僅適合本機驗證。
- 部分社群預覽爬蟲對 **`og:image` 的 SVG 支援不佳**；若分享預覽異常，可改放 **1200×630 PNG**（例如 `public/og-default.png`）並在 `Layout.astro` 調整預設圖路徑。

## 指令

```bash
cd web
npm install
npm run dev
```

瀏覽器開終端機顯示的網址（預設 http://localhost:4321）。

正式打包預覽：

```bash
npm run build
npm run preview
```

`build` 結束後會自動跑 **`postbuild`** 產生 sitemap／robots。`preview` 會啟動 **含 API 的 Node 伺服器**，報告頁上的「延遲行情」區塊才會成功載入。若僅打開靜態 HTML 檔案，行情會顯示失敗。

## 延遲行情（免費）

- 顯示位置：各 `/report/[代號]` 頁面「估值」區塊下方。
- 資料來源：**Yahoo Finance**（與 Python `yfinance` 同源概念；**延遲**，常見約 15–20 分鐘，僅供參考）。
- 代號會依序嘗試 **`{代號}.TW`**、**`{代號}.TWO`**（上市／上櫃）。
- API 有 **60 秒** 快取（`Cache-Control`）。
- **`yahoo-finance2` v3** 須先 `new YahooFinance()` 再呼叫 `quote()`；若 API 未正確實例化，瀏覽器會一直顯示「無法取得行情」。

## 生產環境快取與標頭（建議）

部署在 **Node adapter（standalone）** 或反向代理後方時，可依資產類型調整快取，減輕頻寬並避免 API 被過度快取：

- **靜態資源**（`/_astro/*`、`*.css`、`*.js`、圖片、字體）：可設較長的 `Cache-Control`（例如 `public, max-age=31536000, immutable` 給帶 hash 的檔名）。
- **HTML 頁面**：建議 `Cache-Control: public, max-age=0, must-revalidate` 或短 `max-age`，以便內容更新較快反映。
- **`/api/*`**：維持程式內既有的短快取或 `private`，不要讓 CDN 長期快取個人化或即時性差的報價回應。

實際鍵值請依主機（Cloudflare、Nginx、Vercel 等）設定；重點是 **靜態長快取、HTML 與 API 保守**。

## 建置時發生什麼事

`predev` / `prebuild` 會依序執行：

- `scripts/build-index.mjs`：掃描 `../Pilot_Reports/**/*.md` → `public/data/reports-index.json`，並複製 `../network` → `public/network`（`/graph`）
- `scripts/build-wikilink-hub.mjs` → `public/data/wikilink-hub-top500.json`（`/wiki` 高頻條目）
- `scripts/build-wikilink-stubs.mjs` → `public/data/wikilink-stubs.json`（其餘非上市公司 wikilink 的 stub 路由）
- `scripts/build-themes-index.mjs`：讀取上層 `themes/*.md` → `public/data/themes-index.json`（`/themes`）
- `scripts/build-sector-stats.mjs`：讀取 `public/data/financials/*.json` → `public/data/sector-stats.json`（同業營收分位；**須先**在專案根執行 `python scripts/update_financials.py` 產出 JSON）

## 結構化財務 JSON

- 執行 **`python scripts/update_financials.py`** 更新報告內 `## 財務概況` 時，會同步寫入 **`public/data/financials/{代號}.json`**（預設與 Markdown 同為 **近 5 年**、季度 JSON 最多可較 MD 多幾季）。
- 腳本會 **自動**向 [FinMind](https://finmind.github.io/) 公開 API 拉台股綜合損益／現金流量，與 Yahoo 合併（**Yahoo 數字優先**），以補滿近 12 季等歷史；環境變數 **`MYTWSTOCK_FINMIND=0`** 可關閉。可選 `data/financial_supplements/{代號}.json` 再覆寫或補缺。
- 報告頁年度營收僅 **一張圖**：若 `financials/{代號}.json` 的年度營收期數 **不少於** Markdown 表，則圖表讀 JSON（期數較完整）；否則讀 Markdown，避免與 JSON 重複兩張年度營收圖。

## Wikilink 行為

- 若 `[[名稱]]` 與某報告檔名 `代號_名稱.md` 的「名稱」相同，會連到 `/report/代號`
- 其餘連到 **`/wiki/{slug}`**：前 500 高頻為完整列表頁；其餘為 **stub 頁**（標示非上市公司、列出提及該主題的台股報告）

## 報告頁深化內容

- **介面**：主要導覽與標籤為 **中文（English）** 並列（`Bi.astro` + `src/lib/ui.ts`）
- **頁首**：代號 · 公司名、產業標籤 + `GICS-style industry` 英文提示
- **摘要卡**：自「業務簡介」解析板塊、產業、市值、企業價值、備註（雙語欄名）
- **估值**：各指標 **中文簡稱 + 英文縮寫**（本益比 / P/E 等）；股價列會以 **`/api/quote` 延遲行情**換算倍數（需 Node；見 `ValuationSection.astro`）
- **圖表（2×2 網格）**：年度營收、季度營收、年度毛利率、季度毛利率（資料來自 Markdown 表或 `financials` JSON；預設 **近 5 年／近 12 季** 由 `update_financials.py` 寫入）
- **側欄**：目錄、相關台股、**同產業其他公司**（最多 18 筆 + 連到完整產業頁）、供應鏈網路圖
- Markdown 內第一個 `#` 標題僅視覺隱藏，避免與頁首重複

- **主題投資**：`/themes`（上游／中游／下游，資料來自 `themes/*.md`）
- **關鍵字探索**：`/discover` + **`GET /api/discover?q=`**（掃描 `Pilot_Reports` 全文；需 hybrid／Node，與 CLI `scripts/discover.py` 互補）
- **Wikilink 索引**：`/wiki`
