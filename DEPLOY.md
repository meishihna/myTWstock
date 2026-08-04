# 部署到 Vercel(公開網址)

本站為 **Astro hybrid**(SSR + 預渲染),含 `/api/*` 即時新聞與行情路由,
因此需要能跑 Node/serverless 的平台(**不能**用 GitHub Pages 等純靜態託管)。

`astro.config.mjs` 的 adapter 已設成**依環境自動切換**:
- Vercel 建置(偵測到 `VERCEL` 環境變數)→ `@astrojs/vercel`(serverless)
- 本機 / 自架 → `@astrojs/node`(standalone)

所以本機 `npm run dev`、桌面捷徑、自架伺服器都不受影響。

## 一次性設定(在 vercel.com)

1. 用 GitHub 登入 → **Add New… → Project → Import** `meishihna/twstock-web`。
2. **Root Directory 設為 `web`** ⚠️ 重要 —— Astro 專案在 `web/`;整個 repo 會被 checkout,
   build 仍讀得到 `../data/financials_store`、`../Pilot_Reports`、`../themes`(`prebuild` 用相對路徑)。
3. Framework Preset:**Astro**(通常自動偵測)。Build Command / Output 用預設即可
   (`npm run build` 會先跑 `prebuild`→`build-data.mjs` 重生索引,再 `astro build`)。
4. (可選)Environment Variables:`PUBLIC_SITE_URL` = 你的正式網址(如 `https://你的專案.vercel.app`),
   供 canonical / OG / sitemap 產生絕對網址。第一次部署可先略過,拿到網址後再補一次重部署。
5. **Deploy** → 拿到 `https://…vercel.app` 公開連結。

## 之後維護

- push 到 GitHub `main` → Vercel **自動重新部署**(每次 push 都會)。
- **runtime 不需任何金鑰**:每日簡報是預生 JSON;行情/新聞是公開來源。
- 資料更新(月營收、主題、財務…):在本機跑對應 script → commit → push → Vercel 自動更新。

## 注意

- 行情/新聞為**第三方延遲資料**,僅供參考(站上已有免責聲明)。
- 免費方案有用量/建置時間上限;個人分享足夠。
- repo **可維持私有**(Vercel 授權後即可部署);設不設 public 都不影響網頁連結是否能開。
- 部署反映的是**已 push 的 commit**;本機未推送的變更不會出現在線上,push 後才更新。

## 本機自架(替代方案,不用 Vercel)

```bash
cd web && npm run build && node ./dist/server/entry.mjs
```
(未設 `VERCEL` → 走 Node standalone adapter;預設埠 4321。)
