/**
 * 淨值 / 現金水位 / 合計損益 / 資產配置 —— **純函式,不碰資料庫也不碰 DOM**
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 本檔存在的唯一理由是那條恆等式:
 *
 *     合計損益  = 已實現 + 未實現 + 內部現金流
 *     vs 總存入 = (證券市值 + 現金) − 淨外部資金流
 *     ──────────────────────────────────────────
 *     兩者必須【相等】,而且是**定義逼出來的**,不是我們造的裁判。
 *
 * 代數證明(無賣超、無缺價時逐項成立):
 *   現金        = 外部 + 內部 + Σ賣(Q·P−f−t) − Σ買(Q·P+f)
 *   剩餘成本    = Σ買(Q·P+f) − Σ配對(m·Pb + 買費攤)
 *   已實現      = Σ配對(m·Ps − 賣費攤 − 稅攤) − Σ配對(m·Pb + 買費攤)
 *               = Σ賣(Q·P−f−t) − [Σ買(Q·P+f) − 剩餘成本]      ← 全數配對時
 *   未實現      = 市值 − 剩餘成本
 *   ⇒ 合計損益  = 市值 + Σ賣(…) − Σ買(…) + 內部
 *   ⇒ vs 總存入 = 市值 + 外部 + 內部 + Σ賣(…) − Σ買(…) − 外部
 *               = 市值 + Σ賣(…) − Σ買(…) + 內部          **同式**
 *
 * 🔴 所以它**與股價無關**:股價一動,市值與未實現同時同幅改變,兩邊一起走。
 *    這就是為什麼它可以寫死進測試,而快照數字(市值、未實現、淨值)不行。
 *
 * 🔴 兩個【前置條件】,不成立時判 `unknown` 而不是 `diff`:
 *   ① **賣超**:未配對的賣出收入進了現金、卻沒進已實現 → 恆等式必然破。
 *      那是【資料錯誤】的訊號,不是計算錯誤 —— 不可報成「兩張卡不一致」。
 *   ② **缺價**:任何一檔取不到現價 → 市值與未實現都算不出來。
 *      **留白,不以 0 代替**(輪 3 的規則)。
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { Trade } from "./fifo";
import type { HoldingRow } from "./tradesApp";

/* ── 現金流的分類:這一刀劃錯,恆等式會在他第一次登記股息時靜默破掉 ── */

export type CashKind = "deposit" | "withdraw" | "dividend" | "fee" | "other";
export type CashFlowRow = { flow_date: string; kind: CashKind; amount: number };

/**
 * 🔴 **外部**資金流 = 你自己把錢搬進搬出。那是「總存入」的定義,不是損益。
 */
export const EXTERNAL_KINDS: readonly CashKind[] = ["deposit", "withdraw"];

/**
 * 🔴 **內部**現金流 = 股息、帳戶費用、其他 —— 那些是**投資結果的一部分**,
 *    必須計入「合計損益」。
 *
 * 🔴🔴 **這條恆等式對這一刀是【盲】的 —— 不要指望它保護分類。**
 *    把一筆股息從內部改成外部:`external +D`、`internal −D`、**現金不變**
 *      → `vs 總存入` 少 D(因為減掉的存入變多)
 *      → `合計損益` 也少 D(因為內部現金流變少)
 *      → **兩邊一起少 D,恆等式照樣成立。**
 *
 *    (我第一版在這裡寫「分類錯了恆等式會破」。**算一遍就知道那是錯的** ——
 *     沒算就會多宣稱一個不存在的守衛,而那比沒有守衛更糟:它會讓人停止追問。)
 *
 *    分類錯的後果是**顯示出來的兩個數字都錯**(總存入被灌水、合計損益被低估),
 *    而且日後 TWR 完全建立在「外部資金流」的正確性上。
 *    → 所以這一刀需要**自己的**檢查:`tests/equity-identity.mjs` 直接斷言
 *      `splitCashFlows()` 把 `dividend`/`fee`/`other` 歸到內部、只有
 *      `deposit`/`withdraw` 算存入。**不靠恆等式代勞。**
 */
export const INTERNAL_KINDS: readonly CashKind[] = ["dividend", "fee", "other"];

export function splitCashFlows(rows: CashFlowRow[]): { external: number; internal: number } {
  let external = 0;
  let internal = 0;
  for (const r of rows) {
    if (EXTERNAL_KINDS.includes(r.kind)) external += r.amount;
    else internal += r.amount;
  }
  return { external, internal };
}

/**
 * 交易造成的現金淨變動。
 * 買:`−(Q×P + fee)`;賣:`+(Q×P − fee − tax)`。
 *
 * 🔴 這是恆等式右側唯一由【瀏覽器】算的部分,左側(已實現/未實現)全部來自 SQL 檢視。
 *    所以這條恆等式順便就是「TS 算的現金」對「SQL 算的損益」的交叉檢查 ——
 *    符號寫錯、費用漏減,都會讓兩邊分開。
 */
export function tradeCashImpact(trades: Trade[]): number {
  let n = 0;
  for (const t of trades) {
    const gross = t.shares * t.price;
    n += t.side === "buy" ? -(gross + t.fee) : gross - t.fee - t.tax;
  }
  return n;
}

/* ── 恆等式 ─────────────────────────────────────────────────────────── */

/**
 * 🔴 容差**釘死成常數**,而且實際差額一律回傳。
 *
 * 恆等式在精確算術下是 0;唯一的誤差來源是 double 與 numeric 的尾數
 * (~1e-10 於 65 萬量級)。取分位(0.005 元)已寬鬆數個數量級。
 *
 * ⚠️ 放寬它必須同時改 `tests/equity-identity.mjs` 裡釘死的期望值 ——
 *    輪 5 的教訓:注入量若從參數推出來,把容差改成 1e9 也照樣全綠。
 */
export const IDENTITY_TOL_TWD = 0.005;

export type IdentityResult = {
  /** 🔴 三態:`unknown` = 前置條件不成立(量不到),不可與 ok 合併 */
  status: "ok" | "diff" | "unknown";
  /** 已實現 + 未實現 + 內部現金流 */
  totalPnl: number | null;
  /** (證券市值 + 現金) − 淨外部資金流 */
  vsDeposits: number | null;
  /** 實際差額 —— 一律回傳並顯示。容差若不可見,「通過」可能只是容差太鬆 */
  diff: number | null;
  reason?: string;
};

/* ── 總表 ───────────────────────────────────────────────────────────── */

export type EquityInput = {
  rows: HoldingRow[];
  /** Σ v_realized_lots.realized_pnl(來自 SQL) */
  realizedTotal: number;
  cashFlows: CashFlowRow[];
  trades: Trade[];
  /** v_position_anomalies 的代號;非空時恆等式判 unknown */
  oversoldTickers: string[];
};

export type AllocationSlice = {
  key: string;
  label: string;
  /** 金額 */
  value: number;
  /** 占淨值 % */
  pct: number;
};

export type EquitySummary = {
  /** 證券市值。🔴 有任何一檔缺價 → null(不以 0 代替) */
  securities: number | null;
  /** 現金水位 = 全部現金流 + 交易淨現金流。與股價無關,永遠算得出來 */
  cash: number;
  /** 淨值 = 證券 + 現金 */
  equity: number | null;
  /** 總存入(淨外部資金流) */
  totalDeposits: number;
  vsDeposits: number | null;
  realized: number;
  unrealized: number | null;
  internalFlows: number;
  totalPnl: number | null;
  /** 現金占淨值 % */
  cashPct: number | null;
  missingPriceCount: number;
  oversoldTickers: string[];
  identity: IdentityResult;
  /** 資產配置:逐檔 + 現金。缺價時為空陣列(分母不可信) */
  allocation: AllocationSlice[];
};

export function summarizeEquity(input: EquityInput): EquitySummary {
  const { rows, realizedTotal, cashFlows, trades, oversoldTickers } = input;

  const { external, internal } = splitCashFlows(cashFlows);
  const cash = external + internal + tradeCashImpact(trades);

  const priced = rows.filter((r) => r.marketValue != null);
  const missingPriceCount = rows.length - priced.length;

  /**
   * 🔴 「一檔都沒有」與「有持股但取不到價」是兩件事:
   *   前者 → 證券市值確定是 0(完全已知)
   *   後者 → 算不出來 → null
   * `portfolioTotals()` 對前者也回 null,那會讓「只有現金的帳號」淨值變成留白。
   */
  const securities = rows.length === 0 ? 0 : missingPriceCount > 0 ? null : priced.reduce((n, r) => n + (r.marketValue ?? 0), 0);
  const costBasisPriced = rows.length === 0 ? 0 : missingPriceCount > 0 ? null : priced.reduce((n, r) => n + r.costBasis, 0);

  const equity = securities == null ? null : securities + cash;
  const unrealized = securities == null || costBasisPriced == null ? null : securities - costBasisPriced;
  const totalPnl = unrealized == null ? null : realizedTotal + unrealized + internal;
  const vsDeposits = equity == null ? null : equity - external;
  const cashPct = equity == null || equity === 0 ? null : (cash / equity) * 100;

  /* ── 恆等式 ── */
  let identity: IdentityResult;
  if (oversoldTickers.length > 0) {
    identity = {
      status: "unknown",
      totalPnl,
      vsDeposits,
      diff: totalPnl == null || vsDeposits == null ? null : totalPnl - vsDeposits,
      reason:
        /* ⚠️ 這些字串會用 textContent 直接進畫面 —— **不可以寫 markdown 強調**,
           星號會原樣顯示。(實測看到「**留白不以 0 代替**」出現在頁面上才發現。) */
        `有賣超(${oversoldTickers.join("、")})—— 未配對的賣出收入進了現金卻沒進已實現,` +
        `恆等式必然破。那是「資料錯誤」的訊號,不是兩張卡不一致 —— 請先修交易紀錄。`,
    };
  } else if (totalPnl == null || vsDeposits == null) {
    identity = {
      status: "unknown",
      totalPnl,
      vsDeposits,
      diff: null,
      reason:
        `有 ${missingPriceCount} 檔取不到現價 —— 市值與未實現都算不出來,` +
        `留白不以 0 代替,所以這條恆等式無從驗證。`,
    };
  } else {
    const diff = totalPnl - vsDeposits;
    identity = {
      status: Math.abs(diff) <= IDENTITY_TOL_TWD ? "ok" : "diff",
      totalPnl,
      vsDeposits,
      diff,
    };
  }

  /* ── 配置:缺價時分母不可信,一律不給(不是給個「其他」把缺口塞掉)── */
  const allocation: AllocationSlice[] =
    equity == null || equity <= 0
      ? []
      : [
          ...priced
            .map((r) => ({
              key: r.ticker,
              label: r.name ? `${r.ticker} ${r.name}` : r.ticker,
              value: r.marketValue!,
              pct: (r.marketValue! / equity) * 100,
            }))
            .sort((a, b) => b.value - a.value),
          { key: "__cash__", label: "現金", value: cash, pct: (cash / equity) * 100 },
        ];

  return {
    securities,
    cash,
    equity,
    totalDeposits: external,
    vsDeposits,
    realized: realizedTotal,
    unrealized,
    internalFlows: internal,
    totalPnl,
    cashPct,
    missingPriceCount,
    oversoldTickers,
    identity,
    allocation,
  };
}
