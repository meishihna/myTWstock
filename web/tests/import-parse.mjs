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
  normalizeCurrency,
  normalizeDate,
  dateRejectReason,
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

/* ══════════════════════════════════════════════════════════════════════
 * 十一、🔴 真實 Excel 複製的「不乾淨」貼上
 *
 * 前十節用的都是【乾淨】輸入 —— 而真實的 Excel 複製不乾淨:
 * 工作表右側常有數個空欄與雜欄(例如 `目前現金`),表格下方常有合計列,
 * 而且 Excel 會把尾端的空儲存格截掉。
 * 這一節的形狀比照使用者轉述的來源:41 有效列 = 26 BUY + 13 SELL + 2 DEPOSIT、10 檔。
 *
 * 🔴 判準:容忍 或 具名拒絕 都可接受;**靜默錯位不可接受。**
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n── 不乾淨的貼上(真實 Excel 形狀)──");
{
  const TK = ["2330", "2317", "2454", "2603", "2882", "1301", "3034", "2412", "1216", "2891"];
  const R41 = [{ date: "2024-01-02", action: "DEPOSIT", amount: 500000, notes: "" }];
  for (let i = 0; i < 26; i++)
    R41.push({
      date: `2024-0${1 + Math.floor(i / 14)}-${String(10 + (i % 14)).padStart(2, "0")}`,
      action: "BUY", ticker: TK[i % 10], qty: 1000, price: 100 + i,
      fee: Math.round(1000 * (100 + i) * 0.001425), tax: 0, notes: "",
    });
  R41.push({ date: "2024-03-01", action: "DEPOSIT", amount: 100000, notes: "" });
  for (let i = 0; i < 13; i++)
    R41.push({
      date: `2024-04-${String(10 + i).padStart(2, "0")}`, action: "SELL", ticker: TK[i % 10],
      qty: 500, price: 120 + i, fee: Math.round(500 * (120 + i) * 0.001425),
      tax: Math.round(500 * (120 + i) * 0.003), notes: "",
    });

  /** 雜欄:3 個空欄名 + 目前現金。`trim` 模擬 Excel 截掉尾端空儲存格。 */
  function build41({ junk = false, trim = false, tail = [], mutate } = {}) {
    const heads = junk ? [...HEADERS, "", "", "", "目前現金"] : HEADERS.slice();
    let run = 0;
    const out = [heads.join("\t")];
    R41.forEach((r, i) => {
      const ci = cashImpactOf(r);
      run += ci;
      const c = {
        Date: r.date, Ticker: r.ticker ?? "", Action: r.action, Quantity: r.qty ?? "",
        Price: r.price ?? "", Currency: r.action === "DEPOSIT" ? "" : "TWD",
        Ticker_Clean: r.ticker ?? "",
        Signed_Qty: r.action === "BUY" ? r.qty : r.action === "SELL" ? -r.qty : "",
        Buy_Amount: r.action === "BUY" ? r.qty * r.price : "",
        Sell_Amount: r.action === "SELL" ? r.qty * r.price : "",
        Fee: r.fee ?? "", Tax: r.tax ?? "", Cash_Impact: ci, Running_Cash: run, Notes: r.notes ?? "",
      };
      if (mutate) mutate(c, i);
      let cells = heads.map((h) => String(h === "目前現金" ? (i === 0 ? 500000 : "") : (c[h] ?? "")));
      if (trim) while (cells.length && cells[cells.length - 1] === "") cells.pop();
      out.push(cells.join("\t"));
    });
    return [...out, ...tail].join("\n");
  }

  const shape = (r) => `${r.sourceRowCount}/${r.trades.length}/${r.cashFlows.length}/${new Set(r.trades.map((t) => t.ticker)).size}`;
  const CLEAN = "41/39/2/10";

  /* 對照:乾淨的 41 列。這一條同時驗證【監督者宣告的預期數字】 */
  const a = parsePaste(build41());
  check(a.ok && shape(a) === CLEAN, `對照:乾淨 41 列 → 39 交易 + 2 現金流 + 10 檔`, shape(a));
  check(a.cashFlows.reduce((x, c) => x + c.amount.num, 0) === 600000, "現金流合計 = 600,000(50 萬 + 10 萬)", "");
  check(a.checks[0].status === "pass" && a.checks[0].detail.startsWith("39 / 39"), "🔴 恆等式印出【分母】39 / 39", a.checks[0].detail);

  /* B:尾端 3 個空欄名 + 目前現金,儲存格補齊 */
  const b = parsePaste(build41({ junk: true }));
  check(b.ok && shape(b) === CLEAN, "尾端空欄 + 目前現金 → 容忍,數字與乾淨版一字不差", shape(b));

  /* C:同 B 但 Excel 截掉尾端空儲存格(資料列比表頭短) */
  const c = parsePaste(build41({ junk: true, trim: true }));
  check(c.ok && shape(c) === CLEAN, "Excel 截掉尾端空儲存格 → 容忍(cells 短於表頭也不錯位)", shape(c));

  /* D:表格下方的合計列 —— 我們讀的 15 欄全空、只有雜欄有值 */
  const d = parsePaste(build41({ junk: true, tail: ["\t".repeat(17) + "647312"] }));
  check(d.ok && shape(d) === CLEAN, "表格下方合計列(只有雜欄有值)→ 略過,不影響數字", shape(d));
  check(d.skippedBlankRows === 1, "🔴 略過的空列有【數出來】—— 靜默略過與「本來就沒有」無法區分", String(d.skippedBlankRows));

  /* 🔴 對照:略過的判準是「我們讀的欄全空」,不是「猜它是合計列」。
     只要任何一個被讀的欄有值,就必須照常走白名單並具名拒絕。 */
  const d2 = parsePaste(build41({ junk: true, tail: ["\t\t\t500" + "\t".repeat(14) + "1"] }));
  check(
    d2.ok === false && !!d2.problems.find((x) => x.column === "Action" && x.rowNo === 42),
    "🔴 對照:Action 空白但 Quantity 有值 → 仍具名拒絕(沒有變成無條件吞列)",
    JSON.stringify(d2.problems.slice(0, 2))
  );
  check(d2.skippedBlankRows === 0, "對照:該列不算「空列」", String(d2.skippedBlankRows));

  /* E:尾端全空白列 */
  const e = parsePaste(build41({ junk: true, tail: ["\t".repeat(18), "\t".repeat(18)] }));
  check(e.ok && shape(e) === CLEAN, "尾端全空白列 → 略過", shape(e));

  /* F:極端截斷 —— 某一列只剩前 3 欄。必須具名拒絕【且】Σ 恆等式同時失敗 */
  const fLines = build41().split("\n");
  fLines[5] = fLines[5].split("\t").slice(0, 3).join("\t");
  const f = parsePaste(fLines.join("\n"));
  check(f.ok === false && !!f.problems.find((x) => x.rowNo === 5), "極端截斷(整列只剩 3 欄)→ 具名拒絕到列號", JSON.stringify(f.problems.slice(0, 1)));
  check(f.checks[1].status === "fail", "🔴 而且 Σ 恆等式【同時】失敗 —— 兩個獨立訊號,不靠單一守衛", f.checks[1].status);

  /* 🔴 G:被收下的交易列缺 Cash_Impact → 恆等式覆蓋率不完整。
     這是實測翻出來的洞:舊版會印「38 列全部吻合」而不說有 39 筆交易。 */
  const g = parsePaste(build41({ mutate: (cc, i) => { if (i === 5) cc.Cash_Impact = ""; } }));
  check(g.ok === true, "對照:Cash_Impact 逐列選填,空白不會讓該列被拒", JSON.stringify(g.problems.slice(0, 1)));
  check(
    g.checks[0].status === "unknown" && g.checks[0].detail.includes("38 / 39"),
    "🔴 只驗到 38 / 39 列 → 判【無法驗】而非通過,並印出分母",
    JSON.stringify(g.checks[0])
  );
  check(!!g.checks[0].need, "無法驗時說明要什麼才驗得了", JSON.stringify(g.checks[0].need));
}

/* ══════════════════════════════════════════════════════════════════════
 * 十二、🔴 真實的【顯示格式】—— 合成數值,真實格式
 *
 * 🔴🔴 夾具**不得**放使用者的真實資料:本 repo 是公開的,他的貼上內容含持股與備註。
 *      被測的是【格式】,不是【值】—— 所以下面每個數字都是編的,
 *      但每一種長相都照著他 Excel 實際渲染出來的樣子。
 *
 * 🔴 根因(要記住,不只是修):前 78 項全部用 ISO 日期 + 純數字,
 *    也就是**合成資料共用了寫測試的人的假設**。
 *    輪 5 測了髒【欄位】(雜欄、截斷、合計列),沒測髒【格式】。
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n── 🔴 真實顯示格式 ──");

/** `NT$#,##0`:零 → `NT$-`;負 → `NT$-165,736`;正 → `NT$165,500` */
function nt(v, exact = false) {
  if (v === 0) return "NT$-";
  const a = Math.abs(v);
  const body = exact
    ? a.toLocaleString("en-US", { maximumFractionDigits: 20 })
    : a.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return (v < 0 ? "NT$-" : "NT$") + body;
}
/** `2026年6月26日` —— 月日**不補零** */
const ymd = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y}年${m}月${d}日`;
};
const grp = (v) => v.toLocaleString("en-US", { maximumFractionDigits: 20 });

/** 🔴 表頭刻意帶前後空白 —— 他的來源就是這樣(" Quantity "、" Notes ") */
const REAL_HEADERS = [
  "Date", "Ticker", "Action", " Quantity ", "Price", "Currency", "Ticker_Clean",
  "Signed_Qty", "Buy_Amount", "Sell_Amount", "Fee", "Tax", "Cash_Impact",
  " Running_Cash ", " Notes ",
];

/**
 * 依真實顯示格式產生貼上文字。
 * `cashOverride(i)` 可覆寫某列的 Cash_Impact 原文,用來注入四捨五入/錯位。
 */
function realTsv(rows, { cashOverride, exact = false, runExact = exact, headers = REAL_HEADERS, tailRows = [] } = {}) {
  let run = 0;
  const out = [headers.join("\t")];
  rows.forEach((r, i) => {
    const gross = r.action === "DEPOSIT" ? 0 : r.qty * r.price;
    const ci =
      r.action === "DEPOSIT" ? r.amount : r.action === "BUY" ? -(gross + r.fee) : gross - r.fee - r.tax;
    run += ci;
    const over = cashOverride ? cashOverride(i) : null;
    out.push(
      [
        ymd(r.date),
        r.ticker ?? "",
        r.action,
        r.qty != null ? ` ${grp(r.qty)} ` : r.action === "DEPOSIT" ? ` ${grp(r.amount)} ` : "",
        r.price != null ? String(r.price) : "",
        r.action === "DEPOSIT" ? "" : "TWD",
        r.ticker ?? "",
        r.action === "BUY" ? String(r.qty) : r.action === "SELL" ? String(-r.qty) : "0",
        r.action === "BUY" ? nt(gross, exact) : nt(0),
        r.action === "SELL" ? nt(gross, exact) : nt(0),
        r.action === "DEPOSIT" ? nt(0) : nt(r.fee, exact),
        r.action === "DEPOSIT" ? nt(0) : nt(r.tax, exact),
        over ?? nt(ci, exact),
        /* Running_Cash 的格式可獨立於 Cash_Impact —— 同一張 Excel 裡兩欄格式不同很常見,
           而那正是 Σ 恆等式唯一能看見四捨五入的情況(見下方測試)。 */
        ` ${nt(run, runExact)} `,
        r.notes ? ` ${r.notes} ` : "",
      ].join("\t")
    );
  });
  return [...out, ...tailRows].join("\n");
}

/** 合成的持股與數值,金額刻意取整數 → 恆等式在對照組上必須精確吻合 */
const REAL_ROWS = [
  { date: "2026-06-26", action: "DEPOSIT", amount: 500000, notes: "" },
  { date: "2026-07-01", action: "BUY", ticker: "1111", qty: 1000, price: 165.5, fee: 236, tax: 0, notes: "短線搶反彈" },
  { date: "2026-07-15", action: "BUY", ticker: "2222", qty: 500, price: 173, fee: 123, tax: 0, notes: "" },
  { date: "2026-08-18", action: "SELL", ticker: "1111", qty: 500, price: 180, fee: 128, tax: 270, notes: "" },
];

{
  const r = parsePaste(realTsv(REAL_ROWS));
  const ident = r.checks.find((c) => c.name.startsWith("每列"));
  const run = r.checks.find((c) => c.name.startsWith("Σ"));
  check(r.ok === true, "🔴 對照:真實格式(年月日 + NT$ + 千分位 + 表頭空白)整批通過", JSON.stringify(r.problems.slice(0, 2)));
  check(r.trades.length === 3 && r.cashFlows.length === 1, "3 筆交易 + 1 筆現金流", `${r.trades.length}/${r.cashFlows.length}`);
  check(r.trades[0].trade_date === "2026-07-01", "「2026年7月1日」→ 2026-07-01", r.trades[0]?.trade_date);
  check(r.trades[0].fee.raw === "236", "「NT$236」→ 236", JSON.stringify(r.trades[0]?.fee));
  check(
    r.trades[0].tax.raw === "0" && r.trades[0].tax.num === 0,
    "🔴「NT$-」→ 0(而且是【值】,買進列不會被當成缺稅拒絕)",
    JSON.stringify(r.trades[0]?.tax)
  );
  check(r.trades[0].shares.raw === "1000", "「 1,000 」→ 1000(表頭與值的前後空白都吃掉)", JSON.stringify(r.trades[0]?.shares));
  check(r.trades[0].price.raw === "165.5", "Price 全精度保留", JSON.stringify(r.trades[0]?.price));
  check(r.trades[0].note === "短線搶反彈", "「 短線搶反彈 」→ trim 後匯入", JSON.stringify(r.trades[0]?.note));
  check(r.cashFlows[0].amount.raw === "500000", "DEPOSIT 取 Cash_Impact 而非 Quantity", JSON.stringify(r.cashFlows[0]?.amount));
  check(ident.status === "pass" && ident.maxDeviation === 0, "🔴 對照:恆等式在真實格式下精確吻合(偏差 0)", JSON.stringify(ident));
  check(run.status === "pass", "🔴 對照:Σ 恆等式通過", JSON.stringify(run));
}

console.log("\n── 🔴 NT$ 的兩種 `-`:一個是零,一個是負號 ──");
{
  /* 這兩條【一起】否決兩種常見的錯寫法:
     · parseFloat("NT$-") → NaN     → 第一條會紅
     · 「含 - 就當 0」                → 第二條會紅 */
  const zero = normalizeCurrency("NT$-");
  check(zero !== null && zero.num === 0 && zero.raw === "0", "🔴「NT$-」→ 0(不是 NaN、不是 null)", JSON.stringify(zero));
  const neg = normalizeCurrency("NT$-165,736");
  check(neg !== null && neg.num === -165736, "🔴「NT$-165,736」→ -165736(不是 0)", JSON.stringify(neg));
  check(normalizeCurrency("NT$165,500")?.num === 165500, "「NT$165,500」→ 165500");
  check(normalizeCurrency("  NT$ 1,234.56  ")?.raw === "1234.56", "空白與千分位都吃掉,小數保留");
  check(normalizeCurrency("") === null && normalizeCurrency("   ") === null, "🔴 空白仍然是【缺席】→ null(不是 0)");
  check(normalizeCurrency("NT$") === null, "「NT$」後面什麼都沒有 → null(具名拒絕)");
  check(normalizeCurrency("--") === null && normalizeCurrency("NT$1.2.3") === null, "「--」與「1.2.3」→ null");
  /* 🔴 Price/Quantity 刻意【不】用貨幣解析器:
     若 `-` 在 Price 被讀成 0,schema 允許 price >= 0 → 會靜默存進一筆 0 元成交。 */
  check(normalizeNumber("-") === null, "🔴 Price/Quantity 的解析器不把「-」當 0(否則會靜默存進 0 元成交)");
  check(normalizeNumber("NT$165") === null, "🔴 Price 帶 NT$ → 具名拒絕,不靜默接受");
}

console.log("\n── 🔴 民國年具名拒絕,不 +1911 ──");
{
  check(normalizeDate("2026年6月26日") === "2026-06-26", "年月日 → ISO");
  check(normalizeDate("2026年6月6日") === "2026-06-06", "月日皆一位數 → 補零");
  check(normalizeDate("2026 年 6 月 26 日") === "2026-06-26", "年月日之間有空白也接受");
  for (const bad of ["115年6月26日", "115/6/26", "115-06-26"]) {
    check(normalizeDate(bad) === null, `🔴「${bad}」→ 拒絕(不 +1911)`);
    check(/民國/.test(dateRejectReason(bad)), `「${bad}」的拒絕理由要指名民國年`, dateRejectReason(bad));
  }
  check(!/民國/.test(dateRejectReason("26 Jun 2026")), "對照:非民國形狀的壞日期不要誤扣民國帽子", dateRejectReason("26 Jun 2026"));
  const r = parsePaste(realTsv(REAL_ROWS).replace("2026年7月1日", "115年7月1日"));
  const p = r.problems.find((x) => x.column === "Date");
  check(r.ok === false && !!p && /民國/.test(p.reason), "整批:民國年的列被具名拒絕", JSON.stringify(r.problems));
}

console.log("\n── 🔴 顯示格式四捨五入:偵測並具名,不塞進容差 ──");
{
  /* 180 股 × 333.33 = 59,999.4 → 加費用後 Cash_Impact 的真值有小數,
     而 `NT$#,##0` 會把它顯示成整數。 */
  const ROWS = [
    { date: "2026-06-26", action: "DEPOSIT", amount: 500000, notes: "" },
    { date: "2026-07-01", action: "BUY", ticker: "1111", qty: 180, price: 333.33, fee: 85, tax: 0, notes: "" },
  ];
  const rounded = parsePaste(realTsv(ROWS)); // 預設 #,##0 → 會捨入
  const ident = rounded.checks.find((c) => c.name.startsWith("每列"));
  check(ident.status === "unknown", "🔴 疑似四捨五入 → 判【無法驗】,不是通過", JSON.stringify(ident));
  check(/四捨五入/.test(ident.detail) && /列 2/.test(ident.detail), "逐列具名(列 2)並說明成因", ident.detail);
  check(!!ident.need && /不捨入/.test(ident.need), "說明要怎麼做才驗得了", ident.need);
  check(rounded.ok === true, "⚠️ 但不擋匯入 —— Cash_Impact 本身【不寫入資料庫】,它只是檢查的輸入", JSON.stringify(rounded.problems));
  /* 🔴 這一條的預期我原本寫錯了,實測才發現 —— 留著,因為它本身是個結論:
     `Running_Cash` 若用【同一個】#,##0 格式,兩邊會【一致地】捨入,於是 Σ 剛好對得上。
     **Σ 通過並不能反證每列恆等式** —— 共用同一個捨入的兩邊會一起對上。
     所以上面那條 unknown 不可因為「Σ 通過了」就降級。 */
  const runChk = rounded.checks.find((c) => c.name.startsWith("Σ"));
  check(runChk.status === "pass", "⚠️ 兩欄同樣捨入時 Σ 仍會通過 —— 它不能當成每列恆等式的替代證據", JSON.stringify(runChk));

  /* 混合格式:Cash_Impact 捨入、Running_Cash 全精度(同一張 Excel 兩欄格式不同,很常見)
     → 這時 Σ 才看得見捨入,必須歸因而不是誤報 fail。 */
  const mixed = parsePaste(realTsv(ROWS, { runExact: true }));
  const runMixed = mixed.checks.find((c) => c.name.startsWith("Σ"));
  check(
    runMixed.status === "unknown" && /四捨五入/.test(runMixed.detail),
    "🔴 混合格式(Cash_Impact 捨入、Running_Cash 全精度)→ Σ 歸因到四捨五入,不誤報 fail",
    JSON.stringify(runMixed)
  );

  /* 🔴 對照:同一組資料,Cash_Impact 用全精度 → 必須回到 pass。
     沒有這條,上面的 unknown 可能只是「這組資料永遠驗不過」。 */
  const exactly = parsePaste(realTsv(ROWS, { exact: true }));
  const ident2 = exactly.checks.find((c) => c.name.startsWith("每列"));
  check(ident2.status === "pass", "🔴 對照:同組資料改成全精度 → 恆等式通過", JSON.stringify(ident2));

  /* 注入:差 1 元以上 → 真的對不上,不可歸類成四捨五入 */
  const wayOff = parsePaste(realTsv(ROWS, { cashOverride: (i) => (i === 1 ? "NT$-60,090" : null) }));
  const ident3 = wayOff.checks.find((c) => c.name.startsWith("每列"));
  check(ident3.status === "fail", "🔴 注入:差 5.6 元 → fail(不得被歸類成四捨五入)", JSON.stringify(ident3));

  /* 注入:差得很小【但不是整數】→ 仍然 fail(判準是兩個條件的【且】) */
  const nonInt = parsePaste(realTsv(ROWS, { cashOverride: (i) => (i === 1 ? "NT$-60,084.5" : null) }));
  const ident4 = nonInt.checks.find((c) => c.name.startsWith("每列"));
  check(ident4.status === "fail", "🔴 注入:差 0.1 但貼上值非整數 → fail(不是四捨五入的形狀)", JSON.stringify(ident4));
}

console.log("\n── 🔴 備註含 tab → 欄位位移,具名拒絕 ──");
{
  const shifted = realTsv(REAL_ROWS).split("\n");
  shifted[2] = shifted[2] + "\t被擠出來的東西"; // 模擬 Notes 裡有一個 tab
  const r = parsePaste(shifted.join("\n"));
  const p = r.problems.find((x) => /儲存格/.test(x.reason));
  check(r.ok === false && !!p && p.rowNo === 2, "🔴 儲存格數多於表頭 → 具名拒絕到列號", JSON.stringify(r.problems));
  check(/tab/.test(p.reason) && /位移/.test(p.reason), "理由要講明是 tab/換行造成的位移", p?.reason);
  /* 對照:沒有多出來的 tab 時不得誤報 */
  check(parsePaste(realTsv(REAL_ROWS)).ok === true, "對照:沒有多餘 tab 時不誤報");
}

/* ══════════════════════════════════════════════════════════════════════ */
const PLAN = 78 + 43;
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
