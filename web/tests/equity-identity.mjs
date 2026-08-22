#!/usr/bin/env node
/**
 * 淨值恆等式的注入測試 —— 不需要資料庫、不需要股價
 *
 * ══════════════════════════════════════════════════════════════════════════
 *     合計損益  = 已實現 + 未實現 + 內部現金流
 *     vs 總存入 = (證券市值 + 現金) − 淨外部資金流
 *     兩者必須相等,而且【與股價無關】—— 股價一動,市值與未實現同時同幅改變。
 *
 * 🔴 所以這條可以寫死進測試,而快照數字(市值/未實現/淨值)不行。
 *    本檔的核心是「改股價 → 差額仍為 0」那一條:它驗的是**性質**,不是某天的值。
 *
 * 🔴 每條「期望失敗」都配一條「期望成功」的對照。
 * 🔴 容差**釘死**成常數(輪 5 的教訓:注入量若從參數推出來,容差改成 1e9 也全綠)。
 *
 * 用法:npx tsx tests/equity-identity.mjs
 * ══════════════════════════════════════════════════════════════════════════
 */
import {
  summarizeEquity,
  splitCashFlows,
  tradeCashImpact,
  EXTERNAL_KINDS,
  INTERNAL_KINDS,
  IDENTITY_TOL_TWD,
} from "../src/lib/equity.ts";
import { computeFifo } from "../src/lib/fifo.ts";
import { buildHoldingRows } from "../src/lib/tradesApp.ts";

let pass = 0;
const fails = [];
const check = (ok, name, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(name);
    console.log(`  ✗ ${name}   ${detail}`);
  }
};

/* ══════════════════════════════════════════════════════════════════════
 * 夾具:合成交易,每個數字都可手算
 *
 *   入金        600,000
 *   買 A 1000 @100 費 142   現金 −100,142   每股成本 100.142
 *   買 A  500 @120 費  85   現金  −60,085   每股成本 120.17
 *   賣 A 1200 @130 費 222 稅 468            現金 +155,310
 *        FIFO:1000 配 lot1、200 配 lot2
 *        已實現 = (30,000−142−185−390) + (2,000−34−37−78) = 29,283 + 1,851 = 31,134
 *        剩 A 300 股 @120.17 → 成本 36,051
 *   買 B  200  @50 費  15   現金  −10,015   成本 10,015
 *
 *   現金 = 600,000 −100,142 −60,085 +155,310 −10,015 = 585,068
 * ══════════════════════════════════════════════════════════════════════ */
const TRADES = [
  { id: 1, ticker: "1111", trade_date: "2026-01-05", seq: 1, side: "buy", shares: 1000, price: 100, fee: 142, tax: 0 },
  { id: 2, ticker: "1111", trade_date: "2026-02-05", seq: 2, side: "buy", shares: 500, price: 120, fee: 85, tax: 0 },
  { id: 3, ticker: "1111", trade_date: "2026-03-05", seq: 3, side: "sell", shares: 1200, price: 130, fee: 222, tax: 468 },
  { id: 4, ticker: "2222", trade_date: "2026-04-05", seq: 4, side: "buy", shares: 200, price: 50, fee: 15, tax: 0 },
];
const DEPOSIT = [{ flow_date: "2026-01-01", kind: "deposit", amount: 600000 }];

const HAND = { cash: 585068, realized: 31134, costBasis: 46066 };

const fifo = computeFifo(TRADES);
const REALIZED = fifo.realized.reduce((n, r) => n + r.realized, 0);

/** 由持倉 + 給定股價組出 HoldingRow[] */
const rowsAt = (prices) =>
  buildHoldingRows(
    fifo.holdings.map((h) => ({ ticker: h.ticker, shares: h.shares, avgCost: h.avgCost, costBasis: h.costBasis })),
    new Map(Object.entries(prices).map(([k, v]) => [k, { price: v, name: null }]))
  );

const sum = (over = {}) =>
  summarizeEquity({
    rows: over.rows ?? rowsAt({ 1111: 125, 2222: 60 }),
    realizedTotal: over.realizedTotal ?? REALIZED,
    cashFlows: over.cashFlows ?? DEPOSIT,
    trades: over.trades ?? TRADES,
    oversoldTickers: over.oversoldTickers ?? [],
  });

/* ══════════════════════════════════════════════════════════════════════ */
console.log("── 夾具自洽(手算對得上,否則下面全是空砲)──");
{
  check(tradeCashImpact(TRADES) === HAND.cash - 600000, `交易淨現金流 = ${HAND.cash - 600000}`, String(tradeCashImpact(TRADES)));
  check(Math.abs(REALIZED - HAND.realized) < 1e-9, `已實現 = ${HAND.realized}(FIFO 逐對加總)`, String(REALIZED));
  const cb = fifo.holdings.reduce((n, h) => n + h.costBasis, 0);
  check(Math.abs(cb - HAND.costBasis) < 1e-9, `剩餘成本 = ${HAND.costBasis}`, String(cb));
  const s = sum();
  check(s.cash === HAND.cash, `現金水位 = ${HAND.cash}`, String(s.cash));
  check(s.totalDeposits === 600000, "總存入 = 600,000", String(s.totalDeposits));
}

console.log("\n── 🔴 恆等式:與股價無關 ──");
{
  /* 對照:一組股價下必須精確為 0 */
  const a = sum();
  check(a.identity.status === "ok", "對照:恆等式成立", JSON.stringify(a.identity));
  check(a.identity.diff === 0, "🔴 差額【精確】為 0(不是「在容差內」)", String(a.identity.diff));

  /* 🔴 核心性質:換股價,兩邊一起動,差額仍為 0 */
  const cases = [
    { 1111: 125, 2222: 60 },
    { 1111: 90, 2222: 40 },
    { 1111: 0.01, 2222: 0.01 },
    { 1111: 9999, 2222: 8888 },
    { 1111: 120.17, 2222: 50.075 }, // 剛好等於成本 → 未實現 0
  ];
  for (const p of cases) {
    const s = sum({ rows: rowsAt(p) });
    check(
      s.identity.status === "ok" && s.identity.diff === 0,
      `股價 ${JSON.stringify(p)} → 差額仍為 0(市值 ${s.securities} · 未實現 ${s.unrealized?.toFixed(2)})`,
      JSON.stringify(s.identity)
    );
  }
}

console.log("\n── 🔴 內部現金流(股息)必須計入合計損益 ──");
{
  const withDiv = sum({ cashFlows: [...DEPOSIT, { flow_date: "2026-05-01", kind: "dividend", amount: 1000 }] });
  check(withDiv.internalFlows === 1000, "股息歸到內部現金流", String(withDiv.internalFlows));
  check(withDiv.totalDeposits === 600000, "🔴 股息【不】算進總存入", String(withDiv.totalDeposits));
  check(withDiv.cash === HAND.cash + 1000, "股息計入現金水位", String(withDiv.cash));
  check(withDiv.identity.status === "ok" && withDiv.identity.diff === 0, "恆等式在有股息時仍成立", JSON.stringify(withDiv.identity));

  /* 🔴🔴 這條的結論是【負面】的,而且必須寫下來:
     把股息改歸成外部,兩邊會【一起】少 1000 → 恆等式照樣成立。
     **恆等式對這一刀是盲的。** 所以分類需要自己的斷言(下一節)。 */
  const misclassified = summarizeEquity({
    rows: rowsAt({ 1111: 125, 2222: 60 }),
    realizedTotal: REALIZED,
    cashFlows: [...DEPOSIT, { flow_date: "2026-05-01", kind: "deposit", amount: 1000 }],
    trades: TRADES,
    oversoldTickers: [],
  });
  check(
    misclassified.identity.status === "ok",
    "🔴 把股息誤歸成存入 → 恆等式【仍然成立】(它偵測不到分類錯誤,這是它的盲區)",
    JSON.stringify(misclassified.identity)
  );
  check(
    misclassified.totalDeposits === 601000 && misclassified.totalPnl === withDiv.totalPnl - 1000,
    "🔴 但顯示的兩個數字都錯了:總存入被灌水、合計損益被低估",
    `${misclassified.totalDeposits} / ${misclassified.totalPnl} vs ${withDiv.totalPnl}`
  );
}

console.log("\n── 🔴 分類自己的斷言(不靠恆等式代勞)──");
{
  check(
    JSON.stringify([...EXTERNAL_KINDS].sort()) === JSON.stringify(["deposit", "withdraw"]),
    "外部資金流【只有】deposit / withdraw",
    JSON.stringify(EXTERNAL_KINDS)
  );
  check(
    JSON.stringify([...INTERNAL_KINDS].sort()) === JSON.stringify(["dividend", "fee", "other"]),
    "內部現金流 = dividend / fee / other(全部計入損益)",
    JSON.stringify(INTERNAL_KINDS)
  );
  /* 雙向:schema 的 5 種 kind 必須被兩邊完整覆蓋且不重疊 —— 新增 kind 時這條會紅 */
  const all = [...EXTERNAL_KINDS, ...INTERNAL_KINDS].sort();
  check(
    JSON.stringify(all) === JSON.stringify(["deposit", "dividend", "fee", "other", "withdraw"]),
    "🔴 schema 的 5 種 kind 被完整覆蓋、無重疊(新增 kind 時這條會紅)",
    JSON.stringify(all)
  );
  const s = splitCashFlows([
    { flow_date: "d", kind: "deposit", amount: 100 },
    { flow_date: "d", kind: "withdraw", amount: -30 },
    { flow_date: "d", kind: "dividend", amount: 7 },
    { flow_date: "d", kind: "fee", amount: -2 },
    { flow_date: "d", kind: "other", amount: 1 },
  ]);
  check(s.external === 70 && s.internal === 6, "逐 kind 分流正確(出金為負,不取絕對值)", JSON.stringify(s));
}

console.log("\n── 🔴 注入:恆等式必須抓到真正的錯 ──");
{
  /* ① 賣出稅的符號寫錯(少減一次 → 現金多 468) */
  const badTax = TRADES.map((t) => (t.side === "sell" ? { ...t, tax: -t.tax } : t));
  const s1 = sum({ trades: badTax });
  check(s1.identity.status === "diff" && Math.abs(s1.identity.diff + 936) < 1e-9, "注入:賣出稅符號寫錯 → 差額 −936,判 diff", JSON.stringify(s1.identity));

  /* ② 已實現算少了 */
  const s2 = sum({ realizedTotal: REALIZED - 500 });
  check(s2.identity.status === "diff" && Math.abs(s2.identity.diff + 500) < 1e-9, "注入:已實現少 500 → 差額 −500", JSON.stringify(s2.identity));

  /* ③ 成本基礎被改(未實現跟著錯,現金不變)*/
  const badRows = rowsAt({ 1111: 125, 2222: 60 }).map((r) =>
    r.ticker === "2222" ? { ...r, costBasis: r.costBasis + 1000, unrealized: (r.marketValue ?? 0) - (r.costBasis + 1000) } : r
  );
  const s3 = sum({ rows: badRows });
  check(s3.identity.status === "diff" && Math.abs(s3.identity.diff + 1000) < 1e-9, "注入:某檔成本基礎多 1000 → 差額 −1000", JSON.stringify(s3.identity));

  /* ④ 漏掉一筆交易的現金影響(FIFO 有、現金沒有)*/
  const s4 = sum({ trades: TRADES.slice(0, 3) });
  check(s4.identity.status === "diff", "注入:現金少算一筆買入 → 判 diff", JSON.stringify(s4.identity));
}

console.log("\n── 🔴 前置條件不成立 → unknown,不是 diff、也不是 ok ──");
{
  /* 缺價 */
  const noPrice = sum({ rows: rowsAt({ 1111: 125 }) }); // 2222 沒給價
  check(noPrice.missingPriceCount === 1, "缺價檔數 = 1", String(noPrice.missingPriceCount));
  check(noPrice.securities === null && noPrice.equity === null, "🔴 缺價 → 市值與淨值留白,不以 0 代替", JSON.stringify([noPrice.securities, noPrice.equity]));
  check(noPrice.identity.status === "unknown" && /現價/.test(noPrice.identity.reason ?? ""), "🔴 缺價 → 恆等式判 unknown 並說明", JSON.stringify(noPrice.identity));
  check(noPrice.allocation.length === 0, "🔴 缺價 → 不給資產配置(分母不可信,不塞一個「其他」蓋掉缺口)", String(noPrice.allocation.length));
  check(noPrice.cash === HAND.cash, "但現金水位仍算得出來(與股價無關)", String(noPrice.cash));

  /* 賣超 */
  const over = sum({ oversoldTickers: ["9999"] });
  check(over.identity.status === "unknown" && /賣超/.test(over.identity.reason ?? ""), "🔴 賣超 → unknown 並指名,不報成「兩張卡不一致」", JSON.stringify(over.identity));
}

console.log("\n── 只有現金的帳號 ──");
{
  const s = summarizeEquity({ rows: [], realizedTotal: 0, cashFlows: DEPOSIT, trades: [], oversoldTickers: [] });
  check(s.securities === 0, "🔴 一檔都沒有 → 證券市值是【0】而不是 null(那是完全已知的)", String(s.securities));
  check(s.equity === 600000 && s.cashPct === 100, "淨值 = 現金 = 600,000,現金占比 100%", `${s.equity}/${s.cashPct}`);
  check(s.identity.status === "ok" && s.identity.diff === 0, "恆等式成立(0 = 0)", JSON.stringify(s.identity));
}

console.log("\n── 資產配置 ──");
{
  const s = sum();
  const total = s.allocation.reduce((n, a) => n + a.pct, 0);
  check(Math.abs(total - 100) < 1e-9, "🔴 各片占比加總 = 100%(含現金片)", String(total));
  check(s.allocation[s.allocation.length - 1].key === "__cash__", "現金片排在最後", s.allocation.at(-1)?.key);
  check(
    s.allocation.slice(0, -1).every((a, i, arr) => i === 0 || arr[i - 1].value >= a.value),
    "個股片依市值遞減排序",
    JSON.stringify(s.allocation.map((a) => a.value))
  );
  check(Math.abs(s.allocation.reduce((n, a) => n + a.value, 0) - s.equity) < 1e-9, "各片金額加總 = 淨值", "");
}

console.log("\n── 🔴 容差釘死 ──");
{
  check(IDENTITY_TOL_TWD === 0.005, "容差 = 0.005 元(放寬它必須同時改這個測試)", String(IDENTITY_TOL_TWD));
  check(IDENTITY_TOL_TWD > 0 && Number.isFinite(IDENTITY_TOL_TWD), "容差為有限正數");
  /* 對照:剛好落在容差內外兩側 */
  const inside = sum({ realizedTotal: REALIZED + 0.004 });
  const outside = sum({ realizedTotal: REALIZED + 0.006 });
  check(inside.identity.status === "ok", "差 0.004(容差內)→ ok", JSON.stringify(inside.identity));
  check(outside.identity.status === "diff", "差 0.006(容差外)→ diff", JSON.stringify(outside.identity));
}

/* ══════════════════════════════════════════════════════════════════════ */
const PLAN = 5 + 6 + 6 + 4 + 4 + 7 + 3 + 4 + 4;
console.log(`\n通過 ${pass} 項;失敗 ${fails.length} 項(plan ${PLAN})`);
if (pass + fails.length !== PLAN) {
  console.error(`❌ plan 對不上:宣告 ${PLAN} 項,實跑 ${pass + fails.length} 項`);
  process.exit(1);
}
if (fails.length) {
  for (const f of fails) console.error("  ❌ " + f);
  process.exit(1);
}
console.log("✅ 恆等式與股價無關地成立,注入必響;分類有自己的斷言(恆等式對它是盲的)");
