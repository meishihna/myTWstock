---
name: update-enrichment
description: Update business descriptions, supply chain, and customer/supplier sections for ticker reports
user-invocable: true
---

# Update Enrichment

Re-research and update the enrichment content (業務簡介, 供應鏈位置, 主要客戶及供應商) for existing ticker reports。.md 檔案中不再包含財務表 — 財報數據由 MOPS 管線自動處理並存在 JSON 中。

## Usage

- `/update-enrichment 2330` — single ticker
- `/update-enrichment 2330 2317 3034` — multiple tickers
- `/update-enrichment --batch 101` — all tickers in a batch
- `/update-enrichment --sector Semiconductors` — entire sector folder
- `/update-enrichment` — all tickers (will ask for confirmation first)

## Instructions

### Step 1: Identify targets

Parse the user's scope from their message. If scope is "all" or very large (>50 tickers), ask for confirmation.

### Step 2: Research（每檔至少 5 次搜尋）

For each ticker in scope:

1. Read the current file to understand existing content
2. Run at least 5 searches from different angles:
   - `[Ticker] 法說會 2025` — 法說會簡報、營收結構
   - `[Ticker] 年報 主要客戶 供應商` — 年報揭露
   - `[Company Name] 營收比重 產品組合` — 業務線佔比
   - `[Company Name] 競爭優勢 市佔率` — 競爭地位
   - `[Company Name] supplier customer supply chain` — 英文來源
3. **VERIFY**: company name in filename matches research (Golden Rule #2)

### Step 3: Write 業務簡介（5 個面向）

業務簡介是報告中最重要的部分，必須涵蓋以下面向：

#### A. 公司定位與核心業務（必須）
- 公司做什麼、產業鏈角色
- 市佔率、全球排名、產業地位

#### B. 營收結構（必須）
這是與舊版最大的差異。每份報告都必須嘗試加入營收結構：

- **按產品線/業務別**的營收佔比
- **按終端應用**的營收佔比（如適用）
- **按地區**的營收佔比（如適用）

資料來源優先順序：
1. 法說會簡報（最精確，通常有 pie chart 或表格）
2. 年報（「營業收入」章節會揭露）
3. 券商研究報告（搜尋 `[ticker] 營收比重`）
4. 產業報導（搜尋 `[company] revenue breakdown`）

**如果完全找不到精確數據**，用以下方式處理：
- 已知是主要業務但無佔比：寫「為主要營收來源」
- 已知有此業務但佔比不明：寫「亦有貢獻」
- **不要因為找不到數據就完全省略營收結構段落**

**重要：營收結構數據必須同時以結構化格式寫入 `revenue_mix` 欄位（見 Step 5）。`desc` 中的文字用於閱讀，`revenue_mix` 用於前端圖表渲染。兩者內容必須一致。**

格式範例：
```
**營收結構方面**，依產品別：連接器佔營收約 45%，線纜組件約 30%，天線模組約 15%，其他約 10%。依終端應用：伺服器/資料中心佔約 35%，通訊設備約 25%，消費電子約 20%，車用約 15%，工業約 5%。
```

#### C. 核心技術與競爭優勢（必須）
- 具體技術能力（用 [[wikilink]]）
- 與競爭對手的差異
- 進入門檻

#### D. 成長動能與未來展望（盡量）
- 近期成長驅動力
- 新產品/新客戶/新產能佈局
- 受惠的產業趨勢

#### E. 風險因素（選填）
- 1-2 項主要風險，一句話帶過即可

### Step 4: Write 供應鏈 + 客戶供應商

**供應鏈**必須分段：
```markdown
**上游 (原料與設備):**
- **類別A:** [[公司1]], [[公司2]]
- **類別B:** [[公司3]]

**中游:**
- **公司本身的角色:** **公司名** (角色描述)

**下游 (終端應用):**
- **應用A:** [[客戶1]], [[客戶2]]
- **應用B:** [[客戶3]]
```

**客戶供應商**必須按業務別分組，有佔比的一定要寫：
```markdown
### 主要客戶
- **應用領域A:** [[客戶1]] (佔比約 X%), [[客戶2]]
- **應用領域B:** [[客戶3]], [[客戶4]]

### 主要供應商
- **原料:** [[供應商1]], [[供應商2]]
- **設備:** [[供應商3]]
```

### Step 5: Apply

將 enrichment 寫成 JSON，**必須包含 `revenue_mix` 結構化欄位**：

```json
{
  "XXXX": {
    "desc": "完整的繁體中文業務簡介...",
    "supply_chain": "**上游 (設備/原料):**\n- ...",
    "cust": "### 主要客戶\n- ...\n\n### 主要供應商\n- ...",
    "revenue_mix": {
      "year": "2024",
      "segments": [
        { "name": "連接器", "pct": 45 },
        { "name": "線纜組件", "pct": 30 },
        { "name": "天線模組", "pct": 15 },
        { "name": "其他", "pct": 10 }
      ],
      "geo": "亞太約 50%，北美約 30%，歐洲約 20%"
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
6. **`desc` 文字與 `revenue_mix` 內容必須一致** — 兩者描述的是同一筆研究結果

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

**傳產公司（只知道主力產品，沒有精確佔比）：**
```json
"revenue_mix": {
  "year": "2024",
  "segments": [
    { "name": "水泥", "pct": 70 },
    { "name": "預拌混凝土", "pct": 20 },
    { "name": "其他", "pct": 10 }
  ],
  "geo": "台灣約 60%，中國約 30%，其他約 10%"
}
```

**小型/冷門公司（資料極度稀缺）：**
```json
"revenue_mix": null
```

Write enrichment data as a JSON file, then run from **repository root**:

```bash
python scripts/update_enrichment.py --data enrichment.json [scope]
```

### Step 6: Audit

```bash
python scripts/audit_batch.py <batch> -v
```

## 品質標準

### 業務簡介長度指南

| 公司類型 | 目標長度 | 說明 |
|---|---|---|
| 大型龍頭（台積電、鴻海、聯發科等） | 400-600 字 | 5 個面向全部涵蓋 |
| 中型公司（營收 100 億以上） | 250-400 字 | A+B+C 必須，D 盡量 |
| 小型/冷門公司 | 150-250 字 | A+B+C 必須，資料不足處可精簡 |

### Wikilink 要求

每份報告至少 8 個 wikilink，分三類都要有：

| 類別 | 範例 | 說明 |
|---|---|---|
| 公司 | [[台積電]], [[Apple]], [[NVIDIA]] | 客戶、供應商、競爭對手 |
| 技術/產品 | [[CoWoS]], [[HBM]], [[EUV]], [[MLCC]] | 核心技術、產品名稱 |
| 材料/應用 | [[碳化矽]], [[AI 伺服器]], [[電動車]] | 材料、終端應用 |

### `revenue_mix` 品質檢查

| 檢查項目 | 通過標準 |
|----------|----------|
| `segments` 數量 | 1-5 項 |
| `pct` 加總 | 95-105 |
| `name` 乾淨度 | 不含 `[[` `]]` `佔` `約` `%` `;` |
| `name` 長度 | ≤ 10 中文字 |
| 與 `desc` 一致性 | `desc` 中提到的佔比數字與 `segments` 吻合 |
| `year` 合理性 | 近 2 年內的年度（2023 或 2024） |

### 常見錯誤避免

- ❌ 業務簡介只有 2-3 句話 → 至少要有 A+B+C 三個段落
- ❌ 沒有營收結構 → 至少寫「主要營收來自 XXX」
- ❌ **有 `desc` 營收結構但沒填 `revenue_mix`** → 兩者必須同步
- ❌ **`revenue_mix.name` 包含 `[[CoWoS]]`** → name 是純文字，wikilink 只用在 `desc`
- ❌ **`revenue_mix.segments` 超過 5 項** → 合併較小項為「其他」
- ❌ 只連結公司名不連結技術 → [[CoWoS]] 跟 [[NVIDIA]] 一樣重要
- ❌ 供應鏈只有一行 → 必須分上游/中游/下游，每段按類別細分
- ❌ 用英文寫描述 → 全部繁體中文
- ❌ 用泛稱當 wikilink → [[大廠]]、[[客戶]] 是禁止的

### 批次處理注意事項

批次更新（>10 檔）時：
- **第 1 檔和第 100 檔的品質必須一致** — 不要因為疲勞而偷工減料
- 每檔都要跑完整的 5 次搜尋，不要重複用前一檔的搜尋結果
- 如果某家公司資料極度稀缺（搜尋不到任何法說會或年報），在描述中誠實寫「公開資訊有限」，但仍盡力從官網或新聞組裝 A+B+C
- **`revenue_mix` 找不到就設 `null`，絕對不要編造數字**
