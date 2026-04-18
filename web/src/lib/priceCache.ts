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
        headers: { "User-Agent": "Mozilla/5.0 (compatible; myTWstock/1.0)" },
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
