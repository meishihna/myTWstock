/**
 * 瀏覽器現場回測 —— IndexedDB 快取 + 流程編排。
 *
 * 引擎模組放在 public/scripts/(執行期動態 import),與資料端 Python 版【位元級 0 差】,
 * 由 tests/reconcile-live.mjs 逐格對帳把關(離線可重跑)。
 *
 * 紅線:結果只存在使用者瀏覽器,不上傳、不進任何共享快取。
 */

/**
 * ⚠️ 改動 public/scripts/{backtest,pyround,chipsbits,twsebars}.mjs 任一支,
 *    【必須】把這個值 +1,否則舊快取會被沿用 → 顯示過期數字而無人察覺。
 *    這是 key 的一部分,bump 後所有舊結果自動失效。
 */
export const ENGINE_VERSION = "2";
/*
 * v1 → v2(2026-08-05):`twsebars.mjs` 加入市場分派(上櫃走 /api/tpex/bars 代理)。
 * bump 的另一個必要理由:v1 期間上櫃個股在 UI 上是「不支援」狀態,
 * 若沿用舊快取鍵,那個狀態可能殘留;bump 後所有舊結果失效、重算一次。
 */

const DB_NAME = "twstock-backtest";
const DB_VER = 1;
const STORE_RESULTS = "results";
const STORE_MONTHS = "months";
/** 結果快取上限(檔);超過依 lastSeenAt LRU 淘汰 */
export const MAX_RESULTS = 50;

export type LiveCombo = { s: (number | null)[]; t: number[][] };
export interface LiveResult {
  key: string;
  code: string;
  asof: string;
  months: number;
  engineVersion: string;
  bitsAsof: string;
  computedAt: number;
  lastSeenAt: number;
  barsCount: number;
  /** 確認層位元圖涵蓋的天數;< barsCount 代表位元圖較舊 */
  covered: number | null;
  /** false = 無官方籌碼位元圖(上櫃/新上市)→ 只有 90 組 */
  confirmed: boolean;
  combos: LiveCombo[];
  meta: Record<string, unknown>;
  buyhold: { "總報酬%": number; "最大回撤%": number };
  prices: { dates: string[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[] };
}

export function resultKey(code: string, asof: string, bitsAsof: string): string {
  return `${code}|${asof}|eng${ENGINE_VERSION}|bits${bitsAsof}`;
}

/* ── IndexedDB ─────────────────────────────────────────────── */

let dbPromise: Promise<IDBDatabase> | null = null;

export function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_RESULTS)) {
        db.createObjectStore(STORE_RESULTS, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(STORE_MONTHS)) {
        db.createObjectStore(STORE_MONTHS, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );
}

/* 逐月日K快取:歷史月份不會再變,只有當月要更新 */
const monthKey = (code: string, ym: string) => `${code}|${ym}`;

export async function getMonth(code: string, ym: string): Promise<unknown[] | null> {
  if (!idbAvailable()) return null;
  try {
    const rec = await tx<{ bars: unknown[] } | undefined>(STORE_MONTHS, "readonly", (s) =>
      s.get(monthKey(code, ym)),
    );
    return rec?.bars ?? null;
  } catch {
    return null;
  }
}

export async function putMonth(code: string, ym: string, bars: unknown[]): Promise<void> {
  if (!idbAvailable()) return;
  try {
    await tx(STORE_MONTHS, "readwrite", (s) =>
      s.put({ key: monthKey(code, ym), code, ym, bars, at: Date.now() }),
    );
  } catch {
    /* 配額或私密模式 —— 不快取不影響功能 */
  }
}

export async function getResult(key: string): Promise<LiveResult | null> {
  if (!idbAvailable()) return null;
  try {
    const rec = await tx<LiveResult | undefined>(STORE_RESULTS, "readonly", (s) => s.get(key));
    if (rec) {
      rec.lastSeenAt = Date.now();
      tx(STORE_RESULTS, "readwrite", (s) => s.put(rec)).catch(() => {});
    }
    return rec ?? null;
  } catch {
    return null;
  }
}

/** 依 lastSeenAt LRU 淘汰到剩 keep 筆 */
async function evictTo(keep: number): Promise<number> {
  const all = await tx<LiveResult[]>(STORE_RESULTS, "readonly", (s) => s.getAll());
  if (all.length <= keep) return 0;
  const doomed = all.sort((a, b) => (a.lastSeenAt ?? 0) - (b.lastSeenAt ?? 0)).slice(0, all.length - keep);
  for (const d of doomed) await tx(STORE_RESULTS, "readwrite", (s) => s.delete(d.key)).catch(() => {});
  return doomed.length;
}

export async function putResult(rec: LiveResult): Promise<{ cached: boolean; evicted: number }> {
  if (!idbAvailable()) return { cached: false, evicted: 0 };
  let evicted = 0;
  try {
    evicted = await evictTo(MAX_RESULTS - 1);
    await tx(STORE_RESULTS, "readwrite", (s) => s.put(rec));
    return { cached: true, evicted };
  } catch {
    // 配額不足:先砍一半再試一次;仍失敗就【照常顯示結果但不快取】,不阻斷功能
    try {
      evicted += await evictTo(Math.floor(MAX_RESULTS / 2));
      await tx(STORE_RESULTS, "readwrite", (s) => s.put(rec));
      return { cached: true, evicted };
    } catch {
      return { cached: false, evicted };
    }
  }
}

export async function listResults(): Promise<LiveResult[]> {
  if (!idbAvailable()) return [];
  try {
    return await tx<LiveResult[]>(STORE_RESULTS, "readonly", (s) => s.getAll());
  } catch {
    return [];
  }
}

export async function clearAll(): Promise<void> {
  if (!idbAvailable()) return;
  await tx(STORE_RESULTS, "readwrite", (s) => s.clear()).catch(() => {});
  await tx(STORE_MONTHS, "readwrite", (s) => s.clear()).catch(() => {});
}

/** 回傳 {usage, quota, ratio};瀏覽器不支援時回 null */
export async function quota(): Promise<{ usage: number; quota: number; ratio: number } | null> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est || !est.quota) return null;
    return { usage: est.usage ?? 0, quota: est.quota, ratio: (est.usage ?? 0) / est.quota };
  } catch {
    return null;
  }
}

/* ── 市場判定 ──────────────────────────────────────────────── */

export type Market = "twse" | "tpex" | "unknown";

/** 由 stockSuffix.json 判市場;.TW = 上市、.TWO = 上櫃 */
export function marketOf(code: string, suffix: Record<string, string>): Market {
  const s = suffix?.[code];
  if (s === ".TW") return "twse";
  if (s === ".TWO") return "tpex";
  return "unknown";
}

/* ── 流程編排 ──────────────────────────────────────────────── */

export type Phase = "fetch" | "chips" | "compute" | "done";
export interface Progress {
  phase: Phase;
  done: number;
  total: number;
  /** 本次已從快取命中的月份數(用於「重試將從中斷處繼續」提示) */
  cacheHits: number;
}

export class LiveBacktestError extends Error {
  /**
   * ⚠️ `tpex` 的語意已改變(2026-08-05):
   *   舊 = 「上櫃不支援現場計算」;新 = 「上櫃【代理】失敗」。
   * 上櫃本身已支援,呼叫端不可再用它當「不支援」的理由。
   */
  kind: "tpex" | "not_listed" | "fetch" | "insufficient" | "engine";
  /** 抓取中斷時已完成的月份數,供續傳提示 */
  progress?: { done: number; total: number };
  constructor(kind: LiveBacktestError["kind"], message: string, progress?: { done: number; total: number }) {
    super(message);
    this.kind = kind;
    this.progress = progress;
  }
}

/**
 * 現場計算單一個股(上市 + 上櫃)。
 *
 * 上市 → `twsebars.mjs` 直連 TWSE STOCK_DAY(官方回 ACAO: *)。
 * 上櫃 → 走本站 SSR 代理 `/api/tpex/bars/{code}/{ym}`(TPEx 無 ACAO,瀏覽器抓不到)。
 * 代理已把 TPEx 的格式差異與【成交量張數 ×1000】處理完,本層不需分辨。
 *
 * ⚠️ 上櫃沒有官方籌碼(T86 / MI_MARGN 僅上市)→ `makeConfirm` 回 null →
 *    只有「無」確認層 = **90 組**(對照上市 450 組)。這是資料本質,不是失敗。
 */
export async function computeLive(
  code: string,
  opts: {
    asof: string;
    months: number;
    /** 未指定 = 上市(維持既有呼叫端行為不變) */
    market?: Market;
    signal?: AbortSignal;
    onProgress?: (p: Progress) => void;
  },
): Promise<LiveResult> {
  const { asof, months, signal, onProgress } = opts;
  const market: Market = opts.market === "tpex" ? "tpex" : "twse";

  /* 引擎模組放在 public/,Vite 不允許靜態 import。
     用【執行期組出的 URL】讓 import-analysis 無法靜態分析 → 原樣保留動態載入。
     這也維持了與資料端交付契約一致的路徑(/scripts/*.mjs),
     tests/reconcile-live.mjs 對帳的就是同一批檔案。 */
  const modUrl = (name: string) => `${location.origin}/scripts/${name}.mjs`;
  const [{ fetchRawBars }, { runBacktest }, { makeConfirm }] = await Promise.all([
    import(/* @vite-ignore */ modUrl("twsebars")),
    import(/* @vite-ignore */ modUrl("backtest")),
    import(/* @vite-ignore */ modUrl("chipsbits")),
  ]);

  let cacheHits = 0;
  let lastDone = 0;
  let bars: { d: string }[];
  try {
    const res = await fetchRawBars(code, {
      asof,
      months,
      gapMs: 350,
      market,
      signal,
      getCached: (ym: string) => getMonth(code, ym),
      putCached: (ym: string, b: unknown[]) => putMonth(code, ym, b),
      onProgress: (p: { done: number; total: number }) => {
        lastDone = p.done;
        onProgress?.({ phase: "fetch", done: p.done, total: p.total, cacheHits });
      },
    });
    bars = res.bars;
    cacheHits = res.stats.cacheHits;
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new LiveBacktestError("fetch", String((e as Error)?.message ?? e), { done: lastDone, total: months });
  }

  if (!bars.length) {
    throw new LiveBacktestError("not_listed", "no_bars");
  }

  onProgress?.({ phase: "chips", done: months, total: months, cacheHits });
  const [exAll, bits] = await Promise.all([
    fetch("/data/ex-factors.json").then((r) => r.json()),
    fetch("/data/chips-bits.json").then((r) => r.json()),
  ]);
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");

  const exEvents = (exAll.events?.[code] ?? []).map(([date, ratio]: [string, number]) => ({ date, ratio }));
  const confirm = makeConfirm(bits, code, bars.map((b) => b.d));

  onProgress?.({ phase: "compute", done: months, total: months, cacheHits });
  let out: {
    combos: LiveCombo[];
    meta: Record<string, unknown>;
    buyhold: LiveResult["buyhold"];
    prices: LiveResult["prices"];
  };
  try {
    out = runBacktest(bars, { exEvents, ...(confirm ? { confirm } : {}) });
  } catch (e) {
    throw new LiveBacktestError("engine", String((e as Error)?.message ?? e));
  }
  if (!out?.combos?.length) throw new LiveBacktestError("insufficient", "no_combos");

  const rec: LiveResult = {
    key: resultKey(code, asof, bits.asof),
    code,
    asof,
    months,
    engineVersion: ENGINE_VERSION,
    bitsAsof: bits.asof,
    computedAt: Date.now(),
    lastSeenAt: Date.now(),
    barsCount: bars.length,
    covered: confirm?.series?.covered ?? null,
    confirmed: !!confirm,
    combos: out.combos,
    meta: out.meta,
    buyhold: out.buyhold,
    prices: out.prices,
  };

  onProgress?.({ phase: "done", done: months, total: months, cacheHits });
  return rec;
}
