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
 * 比對單一個股的舊/新交付,把變動分成【三類】而不是二分。
 *
 * 🔴 2026-08-11 判準修正(在看到交付之後改的,理由必須成立才算數):
 *    原本把「null → 有值」也算硬違規(注入案例④「補值也是改」)。**那條是錯的。**
 *    「只增不改」的「改」指的是【改寫既有事實】;null 不是事實,是「還沒有資料」,
 *    把它補上是新增資料,不是改資料。
 *    決定性證據不是交付通不通過,而是【我自己在交付到貨前就預先登記過】:
 *    凍結 commit 的訊息寫著「115Q1 的殼已在、空的就是那四欄,ingest 後這四欄應大幅上升」。
 *    若 null 補值算違規,那句預期本身就自我矛盾 —— 我等於預先登記了一個必然失敗的形狀。
 *
 *    但補值【不能因此變成無條件放行】,否則規則就有了後門。所以改成三分:
 *      ① overwrite:既有【非空】格被改成別的值 → 永遠硬失敗(這才是改寫事實)
 *      ② vanish / shift:期別消失、欄位位移 → 永遠硬失敗
 *      ③ fill:null → 有值 → 分開計數並列出【期別 × 欄位】分布;
 *         且必須落在呼叫端【明文宣告】的範圍內(--allow-fill),
 *         範圍外的補值仍然硬失敗。
 *    宣告是明文的,所以下一次交付若在別的期別偷偷補值,不會靜靜通過。
 */
export function diffTicker(ticker, oldJson, newJson) {
  const overwrite = [];
  const structural = [];
  const fill = [];
  const added = { annual: [], quarters: [] };

  const of = oldJson.fields ?? [];
  const nf = newJson.fields ?? [];
  // 欄位只能【原序保留後追加】。少一欄或換位置都會讓既有列的意義改變。
  for (let i = 0; i < of.length; i++) {
    if (nf[i] !== of[i]) {
      structural.push(`${ticker} 欄位順序改變:第 ${i} 欄 ${of[i]} → ${nf[i] ?? "(消失)"}`);
      return { overwrite, structural, fill, added }; // 索引已不可信,後續比較沒有意義
    }
  }

  for (const block of ["annual", "quarters"]) {
    const o = rowsByPeriod(oldJson, block);
    const n = rowsByPeriod(newJson, block);
    for (const [period, orow] of o) {
      const nrow = n.get(period);
      if (!nrow) {
        structural.push(`${ticker} ${block} 期別消失:${period}`);
        continue;
      }
      for (const f of of) {
        if (same(orow[f], nrow[f])) continue;
        if (orow[f] === null) fill.push({ ticker, block, period, field: f, to: nrow[f] });
        // 🔴 結構化保存,不在此處組字串 —— 下游要用 (檔, 年) 判斷宣告範圍與「全換/全不換」
        else overwrite.push({ ticker, block, period, field: f, from: orow[f], to: nrow[f] });
      }
    }
    for (const period of n.keys()) if (!o.has(period)) added[block].push(period);
  }
  return { overwrite, structural, fill, added };
}

/** `2026Q1:sell,admin` → Map(period → Set(fields));`*` 代表任何欄位 */
export function parseAllowFill(specs) {
  const m = new Map();
  for (const s of specs) {
    const [period, fields = "*"] = String(s).split(":");
    if (!m.has(period)) m.set(period, new Set());
    for (const f of fields.split(",")) m.get(period).add(f.trim());
  }
  return m;
}

export const fillAllowed = (allow, { period, field }) => {
  const set = allow.get(period);
  return !!set && (set.has("*") || set.has(field));
};

/* ══════════════════════════════════════════════════════════════════════════
 * 改動範圍宣告(--allow-restate)—— 比 --allow-fill 更嚴的第二個宣告
 *
 * 背景:引擎補抓 11 檔 × 3 年的【原始申報】,把整年由「重編比較欄」換成「原始申報」。
 *   例 1101 民國109:sell 151.824 → 228.564、admin 1074.932 → 1088.619
 * 那是本輪的目的,不是違規 —— 但 overwrite 判準會硬失敗,所以需要一個宣告機制。
 *
 * 三條設計約束(缺一就有後門):
 *   ① **具名到 (檔, 年)**。不接受 `*`、不接受「這次允許改動」這種萬用通行證 ——
 *      萬用通行證等於把 overwrite 判準關掉。
 *   ② **自動涵蓋「補抓年 − 1」**。官方頁面一次回兩期(本年 + 去年同期),
 *      所以補 (1434, 107) 必然連帶改動民國106 的值。這不是寬鬆,是結構事實;
 *      但展開後的完整範圍會【印出來】,不靜默生效。
 *   ③ 🔴 **雙向檢查**。只驗「改動 ⊆ 宣告範圍」不夠 ——
 *      那樣「只換 Q1、其餘留重編值」仍會通過,而那正是契約禁止的【部分採用重編】。
 *      所以還要驗:宣告的每個 (檔, 年) 內,該年的期別**要嘛全換、要嘛全不換**。
 *
 * ⚠️ 已知限制:③ 以【期別】為單位判斷「有沒有變」。若某一季的原始申報與重編值
 *    恰好相同,該季會被算成「沒換」→ 誤報部分採用。目前選擇讓它硬失敗並印出明細,
 *    由人判斷是否為巧合 —— 寧可誤報一次,不要漏掉真的部分採用。
 * ══════════════════════════════════════════════════════════════════════════ */

/** `1101:109`(民國年)→ Map(ticker → Set(西元年));自動加入補抓年 − 1 */
export function parseAllowRestate(specs) {
  const m = new Map();
  for (const s of specs) {
    const str = String(s).trim();
    if (!/^\d{4}:\d{2,3}$/.test(str)) {
      throw new Error(`--allow-restate 必須具名到 (檔, 民國年),例如 1101:109;收到「${str}」`);
    }
    const [t, roc] = str.split(":");
    const y = Number(roc) + 1911;
    if (!m.has(t)) m.set(t, new Set());
    m.get(t).add(y);
    m.get(t).add(y - 1); // 端點一次回兩期:補 109 必然連帶改 108
  }
  return m;
}

/** 期別字串 → 西元年;`2020` / `2020Q1` 皆可 */
export const yearOfPeriod = (p) => {
  const m = String(p).match(/^(\d{4})/);
  return m ? Number(m[1]) : NaN;
};

export const restateAllowed = (allow, { ticker, period }) =>
  !!allow.get(ticker)?.has(yearOfPeriod(period));

/**
 * 「全換 / 全不換」檢查。
 * 對宣告的每個 (檔, 年),取該年【新舊都存在】的期別,看有幾個真的變了。
 * 0 個或全部 = 合法;介於中間 = 部分採用重編 → 硬失敗。
 */
export function restateCompleteness(ticker, oldJson, newJson, year, changedPeriods) {
  const inYear = [];
  for (const block of ["annual", "quarters"]) {
    const o = rowsByPeriod(oldJson, block);
    const n = rowsByPeriod(newJson, block);
    for (const p of o.keys()) if (n.has(p) && yearOfPeriod(p) === year) inYear.push(`${block}:${p}`);
  }
  const changed = inYear.filter((k) => changedPeriods.has(k));
  return { ticker, year, total: inYear.length, changed: changed.length, changedList: changed, all: inYear };
}

/* ── 自我驗證:三種違規必須被抓,兩種合法變動必須放行 ───────────────────── */
function selfTest() {
  const base = {
    fields: ["rev", "cogs", "rd"],
    annual: { p: ["2024", "2025"], v: [[100, 60, 5], [110, 70, null]] },
    quarters: { p: ["2025Q3", "2025Q4"], v: [[30, 18, 2], [28, 17, null]] },
  };
  const clone = () => JSON.parse(JSON.stringify(base));

  /** 宣告可補值的範圍:只有 2025Q4 的 rd 可以補 —— 用來檢驗範圍外補值會被抓 */
  const allow = parseAllowFill(["2025Q4:rd"]);

  const cases = [];
  // 違規①:既有非空格被改寫
  let c = clone();
  c.annual.v[0][0] = 101;
  cases.push({ name: "違規①:既有年度格 rev 100→101(改寫事實)→ 必須抓到", j: c, expectBad: 1, must: "2024 rev" });
  // 違規②:既有期別消失
  c = clone();
  c.quarters.p = ["2025Q4"];
  c.quarters.v = [[28, 17, null]];
  cases.push({ name: "違規②:既有季別 2025Q3 消失 → 必須抓到", j: c, expectBad: 1, must: "期別消失" });
  // 違規③:欄位順序改變(值都還在,意義換了欄)
  c = clone();
  c.fields = ["rev", "rd", "cogs"];
  cases.push({ name: "違規③:欄位順序 cogs↔rd 對調 → 必須抓到(索引位移不會自己報錯)", j: c, expectBad: 1, must: "欄位順序改變" });
  // 違規④:補值落在【宣告範圍之外】—— 三分法的後門就在這裡,必須封死
  c = clone();
  c.annual.v[1][2] = 7; // 年2025 rd 由 null 補成 7,而宣告只允許 2025Q4:rd
  cases.push({
    name: "違規④:補值在宣告範圍外(年2025 rd,只宣告 2025Q4:rd)→ 必須抓到",
    j: c,
    expectBad: 1,
    must: "範圍外補值",
  });
  // 合法①:新增期別 + 宣告範圍內的補值
  c = clone();
  c.quarters.p.push("2026Q1");
  c.quarters.v.push([31, 19, 3]);
  c.quarters.v[1][2] = 4; // 2025Q4 rd null→4(允許)
  cases.push({ name: "合法①:新增 2026Q1 + 宣告內補值(2025Q4 rd)→ 必須放行", j: c, expectBad: 0, addQ: 1, fillN: 1 });
  // 合法②:尾端追加新欄位
  c = clone();
  c.fields.push("capex");
  c.annual.v.forEach((r) => r.push(-9));
  c.quarters.v.forEach((r) => r.push(-3));
  cases.push({ name: "合法②:尾端追加 capex 欄 → 必須放行", j: c, expectBad: 0 });

  /* ── 改動範圍宣告的注入案例 ───────────────────────────────────────────── */
  /** 夾具:2023 與 2024 各有「年度列 + 四季」,才測得出「某一年只換一部分」 */
  const R = {
    fields: ["rev", "cogs", "rd"],
    annual: { p: ["2023", "2024"], v: [[90, 50, 4], [100, 60, 5]] },
    quarters: {
      p: ["2023Q1","2023Q2","2023Q3","2023Q4","2024Q1","2024Q2","2024Q3","2024Q4"],
      v: [[18,11,1],[22,13,1],[24,14,1],[26,15,1],[20,12,1],[25,15,1],[27,16,1],[28,17,2]],
    },
  };
  const rclone = () => JSON.parse(JSON.stringify(R));
  /** 宣告 (9999, 民國113) → 應展開成 {2024, 2023};這裡順便驗展開規則 */
  const expand = parseAllowRestate(["9999:113"]);
  const expandOk = [...(expand.get("9999") ?? [])].sort().join(",") === "2023,2024";
  /** 本檔的測試代號是 TEST,故手工組同形狀的宣告 */
  const allowR = new Map([["TEST", new Set([2024, 2023])]]);
  const setYear = (j, year, fn) => {
    j.annual.p.forEach((p, i) => { if (yearOfPeriod(p) === year) j.annual.v[i] = fn(j.annual.v[i]); });
    j.quarters.p.forEach((p, i) => { if (yearOfPeriod(p) === year) j.quarters.v[i] = fn(j.quarters.v[i]); });
    return j;
  };

  const rcases = [];
  rcases.push({
    name: "合法①:宣告 (TEST,2024),該年【年度列 + 四季全部】都換 → 必須放行",
    j: setYear(rclone(), 2024, (r) => [r[0] + 1, r[1], r[2]]), allow: allowR, expectBad: 0,
  });
  rcases.push({
    name: "合法②:宣告的 2023 一格都沒換(全不換)→ 必須放行",
    j: setYear(rclone(), 2024, (r) => [r[0] + 1, r[1], r[2]]), allow: allowR, expectBad: 0,
  });
  const onlyQ1 = rclone(); onlyQ1.quarters.v[4] = [21, 12, 1]; // 2024Q1
  rcases.push({
    name: "注入⑤:宣告了 (檔,年) 但【只換 2024Q1】→ 必須抓到(部分採用重編)",
    j: onlyQ1, allow: allowR, expectBad: 1, must: "部分採用重編",
  });
  const onlyAnnual23 = rclone(); onlyAnnual23.annual.v[0] = [91, 50, 4]; // 2023 年度列
  rcases.push({
    name: "注入⑥:自動涵蓋的 2023 只換年度列、四季未換 → 必須抓到(部分採用重編)",
    j: onlyAnnual23, allow: allowR, expectBad: 1, must: "部分採用重編",
  });
  rcases.push({
    name: "注入⑦:未宣告任何範圍時,任何改動都硬失敗(fail closed)",
    j: setYear(rclone(), 2024, (r) => [r[0] + 1, r[1], r[2]]), allow: new Map(), expectBad: 5, must: "範圍外改動",
  });
  const outOfYear = rclone(); outOfYear.annual.v[0] = [91, 50, 4];
  rcases.push({
    name: "注入⑧:改動落在【宣告範圍外的年份】→ 必須抓到",
    j: outOfYear, allow: new Map([["TEST", new Set([2024])]]), expectBad: 1, must: "範圍外改動",
  });

  let fail = 0;
  for (const t of [...cases, ...rcases]) {
    const isR = t.allow !== undefined;
    const oldJ = isR ? R : base;
    const { overwrite, structural, fill, added } = diffTicker("TEST", oldJ, t.j);
    const outOfScope = fill.filter((x) => !fillAllowed(allow, x)).map((x) => `${x.ticker} 範圍外補值 ${x.block} ${x.period} ${x.field}`);
    const aR = isR ? t.allow : new Map();
    const owOut = overwrite
      .filter((x) => !restateAllowed(aR, x))
      .map((x) => `${x.ticker} 範圍外改動 ${x.block} ${x.period} ${x.field}: ${x.from} → ${x.to}`);
    const changedPeriods = new Set(overwrite.map((x) => `${x.block}:${x.period}`));
    const partial = [];
    for (const [tk, years] of aR) {
      for (const y of years) {
        const c = restateCompleteness(tk, oldJ, t.j, y, changedPeriods);
        if (c.changed > 0 && c.changed < c.total) {
          partial.push(`${tk} ${y} 部分採用重編:${c.total} 個期別只換了 ${c.changed} 個(${c.changedList.join(", ")})`);
        }
      }
    }
    const bad = [...(isR ? owOut : overwrite.map((x) => `${x.ticker} ${x.block} ${x.period} ${x.field}: ${x.from} → ${x.to}`)), ...structural, ...outOfScope, ...partial];
    const okCount = bad.length === t.expectBad;
    const okMsg = !t.must || bad.some((b) => b.includes(t.must));
    const okAdd = t.addQ == null || added.quarters.length === t.addQ;
    const okFill = t.fillN == null || fill.length === t.fillN;
    const ok = okCount && okMsg && okAdd && okFill;
    if (!ok) fail++;
    console.log(`  ${ok ? "✓" : "✗"} ${t.name}`);
    if (!ok) {
      console.log(`      實際 ${bad.length} 項:${bad.join(" | ") || "(無)"}`);
      console.log(`      新增季別 ${added.quarters.length} · 補值 ${fill.length} 格`);
    }
  }
  if (!expandOk) {
    fail++;
    console.log(`  ✗ parseAllowRestate("9999:113") 未展開成 {2023, 2024}(實際 ${[...(expand.get("9999") ?? [])].join(",")})`);
  } else {
    console.log(`  ✓ parseAllowRestate("9999:113") 自動涵蓋補抓年 − 1 → {2023, 2024}`);
  }
  // 具名要求:萬用通行證必須被拒
  for (const bad of ["*:113", "1101:*", "1101", "*"]) {
    let threw = false;
    try { parseAllowRestate([bad]); } catch { threw = true; }
    if (!threw) { fail++; console.log(`  ✗ parseAllowRestate("${bad}") 應該拋錯(萬用通行證等於把 overwrite 判準關掉)`); }
  }
  console.log(`  ✓ 萬用通行證(*:113 / 1101:* / 1101 / *)一律拒收`);

  const all = [...cases, ...rcases];
  const ctrl = all.filter((x) => x.expectBad === 0).length;
  console.log(
    fail === 0
      ? `\n✅ 只增不改判準自我驗證通過(${all.length - ctrl} 注入 + ${ctrl} 對照,另含展開規則與具名要求)`
      : `\n❌ 自我驗證失敗 ${fail} / ${all.length}`
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

/**
 * 可補值範圍必須【明文宣告】。沒宣告 = 任何補值都算違規(預設最嚴)。
 * 用法:--allow-fill 2026Q1:sell,admin,rd,capex
 */
const allow = parseAllowFill(argv.filter((_, i) => argv[i - 1] === "--allow-fill"));
console.log(
  allow.size
    ? `宣告可補值範圍:${[...allow].map(([p, s]) => `${p}:${[...s].join(",")}`).join(" · ")}`
    : `宣告可補值範圍:(無)—— 任何 null→有值 都會被判違規`
);

/**
 * 改動範圍宣告。具名到 (檔, 民國年);展開後的完整範圍一定印出來,不靜默生效。
 * 用法:--allow-restate 1101:109 --allow-restate 1434:107
 */
const restate = parseAllowRestate(argv.filter((_, i) => argv[i - 1] === "--allow-restate"));
console.log(
  restate.size
    ? `宣告可改動範圍(已展開「補抓年 − 1」):${[...restate].map(([t, ys]) => `${t}:${[...ys].sort().join("/")}`).join(" · ")}`
    : `宣告可改動範圍:(無)—— 任何既有非空格被改寫都會被判違規`
);

const bad = [];
const fills = [];
const restated = [];
const addedQ = new Map();
const addedA = new Map();
let touched = 0;
for (const t of oldTk) {
  if (!newTk.has(t)) {
    bad.push(`${t} 整檔消失`);
    continue;
  }
  const newJson = readJson(path.join(LIVE_DIR, `${t}.json`));
  const r = diffTicker(t, BASE.get(t), newJson);
  const outOfScope = r.fill.filter((x) => !fillAllowed(allow, x));
  fills.push(...r.fill.filter((x) => fillAllowed(allow, x)));

  // ── 改動:① 必須落在宣告範圍內 ② 宣告的 (檔,年) 內必須全換或全不換 ──
  const owOut = r.overwrite.filter((x) => !restateAllowed(restate, x));
  restated.push(...r.overwrite.filter((x) => restateAllowed(restate, x)));
  const changedPeriods = new Set(r.overwrite.map((x) => `${x.block}:${x.period}`));
  const partial = [];
  for (const y of restate.get(t) ?? []) {
    const c = restateCompleteness(t, BASE.get(t), newJson, y, changedPeriods);
    if (c.changed > 0 && c.changed < c.total) {
      partial.push(
        `${t} ${y} 部分採用重編:該年 ${c.total} 個期別只換了 ${c.changed} 個` +
          `(換了:${c.changedList.join(", ")};未換:${c.all.filter((k) => !changedPeriods.has(k)).join(", ")})`
      );
    }
  }

  const hard = [
    ...owOut.map((x) => `${x.ticker} 範圍外改動 ${x.block} ${x.period} ${x.field}: ${x.from} → ${x.to}`),
    ...partial,
    ...r.structural,
    ...outOfScope.map((x) => `${x.ticker} 範圍外補值 ${x.block} ${x.period} ${x.field}: null → ${x.to}`),
  ];
  if (hard.length) {
    touched++;
    bad.push(...hard);
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

// 補值可見化:分布必須看得見,否則「合法補值」會變成一片無人清點的變動
if (fills.length) {
  const byPF = new Map();
  const tk = new Set();
  for (const f of fills) {
    const k = `${f.block === "annual" ? "年" : "季"}${f.period} · ${f.field}`;
    byPF.set(k, (byPF.get(k) ?? 0) + 1);
    tk.add(f.ticker);
  }
  console.log(`\n── 宣告範圍內的補值(null → 有值):${fills.length} 格 / ${tk.size} 檔 ──`);
  for (const [k, n] of [...byPF].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(24)} ${n} 檔`);
}

// 改動可見化:宣告範圍內的改寫也要逐格看得見
if (restated.length) {
  const byTY = new Map();
  for (const x of restated) {
    const k = `${x.ticker} ${yearOfPeriod(x.period)}`;
    byTY.set(k, (byTY.get(k) ?? 0) + 1);
  }
  console.log(`\n── 宣告範圍內的改動(既有非空值被改寫):${restated.length} 格 / ${byTY.size} 個 (檔,年) ──`);
  for (const [k, n] of [...byTY].sort()) console.log(`  ${k.padEnd(14)} ${n} 格`);
  for (const x of restated.slice(0, 8)) {
    console.log(`    ${x.ticker} ${x.block === "annual" ? "年" : "季"}${x.period} ${x.field}: ${x.from} → ${x.to}`);
  }
  if (restated.length > 8) console.log(`    …其餘 ${restated.length - 8} 格`);
}

console.log(`\n── 只增不改判定 ──`);
if (bad.length === 0) {
  console.log(
    restate.size
      ? `  ✅ 既有非空格的改寫 ${restated.length} 格,全部落在宣告的 (檔,年) 內,且每個宣告年【全換或全不換】`
      : `  ✅ 既有【非空】格 0 處被改寫(${oldTk.size} 檔全數比對)`
  );
  console.log(`  ✅ 無期別消失、無欄位位移`);
  console.log(`  ✅ 所有 null→有值 都落在明文宣告的範圍內(${fills.length} 格)`);
  process.exit(0);
}
console.error(`  ❌ ${touched} 檔違規,共 ${bad.length} 項`);
for (const b of bad.slice(0, 30)) console.error(`      ${b}`);
if (bad.length > 30) console.error(`      …其餘 ${bad.length - 30} 項`);
process.exit(1);
