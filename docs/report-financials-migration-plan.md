# 報告頁官方財務遷移 — 規劃(未實作)

> 撰於 2026-08-03 · 範圍僅本 repo(不碰私有引擎端)
> 目標:讓報告頁與四個消費點改吃官方 MOPS 資料,最終解鎖刪除 `data/financials_store`(1,737 檔 / 68 MB / yfinance)

---

## 0. 先講結論

**不能整檔切換。** 官方 `financials/{ticker}.json` 有三個欄位群**沒有替代品**,照搬會讓:

| 會失去的東西 | 影響檔數 |
|---|---|
| CAPEX(KPI 卡 + 年表列 + CAPEX 圖) | 1,590 |
| 營業/投資/籌資現金流(年表 3 列 + 現金流圖) | 1,630 |
| 推銷費用 / 研發費用 / 管理費用(年季表 3 列 + 金融股「費用率」卡) | 1,733 |

同時官方在別的地方**比現況好**:

| 會變好的東西 | 現況 → 官方 |
|---|---|
| 市值 `marketCap` | 937 → **1,625** |
| ROE | 940 → **1,582** |
| 上市/上櫃徽章 | **0(死碼,線上實測沒有)** → 1,626 |
| 季別長度 | 8 年/32 季(Yahoo) → 民國 106Q1 起 37 季(MOPS) |

所以本輪的正解是 **② 欄位級混合的轉接層**,而不是「換來源」。
`financials_store` 這一輪**還不能刪**,但可以把「還在依賴它的欄位」從 16 條收斂到 **7 條**。

---

## ① 欄位對照表

### 資料盤點(實測,非估計)

```
Coverage 報告數                    1,737
官方 financials/ 命中               1,626   ← 111 檔無官方檔
官方檔 market 分佈(Coverage 範圍)  sii 943 / otc 683 / rotc 0
官方檔 fields                       rev, cogs, gp, opex, op, ni, eps
官方檔 bsFields                     ta, tl, teParent, te, cap, bvps
```

**那 111 檔無官方檔者**:全部不在官方 TWSE ISIN 代碼表 `data/stock_codes.json` 內(已下市/興櫃/合併)。
在 store 裡也幾乎是空的 —— 111 檔中只有 **5 檔**有年營收、**1 檔**有市值。
→ 它們今天的報告頁本來就沒有實際數字,遷移後維持現狀。

---

### a) `report/[ticker].astro` 財務儀表板

#### a-1. 年表 / 季表序列(`annual.series` / `quarterly.series` / `quarterlyCore`)

| 欄位 | 現行來源 | 官方替代 | 狀態 |
|---|---|---|---|
| `Revenue` | yfinance + MOPS | `fields.rev` | ✅ |
| `Cost of Revenue` | 同上 | `fields.cogs`(sec/other 為 null) | ✅ |
| `Gross Profit` | 同上 | `fields.gp` **直接用,不可由 rev−cogs 推** | ✅ |
| `Gross Margin (%)` | 同上 | `gp ÷ rev × 100` | ✅ |
| `Operating Income` | 同上 | `fields.op` | ✅ |
| `Operating Margin (%)` | 同上 | `op ÷ rev × 100` | ✅ |
| `Net Income` | 同上 | `fields.ni`(歸屬母公司) | ✅ |
| `Net Margin (%)` | 同上 | `ni ÷ rev × 100` | ✅ |
| `EPS` | 同上 | `fields.eps` | ✅ |
| `General & Admin Exp`(1,732 檔) | **MOPS sb04** | `fields.opex` | ⚠️ **見下方註 A** |
| `Selling & Marketing Exp`(1,647) | yfinance | **無** | ❌ **註 B** |
| `R&D Exp`(1,569) | yfinance | **無** | ❌ **註 B** |
| `Op Cash Flow`(1,630) | yfinance | MOPS **sb20 有**,交付檔未輸出 | ❌ **註 C** |
| `Investing Cash Flow`(1,630) | yfinance | 同上 | ❌ 註 C |
| `Financing Cash Flow`(1,630) | yfinance | 同上 | ❌ 註 C |
| `CAPEX`(年 1,590 / 季 1,700) | yfinance | **無** | ❌ **註 D** |

**註 A — 「管理費用」這一列標籤是錯的,而且官方檔只填了最新一季**

實測 2330 民國 114 年度:store 的 `General & Admin Exp` = **345,649.63**,
與 `data/mops_cache/sii_114_4.json` 的值**逐位相同** → 這一列早就是 MOPS 來的,不是 Yahoo。

但 345,649.63 不是管理費用,而是**營業費用合計**:
毛利 2,281,293.979 − 營業利益 1,936,091.677 = 345,202.302(差額 447 是其他收益及費損淨額)。
台積電真正的管理費用約 5 萬(百萬台幣)量級。**所以報告頁「管理費用」列顯示的是營業費用合計。**

官方檔的 `opex` 語意相同(2330 2026Q1 = 94,005.657;毛利 751,295 − 營益 658,966 = 92,329 + 其他)。
**但引擎只填了最新一季**:1,974 檔 × 全部季別共 64,959 格,只有 **1,069 格非 null**(每檔剛好 1 格)。

→ 裁決建議:**這一列本輪維持吃 store**(store 的值來自 Coverage 自己的 `mops_financials.py`,已是官方),
並在實作時把顯示標籤由「管理費用」改為「**營業費用**」(修正既有錯標,不是新功能)。
引擎補齊 `opex` 歷史是跨 repo 的事,列入前置條件檢查表。

**註 B — 推銷費用 / 研發費用:官方永久無替代**

MOPS `ajax_t163sb04` 綜合損益表彙總表**沒有這兩欄**。實測 `data/mops_cache` 74 個季別檔、
64,875 格、1,927 檔個股:

```
非 null 比例   推銷 0.0%   研發 0.0%   管理(=營業費用) 100.0%
至少一期有值的個股數   推銷 0   研發 0   管理 1,927
```

現況這兩列來自 yfinance。要官方化只能逐檔抓 XBRL / 財報 PDF —— **超出本專案範圍**。
→ 這兩列是 `financials_store` **無法解除的依賴**,除非使用者同意刪掉這兩列。

**註 C — 現金流三列:官方有,但交付檔沒帶**

`data/mops_cache/{sii,otc}_{年}_{季}_t163sb20.json` 已含
`Op Cash Flow` / `Investing Cash Flow` / `Financing Cash Flow`(單位仟元)。
引擎的 `financials/{ticker}.json` 的 `fields` 沒有輸出這三欄。
→ 需引擎端加欄位。**引擎端另有進行中的重構,本輪不碰** → 列入前置條件。

**註 D — CAPEX:sb20 只有三大活動淨額,沒有明細**

CAPEX 需要「取得不動產、廠房及設備」這一行,sb20 彙總表沒有。→ **無官方替代**。

#### a-2. `quarterlyYtd`(季表「累積合併」切換)

| 欄位 | 現行 | 官方替代 | 狀態 |
|---|---|---|---|
| `quarterlyYtd.periods` | store(1,737 檔) | 同 `quarters.p` | ✅ |
| `rev/cogs/gp/op/ni` 累計 | store 由單季加總 | **同年內由 `quarters` 累加** | ✅ |
| `EPS` 累計 | store 由單季 EPS 加總(近似) | 同法累加 | ✅ 口徑不變 |
| 累計毛利率 | store | **累計 `gp` ÷ 累計 `rev`** | ✅ |
| 累計費用/現金流/CAPEX | store | 見註 B/C/D | ❌ |

🔴 **三條硬規則寫進 adapter 註解**:
1. **`bs` 絕不進 YTD**,也絕不做任何相減/累加(時點數)。現行 quarterlyYtd 表不含 bs 列 → adapter 不得引入。
2. **累計毛利率不可由「累計 rev − 累計 cogs」推**,必須用累計 `gp`(227 個檔×季 / 57 檔合法不等)。
3. **`sec` / `other` 業別的 `cogs`/`gp` 是 null** → 累計也是 null,**不可用 0 頂替**(0 會讓毛利率變 0% 而非「無此列」)。

模擬結果:官方可產出 YTD 的檔數 = **1,559**(現況 store 1,737)。

#### a-3. `valuation`(儀表板 KPI)

| 欄位 | 現行來源 | 官方替代 | 狀態 |
|---|---|---|---|
| `valuation.ROE` → ROE 卡 | store yfinance(**940** 檔) | **ROE(TTM) = 近 4 單季 `ni` ÷ 平均 `teParent`**,平均 =(期初+期末)/2 | ✅ 覆蓋 **1,582**(+642) |
| PE / PB / 殖利率 | **已改吃 `valuation-index.json`** | 已完成(1,730 檔:pe/pb/yield/beta) | ✅ 已上線 |

→ 儀表板對 `store.valuation` 的依賴,遷移後**歸零**。

#### a-4. `monthlyRevenue`(月營收頁籤)

| 欄位 | 現行 | 官方替代 | 狀態 |
|---|---|---|---|
| 月營收 / YoY / 累計 / 累計YoY | `getMonthlyRevenue()` 官方優先,store 為 fallback | `monthly-revenue.json`(1,851 檔) | ✅ **已完成**(`FinancialDashboard.astro:832`) |

→ 只剩「官方查無時退回 store」這一條 fallback,見 ④ 檢查表。

#### a-5. 頂部 meta 卡與其他純量

| 欄位 | 現行 | 官方替代 | 狀態 |
|---|---|---|---|
| `industryType` → 版型選擇 | store(general 1,704 / bank 10 / securities 10 / financial_holding 13) | 官方 `industryType`(**代碼不同**:`fh` / `ins` / `sec` / `other`) | ⚠️ **需對照表**(見 ②) |
| `sector` / `industry` → 板塊卡 | store(Yahoo 英文)→ fallback MD | 官方檔無;MD 有 **1,737 / 1,737** | ✅ MD 已足 |
| `marketCap` → 市值卡 | store(**937**)→ fallback MD(1,736) | **PB × teParent**(見查證 1) | ✅ 覆蓋 **1,625** |
| `enterpriseValue` → 企業價值卡 | store(940)→ fallback MD(1,719) | **無**(缺現金欄) | ❌ 但**畫面不受影響**,MD 已補 |
| `unit` / `schemaVersion` / `updatedAt` | store | 官方檔同名或等價欄位 | ✅ |
| `yahooSuffix` | store | `data/stock_codes.json` 已取代 | ✅ 已無用 |

---

### b) `build-momentum.mjs` → `momentum.json` → map-index「連三月年增」

| 欄位 | 現行來源 | 官方替代 | 狀態 |
|---|---|---|---|
| `monthlyRevenue.yoy`(逐月年增 %) | `data/financials_store/*.json` 內的 FinMind 區塊 | `monthly-revenue.json` + `lib/monthlyRevenue.ts` 的 `yoyOf()` | ✅ |

改法:把 `build-momentum.mjs` 的 `STORE` 掃描改為讀 `web/public/data/monthly-revenue.json` 一次,
逐 ticker 算 `yoy` 再跑既有 `yoyStreak()`。

⚠️ **口徑差異必須量測**:`monthlyRevenue.ts` 的 `yoyOf()` 在**去年同月 ≤ 0 時回 null**;
FinMind 版可能給了數字。streak 是「同號連續月數」,多一個 null 會**截斷 streak** →
連三月年增的家數可能變動。驗證時必須逐檔比對 `momentum.json` 的前後差異並解釋每一筆。

---

### c) `report/[ticker].astro:229–257` 上市/上櫃/興櫃徽章

| 欄位 | 現行來源 | 官方替代 | 狀態 |
|---|---|---|---|
| `exchange`(`"TWSE"`/`"TPEx"`) | store | 官方 `market`:`sii`→上市 / `otc`→上櫃 | ✅ |
| `listingStatus`(`listed`/`emerging`) | store | 官方無 rotc;`market` 存在即視為 listed | ⚠️ 見查證 2 |

🔴 **這段目前是死碼**:實測 1,737 個 store 檔,`exchange` **全部 `undefined`**、
`listingStatus` **全部 `"listed"`** → `deriveListingBadge()` 永遠回 `null`。
生產站抓 `/report/2330`(上市)與 `/report/6488`(上櫃)的 HTML,**兩頁都沒有徽章**。

→ 接上官方 `market` 會讓 **1,626 檔新增徽章**。這是**新功能不是遷移**,需要使用者拍板要不要開。

---

### d) `build-screener-index.mjs` 現存 fallback

上一輪已改為官方優先,以下是**還在讀 store** 的欄位:

| screener 欄 | 現行 fallback | 官方替代 | 狀態 |
|---|---|---|---|
| `mc` 市值 | `data.marketCap`(937) | **PB × teParent** | ✅ 1,625 |
| `roe` | 官方 TTM → `val["ROE"]` → `pb÷pe` | 官方 TTM 已是第一層 | ✅ 可拆掉第 2 層 |
| `de` 負債權益比 | `val["Debt/Equity"]`(913) | **`tl ÷ te`**(官方 bs) | ✅ |
| `ps` | `val["P/S (TTM)"]`(937) → `mc ÷ rev` | 第 2 層即可(mc 改官方後覆蓋更好) | ✅ |
| `beta` | `vi.beta` → `val["Beta"]`(875) | `valuation-index.json` 已有 | ✅ 可拆掉第 2 層 |
| `pe` / `pb` | `vi.pe`/`vi.pb` → `val[...]` | valuation-index 已是第一層 | ✅ 可拆掉第 2 層 |
| `fpe` 預估本益比 | `val["Forward P/E"]`(582) | **無**(需分析師預估) | ❌ |
| `ev` EV/EBITDA | `val["EV/EBITDA"]`(915) | **無**(缺現金、缺折舊攤銷) | ❌ |
| `revYoy` 年度營收成長 | 官方 `annual.rev` → `ann.series.Revenue` | 官方已是第一層 | ✅ 可拆掉第 2 層 |
| `it` 業別 | `data.industryType` → `off.industryType` | 官方已有,需代碼對照 | ✅ |
| `gm`(sec/other) | 官方 gp 為 null → store | store 的值也是 null | ⚠️ 需逐檔驗 |

---

### e) 🔴 第五個消費點:`build-sector-stats.mjs`(使用者清單漏列)

`web/scripts/build-sector-stats.mjs:23-36` 讀 `data/financials_store`,**fallback 到
`web/public/data/financials`**,然後 `ann.periods` / `ann.series`。

官方格式是 `annual.p` / `annual.v` → `ann.periods` 是 `undefined` → **整檔 `continue`,靜默略過**。
這**和上一輪 `build-screener-index.mjs` 的陷阱一模一樣**。今天不會咬人(store 1,737 檔全在),
但 **store 一刪,`sector-stats.json` 的所有產業就全空** —— 產業頁的營收/毛利率分位數與百分位排名整片消失。

| 欄位 | 現行 | 官方替代 | 狀態 |
|---|---|---|---|
| `annual.series.Revenue` 最新年 | store | `annual.v[fields.rev]` | ✅ |
| `annual.series["Gross Margin (%)"]` 最新年 | store | `gp ÷ rev` | ✅ |

→ 必須與其他消費點同批改,否則就是「刪 68 MB 之後才發現」。

---

### 🔎 使用者指定查證的四項 — 結論

#### 查證 1:`marketCap` / `enterpriseValue`

**`marketCap` → ✅ 有官方推導,但不是走 `bs.cap`。**

`cap` 是**股本**不是股數,除以面額才是股數,而面額非 10 元者(特別股、無面額)會錯。
**改用恆等式**:

```
PB = 股價 ÷ BVPS,  BVPS = teParent ÷ 股數
∴ PB × teParent = 股價 × 股數 = 市值          ← 完全不需要面額
```

`PB` 取 `valuation-index.json`(TWSE BWIBBU + TPEx 官方,雙市場),`teParent` 取官方 `bs` 最新一季。

**驗證(以生產站即時報價的 previousClose 當裁判)**:

| 代號 | `PB × BVPS` 推得股價 | 生產站 previousClose | 誤差 |
|---|---|---|---|
| 2330 | 2,205.8 | 2,205 | 0.04% |
| 2454 | 3,235.0 | 3,235 | 0.00% |
| 2317 | 230.1 | 229.5 | 0.26% |
| 1304 | 11.1 | 11.05 | 0.45% |
| 1310 | 7.1 | 7.06 | 0.57% |

覆蓋率 **937 → 1,625**。

⚠️ **我第一次量錯了,寫下來免得重蹈**:我先拿推導值對 `store.marketCap` 比,得到平均誤差
17.0%、402/935 檔超過 15%,差點判定「不可接受」。實際上 **1,737 個 store 檔的
`updatedAt` 全是 2026-06**(兩個月前),它的市值是舊價算的。**陳舊的一方不能當裁判** ——
改用即時報價回驗才看出推導是對的。全量驗收時一律以 `/api/quote-batch` 的收盤價為裁判。

**`enterpriseValue` → ❌ 官方無替代,但畫面不會壞。**

EV = 市值 + 總負債 − 現金。`bsFields` 只有 `ta/tl/teParent/te/cap/bvps`,**沒有現金及約當現金**。
不過報告頁本來就 `fmtMCap(fj?.enterpriseValue) ?? summaryMd.enterpriseValue`,而 1,737 份報告 MD
有 **1,719 份**帶企業價值(N/A 18 份)→ 刪 store 後這張卡改由 MD 供應,**不會變空白**。
代價是值變成靜態快照 —— 但**現況已有 797 檔是這樣**(store 只有 940 檔有 EV)。
真正官方化需引擎 `bsFields` 加 `cash`,列入 ④ 檢查表(跨 repo,本輪不做)。

#### 查證 2:`exchange` / `listingStatus`

**✅ 可直接取代,且是淨改善;興櫃(rotc)官方無涵蓋,但現況也是 0。**

- 官方檔自帶 `market`,Coverage 範圍內 **sii 943 / otc 683 / rotc 0**。
- 全 1,974 個官方檔也只有 `sii 1,083` / `otc 891`,**一筆 rotc 都沒有** → 興櫃不在官方 t163 涵蓋內。
- 但現況 store 的 `listingStatus` **1,737 檔全是 `listed`**,`exchange` **全是 undefined`** →
  今天線上**一個徽章都沒有**(已用生產站 HTML 實測 2330 / 6488 確認)。
- → 換過去 **不減少任何東西**,反而讓 1,626 檔多出徽章。111 檔無官方檔者維持無徽章 = 同今天。

#### 查證 3:`quarterlyYtd`

**✅ 可由單季累加,但三條硬規則不可違反**(已列在 a-2)。
最關鍵的是 🔴 **`bs` 是時點數,絕不可累加也絕不可相減** —— YTD 表不含 bs 列,adapter 不得引入。

#### 查證 4:`valuation` 的 PE / PB / 殖利率

**✅ 這件事上一輪已經做完了。** `report/[ticker].astro:287-290` 早已改讀
`valuation-index.json`(官方雙市場,1,730 檔:pe / pb / yield / beta),
`store.valuation` 只剩**儀表板 ROE 卡**與 **screener 的 fpe/ps/ev/de/beta** 在用。
ROE 換官方 TTM 後,儀表板對 `store.valuation` 的依賴歸零。

---

## ② 轉接層設計

### 位置與職責

```
web/src/lib/officialFinancials.ts     ← 新增:讀官方檔 + 解碼位置陣列 + 衍生量
web/src/lib/financialsAdapter.ts      ← 新增:官方 → FinancialsJson 形狀,【欄位級】混合
web/src/lib/financialsJson.ts         ← 不動型別(下游全部零改動)
```

**核心原則:下游一律看到既有的 `FinancialsJson` 形狀。**
`FinancialDashboard.astro` / `financialDashboard.ts` / `industryConfig.ts` /
`report-financial-tables.js` 全部**不改**。只換供應者。

### 介面

```ts
// officialFinancials.ts
export type OfficialFin = {
  ticker: string;
  market: "sii" | "otc";
  industryType: "general" | "fh" | "bank" | "ins" | "sec" | "other";
  quarters: { p: string[]; v: (number | null)[][] };   // p = "2017Q1"
  annual:   { p: string[]; v: (number | null)[][] };   // p = "2017"
  fields: string[];        // rev cogs gp opex op ni eps
  bsFields: string[];      // ta tl teParent te cap bvps
  bs: { v: (number | null)[][] };                      // 軸同 quarters
  updatedAt: string;
};
export function loadOfficial(ticker: string): OfficialFin | null;
export function roeTtm(o: OfficialFin): number | null;      // 近4單季 ni ÷ 平均 teParent
export function marketCapFrom(o: OfficialFin, pb: number | null): number | null;  // pb × teParent
export function debtToEquity(o: OfficialFin): number | null; // tl ÷ te
```

```ts
// financialsAdapter.ts
export type FieldSource = "official" | "store" | "none";

export type AdaptResult = {
  json: FinancialsJson | null;               // 下游沿用的形狀
  /** 每個 series key 的實際來源 —— 圖表據此決定「整張圖用哪個來源」 */
  sources: Record<string, FieldSource>;
  /** 若某圖表的欄位群跨來源 → 整張圖退回 store,並記在這裡供 UI 標示 */
  chartFallbacks: string[];
};

export function adaptFinancials(ticker: string): AdaptResult;
```

### 欄位級策略(**不是整檔二選一**)

| 欄位群 | 策略 |
|---|---|
| `rev / cogs / gp / op / ni / eps` + 三個率 | **官方優先**;官方查無該檔 → 整組退回 store |
| `Selling & Marketing Exp` / `R&D Exp` | **一律 store**(官方永久無) |
| `General & Admin Exp`(實為營業費用) | **一律 store**,顯示標籤改「營業費用」 |
| 現金流三列 / `CAPEX` | **一律 store**(等引擎補 sb20 / CAPEX 無解) |
| `marketCap` | **官方推導優先**(`pb × teParent`)→ store → MD |
| `enterpriseValue` | **store → MD**(官方無) |
| `industryType` | 官方代碼經對照表 → store → `"general"` |
| `exchange` / `listingStatus` | **官方 `market`**(現況是死碼,無需 fallback) |
| `monthlyRevenue` | 官方 `monthly-revenue.json` → store(已上線) |

### 🔴 「同一張圖表內不得混來源」怎麼落實

規則:**以「圖表」為單位決定來源,不是以「欄位」為單位繪圖。**

| 圖表 / 區塊 | 需要的欄位 | 決策 |
|---|---|---|
| 營收結構線圖(`revenueSeries`) | Revenue / Gross Profit / Operating Income / Net Income | 四欄**全部官方可得** → **整張官方** |
| 利潤率線圖(`marginSeries`) | 三個率 | 皆由官方 rev/gp/op/ni 推 → **整張官方** |
| **費用圖 / 費用率卡** | 推銷 / 研發 / 營業費用 | 官方缺 2 欄 → **整張 store**,加註「Yahoo 來源」 |
| **現金流圖** | Op / Investing / Financing CF | 官方全缺 → **整張 store**,同上加註 |
| **CAPEX 卡 + CAPEX 圖** | CAPEX | 官方全缺 → **整張 store**,同上加註 |
| 年/季財務表(`report-financial-tables.js`) | 全部 16 列 | **逐列標來源**(表格是列的集合,不是單一視覺量) → 官方列用官方、Yahoo 列標註 |
| KPI 卡 ROE | ROE | **官方 TTM** |
| 月營收頁籤 | monthlyRevenue | **官方**(已上線) |

註記形式沿用現有的 `note` 欄(`KpiCard.note`,現在 ROE 卡寫「估值資料」),
圖表下方加一行 `<p class="chart-src">` 級的細字,不新增元件、不改版面骨架。

### 期別軸轉換

| 項目 | 官方 | 下游期待 | 轉換 |
|---|---|---|---|
| 季別 | `"2017Q1"` | `"2017-03-31"` | Q→季末日(3/31, 6/30, 9/30, 12/31) |
| 年度 | `"2017"` | `"2017-12-31"` | 補 `-12-31` |

`financialDashboard.ts` 的 `quarterXLabel()` / `annualXLabel()` 只認 `YYYY-MM-DD`,
且 `tailBlock()` 對非 `YYYY-MM-DD` 會走 `annualXLabel` 分支 → **必須在 adapter 轉好**,
不要改 `financialDashboard.ts`(那會同時影響 store 路徑)。

### `industryType` 代碼對照

| 官方 | 前端 `IndustryType` |
|---|---|
| `general` | `general` |
| `fh` | `financial_holding` |
| `bank` | `bank` |
| `ins` | `insurance` |
| `sec` | `securities` |
| `other` | `other` |

⚠️ 現況 store 只有 4 種(general / bank / securities / financial_holding),**沒有 insurance / other**;
官方有 `ins` 6 檔、`other` 4 檔。換過去會讓這 10 檔改用不同版型 —— 這是**修正而非退化**
(保險股本來就不該套 general 的毛利率卡),但要在驗證報告裡逐檔列出來給使用者看。

---

## ③ `add_ticker.py` 遷移

`scripts/add_ticker.py:25` 有 live import:

```python
from update_financials import ...
```

→ `update_financials.py` 與 `finmind_financials.py` 現在**不能刪**(上一輪已踩過:刪了 4 支腳本
把 `add_ticker` 弄壞,復原後才發現裁決少了一步 grep)。

**建議:分批,不與本輪同批。**

理由:`add_ticker` 是**手動、低頻**的路徑(新增覆蓋個股時才跑),而本輪的風險集中在
**1,737 頁的自動建置**。兩者混在一批,任何一邊出問題都要整批回滾。

遷移做法(下一批):
1. 新增 `scripts/official_financials.py` —— 從 `web/public/data/financials/{t}.json` +
   `monthly-revenue.json` 產出 `add_ticker` 需要的財務表(**不重抓網路**,官方檔已在 repo)。
2. `add_ticker.py` 改 import 它;`update_financials` / `finmind_financials` 保持存在但無人 import。
3. **新代號不在官方檔內**(全新上市/興櫃)→ 明確報「官方尚無此代號的 t163 資料,
   財務表留空待下次官方更新」,**不要靜默產生空表**。
4. 兩支 FinMind 腳本改在**確認 grep 全 repo 零 live import 之後**才刪。

---

## ④ 刪除 68 MB 的前置條件檢查表(本輪**不刪**)

**全部滿足才可刪。任何一項未打勾就不准動。**

### A. 功能面(不減少現有功能)

- [ ] **A1** 推銷費用 / 研發費用 —— 官方永久無替代。**必須由使用者拍板**:
      (a) 接受這兩列消失,或 (b) 永久保留 store 中這兩列的精簡檔,或 (c) 接受改抓 XBRL。
- [ ] **A2** 現金流三列 —— 引擎 `financials/{t}.json` 已輸出 sb20 三欄,且 Coverage 端已接。
- [ ] **A3** CAPEX —— 官方無替代。**必須由使用者拍板**(同 A1 三選一)。
- [ ] **A4** 營業費用(`opex`)—— 引擎已補齊歷史(現在 64,959 格只有 1,069 格非 null)。
- [ ] **A5** `enterpriseValue` —— 引擎 `bsFields` 已加 `cash`,或使用者接受永久走 MD 靜態值。
- [ ] **A6** screener `fpe` / `ev` —— 使用者接受這兩欄消失(官方無替代),或另尋來源。
- [ ] **A7** 111 檔無官方檔者 —— 確認其報告頁與今天視覺完全一致(今天本來就近乎空白)。

### B. 消費點面(**五個**,不是四個)

- [ ] **B1** `report/[ticker].astro` 走 adapter,`data/financials_store` 路徑移除
- [ ] **B2** `build-momentum.mjs` 改讀 `monthly-revenue.json`
- [ ] **B3** `build-screener-index.mjs` 移除 store fallback
- [ ] **B4** `build-sector-stats.mjs` 改讀官方(**目前 fallback 是靜默略過的陷阱**)
- [ ] **B5** 全 repo grep `financials_store` 為 0 live 引用(含 `.py`、`.mjs`、`.astro`、`.yml`)
      —— 上一輪的教訓:**先 grep live import 再刪**
- [ ] **B6** `scripts/` 下 9 支 Python(`update_financials` / `add_ticker` / `scan_emerging_stocks` /
      `audit_financials_*` / `backfill_exchange` / `verify_quarterly_annual_ratios` /
      `validate_test_set`)確認全部改完或確認為死碼

### C. 驗證面

- [ ] **C1** 全 1,737 檔逐欄前後對照,**無任一欄任一檔由有值變空白**(見「驗證方式」)
- [ ] **C2** `astro build` exit 0、頁數不變(1,741)、sitemap URL 數不變
- [ ] **C3** 三層掃描器 深淺 × 4 態 = 0,且自我驗證(注入已知失敗要抓到)
- [ ] **C4** 生產站 smoke:2330(上市 general)/ 6488(上櫃)/ 2882(fh)/ 2801(bank)/
      6005(sec)/ 2823(ins)六種業別各抓一頁,逐項比對數字
- [ ] **C5** 0 console error

### D. 刪除後的驗證方式

1. **先 `git rm --cached` 不刪本機檔** → 跑一次完整 build + 全站對照 → 通過才真的刪本機。
2. 刪除 commit **只含刪除**,不夾帶任何邏輯改動 → 出事可單獨 revert。
3. 刪除後立刻跑 ⑤ 的 `check-selfcontained.mjs`:build 若還在讀已刪目錄,會**大聲失敗**而不是靜默空白。
4. Vercel preview 驗過再併 main;併後生產站重跑 C4 的六頁 smoke。

---

## ⑤ 自足性守門 `web/scripts/check-selfcontained.mjs`

**動機**(使用者原話的技術翻譯):上一輪 `.gitignore` 忽略了 `web/public/data/financials/`,
使得整個 ③ 遷移在線上是 no-op —— **守門過、build 過、掃描器過,只有線上壞掉**(roe 空白退回 303)。
本機有檔、CI 沒檔,是這類錯誤的共同形狀。

### 設計

```
web/scripts/check-selfcontained.mjs
```

**步驟**

1. **決定掃描根**(build 真正會讀的資料來源):
   ```
   data/financials_store/       data/enrichment_store/
   Pilot_Reports/               themes/
   web/public/data/             web/public/scripts/        web/docs/
   ```
2. **推導 build 產物白名單(不 hardcode)**:掃 `web/scripts/build-*.mjs` 的原始碼,
   抓 `writeFileSync(...)` / `renameSync(...)` 的目標常數(`OUT`、`OUT_*` 這類 `path.join(...)`
   宣告),解析成絕對路徑集合。
   **為什麼不 hardcode**:hardcode 會在新增 build 腳本時默默失效 —— 正是這道檢查要防的東西。
   若解析不出任何產物 → **視為檢查失敗**(「量不到 = 失敗」,不可靜默跳過)。
3. **對掃描根下每個檔跑 `git check-ignore --stdin`**(一次批次,不要逐檔開 process)。
4. **判定**:`被 git 忽略` 且 `不在產物白名單` → **失敗**,列出完整檔名 + 所屬掃描根 + 命中的
   `.gitignore` 規則(`git check-ignore -v` 給得到)。
5. 退出碼:失敗 `exit 1` 並印 `❌ 自足性檢查失敗:N 個檔案在本機存在但不會進 repo`。

**接哪裡**

- `package.json` 的 `prebuild`(本機 + Vercel 都會跑),**以及** CI 的 build job。
- ⚠️ **Vercel 上 `git check-ignore` 可用性要先驗**(Vercel 是 shallow clone,`.git` 在不在需實測)。
  若不可用 → 退到「純讀 `.gitignore` 規則比對」是**錯的**(等於自己寫 parser,違反
  「量測工具不要自己解析」);正確退路是**只在 CI 跑**,並讓 CI 成為 merge 的必要條件。

**自我驗證(必做)**:故意把一個已知會被讀的檔(如 `web/public/data/monthly-revenue.json`)
暫時加進 `.gitignore` → 檢查必須抓到 → 移掉 → 回到 0。**沒跑過這步不算通過。**

### 順手清掉的垃圾檔

- `Pilot_Reports/Building Materials/.Rhistory`(0 bytes,R 主控台歷史,**未被 git 追蹤**)→ 刪。

---

## ⑥ `data/mops_monthly_cache` 60 個空檔

**已確認可刪:**

```
檔數           60          全部 119 bytes
內容           {"fetched_at":…,"typek":…,"roc_year":…,"month":…,"by_ticker":{}}   ← by_ticker 全空
git 追蹤       60 檔全部在版控內(不像 data/mops_cache/*.json 被 .gitignore)
程式引用       0     ← 全 repo grep「mops_monthly_cache」只命中
                        scripts/__pycache__/mops_monthly_revenue.cpython-313.pyc
                        (原始 .py 已在上一輪刪除,這是殘留位元組碼;__pycache__/ 已在 .gitignore 第 1 行)
```

→ `git rm -r data/mops_monthly_cache` + 順手刪 `scripts/__pycache__` 殘留(未被追蹤)。

---

## 驗證方式(沿用上輪成功的做法)

**腳本化前後對照,全 1,737 檔,目測不算。**

`web/tests/compare-financials-migration.mjs`(暫定名,與 `test:reconcile` 同一風格,進版控):

1. **before**:在改動前跑一次,對每一 ticker 輸出一列扁平記錄 ——
   16 個 series key × (年/季/YTD) 的「有值格數」+ marketCap / EV / ROE / industryType /
   badge / 各圖表是否顯示 的布林。存成 `before.json`。
2. **after**:改動後同法跑,存 `after.json`。
3. **判定**:逐檔逐欄比對,**任一欄由「有值」變「空白」即 FAIL**,並印出 ticker + 欄位 + 前後值。
   反向(空白變有值)只記錄不擋。
4. **另外三個必比的產物**:
   - `momentum.json` —— 逐 ticker streak 前後差異,每一筆差異都要能解釋(見 b 的口徑警告)
   - `sector-stats.json` —— 每個產業的 n / p25 / p50 / p75 前後差異
   - `screener-index.json` —— 每欄的空白數(沿用上輪的做法:roe / pb / pe / eps / gm / revYoy)
5. **市值專項**:`PB × teParent` 推導值 vs `/api/quote-batch` 收盤價 × 推得股數,
   全 1,625 檔的相對誤差分佈(p50 / p90 / max),**不拿陳舊的 store 當裁判**。

---

## 建議分批

| 批 | 內容 | 風險 |
|---|---|---|
| **本輪(規劃)** | 這份文件 | — |
| **批 1** | ⑤ 自足性守門 + ⑥ 刪空檔 + 刪 `.Rhistory` | 低,可先併 |
| **批 2** | `officialFinancials.ts` + `financialsAdapter.ts` + 前後對照腳本(**只加不接**) | 低,無行為改變 |
| **批 3** | 接報告頁儀表板(a-1/a-2/a-3)+ 修正「管理費用」標籤 | 中,要全量對照 |
| **批 4** | `build-momentum` / `build-sector-stats` / screener 收斂 fallback | 中 |
| **批 5** | 上市櫃徽章(**新功能,需拍板**) | 低 |
| **批 6** | `add_ticker` 遷移 | 低 |
| **批 7** | 刪 68 MB(**須 ④ 全部打勾**) | 高 |

---

## 需要使用者裁決的三件事

1. **推銷費用 / 研發費用 / CAPEX 官方永久無替代** —— 接受消失?保留精簡 store?還是不刪 68 MB?
   (這一題不回答,批 7 永遠無法開始。)
2. **上市/上櫃徽章要不要開?** 現況是死碼、線上沒有;接官方 `market` 會讓 1,626 檔多出徽章 —— 是新功能。
3. **`enterpriseValue` 接受走 MD 靜態值嗎?** 官方缺現金欄;現況已有 797 檔是靜態值。
