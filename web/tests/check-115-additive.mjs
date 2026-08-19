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
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 輸出的靜默截斷 —— 讀違規清單之前先讀這段(2026-08-19 標註,不改行為)
 *
 *   違規清單截在 **30 筆**(第 ~697 行 `bad.slice(0, 30)`),覆寫明細截在 8 筆。
 *   **總數有印**(「❌ N 檔違規,共 M 項」、「…其餘 K 項」),那個數字可以信。
 *
 *   🔴 **不可信的是分項組成。**【範圍外改動 / 混基礎 / 結構性 / 範圍外補值】
 *   四類全塞進同一個 `bad` 陣列,而且是**逐檔**串接、不是逐類 ——
 *   所以「前 30 筆裡沒看到範圍外改動」**完全不代表沒有**:
 *   某一檔的補值就可能把後面所有檔的改動全部擠出可見範圍。
 *   (實例:2026-08-19 複驗時 1434 的 22 格補值就把第 30 筆之後全吃掉了。)
 *
 *   要分項數字 → `node tests/measure-delivery-diff.mjs --base <ref> [--allow-restate …]`
 *   那一支不判定、只給數字,而且**範圍外那一項不截斷**。兩支互為對照,不互相取代。
 *
 *   ⚠️ 本檔在交付到貨前凍結,所以**只標註、不修**。
 *      凍結禁止的是改判準,不是禁止說明它的輸出怎麼讀。
 * ══════════════════════════════════════════════════════════════════════════
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

/**
 * 補值範圍宣告。兩種寫法:
 *   `2026Q1:sell,admin`        期別 + 欄位(代號不限)= 舊寫法,等同 `*:2026Q1:sell,admin`
 *   `6005:*:capex`             **代號** + 期別 + 欄位(期別可 `*`)
 *
 * 🔴 2026-08-13 擴充,方向是【更嚴】:
 *    舊寫法無法表達「這 8 檔的 capex」。若用 `2018:capex` 去放行證券業那批,
 *    會連帶放行【全市場】該年的 capex 補值 —— 一個為了 8 檔開的口子會蓋住 1,975 檔。
 *    帶代號後只放行指定的代號,其餘一律硬失敗。
 *    (依規則:改動使檢查更嚴 → 附新的注入測試證明沒開後門即可。)
 */
export function parseAllowFill(specs) {
  const out = [];
  for (const s of specs) {
    const parts = String(s).split(":").map((x) => x.trim());
    const [ticker, period, fields] =
      parts.length >= 3 ? parts : ["*", parts[0], parts[1] ?? "*"];
    out.push({
      ticker,
      period,
      fields: new Set(String(fields || "*").split(",").map((f) => f.trim())),
    });
  }
  return out;
}

export const fillAllowed = (allow, { ticker, period, field }) =>
  (allow ?? []).some(
    (r) =>
      (r.ticker === "*" || r.ticker === ticker) &&
      (r.period === "*" || r.period === period) &&
      (r.fields.has("*") || r.fields.has(field))
  );

export const describeAllowFill = (allow) =>
  (allow ?? []).map((r) => `${r.ticker}:${r.period}:${[...r.fields].join(",")}`).join(" · ");

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
 * 「全換 / 全不換」—— 🔴【已降級為診斷資訊,不再作為判定】(2026-08-13)
 *
 * 它只數「有沒有動」,而「沒動」有兩種:漏了,和【本來就對】。
 * 重編比較欄只汙染「取自後續年度頁面」的期別;Q1–Q3 若原本就取自自己那年的季報,
 * 從一開始就是原始申報,不需要改。實測 1434/1472/1612/2348/3090 五個 (檔,年)
 * 被它判成「部分採用重編」,但用恆等式驗全部一致 —— 五個都是誤報。
 * 它印出的「換了哪些 / 未換哪些」仍有診斷價值,故保留輸出。
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

/** 期別是否來自 t163 損益表(bs 是時點數,不可累加;capex 屬現金流量表,亦不適用) */
const SUM_FIELDS = ["rev", "cogs", "gp", "opex", "op", "ni", "sell", "admin", "rd"];
/** 期別值以 3 位小數存放,四季相加的捨入誤差上限約 0.002;取 0.005 留餘裕 */
const SUM_TOL = 0.005;

/**
 * 🔴 判定「該年有沒有混基礎」的正式判準:**Σ四季 == 年度**
 *
 * 為什麼比「全換/全不換」強:
 *   - 期別計數只看「有沒有動」,抓不到「全部都換但換錯基礎」
 *   - 恆等式直接檢驗年度與四季是否來自同一組申報;混了必破
 *
 * 資料不全的處置:**「量不到 = 失敗」,不是「量不到 = 沒問題」**
 *   - 某欄位缺年度或缺任一季 → 該欄位記為「無法驗」,不算通過
 *   - 該 (檔,年)【沒有任何一個欄位可驗】→ 判「無法判定」→ 硬失敗
 *   - 至少一個欄位可驗且全部一致 → 通過,並列出無法驗的欄位
 */
export function yearIdentity(ticker, json, year) {
  const fields = json.fields ?? [];
  const ai = (json.annual?.p ?? []).indexOf(String(year));
  const qi = [1, 2, 3, 4].map((q) => (json.quarters?.p ?? []).indexOf(`${year}Q${q}`));
  const checked = [];
  const unverifiable = [];
  const broken = [];
  for (const f of SUM_FIELDS) {
    const k = fields.indexOf(f);
    if (k < 0) continue;
    const av = ai >= 0 ? json.annual?.v?.[ai]?.[k] : null;
    const qs = qi.map((i) => (i >= 0 ? json.quarters?.v?.[i]?.[k] : null));
    if (!isNum(av) || !qs.every(isNum)) {
      unverifiable.push(f);
      continue;
    }
    const sum = qs.reduce((n, v) => n + v, 0);
    const diff = Math.abs(sum - av);
    checked.push(f);
    if (diff > SUM_TOL) broken.push(`${f}: Σ四季 ${sum.toFixed(3)} vs 年度 ${av.toFixed(3)}(差 ${diff.toFixed(3)})`);
  }
  return { ticker, year, checked, unverifiable, broken, verdict: broken.length ? "混基礎" : checked.length ? "一致" : "無法判定" };
}
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

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
  /**
   * 夾具:2023 與 2024 各有「年度列 + 四季」,而且【四季相加 == 年度】逐欄成立。
   * 🔴 夾具本身必須算術自洽,否則恆等式的注入測不到東西 ——
   *    合法案例若一開始就破,測到的是夾具的錯,不是被測物的錯。
   *    (同一個坑上一輪踩過:夾具只有 2024 的季別 → 注入⑥ 是空砲。)
   */
  const R = {
    fields: ["rev", "cogs", "rd"],
    annual: { p: ["2023", "2024"], v: [[90, 50, 4], [100, 60, 5]] },
    quarters: {
      p: ["2023Q1","2023Q2","2023Q3","2023Q4","2024Q1","2024Q2","2024Q3","2024Q4"],
      v: [[18,11,1],[22,13,1],[24,14,1],[26,12,1],[20,12,1],[25,15,1],[27,16,1],[28,17,2]],
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

  /** 「整年換基礎」的合法形狀:四季各 +1、年度 +4 → 恆等式仍成立 */
  const restateWhole = () => {
    const c = rclone();
    c.annual.v[1] = [104, 60, 5];
    [4, 5, 6, 7].forEach((i) => (c.quarters.v[i] = [c.quarters.v[i][0] + 1, c.quarters.v[i][1], c.quarters.v[i][2]]));
    return c;
  };

  const rcases = [];
  rcases.push({
    name: "合法①:宣告 (TEST,2024) 整年換基礎且 Σ四季 == 年度 → 必須放行",
    j: restateWhole(), allow: allowR, expectBad: 0,
  });
  const onlyQ1 = rclone(); onlyQ1.quarters.v[4] = [21, 12, 1]; // 只動 2024Q1
  rcases.push({
    name: "注入⑤:只換 2024Q1 → Σ四季 101 ≠ 年度 100,恆等式必破",
    j: onlyQ1, allow: allowR, expectBad: 1, must: "混基礎",
  });
  const onlyAnnual23 = rclone(); onlyAnnual23.annual.v[0] = [91, 50, 4]; // 只動 2023 年度列
  rcases.push({
    name: "注入⑥:自動涵蓋的 2023 只換年度列 → Σ四季 90 ≠ 年度 91,恆等式必破",
    j: onlyAnnual23, allow: allowR, expectBad: 1, must: "混基礎",
  });
  rcases.push({
    name: "注入⑦:未宣告任何範圍時,任何改動都硬失敗(fail closed)",
    j: restateWhole(), allow: new Map(), expectBad: 5, must: "範圍外改動",
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
    // 判定改用恆等式(只對【該年真的有覆寫】的年份驗;沒動的年份不必驗)
    const changedPeriods = new Set(overwrite.map((x) => `${x.block}:${x.period}`));
    const touchedYears = new Set(overwrite.map((x) => yearOfPeriod(x.period)));
    const partial = [];
    for (const [tk, years] of aR) {
      for (const y of years) {
        if (!touchedYears.has(y)) continue;
        const id = yearIdentity(tk, t.j, y);
        if (id.verdict === "混基礎") partial.push(`${tk} ${y} 混基礎:${id.broken.join(" | ")}`);
        else if (id.verdict === "無法判定") partial.push(`${tk} ${y} 無法判定:沒有任何欄位可驗(缺年度或缺季別)`);
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
  /* ── 補值宣告「帶代號」的注入(證明加代號沒開後門)────────────────────── */
  {
    const a8 = parseAllowFill(["6005:*:capex"]);
    const probes = [
      { name: "指定 6005 的 capex 補值 → 放行", x: { ticker: "6005", period: "2018", field: "capex" }, want: true },
      { name: "注入:未指定的代號 6016 也補了 capex → 必須抓到", x: { ticker: "6016", period: "2018", field: "capex" }, want: false },
      { name: "注入:代號對但欄位不對(6005 的 rd)→ 必須抓到", x: { ticker: "6005", period: "2018", field: "rd" }, want: false },
      { name: "舊寫法 2026Q1:sell 仍等同 *:2026Q1:sell(代號不限)", x: { ticker: "9999", period: "2026Q1", field: "sell" }, want: true, allow: parseAllowFill(["2026Q1:sell"]) },
      { name: "注入:舊寫法下期別不符 → 必須抓到", x: { ticker: "9999", period: "2025Q4", field: "sell" }, want: false, allow: parseAllowFill(["2026Q1:sell"]) },
    ];
    for (const p of probes) {
      const got = fillAllowed(p.allow ?? a8, p.x);
      const ok = got === p.want;
      if (!ok) fail++;
      console.log(`  ${ok ? "✓" : "✗"} ${p.name}`);
    }
  }

  /* ── 恆等式 Σ四季 == 年度 的注入 ──────────────────────────────────────── */
  {
    const J = {
      fields: ["rev", "sell", "rd"],
      annual: { p: ["2020"], v: [[100, 10, 4]] },
      quarters: { p: ["2020Q1", "2020Q2", "2020Q3", "2020Q4"], v: [[20, 2, 1], [25, 3, 1], [27, 2, 1], [28, 3, 1]] },
    };
    const cl = () => JSON.parse(JSON.stringify(J));
    const idCases = [
      { name: "合法:四季相加 == 年度(rev/sell/rd 三欄)→ 一致", j: cl(), want: "一致" },
      {
        name: "注入⑨:某一季換成另一基礎的值(Q1 rev 20→31)→ 恆等式必破,必須抓到",
        j: (() => { const c = cl(); c.quarters.v[0][0] = 31; return c; })(),
        want: "混基礎",
      },
      {
        name: "注入⑩:缺年度列 → 判「無法判定」而非通過(量不到 = 失敗)",
        j: (() => { const c = cl(); c.annual = { p: [], v: [] }; return c; })(),
        want: "無法判定",
      },
      {
        name: "注入⑪:缺一季 → 判「無法判定」",
        j: (() => { const c = cl(); c.quarters.p = c.quarters.p.slice(0, 3); c.quarters.v = c.quarters.v.slice(0, 3); return c; })(),
        want: "無法判定",
      },
      {
        name: "合法:部分欄位資料不全(rd 缺一季)但仍有欄位可驗且一致 → 一致,並列出無法驗的欄位",
        j: (() => { const c = cl(); c.quarters.v[2][2] = null; return c; })(),
        want: "一致",
      },
    ];
    for (const c of idCases) {
      const r = yearIdentity("TEST", c.j, 2020);
      const ok = r.verdict === c.want;
      if (!ok) fail++;
      console.log(`  ${ok ? "✓" : "✗"} ${c.name}`);
      if (!ok) console.log(`      實際判定 ${r.verdict}(可驗 ${r.checked.join(",") || "-"};無法驗 ${r.unverifiable.join(",") || "-"};破 ${r.broken.join(" | ") || "-"})`);
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
  allow.length
    ? `宣告可補值範圍:${describeAllowFill(allow)}`
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
const diag = [];
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
  /**
   * 判定:對【該年真的有覆寫】的宣告年驗 Σ四季 == 年度。
   * 「全換/全不換」的明細降級為診斷輸出(它印的「換了哪些/未換哪些」仍有價值,
   *  但它把「沒換是因為本來就對」誤判成漏了 —— 見 restateCompleteness 的說明)。
   */
  const changedPeriods = new Set(r.overwrite.map((x) => `${x.block}:${x.period}`));
  const touchedYears = new Set(r.overwrite.map((x) => yearOfPeriod(x.period)));
  const partial = [];
  for (const y of restate.get(t) ?? []) {
    if (!touchedYears.has(y)) continue;
    const id = yearIdentity(t, newJson, y);
    const c = restateCompleteness(t, BASE.get(t), newJson, y, changedPeriods);
    diag.push(
      `  ${t} ${y}  恆等式:${id.verdict}` +
        `(可驗 ${id.checked.join(",") || "-"};無法驗 ${id.unverifiable.join(",") || "-"})` +
        `　期別:${c.changed}/${c.total} 有覆寫(${c.changedList.join(", ") || "-"})`
    );
    if (id.verdict === "混基礎") partial.push(`${t} ${y} 混基礎:${id.broken.join(" | ")}`);
    else if (id.verdict === "無法判定") partial.push(`${t} ${y} 無法判定:沒有任何欄位可驗(缺年度或缺季別)`);
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

// 診斷:恆等式判定 + 舊啟發式的期別分布(後者不再作為判定,但明細有價值)
if (diag.length) {
  console.log(`\n── 診斷:宣告年的 Σ四季 == 年度,以及期別覆寫分布 ──`);
  for (const d of diag) console.log(d);
}

console.log(`\n── 只增不改判定 ──`);
if (bad.length === 0) {
  console.log(
    restate.size
      ? `  ✅ 既有非空格的改寫 ${restated.length} 格,全部落在宣告的 (檔,年) 內,` +
        `且每個被動到的宣告年【Σ四季 == 年度】(無混基礎、無「無法判定」)`
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
