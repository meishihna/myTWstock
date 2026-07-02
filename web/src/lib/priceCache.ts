/**
 * Yahoo Finance Chart v8 — 近 90 根可見日線（OHLCV）＋ 5/10/20 日均線；
 * 多抓約 20 根暖身以便第一根 K 線即有完整 MA。僅記憶體快取（5 分鐘 TTL），不落檔。
 *
 * quoteSummary 若用裸 fetch 會需 Crumb；持股／殖利率改走 yahoo-finance2。
 */

import YahooFinance from "yahoo-finance2";

let _yahooFinance: YahooFinance | null = null;
function yahooFinanceClient(): YahooFinance {
  if (!_yahooFinance) {
    _yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
  }
  return _yahooFinance;
}

/** 可見 K 線根數 */
const DISPLAY_BARS = 90;
/** MA20 需前 19 根＋當根；另留 1 根緩衝 → 暖身 20 根 */
const MA_WARMUP = 20;
const TAIL_BARS = DISPLAY_BARS + MA_WARMUP;

export interface PriceData {
  dates: string[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  /** 與 close 同長；暖身足時第一根起皆為有限值，否則前段可能為 null */
  ma5: (number | null)[];
  ma10: (number | null)[];
  ma20: (number | null)[];
  latest: number;
  prevClose: number;
  change: number;
  changePct: number;
  /** ISO 字串，例如 2026-04-16T13:30:00.000Z */
  marketTime: string | null;
  /** Yahoo quoteSummary：持股比例 0–100（%）；缺則 null／undefined（舊快取） */
  insiderPct?: number | null;
  institutionPct?: number | null;
  /** 殖利率 0–100（%）；缺則 null／undefined（舊快取） */
  divYieldPct?: number | null;
}

type CacheEntry = { data: PriceData | null; ts: number };

const cache = new Map<string, CacheEntry>();
const TTL_MS = 5 * 60 * 1000;

type YahooChartJson = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      meta?: {
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
        regularMarketTime?: Date | number;
        symbol?: string;
      };
      indicators?: {
        quote?: Array<{
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }>;
      };
    }>;
  };
};

/** Yahoo 常回傳數字或 `{ raw, fmt }`；遞迴取 raw */
function yahooNumericRaw(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const p = parseFloat(v.replace(/,/g, "").replace(/%/g, "").trim());
    return Number.isFinite(p) ? p : null;
  }
  if (typeof v === "object" && v !== null && "raw" in v) {
    return yahooNumericRaw((v as { raw?: unknown }).raw);
  }
  return null;
}

function yahooRatioToDisplayPercent(raw: unknown): number | null {
  const n = yahooNumericRaw(raw);
  if (n == null || n < 0) return null;
  if (n <= 1) return Math.round(n * 10000) / 100;
  if (n <= 100) return Math.round(n * 100) / 100;
  return null;
}

/**
 * Yahoo quoteSummary（與 K 線分開請求、同一 5 分鐘快取合併）：
 * 內部人／機構持股、殖利率。
 */
async function fetchQuoteSummaryExtras(ticker: string): Promise<{
  insiderPct: number | null;
  institutionPct: number | null;
  divYieldPct: number | null;
}> {
  const empty = {
    insiderPct: null as number | null,
    institutionPct: null as number | null,
    divYieldPct: null as number | null,
  };
  if (!/^\d{4}$/.test(ticker)) return empty;

  const yf = yahooFinanceClient();
  for (const suffix of [".TW", ".TWO"] as const) {
    const symbol = `${ticker}${suffix}`;
    try {
      const r = await yf.quoteSummary(symbol, {
        modules: ["defaultKeyStatistics", "summaryDetail"],
      });
      const d = (r.defaultKeyStatistics ?? {}) as Record<string, unknown>;
      const s = (r.summaryDetail ?? {}) as Record<string, unknown>;
      const insiderPct = yahooRatioToDisplayPercent(d.heldPercentInsiders);
      const institutionPct = yahooRatioToDisplayPercent(
        d.heldPercentInstitutions,
      );
      const divYieldPct = yahooRatioToDisplayPercent(s.dividendYield);
      return { insiderPct, institutionPct, divYieldPct };
    } catch {
      continue;
    }
  }
  return empty;
}

function marketTimeToIso(meta: Record<string, unknown>): string | null {
  const v = meta.regularMarketTime;
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number") {
    const ms = v > 1e12 ? v : v * 1000;
    return new Date(ms).toISOString();
  }
  return null;
}

function rollingSma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += values[j]!;
    }
    out.push(Math.round((sum / period) * 100) / 100);
  }
  return out;
}

async function fetchYahooChartOnce(ticker: string): Promise<PriceData | null> {
  for (const suffix of [".TW", ".TWO"] as const) {
    try {
      const symbol = `${ticker}${suffix}`;
      /** 2y 確保暖身後仍有足夠交易日（遇长假仍盡量滿足 110 根） */
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; TWstock/1.0)" },
      });
      if (!res.ok) continue;
      const json = (await res.json()) as YahooChartJson;
      const result = json?.chart?.result?.[0];
      if (!result) continue;

      const timestamps: number[] = result.timestamp || [];
      const q = result.indicators?.quote?.[0];
      const rawOpen: (number | null)[] = q?.open || [];
      const rawHigh: (number | null)[] = q?.high || [];
      const rawLow: (number | null)[] = q?.low || [];
      const rawClose: (number | null)[] = q?.close || [];
      const rawVolume: (number | null)[] = q?.volume || [];
      const meta = result.meta || {};

      const dates: string[] = [];
      const open: number[] = [];
      const high: number[] = [];
      const low: number[] = [];
      const close: number[] = [];
      const volume: number[] = [];

      for (let i = 0; i < timestamps.length; i++) {
        if (
          rawOpen[i] == null ||
          rawHigh[i] == null ||
          rawLow[i] == null ||
          rawClose[i] == null
        ) {
          continue;
        }
        dates.push(
          new Date(timestamps[i]! * 1000).toISOString().split("T")[0]!,
        );
        open.push(Math.round(Number(rawOpen[i]) * 100) / 100);
        high.push(Math.round(Number(rawHigh[i]) * 100) / 100);
        low.push(Math.round(Number(rawLow[i]) * 100) / 100);
        close.push(Math.round(Number(rawClose[i]) * 100) / 100);
        volume.push(rawVolume[i] ?? 0);
      }

      if (close.length < 2) continue;

      const nAll = dates.length;
      const tailLen = Math.min(nAll, TAIL_BARS);
      const tailFrom = nAll - tailLen;
      const tailDates = dates.slice(tailFrom);
      const tailOpen = open.slice(tailFrom);
      const tailHigh = high.slice(tailFrom);
      const tailLow = low.slice(tailFrom);
      const tailClose = close.slice(tailFrom);
      const tailVol = volume.slice(tailFrom);

      const s5 = rollingSma(tailClose, 5);
      const s10 = rollingSma(tailClose, 10);
      const s20 = rollingSma(tailClose, 20);

      let outFrom: number;
      let outLen: number;
      if (tailLen >= DISPLAY_BARS + MA_WARMUP) {
        outFrom = MA_WARMUP;
        outLen = DISPLAY_BARS;
      } else if (tailLen > MA_WARMUP) {
        outFrom = MA_WARMUP;
        outLen = tailLen - outFrom;
      } else {
        outFrom = 0;
        outLen = tailLen;
      }

      const slice = <T,>(arr: T[]): T[] => arr.slice(outFrom, outFrom + outLen);
      const datesOut = slice(tailDates);
      const openOut = slice(tailOpen);
      const highOut = slice(tailHigh);
      const lowOut = slice(tailLow);
      const closeOut = slice(tailClose);
      const volumeOut = slice(tailVol);

      const ma5 = slice(s5);
      const ma10 = slice(s10);
      const ma20 = slice(s20);

      const latestRaw =
        meta.regularMarketPrice ?? closeOut[closeOut.length - 1]!;
      const latest = Math.round(Number(latestRaw) * 100) / 100;

      const prevRaw =
        meta.chartPreviousClose ??
        meta.previousClose ??
        (closeOut.length >= 2
          ? closeOut[closeOut.length - 2]!
          : closeOut[closeOut.length - 1]!);
      const prevClose = Math.round(Number(prevRaw) * 100) / 100;
      if (prevClose === 0) continue;

      const change = Math.round((latest - prevClose) * 100) / 100;
      const changePct = Math.round((change / prevClose) * 10000) / 100;

      return {
        dates: datesOut,
        open: openOut,
        high: highOut,
        low: lowOut,
        close: closeOut,
        volume: volumeOut,
        ma5,
        ma10,
        ma20,
        latest,
        prevClose,
        change,
        changePct,
        marketTime: marketTimeToIso(meta as Record<string, unknown>),
      };
    } catch {
      continue;
    }
  }
  return null;
}

export async function getPrice(ticker: string): Promise<PriceData | null> {
  if (!/^\d{4}$/.test(ticker)) return null;

  const now = Date.now();
  const hit = cache.get(ticker);
  if (
    hit &&
    now - hit.ts < TTL_MS &&
    hit.data &&
    Array.isArray(hit.data.ma5) &&
    hit.data.ma5.length === hit.data.close.length
  ) {
    return hit.data;
  }

  const [data, extras] = await Promise.all([
    fetchYahooChartOnce(ticker),
    fetchQuoteSummaryExtras(ticker),
  ]);
  if (!data) {
    cache.set(ticker, { data: null, ts: now });
    return null;
  }
  const merged: PriceData = {
    ...data,
    insiderPct: extras.insiderPct,
    institutionPct: extras.institutionPct,
    divYieldPct: extras.divYieldPct,
  };
  cache.set(ticker, { data: merged, ts: now });
  return merged;
}

/** 自選股小卡用:當日盤中分時走勢 + 最新報價 + 市場狀態(盤中/收盤) */
export interface MiniQuote {
  /** 當日 5 分收盤序列(去 null),供 sparkline */
  points: number[];
  /**
   * 與 points 對齊的 X 座標比例(0..1):依每點時間在當日盤中時段[09:00,13:30]的位置計算。
   * 盤中資料只到現在 → 線只走到對應比例;收盤後接近 1 → 幾乎填滿整寬。
   * 時段或時間戳缺失時為空陣列(前端退回等距)。
   */
  xs: number[];
  /** 最新價:盤中＝最新成交,收盤後＝當日收盤(Yahoo regularMarketPrice) */
  latest: number;
  /** 前一交易日收盤 */
  prevClose: number;
  change: number;
  changePct: number;
  /** Yahoo marketState:REGULAR＝盤中;其餘(CLOSED/POST…)＝收盤 */
  state: string;
  /** regularMarketTime ISO */
  time: string | null;
}

const miniCache = new Map<string, { data: MiniQuote | null; ts: number }>();

/** 盤中分時(5 分 K,range=1d)＋最新報價;5 分鐘記憶體快取。 */
export async function getMiniQuote(ticker: string): Promise<MiniQuote | null> {
  if (!/^\d{4}$/.test(ticker)) return null;
  const now = Date.now();
  const hit = miniCache.get(ticker);
  if (hit && now - hit.ts < TTL_MS) return hit.data;

  for (const suffix of [".TW", ".TWO"] as const) {
    try {
      const symbol = `${ticker}${suffix}`;
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; TWstock/1.0)" },
      });
      if (!res.ok) continue;
      const json = (await res.json()) as YahooChartJson;
      const result = json?.chart?.result?.[0];
      if (!result) continue;
      const meta = (result.meta || {}) as Record<string, unknown>;
      const rawClose = result.indicators?.quote?.[0]?.close || [];
      const rawTs = (result as { timestamp?: number[] }).timestamp || [];

      // 盤中時段[start,end](TWSE 約 09:00–13:30):用於把每個點依「當日時間位置」定 X 座標。
      const reg = (
        meta.currentTradingPeriod as { regular?: { start?: number; end?: number } } | undefined
      )?.regular;
      const segStart = reg?.start;
      const segEnd = reg?.end;
      const hasSeg =
        typeof segStart === "number" && typeof segEnd === "number" && segEnd > segStart;
      // 收盤後 currentTradingPeriod.regular 會指向「下一個」(未來)交易時段,當日 K 棒時間全在其之前,
      // 依它定位會把每個點的 (ts-segStart)/range 壓成負值→clamp 0→所有 x=0(線塌成一條)。
      // 僅當 K 棒確實落在此時段內(盤中)才用時間定位;否則 xs 留空→前端等距(完整線)。
      const lastTs = rawTs.length ? rawTs[rawTs.length - 1] : null;
      const segValid =
        hasSeg && typeof lastTs === "number" && lastTs >= (segStart as number);

      const points: number[] = [];
      const xs: number[] = [];
      for (let i = 0; i < rawClose.length; i++) {
        const v = rawClose[i];
        if (v == null || !Number.isFinite(Number(v))) continue;
        points.push(Math.round(Number(v) * 100) / 100);
        if (segValid && typeof rawTs[i] === "number") {
          let f = (rawTs[i]! - segStart!) / (segEnd! - segStart!);
          f = f < 0 ? 0 : f > 1 ? 1 : f;
          xs.push(Math.round(f * 1000) / 1000);
        }
      }
      // 時段或時間戳缺失 → 無法時間定位,清空 xs(前端退回等距)
      if (xs.length !== points.length) xs.length = 0;

      const prevClose =
        Math.round(
          Number(
            (meta.chartPreviousClose as number) ??
              (meta.previousClose as number) ??
              0,
          ) * 100,
        ) / 100;
      const latestRaw =
        (meta.regularMarketPrice as number) ??
        (points.length ? points[points.length - 1]! : prevClose);
      const latest = Math.round(Number(latestRaw) * 100) / 100;
      if (!Number.isFinite(latest) || latest <= 0) continue;

      let change = prevClose > 0 ? Math.round((latest - prevClose) * 100) / 100 : 0;
      let changePct = prevClose > 0 ? Math.round((change / prevClose) * 10000) / 100 : 0;
      // 前收異常(遠超台股 ±10% 漲跌停 → 明顯壞值,如曾見的錯誤前收)→ 視為無效,只顯示價、不顯示假漲跌
      if (prevClose <= 0 || Math.abs(changePct) > 20) {
        change = 0;
        changePct = 0;
      }

      // 盤中判斷:現在時間落在 regular 時段內＝盤中,否則＝收盤。
      const nowSec = Date.now() / 1000;
      const state =
        hasSeg && nowSec >= segStart! && nowSec < segEnd!
          ? "REGULAR"
          : "CLOSED";

      const data: MiniQuote = {
        points,
        xs,
        latest,
        prevClose,
        change,
        changePct,
        state,
        time: marketTimeToIso(meta),
      };
      miniCache.set(ticker, { data, ts: now });
      return data;
    } catch {
      continue;
    }
  }
  miniCache.set(ticker, { data: null, ts: now });
  return null;
}

export interface Bar {
  /** YYYY-MM-DD */
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const barsCache = new Map<string, { bars: Bar[] | null; ts: number }>();

/**
 * 完整 2 年日線 OHLCV（未裁切），供 Lightweight Charts 與未來 Charting Library Datafeed 使用。
 * 與 getPrice 共用 Yahoo Chart v8 與 .TW/.TWO 解析；不裁成 90 根、不算 MA（指標交由圖層處理）。
 */
export async function getBars(ticker: string): Promise<Bar[] | null> {
  if (!/^\d{4}$/.test(ticker)) return null;
  const now = Date.now();
  const hit = barsCache.get(ticker);
  if (hit && now - hit.ts < TTL_MS) return hit.bars;

  for (const suffix of [".TW", ".TWO"] as const) {
    try {
      const symbol = `${ticker}${suffix}`;
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; TWstock/1.0)" },
      });
      if (!res.ok) continue;
      const json = (await res.json()) as YahooChartJson;
      const result = json?.chart?.result?.[0];
      if (!result) continue;

      const ts: number[] = result.timestamp || [];
      const q = result.indicators?.quote?.[0];
      const rawOpen = q?.open || [];
      const rawHigh = q?.high || [];
      const rawLow = q?.low || [];
      const rawClose = q?.close || [];
      const rawVol = q?.volume || [];

      const bars: Bar[] = [];
      for (let i = 0; i < ts.length; i++) {
        if (
          rawOpen[i] == null ||
          rawHigh[i] == null ||
          rawLow[i] == null ||
          rawClose[i] == null
        ) {
          continue;
        }
        bars.push({
          time: new Date(ts[i]! * 1000).toISOString().split("T")[0]!,
          open: Math.round(Number(rawOpen[i]) * 100) / 100,
          high: Math.round(Number(rawHigh[i]) * 100) / 100,
          low: Math.round(Number(rawLow[i]) * 100) / 100,
          close: Math.round(Number(rawClose[i]) * 100) / 100,
          volume: rawVol[i] ?? 0,
        });
      }
      if (bars.length < 2) continue;
      barsCache.set(ticker, { bars, ts: now });
      return bars;
    } catch {
      continue;
    }
  }
  barsCache.set(ticker, { bars: null, ts: now });
  return null;
}
