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
    else if (name.endsWith(".html")) acc.push(full);
  }
  return acc;
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
const urls = files
  .map(fileToUrl)
  .filter((u) => !/\/404\/?$/.test(u) && !u.includes("/404.html"));

/** 報告頁改 SSR 後 dist 可能無 /report/*/index.html，從索引補齊 */
const idxPath = join(webRoot, "public", "data", "reports-index.json");
let reportUrls = [];
if (existsSync(idxPath)) {
  try {
    const idx = JSON.parse(readFileSync(idxPath, "utf8"));
    reportUrls = Object.keys(idx.byTicker || {}).map((t) => `${site}/report/${t}`);
  } catch {
    console.warn("[sitemap] could not parse reports-index.json");
  }
}

const unique = [...new Set([...urls, ...reportUrls])].sort();

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${unique.map((u) => `  <url><loc>${escapeXml(u)}</loc></url>`).join("\n")}
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
