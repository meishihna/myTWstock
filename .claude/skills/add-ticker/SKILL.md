---
name: add-ticker
description: Add a new ticker to the coverage database with enrichment research
user-invocable: true
---

# Add Ticker

Add a new Taiwan-listed company to the coverage database. Generates the .md report file，然後研究並充實業務簡介、供應鏈、客戶供應商。財報數據由 MOPS 管線自動處理，不在 .md 中產生。

## Usage

- `/add-ticker 2330 台積電` — auto-detect sector from yfinance
- `/add-ticker 2330 台積電 --sector Semiconductors` — specify sector

## Instructions

### Step 1: Generate the base file

From the **repository root** (this project folder):

```bash
python scripts/add_ticker.py <ticker> <name> [--sector <sector>]
```

This creates the .md file with metadata and placeholder enrichment sections.**不產生財務表** — 財報數據由 MOPS 管線（sb04/sb06/sb20/t164）自動處理，存在 `data/financials_store/{ticker}.json`，前端直接從 JSON 讀取。

### Step 2: Research

For each ticker, run **at least 5 次不同角度的搜尋**：

1. `[Ticker] 法說會 2025` — 最新法說會簡報、營收結構
2. `[Ticker] 年報 主要客戶 供應商` — 年報揭露的客戶供應商
3. `[Company Name] 營收比重 產品組合` — 各業務線營收佔比
4. `[Company Name] 競爭優勢 護城河` — 技術門檻、市佔率、專利
5. `[Company Name] supplier customer supply chain` — 英文來源補充

**VERIFY**: 確認研究的公司與檔名中的公司名一致（Golden Rule #2）。

### Step 3: Write enrichment — 業務簡介（最重要）

業務簡介必須包含以下 **5 個面向**，每個面向至少 1-2 句話：

#### A. 公司定位與核心業務
- 公司做什麼、在產業鏈中扮演什麼角色
- 成立年份、總部地點（如有意義）
- 市佔率、全球排名（如有公開數據）

#### B. 營收結構（必須有）
- 按產品線或業務別的營收佔比（例如：「晶圓代工佔營收約 85%，光罩業務約 10%，封測服務約 5%」）
- 按終端應用的營收佔比（例如：「HPC 佔 44%、智慧手機 33%、IoT 10%、車用 8%」）
- 按地區的營收佔比（例如：「北美佔 65%、亞太 20%、中國 10%」）
- **如果找不到精確數據，用「約」或「超過」等詞彙估算，不要完全省略**

**重要：營收結構的數據同時要以結構化格式寫入 `revenue_mix` 欄位（見 Step 5），`desc` 文字中的營收結構段落用於閱讀，`revenue_mix` 用於前端圖表渲染。兩者內容必須一致。**

#### C. 核心技術與競爭優勢
- 關鍵技術能力（用 [[wikilink]] 標注具體技術名稱）
- 與競爭對手的差異化（技術領先幾代、良率優勢、規模優勢）
- 專利、認證、獨家能力
- 進入門檻（資本密集度、技術壁壘、客戶轉換成本）

#### D. 成長動能與未來展望
- 近 1-2 年的主要成長驅動力
- 新產品、新產能、新客戶的佈局
- 產業趨勢如何受益（[[AI]]、[[電動車]]、[[5G]] 等）
- 資本支出計畫（如有揭露）

#### E. 風險因素（簡短帶過）
- 主要營運風險 1-2 項（客戶集中度、景氣循環、地緣政治等）

#### 範例（以台積電為例，這是目標品質）

```
[[台積電]] 成立於 1987 年，總部位於[[新竹]]科學園區，為全球最大專業積體電路製造服務公司（Pure-play Foundry），全球晶圓代工市佔率超過 60%，遙遙領先第二名的 [[三星電子]]（約 12%）與 [[聯電]]（約 6%）。

**營收結構方面**，依平台別區分：高效能運算（HPC）佔營收約 44%，智慧型手機約 33%，[[物聯網]]約 6%，車用電子約 5%，[[消費性電子]]約 5%，其他約 7%（2024 年）。依製程別：5 奈米及以下先進製程貢獻營收逾 50%，7 奈米約 17%，成熟製程（16nm 以上）約 33%。依地區：北美佔約 68%，中國約 11%，亞太約 12%，歐洲約 6%。

**核心技術與競爭優勢方面**，[[台積電]]掌握全球最先進的 [[EUV]] 微影製程，目前量產 3 奈米（N3），積極研發 2 奈米（N2，預計 2025 年下半量產）及 A16（背面供電）。先進封裝技術方面，[[CoWoS]]（Chip-on-Wafer-on-Substrate）為 [[NVIDIA]] [[AI]] GPU 的關鍵封裝平台，[[InFO]]（Integrated Fan-Out）廣泛用於 [[Apple]] 處理器。公司 2024 年研發支出超過 2,000 億台幣，全球員工逾 7 萬人。進入門檻極高——一座先進晶圓廠投資逾 200 億美元，良率與量產經驗需 3-5 年累積。

**成長動能方面**，[[AI]] 伺服器對先進製程與 [[CoWoS]] 封裝的需求為近兩年最大成長引擎。公司持續擴充 [[CoWoS]] 月產能，預計 2025 年底達 4 萬片以上。海外佈局方面，美國亞利桑那廠（4nm/3nm）預計 2025 年投產，日本熊本廠（[[JASM]]，與 [[Sony]]、[[Denso]] 合資）已於 2024 年開始量產。此外，2 奈米（N2）將於 2025 年下半進入量產，為智慧手機與 HPC 帶來新一輪升級需求。

主要風險包括客戶集中度偏高（前五大客戶佔營收逾 50%）、地緣政治風險（兩岸關係）及全球[[半導體]]景氣循環波動。
```

**注意：不是每家公司都能寫到這麼詳細。但至少要涵蓋 A（定位）+ B（營收結構）+ C（競爭優勢）三個面向。D（成長動能）和 E（風險）視資料可得性盡量補充。**

### Step 4: Write enrichment — 供應鏈 + 客戶供應商

（這部分跟原本一樣，遵循 CLAUDE.md Golden Rules）

供應鏈必須分段（上游/中游/下游），每段按業務類別細分，用 [[wikilink]] 標注具體公司和技術名稱。

客戶供應商按業務別分組，有佔比數據的一定要寫。

### Step 5: Apply enrichment

將 enrichment 寫成 JSON，**必須包含 `revenue_mix` 結構化欄位**：

```json
{
  "XXXX": {
    "desc": "完整的繁體中文業務簡介（含營收結構、競爭優勢、成長動能）...",
    "supply_chain": "**上游 (設備/原料):**\n- ...\n**中游:**\n- ...\n**下游 (終端應用):**\n- ...",
    "cust": "### 主要客戶\n- ...\n\n### 主要供應商\n- ...",
    "revenue_mix": {
      "year": "2024",
      "segments": [
        { "name": "高效能運算", "pct": 44 },
        { "name": "智慧型手機", "pct": 33 },
        { "name": "物聯網", "pct": 6 },
        { "name": "車用電子", "pct": 5 },
        { "name": "其他", "pct": 12 }
      ],
      "geo": "北美約 68%，中國約 11%，亞太約 12%，歐洲約 6%"
    }
  }
}
```

#### `revenue_mix` 格式規範

| 欄位 | 類型 | 說明 |
|------|------|------|
| `year` | string | 資料年度，例如 `"2024"` |
| `segments` | array | 營收分類，**最多 5 項** |
| `segments[].name` | string | 品項名稱，純文字，**不含 `[[]]`、`佔`、`約`、`%`、`;`** |
| `segments[].pct` | number | 百分比，**整數**（不含 % 符號） |
| `geo` | string 或 null | 地區分佈（一行純文字），沒有則設 `null` |

#### `revenue_mix` 規則

1. **`segments` 最多 5 項**。超過 5 個業務線的，把較小的合併為「其他」
2. **`pct` 加總應接近 100**（允許 95-105 的誤差，因為四捨五入）
3. **`name` 必須乾淨**：
   - 禁止包含 `[[`、`]]`（wikilink 括號）
   - 禁止包含 `佔`、`約`、`%`、`;`、`：`
   - 禁止包含數字（百分比數字）
   - 最多 10 個中文字（或等長英文）
   - 範例：`"高效能運算"` ✅ / `"高效能運算（HPC）佔"` ❌ / `"[[物聯網]]"` ❌
4. **找不到營收結構時，`revenue_mix` 設為 `null`**（不要猜測、不要編造）
5. **`geo` 找不到地區資訊時，設為 `null`**
6. **`desc` 文字與 `revenue_mix` 內容必須一致** — 兩者是同一筆研究的不同呈現形式

#### `revenue_mix` 範例

**大型科技公司（有完整法說會資料）：**
```json
"revenue_mix": {
  "year": "2024",
  "segments": [
    { "name": "高效能運算", "pct": 44 },
    { "name": "智慧型手機", "pct": 33 },
    { "name": "物聯網", "pct": 6 },
    { "name": "車用電子", "pct": 5 },
    { "name": "其他", "pct": 12 }
  ],
  "geo": "北美約 68%，中國約 11%，亞太約 12%，歐洲約 6%"
}
```

**中型零件公司（只有產品線佔比）：**
```json
"revenue_mix": {
  "year": "2024",
  "segments": [
    { "name": "連接器", "pct": 45 },
    { "name": "線纜組件", "pct": 30 },
    { "name": "天線模組", "pct": 15 },
    { "name": "其他", "pct": 10 }
  ],
  "geo": null
}
```

**小型/冷門公司（資料極度稀缺）：**
```json
"revenue_mix": null
```

Save to temp file and apply:

```bash
python scripts/update_enrichment.py --data /tmp/enrich.json <ticker>
```

### Step 6: Audit

```bash
python scripts/audit_batch.py --all -v 2>&1 | grep <ticker>
```

Verify: 8+ wikilinks, no generics, no placeholders, no English in description.

## Quality Checklist

Before finalizing, check:

- [ ] 業務簡介涵蓋：定位 + 營收結構 + 競爭優勢（至少三個面向）
- [ ] 營收結構有數據支撐（佔比 % 或排名）
- [ ] **`revenue_mix` JSON 已填寫且與 `desc` 文字一致**
- [ ] **`revenue_mix.segments[].name` 不含 `[[]]`、`佔`、`約`、`%`**
- [ ] **`revenue_mix.segments` 最多 5 項，`pct` 加總接近 100**
- [ ] 技術/材料 wikilink 完整（不只連結公司名，也要連結技術如 [[CoWoS]]、[[EUV]]）
- [ ] 至少 8 個不同的 wikilink
- [ ] 供應鏈分上游/中游/下游，每段有具體名稱
- [ ] 客戶供應商按業務別分組
- [ ] 全文繁體中文，無英文殘留
- [ ] 公司名與檔名一致（Golden Rule #2）
- [ ] 無占位符（待補充、待更新）
