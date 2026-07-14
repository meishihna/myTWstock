# MAINTENANCE — My TW Coverage 維運手冊

這個站（`meishihna/myTWstock`，Astro + Vercel，部署於 `main`）**大部分是自動維護的**。
本文件說明：什麼會自己跑、什麼要手動、推程式碼的規則、以及不能踩的地雷。

---

## TL;DR（平常只要記這三件）
1. **讓 CI 自己跑** — 每個交易日盤後會自動刷新行情/籌碼/估值並部署，你不用動手。
2. **推任何東西到 `main` 前，先 `git fetch origin && git merge origin/main`** — 因為 CI 每天會自動 commit，你本地一定落後。**永不 `--force` 推 `main`。**
3. **要手動刷財務資料時，先設好 `FINMIND_TOKEN`** — 尤其 `update_financials.py` 沒 token 會毀掉歷史資料（見地雷區）。

---

## 1. 自動化：CI 與部署（你不用管）

### GitHub Actions（`.github/workflows/`）
| Workflow | 排程（UTC → 台灣） | 做什麼 |
|---|---|---|
| **`refresh-snapshots.yml`** | `0 10 * * 1-5`（週一–五 18:00 盤後） | 三大法人/資券(`market-focus`)、今日強勢股(`top-movers`)、熱門題材(`today-themes`)、熱力圖(`heatmap-stats`)、估值(`valuation-index`)、籌碼(`chips-index`)、籌碼走勢(`chips-history`) → commit → 推 `main` |
| **`refresh-valuation.yml`** | `10 0 * * 1-5`（週一–五 08:10） | 跑 `update_valuation.py`，更新報告內「財務概況」估值表 |
| **`report-integrity.yml`** | 每次 push/PR 動到 `Pilot_Reports/**` | 擋 mojibake、未取代樣板、缺段落、重複代號、壞檔名（`check_report_integrity.py`） |

- 兩支 refresh workflow 都用 `fetch-depth: 0` + **推送撞車自癒**（被搶先時 fetch→rebase→重試 5 次，不 force）。所以就算你同時在推，也不會互相打架。
- 需要 `FINMIND_TOKEN`（已存在 GitHub → Settings → Secrets）。

### Vercel 部署
- **每次 `main` 有新 commit 就自動 build 並上線**（含 CI 的自動 commit）。
- build 前 `prebuild` 會執行 `web/scripts/build-data.mjs`，**重新產生**下列索引（所以它們不進版控）：
  `reports-index`、`map-index`、`themes-index`、`screener-index`、`industries-index`。
- Node 版本：**20.x**（`web/package.json` 的 `engines`；別升級破壞相容）。

### 健康檢查（平常不用看，覺得怪再看）
- **GitHub → Actions**：有沒有紅色失敗。
- **Vercel → Deployments**：最新部署是否成功。

---

## 2. 手動刷新資料（想要更新時才跑）

> 本地執行前先設 token：Windows PowerShell `$env:FINMIND_TOKEN="你的token"`；bash `export FINMIND_TOKEN=...`

| 指令 | 用途 | 頻率 / 注意 |
|---|---|---|
| `python scripts/update_month_revenue.py <代號…>` / `--all` | 月營收（FinMind） | `--all` 數小時，建議自備 token |
| `python scripts/update_valuation.py [scope]` | 只刷估值指標（快，不動財務表） | CI 已每日做；想即時可手動 |
| `python scripts/update_financials.py [scope]` | 年報 3 年 + 季報 4 季財務表 | ⚠️ **沒 token 絕不可跑 `--all`**（見地雷區） |
| `python scripts/build_valuation_snapshot.py` | 產 `valuation-index.json`（TWSE/TPEx 官方 + Yahoo beta） | CI 已做 |
| `python scripts/build_chips_snapshot.py` / `build_chips_history.py` | 籌碼快照 / 走勢 | CI 已做 |

`scope` 語法（多數腳本共用）：`<代號>`、`<代號> <代號> …`、`--batch <n>`、`--sector <名>`、或不帶參數＝全市場。

跑完 → `git add` 對應檔 → 依「§4 推送規則」推，或直接等 CI 隔天覆蓋。

---

## 3. 內容維護（Pilot_Reports 報告 enrichment）

| 指令 / 斜線命令 | 用途 |
|---|---|
| `/add-ticker 2330 台積電`（或 `python scripts/add_ticker.py`） | 新增一檔（產 .md + 財務 + 研究 enrichment） |
| `/update-enrichment 2330`（或 `scripts/update_enrichment.py --data <json> [scope]`） | 重寫 業務簡介/供應鏈/客戶（**保留財務概況**） |
| `python scripts/audit_batch.py --all -v` | 品質稽核（8 條鐵則：≥8 wikilink、無泛稱、無 placeholder、無英文描述、段落齊全…） |
| `python scripts/build_wikilink_index.py` | **改過 wikilink 後**重建 `WIKILINKS.md` |
| `python scripts/build_themes.py --curated` | 更新 /map 投資題材（⚠️ 見地雷區） |
| `python scripts/build_industries.py` | 更新 /sectors 產業價值鏈 |
| `/discover 液冷散熱` | 反向搜尋：關鍵字 → 相關個股 |

規則細節見 `CLAUDE.md`（wikilink 必須是具體專有名詞、財務表神聖不可改、全繁中…）。

---

## 4. 推送到 `main` 的規則（最容易踩的坑）

1. **推之前一定先同步遠端**（CI 每天自動 commit，你本地必然落後）：
   ```bash
   git fetch origin
   git merge origin/main      # 通常乾淨自動合併
   ```
   為何乾淨：你的 enrichment 動「業務/供應鏈/客戶」段，CI 動「財務概況」段，區塊不同 → 三方合併不衝突。
2. **永遠不要 `git push --force`（或 `--force-with-lease`）到 `main`** — 會蓋掉 CI 推上去的真實行情/財務資料。
3. **要推大量報告（Pilot_Reports/enrichment_store）時**：先 commit 本地變更，再 `git merge origin/main`，確認 0 衝突、且沒把「財務概況」段落改動（CI 的財務表要保留），再推。
4. 推 `main` 後 Vercel 會自動部署，約 1–3 分鐘上線。

---

## 5. 資料檔：哪些進版控、哪些 build 時重生

| 進版控（要 commit） | Build 時重生（gitignore，別手動改） |
|---|---|
| `Pilot_Reports/**`、`data/financials_store/**`、`data/enrichment_store/**` | `web/public/data/reports-index.json` |
| `WIKILINKS.md` | `…/map-index.json` |
| `web/public/data/`：`valuation-index`、`chips-index`、`chips-history`、`top-movers`、`today-themes`、`market-focus`、`heatmap-stats`、`theme-xref`、`news-digest` | `…/themes-index.json`、`…/screener-index.json`、`…/industries-index.json` |

> 別手動編輯「build 時重生」那欄的檔——會被下次部署覆蓋。要改，改**產生它的來源腳本**。

---

## 6. 本地開發

```bash
cd web
npm install            # 首次 / 相依變更
npm run dev            # 本機開發，http://localhost:4330（predev 會先建索引）
npm run build          # 完整 build（等同 Vercel：prebuild 建索引 → astro build → 產 sitemap）
```
- 用免費資料源：Yahoo Finance、TWSE/TPEx OpenAPI（盤後）、TWSE MIS（盤中近即時）、MOPS、FinMind 免費版。**不碰付費**（Fugle 付費 / TEJ）。
- 沒有 `ANTHROPIC_API_KEY`：需要 LLM 的功能一律做成「無金鑰的 Claude Code 技能」產出 JSON，不在站上即時呼叫模型（例：`/news` 每日簡報）。

---

## 7. 🔴 地雷清單（別這樣做）

- **`update_financials.py --all` 沒帶 `FINMIND_TOKEN`** → 會把 8 年/32 季的豐富史料覆蓋成稀疏的 Yahoo 資料（資料損失，難救）。要嘛帶 token、要嘛只跑單一代號。
- **`git push --force` 到 `main`** → 蓋掉 CI 的真實資料。
- **`python scripts/build_themes.py`（不帶參數）** → 會用「進行中、未定稿」的關鍵字重新推導題材成員，覆蓋你手工校正的名單。要用 `--curated` 或指定單一題材；且單一題材 build 後會改寫 `themes/README.md`，記得 `git checkout -- themes/README.md` 還原。
- **手動編輯 build 時重生的索引檔**（§5 右欄）→ 部署即被覆蓋。
- **外資持股率顯示**：最新交易日若無持股資料（MI_QFIIS 常落後買賣超 1 日）就**隱藏**該欄，**不要**改成「顯示前一日的值」——這是刻意的設計決定。

---

## 8. 出問題時

| 症狀 | 通常原因 / 處理 |
|---|---|
| CI workflow 紅（push rejected / fetch first） | 推送撞車，已內建 rebase 重試；通常下次排程自動恢復，不用管。真的卡住再手動重跑該 workflow。 |
| 站上資料看起來過時 | 等下一次排程（盤後 18:00），或手動觸發 `refresh-snapshots` workflow（GitHub → Actions → Run workflow）。 |
| 報告頁某數字離譜（如 YoY 破千%、比率破萬%） | 基期近零/負值造成的比率失真；顯示端已有 >±1000% 防呆，若又出現多半是新的邊界情況。 |
| 部署失敗（Vercel） | 看 Vercel build log；常見是索引產生腳本或 Node 版本（維持 20.x）。 |

---

_本文件為維運參考；專案的內容規則（wikilink、報告格式、批次進度）見 `CLAUDE.md`。_
