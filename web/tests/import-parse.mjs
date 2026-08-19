#!/usr/bin/env node
/**
 * 貼上匯入解析器的注入測試 —— 全部用【合成資料】,不讀使用者的任何檔案
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 每一條「期望失敗」的檢查,都必須有一條「期望成功」的對照。
 *    否則「擋下來了」與「根本沒跑起來」無法區分 —— 這與 RLS 自測的
 *    `attack 0 + control 0` 是同一條原則,只是換到解析器上。
 *
 * 🔴 夾具必須【算術自洽】。若合成資料自己就對不上 Cash_Impact 恆等式,
 *    那條檢查在「合法」案例上就會紅,注入案例便毫無意義 ——
 *    夾具不自洽,恆等式測不到東西。
 *    下方 BASE 的 Running_Cash 是逐列累加算出來的,不是手打的。
 *
 * 用法:npx tsx tests/import-parse.mjs
 * ══════════════════════════════════════════════════════════════════════════
 */
import {
  parsePaste,
  normalizeNumber,
  normalizeDate,
  findDuplicates,
  splitLine,
} from "../src/lib/importParse.ts";

let pass = 0;
const fails = [];
const check = (ok, name, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(name);
    console.log(`  ✗ ${name}   ${detail}`);
  }
};

/* ══════════════════════════════════════════════════════════════════════
 * 夾具:模仿真實來源的形狀,但數字全是編的
 * ══════════════════════════════════════════════════════════════════════ */

const HEADERS = [
  "Date", "Ticker", "Action", "Quantity", "Price", "Currency", "Ticker_Clean",
  "Signed_Qty", "Buy_Amount", "Sell_Amount", "Fee", "Tax", "Cash_Impact",
  "Running_Cash", "Notes",
];

/** 每一列的語意來源;Cash_Impact 與 Running_Cash 由下方【算出來】,不手打 */
const BASE_ROWS = [
  { date: "2024-01-02", action: "DEPOSIT", amount: 1000000, notes: "" },
  { date: "2024-01-15", action: "BUY",  ticker: "2330", qty: 1000, price: 600, fee: 855,  tax: 0,    notes: "純粹爽" },
  { date: "2024-02-01", action: "BUY",  ticker: "2317", qty: 2000, price: 100, fee: 285,  tax: 0,    notes: "" },
  { date: "2024-03-10", action: "SELL", ticker: "2330", qty: 500,  price: 700, fee: 498,  tax: 1050, notes: "知道錯了" },
  { date: "2024-04-01", action: "DEPOSIT", amount: 100000, notes: "" },
];

function cashImpactOf(r) {
  if (r.action === "DEPOSIT") return r.amount;
  const gross = r.qty * r.price;
  return r.action === "BUY" ? -(gross + r.fee) : gross - r.fee - r.tax;
}

/** rows → TSV 字串。`mutate(cells, i)` 可就地改某一列,用來注入。 */
function toTsv(rows = BASE_ROWS, { mutate, headers = HEADERS, dropCols = [] } = {}) {
  let running = 0;
  const out = [headers.join("\t")];
  rows.forEach((r, i) => {
    const ci = cashImpactOf(r);
    running += ci;
    const cells = {
      Date: r.date,
      Ticker: r.ticker ?? "",
      Action: r.action,
      Quantity: r.qty ?? "",
      Price: r.price ?? "",
      Currency: r.action === "DEPOSIT" ? "" : "TWD",
      Ticker_Clean: r.ticker ?? "",
      Signed_Qty: r.action === "BUY" ? r.qty : r.action === "SELL" ? -r.qty : "",
      Buy_Amount: r.action === "BUY" ? r.qty * r.price : "",
      Sell_Amount: r.action === "SELL" ? r.qty * r.price : "",
      Fee: r.fee ?? "",
      Tax: r.tax ?? "",
      Cash_Impact: ci,
      Running_Cash: running,
      Notes: r.notes ?? "",
    };
    if (mutate) mutate(cells, i);
    out.push(headers.filter((h) => !dropCols.includes(h)).map((h) => String(cells[h] ?? "")).join("\t"));
  });
  return out.join("\n");
}

/* ══════════════════════════════════════════════════════════════════════
 * 一、對照組:合法輸入必須靜(否則所有注入都是空砲)
 * ══════════════════════════════════════════════════════════════════════ */
console.log("── 對照組:合法輸入 ──");
{
  const r = parsePaste(toTsv());
  check(r.ok === true, "合法輸入 → ok", JSON.stringify(r.problems));
  check(r.problems.length === 0, "0 個問題", JSON.stringify(r.problems));
  check(r.sourceRowCount === 5, "來源列數 5", String(r.sourceRowCount));
  check(r.trades.length === 3, "交易 3 筆(BUY 2 + SELL 1)", String(r.trades.length));
  check(r.cashFlows.length === 2, "現金流 2 筆(DEPOSIT)", String(r.cashFlows.length));
  check(
    r.actionCounts.BUY === 2 && r.actionCounts.SELL === 1 && r.actionCounts.DEPOSIT === 2,
    "Action 分布 BUY 2 / SELL 1 / DEPOSIT 2",
    JSON.stringify(r.actionCounts)
  );
  const ident = r.checks.find((c) => c.name.startsWith("每列"));
  const run = r.checks.find((c) => c.name.startsWith("Σ"));
  check(ident.status === "pass", "🔴 對照:來源自己的每列恆等式必須【通過】", JSON.stringify(ident));
  check(run.status === "pass", "🔴 對照:Σ Cash_Impact == Running_Cash 必須【通過】", JSON.stringify(run));
  check(ident.maxDeviation === 0, "最大偏差 0(容差沒有在掩護誤差)", String(ident.maxDeviation));

  /* DEPOSIT 走現金流、不進 trades —— 「41 列 → 39 交易 + 2 現金流」才是對的 */
  check(r.cashFlows[0].kind === "deposit" && r.cashFlows[0].amount.raw === "1000000", "DEPOSIT → deposit / 金額取 Cash_Impact", JSON.stringify(r.cashFlows[0]));
  check(r.cashFlows.every((c) => c.ticker === null), "DEPOSIT 的 ticker 為 null", "");
  check(r.trades[2].side === "sell" && r.trades[2].tax.raw === "1050", "SELL 的稅逐字帶入", JSON.stringify(r.trades[2].tax));
  check(r.trades[0].seq === 2 && r.trades[1].seq === 3, "seq = 來源列號(單調遞增,FIFO 無平手)", `${r.trades[0].seq},${r.trades[1].seq}`);
}

/* ══════════════════════════════════════════════════════════════════════
 * 二、Action 白名單:不認得就具名拒絕,不猜
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n── Action 白名單 ──");
for (const act of ["DIVIDEND", "轉帳", "buy ", ""]) {
  const tsv = toTsv(BASE_ROWS, { mutate: (c, i) => { if (i === 1) c.Action = act; } });
  const r = parsePaste(tsv);
  if (act === "buy ") {
    /* 大小寫與前後空白是格式,不是語意 —— 應正常接受 */
    check(r.ok === true && r.trades.length === 3, "對照:「buy 」(小寫+空白)應正常接受,不算未知", JSON.stringify(r.problems));
    continue;
  }
  const p = r.problems.find((x) => x.column === "Action");
  check(
    r.ok === false && !!p && p.rowNo === 2 && p.raw === act,
    `注入:未知 Action「${act || "(空白)"}」→ 具名拒絕(列號 + 原文)`,
    JSON.stringify(r.problems)
  );
}

/* ══════════════════════════════════════════════════════════════════════
 * 三、🔴 缺值不補 0 —— 但來源寫的 0 是值
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n── 費用/稅:缺席 vs 零 ──");
{
  const blankFee = parsePaste(toTsv(BASE_ROWS, { mutate: (c, i) => { if (i === 1) c.Fee = ""; } }));
  const p = blankFee.problems.find((x) => x.column === "Fee");
  check(blankFee.ok === false && !!p, "注入:Fee 空白 → 拒絕(不是補 0)", JSON.stringify(blankFee.problems));
  check(blankFee.trades.every((t) => t.rowNo !== 2), "🔴 被拒的那一列【不得】出現在 trades 裡", "");

  const blankTax = parsePaste(toTsv(BASE_ROWS, { mutate: (c, i) => { if (i === 1) c.Tax = ""; } }));
  check(blankTax.ok === false && !!blankTax.problems.find((x) => x.column === "Tax"), "注入:Tax 空白 → 拒絕", "");

  /* 🔴 對照:買進的 Tax 就是來源寫的 0 —— 必須照收,否則整批合法資料都會被擋 */
  const r = parsePaste(toTsv());
  check(r.trades[0].tax.raw === "0" && r.trades[0].tax.num === 0, "🔴 對照:來源寫的 0 是【值】,照收不拒絕", JSON.stringify(r.trades[0].tax));

  const negFee = parsePaste(toTsv(BASE_ROWS, { mutate: (c, i) => { if (i === 1) c.Fee = -855; } }));
  check(negFee.ok === false && !!negFee.problems.find((x) => x.column === "Fee"), "注入:Fee 為負 → 拒絕(DB 的 check 也會擋,但要先在瀏覽器講清楚)", "");
}

/* ══════════════════════════════════════════════════════════════════════
 * 四、🔴 欄位對應:表頭名稱,不是位置索引
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n── 欄位對應 ──");
{
  /* 對照:中間插入一個不認識的欄位,靠名稱對應應完全不受影響 */
  const withExtra = HEADERS.slice();
  withExtra.splice(3, 0, "SomeNewColumn");
  const tsv = toTsv(BASE_ROWS, { headers: withExtra });
  const r = parsePaste(tsv);
  check(r.ok === true && r.trades.length === 3, "🔴 對照:來源中間多一欄 → 靠表頭名稱對應,不受影響", JSON.stringify(r.problems));

  /* 注入:必要欄位被改名 → 整批拒絕(不是靜默略過那一欄) */
  const renamed = HEADERS.map((h) => (h === "Fee" ? "Commission" : h));
  const r2 = parsePaste(toTsv(BASE_ROWS, { headers: renamed }));
  check(
    r2.ok === false && r2.problems.length === 1 && r2.problems[0].reason.includes("Fee"),
    "注入:必要欄位改名 → 整批拒絕並指名缺哪一欄",
    JSON.stringify(r2.problems)
  );
  check(r2.trades.length === 0 && r2.cashFlows.length === 0, "整批拒絕時不得產出任何一列", "");

  /* 🔴 注入:Fee 與 Tax 的【值】整欄互換 —— 這是真實的錯位形狀。
     來源自己的算術必須抓到:買進 CI 應為 −(gross+855) 而錯位後 Fee 變成 0。 */
  const swapped = toTsv(BASE_ROWS, {
    mutate: (c) => { const f = c.Fee; c.Fee = c.Tax; c.Tax = f; },
  });
  const r3 = parsePaste(swapped);
  const ident3 = r3.checks.find((x) => x.name.startsWith("每列"));
  check(ident3.status === "fail", "🔴 注入:Fee/Tax 整欄錯位 → 來源自己的恆等式必須【失敗】", JSON.stringify(ident3));
  check(ident3.maxDeviation > 0.01, "錯位的偏差要大於容差(容差沒把錯誤蓋掉)", String(ident3.maxDeviation));
}

/* ══════════════════════════════════════════════════════════════════════
 * 五、交叉檢查的鑑別力
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n── 交叉檢查 ──");
{
  /* 注入:單獨改一列的 Cash_Impact */
  const r = parsePaste(toTsv(BASE_ROWS, { mutate: (c, i) => { if (i === 3) c.Cash_Impact = Number(c.Cash_Impact) + 7; } }));
  const ident = r.checks.find((x) => x.name.startsWith("每列"));
  check(ident.status === "fail" && Math.abs(ident.maxDeviation - 7) < 1e-6, "注入:某列 Cash_Impact 偏 7 元 → 每列恆等式失敗且偏差 = 7", JSON.stringify(ident));

  /* 注入:Running_Cash 尾值被改 → 累計恆等式失敗 */
  const r2 = parsePaste(toTsv(BASE_ROWS, { mutate: (c, i) => { if (i === 4) c.Running_Cash = Number(c.Running_Cash) + 100; } }));
  const run2 = r2.checks.find((x) => x.name.startsWith("Σ"));
  check(run2.status === "fail", "注入:尾列 Running_Cash 被改 → Σ 恆等式失敗", JSON.stringify(run2));

  /* 🔴 缺 Running_Cash 欄 → 必須是 unknown,【不是 pass】 */
  const r3 = parsePaste(toTsv(BASE_ROWS, { dropCols: ["Running_Cash"], headers: HEADERS.filter((h) => h !== "Running_Cash") }));
  const run3 = r3.checks.find((x) => x.name.startsWith("Σ"));
  check(run3.status === "unknown" && !!run3.need, "🔴 沒有 Running_Cash 欄 → 判【無法驗】而非通過,並說明要什麼", JSON.stringify(run3));
  check(r3.ok === true, "對照:Running_Cash 是選填,缺它不影響匯入本身", JSON.stringify(r3.problems));

  /* 只有 DEPOSIT 時,每列恆等式無從驗 */
  const onlyDep = parsePaste(toTsv([BASE_ROWS[0]]));
  const identD = onlyDep.checks.find((x) => x.name.startsWith("每列"));
  check(identD.status === "unknown" && !!identD.need, "🔴 沒有任何 BUY/SELL → 每列恆等式判無法驗,不是通過", JSON.stringify(identD));
}

/* ══════════════════════════════════════════════════════════════════════
 * 六、現金流的符號慣例(出金方向:真實資料沒有,只能在合成資料裡驗)
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n── 現金流符號 ──");
{
  const r = parsePaste(toTsv([{ date: "2024-05-01", action: "DEPOSIT", amount: -50000, notes: "" }]));
  check(r.cashFlows[0]?.kind === "withdraw", "🔴 負的 Cash_Impact → withdraw(出金方向【只有這裡驗得到】,真實資料無此列)", JSON.stringify(r.cashFlows));
  check(r.cashFlows[0]?.amount.raw === "-50000", "金額保留負號,不取絕對值", JSON.stringify(r.cashFlows[0]?.amount));

  const zero = parsePaste(toTsv([{ date: "2024-05-01", action: "DEPOSIT", amount: 0, notes: "" }]));
  check(
    zero.ok === false && !!zero.problems.find((x) => x.column === "Cash_Impact"),
    "注入:金額 0 的現金流 → 拒絕(方向不可判定)",
    JSON.stringify(zero.problems)
  );
}

/* ══════════════════════════════════════════════════════════════════════
 * 七、代號 / 日期 / 幣別
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n── 代號 / 日期 / 幣別 ──");
{
  for (const [tk, want] of [["2330", true], ["00878", true], ["2891A", true], ["233", false], ["TSMC", false], ["", false]]) {
    const r = parsePaste(toTsv([{ ...BASE_ROWS[1], ticker: tk }]));
    check(
      want ? r.trades.length === 1 && r.trades[0].ticker === tk : r.ok === false,
      `代號「${tk || "(空白)"}」→ ${want ? "接受" : "拒絕"}`,
      JSON.stringify(r.problems)
    );
  }
  check(normalizeDate("2024/1/5") === "2024-01-05", "日期 2024/1/5 → 2024-01-05");
  check(normalizeDate("2024-01-15 00:00:00") === "2024-01-15", "日期帶時間 → 取日期部分");
  check(normalizeDate("15/01/2024") === null, "🔴 日期 15/01/2024 → 拒絕(不猜 D/M/Y 還是 M/D/Y)");
  check(normalizeDate("2024-13-01") === null, "月份 13 → 拒絕");

  const usd = parsePaste(toTsv(BASE_ROWS, { mutate: (c, i) => { if (i === 1) c.Currency = "USD"; } }));
  check(usd.ok === false && !!usd.problems.find((x) => x.column === "Currency"), "注入:非 TWD → 拒絕(此守衛預期永不觸發,但必須會咬)", "");
}

/* ══════════════════════════════════════════════════════════════════════
 * 八、🔴 數字:原始字串直送,不經 IEEE754
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n── 數字保真 ──");
{
  check(normalizeNumber("1,234.56")?.raw === "1234.56", "千分位去掉,raw 為十進位字串");
  check(normalizeNumber("+12")?.raw === "12", "正號去掉");
  check(normalizeNumber("(1,234)") === null, "🔴 會計格式 (1,234) → 拒絕(在確認來源用法之前支援它就是猜,而猜錯的方向是把負數讀成正數)");
  check(normalizeNumber("") === null && normalizeNumber("  ") === null, "空白 → null(交由呼叫端具名拒絕)");
  check(normalizeNumber("abc") === null && normalizeNumber("1.2.3") === null, "非數字 → null");

  /* 🔴 關鍵:雙精度存不下的字面值,raw 必須逐字保留 */
  const big = "12345678901234.5678";
  const n = normalizeNumber(big);
  check(n.raw === big, "🔴 雙精度存不下的字面值,raw 逐字保留", n?.raw);
  check(String(n.num) !== big, "🔴 而 num 確實已失真 —— 證明 raw/num 分離不是多餘的", String(n?.num));

  const r = parsePaste(toTsv([{ ...BASE_ROWS[1], price: "600.005", fee: "855.25" }]));
  check(r.trades[0]?.price.raw === "600.005" && r.trades[0]?.fee.raw === "855.25", "小數逐字保留到 raw", JSON.stringify(r.trades[0]?.price));
}

/* ══════════════════════════════════════════════════════════════════════
 * 九、Notes:預設匯入、可整批排除
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n── Notes ──");
{
  const on = parsePaste(toTsv());
  check(on.trades[0].note === "純粹爽" && on.trades[2].note === "知道錯了", "預設匯入 Notes → trades.note", JSON.stringify(on.trades.map((t) => t.note)));
  check(on.trades[1].note === null, "空白的 Notes → null,不是空字串", JSON.stringify(on.trades[1].note));

  const off = parsePaste(toTsv(), { importNotes: false });
  check(off.trades.every((t) => t.note === null), "取消勾選 → 所有 note 皆 null", JSON.stringify(off.trades.map((t) => t.note)));
  check(off.trades.length === on.trades.length, "取消勾選只影響備註,不影響筆數", "");

  /* 含逗號/引號的備註在 CSV 模式下不得把欄位切碎 */
  const csv = [
    HEADERS.join(","),
    `2024-01-15,2330,BUY,1000,600,TWD,2330,1000,600000,,855,0,-600855,-600855,"短線搶反彈, 但要小心"`,
  ].join("\n");
  const c = parsePaste(csv);
  check(c.trades[0]?.note === "短線搶反彈, 但要小心", "CSV 模式:含逗號的引號欄位不被切碎", JSON.stringify(c.trades[0]?.note));
  check(splitLine('a,"b""c",d', ",")[1] === 'b"c', "CSV 跳脫的雙引號還原");
}

/* ══════════════════════════════════════════════════════════════════════
 * 十、疑似重複
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n── 疑似重複 ──");
{
  const r = parsePaste(toTsv());
  const existing = [{ ticker: "2330", trade_date: "2024-01-15", side: "buy", shares: 1000, price: 600 }];
  const dup = findDuplicates(r.trades, existing);
  check(dup.size === 1 && dup.has(2), "撞鍵的列被標出(列號 2)", JSON.stringify([...dup]));

  const noneCase = findDuplicates(r.trades, [{ ticker: "2330", trade_date: "2024-01-15", side: "buy", shares: 1000, price: 601 }]);
  check(noneCase.size === 0, "對照:價格不同就不算重複", JSON.stringify([...noneCase]));

  /* 🔴 手續費不納入鍵:同一筆重匯但取消了備註/費用格式不同,仍要抓得到 */
  const r2 = parsePaste(toTsv(), { importNotes: false });
  check(findDuplicates(r2.trades, existing).size === 1, "🔴 備註被排除時仍抓得到重複(鍵不含備註/費用)", "");
}

/* ══════════════════════════════════════════════════════════════════════ */
const PLAN = 63;
console.log(`\n通過 ${pass} 項;失敗 ${fails.length} 項(plan ${PLAN})`);
if (pass + fails.length !== PLAN) {
  console.error(`❌ plan 對不上:宣告 ${PLAN} 項,實跑 ${pass + fails.length} 項 —— 有測試沒跑到或多跑了`);
  process.exit(1);
}
if (fails.length) {
  for (const f of fails) console.error("  ❌ " + f);
  process.exit(1);
}
console.log("✅ 解析器判準正確:不認得就具名拒絕、缺值不補 0、來源自己的恆等式有鑑別力");
