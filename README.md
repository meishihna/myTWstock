# myTWstock｜台股研究資料庫

將上市櫃公司研究整理成**可搜尋、可連結、可瀏覽**的資料庫：產業分類下的 Markdown 報告、`[[wikilink]]` 交錯成網、主題與供應鏈視覺化，以及 **Astro** 網站（產業／報告／圖表／延遲行情與財務儀表板）。

---

## 這個專案能做什麼

| 面向 | 說明 |
|------|------|
| **報告** | `Pilot_Reports/` 內依產業存放 `代號_公司名.md`：業務、供應鏈、客供、財務表與估值欄位。 |
| **Wikilink** | 報告內 `[[台積電]]`、`[[CoWoS]]` 等連結；建索引與探索工具，形成主題與公司關聯。 |
| **網站** | `web/`：產業列表、報告頁、主題投資、探索、wikilink 索引、內嵌供應鏈網路圖等。 |
| **行情** | 報告頁延遲日線（Yahoo Chart v8）、K 線＋成交量、5/10/20 日均線；**SSR 記憶體快取**（非純靜態託管需 Node）。 |
| **財務圖表** | `update_financials.py` 產出 `web/public/data/financials/{代號}.json`，報告頁 **FinancialDashboard** 等元件讀取。 |

---

## 專案結構（精簡）

```
├── README.md                 # 本檔
├── requirements.txt        # Python 依賴
├── CLAUDE.md                 # 撰寫／品質規範（若存在）
├── Pilot_Reports/            # 報告 Markdown（依產業分子資料夾）
├── web/                      # Astro 4 + @astrojs/node（hybrid）
│   ├── src/                  # 頁面、元件、lib（行情快取、圖表幾何等）
│   ├── public/data/          # build 腳本產生的 JSON、financials 等
│   └── README.md             # 前端建置、環境變數、API 說明
├── scripts/                  # Python 維護與產報流程
├── themes/                   # 主題投資 Markdown（`build_themes.py` 產頁）
├── network/                  # 互動網路圖輸出（`build_network.py`）
└── WIKILINKS.md              # wikilink 索引（由腳本重建）
```

---

## 環境需求

- **Python 3.10+**（建議）：維護報告與財務資料  
- **Node.js 18+**（建議 20+）：建置與執行 `web/`

```bash
pip install -r requirements.txt
```

---

## Python：常用指令

```bash
# 新增一檔（範例）
python scripts/add_ticker.py 2330 台積電
python scripts/add_ticker.py 2330 台積電 --sector Semiconductors

# 更新財務（單檔／多檔／批次／產業／全市場）
python scripts/update_financials.py 2330
python scripts/update_financials.py --batch 101
python scripts/update_financials.py --sector Semiconductors

# 僅刷新估值表（較快）
python scripts/update_valuation.py 2330
python scripts/update_valuation.py

# 套用預先準備的 enrichment JSON
python scripts/update_enrichment.py --data enrichment.json 2330

# 品質稽核
python scripts/audit_batch.py 101 -v
python scripts/audit_batch.py --all -v

# 關鍵字探索（全文）
python scripts/discover.py "液冷散熱"
python scripts/discover.py "液冷散熱" --smart

# 重建 wikilink 索引、主題頁、網路圖
python scripts/build_wikilink_index.py
python scripts/build_themes.py
python scripts/build_network.py
```

**FinMind 與財務 JSON**：`update_financials.py` 可合併 Yahoo／FinMind 與補充檔，寫入 `web/public/data/financials/{代號}.json`。權杖、節流與開關變數請見 **`scripts/update_financials.py` 檔頭註解** 與 `web/README.md`「結構化財務 JSON」一節。

---

## Web 前端（Astro）

```bash
cd web
npm install
npm run dev
```

- **輸出模式**：`output: "hybrid"` + **Node adapter**（standalone）— 靜態頁面預渲染，`/api/*` 在 Node 上執行。  
- **延遲行情**：報告頁 **QuoteStrip** 於建置／請求時向 Yahoo Chart v8 取 OHLCV（含 MA 暖身資料）；估值區塊等仍可能呼叫 **`/api/quote`**。純上傳靜態檔無法還原完整行為，請以 **`npm run build` 後的 Node 程序** 或具 API 的託管方式部署。  
- **建置前索引**：`prebuild`／`predev` 會掃描報告、wikilink、主題、產業統計等寫入 `public/data/`。  
- **正式站**：建議設定 **`PUBLIC_SITE_URL`**（含 `https://`、無結尾斜線），供 canonical、OG、`postbuild` 產生之 sitemap／robots。

更細的指令、快取標頭建議與資料流見 **`web/README.md`**。

---

## 資料來源與限制

- **股價／圖表**：Yahoo Finance（**延遲**，常見約 15–20 分鐘；僅供參考）。  
- **財務數值**：以 **yfinance** 等為主，並可搭配 **FinMind** 與專案內補充 JSON。  
- **敘述內容**：研究當下整理，**不會**因股價自動更新；更新請走 enrichment／編修流程。  

---

## 品質與貢獻

- 撰寫與機械化檢查請遵守 **`CLAUDE.md`**（若專案內有定義）。  
- 提交前建議執行 **`python scripts/audit_batch.py`** 相關範圍。  
- Wikilink 請使用**具體專有名詞**，避免泛稱占位。

---

## 授權

**MIT License**（見 `LICENSE`）。公開數據之著作權屬原提供者；專案內文字為研究整理，轉載請自行留意來源與法遵。
