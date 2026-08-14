/**
 * Post-build: scan dist/client for *.html and write sitemap.xml (hybrid-friendly).
 * Run after `astro build`. Uses PUBLIC_SITE_URL or falls back to astro.config site default.
 */
import {
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const webRoot = join(__dirname, "..");
const clientDir = join(webRoot, "dist", "client");

const site = (process.env.PUBLIC_SITE_URL || "http://localhost:4321").replace(
  /\/$/,
  "",
);

function walkHtml(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkHtml(full, acc);
    else if (name.endsWith(".html")) acc.push({ path: full, mtime: st.mtime });
  }
  return acc;
}

/** 由 Pilot_Reports 的 .md mtime 取得各 ticker 最後修改日(報告頁為 SSR,dist 無靜態檔) */
function reportMtimeMap(dir, map = new Map()) {
  if (!existsSync(dir)) return map;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) reportMtimeMap(full, map);
    else if (name.endsWith(".md")) {
      const m = name.match(/^(\d{4})_/);
      if (m) map.set(m[1], st.mtime.toISOString().slice(0, 10));
    }
  }
  return map;
}

function fileToUrl(absPath) {
  let rel = relative(clientDir, absPath).replace(/\\/g, "/");
  if (rel === "index.html") return `${site}/`;
  if (rel.endsWith("/index.html")) {
    const path = rel.slice(0, -"/index.html".length);
    return `${site}/${path}`;
  }
  if (rel.endsWith(".html")) {
    return `${site}/${rel.slice(0, -".html".length)}`;
  }
  return `${site}/${rel}`;
}

function escapeXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

if (!existsSync(clientDir)) {
  console.warn("[sitemap] dist/client missing, skip");
  process.exit(0);
}

const files = walkHtml(clientDir);
/** url -> YYYY-MM-DD lastmod(可為 null) */
const lastmod = new Map();
for (const f of files) {
  const u = fileToUrl(f.path);
  if (/\/404\/?$/.test(u) || u.includes("/404.html")) continue;
  // 自測工具不進 sitemap:它是給人手動帶參數執行的,沒有參數時什麼都不做,
  // 進索引只會製造一個看起來像功能頁的空殼(頁面本身另有 noIndex)。
  if (/\/trades\/rls-selftest\/?$/.test(u)) continue;
  lastmod.set(u, f.mtime.toISOString().slice(0, 10));
}

// 報告頁改 SSR 後 dist 無各 ticker 靜態檔，從索引補齊 URL,lastmod 取 .md mtime
const reportMtimes = reportMtimeMap(join(webRoot, "..", "Pilot_Reports"));
const idxPath = join(webRoot, "public", "data", "reports-index.json");
if (existsSync(idxPath)) {
  try {
    const idx = JSON.parse(readFileSync(idxPath, "utf8"));
    for (const t of Object.keys(idx.byTicker || {})) {
      const u = `${site}/report/${t}`;
      lastmod.set(u, reportMtimes.get(t) ?? lastmod.get(u) ?? null);
    }
  } catch {
    console.warn("[sitemap] could not parse reports-index.json");
  }
}

const unique = [...lastmod.keys()].sort();

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${unique
  .map((u) => {
    const lm = lastmod.get(u);
    return lm
      ? `  <url><loc>${escapeXml(u)}</loc><lastmod>${lm}</lastmod></url>`
      : `  <url><loc>${escapeXml(u)}</loc></url>`;
  })
  .join("\n")}
</urlset>
`;

writeFileSync(join(clientDir, "sitemap.xml"), xml, "utf8");
console.log(`[sitemap] wrote ${unique.length} URLs to dist/client/sitemap.xml`);

const robots = `User-agent: *
Allow: /

Sitemap: ${site}/sitemap.xml
`;
writeFileSync(join(clientDir, "robots.txt"), robots, "utf8");
console.log("[sitemap] wrote dist/client/robots.txt");
