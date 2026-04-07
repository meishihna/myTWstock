import node from "@astrojs/node";
import { defineConfig } from "astro/config";

// 正式站請設環境變數 PUBLIC_SITE_URL（含 https、無結尾斜線），供 canonical / OG / sitemap 絕對網址
const site =
  process.env.PUBLIC_SITE_URL?.replace(/\/$/, "") || "http://localhost:4321";

// hybrid：靜態頁面仍預渲染；/api/* 由 Node 執行（延遲行情）
// sitemap：見 postbuild scripts/generate-sitemap.mjs（與 @astrojs/sitemap + hybrid 相容性問題時改用手動產生）
export default defineConfig({
  site,
  output: "hybrid",
  adapter: node({ mode: "standalone" }),
  server: { port: 4321 },
});
