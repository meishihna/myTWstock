---
name: news-digest
description: Generate the daily financial-news digest (每日簡報) for /news — by Claude Code itself, no API key needed
user-invocable: true
---

# News Digest（每日簡報）

由 **Claude Code 直接生成**財經新聞每日簡報,寫入 `web/public/data/news-digest.json`,
供 `/news` 頁面頂端「每日簡報」區與事件群命名使用。**無需 ANTHROPIC_API_KEY**——
用你目前登入的 Claude 生成,和 `/update-enrichment` 一樣。

執行時間點:盤後或任何想更新時手動跑 `/news-digest` 即可(可一天數次)。
runtime 只讀這個 JSON;檔案不存在時 `/news` 會優雅地不顯示簡報區,不會壞頁。

## Usage

- `/news-digest` — 抓當前新聞快照並生成簡報

## Instructions

### Step 1：產生新聞快照(本地 NLP,無金鑰、免 dev server)

```
cd web && npx tsx scripts/build-news-snapshot.ts
```

這會抓 8 來源即時新聞、跑情緒/wikilink/聚類,輸出精簡快照到 `web/news-snapshot.json`
(gitignored),內容含:
- `counts`：利多/中性/利空 篇數
- `articles`：最新 60 篇(標題 `t`、摘要 `s`、分類 `cat`、來源 `src`、情緒 `sent`/`score`、wikilink `wiki`、事件群 `cl`)
- `clusters`：跨來源事件群(`clusterId`、`sourceCount`、`primaryTitle`、成員 `titles`)
- `tickerMovers`：情緒最正/最負個股(`ticker`、`name`、`net`、`n`)

### Step 2：讀取快照

`Read web/news-snapshot.json`。**只根據快照內容**撰寫,不要杜撰未出現的數字或事件。

### Step 3：撰寫簡報(專業繁體中文)

依快照綜整當日台股與全球財經重點:

- **headline**:一句話總結當日盤勢主軸(如記憶體/AI/權值股動向),≤ 40 字。
- **marketTone**:`利多`／`中性`／`利空`——綜合 `counts`、加權指數漲跌、三大法人買賣超判斷。
  利多篇數明顯多於利空且大盤收紅 → 利多;反之利空;拉鋸則中性。
- **bullets**:5–8 條,每條一個重點(大盤點數與法人動向、領漲/領跌族群、全球股市連動、
  個股焦點、利空提醒…)。具體引用快照中的數字與名稱。
- **sectorsHot / sectorsWeak**:由 `clusters`、`tickerMovers`、強弱勢族群歸納出的產業/主題標籤
  (各 2–5 個,如「記憶體」「被動元件」「ABF 載板」「金融」)。

### Step 4：為主要事件群命名 + 一行摘要

取 `clusters` 中 `sourceCount` 較高者(最多 8 組),每組產出:
- `clusterId`:**原封不動**沿用快照的 clusterId(runtime 以此 join 到即時事件群)
- `name`:≤ 12 字事件名(如「美光史上最強財報」)
- `oneLine`:一句話摘要
- `sourceCount`:沿用快照

### Step 5：寫入 `web/public/data/news-digest.json`

嚴格依此 schema(欄位齊全):

```json
{
  "generatedAt": "<現在 ISO 時間>",
  "model": "claude-opus-4-8 (Claude Code)",
  "digest": {
    "headline": "...",
    "marketTone": "利多|中性|利空",
    "bullets": ["...", "..."],
    "sectorsHot": ["..."],
    "sectorsWeak": ["..."]
  },
  "clusters": [
    { "clusterId": "cl_xxxx", "name": "...", "oneLine": "...", "sourceCount": 2 }
  ]
}
```

### Step 6：驗證

- 確認 JSON 合法、欄位齊全、全繁體中文、無 placeholder。
- 若 dev server 在跑:`curl -s "http://localhost:4321/api/news?limit=3"` 應回傳 `digest`(非 null);
  重整 `/news` 應見頂端「每日簡報」區與事件群名稱。

## Notes

- **schema 契約**:runtime(`web/src/lib/news-nlp-data.ts` 的 `loadNewsDigest`、
  `web/src/pages/news.astro` 的 `renderDigest`)依上述欄位讀取;勿更動鍵名。
- **clusterId 時效**:clusterId 由主篇 URL 推導,僅在新聞窗內穩定。若 `/api/news` 已刷新導致
  對不上,事件徽章會自動退回顯示「同一事件 · N 來源」(不會出錯)。
- **排程(選用)**:`scripts/refresh-news-digest.ps1` 為自動更新包裝(步驟1 本地跑快照,
  步驟2 以 `claude -p` 無頭生成,工具僅 `Read`/`Write`、無 Bash 以降低注入風險)。
  以 Windows 工作排程器每日呼叫即可;**首次請手動跑一次確認可寫出 digest**。
  安全提醒:無頭代理會讀取外部新聞內容(不可信),故刻意不給 Bash;digest 內容以 textContent
  呈現(非 HTML),blast radius 受限。
- `web/news-snapshot.json` 為暫存輸入,已在 `.gitignore`;`news-digest.json` 為內容需追蹤。
