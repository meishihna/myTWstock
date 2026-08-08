#!/usr/bin/env node
/**
 * check-financials-delivery.mjs —— 官方財務交付的【收貨檢查】
 *
 * 為什麼要有這支:2026-08-08 引擎交付了一批季度軸 sell/admin/rd 被「減兩次」的資料
 * (2330 2025Q2 研發費用 61,279.719 → 4,732.226,admin 變負)。
 * 引擎端 52 項 parity 全綠 —— 因為那 52 項都在比「兩邊算出來一不一樣」,
 * **沒有一項在問「這個數字合不合理」**。
 *
 * 🔴 設計原則:交付兩端各自【獨立】檢查,不信任交付方的報告。
 *    引擎端有 parity,消費端有這支;兩套是不同的程式,才構成真正的獨立。
 *
 * 用法
 *   node tests/check-financials-delivery.mjs            # 檢查 1、2、4(不連網)
 *   node tests/check-financials-delivery.mjs --spot     # 加做檢查 3(打 MOPS 原始頁,1 次請求)
 *   node tests/check-financials-delivery.mjs --self-test # 只跑注入測試(證明門檻是活的)
 *
 * 退出碼:0 = 硬檢查全過,1 = 有硬失敗,2 = 用法錯誤
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..");
const DATA = path.join(WEB, "public/data/financials");
const CONTRACT = path.join(WEB, "docs/financials-contract.md");

const fin = (v) => typeof v === "number" && Number.isFinite(v);

/* ══════════════════════════════════════════════════════════════════════════
 * 門檻 2%:由來(不要只留裸數字 —— 三個月後沒人記得為什麼是 2%)
 *
 * 檢查 2 量的是 |(毛利 − 營益) − (推銷 + 管理 + 研發)| ÷ 營收。
 *
 * ⚠️ 它【不是】等式檢查。`毛利 − 營益 = 營業費用`,而營業費用 ≠ 推銷+管理+研發 ——
 *    差額是「預期信用減損損失(利益)」等我們刻意不收的科目,**合法且雙向**。
 *    實測:兩者逐位相等只有 24.9%(年度軸 n=11,593)。
 *    → 拿它當等式門檻會在約 7 成的列上響,而【每次都響的假警報 = 沒有警報】。
 *
 * 為什麼是 2% 而不是 5%(2026-08-08 實測年度軸決定):
 *   「減兩次」造成的差額 ≈ 前一期的營業費用
 *   → **營業費用率低於門檻的公司,bug 再嚴重也不會響**。
 *   營業費用率分布:p5 = 4.13%、**p10 = 5.94%**、p25 = 10.02%、p50 = 16.34%
 *
 *   門檻   漏抓(營業費用率低於門檻)      誤報(乾淨資料上響)
 *    5%    1,135 列 (6.9%) ← 卡在 p10,放掉近一成市場
 *    3%      391 列 (2.4%)
 *    2%      128 列 (0.8%)              444 列 (3.8%)
 *
 *   選 2%:檢查 2 是【人工判讀,不是硬失敗】→ 偏向多報是正確的取捨。
 *
 * 🔴 兩個已知限制(第一次收到季度資料時必須回頭校準):
 *   ① 上述分布量自【年度軸】。季度單季金額小、比值會放大,季度軸門檻可能要不同。
 *   ② 極值來自小營收公司(分母崩掉,年度軸 p100 = 2,572% 營收)。
 *      若實測發現響的幾乎都是小營收股 → 改雙條件(比值【且】絕對金額都超標)。
 * ══════════════════════════════════════════════════════════════════════════ */
const MAGNITUDE_THRESHOLD_PCT = 2;

/* ══════════════════════════════════════════════════════════════════════════
 * 注入測試的永久夾具 —— 證明門檻【真的會響】
 *
 * 這是本專案的規矩:宣告一個檢查有效之前,注入它該抓的錯誤,必須抓到。
 * 不留紀錄的話,下次有人會以為它驗過了 —— 那正是壞交付的契約犯的錯
 * (它寫「已驗:Σ 四個單季 == Q4 累計,94,972 個 0 不符」,
 *  但那是 telescoping 恆等式,在單季與累計兩種假設下都成立,對口徑一個字都沒說)。
 *
 * 資料來源:2330 民國114年(2025)真實案例。
 *   `wrong` = 那批壞交付實際送來的值(我在還原前記錄下來的)
 *   `correct` = 監督者提供的 ground truth + 交叉核對還原:
 *       Q1+Q2         = 117,827.212 == 官方 114Q2 累計 ✓
 *       Q1+Q2+Q3      = 181,569.457 == 官方 Q3 累計   ✓
 *       四個單季相加   = 246,427.264 == 官方年度      ✓
 *
 * ⚠️ 還原時我曾自己踩過一次:用「錯誤值累加」推正確單季,在 Q1–Q3 成立,
 *    但 Q4 那格的快取存的是【全年累計】,累加法到它就斷。
 *    我發現「四單季相加 ≠ 年度」後,把 Q2/Q3 也一起退掉 —— **歸因歸多了兩格**。
 *    教訓:自我否定也要有證據,否則會丟掉有效的證據。
 *    正確 Q4 單季 = 年度 − Q3累計 = 246,427.264 − 181,569.457 = 64,857.807。
 * ══════════════════════════════════════════════════════════════════════════ */
const INJECTION_FIXTURE = {
  code: "2330",
  note: "2025 年季度 sell/admin/rd 的(正確, 錯誤)配對;錯誤 = 單季被當累計再減一次",
  quarters: {
    // [sell, admin, rd]
    "2025Q2": { correct: [4273.247, 18955.373, 61279.719], wrong: [518.432, -5928.375, 4732.226] },
    "2025Q3": { correct: [3973.966, 20048.234, 63742.245], wrong: [-299.281, 1092.861, 2462.526] },
    // Q4 的 sell/admin 正確值尚無 ground truth,只放 rd 供符號/量級參考,不列入斷言
    "2025Q4": { correct: null, wrong: [12944.11, 62256.056, 182685.019], rdCorrect: 64857.807 },
  },
};

/**
 * 抽格對官方原始頁面的靶(檢查 3)。
 * 用【官方頁面】當裁判,不是拿引擎的數字對引擎的數字 —— 否則就閉環了。
 *
 * 靶選【年度】而非季度,因為年度值在交付檔裡直接存在、可自動比對成斷言;
 * 季度單季要再減前一期累計,多一層自己的算術會削弱「獨立裁判」的性質。
 *
 * ✅ 已對 MOPS 實跑驗證(2026-08-08,不是等交付日才第一次跑):
 *      POST ajax_t164sb04  co_id=2330 year=114 season=4  → http=200 · 22,585 bytes · utf-8
 *      頁面片段:「研究發展費用| 246,427,264 | 6.47 | 204,181,823 | 7.05 |　營業費用合計」
 *      取第一個數字 246,427,264 仟元 = 246,427.264 百萬 == 交付檔年度 rd ✓
 *    版面特徵:同列先給【本期】再給【去年同期】,故一律取第一個數字。
 */
const SPOT = {
  code: "2330", rocYear: 114, season: 4,
  block: "annual", period: "2025", field: "rd",
  label: "研究發展費用(年度 = 第4季累計)",
};

/* ══════════════════════════════════════════════════════════════════════════ */

function loadAll() {
  if (!fs.existsSync(DATA)) throw new Error(`找不到 ${DATA}`);
  const out = [];
  for (const f of fs.readdirSync(DATA)) {
    if (!/^\d{4}\.json$/.test(f)) continue;
    const j = JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));
    const ix = {};
    (j.fields ?? []).forEach((k, i) => (ix[k] = i));
    out.push({ code: f.slice(0, 4), j, ix });
  }
  return out;
}

/**
 * 從交付的契約文件抓 capex 正值白名單。
 * 🔴 一律以【交付物】為準,不用記憶中的數字 —— 記憶會過期,交付物不會。
 * 抓不到 → 回 null,呼叫端必須把「白名單未知」當成需要人工確認,不可當成空白名單。
 */
function capexWhitelistFromContract() {
  if (!fs.existsSync(CONTRACT)) return null;
  const s = fs.readFileSync(CONTRACT, "utf8");
  const hits = [...s.matchAll(/(\d{4})\s*民國\s*(\d{2,3})(?:Q(\d))?\s*=\s*\+?([\d.]+)/g)];
  if (!hits.length) return null;
  return hits.map((m) => ({ code: m[1], roc: m[2], q: m[3] ?? null, value: Number(m[4]) }));
}

/** 檢查 1:符號 —— 硬失敗 */
function checkSigns(all, capexWl) {
  const negExpense = [];
  const posCapex = [];
  for (const { code, j, ix } of all) {
    for (const [tag, blk] of [["年", j.annual], ["季", j.quarters]]) {
      if (!blk?.v) continue;
      for (let r = 0; r < blk.v.length; r++) {
        const row = blk.v[r];
        for (const k of ["sell", "admin", "rd"]) {
          const v = ix[k] == null ? null : row[ix[k]];
          if (fin(v) && v < 0) negExpense.push({ code, period: tag + blk.p[r], field: k, value: v });
        }
        const cv = ix.capex == null ? null : row[ix.capex];
        if (fin(cv) && cv > 0) posCapex.push({ code, period: tag + blk.p[r], value: cv });
      }
    }
  }
  return { negExpense, posCapex, capexWl };
}

/** 檢查 2:量級 —— 只列出,人工判讀 */
function checkMagnitude(all) {
  const hits = [];
  let scanned = 0;
  for (const { code, j, ix } of all) {
    for (const [tag, blk] of [["年", j.annual], ["季", j.quarters]]) {
      if (!blk?.v) continue;
      for (let r = 0; r < blk.v.length; r++) {
        const row = blk.v[r];
        const gp = row[ix.gp], op = row[ix.op], rev = row[ix.rev];
        if (!fin(gp) || !fin(op) || !fin(rev) || rev <= 0) continue;
        const parts = ["sell", "admin", "rd"].map((k) => (ix[k] == null ? null : row[ix[k]]));
        if (!parts.some(fin)) continue;
        scanned++;
        const sum = parts.reduce((a, b) => a + (fin(b) ? b : 0), 0);
        const pct = (Math.abs(gp - op - sum) / rev) * 100;
        if (pct > MAGNITUDE_THRESHOLD_PCT) {
          hits.push({ code, period: tag + blk.p[r], pct: +pct.toFixed(2), rev: +rev.toFixed(1) });
        }
      }
    }
  }
  return { hits, scanned };
}

/**
 * 注入測試:把已知的錯誤值套進門檻,必須響;正確值必須靜。
 * 用該季【真實的 rev/gp/op】(那三欄從未出錯),只替換 sell/admin/rd。
 */
function runInjection(all) {
  const t = all.find((x) => x.code === INJECTION_FIXTURE.code);
  if (!t) return { ok: false, reason: `找不到 ${INJECTION_FIXTURE.code}.json` };
  const { j, ix } = t;
  const rows = [];
  let ok = true;
  for (const [q, pair] of Object.entries(INJECTION_FIXTURE.quarters)) {
    const i = j.quarters.p.indexOf(q);
    if (i < 0) { rows.push({ q, skip: "該期別不在交付檔內" }); continue; }
    const r = j.quarters.v[i];
    const gp = r[ix.gp], op = r[ix.op], rev = r[ix.rev];
    if (!fin(gp) || !fin(op) || !fin(rev) || rev <= 0) { rows.push({ q, skip: "rev/gp/op 缺" }); continue; }
    const pctOf = (arr) => (Math.abs(gp - op - arr.reduce((a, b) => a + b, 0)) / rev) * 100;
    const wrongPct = pctOf(pair.wrong);
    const wrongFires = wrongPct > MAGNITUDE_THRESHOLD_PCT;
    const row = { q, wrongPct: +wrongPct.toFixed(2), wrongFires };
    if (pair.correct) {
      const correctPct = pctOf(pair.correct);
      row.correctPct = +correctPct.toFixed(2);
      row.correctSilent = correctPct <= MAGNITUDE_THRESHOLD_PCT;
      if (!row.correctSilent) ok = false;
    } else {
      row.correctPct = null;
      row.correctSilent = null; // Q4 無 ground truth,不列入斷言
    }
    if (!wrongFires) ok = false;
    // 符號檢查也要在注入資料上證明會抓到(壞交付的 admin/sell 有負值)
    row.wrongHasNegative = pair.wrong.some((v) => v < 0);
    rows.push(row);
  }
  return { ok, rows };
}

/** 檢查 3:抽格對 MOPS 原始頁面(opt-in,1 次請求) */
async function spotCheck() {
  const body = new URLSearchParams({
    encodeURIComponent: "1", step: "1", firstin: "1", off: "1",
    queryName: "co_id", inpuType: "co_id", TYPEK: "all", isnew: "false",
    co_id: SPOT.code, year: String(SPOT.rocYear), season: String(SPOT.season),
  });
  const r = await fetch("https://mopsov.twse.com.tw/mops/web/ajax_t164sb04", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (compatible; TWstock/1.0; +https://github.com/meishihna/twstock-web)",
    },
    body,
  });
  if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
  const buf = Buffer.from(await r.arrayBuffer());
  let html = buf.toString("utf8");
  if (!/研究發展費用/.test(html)) html = new TextDecoder("big5").decode(buf);
  const i = html.indexOf("研究發展費用");
  if (i < 0) return { ok: false, reason: "頁面中找不到「研究發展費用」(版面可能改了)" };
  const seg = html.slice(i, i + 400).replace(/<[^>]+>/g, "|");
  const nums = seg.match(/[\d,]{4,}/g);
  if (!nums?.length) return { ok: false, reason: "找到科目名但取不到數字(版面可能改了)" };
  // 同列先本期、後去年同期 → 取第一個
  return { ok: true, value: Number(nums[0].replace(/,/g, "")) / 1000, raw: nums[0] };
}

/* ══════════════════════════════════════════════════════════════════════════ */
const argv = process.argv.slice(2);
const SELF_TEST_ONLY = argv.includes("--self-test");
const DO_SPOT = argv.includes("--spot");

const all = loadAll();
const inj = runInjection(all);

console.log(`收貨檢查 · ${all.length} 檔 · 量級門檻 ${MAGNITUDE_THRESHOLD_PCT}%\n`);

console.log("── 注入測試(證明門檻是活的)──");
for (const r of inj.rows) {
  if (r.skip) { console.log(`  ${r.q}  跳過:${r.skip}`); continue; }
  const c = r.correctPct == null ? "(無 ground truth)" : `${r.correctPct}% ${r.correctSilent ? "靜 ✓" : "響 ✗"}`;
  console.log(`  ${r.q}  正確值→ ${c}   錯誤值→ ${r.wrongPct}% ${r.wrongFires ? "響 ✓" : "靜 ✗"}   錯誤值含負數:${r.wrongHasNegative}`);
}
console.log(`  判定:${inj.ok ? "PASS(錯誤值必響、正確值必靜)" : "FAIL —— 門檻抓不到已知錯誤,不可信任它的『0』"}\n`);

if (SELF_TEST_ONLY) process.exit(inj.ok ? 0 : 1);

let hardFail = !inj.ok;

console.log("── 檢查 1:符號(硬失敗)──");
const wl = capexWhitelistFromContract();
const sg = checkSigns(all, wl);
console.log(`  sell/admin/rd 為負:${sg.negExpense.length} 格`);
for (const x of sg.negExpense) console.log(`      ${x.code} ${x.period} ${x.field} = ${x.value}`);
/**
 * 3518 協調(監督者 2026-08-08 指示):
 *   線上既有資料裡本來就有 1 格 —— 3518 年2019 sell = −20.219。
 *   已請引擎核原始 HTML:官方是負的 → 進【有證據的例外白名單】;是正的 → 引擎修。
 *   規則:只在 3518 響 → 查新契約白名單,有就放行、沒有就問監督者;
 *        其他格也響 → 新問題,硬失敗。
 */
const KNOWN_PENDING = new Set(["3518"]);
const unexpectedNeg = sg.negExpense.filter((x) => !KNOWN_PENDING.has(x.code));
if (sg.negExpense.length && !unexpectedNeg.length) {
  console.log("  ⚠️ 只在待確認清單(3518)上響 → 查新契約是否已帶白名單;沒有就問監督者,不要自行放行");
} else if (unexpectedNeg.length) {
  console.log(`  ❌ 硬失敗:${unexpectedNeg.length} 格在待確認清單【之外】為負`);
  hardFail = true;
}
console.log(`  capex 為正:${sg.posCapex.length} 格 · 契約白名單:${wl ? `${wl.length} 筆` : "【抓不到 —— 需人工確認,不可當成空白名單】"}`);
console.log();

console.log(`── 檢查 2:量級 > ${MAGNITUDE_THRESHOLD_PCT}% 營收(列出,人工判讀,非硬失敗)──`);
const mg = checkMagnitude(all);
console.log(`  掃 ${mg.scanned} 列 → ${mg.hits.length} 列超標 (${((mg.hits.length / Math.max(1, mg.scanned)) * 100).toFixed(2)}%)`);
for (const h of mg.hits.slice(0, 15)) console.log(`      ${h.code} ${h.period}  ${h.pct}% 營收(rev=${h.rev})`);
if (mg.hits.length > 15) console.log(`      …其餘 ${mg.hits.length - 15} 列`);
console.log();

console.log("── 檢查 3:抽格對 MOPS 原始頁面 ──");
if (DO_SPOT) {
  const s = await spotCheck();
  if (!s.ok) { console.log(`  ❌ 取不到:${s.reason}`); hardFail = true; }
  else {
    // 與【交付檔】的同一格比對 —— 官方頁面是裁判,交付檔是被告
    const t = all.find((x) => x.code === SPOT.code);
    const blk = t?.j?.[SPOT.block];
    const pi = blk?.p?.indexOf(SPOT.period) ?? -1;
    const delivered = pi >= 0 && t.ix[SPOT.field] != null ? blk.v[pi][t.ix[SPOT.field]] : null;
    const match = fin(delivered) && Math.abs(delivered - s.value) < 0.001;
    console.log(`  ${SPOT.code} 民國${SPOT.rocYear} ${SPOT.label}`);
    console.log(`    官方頁面 = ${s.raw} 仟元 = ${s.value} 百萬`);
    console.log(`    交付檔   = ${delivered}`);
    console.log(`    → ${match ? "逐位相符 ✓" : "❌ 不符 —— 交付資料與官方頁面對不上"}`);
    if (!match) hardFail = true;
  }
} else {
  // 🔴 不可靜默跳過:沒跑就是「未執行」,不是「通過」
  console.log("  ⚠️ 【未執行】(需 --spot)。這是最權威的一把尺,交付到貨時務必跑一次。");
}
console.log();

console.log("── 檢查 4:逐檔對照 ──");
console.log("  由 tests/compare-financials-migration.ts 負責(逐 key 比較,不聚合):");
console.log("    npx tsx tests/compare-financials-migration.ts --mode adapter --out after.json");
console.log("    npx tsx tests/compare-financials-migration.ts --compare before.json after.json");
console.log();

console.log(hardFail ? "❌ 有硬失敗" : "✅ 硬檢查全過(檢查 2 的列表仍需人工判讀)");
process.exit(hardFail ? 1 : 0);
