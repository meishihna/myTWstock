/**
 * 匯入的資料層 —— 貼上內容只走 supabase-js + 使用者自己的 JWT
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 **不經過 `/api/*`,一個位元組都不經過本站伺服器。**
 *    本檔只呼叫 supabase-js;解析在 `importParse.ts`(純函式)。
 *    這條不是慣例,是輪 5 的硬要求。
 *
 * 🔴 對帳的形狀是【先預測,再實跑】:
 *    匯入【之前】,瀏覽器用 `computeFifo(既有 ∪ 貼上)` 算出「這批寫進去之後應該長什麼樣」;
 *    匯入【之後】,資料庫用完全不同的演算法(SQL 的累積區間集合運算)自己算一次。
 *    兩邊逐檔比對 —— 對得上才叫匯入成功。
 *
 *    ⚠️ 為什麼不能只比「筆數對不對」:筆數對而內容錯,是最典型的靜默損壞。
 *    ⚠️ 為什麼不能「(匯入前持倉)+(這批)」相加:FIFO 不可加 ——
 *       這批裡的賣出會沖銷【既有】的買入批次。所以必須拿完整集合重算。
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeFifo, type Holding, type Trade } from "./fifo";
import type { ParsedCashFlow, ParsedTrade, ParseResult } from "./importParse";

/* ── 既有交易(重複偵測 + 預測用)────────────────────────────────── */

export type ExistingTrade = Trade & { import_batch: string | null };

export async function fetchExistingTrades(sb: SupabaseClient): Promise<ExistingTrade[]> {
  // 🔴 不帶 user_id 條件 —— RLS 沒生效時要看到「什麼都沒有」,而不是「看起來正常」
  const { data, error } = await sb
    .from("trades")
    .select("id,ticker,trade_date,seq,side,shares,price,fee,tax,import_batch")
    .order("trade_date")
    .order("seq")
    .order("id");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id as number,
    ticker: r.ticker as string,
    trade_date: String(r.trade_date),
    seq: Number(r.seq),
    side: r.side as "buy" | "sell",
    shares: Number(r.shares),
    price: Number(r.price),
    fee: Number(r.fee),
    tax: Number(r.tax),
    import_batch: (r.import_batch as string | null) ?? null,
  }));
}

/* ── 預測:這批寫進去之後,持倉應該長什麼樣 ────────────────────── */

/**
 * 把解析結果轉成 FIFO 用的 Trade。
 * `id` 用一個不會與資料庫序號相撞的字串 —— FIFO 的平手排序會用到 id,
 * 而預測與實跑必須排出同樣的順序(兩邊都是 trade_date → seq → id,seq 已單調遞增)。
 */
const toFifoTrade = (t: ParsedTrade): Trade => ({
  id: `paste-${t.rowNo}`,
  ticker: t.ticker,
  trade_date: t.trade_date,
  seq: t.seq,
  side: t.side,
  shares: t.shares.num,
  price: t.price.num,
  fee: t.fee.num,
  tax: t.tax.num,
});

export type Prediction = { holdings: Holding[]; oversold: { ticker: string; oversoldShares: number }[] };

/** 🔴 拿【完整集合】重算,不做加法。 */
export function predictHoldings(existing: Trade[], parsed: ParsedTrade[], excluded: Set<number>): Prediction {
  const incoming = parsed.filter((t) => !excluded.has(t.rowNo)).map(toFifoTrade);
  const r = computeFifo([...existing, ...incoming]);
  return {
    holdings: r.holdings.slice().sort((a, b) => a.ticker.localeCompare(b.ticker)),
    oversold: r.anomalies.map((a) => ({ ticker: a.ticker, oversoldShares: a.oversoldShares })),
  };
}

/* ── 寫入 ────────────────────────────────────────────────────────── */

/**
 * 🔴 數字一律送【原始字串】。
 *    JS 的 `number` 是雙精度;把 `12345678901234.5678` 丟進去再序列化就已經失真了,
 *    而且失真後看起來完全正常。字面值直送,十進位轉換交給 Postgres。
 */
const tradeRow = (t: ParsedTrade) => ({
  ticker: t.ticker,
  trade_date: t.trade_date,
  seq: String(t.seq),
  side: t.side,
  shares: t.shares.raw,
  price: t.price.raw,
  fee: t.fee.raw,
  tax: t.tax.raw,
  note: t.note,
});

const cashRow = (c: ParsedCashFlow) => ({
  flow_date: c.flow_date,
  kind: c.kind,
  amount: c.amount.raw,
  ticker: "",
  note: c.note,
});

export type ImportStats = {
  sourceRowCount: number;
  tradeCount: number;
  cashFlowCount: number;
  excludedCount: number;
  actionCounts: Record<string, number>;
  notesImported: boolean;
};

/**
 * 一次 RPC 寫完三張表。
 * 🔴 不用三次 `insert` —— 那是三個交易,中途失敗會留下一半的持股。
 */
export async function runImport(
  sb: SupabaseClient,
  parsed: ParseResult,
  excluded: Set<number>,
  opts: { notesImported: boolean; note?: string }
): Promise<{ batchId: string; stats: ImportStats }> {
  const trades = parsed.trades.filter((t) => !excluded.has(t.rowNo));
  const cashFlows = parsed.cashFlows.filter((c) => !excluded.has(c.rowNo));
  const stats: ImportStats = {
    sourceRowCount: parsed.sourceRowCount,
    tradeCount: trades.length,
    cashFlowCount: cashFlows.length,
    excludedCount: excluded.size,
    actionCounts: parsed.actionCounts,
    notesImported: opts.notesImported,
  };

  const { data, error } = await sb.rpc("import_paste", {
    p_source_row_count: parsed.sourceRowCount,
    p_stats: stats,
    p_trades: trades.map(tradeRow),
    p_cash_flows: cashFlows.map(cashRow),
    p_note: opts.note ?? null,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("匯入沒有回傳批次 id —— 不可當成成功");
  return { batchId: String(data), stats };
}

/* ── 對帳 ────────────────────────────────────────────────────────── */

export type ReconRow = {
  ticker: string;
  /** 匯入前由瀏覽器預測的 */
  expShares: number | null;
  expAvgCost: number | null;
  expCostBasis: number | null;
  /** 匯入後由資料庫算出來的 */
  gotShares: number | null;
  gotAvgCost: number | null;
  gotCostBasis: number | null;
  ok: boolean;
};

export type ReconResult = {
  /** 🔴 三態:`unknown` = 量不到(查詢失敗),不可與 ok 合併 */
  status: "ok" | "diff" | "unknown";
  rows: ReconRow[];
  detail: string;
};

/**
 * 股數比到 1e-6;均價比到 0.005;**成本合計**比到 0.01。
 *
 * 🔴 為什麼三個都要比,而不是只比均價:`均價 = 成本 / 股數`,
 *    除法會把小差異吃掉 —— 兩邊成本差 0.4 元、股數 850 的話,均價只差 0.0005,
 *    在 0.005 的容差裡看不見。**直接比成本合計是嚴格更強的檢查。**
 *    兩邊算式同形(Σ 剩餘股數 × 每股含費成本),差別只有 double vs numeric 的尾數。
 */
const SHARE_TOL = 1e-6;
const COST_TOL = 0.005;
const BASIS_TOL = 0.01;

const near = (a: number | null, b: number | null, tol: number) =>
  a == null || b == null ? a === b : Math.abs(a - b) <= tol;

/**
 * 逐檔比對「匯入前的預測」與「匯入後資料庫算出來的」。
 *
 * 🔴 只要有任一檔對不上就是 `diff`,不看比例、不看「大致相符」。
 * 🔴 查詢失敗時是 `unknown`,**不是 ok** —— 量不到與沒問題是兩件事。
 */
export async function reconcile(sb: SupabaseClient, predicted: Holding[]): Promise<ReconResult> {
  const { data, error } = await sb.from("v_holdings").select("ticker,shares,avg_cost,cost_basis");
  if (error) {
    return { status: "unknown", rows: [], detail: `讀不回持倉,無法對帳:${error.message}` };
  }
  const got = new Map<string, { shares: number; avgCost: number; costBasis: number }>();
  for (const h of data ?? []) {
    got.set(h.ticker as string, {
      shares: Number(h.shares),
      avgCost: Number(h.avg_cost),
      costBasis: Number(h.cost_basis),
    });
  }
  const exp = new Map(predicted.map((h) => [h.ticker, h]));

  const tickers = [...new Set([...exp.keys(), ...got.keys()])].sort();
  const rows: ReconRow[] = tickers.map((ticker) => {
    const e = exp.get(ticker) ?? null;
    const g = got.get(ticker) ?? null;
    return {
      ticker,
      expShares: e?.shares ?? null,
      expAvgCost: e?.avgCost ?? null,
      expCostBasis: e?.costBasis ?? null,
      gotShares: g?.shares ?? null,
      gotAvgCost: g?.avgCost ?? null,
      gotCostBasis: g?.costBasis ?? null,
      ok:
        near(e?.shares ?? null, g?.shares ?? null, SHARE_TOL) &&
        near(e?.avgCost ?? null, g?.avgCost ?? null, COST_TOL) &&
        near(e?.costBasis ?? null, g?.costBasis ?? null, BASIS_TOL),
    };
  });

  const badList = rows.filter((r) => !r.ok);
  if (tickers.length === 0) {
    return { status: "unknown", rows, detail: "沒有任何持倉可比對 —— 這批可能只有現金流,或全部已賣光" };
  }
  return badList.length
    ? { status: "diff", rows, detail: `${badList.length} / ${rows.length} 檔對不上:${badList.map((r) => r.ticker).join("、")}` }
    /* 🔴 這句話必須逐字對應上面實際比的欄位。
       它原本寫「股數與平均成本」,而程式已經在比三欄 ——
       轉述比程式碼窄,會讓讀者以為某一欄沒被檢查(反之更糟)。 */
    : { status: "ok", rows, detail: `${rows.length} 檔逐檔吻合(股數 / 均價 / 成本合計三欄)` };
}

/* ── 批次清單與撤銷 ──────────────────────────────────────────────── */

export type BatchRow = {
  id: string;
  createdAt: string;
  sourceRowCount: number;
  stats: Partial<ImportStats>;
  note: string | null;
  /** 目前資料庫裡還掛在這個批次上的筆數 —— 與 stats 不一定相等(可能被個別刪過) */
  liveTrades: number;
  liveCashFlows: number;
};

export async function fetchBatches(sb: SupabaseClient): Promise<BatchRow[]> {
  const { data, error } = await sb
    .from("import_batches")
    .select("id,created_at,source_row_count,stats,note")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  const batches = data ?? [];
  if (!batches.length) return [];

  /* 現存筆數另外數。🔴 不採信 stats —— 那是匯入當下的快照,
     使用者事後可能個別刪過幾列,顯示快照會讓「撤銷會刪掉幾筆」講錯。 */
  const ids = batches.map((b) => String(b.id));
  const [{ data: tr }, { data: cf }] = await Promise.all([
    sb.from("trades").select("import_batch").in("import_batch", ids),
    sb.from("cash_flows").select("import_batch").in("import_batch", ids),
  ]);
  const countBy = (rows: { import_batch: unknown }[] | null) => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) {
      const k = String(r.import_batch);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const tc = countBy(tr);
  const cc = countBy(cf);

  return batches.map((b) => ({
    id: String(b.id),
    createdAt: String(b.created_at),
    sourceRowCount: Number(b.source_row_count),
    stats: (b.stats ?? {}) as Partial<ImportStats>,
    note: (b.note as string | null) ?? null,
    liveTrades: tc.get(String(b.id)) ?? 0,
    liveCashFlows: cc.get(String(b.id)) ?? 0,
  }));
}

export type UndoResult = { trades: number; cash_flows: number; batch: number };

/**
 * 整批撤銷。回傳【實際刪除筆數】。
 * 🔴 呼叫端必須把筆數顯示出來 ——「撤銷成功」與「撤銷了 39 筆」是兩件事,
 *    而「刪了 0 筆卻說成功」正是最需要被看見的那種失敗。
 */
export async function undoImport(sb: SupabaseClient, batchId: string): Promise<UndoResult> {
  const { data, error } = await sb.rpc("undo_import", { p_batch: batchId });
  if (error) throw new Error(error.message);
  const r = (data ?? {}) as Partial<UndoResult>;
  if (typeof r.batch !== "number") throw new Error("撤銷沒有回傳筆數 —— 不可當成成功");
  return { trades: r.trades ?? 0, cash_flows: r.cash_flows ?? 0, batch: r.batch };
}
