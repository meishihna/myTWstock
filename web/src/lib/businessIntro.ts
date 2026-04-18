/**
 * 業務簡介 Proposal C：自 Markdown 節內文解析 intro／營收條／三格 pill。
 * 營收結構條狀圖優先使用 enrichment_store 的 revenue_mix，避免從自由文字 regex 解析。
 */

import fs from "node:fs";
import path from "node:path";

export const BIZ_REV_BAR_COLORS = [
  "#1D9E75",
  "#378ADD",
  "#EF9F27",
  "#D4537E",
  "rgba(255,255,255,0.2)",
] as const;

export type BizRevenueRow = { name: string; pct: number; color: string };

export type ParsedBusinessIntro =
  | { mode: "fallback"; rawMarkdown: string }
  | {
      mode: "structured";
      introMd: string;
      yearLabel: string | null;
      revenueRows: BizRevenueRow[];
      revenueGeo: string | null;
      advantagesMd: string;
      growthMd: string;
      risksMd: string;
      showBars: boolean;
      showPills: boolean;
    };

/** 與 update_enrichment JSON / enrichment_store 對齊的營收結構欄位 */
export type RevenueMixSegment = { name: string; pct: number };
export type RevenueMixJson = {
  year?: string;
  segments?: RevenueMixSegment[];
  geo?: string;
};

const REV_BLOCK = /\*\*營收結構[^*]*\*\*/;
const ADV_BLOCK =
  /\*\*(?:核心競爭優勢方面|核心技術與競爭優勢方面|核心競爭力與發展方向|核心競爭力)[^*]*\*\*/;
const GROWTH_BLOCK = /\*\*成長動能(?:方面)?\*\*/;
/** 風險段開頭：`**主要風險**` 或行首 `主要風險：`（台積等） */
const RISK_BLOCK = /\*\*主要風險\*\*|(?:^|(?<=[\r\n]))主要風險[：:]/;

const HAN = /\p{Script=Han}/u;

/** Bar 標籤：去 wikilink、去尾字「佔／約」、中文最多 6 字加 … */
export function formatBizRevenueLabel(raw: string): string {
  let s = String(raw).trim();
  s = s.replace(/\[\[([^\[\]]+?)\]\]/g, "$1").replace(/\[\[|\]\]/g, "");
  s = s.trim();
  for (let i = 0; i < 4; i++) {
    const t = s
      .replace(/[，,、．.\s]+$/u, "")
      .replace(/^(約|佔|占)\s*/u, "")
      .replace(/\s*(佔|占|約)\s*$/u, "")
      .trim();
    if (t === s) break;
    s = t;
  }
  return truncateHanRun(s, 6);
}

function truncateHanRun(s: string, maxHan: number): string {
  let hanCount = 0;
  let out = "";
  for (const ch of s) {
    const isH = HAN.test(ch);
    if (isH) {
      if (hanCount >= maxHan) return `${out}…`;
      hanCount += 1;
    }
    out += ch;
  }
  return out;
}

function clampPct(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(100, Math.round(p)));
}

export function normalizeRevenueMix(raw: unknown): RevenueMixJson | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const segsIn = o.segments;
  if (!Array.isArray(segsIn) || segsIn.length === 0) return null;
  const segments: RevenueMixSegment[] = [];
  for (const item of segsIn) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const name = r.name != null ? String(r.name).trim() : "";
    const pct = Number(r.pct);
    if (!name || !Number.isFinite(pct) || pct <= 0 || pct > 100) continue;
    segments.push({ name, pct });
  }
  if (segments.length === 0) return null;
  const year =
    o.year != null && String(o.year).trim() ? String(o.year).trim() : undefined;
  const geo = o.geo != null ? String(o.geo) : undefined;
  return { year, segments, geo };
}

function rowsFromRevenueMix(mix: RevenueMixJson): BizRevenueRow[] {
  const segs = mix.segments ?? [];
  return segs.slice(0, 5).map((s, i) => ({
    name: formatBizRevenueLabel(s.name),
    pct: clampPct(s.pct),
    color: BIZ_REV_BAR_COLORS[i % BIZ_REV_BAR_COLORS.length]!,
  }));
}

function dedupeRevenueRowsByFormattedName(
  rows: { name: string; pct: number }[],
): { name: string; pct: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const key = formatBizRevenueLabel(r.name);
    const prev = m.get(key) ?? 0;
    m.set(key, Math.max(prev, r.pct));
  }
  return [...m.entries()]
    .map(([name, pct]) => ({ name, pct }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 5);
}

function extractGeoFromRevenueBlock(revenueBlock: string): string | null {
  const gm = revenueBlock.match(/依地區[：:]\s*([^。\n]+)/);
  return gm?.[1]?.trim() ?? null;
}

/** 讀取 data/enrichment_store 或 public/data/enrichment 內之 revenue_mix */
export function readRevenueMixForTicker(
  repoRoot: string,
  cwd: string,
  ticker: string,
): RevenueMixJson | null {
  const candidates = [
    path.join(repoRoot, "data", "enrichment_store", `${ticker}.json`),
    path.join(cwd, "public", "data", "enrichment", `${ticker}.json`),
  ];
  for (const fp of candidates) {
    if (!fs.existsSync(fp)) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(fp, "utf8")) as unknown;
      const mix = extractRevenueMixFromDoc(doc);
      if (mix) return mix;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function extractRevenueMixFromDoc(doc: unknown): RevenueMixJson | null {
  if (!doc || typeof doc !== "object") return null;
  const o = doc as Record<string, unknown>;
  if (o.revenue_mix != null) {
    const nested = normalizeRevenueMix(o.revenue_mix);
    if (nested) return nested;
  }
  return normalizeRevenueMix(doc);
}

function extractYearFromLine(line: string): string | null {
  const m =
    line.match(/[（(](\d{4})\s*年/) ||
    line.match(/[（(](\d{4})[）)]/) ||
    line.match(/\((\d{4})\)/);
  return m?.[1] ?? null;
}

/** 取營收敘述中「第一個維度」片段（避免 依平台＋依製程 重複畫 bar）。 */
function firstRevenueDimensionSlice(block: string): string {
  const iBiz = block.indexOf("依業務別");
  const iPlat = block.indexOf("依平台別");
  const iProd = block.indexOf("依產品");
  const starts = [iBiz, iPlat, iProd].filter((i) => i >= 0);
  const i0 = starts.length ? Math.min(...starts) : -1;
  if (i0 < 0) return block;
  const tail = block.slice(i0);
  const stopM = tail.match(/。依(?:製程|地區)|依地區[：:]/);
  return stopM && stopM.index !== undefined
    ? tail.slice(0, stopM.index + 1)
    : tail;
}

function parsePctRows(scan: string): { name: string; pct: number }[] {
  const rows: { name: string; pct: number }[] = [];
  const seen = new Set<string>();

  const tryPush = (nameRaw: string, pctStr: string) => {
    let name = nameRaw.replace(/^[（(][^）)]*[）)]\s*/, "").trim();
    name = name.replace(/^\*\*|\*\*$/g, "").trim();
    if (name.length < 2 || name.length > 42) return;
    if (/依地區|依製程|依業務|依平台|營收結構|^[：:]+$/.test(name)) return;
    if (/[:：]\s*$/.test(name)) return;
    const pct = parseFloat(pctStr);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return;
    const key = `${name}:${pct}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ name, pct });
  };

  const re1 = /([^，。\n]+?)\s*[佔占]\s*(?:約)?\s*([\d.]+)\s*%/g;
  let m: RegExpExecArray | null;
  while ((m = re1.exec(scan)) !== null) {
    tryPush(m[1], m[2]);
    if (rows.length >= 8) break;
  }

  const re2 = /([^，。\n]{2,40}?)合計約\s*([\d.]+)\s*%/g;
  while ((m = re2.exec(scan)) !== null) {
    tryPush(m[1], m[2]);
    if (rows.length >= 8) break;
  }

  const re3 = /([^，。\n]+?)\s*約\s*([\d.]+)\s*%/g;
  while ((m = re3.exec(scan)) !== null) {
    tryPush(m[1], m[2]);
    if (rows.length >= 8) break;
  }

  rows.sort((a, b) => b.pct - a.pct);
  return rows.slice(0, 5);
}

function parseRevenueFromBlock(revenueBlock: string): {
  rows: BizRevenueRow[];
  geo: string | null;
  yearLabel: string | null;
} {
  const headLine = revenueBlock.split(/\r?\n/)[0] ?? revenueBlock;
  const yearLabel = extractYearFromLine(headLine);
  const gm = revenueBlock.match(/依地區[：:]\s*([^。\n]+)/);
  const geo = gm?.[1]?.trim() ?? null;

  const beforeGeo = gm ? revenueBlock.slice(0, gm.index!) : revenueBlock;
  const slice = firstRevenueDimensionSlice(beforeGeo);
  const afterColon = slice.replace(/^[^：:]+[：:]\s*/u, "").trim() || slice;

  const raw = parsePctRows(afterColon);
  const deduped = dedupeRevenueRowsByFormattedName(raw);
  const rows: BizRevenueRow[] = deduped.map((r, i) => ({
    name: formatBizRevenueLabel(r.name),
    pct: r.pct,
    color: BIZ_REV_BAR_COLORS[i % BIZ_REV_BAR_COLORS.length]!,
  }));
  return { rows, geo, yearLabel };
}

function sliceSection(
  md: string,
  startRe: RegExp,
  endRes: RegExp[],
): string | null {
  const m = md.match(startRe);
  if (!m || m.index === undefined) return null;
  const start = m.index + m[0].length;
  let end = md.length;
  const tail = md.slice(start);
  for (const er of endRes) {
    const hit = tail.match(er);
    if (hit && hit.index !== undefined) {
      end = Math.min(end, start + hit.index);
    }
  }
  const text = md
    .slice(start, end)
    .trim()
    .replace(/^[：:，,、．.\s]+/u, "");
  return text || null;
}

/**
 * @param bodyMd `## 業務簡介` 底下純內文（已移除板塊／產業／市值／企業價值行）
 * @param revenueMixOverride enrichment_store 之 revenue_mix（有 segments 時不再用 regex 畫條）
 */
export function parseStructuredBusinessIntro(
  bodyMd: string,
  revenueMixOverride?: RevenueMixJson | null,
): ParsedBusinessIntro {
  const md = bodyMd.trim();
  if (!md) {
    return { mode: "fallback", rawMarkdown: "" };
  }

  const hasRev = REV_BLOCK.test(md);
  const hasAdv = ADV_BLOCK.test(md);
  const hasGrowth = GROWTH_BLOCK.test(md);
  const hasRisk = RISK_BLOCK.test(md);

  const fromStore =
    revenueMixOverride != null
      ? normalizeRevenueMix(revenueMixOverride)
      : null;

  if (
    !hasRev &&
    !hasAdv &&
    !hasGrowth &&
    !hasRisk &&
    !fromStore?.segments?.length
  ) {
    return { mode: "fallback", rawMarkdown: md };
  }

  const revIdx = hasRev ? md.search(REV_BLOCK) : md.length;
  const advIdx = hasAdv ? md.search(ADV_BLOCK) : md.length;
  const growthIdx = hasGrowth ? md.search(GROWTH_BLOCK) : md.length;
  const riskIdx = hasRisk ? md.search(RISK_BLOCK) : md.length;

  let introEnd = md.length;
  if (hasRev) introEnd = Math.min(introEnd, revIdx);
  else if (hasAdv) introEnd = Math.min(introEnd, advIdx);
  else if (hasGrowth) introEnd = Math.min(introEnd, growthIdx);
  else if (hasRisk) introEnd = Math.min(introEnd, riskIdx);

  const introMd = md.slice(0, introEnd).trim();

  let revenueRows: BizRevenueRow[] = [];
  let revenueGeo: string | null = null;
  let yearLabel: string | null = null;

  let revBlock = "";
  if (hasRev) {
    const revStart = md.search(REV_BLOCK);
    const revEnd = Math.min(
      hasAdv ? advIdx : md.length,
      hasGrowth ? growthIdx : md.length,
      hasRisk ? riskIdx : md.length,
    );
    revBlock = md.slice(revStart, revEnd).trim();
  }

  if (fromStore?.segments?.length) {
    revenueRows = rowsFromRevenueMix(fromStore);
    yearLabel = fromStore.year?.trim() || null;
    revenueGeo = fromStore.geo?.trim() || null;
    if (hasRev && revBlock) {
      const headLine = revBlock.split(/\r?\n/)[0] ?? revBlock;
      if (!yearLabel) yearLabel = extractYearFromLine(headLine);
      if (!revenueGeo) revenueGeo = extractGeoFromRevenueBlock(revBlock);
    }
  } else if (hasRev && revBlock) {
    const parsed = parseRevenueFromBlock(revBlock);
    revenueRows = parsed.rows;
    revenueGeo = parsed.geo;
    yearLabel = parsed.yearLabel;
  }

  const advantagesMd =
    sliceSection(md, ADV_BLOCK, [GROWTH_BLOCK, RISK_BLOCK, /\r?\n##\s/u]) ??
    "";
  const growthMd =
    sliceSection(md, GROWTH_BLOCK, [RISK_BLOCK, /\r?\n##\s/u]) ?? "";
  const risksMd =
    sliceSection(md, RISK_BLOCK, [/\r?\n##\s/u]) ?? "";

  const showBars = revenueRows.length > 0;
  const showPills =
    Boolean(advantagesMd.trim()) ||
    Boolean(growthMd.trim()) ||
    Boolean(risksMd.trim());

  if (!showBars && !showPills) {
    return { mode: "fallback", rawMarkdown: md };
  }

  return {
    mode: "structured",
    introMd: introMd || md,
    yearLabel,
    revenueRows,
    revenueGeo,
    advantagesMd: advantagesMd.trim(),
    growthMd: growthMd.trim(),
    risksMd: risksMd.trim(),
    showBars,
    showPills,
  };
}
