/**
 * build-search-index.mjs — /discover 關鍵字搜尋用的靜態索引。
 *
 * 原本 /api/discover 在「請求時」直接讀 repo 根的 Pilot_Reports/*.md 做全文搜尋;
 * Vercel serverless function 打包不到 repo 根的 Pilot_Reports → 線上回 503(dev 才可用)。
 * 改為 build 時(Pilot_Reports 在磁碟)把可搜文字抽成一份 JSON,放 web/public/data/
 * (走 CDN 靜態服務),前端載入後在瀏覽器內比對 — 不再依賴執行時讀檔。
 *
 * 每檔輸出 { t:代號, n:名稱, s:板塊, ss:sectorSlug, x:可搜文字 }。
 * 可搜文字 = 「## 財務概況」之前的內容(業務簡介/供應鏈/客戶),去 markdown。
 * 排除財務表(數字表格對關鍵字搜尋無意義且佔體積)。
 *
 * 須在 build-index.mjs 之後(讀 reports-index 取 name/sector/sectorSlug)。
 */
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(__dirname, "..");
const REPO = path.join(WEB, "..");
const REPORTS_DIR = path.join(REPO, "Pilot_Reports");
const IDX = path.join(WEB, "public", "data", "reports-index.json");
const OUT = path.join(WEB, "public", "data", "search-index.json");

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, acc);
    else if (ent.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

/** 取「## 財務概況」之前的內容,去 markdown → 純可搜文字(保留 wikilink 目標為純文字) */
function searchableText(content) {
  let s = content;
  const cut = s.indexOf("## 財務概況");
  if (cut >= 0) s = s.slice(0, cut);
  return s
    .replace(/\[\[([^\]]+)\]\]/g, "$1") // [[台積電]] → 台積電(讓 wikilink 可被關鍵字搜到)
    .replace(/[*#>`]/g, " ") // 粗體/標題/引用/inline code 符號
    .replace(/\|/g, " ") // 表格分隔
    .replace(/^[ \t]*[-*+]\s+/gm, "") // 項目符號
    .replace(/\s+/g, " ")
    .trim();
}

function main() {
  if (!existsSync(REPORTS_DIR)) {
    console.warn("[search-index] Pilot_Reports missing, skip");
    return;
  }
  const byTicker = existsSync(IDX)
    ? JSON.parse(readFileSync(IDX, "utf8")).byTicker || {}
    : {};
  const rows = [];
  for (const fp of walk(REPORTS_DIR)) {
    const m = path.basename(fp, ".md").match(/^(\d{4})_(.+)$/);
    if (!m) continue;
    const t = m[1];
    const x = searchableText(readFileSync(fp, "utf8"));
    if (!x) continue;
    const meta = byTicker[t] || {};
    rows.push({
      t,
      n: meta.name || m[2],
      s: meta.sector || "",
      ss: meta.sectorSlug || "",
      x,
    });
  }
  rows.sort((a, b) => a.t.localeCompare(b.t));
  writeFileSync(
    OUT,
    JSON.stringify({ generatedAt: new Date().toISOString(), count: rows.length, rows }),
    "utf8",
  );
  console.error(`[search-index] wrote ${rows.length} -> ${OUT}`);
}

main();
