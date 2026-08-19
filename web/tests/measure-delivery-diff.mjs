#!/usr/bin/env node
/**
 * 交付差異的【獨立】重算 —— 改寫 / 補值 / 範圍外,逐類給總數
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 為什麼不直接讀 check-115-additive.mjs 的輸出:
 *    那支的違規清單把【範圍外改動 / 混基礎 / 結構性 / 範圍外補值】四類
 *    混在同一個陣列,逐檔串接後截在 30 筆。總數有印(「共 N 項」),
 *    但**分項組成不可從印出的內容推導** —— 前 30 筆沒看到某一類,不代表沒有,
 *    因為排序是逐檔的、不是逐類的。
 *    要分項數字,用這一支;要判定「過/不過」,用那一支。**兩支互為對照,不互相取代。**
 *
 * 🔴 這一支【不做判定】,只給數字。它沒有 exit 1,不會替任何人下結論。
 *
 * 用法
 *   node tests/measure-delivery-diff.mjs --base <ref> [--allow-restate 1101:109 ...]
 *
 * `--allow-restate` 在這裡只用來把改寫分成「宣告範圍內 / 範圍外」兩堆,
 * 不放行任何東西(本腳本本來就不判定)。展開規則同檢查器:(檔, 民國Y) → {Y, Y−1}。
 * ══════════════════════════════════════════════════════════════════════════
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const REL = "web/public/data/financials";
const argv = process.argv.slice(2);
const BASE = (() => {
  const i = argv.indexOf("--base");
  if (i < 0 || i + 1 >= argv.length) {
    console.error("需要 --base <ref>(基準來自 git 物件,不用自存快照)");
    process.exit(2);
  }
  return argv[i + 1];
})();

/** 宣告展開:(檔, 民國Y) → {西元Y, 西元Y−1} —— 端點一次回兩期,見 known-limitations §3.2 */
const RANGE = new Map();
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "--allow-restate") continue;
  const m = String(argv[i + 1] ?? "").match(/^(\d{4}[0-9A-Z]?):(\d{2,3})$/);
  if (!m) {
    console.error(`--allow-restate 必須具名到 (檔, 民國年),例如 1101:109;收到「${argv[i + 1]}」`);
    process.exit(2);
  }
  const y = Number(m[2]) + 1911;
  RANGE.set(m[1], new Set([y, y - 1]));
}
if (RANGE.size) {
  console.log("展開後的宣告範圍(不放行,只用來分堆):");
  for (const [t, ys] of [...RANGE].sort()) console.log(`  ${t}: ${[...ys].sort().join(" / ")}`);
  console.log();
}

function rows(json, block) {
  const out = new Map();
  const f = json.fields ?? [];
  const b = json[block];
  for (let i = 0; i < (b?.p ?? []).length; i++) {
    const r = {};
    for (let k = 0; k < f.length; k++) r[f[k]] = b.v[i]?.[k] ?? null;
    out.set(String(b.p[i]), r);
  }
  return out;
}
const yearOf = (p) => Number(String(p).slice(0, 4));

const names = execFileSync("git", ["-C", REPO, "ls-tree", "--name-only", BASE, REL + "/"], {
  encoding: "utf8",
  maxBuffer: 1 << 28,
}).split("\n").filter((s) => s.endsWith(".json"));
const buf = spawnSync("git", ["-C", REPO, "cat-file", "--batch"], {
  input: names.map((n) => `${BASE}:${n}`).join("\n") + "\n",
  maxBuffer: 1 << 30,
}).stdout;

let off = 0, idx = 0;
let owIn = 0, owOut = 0, fill = 0, vanished = 0, shifted = 0, newCells = 0;
const owByTY = new Map(), fillByT = new Map(), owOutList = [], vanishList = [], shiftList = [];

while (off < buf.length && idx < names.length) {
  const nl = buf.indexOf(0x0a, off);
  const size = parseInt(buf.slice(off, nl).toString("utf8").split(" ")[2], 10);
  const base = JSON.parse(buf.slice(nl + 1, nl + 1 + size).toString("utf8"));
  off = nl + 1 + size + 1;
  const t = path.basename(names[idx], ".json");
  idx++;

  const p = path.join(REPO, REL, `${t}.json`);
  if (!fs.existsSync(p)) { vanished++; vanishList.push(`${t} 整檔消失`); continue; }
  const live = JSON.parse(fs.readFileSync(p, "utf8"));

  /** 欄位順序:既有欄位必須是新欄位的前綴(只准尾端追加) */
  const bf = base.fields ?? [], lf = live.fields ?? [];
  if (bf.some((x, i) => lf[i] !== x)) { shifted++; shiftList.push(`${t}: ${bf.join(",")} → ${lf.join(",")}`); }

  for (const block of ["annual", "quarters"]) {
    const B = rows(base, block), L = rows(live, block);
    for (const [per, br] of B) {
      const lr = L.get(per);
      if (!lr) { vanished++; vanishList.push(`${t} ${block} ${per}`); continue; }
      for (const f of bf) {
        const a = br[f], b = lr[f];
        if (a === null && b !== null) {
          fill++;
          fillByT.set(t, (fillByT.get(t) ?? 0) + 1);
        } else if (a !== null && b === null) {
          /** 有值變空:比改寫更嚴重,一律歸範圍外 */
          owOut++;
          owOutList.push(`🔴 ${t} ${block} ${per} ${f}: ${a} → null(有值變空)`);
        } else if (a !== null && b !== null && !Object.is(a, b)) {
          if (RANGE.get(t)?.has(yearOf(per))) {
            owIn++;
            const k = `${t} ${yearOf(per)}`;
            owByTY.set(k, (owByTY.get(k) ?? 0) + 1);
          } else {
            owOut++;
            owOutList.push(`${t} ${block} ${per} ${f}: ${a} → ${b}`);
          }
        }
      }
    }
    for (const per of L.keys()) if (!B.has(per)) newCells += (live.fields ?? []).length;
  }
}

console.log(`基準 ${BASE} · ${names.length} 檔\n`);
console.log(`① 既有值被改寫(宣告範圍內)  = ${owIn} 格 / ${owByTY.size} 個 (檔,年)`);
for (const [k, n] of [...owByTY].sort()) console.log(`     ${k}  ${n} 格`);
console.log(`\n② null → 有值(補值)          = ${fill} 格 / ${fillByT.size} 檔`);
for (const [k, n] of [...fillByT].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) console.log(`     ${k}  ${n} 格`);
console.log(`\n③ 範圍外變動                  = ${owOut} 格   ← 🔴 這一項【不截斷】`);
for (const x of owOutList) console.log(`     ${x}`);
console.log(`\n   既有期別消失 = ${vanished}   欄位位移 = ${shifted}   新增期別格數 = ${newCells}`);
for (const x of vanishList) console.log(`     ${x}`);
for (const x of shiftList) console.log(`     ${x}`);
console.log(`\n(本腳本不做判定,只給數字 —— 過/不過請跑 check-115-additive.mjs)`);
