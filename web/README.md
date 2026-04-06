# myTWstock Web（Astro 前端）

依 [規劃](../README.md) 的 Phase A：產業列表、公司報告頁、`[[wikilink]]` 對應台股檔案名時轉為連結、首頁代號／公司名搜尋、內嵌 `network/` 圖。

## 需求

- Node.js 18+（建議 **20+**；`yahoo-finance2` v3 官方建議 Node 22+）
- 上層目錄須為完整 clone（含 `Pilot_Reports/`；`network/` 可選，會複製到 `public/network`）
- **延遲行情**：專案為 **hybrid**（`output: "hybrid"` + `@astrojs/node`），報告頁會呼叫 **`GET /api/quote/[代號]`**，後端向 **Yahoo Finance** 取延遲免費報價；**純靜態託管（如僅上傳 `dist/client`）無法使用此 API**，需以 Node 執行 build 產物（見下）。

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

`preview` 會啟動 **含 API 的 Node 伺服器**，報告頁上的「延遲行情」區塊才會成功載入。若僅打開靜態 HTML 檔案，行情會顯示失敗。

## 延遲行情（免費）

- 顯示位置：各 `/report/[代號]` 頁面「估值」區塊下方。
- 資料來源：**Yahoo Finance**（與 Python `yfinance` 同源概念；**延遲**，常見約 15–20 分鐘，僅供參考）。
- 代號會依序嘗試 **`{代號}.TW`**、**`{代號}.TWO`**（上市／上櫃）。
- API 有 **60 秒** 快取（`Cache-Control`）。
- **`yahoo-finance2` v3** 須先 `new YahooFinance()` 再呼叫 `quote()`；若 API 未正確實例化，瀏覽器會一直顯示「無法取得行情」。

## 建置時發生什麼事

`predev` / `prebuild` 會依序執行：

- `scripts/build-index.mjs`：掃描 `../Pilot_Reports/**/*.md` → `public/data/reports-index.json`，並複製 `../network` → `public/network`（`/graph`）
- `scripts/build-wikilink-hub.mjs` → `public/data/wikilink-hub-top500.json`（`/wiki`）
- `scripts/build-themes-index.mjs`：讀取上層 `themes/*.md` → `public/data/themes-index.json`（`/themes`）

## Wikilink 行為

- 若 `[[名稱]]` 與某報告檔名 `代號_名稱.md` 的「名稱」相同，會連到 `/report/代號`
- 其餘顯示為虛線提示（國際公司、技術詞等）

## 報告頁深化內容

- **介面**：主要導覽與標籤為 **中文（English）** 並列（`Bi.astro` + `src/lib/ui.ts`）
- **頁首**：代號 · 公司名、產業標籤 + `GICS-style industry` 英文提示
- **摘要卡**：自「業務簡介」解析板塊、產業、市值、企業價值、備註（雙語欄名）
- **估值**：各指標 **中文簡稱 + 英文縮寫**（本益比 / P/E 等）；股價列會以 **`/api/quote` 延遲行情**換算倍數（需 Node；見 `ValuationSection.astro`）
- **圖表（2×2 網格）**：年度營收、近四季營收、年度毛利率、近四季毛利率（皆自 Markdown 表解析；營收單位百萬台幣，毛利率為 %）
- **側欄**：目錄、相關台股、**同產業其他公司**（最多 18 筆 + 連到完整產業頁）、供應鏈網路圖
- Markdown 內第一個 `#` 標題僅視覺隱藏，避免與頁首重複

- **主題投資**：`/themes`（上游／中游／下游，資料來自 `themes/*.md`）
- **關鍵字探索**：`/discover` + **`GET /api/discover?q=`**（掃描 `Pilot_Reports` 全文；需 hybrid／Node，與 CLI `scripts/discover.py` 互補）
- **Wikilink 索引**：`/wiki`
