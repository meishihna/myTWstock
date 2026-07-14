import type { APIRoute } from "astro";
import YahooFinance from "yahoo-finance2";

export const prerender = false;

const yahooFinance = new YahooFinance({
  suppressNotices: ["yahooSurvey"],
});

const CACHE_TTL_MS = 60_000;
/** 佈署後若曾快取到錯誤 payload，遞增以強制重算 */
const CACHE_BUSTER = 9;
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

type ChartResult0 = {
  meta?: Record<string, unknown>;
  timestamp?: number[];
  indicators?: { quote?: Array<{ close?: unknown[] }> };
};

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
  // 只取「當日/最近整段」日內序列作為線形；不再退回 3 個月日線
  // (3 個月日線與「當日漲跌色」時間軸不一致,且 Yahoo 對某些指數如 ^TWOII
  //  的日線收盤比例是壞的 → 反而造成線與現價對不上)。
  // 拿不到日內序列時回空陣列,交由組裝端改畫「昨收→現價」乾淨兩點線。
  try {
    const intra = await fetchIntradayClosesOnly(symbol);
    if (intra.closes.length >= 2) {
      return {
        sparkline: intra.closes,
        sessionProgress: intra.sessionProgress,
        isLive: intra.isLive,
      };
    }
    return { sparkline: [], sessionProgress: 1.0, isLive: false };
  } catch {
    return { sparkline: [], sessionProgress: 1.0, isLive: false };
  }
}

type OfficialSeries = {
  price: number;
  previousClose: number;
  closes: number[];
  sessionProgress: number;
  isLive: boolean;
  marketTime: string | null;
};

/** 上一次成功的官方櫃買資料(warm lambda 內存活);官方端偶發 5xx 時沿用 */
let lastGoodOtc: OfficialSeries | null = null;

/**
 * 櫃買指數官方即時來源(櫃買中心 https://info.tpex.org.tw/api/mktRT)。
 *
 * Yahoo 的 ^TWOII 報價值其實是另一個指數(例:官方 419.90 -1.20% vs
 * Yahoo 269.45 +0.65%,連漲跌方向都不同),且 Yahoo 無櫃買日內序列,
 * 因此「櫃台」一律改用官方 API,不再使用 Yahoo 報價。
 *
 * 回應格式:
 * - ohlcArray: t=000000 為昨收基準,其後為 09:00–13:30 逐分鐘收盤,
 *   t=999999 為最新快照(略過)
 * - infoArray.y = 昨收;taiex = { index, diff, percent, datetime }(官方現值)
 */
async function fetchOtcOfficial(): Promise<OfficialSeries | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch("https://info.tpex.org.tw/api/mktRT", {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; TWstock/1.0)",
        Referer: "https://www.tpex.org.tw/",
        Accept: "application/json",
      },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return lastGoodOtc;
    const json = (await res.json()) as {
      ohlcArray?: Array<{ c?: string; t?: string }>;
      infoArray?: { y?: string };
      taiex?: { datetime?: string; index?: string };
    };
    const num = (v: unknown): number | null => {
      const n = Number(String(v ?? "").replace(/,/g, ""));
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const rows = json?.ohlcArray;
    if (!Array.isArray(rows) || rows.length === 0) return lastGoodOtc;
    let prevFromSeries: number | null = null;
    const closes: number[] = [];
    let lastMinuteT = "";
    for (const row of rows) {
      const t = String(row?.t ?? "");
      const c = num(row?.c);
      if (c == null) continue;
      if (t === "000000") {
        prevFromSeries = c;
        continue;
      }
      if (t === "999999") continue;
      closes.push(c);
      lastMinuteT = t;
    }
    const previousClose = num(json?.infoArray?.y) ?? prevFromSeries;
    const price =
      num(json?.taiex?.index) ??
      (closes.length ? closes[closes.length - 1]! : null);
    if (price == null || previousClose == null || closes.length < 2) {
      return lastGoodOtc;
    }
    // 逐分鐘 → 每 5 分取樣(與其他指數的 5m K 密度一致),保留最末點
    const sampled: number[] = [];
    for (let i = 0; i < closes.length; i += 5) sampled.push(closes[i]!);
    if (sampled[sampled.length - 1] !== closes[closes.length - 1]) {
      sampled.push(closes[closes.length - 1]!);
    }
    // 台股時段 09:00–13:30;progress 依最後一根分鐘 K 時間
    const hh = Number(lastMinuteT.slice(0, 2));
    const mm = Number(lastMinuteT.slice(2, 4));
    const minuteOfDay = hh * 60 + mm;
    const progress = Math.max(
      0.01,
      Math.min(1, (minuteOfDay - 540) / 270),
    );
    const isLive = progress < 0.995;
    const dtRaw = json?.taiex?.datetime; // 'YYYY/MM/DD HH:mm:ss'(台北時間)
    let marketTime: string | null = null;
    if (
      typeof dtRaw === "string" &&
      /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/.test(dtRaw)
    ) {
      marketTime = new Date(
        dtRaw.replace(/\//g, "-").replace(" ", "T") + "+08:00",
      ).toISOString();
    }
    const out: OfficialSeries = {
      price,
      previousClose,
      closes: sampled,
      sessionProgress: progress,
      isLive,
      marketTime,
    };
    lastGoodOtc = out;
    return out;
  } catch {
    return lastGoodOtc;
  }
}

/** 上一次成功的 Coinbase BTC 資料(warm lambda 內存活) */
let lastGoodBtc: OfficialSeries | null = null;

/**
 * 比特幣來源:Coinbase Exchange 公開 API(免費、無金鑰)。
 *
 * Yahoo 的 BTC-USD 會「常態性劣化」:報價凍結十幾小時、日內 K 只回
 * 零星幾根(曾實測凍結價與真實價差 3%+),故 BTC 主來源改 Coinbase,
 * Yahoo 僅在 Coinbase 失敗時作備援。
 *
 * 語意與 Yahoo 對齊:昨收 = 前一 UTC 日收盤;線 = 今日(UTC)5 分 K;
 * 加密貨幣 24/7,sessionProgress = UTC 日進度、恆為 LIVE。
 * Coinbase candles 回傳「新→舊」,格式 [time, low, high, open, close, vol]。
 */
async function fetchBtcOfficial(): Promise<OfficialSeries | null> {
  try {
    const H = { "User-Agent": "Mozilla/5.0 (compatible; TWstock/1.0)" };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const utc0 = new Date();
    utc0.setUTCHours(0, 0, 0, 0);
    const [dailyRes, m5Res] = await Promise.all([
      fetch(
        "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&limit=3",
        { headers: H, signal: ctrl.signal },
      ),
      fetch(
        `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=300&start=${utc0.toISOString()}&end=${new Date().toISOString()}`,
        { headers: H, signal: ctrl.signal },
      ),
    ]);
    clearTimeout(timer);
    if (!dailyRes.ok || !m5Res.ok) return lastGoodBtc;
    const daily = (await dailyRes.json()) as number[][];
    const m5 = (await m5Res.json()) as number[][];
    if (
      !Array.isArray(daily) ||
      daily.length < 2 ||
      !Array.isArray(m5) ||
      m5.length < 2
    ) {
      return lastGoodBtc;
    }
    const previousClose = Number(daily[1]?.[4]);
    const closesAsc: number[] = [];
    for (let i = m5.length - 1; i >= 0; i--) {
      const c = Number(m5[i]?.[4]);
      if (Number.isFinite(c) && c > 0) closesAsc.push(c);
    }
    const price = closesAsc.length
      ? closesAsc[closesAsc.length - 1]!
      : Number.NaN;
    if (
      !Number.isFinite(previousClose) ||
      previousClose <= 0 ||
      !Number.isFinite(price) ||
      closesAsc.length < 2
    ) {
      return lastGoodBtc;
    }
    const newestT = Number(m5[0]?.[0]);
    const marketTime = Number.isFinite(newestT)
      ? new Date(newestT * 1000).toISOString()
      : null;
    const minutes = (Date.now() - utc0.getTime()) / 60000;
    const sessionProgress = Math.max(0.01, Math.min(1, minutes / 1440));
    const out: OfficialSeries = {
      price,
      previousClose,
      closes: closesAsc,
      sessionProgress,
      isLive: true,
      marketTime,
    };
    lastGoodBtc = out;
    return out;
  } catch {
    return lastGoodBtc;
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

  // 櫃台走官方 API(Yahoo ^TWOII 報價是錯的指數)、比特幣走 Coinbase
  // (Yahoo BTC 會凍結);其餘走 Yahoo batch。btc 保留在 Yahoo batch 內作備援。
  const yahooDefs = DEFS.filter((d) => d.id !== "otc");
  const [rowsMap, otcOfficial, btcOfficial] = await Promise.all([
    fetchQuoteRowsForDefs(yahooDefs),
    fetchOtcOfficial(),
    fetchBtcOfficial(),
  ]);

  const officialFor = (id: MarketTickerId): OfficialSeries | null =>
    id === "otc" ? otcOfficial : id === "btc" ? btcOfficial : null;

  const resolved = DEFS.map((def) => {
    const official = officialFor(def.id);
    if (official) {
      return {
        def,
        q: {
          symbol: def.id === "otc" ? "TPEX:mktRT" : "COINBASE:BTC-USD",
          shortName: undefined as string | undefined,
          currency: def.id === "otc" ? "TWD" : "USD",
          price: official.price,
          previousClose: official.previousClose,
          marketTime: official.marketTime,
        },
      };
    }
    if (def.id === "otc") {
      // 官方失敗時不得退回 Yahoo(錯的指數)→ 顯示占位
      return { def, q: null };
    }
    return { def, q: pickQuoteForDef(def, rowsMap) };
  });

  const emptySpark = {
    sparkline: [] as number[],
    sessionProgress: 1.0,
    isLive: false,
  };
  const sparks = await Promise.all(
    resolved.map((r) => {
      const official = officialFor(r.def.id);
      if (official) {
        return Promise.resolve({
          sparkline: official.closes,
          sessionProgress: official.sessionProgress,
          isLive: official.isLive,
        });
      }
      if (r.def.id === "otc") return Promise.resolve(emptySpark);
      return r.q
        ? fetchSparklineBundle(r.q.symbol)
        : Promise.resolve(emptySpark);
    }),
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
    // 走勢線 = 真實日內序列,以昨收為起點錨定、尾端貼齊現價。
    // 顏色語意交給前端「平盤線分色」(昨收以上紅、以下綠,台股看盤慣例),
    // 因此跳空反轉日(開高走低收紅)也能誠實呈現而不產生顏色矛盾。
    // scaleOk:擋掉 Yahoo 比例壞掉的序列(如櫃買 ^TWOII 日內缺、
    // 日線收盤 352~425 但現值 269)→ 退為「昨收→現價」兩點線。
    const px = q.price;
    const pc = q.previousClose;
    const intra = rawSpark.sparkline;
    const lastPt = intra.length ? intra[intra.length - 1]! : null;
    const scaleOk =
      px != null &&
      lastPt != null &&
      px !== 0 &&
      Math.abs(lastPt / px - 1) <= 0.25;
    let sparkline: number[];
    if (intra.length >= 2 && scaleOk) {
      sparkline =
        pc != null && Number.isFinite(pc) ? [pc, ...intra] : intra.slice();
      if (px != null) sparkline[sparkline.length - 1] = px;
    } else {
      sparkline = ensureSparklinePoints([], px, pc);
    }
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
