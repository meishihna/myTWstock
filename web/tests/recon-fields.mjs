#!/usr/bin/env node
/**
 * 對帳欄位定義的注入測試 —— 不需要資料庫
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 這一層為什麼存在:輪 5 發生過三次「轉述比程式碼窄」,
 *    最後一次是對帳結論句寫「股數與平均成本」而程式已在比三欄。
 *    前兩次的處置是**加註解** —— 但註解只攔得住讀到它的人
 *    (`verify_online.sql` 第 ⑥ 條旁邊早就寫著「名字白名單會祝福掉錯的東西」,
 *     下一個加斷言的人還是寫成名字白名單)。
 *
 *    **能寫成會響的檢查,就不要只寫成註解。**
 *
 * 🔴 本檔的測試全部【由 RECON_FIELDS 導出】,不逐欄手寫。
 *    所以日後新增比對欄位時,下面每一條都會自動涵蓋它 ——
 *    一份手寫清單的測試,會在別人加第四欄時靜靜地漏掉它。
 *
 * 用法:npx tsx tests/recon-fields.mjs
 * ══════════════════════════════════════════════════════════════════════════
 */
import { RECON_FIELDS, reconFieldSummary, judgeReconRow } from "../src/lib/importApp.ts";

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

/** 一組基準值,三欄之間刻意【不自洽】無所謂 —— 這裡測的是比對機制,不是 FIFO */
const BASE = { shares: 850, avgCost: 265.022, costBasis: 225268.67 };
const side = (over = {}) => ({ ...BASE, ...over });

console.log("── 空清單守衛 ──");
check(RECON_FIELDS.length > 0, "🔴 RECON_FIELDS 非空(空清單會讓 every() 恆真 → 零檢查卻宣告吻合)", String(RECON_FIELDS.length));

/* ══════════════════════════════════════════════════════════════════════
 * 🔴 容差釘在這裡 —— 否則下面的注入測試是【自我指涉】的
 *
 * 下面「注入超出容差」用的注入量是 `f.tol * 10`,也就是**從容差推出來的**。
 * 所以若有人把某欄的 `tol` 改成 `1e9`,注入量會跟著變成 `1e10`,
 * 測試照樣全綠 —— 而那一欄實際上**不再檢查任何東西**。
 * 「參數把檢查變空,測試卻仍綠」是比「檢查寫錯」更難發現的一種失效。
 *
 * 解法:把每一欄的容差**釘成常數**。之後放寬容差就必須同時改這裡 ——
 * 從**靜默漂移**變成**刻意行為**(與凍結全量 md5 指紋是同一個手法)。
 *
 * ⚠️ 兩個方向都要檢查:
 *   ① 每一欄都必須在這張表裡 → 新增欄位時會被迫替它訂一個容差
 *   ② 這張表不得有多出來的鍵 → 欄位被移除時這裡不會留下無人看管的期望值
 * ══════════════════════════════════════════════════════════════════════ */
const PINNED_TOL = {
  /* 股數是整數或零股小數,兩邊不該有任何實質差異 —— 這個容差只吸浮點噪音 */
  shares: 1e-6,
  /* 均價是除法結果,容差比股數鬆一級 */
  avgCost: 0.005,
  /* 成本合計是加總,容差再鬆一級(仍遠小於 1 分錢的實際意義) */
  costBasis: 0.01,
};

console.log("\n── 🔴 容差釘死(否則注入測試是自我指涉的)──");
{
  const fieldKeys = RECON_FIELDS.map((f) => f.key).sort();
  const pinnedKeys = Object.keys(PINNED_TOL).sort();
  check(
    JSON.stringify(fieldKeys) === JSON.stringify(pinnedKeys),
    "🔴 每一欄都有釘死的容差,且沒有多餘的期望值(雙向)",
    `欄位 ${JSON.stringify(fieldKeys)} vs 釘死 ${JSON.stringify(pinnedKeys)}`
  );
  for (const f of RECON_FIELDS) {
    check(
      f.tol === PINNED_TOL[f.key] && Number.isFinite(f.tol) && f.tol > 0,
      `「${f.label}」的容差 = ${PINNED_TOL[f.key]}(放寬它必須同時改這個測試)`,
      `實際 ${f.tol}`
    );
  }
}

console.log("\n── 對照組:兩邊相同必須全數吻合 ──");
{
  const r = judgeReconRow("2330", side(), side());
  check(r.ok === true, "相同 → 吻合", JSON.stringify(r));
  check(r.cells.length === RECON_FIELDS.length, `逐欄都出現一格(${RECON_FIELDS.length} 格)`, String(r.cells.length));
  check(r.cells.every((c) => c.ok && c.delta === 0), "每一格 ok 且差額 0", JSON.stringify(r.cells));
}

console.log("\n── 🔴 逐欄注入:每一欄都必須【真的參與判定】 ──");
for (const f of RECON_FIELDS) {
  /* 超出容差一個數量級 → 該欄必須紅,而且【只有該欄】紅 */
  const r = judgeReconRow("2330", side(), side({ [f.key]: BASE[f.key] + f.tol * 10 }));
  const bad = r.cells.filter((c) => !c.ok).map((c) => c.label);
  check(
    r.ok === false && bad.length === 1 && bad[0] === f.label,
    `注入「${f.label}」偏 ${f.tol * 10} → 整列不吻合,且只有「${f.label}」那一格紅`,
    JSON.stringify(bad)
  );
  const cell = r.cells.find((c) => c.label === f.label);
  check(
    Math.abs(cell.delta + f.tol * 10) < f.tol * 1e-6,
    `「${f.label}」的差額是原值(不是四捨五入後的顯示值)`,
    String(cell.delta)
  );
}

console.log("\n── 容差確實生效(否則上面的注入可能只是「任何差異都紅」)──");
for (const f of RECON_FIELDS) {
  const r = judgeReconRow("2330", side(), side({ [f.key]: BASE[f.key] + f.tol * 0.5 }));
  check(r.ok === true, `對照:「${f.label}」偏 ${f.tol * 0.5}(容差內)→ 仍吻合`, JSON.stringify(r.cells.filter((c) => !c.ok)));
}

console.log("\n── 缺一邊 ──");
{
  const onlyExp = judgeReconRow("2330", side(), null);
  check(onlyExp.ok === false, "資料庫沒有這一檔 → 不吻合", JSON.stringify(onlyExp));
  check(onlyExp.cells.every((c) => c.delta === null && c.got === null), "缺的那一邊為 null、差額為 null(不是 0)", JSON.stringify(onlyExp.cells));

  const onlyGot = judgeReconRow("2330", null, side());
  check(onlyGot.ok === false, "預測沒有這一檔 → 不吻合", JSON.stringify(onlyGot));

  const neither = judgeReconRow("2330", null, null);
  check(neither.ok === true, "兩邊都沒有 → 視為一致(null == null;這一檔根本不該出現在清單裡)", JSON.stringify(neither));
}

console.log("\n── 🔴 結論句由欄位定義導出,不是另寫的字串 ──");
{
  const s = reconFieldSummary();
  console.log(`     實際輸出:「${s}」`);
  for (const f of RECON_FIELDS) {
    check(s.includes(f.label), `結論句包含「${f.label}」—— 描述不得比實際比對的欄位窄`, s);
  }
  check(s.includes(String(RECON_FIELDS.length)), `結論句包含欄位數 ${RECON_FIELDS.length}`, s);
}

/* plan 由欄位數導出 —— 加一欄時期望值自動跟上,不會變成「有測試沒跑到」 */
const N = RECON_FIELDS.length;
const PLAN = 1 + (1 + N) + 3 + N * 2 + N + 4 + N + 1;
console.log(`\n通過 ${pass} 項;失敗 ${fails.length} 項(plan ${PLAN},由 ${N} 欄導出)`);
if (pass + fails.length !== PLAN) {
  console.error(`❌ plan 對不上:宣告 ${PLAN} 項,實跑 ${pass + fails.length} 項`);
  process.exit(1);
}
if (fails.length) {
  for (const f of fails) console.error("  ❌ " + f);
  process.exit(1);
}
console.log("✅ 每一個比對欄位都真的參與判定,且結論句的措辭由同一份定義導出 —— 描述漂不了");
