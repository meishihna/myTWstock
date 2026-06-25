# TWstock｜台股研究資料庫

將上市櫃公司研究整理成**可搜尋、可連結、可瀏覽**的資料庫：產業分類下的 Markdown 報告、`[[wikilink]]` 交錯成網、主題與供應鏈分層，以及 **Astro** 網站（產業／報告／選股器／自選比較／財經新聞 NLP／延遲行情與財務儀表板）。

---

## 這個專案能做什麼

| 面向 | 說明 |
|------|------|
| **報告** | `Pilot_Reports/` 依產業存放 `代號_公司名.md`：業務、供應鏈、客供；財務表與估值由 JSON 提供。 |
| **Wikilink** | 報告內 `[[台積電]]`、`[[CoWoS]]` 等連結；建索引與探索工具，形成主題、公司關聯與共現圖。 |
| **財經新聞 + NLP** | `/news` 聚合 8 大來源即時標題；**本地 NLP**：情緒（利多／利空）、題材／Wikilink 標籤、跨來源事件聚類；外加 **Claude Code 每日簡報**（keyless）。 |
| **選股器／比較** | `/screener` 依估值與三率等門檻篩選 1,700+ 檔；`/watchlist` 自選、`/compare` 並排比較。 |
| **行情** | 報告頁延遲日線（Yahoo Chart v8）、K 線＋成交量＋均線、互動式 OHLCV；**SSR 記憶體快取**（需 Node）。 |
| **財務** | **MOPS 市場級批次**為骨幹，寫入 `data/financials_store/{代號}.json`（8 年／32 季）；報告頁 **FinancialDashboard** 讀取。 |

---

## 專案結構（精簡）

```
├── README.md / CLAUDE.md       # 本檔 / 撰寫與品質規範
├── requirements.txt            # Python 依賴
├── Pilot_Reports/              # 報告 Markdown（依產業分子資料夾）
├── data/financials_store/      # 結構化財務 JSON（8 年／32 季,MOPS 為主）
├── themes/                     # 主題投資 Markdown（build_themes.py 產頁）
├── scripts/                    # Python 維護／產報 + PowerShell 工具
├── web/                        # Astro 4 + @astrojs/node（hybrid）
│   ├── src/                    # 頁面、元件、lib（新聞 NLP、行情快取、圖表幾何…）
│   ├── scripts/                # build-data 索引產生器、測試
│   └── public/data/            # build 產生的索引 JSON、新聞情緒詞典／每日簡報
├── .claude/skills/             # 斜線技能（add-ticker、update-enrichment、news-digest…）
└── WIKILINKS.md                # wikilink 索引（由腳本重建）
```

---

## 環境需求

- **Python 3.10+**：維護報告與財務資料
- **Node.js 18+**（建議 20+）：建置與執行 `web/`

```bash
pip install -r requirements.txt
```

---

## Python：常用指令

```bash
# 新增一檔
python scripts/add_ticker.py 2330 台積電 --sector Semiconductors

# 更新財務（單檔／批次／產業／全市場;MOPS 為主,Yahoo/FinMind 補漏）
python scripts/update_financials.py 2330
python scripts/update_financials.py --batch 101

# 僅刷新估值表（較快）
python scripts/update_valuation.py 2330

# 套用預先準備的 enrichment JSON
python scripts/update_enrichment.py --data enrichment.json 2330

# 品質稽核
python scripts/audit_batch.py --all -v

# 關鍵字探索（全文）
python scripts/discover.py "液冷散熱" --smart

# 重建 wikilink 索引與主題頁
python scripts/build_wikilink_index.py
python scripts/build_themes.py
```

**財務資料**：以 **MOPS（公開資訊觀測站）市場級批次**為骨幹，缺漏時以 **FinMind／Yahoo** 補；寫入 `data/financials_store/{代號}.json`。權杖、節流與開關變數見 **`scripts/update_financials.py` 檔頭註解**。
> ⚠️ 無 `FINMIND_TOKEN` 時請勿全市場跑 `update_financials.py`（會以稀疏資料覆蓋 8 年／32 季歷史）。

---

## Web 前端（Astro）

```bash
cd web
npm install
npm run dev          # http://localhost:4321
```

- **頁面**：首頁搜尋、`/sectors` 產業、`/screener` 選股、`/watchlist` 自選、`/compare` 比較、`/themes` 主題投資、`/discover` 探索、`/news` 財經新聞、`/wiki` Wikilink 索引、`/report/[代號]` 報告。
- **輸出模式**：`output: "hybrid"` + **Node adapter**（standalone）— 靜態頁預渲染，`/api/*`（news、quote-batch、bars…）在 Node 執行；純靜態託管無法還原完整行為。
- **建置前索引**：`prebuild`／`predev` 掃描報告、wikilink、主題、產業統計、選股索引寫入 `public/data/`。
- **正式站**：設定 **`PUBLIC_SITE_URL`**（含 `https://`、無結尾斜線），供 canonical／OG／sitemap。

### 財經新聞 NLP + 每日簡報

- **即時層（免金鑰、隨 5 分鐘新聞快取算一次）**：情緒、題材／Wikilink 標籤、跨來源事件聚類 — 規則／詞典式，位於 `web/src/lib/news-nlp.ts`；測試 `npm run test:news-nlp`、`npm run test:news-resolve`。
- **每日簡報（keyless）**：`/news-digest` 技能由 **Claude Code 生成**（不需 `ANTHROPIC_API_KEY`），寫入 `web/public/data/news-digest.json`；runtime 只讀，缺檔自動隱藏不壞頁。
- **自動更新**：`scripts/refresh-news-digest.ps1` + Windows 工作排程器（每日；無頭代理工具僅限 Read／Write）。
- **桌面捷徑**：`scripts/open-site.ps1` —— 點擊自動啟動 dev server 並開站。

更細的指令、快取標頭與資料流見 **`web/README.md`**。

---

## 資料來源與限制

- **股價／圖表**：Yahoo Finance（**延遲**，常見約 15–20 分鐘；僅供參考）。
- **財務數值**：以 **MOPS** 市場級批次為主，搭配 **FinMind／Yahoo** 補漏。
- **新聞**：第三方 **RSS／公開 API** 聚合（鉅亨、經濟日報、工商時報、自由時報、科技新報、財經新報、商業周刊、Yahoo 股市）；完整內容與版權以原站為準。
- **敘述內容**：研究當下整理，**不會**因股價自動更新；更新請走 enrichment／編修流程。

---

## 品質與貢獻

- 撰寫與機械化檢查請遵守 **`CLAUDE.md`**。
- 提交前建議執行 **`python scripts/audit_batch.py`** 相關範圍。
- Wikilink 請使用**具體專有名詞**，避免泛稱占位。

---

## 授權

**MIT License**（見 `LICENSE`）。公開數據之著作權屬原提供者；專案內文字為研究整理，轉載請自行留意來源與法遵。
