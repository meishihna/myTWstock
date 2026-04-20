# TWstock Web（Astro）

本目錄為 **Astro 4** 網站，與上層 **`Pilot_Reports/`**、**`scripts/`** 產出之 JSON 搭配運作。總覽與 Python 管線請見 [**根目錄 README.md**](../README.md)。

---

## 需求

- **Node.js 18+**（建議 20+）
- 上層 repo 須含 **`Pilot_Reports/`**；`network/` 可選（建置時會複製到 `public/network`）

---

## 指令

```bash
cd web
npm install
npm run dev
```

```bash
npm run build
npm run preview
```

- **`build`** 會跑 `prebuild`（索引、wikilink hub、主題、產業統計等），結束後 **`postbuild`** 產生 `dist/client/sitemap.xml` 與 `robots.txt`。  
- **`preview`** 啟動 **含 `/api/*` 的 Node 伺服器**；若只開本機靜態 HTML，部分依賴 API 的區塊會無法載入。

---

## 正式站環境變數

建置／部署前建議：

```bash
set PUBLIC_SITE_URL=https://your-domain.com
npm run build
```

- `astro.config.mjs` 的 `site` 用於 canonical、Open Graph。  
- 未設定時預設 `http://localhost:4321`，僅適合本機驗證。

---

## 延遲行情與 API

- **報告頁 K 線**：`QuoteStrip` 於 **SSR** 透過 `src/lib/priceCache.ts` 請求 Yahoo Chart v8（**5 分鐘記憶體快取**），含 OHLCV 與 5/10/20 日均線暖身資料。  
- **估值等**：部分元件仍使用 **`GET /api/quote/[代號]`**（實作於 `src/pages/api/`）。  
- **全站頂部行情列**（位於導覽列下方、**非 sticky**，隨頁面捲動）：`MarketTickerBar` 呼叫 **`GET /api/market-ticker`**（台加權、S&P 500、道瓊、日經指數、台幣兌美元、VIX、黃金 `GC=F`、原油 `CL=F`；含近月日線 **sparkline**；載入 **淡入**、捲動上移 **淡出**；**60 秒**快取 + `Cache-Control`）。  
- 專案為 **`output: "hybrid"`** + **`@astrojs/node`**；純靜態託管無法完整提供上述行為。

---

## 建置時產生的資料（`prebuild` / `predev`）

| 腳本 | 輸出（`public/` 下） |
|------|----------------------|
| `build-index.mjs` | `data/reports-index.json`；複製 `network/` |
| `build-wikilink-hub.mjs` | `data/wikilink-hub-top500.json` |
| `build-wikilink-stubs.mjs` | `data/wikilink-stubs.json` |
| `build-themes-index.mjs` | `data/themes-index.json` |
| `build-sector-stats.mjs` | `data/sector-stats.json`（需先有 `data/financials/*.json`） |

---

## 結構化財務 JSON（`public/data/financials/`）

由上層 **`python scripts/update_financials.py`** 寫入。可合併 Yahoo、**FinMind**（JWT／帳密與節流變數見 **`scripts/update_financials.py` 檔頭**）、以及選用 **`data/financial_supplements/{代號}.json`**。

報告頁 **FinancialDashboard**、營收圖等優先讀 JSON（期數足夠時），與 Markdown 表互補。

---

## Wikilink 行為（摘要）

- 若 `[[名稱]]` 對應到報告檔 **`代號_名稱.md`** → 連至 **`/report/代號`**  
- 其餘 → **`/wiki/...`**（高頻為列表頁，其餘 stub）

---

## 快取標頭（部署建議）

- 帶 hash 的 `/_astro/*`、CSS、JS、圖片：可長快取。  
- HTML：短快取或 `must-revalidate`。  
- **`/api/*`**：勿讓 CDN 長期快取即時性差的個股回應。
