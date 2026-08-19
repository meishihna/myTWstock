#!/usr/bin/env node
/**
 * 偵測器盲區量測 —— §1.8 那 2,864 格的重算規則
 *
 * 🔴 存在的理由:「解析缺口已修完」這句話的真實範圍是
 *    「**store 有值可作對照的那一類**已修完」。官方 null 且 store 也 null 的格子,
 *    「真的沒有這個科目」與「兩邊都漏抓」輸出一模一樣 —— 偵測器結構上看不見。
 *    盲區必須有可重跑的大小,否則它會退化成一句沒有量感的散文。
 *
 * 🔴 這支腳本量的是【盲區有多大】,不是【盲區裡有幾格是錯的】。
 *    後者本站沒有任何來源能回答 —— 那正是本節的重點。
 *
 * 用法:node tests/measure-detector-blindspot.mjs
 */
import fs from "node:fs";
import path from "node:path";
const OFF = "C:/Users/messn/Desktop/twstock-web/web/public/data/financials";
const STORE = "C:/Users/messn/Desktop/twstock-web/data/financials_store";
const MAP = { sell: "Selling & Marketing Exp", admin: "General & Admin Exp", rd: "R&D Exp", capex: "CAPEX" };
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const yr = (p) => String(p).slice(0, 4);

const stat = {};
for (const f of Object.keys(MAP)) stat[f] = { A: 0, B: 0, C: 0, Cty: new Set() };
let tickers = 0, noStore = 0;

for (const n of fs.readdirSync(OFF)) {
  if (!n.endsWith(".json")) continue;
  const t = path.basename(n, ".json");
  const o = JSON.parse(fs.readFileSync(path.join(OFF, n), "utf8"));
  const sp = path.join(STORE, `${t}.json`);
  if (!fs.existsSync(sp)) { noStore++; continue; }
  const s = JSON.parse(fs.readFileSync(sp, "utf8"));
  if (!s?.annual?.series) { noStore++; continue; }
  tickers++;

  const sIdx = new Map();
  (s.annual.periods ?? []).forEach((p, i) => sIdx.set(yr(p), i));

  const fields = o.fields ?? [];
  const op = o.annual?.p ?? [], ov = o.annual?.v ?? [];
  for (let i = 0; i < op.length; i++) {
    const y = yr(op[i]);
    const si = sIdx.get(y);
    if (si == null) continue;                     // store 沒這一年,不列入比較
    for (const [f, key] of Object.entries(MAP)) {
      const k = fields.indexOf(f);
      if (k < 0) continue;
      const offV = ov[i]?.[k] ?? null;
      const stoV = s.annual.series[key]?.[si] ?? null;
      if (fin(offV)) stat[f].A++;
      else if (fin(stoV)) stat[f].B++;
      else { stat[f].C++; stat[f].Cty.add(t); }
    }
  }
}

console.log(`可比對的個股 ${tickers} 檔(無 store 或形狀不符 ${noStore} 檔,整檔無從比對)\n`);
console.log("年度區塊、雙方都有的年份、四個費用/資本支出欄:\n");
console.log("欄位     官方有值(A)  官方null·store有值(B)=可偵測  官方null·store也null(C)=🔴盲區  盲區檔數");
for (const [f, v] of Object.entries(stat)) {
  const tot = v.A + v.B + v.C;
  console.log(
    `${f.padEnd(8)} ${String(v.A).padStart(6)} ${((v.A/tot)*100).toFixed(1).padStart(6)}%   ${String(v.B).padStart(5)} ${((v.B/tot)*100).toFixed(1).padStart(5)}%              ${String(v.C).padStart(5)} ${((v.C/tot)*100).toFixed(1).padStart(5)}%           ${String(v.Cty.size).padStart(4)}`
  );
}
const allC = Object.values(stat).reduce((a, v) => a + v.C, 0);
const allB = Object.values(stat).reduce((a, v) => a + v.B, 0);
console.log(`\n合計:可偵測區 B = ${allB} 格 · 盲區 C = ${allC} 格 · 盲區/可偵測 = ${(allC/allB).toFixed(1)} 倍`);
