#!/usr/bin/env node
/**
 * 115 ingest 收貨檢查 ——【只增不改】
 *
 * 這輪交付的唯一合法形狀:**新增 115 期別,既有期別一格都不動。**
 * 所以判準不是「新資料看起來對不對」,而是可否證偽的三件事:
 *   ① 既有期別的每一格,逐位元相同(null 也要對得上 null)
 *   ② 既有期別不得消失
 *   ③ 欄位順序不得改變(順序一變,所有既有列的索引全體位移 ——
 *      值看起來還在,意義卻換了一欄,而且不會有任何錯誤訊息)
 * 任何一項不成立就是【改到了舊資料】,不是「更新」。
 *
 * 🔴 基準來自【git 已提交的版本】,不是我另外存的快照 ——
 *    自己存的快照可以被自己覆寫,git 物件不行。預設基準 = 最後一次改動
 *    web/public/data/financials 的 commit,可用 --base <ref> 覆寫。
 *
 * 🔴 本檔在交付到貨【之前】凍結。到貨後若需要改判準,必須先說明為什麼
 *    「原本的判準錯了」,而不是「這樣交付才會過」。
 *
 * 用法
 *   node tests/check-115-additive.mjs --self-test   # 注入驗證(不碰交付)
 *   node tests/check-115-additive.mjs               # 對工作區的交付跑
 *   node tests/check-115-additive.mjs --base <ref>
 *
 * 退出碼:0 = 只增不改成立,1 = 有既有格被改動/消失/欄位位移
 */
import fs from "node:fs";

import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const REL = "web/public/data/financials";
const LIVE_DIR = path.join(REPO, REL);

const argv = process.argv.slice(2);
const argOf = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const git = (args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });

/** 期別 → 該列各欄值(以欄位名為鍵,避免用索引比較而被欄位位移騙過) */
function rowsByPeriod(json, block) {
  const out = new Map();
  const fields = json.fields ?? [];
  const b = json[block];
  const ps = b?.p ?? [];
  const vs = b?.v ?? [];
  for (let i = 0; i < ps.length; i++) {
    const row = {};
    for (let k = 0; k < fields.length; k++) row[fields[k]] = vs[i]?.[k] ?? null;
    out.set(String(ps[i]), row);
  }
  return out;
}

const same = (a, b) => (a === null || b === null ? a === b : Object.is(a, b));

/**
 * 比對單一個股的舊/新交付。回傳所有違反「只增不改」的事實。
 * 純函式 —— 自我驗證直接餵物件進來,不需要檔案。
 */
export function diffTicker(ticker, oldJson, newJson) {
  const bad = [];
  const added = { annual: [], quarters: [] };

  const of = oldJson.fields ?? [];
  const nf = newJson.fields ?? [];
  // 欄位只能【原序保留後追加】。少一欄或換位置都會讓既有列的意義改變。
  for (let i = 0; i < of.length; i++) {
    if (nf[i] !== of[i]) {
      bad.push(`${ticker} 欄位順序改變:第 ${i} 欄 ${of[i]} → ${nf[i] ?? "(消失)"}`);
      return { bad, added }; // 索引已不可信,後續比較沒有意義
    }
  }

  for (const block of ["annual", "quarters"]) {
    const o = rowsByPeriod(oldJson, block);
    const n = rowsByPeriod(newJson, block);
    for (const [period, orow] of o) {
      const nrow = n.get(period);
      if (!nrow) {
        bad.push(`${ticker} ${block} 期別消失:${period}`);
        continue;
      }
      for (const f of of) {
        if (!same(orow[f], nrow[f])) {
          bad.push(`${ticker} ${block} ${period} ${f}: ${orow[f]} → ${nrow[f]}`);
        }
      }
    }
    for (const period of n.keys()) if (!o.has(period)) added[block].push(period);
  }
  return { bad, added };
}

/* ── 自我驗證:三種違規必須被抓,兩種合法變動必須放行 ───────────────────── */
function selfTest() {
  const base = {
    fields: ["rev", "cogs", "rd"],
    annual: { p: ["2024", "2025"], v: [[100, 60, 5], [110, 70, null]] },
    quarters: { p: ["2025Q3", "2025Q4"], v: [[30, 18, 2], [28, 17, null]] },
  };
  const clone = () => JSON.parse(JSON.stringify(base));

  const cases = [];
  // 違規①:既有格被改
  let c = clone();
  c.annual.v[0][0] = 101;
  cases.push({ name: "違規①:既有年度格 rev 100→101 → 必須抓到", j: c, expectBad: 1, must: "2024 rev" });
  // 違規②:既有期別消失
  c = clone();
  c.quarters.p = ["2025Q4"];
  c.quarters.v = [[28, 17, null]];
  cases.push({ name: "違規②:既有季別 2025Q3 消失 → 必須抓到", j: c, expectBad: 1, must: "期別消失" });
  // 違規③:欄位順序改變(值都還在,意義換了欄)
  c = clone();
  c.fields = ["rev", "rd", "cogs"];
  cases.push({ name: "違規③:欄位順序 cogs↔rd 對調 → 必須抓到(索引位移不會自己報錯)", j: c, expectBad: 1, must: "欄位順序改變" });
  // 違規④:null → 有值 也算改動(補值也是改既有格,必須看得見)
  c = clone();
  c.annual.v[1][2] = 7;
  cases.push({ name: "違規④:既有格由 null 補成 7 → 必須抓到(補值也是改)", j: c, expectBad: 1, must: "2025 rd" });
  // 合法①:新增期別
  c = clone();
  c.quarters.p.push("2026Q1");
  c.quarters.v.push([31, 19, 3]);
  cases.push({ name: "合法①:新增 2026Q1 → 必須放行,並列為新增", j: c, expectBad: 0, addQ: 1 });
  // 合法②:尾端追加新欄位
  c = clone();
  c.fields.push("capex");
  c.annual.v.forEach((r) => r.push(-9));
  c.quarters.v.forEach((r) => r.push(-3));
  cases.push({ name: "合法②:尾端追加 capex 欄 → 必須放行", j: c, expectBad: 0 });

  let fail = 0;
  for (const t of cases) {
    const { bad, added } = diffTicker("TEST", base, t.j);
    const okCount = bad.length === t.expectBad;
    const okMsg = !t.must || bad.some((b) => b.includes(t.must));
    const okAdd = t.addQ == null || added.quarters.length === t.addQ;
    const ok = okCount && okMsg && okAdd;
    if (!ok) fail++;
    console.log(`  ${ok ? "✓" : "✗"} ${t.name}`);
    if (!ok) {
      console.log(`      實際 ${bad.length} 項:${bad.join(" | ") || "(無)"}`);
      console.log(`      新增季別 ${added.quarters.length}`);
    }
  }
  const ctrl = cases.filter((x) => x.expectBad === 0).length;
  console.log(
    fail === 0
      ? `\n✅ 只增不改判準自我驗證通過(${cases.length - ctrl} 注入 + ${ctrl} 對照)`
      : `\n❌ 自我驗證失敗 ${fail} / ${cases.length}`
  );
  return fail === 0 ? 0 : 1;
}

if (argv.includes("--self-test")) process.exit(selfTest());

/* ── 對真實交付跑 ───────────────────────────────────────────────────────── */
const base = argOf("--base") || git(["log", "-1", "--format=%H", "--", REL]).trim();
if (!base) {
  console.error("找不到基準 commit");
  process.exit(2);
}
console.log(`基準 = ${base.slice(0, 9)} (${git(["log", "-1", "--format=%s", base]).trim()})`);

/**
 * 從 git 物件直接讀出基準內容 —— 不落地、不依賴外部 tar。
 * (原本用 `git archive | tar -x`:Git Bash 的 GNU tar 會把 `C:\...` 的冒號
 *  當成遠端主機規格,報 "Cannot connect to C"。少一個外部相依就少一種平台差異。)
 * `git cat-file --batch` 一次行程讀完 1,973 檔,輸出格式為
 *   `<oid> <type> <size>\n<內容><LF>` 逐筆相接。
 */
function readBaseAll(baseRef, tickers) {
  const input = tickers.map((t) => `${baseRef}:${REL}/${t}.json\n`).join("");
  const res = spawnSync("git", ["-C", REPO, "cat-file", "--batch"], {
    input,
    maxBuffer: 1 << 30,
  });
  if (res.status !== 0) throw new Error(`git cat-file 失敗:${res.stderr}`);
  const buf = res.stdout;
  const out = new Map();
  let off = 0;
  for (const t of tickers) {
    const nl = buf.indexOf(0x0a, off);
    const header = buf.slice(off, nl).toString("utf8");
    off = nl + 1;
    if (/ missing$/.test(header)) continue; // 基準沒有這一檔 = 全新個股
    const size = Number(header.split(" ")[2]);
    out.set(t, JSON.parse(buf.slice(off, off + size).toString("utf8")));
    off += size + 1; // 內容後有一個 LF
  }
  return out;
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const baseList = git(["ls-tree", "-r", "--name-only", base, "--", REL])
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => /\/\d{4}\.json$/.test(l))
  .map((l) => l.slice(-9, -5));
const BASE = readBaseAll(base, baseList);
const oldTk = new Set(BASE.keys());
const newTk = new Set(
  fs.readdirSync(LIVE_DIR).filter((f) => /^\d{4}\.json$/.test(f)).map((f) => f.slice(0, 4))
);

const bad = [];
const addedQ = new Map();
const addedA = new Map();
let touched = 0;
for (const t of oldTk) {
  if (!newTk.has(t)) {
    bad.push(`${t} 整檔消失`);
    continue;
  }
  const r = diffTicker(t, BASE.get(t), readJson(path.join(LIVE_DIR, `${t}.json`)));
  if (r.bad.length) {
    touched++;
    bad.push(...r.bad);
  }
  if (r.added.quarters.length) addedQ.set(t, r.added.quarters);
  if (r.added.annual.length) addedA.set(t, r.added.annual);
}
const brandNew = [...newTk].filter((t) => !oldTk.has(t));

console.log(`\n基準 ${oldTk.size} 檔 · 交付 ${newTk.size} 檔 · 全新個股 ${brandNew.length} 檔`);

// 新增期別統計
const qTally = new Map();
for (const ps of addedQ.values()) for (const p of ps) qTally.set(p, (qTally.get(p) ?? 0) + 1);
const aTally = new Map();
for (const ps of addedA.values()) for (const p of ps) aTally.set(p, (aTally.get(p) ?? 0) + 1);
console.log(`\n── 新增期別(這輪應該只有 115)──`);
for (const [p, n] of [...qTally].sort()) console.log(`  季 ${p}  ${n} 檔`);
for (const [p, n] of [...aTally].sort()) console.log(`  年 ${p}  ${n} 檔`);

// 115Q1 的欄位覆蓋:自己數一次,不引用交付報告的數字
const FOCUS = ["sell", "rd", "admin", "capex"];
const cov = Object.fromEntries([...FOCUS, "rev", "op", "ni"].map((f) => [f, 0]));
let q115 = 0;
for (const t of newTk) {
  const j = readJson(path.join(LIVE_DIR, `${t}.json`));
  const i = (j.quarters?.p ?? []).indexOf("2026Q1");
  if (i < 0) continue;
  q115++;
  for (const f of Object.keys(cov)) {
    const k = (j.fields ?? []).indexOf(f);
    const v = k < 0 ? null : j.quarters.v[i]?.[k];
    if (typeof v === "number" && Number.isFinite(v)) cov[f]++;
  }
}
console.log(`\n── 2026Q1(民國115Q1)覆蓋 —— 本腳本自行清點,不引用交付報告 ──`);
console.log(`  有 2026Q1 這一格的個股:${q115} 檔`);
for (const f of Object.keys(cov)) {
  console.log(`    ${f.padEnd(6)} ${String(cov[f]).padStart(5)} 檔  ${((100 * cov[f]) / (q115 || 1)).toFixed(1)}%`);
}

console.log(`\n── 只增不改判定 ──`);
if (bad.length === 0) {
  console.log(`  ✅ 既有期別逐格 0 差(${oldTk.size} 檔全數比對,含 null 對 null)`);
  console.log(`  ✅ 無期別消失、無欄位位移`);
  process.exit(0);
}
console.error(`  ❌ ${touched} 檔的既有資料被改動,共 ${bad.length} 項`);
for (const b of bad.slice(0, 30)) console.error(`      ${b}`);
if (bad.length > 30) console.error(`      …其餘 ${bad.length - 30} 項`);
process.exit(1);
