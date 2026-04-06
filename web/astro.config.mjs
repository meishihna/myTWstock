import node from "@astrojs/node";
import { defineConfig } from "astro/config";

// hybrid：靜態頁面仍預渲染；/api/* 由 Node 執行（延遲行情）
export default defineConfig({
  output: "hybrid",
  adapter: node({ mode: "standalone" }),
  server: { port: 4321 },
});
