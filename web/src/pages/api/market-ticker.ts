import type { APIRoute } from "astro";
import YahooFinance from "yahoo-finance2";

export const prerender = false;

const yahooFinance = new YahooFinance({
  suppressNotices: ["yahooSurvey"],
});

const CACHE_TTL_MS = 60_000;
/** 佈署後若曾快取到錯誤 payload，遞增以強制重算 */
const CACHE_BUSTER = 4;
let cache: { body: string; ts: number; buster: number } | null = null;

export type MarketTickerId =
  | "twii"
  | "otc"
  | "dji"
  | "nasdaq"
  | "sp500"
  | "n225"
  | "usdtwd"
  | "vix"
  | "gold"
  | "oil"
  | "btc";

type TickerDef = {
  id: MarketTickerId;
  labelZh: string;
  /** Yahoo Finance symbols to try in order */
  symbols: string[];
  /** 顯示用：index | equity | fx | commodity | crypto */
  kind: "index" | "equity" | "fx" | "commodity" | "crypto";
};

/**
 * 橫幅顯示順序（與跑馬燈閱讀習慣）：匯率與原物料 → 台股 → 美股 → 日經
 * Yahoo：櫃檯指數 ^TWOII、那斯達克 ^IXIC、BTC-USD
 */
const DEFS: TickerDef[] = [
  { id: "usdtwd", labelZh: "台幣兌美元", symbols: ["USDTWD=X"], kind: "fx" },
  { id: "vix", labelZh: "VIX", symbols: ["^VIX"], kind: "index" },
  {
    id: "gold",
    labelZh: "黃金",
    symbols: ["GC=F"],
    kind: "commodity",
  },
  { id: "oil", labelZh: "原油", symbols: ["CL=F"], kind: "commodity" },
  { id: "btc", labelZh: "比特幣", symbols: ["BTC-USD"], kind: "crypto" },
  { id: "twii", labelZh: "加權", symbols: ["^TWII"], kind: "index" },
  { id: "otc", labelZh: "櫃台", symbols: ["^TWOII", "TWOII.TW"], kind: "index" },
  { id: "dji", labelZh: "道瓊", symbols: ["^DJI"], kind: "index" },
  { id: "nasdaq", labelZh: "那斯達克", symbols: ["^IXIC"], kind: "index" },
  { id: "sp500", labelZh: "S&P 500", symbols: ["^GSPC"], kind: "index" },
  { id: "n225", labelZh: "日經", symbols: ["^N225"], kind: "index" },
];

function pickNumber(
  o: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function extractQuote(q: Record<string, unknown>) {
  const price =
    pickNumber(q, [
      "regularMarketPrice",
      "postMarketPrice",
      "preMarketPrice",
      "bid",
    ]) ?? null;
  const prev =
    pickNumber(q, [
      "regularMarketPreviousClose",
      "previousClose",
      "chartPreviousClose",
    ]) ?? null;
  const t = q.regularMarketTime as Date | undefined;
  const sym = (q.symbol as string) ?? "";
  return {
    symbol: sym,
    shortName: q.shortName as string | undefined,
    currency: (q.currency as string) ?? "TWD",
    price,
    previousClose: prev,
    marketTime: t instanceof Date ? t.toISOString() : null,
  };
}

type QuoteRow = Record<string, unknown>;

async function mergeOneQuoteInto(
  merged: Record<string, QuoteRow>,
  symbol: string,
): Promise<void> {
  try {
    const one = await yahooFinance.quote(symbol);
    const row = Array.isArray(one) ? one[0] : one;
    if (!row || typeof row !== "object") return;
    const o = row as Record<string, unknown>;
    const sym = (o.symbol as string) || symbol;
    merged[sym] = row as QuoteRow;
  } catch {
    /* ignore */
  }
}

/** 單次 batch quote，避免並行多次 quote() 觸發 Yahoo 限流；失敗則逐檔補抓 */
async function fetchQuoteRowsForDefs(
  defs: TickerDef[],
): Promise<Record<string, QuoteRow>> {
  const primary = defs.map((d) => d.symbols[0]).filter(Boolean);
  const merged: Record<string, QuoteRow> = {};

  const pullBatch = async (symbols: string[]) => {
    if (symbols.length === 0) return;
    const obj = (await yahooFinance.quote(symbols, {
      return: "object",
    })) as Record<string, QuoteRow>;
    for (const k of Object.keys(obj)) {
      merged[k] = obj[k]!;
    }
  };

  try {
    await pullBatch(primary);
  } catch {
    for (const s of primary) {
      await mergeOneQuoteInto(merged, s);
    }
  }

  const altSyms: string[] = [];
  for (const def of defs) {
    let ok = false;
    for (const s of def.symbols) {
      const row = merged[s];
      if (
        row &&
        pickNumber(row as Record<string, unknown>, [
          "regularMarketPrice",
          "postMarketPrice",
          "preMarketPrice",
          "bid",
        ]) != null
      ) {
        ok = true;
        break;
      }
    }
    if (!ok) {
      for (const s of def.symbols.slice(1)) {
        if (s) altSyms.push(s);
      }
    }
  }
  const uniqAlts = [...new Set(altSyms)];
  try {
    await pullBatch(uniqAlts);
  } catch {
    for (const s of uniqAlts) {
      await mergeOneQuoteInto(merged, s);
    }
  }

  for (const def of defs) {
    if (pickQuoteForDef(def, merged)) continue;
    for (const s of def.symbols) {
      await mergeOneQuoteInto(merged, s);
      if (pickQuoteForDef(def, merged)) break;
    }
  }

  return merged;
}

function pickQuoteForDef(
  def: TickerDef,
  rows: Record<string, QuoteRow>,
): ReturnType<typeof extractQuote> | null {
  for (const sym of def.symbols) {
    const raw = rows[sym];
    if (!raw) continue;
    const q = extractQuote(raw as Record<string, unknown>);
    if (q.price != null) return q;
  }
  return null;
}

function computeChange(
  price: number | null,
  prev: number | null,
): { change: number | null; changePct: number | null } {
  if (price == null || prev == null || prev === 0) {
    return { change: null, changePct: null };
  }
  const change = Math.round((price - prev) * 1e6) / 1e6;
  const changePct = Math.round((change / prev) * 10000) / 100;
  return { change, changePct };
}

/**
 * 從 Yahoo Chart v8 meta 計算當下交易時段進度。
 *
 * 規則：
 * - 若 meta 無 currentTradingPeriod.regular → 回傳 { 1.0, false }（保守：視為已收盤）
 * - 若 now < regular.start → 開盤前，回傳 { 1.0, false }（前一日完整線）
 * - 若 now >= regular.end → 已收盤，回傳 { 1.0, false }
 * - 若 regular.start <= now < regular.end → 進行中，sessionProgress 為線性比例
 */
function computeSessionProgress(
  meta: unknown,
  nowMs: number = Date.now(),
): { sessionProgress: number; isLive: boolean } {
  const m = meta as {
    currentTradingPeriod?: {
      regular?: { start?: number; end?: number };
    };
  } | null | undefined;
  const regular = m?.currentTradingPeriod?.regular;
  const startSec = regular?.start;
  const endSec = regular?.end;

  if (
    typeof startSec !== "number" ||
    typeof endSec !== "number" ||
    endSec <= startSec
  ) {
    return { sessionProgress: 1.0, isLive: false };
  }

  const startMs = startSec * 1000;
  const endMs = endSec * 1000;

  if (nowMs < startMs) {
    return { sessionProgress: 1.0, isLive: false };
  }
  if (nowMs >= endMs) {
    return { sessionProgress: 1.0, isLive: false };
  }

  const progress = (nowMs - startMs) / (endMs - startMs);
  const clamped = Math.max(0.01, Math.min(0.99, progress));
  return { sessionProgress: clamped, isLive: true };
}

const SPARK_MAX_POINTS = 48;

type ChartResult0 = {
  meta?: Record<string, unknown>;
  timestamp?: number[];
  indicators?: { quote?: Array<{ close?: unknown[] }> };
};

/** Yahoo Chart v8：近月日線收盤（備援：無日內資料時） */
async function fetchSparklineClosesDaily(symbol: string): Promise<number[]> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; TWstock/1.0)" },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      chart?: { result?: ChartResult0[] };
    };
    const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    if (!Array.isArray(closes)) return [];
    const nums: number[] = [];
    for (const c of closes) {
      if (typeof c === "number" && Number.isFinite(c)) nums.push(c);
    }
    if (nums.length < 2) return [];
    return nums.slice(-SPARK_MAX_POINTS);
  } catch {
    return [];
  }
}

type IntradayResult = {
  closes: number[];
  sessionProgress: number;
  isLive: boolean;
};

/** 日內 5 分 K 收盤序列；併帶當下交易時段比例（自 Yahoo chart meta） */
async function fetchIntradayClosesOnly(symbol: string): Promise<IntradayResult> {
  const empty = (): IntradayResult => ({
    closes: [],
    sessionProgress: 1.0,
    isLive: false,
  });
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; TWstock/1.0)" },
    });
    if (!res.ok) return empty();
    const json = (await res.json()) as { chart?: { result?: ChartResult0[] } };
    const r0 = json?.chart?.result?.[0];
    if (!r0) return empty();
    const closes = r0.indicators?.quote?.[0]?.close;
    if (!Array.isArray(closes)) return empty();
    const nums: number[] = [];
    for (const c of closes) {
      if (typeof c === "number" && Number.isFinite(c)) nums.push(c);
    }
    const { sessionProgress, isLive } = computeSessionProgress(r0.meta);
    if (nums.length < 2) {
      return { closes: [], sessionProgress: 1.0, isLive: false };
    }
    return { closes: nums, sessionProgress, isLive };
  } catch {
    return empty();
  }
}

async function fetchSparklineBundle(symbol: string): Promise<{
  sparkline: number[];
  sessionProgress: number;
  isLive: boolean;
}> {
  try {
    const intra = await fetchIntradayClosesOnly(symbol);
    if (intra.closes.length >= 2) {
      return {
        sparkline: intra.closes,
        sessionProgress: intra.sessionProgress,
        isLive: intra.isLive,
      };
    }
    const daily = await fetchSparklineClosesDaily(symbol);
    return { sparkline: daily, sessionProgress: 1.0, isLive: false };
  } catch {
    return { sparkline: [], sessionProgress: 1.0, isLive: false };
  }
}

/** 至少兩點，避免迷你圖空白 */
function ensureSparklinePoints(
  line: number[],
  price: number | null,
  prev: number | null,
): number[] {
  if (line.length >= 2) return line;
  if (price != null && prev != null && price !== prev) return [prev, price];
  if (price != null) return [price * (1 - 5e-4), price];
  if (prev != null) return [prev, prev * (1 + 5e-4)];
  return [0, 1];
}

function fmtPriceForKind(
  kind: "index" | "equity" | "fx" | "commodity" | "crypto",
  n: number | null,
): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  if (kind === "fx") {
    return n.toLocaleString("zh-TW", {
      minimumFractionDigits: 3,
      maximumFractionDigits: 4,
    });
  }
  if (kind === "commodity" || kind === "crypto") {
    return n.toLocaleString("zh-TW", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  return n.toLocaleString("zh-TW", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export const GET: APIRoute = async () => {
  const now = Date.now();
  if (
    cache &&
    cache.buster === CACHE_BUSTER &&
    now - cache.ts < CACHE_TTL_MS
  ) {
    return new Response(cache.body, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  }

  const rowsMap = await fetchQuoteRowsForDefs(DEFS);

  const resolved = DEFS.map((def) => ({
    def,
    q: pickQuoteForDef(def, rowsMap),
  }));

  const sparks = await Promise.all(
    resolved.map((r) =>
      r.q
        ? fetchSparklineBundle(r.q.symbol)
        : Promise.resolve({
            sparkline: [] as number[],
            sessionProgress: 1.0,
            isLive: false,
          }),
    ),
  );

  const items = resolved.map((r, i) => {
    const def = r.def;
    if (!r.q) {
      return {
        id: def.id,
        labelZh: def.labelZh,
        kind: def.kind,
        yahooSymbol: null,
        price: null,
        previousClose: null,
        change: null,
        changePct: null,
        marketTime: null,
        sparkline: [] as number[],
        sessionProgress: 1.0,
        isLive: false,
        priceDisplay: null,
        changeDisplay: null,
        changePctDisplay: null,
        error: true as const,
      };
    }
    const q = r.q;
    const rawSpark = sparks[i]!;
    const sparkline = ensureSparklinePoints(
      rawSpark.sparkline,
      q.price,
      q.previousClose,
    );
    const { change, changePct } = computeChange(q.price, q.previousClose);
    return {
      id: def.id,
      labelZh: def.labelZh,
      kind: def.kind,
      yahooSymbol: q.symbol,
      price: q.price,
      previousClose: q.previousClose,
      change,
      changePct,
      marketTime: q.marketTime,
      sparkline,
      sessionProgress: rawSpark.sessionProgress,
      isLive: rawSpark.isLive,
      priceDisplay: fmtPriceForKind(def.kind, q.price),
      changeDisplay:
        change == null
          ? null
          : (change >= 0 ? "+" : "") +
            (def.kind === "fx"
              ? change.toFixed(4)
              : change.toLocaleString("zh-TW", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })),
      changePctDisplay:
        changePct == null
          ? null
          : (changePct >= 0 ? "+" : "") + changePct.toFixed(2) + "%",
    };
  });

  const body = JSON.stringify({ items, fetchedAt: new Date().toISOString() });
  cache = { body, ts: now, buster: CACHE_BUSTER };

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60",
    },
  });
};
