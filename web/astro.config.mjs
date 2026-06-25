import node from "@astrojs/node";
import vercel from "@astrojs/vercel/serverless";
import { defineConfig } from "astro/config";

// 正式站請設環境變數 PUBLIC_SITE_URL（含 https、無結尾斜線），供 canonical / OG / sitemap 絕對網址
const site =
  process.env.PUBLIC_SITE_URL?.replace(/\/$/, "") || "http://localhost:4321";

// hybrid：靜態頁面仍預渲染；/api/* 為 SSR（延遲行情／新聞）。
// adapter 依環境自動切換：Vercel 建置（VERCEL=1）用 serverless；本機／自架用 Node standalone。
// sitemap：見 postbuild scripts/generate-sitemap.mjs。
export default defineConfig({
  site,
  output: "hybrid",
  adapter: process.env.VERCEL ? vercel() : node({ mode: "standalone" }),
  server: { port: 4321 },
});
