import type { APIRoute } from "astro";
import fs from "node:fs";
import path from "node:path";

export const prerender = false;

function walkMd(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkMd(full, acc);
    else if (ent.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

function findMatchIndex(content: string, q: string): number {
  let i = content.indexOf(q);
  if (i >= 0) return i;
  const ql = q.toLowerCase();
  if (ql === q) return -1;
  return content.toLowerCase().indexOf(ql);
}

function matches(content: string, q: string): boolean {
  return findMatchIndex(content, q) >= 0;
}

export const GET: APIRoute = async ({ url }) => {
  const q = new URL(url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) {
    return new Response(JSON.stringify({ error: "query_too_short" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
  if (q.length > 120) {
    return new Response(JSON.stringify({ error: "query_too_long" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const idxPath = path.join(process.cwd(), "public", "data", "reports-index.json");
  if (!fs.existsSync(idxPath)) {
    return new Response(JSON.stringify({ error: "index_missing" }), {
      status: 503,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const idx = JSON.parse(fs.readFileSync(idxPath, "utf8")) as {
    byTicker: Record<string, { sectorSlug?: string }>;
  };
  const reportsDir = path.join(process.cwd(), "..", "Pilot_Reports");
  if (!fs.existsSync(reportsDir)) {
    return new Response(JSON.stringify({ error: "reports_missing" }), {
      status: 503,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const files = walkMd(reportsDir);
  const results: {
    ticker: string;
    name: string;
    sector: string;
    sectorSlug: string;
    excerpt: string;
  }[] = [];

  for (const fp of files) {
    const content = fs.readFileSync(fp, "utf8");
    if (!matches(content, q)) continue;

    const rel = path.relative(reportsDir, fp);
    const sector = path.dirname(rel);
    if (sector === ".") continue;
    const base = path.basename(fp, ".md");
    const m = base.match(/^(\d{4})_(.+)$/);
    if (!m) continue;
    const ticker = m[1];
    const meta = idx.byTicker[ticker];
    const sectorSlug = meta?.sectorSlug ?? "";

    const pos = findMatchIndex(content, q);
    const start = Math.max(0, pos - 50);
    const excerpt = content
      .slice(start, start + 180)
      .replace(/\s+/g, " ")
      .trim();

    results.push({
      ticker,
      name: m[2],
      sector,
      sectorSlug,
      excerpt: (start > 0 ? "…" : "") + excerpt + (start + 180 < content.length ? "…" : ""),
    });
    if (results.length >= 150) break;
  }

  results.sort((a, b) => a.ticker.localeCompare(b.ticker));

  return new Response(
    JSON.stringify({
      query: q,
      count: results.length,
      results,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=30",
      },
    }
  );
};
