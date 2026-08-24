#!/usr/bin/env node
/**
 * 逐日部位 / 淨值曲線 / 回撤 / TWR 的注入測試 —— 合成資料,不需要網路
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 這一輪唯一的新東西是【逐日位置】,所以測試的重心在位置,不在總量。
 *
 * 🔴 而且「B 只驗總量」這件事**做成測試**,不是寫成註解:
 *    把所有交易日期改成同一天 → B(現金累加 == 現在的現金)照樣通過,
 *    而逐日位置全錯。**在正確與錯誤假設下都會通過的檢查,不是檢查。**
 *
 * 用法:npx tsx tests/portfolio-series.mjs
 * ══════════════════════════════════════════════════════════════════════════
 */
import {
  rebuildDaily,
  positionAt,
  buildAxis,
  buildNav,
  drawdownSeries,
  twr,
  externalFlowByDate,
  benchmarkReturn,
  eventsInHolding,
  CARRY_MAX_DAYS,
} from "../src/lib/portfolioSeries.ts";
import { summarizeEquity, EXTERNAL_KINDS } from "../src/lib/equity.ts";
import { computeFifo } from "../src/lib/fifo.ts";
import { buildHoldingRows } from "../src/lib/tradesApp.ts";
import { buildLineChart, buildDrawdownArea } from "../src/lib/seriesChartSvg.ts";

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
const near = (a, b, tol = 1e-9) => a != null && b != null && Math.abs(a - b) <= tol;

/* ══════════════════════════════════════════════════════════════════════
 * 夾具:逐日都可手算,並刻意放進四個邊界
 *   ① 交易日期落在【沒有價格棒的日子】(06-28 週日)→ 必須從那天起算
 *   ② 零股(1000 → 1120)—— 錯位最容易在非整張的地方露出來
 *   ③ 同一天兩筆交易(07-01 賣一檔 + 買一檔)
 *   ④ 一檔被賣光 → 必須從部位裡消失
 * ══════════════════════════════════════════════════════════════════════ */
const T = (id, date, seq, side, ticker, shares, price, fee, tax) => ({
  id, trade_date: date, seq, side, ticker, shares, price, fee, tax,
});
const TRADES = [
  T(1, "2026-06-26", 1, "buy", "1111", 1000, 100, 142, 0),   // cash −100,142
  T(2, "2026-06-28", 2, "buy", "1111", 120, 101, 17, 0),     // 🔴 週日,非軸日 · cash −12,137
  T(3, "2026-06-30", 3, "buy", "2222", 500, 50, 36, 0),      // cash −25,036
  T(4, "2026-07-01", 4, "sell", "1111", 1120, 110, 175, 369),// cash +122,656
  T(5, "2026-07-01", 5, "buy", "3333", 200, 20, 6, 0),       // cash −4,006
];
const FLOWS = [{ flow_date: "2026-06-26", kind: "deposit", amount: 500000 }];

const bars = (rows) => rows.map(([time, close]) => ({ time, close }));
const SERIES = new Map([
  ["1111", bars([["2026-06-26", 100], ["2026-06-29", 101], ["2026-06-30", 102], ["2026-07-01", 110], ["2026-07-02", 111]])],
  ["2222", bars([["2026-06-30", 50], ["2026-07-01", 51], ["2026-07-02", 52]])],
  ["3333", bars([["2026-07-01", 20], ["2026-07-02", 21]])],
]);
const AXIS = ["2026-06-26", "2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02"];

/** 手算的逐日期望值 */
const EXPECT = [
  { date: "2026-06-26", cash: 399858, shares: { 1111: 1000 }, nav: 499858 },
  { date: "2026-06-29", cash: 387721, shares: { 1111: 1120 }, nav: 500841 },
  { date: "2026-06-30", cash: 362685, shares: { 1111: 1120, 2222: 500 }, nav: 501925 },
  { date: "2026-07-01", cash: 481335, shares: { 2222: 500, 3333: 200 }, nav: 510835 },
  { date: "2026-07-02", cash: 481335, shares: { 2222: 500, 3333: 200 }, nav: 511535 },
];

console.log("── 軸 ──");
{
  const a = buildAxis(SERIES, "2026-06-01", "2026-12-31");
  check(JSON.stringify(a) === JSON.stringify(AXIS), "軸 = 各檔價格日期的【聯集】並排序", JSON.stringify(a));
  const clipped = buildAxis(SERIES, "2026-06-30", "2026-07-01");
  check(JSON.stringify(clipped) === JSON.stringify(["2026-06-30", "2026-07-01"]), "軸會被 [from,to] 裁切", JSON.stringify(clipped));
}

console.log("\n── 🔴 逐日位置(這一輪的重點)──");
{
  const days = rebuildDaily(AXIS, TRADES, FLOWS);
  check(days.length === 5, "5 個軸日", String(days.length));
  for (const e of EXPECT) {
    const d = days.find((x) => x.date === e.date);
    check(near(d.cash, e.cash, 1e-9), `${e.date} 現金 = ${e.cash.toLocaleString()}`, String(d?.cash));
    check(
      JSON.stringify(d.shares) === JSON.stringify(e.shares),
      `${e.date} 逐檔股數 = ${JSON.stringify(e.shares)}`,
      JSON.stringify(d?.shares)
    );
  }
  /* ① 非軸日的交易必須從【它自己的日期】起算,不是延到下一個軸日之後 */
  const d0629 = days.find((x) => x.date === "2026-06-29");
  check(d0629.shares["1111"] === 1120, "🔴 06-28(週日、非軸日)的交易在 06-29 已生效 —— 判準是 trade_date <= 軸日", String(d0629.shares["1111"]));
  /* ④ 賣光的檔必須消失,不是留下 0 */
  const d0701 = days.find((x) => x.date === "2026-07-01");
  check(!("1111" in d0701.shares), "🔴 賣光的檔從部位消失(不是留一個 0)", JSON.stringify(d0701.shares));
}

console.log("\n── 🔴 B 是望遠鏡恆等式:做成測試,不寫成註解 ──");
{
  const days = rebuildDaily(AXIS, TRADES, FLOWS);
  /* 注入:把所有交易日期壓到同一天(日期歸屬全錯) */
  const squashed = TRADES.map((t) => ({ ...t, trade_date: "2026-06-26" }));
  const bad = rebuildDaily(AXIS, squashed, FLOWS);

  const lastGood = days[days.length - 1].cash;
  const lastBad = bad[bad.length - 1].cash;
  check(near(lastGood, lastBad, 1e-9), "🔴 B:日期全錯,但【末期現金總額完全一樣】→ B 對位置是盲的", `${lastGood} vs ${lastBad}`);

  const dGood = JSON.stringify(days.find((x) => x.date === "2026-06-29").shares);
  const dBad = JSON.stringify(bad.find((x) => x.date === "2026-06-29").shares);
  check(dGood !== dBad, "🔴 D:同一天的逐檔股數不同 → 位置錯位【只有 D 抓得到】", `${dGood} vs ${dBad}`);
  const cGood = days.find((x) => x.date === "2026-06-29").cash;
  const cBad = bad.find((x) => x.date === "2026-06-29").cash;
  check(!near(cGood, cBad, 1e-9), "🔴 D:同一天的現金也不同(B 看總量看不到這個)", `${cGood} vs ${cBad}`);
}

console.log("\n── D 抽點(positionAt)──");
{
  const days = rebuildDaily(AXIS, TRADES, FLOWS);
  const p = positionAt(days, "2026-06-30");
  check(p.date === "2026-06-30" && near(p.cash, 362685), "抽點命中軸日", JSON.stringify(p));
  const gap = positionAt(days, "2026-07-05"); // 軸上沒有這天
  check(gap.date === "2026-07-02", "🔴 抽點日不在軸上 → 取 <= 該日的最後一個軸日", gap?.date);
  check(positionAt(days, "2026-01-01") === null, "抽點日早於全部軸日 → null(不回第一天)");
}

console.log("\n── 淨值曲線 ──");
{
  const days = rebuildDaily(AXIS, TRADES, FLOWS);
  const r = buildNav(days, SERIES);
  for (const e of EXPECT) {
    const p = r.points.find((x) => x.date === e.date);
    check(near(p.nav, e.nav, 1e-9), `${e.date} 淨值 = ${e.nav.toLocaleString()}`, String(p?.nav));
  }
  check(r.carriedTotal === 0 && r.unknownDays === 0, "對照:資料完整時 0 次填補、0 天未知", JSON.stringify([r.carriedTotal, r.unknownDays]));
  check(r.lastPointUnpriced === false, "對照:末點有價 → lastPointUnpriced false");
}

console.log("\n── 🔴 A:末點改用即時報價 == 頭條淨值 ──");
{
  const days = rebuildDaily(AXIS, TRADES, FLOWS);
  const LIVE = { 2222: 55, 3333: 22 };

  /* 曲線末點,但把該日價格換成即時報價 */
  const liveSeries = new Map(Object.entries(LIVE).map(([tk, p]) => [tk, bars([["2026-07-02", p]])]));
  const navLive = buildNav([days[days.length - 1]], liveSeries).points[0];

  /* 頭條淨值(輪 6 的路徑:computeFifo → buildHoldingRows → summarizeEquity)*/
  const fifo = computeFifo(TRADES);
  const rows = buildHoldingRows(
    fifo.holdings.map((h) => ({ ticker: h.ticker, shares: h.shares, avgCost: h.avgCost, costBasis: h.costBasis })),
    new Map(Object.entries(LIVE).map(([tk, p]) => [tk, { price: p, name: null }]))
  );
  const s = summarizeEquity({
    rows,
    realizedTotal: fifo.realized.reduce((n, x) => n + x.realized, 0),
    cashFlows: FLOWS,
    trades: TRADES,
    oversoldTickers: [],
  });

  check(near(navLive.nav, s.equity, 1e-9), "🔴 A:末點(即時價)== 頭條淨值,精確相等", `${navLive.nav} vs ${s.equity}`);
  check(near(navLive.cash, s.cash, 1e-9), "現金兩條路一致", `${navLive.cash} vs ${s.cash}`);
  check(s.identity.status === "ok" && s.identity.diff === 0, "順帶:輪 6 恆等式仍成立", JSON.stringify(s.identity));
}

console.log("\n── 🔴 末點不得使用填補值 ──");
{
  const days = rebuildDaily(AXIS, TRADES, FLOWS);
  /* 2222/3333 在末日(07-02)沒有棒,但前一日有 → 一般會填補 */
  const gappy = new Map([
    ["1111", SERIES.get("1111")],
    ["2222", bars([["2026-06-30", 50], ["2026-07-01", 51]])],
    ["3333", bars([["2026-07-01", 20]])],
  ]);
  const r = buildNav(days, gappy);
  const last = r.points[r.points.length - 1];
  check(last.nav === null, "🔴 末點缺價 → 淨值 null(不填補、不以 0 代替)", String(last.nav));
  check(r.lastPointUnpriced === true, "lastPointUnpriced = true");
  check(last.missing.sort().join(",") === "2222,3333", "缺價的檔逐檔列名", JSON.stringify(last.missing));
  /* 對照:同一份資料的【中間】日子仍然會填補(證明上一條不是「整條都不填」) */
  const mid = buildNav(days, new Map([["1111", bars([["2026-06-26", 100], ["2026-06-29", 101], ["2026-07-01", 110], ["2026-07-02", 111]])]]), {});
  const d0630 = mid.points.find((p) => p.date === "2026-06-30");
  check(d0630.carried === 1, "🔴 對照:中間日缺價【會】填補並計數(carried=1)", JSON.stringify(d0630));
}

console.log("\n── 填補上限 ──");
{
  check(CARRY_MAX_DAYS === 5, "🔴 填補上限釘死 = 5 個交易日(放寬必須改這個測試)", String(CARRY_MAX_DAYS));
  const axis = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09", "2026-01-12", "2026-01-13"];
  const trades = [T(1, "2026-01-05", 1, "buy", "9999", 100, 10, 0, 0)];
  /* 只有 01-05 有棒 → 之後每一天都是填補,超過 5 個「該檔交易日」就填不動 */
  const s = new Map([["9999", bars([["2026-01-05", 10]])]]);
  const r = buildNav(rebuildDaily(axis, trades, []), s, { carryMax: 2 });
  const navs = r.points.map((p) => (p.nav == null ? "null" : p.nav));
  /* ⚠️ 這個夾具沒有入金,所以現金是 −1,000、淨值 = 1,000 − 1,000 = 0。
     斷言證券市值而不是淨值 —— 我第一版寫成「淨值應為 1000」,
     那是忘了現金那一邊,而測試紅了才發現。期望值算錯與程式算錯要分得清。 */
  check(r.points[0].securities === 1000 && r.points[0].carried === 0, "起始日有價(證券 1,000、非填補)", JSON.stringify(r.points[0]));
  check(r.points.filter((p) => p.nav == null).length > 0, "超過 carryMax 之後判未知(不是無限往前抓)", JSON.stringify(navs));
  check(r.carriedTotal > 0, "填補次數被計數", String(r.carriedTotal));
}

console.log("\n── 回撤 ──");
{
  const pts = [
    { date: "d1", nav: 100, securities: 0, cash: 0, carried: 0, missing: [] },
    { date: "d2", nav: 120, securities: 0, cash: 0, carried: 0, missing: [] },
    { date: "d3", nav: 90, securities: 0, cash: 0, carried: 0, missing: [] },
    { date: "d4", nav: null, securities: null, cash: 0, carried: 0, missing: ["x"] },
    { date: "d5", nav: 132, securities: 0, cash: 0, carried: 0, missing: [] },
  ];
  const { series, maxDrawdown } = drawdownSeries(pts);
  check(near(series[1].dd, 0), "新高當天回撤 0", String(series[1].dd));
  check(near(series[2].dd, -25), "120 → 90 回撤 −25%", String(series[2].dd));
  check(series[3].dd === null, "🔴 缺價那天回撤是 null(不是 0,也不當成新高)", String(series[3].dd));
  check(near(series[4].dd, 0), "d5 創新高 → 回撤回到 0", String(series[4].dd));
  check(near(maxDrawdown, -25), "最大回撤 −25%", String(maxDrawdown));
}

console.log("\n── 🔴 C:TWR ──");
{
  const days = rebuildDaily(AXIS, TRADES, FLOWS);
  const nav = buildNav(days, SERIES);
  const flows = externalFlowByDate(FLOWS);
  const r = twr(nav.points, flows);
  const simple = (511535 / 499858 - 1) * 100;
  check(near(r.pct, simple, 1e-9), `🔴 C:期初一筆入金之後無外部流 → TWR == 末/初 − 1 = ${simple.toFixed(6)}%`, String(r.pct));
  check(r.linkedDays === 4 && r.skippedDays === 0 && r.degenerateDays === 0, "連乘 4 天、0 跳過、0 退化", JSON.stringify(r));

  /* 注入:期中再入金 100,000 → TWR 必須【不等於】單純的末/初(否則分母沒被用到) */
  const withMid = [...FLOWS, { flow_date: "2026-06-30", kind: "deposit", amount: 100000 }];
  const days2 = rebuildDaily(AXIS, TRADES, withMid);
  const nav2 = buildNav(days2, SERIES);
  const r2 = twr(nav2.points, externalFlowByDate(withMid));
  const naive = (nav2.points[4].nav / nav2.points[0].nav - 1) * 100;
  check(!near(r2.pct, naive, 1e-6), "🔴 注入:期中入金 → TWR 必須與「末/初」分開(證明分母真的用到外部資金流)", `${r2.pct} vs ${naive}`);
  check(r2.pct < naive, "入金會拉高「末/初」但不該拉高 TWR", `${r2.pct} vs ${naive}`);

  /* 🔴 股息(內部)不得進分母 —— 否則 TWR 會把股息當成外部注資而扣掉它 */
  const withDiv = [...FLOWS, { flow_date: "2026-06-30", kind: "dividend", amount: 100000 }];
  const days3 = rebuildDaily(AXIS, TRADES, withDiv);
  const nav3 = buildNav(days3, SERIES);
  const r3 = twr(nav3.points, externalFlowByDate(withDiv));
  const r3naive = (nav3.points[4].nav / nav3.points[0].nav - 1) * 100;
  check(near(r3.pct, r3naive, 1e-9), "🔴 股息是【內部】現金流 → 不進分母,TWR = 末/初(它是報酬的一部分)", `${r3.pct} vs ${r3naive}`);
}

console.log("\n── 🔴 TWR 的退化與跳過都要計數 ──");
{
  const pts = [
    { date: "d1", nav: 100, securities: 0, cash: 0, carried: 0, missing: [] },
    { date: "d2", nav: null, securities: null, cash: 0, carried: 0, missing: ["x"] },
    { date: "d3", nav: 110, securities: 0, cash: 0, carried: 0, missing: [] },
  ];
  const r = twr(pts, new Map());
  check(r.skippedDays === 1, "🔴 缺價的日子計入 skippedDays(跨過缺口是假設,不是事實)", String(r.skippedDays));
  check(r.linkedDays === 1, "只連乘得到 1 天", String(r.linkedDays));

  const deg = [
    { date: "d1", nav: 100, securities: 0, cash: 0, carried: 0, missing: [] },
    { date: "d2", nav: 50, securities: 0, cash: 0, carried: 0, missing: [] },
  ];
  const r2 = twr(deg, new Map([["d2", -100]])); // 分母 100 + (−100) = 0
  check(r2.degenerateDays === 1, "🔴 分母 ≤ 0 → 計入 degenerateDays,不當 0 帶過", JSON.stringify(r2));
}

console.log("\n── 🔴 TWR 分母只認 EXTERNAL_KINDS,且不另列一份 ──");
{
  const m = externalFlowByDate([
    { flow_date: "d", kind: "deposit", amount: 100 },
    { flow_date: "d", kind: "withdraw", amount: -30 },
    { flow_date: "d", kind: "dividend", amount: 7 },
    { flow_date: "d", kind: "fee", amount: -2 },
    { flow_date: "d", kind: "other", amount: 1 },
  ]);
  check(m.get("d") === 70, "只有 deposit + withdraw 進分母 = 70", String(m.get("d")));
  /* 🔴 反向:逐一放行 EXTERNAL_KINDS 的每一種,新增外部 kind 時這條自動涵蓋 */
  for (const k of EXTERNAL_KINDS) {
    const one = externalFlowByDate([{ flow_date: "d", kind: k, amount: 5 }]);
    check(one.get("d") === 5, `EXTERNAL_KINDS 的「${k}」確實進分母(由清單導出,不手寫)`, String(one.get("d")));
  }
}

console.log("\n── 對標(同一條軸)──");
{
  const b = bars([["2026-06-26", 200], ["2026-06-29", 202], ["2026-07-02", 210]]);
  check(near(benchmarkReturn(b, AXIS), (210 / 200 - 1) * 100), "對標報酬 = 末/初 − 1", String(benchmarkReturn(b, AXIS)));
  check(benchmarkReturn(b, []) === null, "空軸 → null");
  check(benchmarkReturn([], AXIS) === null, "無對標資料 → null(不當 0)");
  /* 軸不同 → 比的是不同期間,結果必須不同 */
  const shortAxis = ["2026-06-26", "2026-06-29"];
  check(!near(benchmarkReturn(b, shortAxis), benchmarkReturn(b, AXIS)), "🔴 換軸就換期間 → 結果不同(所以必須用同一條軸)");
}

console.log("\n── 除權息事件:持有期間內才標 ──");
{
  const days = rebuildDaily(AXIS, TRADES, FLOWS);
  const evts = [
    { ticker: "1111", date: "2026-06-30", kind: "dividend", detail: "現金股息" },
    { ticker: "1111", date: "2026-07-02", kind: "split", detail: "配股" },   // 07-02 已賣光
    { ticker: "9999", date: "2026-06-30", kind: "dividend", detail: "沒持有" },
  ];
  const hit = eventsInHolding(evts, days);
  check(hit.length === 1 && hit[0].date === "2026-06-30", "🔴 只標【持有期間內】的事件", JSON.stringify(hit));
  check(!hit.some((e) => e.ticker === "9999"), "對照:沒持有的檔不標");
  check(!hit.some((e) => e.date === "2026-07-02"), "對照:已賣光之後的事件不標");
}


console.log("\n── 🔴 圖形幾何:null 必須讓線斷開 ──");
{
  const P = (v, i) => ({ date: `d${i}`, v });
  const mk = (arr) => arr.map((v, i) => P(v, i));

  const full = buildLineChart(mk([100, 110, 105, 120]), { w: 400, h: 100 });
  check(full.paths.length === 1, "全有值 → 一段", String(full.paths.length));
  check(full.gaps === 0, "gaps = 0");

  const broken = buildLineChart(mk([100, 110, null, null, 120, 130]), { w: 400, h: 100 });
  check(broken.paths.length === 2, "🔴 中間兩個 null → 分成兩段(不連過去)", String(broken.paths.length));
  check(broken.gaps === 2, "gaps 計數 = 2", String(broken.gaps));
  check(!broken.paths.join(" ").includes("NaN"), "路徑不含 NaN");

  const single = buildLineChart(mk([null, 100, null, null, 200, null]), { w: 400, h: 100 });
  check(single.paths.length === 2, "🔴 兩個孤立單點 → 兩段(不可消失:消失與 0 無法區分)", JSON.stringify(single.paths));

  const allNull = buildLineChart(mk([null, null, null]), { w: 400, h: 100 });
  check(allNull.paths.length === 0 && allNull.gaps === 3, "全 null → 0 段、gaps 3", JSON.stringify(allNull.paths));

  /* y 映射:最大值必須落在最上緣附近、最小值在最下緣附近(域被 niceStep 撐開) */
  const c = buildLineChart(mk([0, 50, 100]), { w: 100, h: 100, pad: 0 });
  const ys = [...c.paths[0].matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
  check(ys[0] > ys[2], "值越大 y 越小(SVG y 向下)", JSON.stringify(ys));
  check(c.yMin <= 0 && c.yMax >= 100, "y 域涵蓋資料範圍", `${c.yMin}..${c.yMax}`);

  /* 水平線不可除以 0 */
  const flat = buildLineChart(mk([7, 7, 7]), { w: 100, h: 100 });
  check(flat.paths.length === 1 && !flat.paths[0].includes("NaN"), "🔴 完全水平的線不得產生 NaN", flat.paths[0]);

  /* 回撤面積:上界固定 0,面積往下封 */
  const dd = buildDrawdownArea(mk([0, -5, -12, 0]), { w: 100, h: 100, pad: 0 });
  check(dd.yMax === 0, "🔴 回撤圖上界固定為 0(0 = 沒有回落)", String(dd.yMax));
  check(dd.areas.length === 1 && dd.areas[0].endsWith("Z"), "面積封閉", dd.areas[0]?.slice(-30));
  const ddBroken = buildDrawdownArea(mk([0, -5, null, -12]), { w: 100, h: 100 });
  check(ddBroken.areas.length === 2, "🔴 回撤有缺口 → 面積也分成兩塊,不跨過缺口", String(ddBroken.areas.length));
}


/* ══════════════════════════════════════════════════════════════════════
 * 十五、🔴 除權息偵測:必須用合成資料證明它會響
 *
 * 使用者的真實資料上這個偵測器會標【0 筆】—— 持有期內 Yahoo 回報 5 次除息
 * + 1 次分割,但全部落在他的持有期【之外】(最近的差一天)。
 *
 * 🔴 一個永遠回 0 的檢查,分不出是「真的沒有事件」還是「根本沒在跑」——
 *    那與 `攻擊 0 + 對照 0` 是同一件事。所以必須有合成的正向案例。
 *
 * 事件日期用【真實的】(那些是公開事實),部位是合成的。
 *
 * 🔴 判準的邊界:台股是「除息(權)日**前一交易日**收盤時持有」才領得到。
 *    所以判準是「事件日【前一個軸日】是否持有」,不是「事件日當天」。
 *    用「當天」會在兩個方向同時出錯,而且兩種錯都看起來完全正常:
 *      · 在除息日當天買進 → 領不到、無失真,卻被誤標
 *      · 前一日持有、當天賣出 → 領得到、有失真,卻被漏標
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n── 🔴 除權息偵測:邊界只差一天 ──");
{
  /** 2026-06-26 → 2026-08-24 的平日(市場假日不影響本組測試用到的日期) */
  const weekdays = (() => {
    const out = [];
    for (let t = Date.UTC(2026, 5, 26); t <= Date.UTC(2026, 7, 24); t += 86400000) {
      const d = new Date(t);
      const w = d.getUTCDay();
      if (w !== 0 && w !== 6) out.push(d.toISOString().split("T")[0]);
    }
    return out;
  })();
  check(weekdays.includes("2026-07-01") && weekdays.includes("2026-07-02") && weekdays.includes("2026-07-03"),
    "夾具軸涵蓋 07-01 / 07-02 / 07-03(邊界日)", weekdays.length + " 天");

  /** 真實事件(公開事實) */
  const EX_3006 = { ticker: "3006", date: "2026-07-02", kind: "dividend", detail: "現金股息 1.0" };
  const EX_2449 = { ticker: "2449", date: "2026-07-28", kind: "split", detail: "分割 1050:1000" };

  const buy = (tk, date) => [T(1, date, 1, "buy", tk, 1000, 100, 142, 0)];
  const flagged = (evts, trades) =>
    eventsInHolding(evts, rebuildDaily(weekdays, trades, [])).map((e) => `${e.ticker}@${e.date}`);

  /* ① 正向:除息日【之前】買進 → 必須標 */
  check(
    flagged([EX_3006], buy("3006", "2026-06-30")).join() === "3006@2026-07-02",
    "🔴 正向:06-30 買 3006 → 07-02 除息落在持有期內【必須標】",
    JSON.stringify(flagged([EX_3006], buy("3006", "2026-06-30")))
  );

  /* ② 對照(他的實際):除息日【之後】買進 → 必須不標 */
  check(
    flagged([EX_3006], buy("3006", "2026-07-03")).length === 0,
    "🔴 對照:07-03 買 3006(他的實際首買)→ 差一天,【不標】",
    JSON.stringify(flagged([EX_3006], buy("3006", "2026-07-03")))
  );

  /* ③ 🔴 邊界:在除息日【當天】買進 → 領不到、價格已調整 → 不標
        (用「當天是否持有」的舊判準會誤標) */
  check(
    flagged([EX_3006], buy("3006", "2026-07-02")).length === 0,
    "🔴 邊界:在除息日【當天】買進 → 不標(領不到,無失真)",
    JSON.stringify(flagged([EX_3006], buy("3006", "2026-07-02")))
  );

  /* ④ 🔴 邊界:前一日持有、除息日【當天】賣出 → 領得到、有失真 → 必須標
        (用「當天是否持有」的舊判準會漏標) */
  const heldThenSold = [
    T(1, "2026-06-30", 1, "buy", "3006", 1000, 100, 142, 0),
    T(2, "2026-07-02", 2, "sell", "3006", 1000, 100, 142, 300),
  ];
  check(
    flagged([EX_3006], heldThenSold).join() === "3006@2026-07-02",
    "🔴 邊界:前一日持有、除息日當天賣出 → 【必須標】(領得到,賣在調整後價)",
    JSON.stringify(flagged([EX_3006], heldThenSold))
  );

  /* ⑤ 配股(真實的 1050:1000)*/
  check(
    flagged([EX_2449], buy("2449", "2026-07-20")).join() === "2449@2026-07-28",
    "🔴 配股:07-20 買 2449 → 07-28 分割 1050:1000【必須標】(股數變動沒有紀錄)",
    JSON.stringify(flagged([EX_2449], buy("2449", "2026-07-20")))
  );
  check(
    flagged([EX_2449], buy("2449", "2026-08-14")).length === 0,
    "🔴 對照:08-14 買 2449(他的實際首買)→【不標】",
    JSON.stringify(flagged([EX_2449], buy("2449", "2026-08-14")))
  );

  /* ⑥ 他的五筆真實情形一次驗完:全部必須【不標】——
        這一組是「0 筆」的對照,證明那個 0 是算出來的,不是沒跑 */
  const REAL = [
    ["3006", "2026-07-02", "2026-07-03"],
    ["2303", "2026-07-08", "2026-06-26"], // 06-26 買、06-30 賣光
    ["2645", "2026-07-13", "2026-08-10"],
    ["2027", "2026-07-14", "2026-08-14"],
    ["2449", "2026-07-28", "2026-08-14"],
  ];
  let realFlagged = 0;
  for (const [tk, ex, firstBuy] of REAL) {
    const trades =
      tk === "2303"
        ? [T(1, firstBuy, 1, "buy", tk, 1000, 100, 142, 0), T(2, "2026-06-30", 2, "sell", tk, 1000, 100, 142, 300)]
        : buy(tk, firstBuy);
    if (flagged([{ ticker: tk, date: ex, kind: "dividend", detail: "x" }], trades).length) realFlagged++;
  }
  check(realFlagged === 0, "🔴 他的五筆真實情形全部【不標】—— 那個 0 是算出來的", String(realFlagged));

  /* ⑦ 範圍外的事件不標(軸之前 / 軸之後)*/
  check(
    flagged([{ ticker: "3006", date: "2026-01-05", kind: "dividend", detail: "x" }], buy("3006", "2026-06-30")).length === 0,
    "軸之前的事件不標"
  );
  check(
    flagged([{ ticker: "3006", date: "2026-12-01", kind: "dividend", detail: "x" }], buy("3006", "2026-06-30")).length === 0,
    "軸之後的事件不標(那個失真還沒出現在這條曲線上)"
  );
}

/* ══════════════════════════════════════════════════════════════════════ */
const N_EXPECT = EXPECT.length;
const PLAN =
  2 +                                 /* 軸 */
  (1 + N_EXPECT * 2 + 2) +            /* 逐日位置 */
  3 +                                 /* B 望遠鏡 */
  3 +                                 /* D 抽點 */
  (N_EXPECT + 2) +                    /* 淨值曲線 */
  3 +                                 /* A */
  4 +                                 /* 末點不填補 */
  4 +                                 /* 填補上限 */
  5 +                                 /* 回撤 */
  5 +                                 /* TWR C */
  3 +                                 /* TWR 退化/跳過 */
  (1 + EXTERNAL_KINDS.length) +       /* 分母只認 EXTERNAL_KINDS */
  4 +                                 /* 對標 */
  3 +                                 /* 除權息事件 */
  13 +                                /* 圖形幾何 */
  10;                                 /* 除權息邊界 */
console.log(`\n通過 ${pass} 項;失敗 ${fails.length} 項(plan ${PLAN})`);
if (pass + fails.length !== PLAN) {
  console.error(`❌ plan 對不上:宣告 ${PLAN} 項,實跑 ${pass + fails.length} 項`);
  process.exit(1);
}
if (fails.length) {
  for (const f of fails) console.error("  ❌ " + f);
  process.exit(1);
}
console.log("✅ 逐日位置逐格對上;B 的盲區已做成測試;TWR 分母只認 EXTERNAL_KINDS");
