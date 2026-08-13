#!/usr/bin/env node
/**
 * FIFO 手算向量 —— TS 版(逐筆佇列消耗)
 *
 * 🔴 期望值是【手算】的,不是任一實作的輸出。
 *    拿一邊的輸出當另一邊的期望值 = golden output:實作一開始就錯的話兩邊一起錯,
 *    而且永遠全綠。同一組向量也用在 supabase/tests/fifo_positions.test.sql。
 *
 * 用法:npx tsx tests/fifo-vectors.mjs
 */
import { computeFifo } from "../src/lib/fifo.ts";

let pass = 0;
const fails = [];
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
const check = (ok, name, got, want) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}(得 ${got},期望 ${want})`); console.log(`  ✗ ${name}  得 ${got} 期望 ${want}`); }
};

const T = (id, date, seq, side, shares, price, fee, tax = 0) => ({
  id, ticker: "2330", trade_date: date, seq, side, shares, price, fee, tax,
});

/* ── 向量①:監督者驗算過的那組 ─────────────────────────────────────────
 * 買 1000@100(費 142.5)、買 1000@110(費 156.75)、賣 1500@120(費 256.5、稅 540)
 *
 * 手算:
 *   買① 每股含費成本 = (100×1000 + 142.5)/1000 = 100.1425
 *   買② 每股含費成本 = (110×1000 + 156.75)/1000 = 110.15675
 *   賣 1500 → 吃光買①(1000)+ 買②的 500
 *   剩餘 = 買②的 500 股,均價 = 110.15675(【不是】105 —— 那是所有買入的平均)
 *
 *   配對 1(買① 1000 股):1000×(120−100) − 142.5 − 256.5×1000/1500 − 540×1000/1500
 *                        = 20000 − 142.5 − 171 − 360 = 19326.5
 *   配對 2(買② 500 股) :500×(120−110) − 156.75×500/1000 − 256.5×500/1500 − 540×500/1500
 *                        = 5000 − 78.375 − 85.5 − 180 = 4656.125
 *   已實現合計 = 19326.5 + 4656.125 = 23982.625
 * ────────────────────────────────────────────────────────────────────── */
console.log("── 向量①:2330 買1000@100 + 買1000@110 → 賣1500@120 ──");
{
  const r = computeFifo([
    T(1, "2024-01-02", 1, "buy", 1000, 100, 142.5),
    T(2, "2024-02-02", 1, "buy", 1000, 110, 156.75),
    T(3, "2024-03-02", 1, "sell", 1500, 120, 256.5, 540),
  ]);
  const h = r.holdings[0];
  check(r.holdings.length === 1, "持倉 1 檔", r.holdings.length, 1);
  check(near(h.shares, 500), "剩餘股數 500", h?.shares, 500);
  check(near(h.avgCost, 110.15675), "均價 110.15675(不是 105)", h?.avgCost, 110.15675);
  check(near(h.costBasis, 500 * 110.15675), "剩餘成本 = 500 × 110.15675", h?.costBasis, 500 * 110.15675);

  check(r.realized.length === 2, "配對明細 2 段", r.realized.length, 2);
  check(near(r.realized[0]?.matchedShares, 1000), "第一段配 1000 股", r.realized[0]?.matchedShares, 1000);
  check(near(r.realized[1]?.matchedShares, 500), "第二段配 500 股", r.realized[1]?.matchedShares, 500);
  check(near(r.realized[0]?.realized, 19326.5), "第一段已實現 19326.5", r.realized[0]?.realized, 19326.5);
  check(near(r.realized[1]?.realized, 4656.125), "第二段已實現 4656.125", r.realized[1]?.realized, 4656.125);

  const total = r.realized.reduce((n, x) => n + x.realized, 0);
  check(near(total, 23982.625), "已實現合計 23982.625", total, 23982.625);
  check(r.anomalies.length === 0, "無賣超", r.anomalies.length, 0);
}

/* ── 向量②:賣超必須被指名(不可靜默變成持倉 0)────────────────────────
 * 買 1000、賣 1500 → 賣超 500 股
 * 手算已實現:1000×(120−100) − 142.5 − 256.5×1000/1500 − 540×1000/1500 = 19326.5
 * ────────────────────────────────────────────────────────────────────── */
console.log("\n── 向量②:賣超(買1000、賣1500)──");
{
  const r = computeFifo([
    T(1, "2024-01-02", 1, "buy", 1000, 100, 142.5),
    T(2, "2024-03-02", 1, "sell", 1500, 120, 256.5, 540),
  ]);
  check(r.holdings.length === 0, "持倉為空", r.holdings.length, 0);
  check(r.anomalies.length === 1, "賣超被指名 1 檔", r.anomalies.length, 1);
  check(near(r.anomalies[0]?.oversoldShares, 500), "賣超 500 股", r.anomalies[0]?.oversoldShares, 500);
  check(near(r.realized[0]?.realized, 19326.5), "已配對部分仍正確計算", r.realized[0]?.realized, 19326.5);
}

/* ── 向量③:同日多筆 → seq 決定先進後出,不可靠日期 ──────────────────
 * 同日買 100@10(seq 1)與 100@20(seq 2);隔日賣 100@30(無費無稅)
 * FIFO 應吃 seq=1 那筆:100×(30−10) = 2000;剩 100 股均價 20
 * ────────────────────────────────────────────────────────────────────── */
console.log("\n── 向量③:同日多筆由 seq 決定順序 ──");
{
  const r = computeFifo([
    T(11, "2024-05-01", 2, "buy", 100, 20, 0),
    T(10, "2024-05-01", 1, "buy", 100, 10, 0),
    T(12, "2024-05-02", 1, "sell", 100, 30, 0, 0),
  ]);
  check(near(r.realized[0]?.realized, 2000), "先出的是 seq=1 那筆(已實現 2000)", r.realized[0]?.realized, 2000);
  check(near(r.holdings[0]?.avgCost, 20), "剩餘均價 20", r.holdings[0]?.avgCost, 20);
}

/* ── 向量④:零股(小數股)—— 整股/零股同一欄,不是另一種東西 ──────────
 * 買 0.5 股 @100(無費)、賣 0.2 股 @150 → 已實現 0.2×50 = 10;剩 0.3 股均價 100
 * ────────────────────────────────────────────────────────────────────── */
console.log("\n── 向量④:零股(小數股)──");
{
  const r = computeFifo([
    T(20, "2024-06-01", 1, "buy", 0.5, 100, 0),
    T(21, "2024-06-02", 1, "sell", 0.2, 150, 0, 0),
  ]);
  check(near(r.realized[0]?.realized, 10), "已實現 10", r.realized[0]?.realized, 10);
  check(near(r.holdings[0]?.shares, 0.3), "剩 0.3 股", r.holdings[0]?.shares, 0.3);
  check(near(r.holdings[0]?.avgCost, 100), "均價 100", r.holdings[0]?.avgCost, 100);
}

console.log(`\n通過 ${pass} 項;失敗 ${fails.length} 項`);
if (fails.length) { for (const f of fails) console.error("  ❌ " + f); process.exit(1); }
console.log("✅ FIFO(TS 逐筆佇列)符合手算向量");
