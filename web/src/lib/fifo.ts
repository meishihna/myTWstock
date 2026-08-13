/**
 * FIFO 配對 — TypeScript 版(**逐筆佇列消耗**)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 這一份【刻意】與 SQL view 用不同的演算法:
 *      SQL(`v_realized_lots`)= 把買賣各排成一條數線,取【區間重疊長度】,純集合運算
 *      TS(本檔)            = 買入排成佇列,賣出【逐筆消耗】隊頭,可變狀態機
 *
 *    監督者原本的要求是「兩邊不共用計算程式碼」。但共用程式碼會一起錯,
 *    **共用思路也會** —— 同一個誤解用兩種語言寫兩次,仍然是一把尺。
 *    不同思路才是真的交叉檢查。
 *
 * 🔴 兩邊用【同一組手算向量】測,不拿任一邊的輸出當另一邊的期望值。
 *    後者是 golden output:實作一開始就錯的話兩邊一起錯,而且永遠全綠。
 *
 * 🔴 不做任何捨入。與資料層同一條鐵律:**只算數、不算捨入**。
 *    券商的捨入規則(無條件捨去到元、最低手續費 20、當沖減半…)屬於呈現層,
 *    在這裡捨入會讓 SQL 與 JS 永遠對不齊。
 * ══════════════════════════════════════════════════════════════════════════
 */

export type Trade = {
  id: number | string;
  ticker: string;
  trade_date: string;
  /** 同日多筆的 FIFO 排序依據。只有日期會產生平手,平手 = 配對結果不唯一 = 靜默的不確定性 */
  seq: number;
  side: "buy" | "sell";
  shares: number;
  price: number;
  fee: number;
  tax: number;
};

/** 一買一賣配到的一段 */
export type RealizedLot = {
  ticker: string;
  buyId: Trade["id"];
  sellId: Trade["id"];
  buyDate: string;
  sellDate: string;
  buyPrice: number;
  sellPrice: number;
  matchedShares: number;
  /** 費用依【配到的股數比例】分攤 */
  buyFeeAlloc: number;
  sellFeeAlloc: number;
  sellTaxAlloc: number;
  /** 淨已實現 = 配到股數 ×(賣價 − 買價) − 分攤的買費 − 分攤的賣費 − 分攤的稅 */
  realized: number;
};

export type Holding = {
  ticker: string;
  shares: number;
  /** 剩餘批次的含費成本合計 */
  costBasis: number;
  /** 剩餘批次的加權平均成本(對齊券商對帳單),不是所有買入的平均 */
  avgCost: number;
  openLotCount: number;
  oldestOpenDate: string | null;
};

/** 賣出量 > 買入量 —— 幾乎必然是資料錯誤(漏登買入、代號打錯) */
export type Anomaly = { ticker: string; boughtShares: number; soldShares: number; oversoldShares: number };

export type FifoResult = { holdings: Holding[]; realized: RealizedLot[]; anomalies: Anomaly[] };

/** FIFO 的「先進」必須是全序:(trade_date, seq, id) */
function order(a: Trade, b: Trade): number {
  if (a.trade_date !== b.trade_date) return a.trade_date < b.trade_date ? -1 : 1;
  if (a.seq !== b.seq) return a.seq - b.seq;
  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
}

/**
 * 逐筆狀態機:買入進佇列,賣出消耗隊頭。
 *
 * 每股含費成本 =(price × shares + fee)/ shares —— 買入手續費【計入成本】。
 * 賣出手續費與證交稅【自賣出價扣除】,依配到的股數比例分攤。
 */
export function computeFifo(trades: Trade[]): FifoResult {
  const byTicker = new Map<string, Trade[]>();
  for (const t of trades) {
    if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, []);
    byTicker.get(t.ticker)!.push(t);
  }

  const holdings: Holding[] = [];
  const realized: RealizedLot[] = [];
  const anomalies: Anomaly[] = [];

  for (const [ticker, listRaw] of byTicker) {
    const list = [...listRaw].sort(order);

    /** 佇列:每個元素是一筆買入的剩餘部分 */
    const queue: { t: Trade; remaining: number; costPerShare: number }[] = [];
    let bought = 0;
    let sold = 0;
    let oversold = 0;

    for (const t of list) {
      if (t.side === "buy") {
        bought += t.shares;
        queue.push({
          t,
          remaining: t.shares,
          costPerShare: (t.price * t.shares + t.fee) / t.shares,
        });
        continue;
      }

      sold += t.shares;
      let need = t.shares;
      while (need > 0 && queue.length > 0) {
        const head = queue[0]!;
        const take = Math.min(need, head.remaining);

        const buyFeeAlloc = (head.t.fee * take) / head.t.shares;
        const sellFeeAlloc = (t.fee * take) / t.shares;
        const sellTaxAlloc = (t.tax * take) / t.shares;

        realized.push({
          ticker,
          buyId: head.t.id,
          sellId: t.id,
          buyDate: head.t.trade_date,
          sellDate: t.trade_date,
          buyPrice: head.t.price,
          sellPrice: t.price,
          matchedShares: take,
          buyFeeAlloc,
          sellFeeAlloc,
          sellTaxAlloc,
          realized: take * (t.price - head.t.price) - buyFeeAlloc - sellFeeAlloc - sellTaxAlloc,
        });

        head.remaining -= take;
        need -= take;
        if (head.remaining <= 0) queue.shift();
      }
      /**
       * 🔴 佇列空了但還要賣 → 賣超。
       * 不可靜默:持倉會自然變成 0,**看起來完全正常**,而使用者以為自己賣光了。
       * 靜默的零是最難查的錯。
       */
      if (need > 0) oversold += need;
    }

    if (oversold > 0) {
      anomalies.push({ ticker, boughtShares: bought, soldShares: sold, oversoldShares: oversold });
    }

    const openShares = queue.reduce((n, q) => n + q.remaining, 0);
    if (openShares > 0) {
      const costBasis = queue.reduce((n, q) => n + q.remaining * q.costPerShare, 0);
      holdings.push({
        ticker,
        shares: openShares,
        costBasis,
        avgCost: costBasis / openShares,
        openLotCount: queue.length,
        oldestOpenDate: queue[0]?.t.trade_date ?? null,
      });
    }
  }

  holdings.sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
  anomalies.sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
  return { holdings, realized, anomalies };
}

/** 兩份實作比對用:把結果壓成可逐項比較的形狀 */
export function fifoSummary(r: FifoResult) {
  return {
    holdings: r.holdings.map((h) => ({ ticker: h.ticker, shares: h.shares, avgCost: h.avgCost })),
    realizedTotal: r.realized.reduce((n, x) => n + x.realized, 0),
    realizedByTicker: Object.fromEntries(
      [...new Set(r.realized.map((x) => x.ticker))].sort().map((tk) => [
        tk,
        r.realized.filter((x) => x.ticker === tk).reduce((n, x) => n + x.realized, 0),
      ])
    ),
    anomalies: r.anomalies.map((a) => ({ ticker: a.ticker, oversoldShares: a.oversoldShares })),
  };
}
