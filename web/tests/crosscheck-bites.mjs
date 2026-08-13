#!/usr/bin/env node
/**
 * 證明【瀏覽器端】的雙實作比對會咬 —— 直接測產品函式 `crossCheck()`
 *
 * 🔴 `tests/fifo-cross-check.mjs` 的自我驗證測的是【那支腳本自己的】比對程式碼,
 *    不是頁面實際用的 `crossCheck()`。兩者是不同的程式碼路徑,
 *    證明一個會咬推論不到另一個 —— 所以這支存在。
 *
 * 用假的 supabase client 餵入【刻意算錯的 view 結果】,比對必須:
 *   ① 判定 diff 並指名代號   ② view 查詢失敗時判 error 並累加計數(不可靜默)
 *
 * 用法:npx tsx tests/crosscheck-bites.mjs
 */
import { crossCheck, newCompareState } from "../src/lib/tradesApp.ts";

let pass = 0;
const fails = [];
const check = (ok, name, detail = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}  ${detail}`); }
};

/** 手算向量那組:剩 500 股、均價 110.15675、已實現 23982.625 */
const TRADES = [
  { id: 1, ticker: "2330", trade_date: "2024-01-02", seq: 1, side: "buy", shares: 1000, price: 100, fee: 142.5, tax: 0 },
  { id: 2, ticker: "2330", trade_date: "2024-02-02", seq: 1, side: "buy", shares: 1000, price: 110, fee: 156.75, tax: 0 },
  { id: 3, ticker: "2330", trade_date: "2024-03-02", seq: 1, side: "sell", shares: 1500, price: 120, fee: 256.5, tax: 540 },
];

/** 假 client:只回傳指定的 view 結果 */
const stub = (holdings, realized, err = null) => ({
  from(table) {
    return {
      select() {
        if (err) return Promise.resolve({ data: null, error: { message: err } });
        return Promise.resolve({
          data: table === "v_holdings" ? holdings : realized,
          error: null,
        });
      },
    };
  },
});

console.log("── 對照組:view 與 TS 一致 → 必須判 ok ──");
{
  const st = await crossCheck(
    stub([{ ticker: "2330", shares: 500, avg_cost: 110.15675 }], [{ ticker: "2330", realized_pnl: 23982.625 }]),
    TRADES,
    newCompareState()
  );
  check(st.status === "ok", "一致時判 ok", `實際 ${st.status}`);
  check(st.pending.size === 0, "無待核代號", `${[...st.pending]}`);
}

console.log("\n── 注入①:view 的均價差 0.001 → 必須判 diff 並指名 ──");
{
  const st = await crossCheck(
    stub([{ ticker: "2330", shares: 500, avg_cost: 110.15775 }], [{ ticker: "2330", realized_pnl: 23982.625 }]),
    TRADES,
    newCompareState()
  );
  check(st.status === "diff", "判 diff", `實際 ${st.status}`);
  check(st.pending.has("2330"), "指名 2330", `${[...st.pending]}`);
}

console.log("\n── 注入②:view 的股數不同 → 必須判 diff ──");
{
  const st = await crossCheck(
    stub([{ ticker: "2330", shares: 400, avg_cost: 110.15675 }], [{ ticker: "2330", realized_pnl: 23982.625 }]),
    TRADES,
    newCompareState()
  );
  check(st.status === "diff" && st.pending.has("2330"), "股數不同被抓到", `${st.status} ${[...st.pending]}`);
}

console.log("\n── 注入③:view 的已實現不同 → 必須判 diff ──");
{
  const st = await crossCheck(
    stub([{ ticker: "2330", shares: 500, avg_cost: 110.15675 }], [{ ticker: "2330", realized_pnl: 23982.0 }]),
    TRADES,
    newCompareState()
  );
  check(st.status === "diff" && st.pending.has("2330"), "已實現不同被抓到", `${st.status} ${[...st.pending]}`);
}

console.log("\n── 注入④:view 少了一檔(TS 有、SQL 沒有)→ 必須判 diff ──");
{
  const st = await crossCheck(stub([], [{ ticker: "2330", realized_pnl: 23982.625 }]), TRADES, newCompareState());
  check(st.status === "diff" && st.pending.has("2330"), "缺檔被抓到", `${st.status} ${[...st.pending]}`);
}

console.log("\n── 注入⑤:view 查詢失敗 → 判 error 且【計數】,不可靜默 ──");
{
  const st0 = newCompareState();
  const st = await crossCheck(stub(null, null, "boom"), TRADES, st0);
  check(st.status === "error", "判 error", `實際 ${st.status}`);
  check(st.errorCount === 1, "錯誤計數 = 1", `實際 ${st.errorCount}`);
  check(st.lastError === "boom", "保留錯誤訊息", `實際 ${st.lastError}`);
  const st2 = await crossCheck(stub(null, null, "boom again"), TRADES, st);
  check(st2.errorCount === 2, "再次失敗 → 計數累加為 2", `實際 ${st2.errorCount}`);
}

console.log(`\n通過 ${pass} 項;失敗 ${fails.length} 項`);
if (fails.length) { for (const f of fails) console.error("  ❌ " + f); process.exit(1); }
console.log("✅ 頁面用的 crossCheck() 會咬:不一致必判 diff 並指名,查詢失敗必判 error 並計數");
