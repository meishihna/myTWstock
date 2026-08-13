/**
 * /trades 的資料層行為(輪 2:交易 CRUD + 雙實作比對)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 這裡沒有任何權限判斷。能不能讀寫由資料庫的 RLS 決定,不由這段程式決定。
 *    所有查詢都不帶 user_id 條件 —— 帶了也只是多餘的再篩一次,
 *    **不帶才會逼出「RLS 沒生效就什麼都看不到」而不是「看起來正常」**。
 *    寫入時的 user_id 由 session 帶入(policy 的 with check 會擋掉別人的)。
 *
 * 🔴 雙實作比對排在【首次繪製之後】,不擋渲染:
 *    資料先上畫面,比對在背景跑完再標記。否則某天有人有幾千筆交易,
 *    這個比對就成了白畫面的原因。比對自己拋錯也不可擋住頁面,但必須計數。
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeFifo, type Trade } from "./fifo";

/** 與回測引擎同口徑:手續費 0.1425%(買賣各一次)、證交稅 0.3%(賣出才有) */
export const FEE_RATE = 0.001425;
export const TAX_RATE = 0.003;
export const defaultFee = (shares: number, price: number) => shares * price * FEE_RATE;
export const defaultTax = (side: "buy" | "sell", shares: number, price: number) =>
  side === "sell" ? shares * price * TAX_RATE : 0;

export type CompareState = {
  /** idle=尚未跑 · running=背景比對中 · ok=一致 · diff=有出入 · error=比對自己失敗 */
  status: "idle" | "running" | "ok" | "diff" | "error";
  /** 有出入的代號 → 供畫面標「數值待核」 */
  pending: Set<string>;
  /** 比對自己失敗的次數。🔴 不可靜默 —— 沉默有兩種:沒問題,和沒在跑 */
  errorCount: number;
  lastError: string | null;
};

export const newCompareState = (): CompareState => ({
  status: "idle",
  pending: new Set(),
  errorCount: 0,
  lastError: null,
});

export async function fetchTrades(sb: SupabaseClient): Promise<Trade[]> {
  const { data, error } = await sb
    .from("trades")
    .select("id,ticker,trade_date,seq,side,shares,price,fee,tax,note")
    .order("trade_date", { ascending: false })
    .order("seq", { ascending: false })
    .order("id", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id,
    ticker: r.ticker,
    trade_date: r.trade_date,
    seq: r.seq,
    side: r.side,
    shares: Number(r.shares),
    price: Number(r.price),
    fee: Number(r.fee),
    tax: Number(r.tax),
    note: r.note ?? null,
  })) as (Trade & { note: string | null })[];
}

export type TradeInput = {
  ticker: string;
  trade_date: string;
  seq: number;
  side: "buy" | "sell";
  shares: number;
  price: number;
  fee: number;
  tax: number;
  note?: string | null;
};

export async function insertTrade(sb: SupabaseClient, userId: string, t: TradeInput) {
  const { error } = await sb.from("trades").insert({ ...t, user_id: userId });
  if (error) throw new Error(error.message);
}

export async function updateTrade(sb: SupabaseClient, id: number | string, t: TradeInput) {
  // 🔴 不帶 user_id 條件:policy 的 using 已讓別人的列不可見,影響 0 列即為正確結果
  const { error } = await sb.from("trades").update(t).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteTrade(sb: SupabaseClient, id: number | string) {
  const { error } = await sb.from("trades").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/**
 * 雙實作比對:TS(逐筆佇列)vs SQL view(區間重疊)。
 *
 * 回傳有出入的代號集合。**任何一種失敗都不拋出到呼叫端之外** ——
 * 比對壞掉不該讓使用者看不到自己的資料;但它必須被計數並寫進 console。
 */
export async function crossCheck(sb: SupabaseClient, trades: Trade[], st: CompareState): Promise<CompareState> {
  st.status = "running";
  st.pending = new Set();
  try {
    const ts = computeFifo(trades);
    const [{ data: hold, error: e1 }, { data: real, error: e2 }] = await Promise.all([
      sb.from("v_holdings").select("ticker,shares,avg_cost"),
      sb.from("v_realized_lots").select("ticker,realized_pnl"),
    ]);
    if (e1 || e2) throw new Error((e1 || e2)!.message);

    const TOL = 1e-6;
    const sqlH = new Map((hold ?? []).map((h) => [h.ticker as string, h]));
    for (const h of ts.holdings) {
      const s = sqlH.get(h.ticker);
      if (!s || Math.abs(h.shares - Number(s.shares)) > TOL || Math.abs(h.avgCost - Number(s.avg_cost)) > TOL) {
        st.pending.add(h.ticker);
      }
    }
    for (const tk of sqlH.keys()) if (!ts.holdings.some((h) => h.ticker === tk)) st.pending.add(tk);

    const agg = (arr: { ticker: string; v: number }[]) => {
      const m = new Map<string, number>();
      for (const x of arr) m.set(x.ticker, (m.get(x.ticker) ?? 0) + x.v);
      return m;
    };
    const tsR = agg(ts.realized.map((r) => ({ ticker: r.ticker, v: r.realized })));
    const sqlR = agg((real ?? []).map((r) => ({ ticker: r.ticker as string, v: Number(r.realized_pnl) })));
    for (const tk of new Set([...tsR.keys(), ...sqlR.keys()])) {
      if (Math.abs((tsR.get(tk) ?? 0) - (sqlR.get(tk) ?? 0)) > TOL) st.pending.add(tk);
    }

    st.status = st.pending.size ? "diff" : "ok";
    if (st.pending.size) {
      // 技術細節走 console;畫面上用平白說法(見 trades.astro 的「數值待核」)
      console.warn(
        `[trades] FIFO 雙實作結果不一致,涉及代號:${[...st.pending].join(", ")}。` +
          `TS 版為逐筆佇列消耗、SQL view 為區間重疊 —— 兩者刻意用不同演算法,不一致代表其中一邊有誤。`
      );
    }
  } catch (err) {
    st.status = "error";
    st.errorCount += 1;
    st.lastError = err instanceof Error ? err.message : String(err);
    console.warn(`[trades] FIFO 雙實作比對失敗(第 ${st.errorCount} 次):${st.lastError}`);
  }
  return st;
}
