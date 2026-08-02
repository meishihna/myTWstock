#!/usr/bin/env node
/**
 * 現場回測對帳 —— 驗證「瀏覽器現場算」與資料端預先算好的 signals/{code}.json 逐格相同。
 *
 * 為什麼要進版控:S2 的「0 差」是整條線的信任基礎。若腳本與輸入只存在於一次性執行裡,
 * 日後改了 backtest.mjs / twsebars.mjs 就無法複驗,等同沒有測試。
 *
 * 設計要點
 *  - 刻意 import【實際會上線的模組】(twsebars / backtest / chipsbits),不用複製品,
 *    否則測到的不是會出貨的那份程式碼。
 *  - 預設【離線】:讀 tests/fixtures/bars/{code}.json,並注入一個會拋錯的 fetch,
 *    任何一次網路存取都會讓測試失敗 → 保證離線可重跑、且不騷擾官方端點。
 *    (每跑一次全量 = 183 次官方請求,不禮貌也不可靠。)
 *
 * 用法
 *   node tests/reconcile-live.mjs              # 離線,用夾具(預設;CI 可用)
 *   node tests/reconcile-live.mjs 2330         # 只跑單檔
 *   node tests/reconcile-live.mjs --live       # 真的打官方端點(節流 350ms,約 20 秒/檔)
 *   node tests/reconcile-live.mjs --record     # 打官方端點並【更新夾具】(資料端換 asof 後才需要)
 *
 * 退出碼:0 = 全部 PASS,1 = 有任一項不符
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..");
const S = (p) => pathToFileURL(path.join(WEB, p)).href;

const { fetchRawBars, monthKeys, fetchMonth } = await import(S("public/scripts/twsebars.mjs"));
const { runBacktest } = await import(S("public/scripts/backtest.mjs"));
const { makeConfirm } = await import(S("public/scripts/chipsbits.mjs"));

const readJson = (p) => JSON.parse(fs.readFileSync(path.join(WEB, p), "utf8"));
const idx = readJson("public/data/signals-index.json");
const exAll = readJson("public/data/ex-factors.json");
const bits = readJson("public/data/chips-bits.json");

const ASOF = idx.window.asof;
const MONTHS = idx.window.months;

const argv = process.argv.slice(2);
const LIVE = argv.includes("--live") || argv.includes("--record");
const RECORD = argv.includes("--record");
const only = argv.filter((a) => /^\d{4}$/.test(a));
const CODES = only.length ? only : ["2330", "2327", "2317"];

const FIX = (code) => path.join(HERE, "fixtures", "bars", `${code}.json`);

/** 離線模式注入:任何網路存取都視為測試失敗 */
const noNetwork = () => {
  throw new Error("離線模式不應發生網路存取(夾具缺月份?)");
};

const eq = (a, b) => (a === null || b === null ? a === b : Object.is(a, b));

async function loadBars(code) {
  if (!LIVE) {
    if (!fs.existsSync(FIX(code))) throw new Error(`缺夾具 ${FIX(code)},請先 --record`);
    const fx = JSON.parse(fs.readFileSync(FIX(code), "utf8"));
    if (fx.asof !== ASOF || fx.months !== MONTHS) {
      throw new Error(`夾具視窗 ${fx.asof}/${fx.months} 與 index ${ASOF}/${MONTHS} 不符,請 --record 重錄`);
    }
    // 先驗夾具完整性,否則缺月份會在下游變成誤導的 "fetch_failed:YYYYMM"
    const missing = monthKeys(ASOF, MONTHS).filter((ym) => !fx.data[ym]);
    if (missing.length) {
      throw new Error(
        `夾具 ${code} 缺 ${missing.length} 個月(${missing.slice(0, 3).join(",")}…),離線無法重跑;請 --record 重錄`,
      );
    }
    // 走真正的 fetchRawBars,只是每個月都從夾具命中;fetchImpl 保證不會被呼叫
    return fetchRawBars(code, {
      asof: ASOF, months: MONTHS, gapMs: 0,
      getCached: async (ym) => fx.data[ym] ?? null,
      fetchImpl: noNetwork,
      // 當月不走快取是線上行為;離線測試需覆寫,否則會嘗試連網
      alwaysUseCache: true,
    });
  }
  const rec = {};
  const out = await fetchRawBars(code, {
    asof: ASOF, months: MONTHS, gapMs: 350,
    putCached: async (ym, b) => { rec[ym] = b; },
    onProgress: ({ done, total }) => {
      if (done % 20 === 0 || done === total) process.stderr.write(`    抓取 ${done}/${total}\n`);
    },
  });
  if (RECORD) {
    // 當月不進 putCached,補寫
    const yms = monthKeys(ASOF, MONTHS);
    for (const ym of yms) if (!rec[ym]) rec[ym] = await fetchMonth(code, ym);
    fs.mkdirSync(path.dirname(FIX(code)), { recursive: true });
    fs.writeFileSync(FIX(code), JSON.stringify({
      schema: "live-backtest-fixture/1", code, asof: ASOF, months: MONTHS,
      note: "原始未還原 STOCK_DAY 日K(已解析);供 reconcile-live.mjs 離線重跑,不需打官方端點",
      data: rec,
    }));
    process.stderr.write(`    已更新夾具 ${FIX(code)}\n`);
  }
  return out;
}

function reconcile(code, out) {
  const ref = readJson(`public/data/signals/${code}.json`);
  const refStock = idx.stocks.find((s) => s.code === code);
  const samples = [];
  let sCells = 0, sDiff = 0, tCells = 0, tDiff = 0;

  const comboMatch = out.combos.length === ref.combos.length;
  const n = Math.min(out.combos.length, ref.combos.length);
  for (let i = 0; i < n; i++) {
    const a = out.combos[i], b = ref.combos[i];
    for (let k = 0; k < b.s.length; k++) {
      sCells++;
      if (!eq(a.s[k], b.s[k])) {
        sDiff++;
        if (samples.length < 5) samples.push(`combo#${i} s[${k}] 現場=${a.s[k]} 參考=${b.s[k]}`);
      }
    }
    if (a.t.length !== b.t.length) {
      tDiff++;
      if (samples.length < 5) samples.push(`combo#${i} 逐筆數 現場=${a.t.length} 參考=${b.t.length}`);
    }
    const tn = Math.min(a.t.length, b.t.length);
    for (let j = 0; j < tn; j++) {
      for (let k = 0; k < b.t[j].length; k++) {
        tCells++;
        if (!eq(a.t[j][k], b.t[j][k])) {
          tDiff++;
          if (samples.length < 5) samples.push(`combo#${i} t[${j}][${k}] 現場=${a.t[j][k]} 參考=${b.t[j][k]}`);
        }
      }
    }
  }

  const bhDiff = [];
  for (const k of Object.keys(refStock.buyhold)) {
    if (!eq(out.buyhold[k], refStock.buyhold[k])) {
      bhDiff.push(`${k}: 現場=${out.buyhold[k]} 參考=${refStock.buyhold[k]}`);
    }
  }

  // 權益累乘抽驗:∏(1+r/100) 應等於 總報酬%
  const Ri = out.meta.tradeFields.indexOf("r");
  const Ti = out.meta.comboFields.indexOf("總報酬%");
  const wt = out.combos.find((c) => c.t.length > 0);
  let equity = null;
  if (wt) {
    let e = 1;
    for (const t of wt.t) e *= 1 + t[Ri] / 100;
    const derived = (e - 1) * 100;
    equity = { 累乘: +derived.toFixed(6), 引擎: wt.s[Ti], 筆數: wt.t.length, 誤差pp: +Math.abs(derived - wt.s[Ti]).toFixed(6) };
  }

  const pass = comboMatch && sDiff === 0 && tDiff === 0 && bhDiff.length === 0;
  return { comboMatch, sCells, sDiff, tCells, tDiff, bhDiff, equity, samples, pass, refStock };
}

let allPass = true;
const rows = [];
for (const code of CODES) {
  process.stderr.write(`  ${code} …\n`);
  const { bars, stats } = await loadBars(code);
  const exEvents = (exAll.events[code] || []).map(([date, ratio]) => ({ date, ratio }));
  const confirm = makeConfirm(bits, code, bars.map((b) => b.d));
  const t0 = Date.now();
  const out = runBacktest(bars, { exEvents, ...(confirm ? { confirm } : {}) });
  const calcMs = Date.now() - t0;
  const r = reconcile(code, out);
  if (!r.pass) allPass = false;
  rows.push({
    code,
    模式: LIVE ? (RECORD ? "live+record" : "live") : "offline(夾具)",
    K棒: `${bars.length} / ${r.refStock["交易日數"]}`,
    組合: `${out.combos.length} / ${r.refStock.combos}`,
    統計: `${r.sCells} 格 → ${r.sDiff} 不符`,
    逐筆: `${r.tCells} 格 → ${r.tDiff} 不符`,
    buyhold: r.bhDiff.length ? r.bhDiff : "0 不符",
    覆蓋: confirm ? `${confirm.series.covered}/${bars.length}(位元圖 asof ${bits.asof})` : "無位元圖 → 僅 90 組",
    權益抽驗: r.equity,
    網路: LIVE ? `${stats.networkCalls} 次(重試 ${stats.retried})` : "0 次 ✅",
    運算ms: calcMs,
    判定: r.pass ? "PASS ✅" : "FAIL ❌",
    ...(r.samples.length ? { 不符樣本: r.samples } : {}),
  });
}

console.log(JSON.stringify({
  視窗: { asof: ASOF, months: MONTHS },
  結果: rows,
  總判定: allPass ? "全部 PASS ✅ 逐格 0 差" : "有不符 ❌",
}, null, 1));

process.exit(allPass ? 0 : 1);
