#!/usr/bin/env node
/**
 * FIFO 雙實作交叉比對 —— SQL view(區間重疊)vs TS(逐筆佇列消耗)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 兩邊【刻意用不同演算法】,所以這支比對才有意義:
 *   共用程式碼會一起錯;**共用思路也會**。不同思路才是真的交叉檢查。
 *
 * 🔴 比對本身必須被證明會咬(`--self-test`):
 *    注入一個「TS 結果被改動一格」的情境,比對必須紅燈。
 *    沒有這個,「兩邊一致」只證明比對程式沒有報錯。
 *
 * 🔴 只跑本機(會建立與刪除測試使用者)。
 *
 * 用法:
 *   npx tsx tests/fifo-cross-check.mjs             # 比對
 *   npx tsx tests/fifo-cross-check.mjs --self-test # 注入驗證(證明比對會咬)
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { computeFifo } from "../src/lib/fifo.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cfg = JSON.parse(
  execSync("npx --yes supabase@latest status -o json", { encoding: "utf8", maxBuffer: 1 << 24, cwd: REPO })
);
const url = cfg.API_URL;
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) {
  console.error(`❌ 拒絕執行:URL 不是本機(${url})`);
  process.exit(2);
}
const admin = createClient(url, cfg.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const asUser = (t) =>
  createClient(url, cfg.ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${t}` } },
  });

async function makeUser(email) {
  const { data: c, error: e1 } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (e1) throw new Error(e1.message);
  const { data: l, error: e2 } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (e2) throw new Error(e2.message);
  const sb = createClient(url, cfg.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: s, error: e3 } = await sb.auth.verifyOtp({ type: "email", token_hash: l.properties.hashed_token });
  if (e3) throw new Error(e3.message);
  return { id: c.user.id, token: s.session.access_token };
}

/** 多檔、多筆、含賣超與零股 —— 單一情境比不出「某些形狀才會分歧」的錯 */
function fixture(uid) {
  const mk = (ticker, date, seq, side, shares, price, fee, tax = 0) => ({
    user_id: uid, ticker, trade_date: date, seq, side, shares, price, fee, tax,
  });
  return [
    // 監督者驗算過的那組
    mk("2330", "2024-01-02", 1, "buy", 1000, 100, 142.5),
    mk("2330", "2024-02-02", 1, "buy", 1000, 110, 156.75),
    mk("2330", "2024-03-02", 1, "sell", 1500, 120, 256.5, 540),
    // 同日多筆 → seq 決定順序
    mk("2317", "2024-05-01", 1, "buy", 100, 10, 0),
    mk("2317", "2024-05-01", 2, "buy", 100, 20, 0),
    mk("2317", "2024-05-02", 1, "sell", 100, 30, 0, 0),
    // 零股
    mk("0050", "2024-06-01", 1, "buy", 0.5, 100, 0),
    mk("0050", "2024-06-02", 1, "sell", 0.2, 150, 0, 0),
    // 賣超
    mk("2454", "2024-07-01", 1, "buy", 100, 500, 71.25),
    mk("2454", "2024-07-05", 1, "sell", 150, 600, 128.25, 270),
    // 多段配對 + 尚有剩餘
    mk("2603", "2024-08-01", 1, "buy", 300, 40, 17.1),
    mk("2603", "2024-08-02", 1, "buy", 300, 45, 19.24),
    mk("2603", "2024-08-03", 1, "sell", 100, 50, 7.13, 15),
    mk("2603", "2024-08-04", 1, "sell", 350, 55, 27.44, 57.75),
  ];
}

const SELF_TEST = process.argv.includes("--self-test");
const TOL = 1e-6;
let pass = 0;
const fails = [];
const check = (ok, name, detail = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${detail ? " —— " + detail : ""}`); console.log(`  ✗ ${name}  ${detail}`); }
};

const U = await makeUser(`fifo-${Date.now()}@example.test`);
const cli = asUser(U.token);
const rows = fixture(U.id);
const ins = await cli.from("trades").insert(rows);
if (ins.error) throw new Error(`種資料失敗:${ins.error.message}`);

// TS 側:直接讀回原始 trades,自己算
const { data: raw, error: rawErr } = await cli.from("trades").select("*").order("trade_date").order("seq").order("id");
if (rawErr) throw new Error(rawErr.message);
const ts = computeFifo(
  raw.map((r) => ({
    id: r.id, ticker: r.ticker, trade_date: r.trade_date, seq: r.seq,
    side: r.side, shares: Number(r.shares), price: Number(r.price),
    fee: Number(r.fee), tax: Number(r.tax),
  }))
);

// 🔴 注入:把 TS 的一格改掉,比對必須紅燈
if (SELF_TEST && ts.holdings.length) {
  ts.holdings[0].avgCost += 0.001;
  console.log(`(自我驗證:已把 TS 的 ${ts.holdings[0].ticker} 均價 +0.001,比對必須抓到)\n`);
}

// SQL 側:讀 view
const { data: sqlHold, error: e1 } = await cli.from("v_holdings").select("*").order("ticker");
const { data: sqlReal, error: e2 } = await cli.from("v_realized_lots").select("*");
const { data: sqlAnom, error: e3 } = await cli.from("v_position_anomalies").select("*").order("ticker");
if (e1 || e2 || e3) throw new Error((e1 || e2 || e3).message);

console.log("── 持倉:逐檔比對 shares / avgCost ──");
const tsH = new Map(ts.holdings.map((h) => [h.ticker, h]));
const sqlH = new Map(sqlHold.map((h) => [h.ticker, h]));
check(tsH.size === sqlH.size, `持倉檔數一致(TS ${tsH.size} / SQL ${sqlH.size})`);
for (const tk of new Set([...tsH.keys(), ...sqlH.keys()])) {
  const t = tsH.get(tk), s = sqlH.get(tk);
  if (!t || !s) { check(false, `${tk} 兩邊都有`, `TS ${t ? "有" : "無"} / SQL ${s ? "有" : "無"}`); continue; }
  check(Math.abs(t.shares - Number(s.shares)) < TOL, `${tk} 股數`, `TS ${t.shares} / SQL ${s.shares}`);
  check(Math.abs(t.avgCost - Number(s.avg_cost)) < TOL, `${tk} 均價`, `TS ${t.avgCost} / SQL ${s.avg_cost}`);
}

console.log("\n── 已實現:逐檔合計 + 配對段數 ──");
const sum = (arr, k) => arr.reduce((n, x) => n + Number(x[k]), 0);
const byTk = (arr, k, tkKey = "ticker") => {
  const m = new Map();
  for (const x of arr) m.set(x[tkKey], (m.get(x[tkKey]) ?? 0) + Number(x[k]));
  return m;
};
const tsR = byTk(ts.realized, "realized");
const sqlR = byTk(sqlReal, "realized_pnl");
check(ts.realized.length === sqlReal.length, `配對段數一致(TS ${ts.realized.length} / SQL ${sqlReal.length})`);
for (const tk of new Set([...tsR.keys(), ...sqlR.keys()])) {
  const a = tsR.get(tk) ?? 0, b = sqlR.get(tk) ?? 0;
  check(Math.abs(a - b) < TOL, `${tk} 已實現合計`, `TS ${a} / SQL ${b}`);
}
check(Math.abs(sum(ts.realized, "realized") - sum(sqlReal, "realized_pnl")) < TOL, "已實現總計一致");

console.log("\n── 賣超 ──");
const tsA = new Map(ts.anomalies.map((a) => [a.ticker, a.oversoldShares]));
const sqlA = new Map(sqlAnom.map((a) => [a.ticker, Number(a.oversold_shares)]));
check(tsA.size === sqlA.size, `賣超檔數一致(TS ${tsA.size} / SQL ${sqlA.size})`);
for (const tk of new Set([...tsA.keys(), ...sqlA.keys()])) {
  check(Math.abs((tsA.get(tk) ?? 0) - (sqlA.get(tk) ?? 0)) < TOL, `${tk} 賣超股數`, `TS ${tsA.get(tk)} / SQL ${sqlA.get(tk)}`);
}

await admin.auth.admin.deleteUser(U.id).catch(() => {});

console.log(`\n通過 ${pass} 項;不一致 ${fails.length} 項`);
if (SELF_TEST) {
  if (fails.length > 0) { console.log("✅ 自我驗證通過:注入一格差異後,比對確實紅燈"); process.exit(0); }
  console.error("❌ 自我驗證失敗:注入了差異,比對卻全綠 —— 這個比對是裝飾品");
  process.exit(1);
}
if (fails.length) { for (const f of fails) console.error("  ❌ " + f); process.exit(1); }
console.log("✅ 兩份【不同演算法】的 FIFO 實作結果一致");
