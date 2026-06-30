/**
 * 伺服器端(build 時)讀取 web/public/data/theme-xref.json(由 build-map-index.mjs 產生),
 * 取出「單一個股所屬的投資題材」供報告頁「所屬投資題材」區塊使用。模組層快取。
 * 檔案缺失或查無 → 回傳空陣列。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

let cache: { byTicker: Record<string, { slug: string; title: string }[]> } | null | undefined;

function load() {
  if (cache !== undefined) return cache;
  cache = null;
  try {
    const file = path.join(process.cwd(), "public", "data", "theme-xref.json");
    if (existsSync(file)) cache = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    cache = null;
  }
  return cache;
}

/** 該代號所屬的投資題材(/map);查無回傳空陣列。 */
export function themesForTicker(ticker: string): { slug: string; title: string }[] {
  const j = load();
  return (j && j.byTicker && j.byTicker[ticker]) || [];
}
