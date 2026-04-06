# myTWstock｜台股研究資料庫

結構化台股研究資料庫，涵蓋 **1,735 家** 上市櫃公司（上市＋上櫃），分屬 **99 個產業分類**。每份報告含業務簡介、供應鏈位置、客戶／供應商關係與財務數據，並透過 **4,900+ 個 `[[wikilink]]`** 交錯連結，形成可搜尋的知識網路。

## 為什麼要做這個

台股上市櫃超過 1,800 家，其中許多是全球供應鏈關鍵節點（半導體、電子、汽車、紡織等）。公開資訊分散在中文法說、投資人簡報與產業報告中。本專案將研究整理成**一致、可搜尋**的格式。

**Wikilink 網路是核心。** 搜尋 `[[Apple]]` 可看到 207 家與蘋果供應鏈相關的台廠；搜尋 `[[CoWoS]]` 可看到台積電先進封裝生態；搜尋 `[[光阻液]]` 可對應該材料的供應與需求端公司。

## 快速開始

### 環境需求

```bash
pip install yfinance pandas tabulate
```

### 瀏覽報告

報告為 Markdown，依產業資料夾存放：

```
Pilot_Reports/
├── Semiconductors/           (155 檔)
│   ├── 2330_台積電.md
│   ├── 2454_聯發科.md
│   └── ...
├── Electronic Components/    (267 檔)
├── Computer Hardware/        (114 檔)
└── ...（共 99 個產業資料夾）
```

每份報告結構一致，例如：

```markdown
# 2330 - [[台積電]]

## 業務簡介
**板塊:** Technology
**產業:** Semiconductors
**市值:** 47,326,857 百萬台幣
**企業價值:** 44,978,990 百萬台幣

[繁體中文敘述，內含 [[wikilinks]]...]

## 供應鏈位置
**上游:** [[ASML]], [[Applied Materials]], [[SUMCO]]...
**中游:** **台積電** (晶圓代工)
**下游:** [[Apple]], [[NVIDIA]], [[AMD]], [[Broadcom]]...

## 主要客戶及供應商
### 主要客戶
- [[Apple]], [[NVIDIA]], [[AMD]], [[Qualcomm]]...
### 主要供應商
- [[ASML]], [[Tokyo Electron]], [[Shin-Etsu]]...

## 財務概況
### 估值指標
| P/E (TTM) | Forward P/E | P/S (TTM) | P/B | EV/EBITDA |
（yfinance 估值倍數）

### 年度/季度財務數據
（近 3 年年度表、近 4 季季度表，含 14 項指標）
```

### 新增一檔股票

```bash
python scripts/add_ticker.py 2330 台積電
python scripts/add_ticker.py 2330 台積電 --sector Semiconductors
```

### 更新財務數據

```bash
python scripts/update_financials.py 2330                        # 單一檔
python scripts/update_financials.py 2330 2454 3034              # 多檔
python scripts/update_financials.py --batch 101                 # 依批次
python scripts/update_financials.py --sector Semiconductors     # 依產業
python scripts/update_financials.py                             # 全市場
```

### 僅更新估值（較快）

只刷新「估值指標」表（P/E、Forward P/E、P/S、P/B、EV/EBITDA、股價），不重拉完整財報，速度約為 `update_financials` 的 **3 倍**。

```bash
python scripts/update_valuation.py 2330
python scripts/update_valuation.py --batch 101
python scripts/update_valuation.py --sector Semiconductors
python scripts/update_valuation.py
```

### 更新充實內容（Enrichment）

先準備 JSON，再套用：

```bash
python scripts/update_enrichment.py --data enrichment.json 2330
python scripts/update_enrichment.py --data enrichment.json --batch 101
python scripts/update_enrichment.py --data enrichment.json --sector Semiconductors
```

JSON 格式範例：

```json
{
  "2330": {
    "desc": "台積電為全球最大晶圓代工廠，專注於 [[CoWoS]]、[[3奈米]] 先進製程...",
    "supply_chain": "**上游:**\n- [[ASML]]...\n**中游:**\n- **台積電**...\n**下游:**\n- [[Apple]]...",
    "cust": "### 主要客戶\n- [[Apple]]...\n\n### 主要供應商\n- [[ASML]]..."
  }
}
```

### 品質稽核

```bash
python scripts/audit_batch.py 101 -v      # 單一批次
python scripts/audit_batch.py --all -v    # 全部批次
```

稽核項目包含：至少 8 個 wikilink、括號內非泛稱、無占位符、無不當英文、metadata 完整、章節深度等。

### 重建 Wikilink 索引

```bash
python scripts/build_wikilink_index.py
```

會重新產生 [WIKILINKS.md](WIKILINKS.md)（依類型分類的 4,900+ wikilink 索引）。在 enrichment 更新後建議重跑。

### 關鍵字反向探索（Discover）

聽到新名詞？一次找出資料庫裡所有相關上市櫃公司。

```bash
python scripts/discover.py "液冷散熱"                    # 全產業搜尋
python scripts/discover.py "液冷散熱" --smart            # 自動篩選較相關產業
python scripts/discover.py "液冷散熱" --apply            # 在報告中加上 [[wikilink]]
python scripts/discover.py "液冷散熱" --apply --rebuild  # 並重建主題頁 + 網路圖
python scripts/discover.py "液冷散熱" --sector Semiconductors  # 限定產業
```

結果會依關係類型分組並附上下文摘要。`--smart` 會略過與科技題材較無關的產業（如部分金融、不動產）。

### 產生 Wikilink 網路圖

互動式 D3 力導向圖：共現 wikilink、懸停高亮、搜尋、可調整邊權重門檻。

```bash
python scripts/build_network.py                    # 預設：最少共現 5 次
python scripts/build_network.py --min-weight 10    # 邊較少、畫面較乾淨
python scripts/build_network.py --top 200          # 只保留前 200 節點
```

以瀏覽器開啟 `network/index.html`。節點顏色：紅＝台灣公司、藍＝國際公司、綠＝技術、橘＝材料、紫＝應用（依專案設定為準）。

### 產生主題投資頁

```bash
python scripts/build_themes.py               # 全部 20 個主題
python scripts/build_themes.py "CoWoS"       # 單一主題
python scripts/build_themes.py --list        # 列出可用主題
```

輸出於 [themes/](themes/)：依**上游／中游／下游**分組的供應鏈地圖。完整索引見 [themes/README.md](themes/README.md)。

## Token 用量與成本說明

工具分兩類：**Python 腳本**（本機免費）與 **Claude Code 技能**（呼叫 AI 時消耗 API token）。

### 免費｜Python 腳本（不耗 Token）

於本機執行 Python + yfinance，無 AI、無額外 API 費用。

| 腳本 | 指令 | 說明 |
|---|---|---|
| 更新財務 | `python scripts/update_financials.py [範圍]` | 自 yfinance 刷新財務表 |
| 更新估值 | `python scripts/update_valuation.py [範圍]` | 僅刷新 P/E、P/B、EV/EBITDA 等（快） |
| 更新充實 | `python scripts/update_enrichment.py --data <json> [範圍]` | 套用預先準備的 enrichment |
| 稽核 | `python scripts/audit_batch.py <batch> -v` | 報告品質檢查 |
| Discover | `python scripts/discover.py "<關鍵字>"` | 全文關鍵字搜尋 |
| 主題頁 | `python scripts/build_themes.py` | 產生主題供應鏈頁 |
| 網路圖 | `python scripts/build_network.py` | 產生 D3 互動圖 |
| Wikilink 索引 | `python scripts/build_wikilink_index.py` | 重建 WIKILINKS.md |

### 消耗 Token｜Claude Code 技能（需 AI）

需 [Claude Code](https://claude.ai/claude-code)，並會消耗 API token。

| 斜線指令 | Token 用量 | 說明 |
|---|---|---|
| `/add-ticker 2330 台積電` | 中 | 產生 .md + 拉財務 + **AI 研究** 業務／供應鏈／客供 |
| `/update-enrichment 2330` | 中 | **AI 重新研究** 並改寫業務內容（保留財務表） |
| `/discover 液冷散熱` | 低～高 | 先掃資料庫（免費）→ 無結果時 **AI 上網** 並充實報告 |

**成本大致來自：**  
- `/add-ticker`：每檔約 1 次網搜 + 內容生成  
- `/update-enrichment`：每檔約 3～5 次網搜 + 綜合  
- `/discover` 有結果：**0 token**（僅 Python）  
- `/discover` 無結果：依研究深度而定  

**建議：** 大量批次以 Python 為主；單檔或需要 AI 研究時再用斜線指令。

## Wikilink 圖譜

完整索引：**[WIKILINKS.md](WIKILINKS.md)**

資料庫含 **4,900+** 個不重複 wikilink，大致分三類：

| 類別 | 範例 | 用途 |
|---|---|---|
| **公司** | `[[台積電]]`, `[[Apple]]`, `[[Bosch]]` | 供應鏈關係 |
| **技術** | `[[CoWoS]]`, `[[HBM]]`, `[[矽光子]]`, `[[EUV]]` | 技術生態系參與者 |
| **材料** | `[[光阻液]]`, `[[碳化矽]]`, `[[ABF 載板]]` | 材料供需 |

### 被引用次數較高的實體（節錄）

| 實體 | 提及次數 | 可看出什麼 |
|---|---|---|
| `[[台積電]]` | 469 | 台灣半導體生態以台積電為核心 |
| `[[NVIDIA]]` | 277 | AI 供應鏈與輝達零組件 |
| `[[Apple]]` | 207 | 蘋果在台供應網路 |
| `[[AI 伺服器]]` | 237 | AI 伺服器供應鏈 |
| `[[電動車]]` | 223 | 電動車零組件 |
| `[[5G]]` | 232 | 5G 基礎建設相關公司 |
| `[[PCB]]` | 263 | 印刷電路板生態 |

## 專案結構

```
├── CLAUDE.md                  # 專案規則與品質標準
├── WIKILINKS.md               # Wikilink 索引（自動產生）
├── task.md                    # 批次定義與進度
├── requirements.txt           # Python 依賴
├── README.md
├── web/                       # Astro 前端（瀏覽器介面）
├── scripts/
│   ├── utils.py
│   ├── add_ticker.py
│   ├── update_financials.py
│   ├── update_enrichment.py
│   ├── audit_batch.py
│   ├── update_valuation.py
│   ├── discover.py
│   ├── build_wikilink_index.py
│   ├── build_themes.py
│   ├── build_network.py
│   └── generators/
├── Pilot_Reports/             # 1,735 檔報告，99 產業
├── network/                   # 互動網路圖（自動產生）
│   ├── index.html
│   └── graph_data.json
├── themes/                    # 主題投資頁（自動產生）
│   ├── README.md
│   ├── CoWoS.md
│   ├── AI_伺服器.md
│   ├── NVIDIA.md
│   └── ...（20 個主題）
└── .claude/skills/            # Claude Code 技能定義
```

## 品質標準

每份報告需符合 `CLAUDE.md` 中 8 項規則（摘要）：

1. Wikilink 須為**具體專有名詞**，不可為泛稱如「供應商」「大廠」  
2. **代號與公司名**以檔名為準  
3. 每份至少 **8 個** wikilink  
4. **財務表**在 enrichment 流程中不可被改壞  
5. 內容以**繁體中文**為主  
6. 完稿**不可有占位符**  
7. **Metadata 完整**（板塊、產業、市值、企業價值）  
8. 供應鏈須**分段**（上游／中游／下游）

目前稽核：**1,733 / 1,733（100%）** 通過品質檢查。

## 資料來源

- **財務數據**：[yfinance](https://github.com/ranaroussi/yfinance)（Yahoo Finance 台股）  
- **業務內容**：公司 IR、公開資訊觀測站、法說會、年報等  
- **供應鏈**：產業報導、新聞、公司揭露  

## 限制

- 財務資料依 yfinance 可得性，部分上櫃標的可能缺漏  
- 業務敘述為研究當下快照，**不會自動更新**  
- Wikilink 多為人工策展，新技術／新公司需手動或流程補上  
- 內容以繁中為主，英文讀者需自行翻譯  

## Wikilink 命名慣例

| 類別 | 建議形式 | 範例 |
|---|---|---|
| 台灣公司 | 中文 | `[[台積電]]`, `[[鴻海]]`, `[[聯發科]]` |
| 外國公司 | 英文 | `[[NVIDIA]]`, `[[Samsung]]`, `[[Micron]]` |
| 材料／基板 | 中文 | `[[碳化矽]]`, `[[氮化鎵]]`, `[[電動車]]` |
| 產業縮寫 | 縮寫 | `[[PCB]]`, `[[CPO]]`, `[[HBM]]`, `[[CoWoS]]` |

別名會在寫入流程中盡量**正規化**為慣用寫法。

## 參與貢獻

歡迎 PR／Issue。新增或修改報告時請：

1. 遵守 `CLAUDE.md`  
2. 提交前執行 `python scripts/audit_batch.py --all -v`  
3. 每個 `[[wikilink]]` 皆為具體專有名詞  
4. 公司名與代號一致  

## 授權

MIT License，詳見 [LICENSE](LICENSE)。

財務數據經 yfinance 取自 Yahoo Finance；業務描述為專案內研究整理。
