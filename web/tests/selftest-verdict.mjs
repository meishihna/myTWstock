#!/usr/bin/env node
/**
 * 隔離自測【判準】的注入測試 —— 不需要資料庫
 *
 * 🔴 這一層存在的理由:判準寫在頁面 script 裡時,只能靠「跑一次真實情境」驗證,
 *    而真實情境不保證涵蓋所有組合。**線上首跑就沒有涵蓋到「攻擊 0 + 對照 0」**,
 *    於是那個洞活了下來,還印出 ✅。抽成純函式後,每種組合都能逐一注入。
 *
 * 用法:npx tsx tests/selftest-verdict.mjs
 */
import { judgeProbe, summarize } from "../src/lib/selftestVerdict.ts";

let pass = 0;
const fails = [];
const check = (ok, name, detail = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}  ${detail}`); }
};

console.log("── 逐項判定 ──");
{
  const cases = [
    { n: "攻擊 0 + 對照 3 → 通過", i: { name: "t", attackRows: 0, controlRows: 3 }, want: "pass" },
    { n: "🔴 攻擊 0 + 對照 0 → 無法判定(不是通過)", i: { name: "t", attackRows: 0, controlRows: 0 }, want: "unknown" },
    { n: "攻擊 1 + 對照 3 → 失敗(讀到別人的資料)", i: { name: "t", attackRows: 1, controlRows: 3 }, want: "fail" },
    { n: "攻擊 1 + 對照 0 → 失敗(讀到別人的仍是失敗)", i: { name: "t", attackRows: 1, controlRows: 0 }, want: "fail" },
    { n: "攻擊查詢出錯 → 無法判定(量不到 ≠ 沒問題)", i: { name: "t", attackRows: null, controlRows: 3 }, want: "unknown" },
    { n: "對照查詢出錯 → 無法判定", i: { name: "t", attackRows: 0, controlRows: null }, want: "unknown" },
  ];
  for (const c of cases) {
    const got = judgeProbe(c.i);
    check(got === c.want, c.n, `得 ${got} 期望 ${c.want}`);
  }
}

console.log("\n── 整體結論 ──");
{
  const all = [
    { name: "a", attackRows: 0, controlRows: 1 },
    { name: "b", attackRows: 0, controlRows: 2 },
  ];
  const s = summarize(all);
  check(s.verdict === "pass" && s.passed === 2 && s.unknown.length === 0, "全部逐項通過 → pass", JSON.stringify(s));
}
{
  // 🔴 這正是線上首跑的形狀:多數通過,少數攻擊 0 + 對照 0。舊判準會印 ✅
  const mixed = [
    { name: "trades", attackRows: 0, controlRows: 3 },
    { name: "profiles", attackRows: 0, controlRows: 1 },
    { name: "cash_flows", attackRows: 0, controlRows: 0, need: "A 需要至少一筆現金流" },
    { name: "watchlist", attackRows: 0, controlRows: 0, need: "A 需要至少一檔觀察清單" },
    { name: "preferences", attackRows: 0, controlRows: 0, need: "A 需要一組偏好設定" },
  ];
  const s = summarize(mixed);
  check(s.verdict === "partial", "線上首跑的形狀(2 通過 + 3 對照皆 0)→ partial,【不是】pass", s.verdict);
  check(s.passed === 2, "通過數 = 2", String(s.passed));
  check(s.unknown.length === 3 && s.unknown.includes("cash_flows"), "無法判定逐條列名", JSON.stringify(s.unknown));
}
{
  const withFail = [
    { name: "trades", attackRows: 0, controlRows: 3 },
    { name: "v_holdings", attackRows: 2, controlRows: 1 },
    { name: "watchlist", attackRows: 0, controlRows: 0 },
  ];
  const s = summarize(withFail);
  check(s.verdict === "fail", "有任一失敗 → fail(即使同時有無法判定)", s.verdict);
  check(s.failed.length === 1 && s.failed[0] === "v_holdings", "失敗項目被指名", JSON.stringify(s.failed));
}
{
  // 舊判準的反例:若沿用「至少一項對照讀得到就通過」,下面這組會被判 pass
  const s = summarize([
    { name: "trades", attackRows: 0, controlRows: 3 },
    { name: "cash_flows", attackRows: 0, controlRows: 0 },
  ]);
  check(s.verdict !== "pass", "🔴 舊判準會誤判為通過的那一組,新判準不得為 pass", s.verdict);
}

console.log(`\n通過 ${pass} 項;失敗 ${fails.length} 項`);
if (fails.length) { for (const f of fails) console.error("  ❌ " + f); process.exit(1); }
console.log("✅ 判準本身正確:攻擊 0 + 對照 0 一律判無法判定,絕不宣告通過");
