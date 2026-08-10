/**
 * expenseStack 群組決議規則變更 —— 【dry-run,不改任何行為】
 *
 * 現行規則(financialsAdapter.ts resolveGroups):
 *   官方勝出 ⟺ 群組內【每一個 key】的官方有值格數 > 0 且 ≥ store
 * 提案規則:
 *   官方勝出 ⟺ 官方的【期別覆蓋】≥ store 的期別覆蓋(某期別只要群組內任一 key 有值即算涵蓋)
 *
 * 為什麼要換:官方的 null 有大量是【語義 null】—— 那家公司的損益表本來就沒有「研發費用」
 * 那一列,null 才是正確答案。現行規則用「非空格數」比大小,等於讓 store 幾個【編出來的 0】
 * 在格數上勝出 —— 規則在懲罰正確性。
 *
 * 🔴 本腳本的可信度前提:
 *   我在這裡【重新實作】了舊規則。若我的重算與 adaptFinancials() 實際輸出的 charts 不一致,
 *   那麼我對新規則的推論也不可信。所以每跑一次都先做一致性驗證,不一致就 exit 1 ——
 *   不允許「舊規則對不上但新規則的數字照報」。
 *
 * 用法:npx tsx tests/dryrun-group-coverage.ts [--limit N] [--group expenseStack]
 */
import fs from "node:fs";
import path from "node:path";
import { adaptFinancials, CHART_GROUPS, loadStore } from "../src/lib/financialsAdapter";
import type { FinancialsJson } from "../src/lib/financialsJson";

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** 群組 → 官方交付檔的欄位代碼。marginLines 由 revenueLines 推導,不獨立決議。 */
const GROUP_TO_OFFICIAL_FIELDS: Record<string, string[]> = {
  revenueLines: ["rev", "gp", "op", "ni"],
  expenseStack: ["sell", "rd", "admin"],
  cashFlow: ["ocf", "icf", "fcf"],
  capex: ["capex"],
  eps: ["eps"],
};
const DECIDED_GROUPS = Object.keys(GROUP_TO_OFFICIAL_FIELDS);

type OffRaw = {
  fields?: string[];
  annual?: { p?: string[]; v?: (number | null)[][] };
  quarters?: { p?: string[]; v?: (number | null)[][] };
};

function loadOfficialRaw(ticker: string): OffRaw | null {
  const p = path.join(process.cwd(), "public/data/financials", `${ticker}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** 官方某群組在某軸的欄位值矩陣:每個欄位一條與期別等長的陣列 */
function officialCols(o: OffRaw | null, scope: "annual" | "quarters", group: string) {
  const blk = scope === "annual" ? o?.annual : o?.quarters;
  const rows = blk?.v ?? [];
  return GROUP_TO_OFFICIAL_FIELDS[group]!.map((f) => {
    const i = (o?.fields ?? []).indexOf(f);
    return i < 0 ? [] : rows.map((r) => r?.[i] ?? null);
  });
}

function storeCols(s: FinancialsJson | null, scope: "annual" | "quarters", group: string) {
  const blk = scope === "annual" ? s?.annual : (s?.quarterly ?? s?.quarterlyCore);
  return CHART_GROUPS[group]!.map((k) => (blk?.series?.[k] as (number | null)[]) ?? []);
}

const nFinite = (a: (number | null)[]) => a.filter(fin).length;
/** 期別覆蓋:該期只要群組內任一欄有值就算涵蓋 */
const nCovered = (cols: (number | null)[][]) => {
  const n = Math.max(0, ...cols.map((c) => c.length));
  let k = 0;
  for (let i = 0; i < n; i++) if (cols.some((c) => fin(c[i]))) k++;
  return k;
};

/** 舊規則:每一個 key 的官方非空格數 > 0 且 ≥ store */
const oldWins = (off: (number | null)[][], sto: (number | null)[][]) =>
  off.length > 0 && off.every((c, i) => nFinite(c) > 0 && nFinite(c) >= nFinite(sto[i] ?? []));

/**
 * 新規則:官方期別覆蓋 ≥ store 期別覆蓋。
 * 仍要求官方覆蓋 > 0 —— 否則「兩邊都空」時官方會以 0 ≥ 0 勝出,
 * 讓一個完全沒有官方資料的檔改標成官方來源(空的東西不該贏)。
 */
const newWins = (off: (number | null)[][], sto: (number | null)[][]) => {
  const oc = nCovered(off);
  return oc > 0 && oc >= nCovered(sto);
};

const tickers = (() => {
  const idx = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "public/data/reports-index.json"), "utf8")
  );
  return Object.keys(idx.byTicker ?? {})
    .filter((t) => /^\d{4}$/.test(t))
    .sort();
})();

const argv = process.argv.slice(2);
const limIdx = argv.indexOf("--limit");
const list = limIdx >= 0 ? tickers.slice(0, Number(argv[limIdx + 1])) : tickers;

type Flip = {
  ticker: string;
  group: string;
  from: string;
  to: string;
  cov: { aOff: number; aSto: number; qOff: number; qSto: number };
  cells: { aOff: number; aSto: number; qOff: number; qSto: number };
};

const flips: Flip[] = [];
const reverse: Flip[] = [];
const tally: Record<string, { oldOfficial: number; newOfficial: number; oldStore: number; newStore: number }> = {};
for (const g of DECIDED_GROUPS) tally[g] = { oldOfficial: 0, newOfficial: 0, oldStore: 0, newStore: 0 };

/** 一致性驗證:我重算的舊規則 vs adaptFinancials() 實際的 charts */
let checked = 0;
const mismatches: string[] = [];

/** 量測 #2:翻轉後,季度費用堆疊圖出現負值的檔數與格數 */
const negStack: { ticker: string; cells: number; sample: string[] }[] = [];

for (const t of list) {
  const o = loadOfficialRaw(t);
  const s = loadStore(t);
  if (!o && !s) continue;

  const decide = (rule: (a: (number | null)[][], b: (number | null)[][]) => boolean) => {
    const out: Record<string, string> = {};
    for (const g of DECIDED_GROUPS) {
      const dec = (scope: "annual" | "quarters") => {
        const off = o ? officialCols(o, scope, g) : [];
        const sto = storeCols(s, scope, g);
        if (o != null && rule(off, sto)) return "official";
        const anyStore = sto.some((c) => c.some(fin));
        return anyStore ? "store" : off.some((c) => c.some(fin)) ? "official" : "none";
      };
      const a = dec("annual");
      const q = dec("quarters");
      // 與 adaptFinancials 相同:年/季取交集
      out[g] = a === q ? a : a === "none" || q === "none" ? "none" : "store";
    }
    return out;
  };

  const mineOld = decide(oldWins);
  const mineNew = decide(newWins);

  // ── 一致性驗證(舊規則必須逐群組等於 production 實際輸出)──
  const real = adaptFinancials(t).charts;
  for (const g of DECIDED_GROUPS) {
    checked++;
    if ((real[g] ?? "none") !== mineOld[g]) {
      mismatches.push(`${t} ${g}: adaptFinancials=${real[g]} 我的重算=${mineOld[g]}`);
    }
  }

  for (const g of DECIDED_GROUPS) {
    if (mineOld[g] === "official") tally[g]!.oldOfficial++;
    if (mineOld[g] === "store") tally[g]!.oldStore++;
    if (mineNew[g] === "official") tally[g]!.newOfficial++;
    if (mineNew[g] === "store") tally[g]!.newStore++;
    if (mineOld[g] === mineNew[g]) continue;

    const oc = (sc: "annual" | "quarters") => (o ? officialCols(o, sc, g) : []);
    const sc2 = (sc: "annual" | "quarters") => storeCols(s, sc, g);
    const rec: Flip = {
      ticker: t,
      group: g,
      from: mineOld[g]!,
      to: mineNew[g]!,
      cov: {
        aOff: nCovered(oc("annual")), aSto: nCovered(sc2("annual")),
        qOff: nCovered(oc("quarters")), qSto: nCovered(sc2("quarters")),
      },
      cells: {
        aOff: oc("annual").reduce((n, c) => n + nFinite(c), 0),
        aSto: sc2("annual").reduce((n, c) => n + nFinite(c), 0),
        qOff: oc("quarters").reduce((n, c) => n + nFinite(c), 0),
        qSto: sc2("quarters").reduce((n, c) => n + nFinite(c), 0),
      },
    };
    if (mineNew[g] === "official") flips.push(rec);
    else reverse.push(rec);

    // 量測 #2:只看 expenseStack 翻到官方的檔,季度官方值出現負數的格
    if (g === "expenseStack" && mineNew[g] === "official" && o) {
      const cols = officialCols(o, "quarters", g);
      const ps = o.quarters?.p ?? [];
      const names = ["推銷", "研發", "管理"];
      const hits: string[] = [];
      let n = 0;
      cols.forEach((c, ci) =>
        c.forEach((v, i) => {
          if (fin(v) && v < 0) {
            n++;
            if (hits.length < 4) hits.push(`${ps[i] ?? "?"} ${names[ci]}=${v}`);
          }
        })
      );
      if (n > 0) negStack.push({ ticker: t, cells: n, sample: hits });
    }
  }
}

console.log(`掃描 ${list.length} 檔 · 群組決議一致性驗證 ${checked} 項`);
if (mismatches.length) {
  console.error(`\n❌ 我重算的【舊規則】與 adaptFinancials() 實際輸出不一致 ${mismatches.length} 項`);
  for (const m of mismatches.slice(0, 20)) console.error(`    ${m}`);
  console.error("→ 重算不可信,新規則的推論一律作廢。先修這裡。");
  process.exit(1);
}
console.log("✓ 舊規則重算與 adaptFinancials() 逐群組完全一致 → 新規則的推論建立在對的基準上\n");

console.log("群組".padEnd(16), "舊:官方".padStart(8), "新:官方".padStart(8), "  變化", "   舊:store", " 新:store");
console.log("-".repeat(72));
for (const g of DECIDED_GROUPS) {
  const v = tally[g]!;
  const d = v.newOfficial - v.oldOfficial;
  console.log(
    g.padEnd(16),
    String(v.oldOfficial).padStart(8),
    String(v.newOfficial).padStart(8),
    (d === 0 ? "    —" : d > 0 ? `  ▲ +${d}` : `  ▼ ${d}`).padEnd(9),
    String(v.oldStore).padStart(9),
    String(v.newStore).padStart(9)
  );
}

const byGroup = (arr: Flip[]) => {
  const m = new Map<string, Flip[]>();
  for (const f of arr) {
    if (!m.has(f.group)) m.set(f.group, []);
    m.get(f.group)!.push(f);
  }
  return m;
};

console.log(`\n── store → official 翻轉:${flips.length} 檔次 ──`);
for (const [g, list2] of byGroup(flips)) {
  console.log(`\n  ${g}:${list2.length} 檔`);
  // 每一檔都要能證明「官方期別覆蓋 ≥ store」,否則規則寫錯
  const bad = list2.filter((f) => !(f.cov.aOff >= f.cov.aSto && f.cov.qOff >= f.cov.qSto));
  console.log(`    覆蓋條件自我核對:${list2.length - bad.length}/${list2.length} 檔滿足「年與季的官方覆蓋皆 ≥ store」`);
  if (bad.length) {
    console.error(`    ❌ ${bad.length} 檔不滿足 —— 規則實作有誤`);
    for (const f of bad.slice(0, 5)) console.error(`        ${f.ticker} ${JSON.stringify(f.cov)}`);
  }
  for (const f of list2.slice(0, 10)) {
    console.log(
      `    ${f.ticker}  覆蓋 年 ${f.cov.aOff}/${f.cov.aSto} 季 ${f.cov.qOff}/${f.cov.qSto}` +
        `  (非空格數 年 ${f.cells.aOff}/${f.cells.aSto} 季 ${f.cells.qOff}/${f.cells.qSto})`
    );
  }
  if (list2.length > 10) console.log(`    …其餘 ${list2.length - 10} 檔`);
}

/**
 * 翻轉的【代價】:期別覆蓋上升,不代表非空格數不降。
 * 官方少掉的那些格若是【語義 null】(那家公司本來就沒有那一列)= 正確;
 * 但這裡先如實把數字攤開 —— 它正是全站對照(檢查 4)會報成退化的東西,
 * 必須在裁決前就看得見,不能等到檢查 4 紅了才發現。
 */
console.log(`\n── 翻轉的代價:非空格數變化 ──`);
for (const [g, list2] of byGroup(flips)) {
  const dA = list2.reduce((n, f) => n + (f.cells.aOff - f.cells.aSto), 0);
  const dQ = list2.reduce((n, f) => n + (f.cells.qOff - f.cells.qSto), 0);
  const loseA = list2.filter((f) => f.cells.aOff < f.cells.aSto);
  const loseQ = list2.filter((f) => f.cells.qOff < f.cells.qSto);
  console.log(
    `  ${g.padEnd(14)} 年 ${dA >= 0 ? "+" : ""}${dA} 格(${loseA.length} 檔下降)` +
      `  季 ${dQ >= 0 ? "+" : ""}${dQ} 格(${loseQ.length} 檔下降)`
  );
  for (const f of [...new Set([...loseA, ...loseQ])].slice(0, 6)) {
    console.log(
      `      ${f.ticker} 年 ${f.cells.aOff}←${f.cells.aSto} 季 ${f.cells.qOff}←${f.cells.qSto}`
    );
  }
}

console.log(`\n── 反向檢查:official → store(不該有)──`);
if (reverse.length === 0) console.log("  0 檔 ✓");
else {
  console.error(`  ❌ ${reverse.length} 檔次由官方掉回 store`);
  for (const [g, list2] of byGroup(reverse)) {
    console.error(`    ${g}:${list2.length} 檔`);
    for (const f of list2.slice(0, 8)) {
      console.error(`        ${f.ticker} 覆蓋 年 ${f.cov.aOff}/${f.cov.aSto} 季 ${f.cov.qOff}/${f.cov.qSto}`);
    }
  }
}

console.log(`\n── 量測 #2:翻轉後 expenseStack 的季度負值 ──`);
const stackFlips = flips.filter((f) => f.group === "expenseStack").length;
const negCells = negStack.reduce((n, x) => n + x.cells, 0);
console.log(`  翻轉檔 ${stackFlips} 檔中,季度費用出現負值:${negStack.length} 檔 / ${negCells} 格`);
for (const x of negStack.slice(0, 15)) {
  console.log(`    ${x.ticker}  ${x.cells} 格   ${x.sample.join(" · ")}`);
}
if (negStack.length > 15) console.log(`    …其餘 ${negStack.length - 15} 檔`);

fs.writeFileSync(
  path.join(process.cwd(), "node_modules/.cache/dryrun-group-coverage.json"),
  JSON.stringify({ tally, flips, reverse, negStack }, null, 1),
  "utf8"
);
console.log(`\n明細已寫入 node_modules/.cache/dryrun-group-coverage.json`);
