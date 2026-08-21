/**
 * 貼上匯入的解析器 —— 交易 + 現金流,單一來源、單一解析器
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 貼上的內容【完全不離開瀏覽器】。本檔是純函式,不 fetch、不碰 DOM、
 *    不經過 `/api/*`。寫入只走 supabase-js + 使用者自己的 JWT。
 *
 * 🔴 三條不可妥協的解析原則:
 *   ① **不認得就拒絕並具名,絕不猜。** `Action` 走白名單;欄位靠【表頭名稱】對應,
 *      不用位置索引 —— 位置索引在來源多一欄時會整排位移,而且不會報錯。
 *   ② **費用逐字匯入,不重算。** `Fee` / `Tax` 直接吃來源值。
 *      本檔【沒有】費率、沒有折扣、沒有最低手續費、沒有捨入規則 —— 不算就沒有捨入問題。
 *   ③ **缺值不補 0。** 儲存格空白 / 欄位不存在 → 該列拒絕並具名。
 *      🔴 但來源寫的 `0` 是【值】,不是缺席(買進的 Tax 本來就是 0)。
 *      「沒有」與「是零」必須分得開,否則買進與缺資料長得一樣。
 *
 * 🔴 數字保留【原始字串】(`raw`)供寫入,另存 `num` 供算術。
 *    寫入走 raw → 由 Postgres 做十進位轉換,字面值不經過 IEEE754。
 *    `num` 只用在對帳與畫面顯示,那裡本來就要容忍浮點。
 * ══════════════════════════════════════════════════════════════════════════
 */

/** 來源必備的表頭。少一個就整批拒絕 —— 少欄位時「對應到別的欄」比「沒有資料」危險。 */
export const REQUIRED_HEADERS = [
  "Date",
  "Ticker",
  "Action",
  "Quantity",
  "Price",
  "Currency",
  "Ticker_Clean",
  "Fee",
  "Tax",
  "Cash_Impact",
] as const;

/** 用得到但可缺席的表頭(缺席時對應的交叉檢查標成「無法驗」,不是通過) */
export const OPTIONAL_HEADERS = ["Signed_Qty", "Buy_Amount", "Sell_Amount", "Running_Cash", "Notes"] as const;

/** 🔴 白名單。不在此列的一律拒絕並具名 —— 不猜、不歸類到 other。 */
export const KNOWN_ACTIONS = ["BUY", "SELL", "DEPOSIT"] as const;
export type KnownAction = (typeof KNOWN_ACTIONS)[number];

export const TICKER_RE = /^[0-9]{4}[0-9A-Z]?$/;

/** 每列的容差:來源金額以元為單位,1 分錢已遠小於任何實際誤差 */
export const IDENTITY_TOL = 0.01;

export type Num = {
  /** 原始字串正規化後的十進位表示(去千分位/空白)。寫入資料庫用這個。 */
  raw: string;
  /** 供對帳與顯示的數值。🔴 不可用來寫入。 */
  num: number;
};

export type ParsedTrade = {
  /** 來源列號(1 = 表頭之後的第一列) */
  rowNo: number;
  ticker: string;
  trade_date: string;
  seq: number;
  side: "buy" | "sell";
  shares: Num;
  price: Num;
  fee: Num;
  tax: Num;
  note: string | null;
};

export type ParsedCashFlow = {
  rowNo: number;
  flow_date: string;
  kind: "deposit" | "withdraw";
  amount: Num;
  ticker: null;
  note: string | null;
};

export type RowProblem = {
  /** 來源列號,讓使用者回去看得到是哪一列 */
  rowNo: number;
  /** 哪一欄出問題;整列/整批問題為 null */
  column: string | null;
  reason: string;
  /** 原始內容,原樣回顯 —— 讓使用者自己判斷,而不是由我們解釋 */
  raw: string;
};

export type CrossCheck = {
  name: string;
  /** 🔴 三態。`unknown` 代表【量不到】,不可與 pass 合併。 */
  status: "pass" | "fail" | "unknown";
  detail: string;
  /** 對得上時的最大偏差 —— 印出來,否則容差多鬆是看不見的 */
  maxDeviation?: number;
  /** 無法驗時,要有什麼才驗得了 */
  need?: string;
};

export type ParseResult = {
  ok: boolean;
  /** 來源實際資料列數(不含表頭、不含空列) */
  sourceRowCount: number;
  /**
   * 被略過的空列數 —— 「我們讀的 15 欄全空」的列。
   * 🔴 必須顯示出來。靜默略過的話,「本來就沒有那一列」與「我們吃掉了那一列」無法區分。
   * 真實 Excel 複製會帶進工作表右側的雜欄,表格下方的合計列就落在這一類。
   */
  skippedBlankRows: number;
  headers: string[];
  trades: ParsedTrade[];
  cashFlows: ParsedCashFlow[];
  /** 🔴 任一 problem 存在 → ok = false。不做「略過壞列繼續匯入」。 */
  problems: RowProblem[];
  checks: CrossCheck[];
  /** Action 分布,供對帳畫面顯示 */
  actionCounts: Record<string, number>;
};

/* ── 基本工具 ─────────────────────────────────────────────────────── */

/** 分隔符偵測:Excel 貼上是 TAB;CSV 另存是逗號。用表頭列判斷,不逐列猜。 */
export function detectDelimiter(headerLine: string): "\t" | "," {
  return headerLine.includes("\t") ? "\t" : ",";
}

/** 逗號分隔時要處理引號欄(Notes 可能含逗號);TAB 分隔時用同一支也不會錯。 */
export function splitLine(line: string, delim: "\t" | ","): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * 數字正規化。接受 `1234`、`1,234.56`、`-1234.5`、`+12`、`.5`
 *
 * 🔴 不接受的一律回 null 讓呼叫端具名拒絕 —— 包括會計格式的 `(1,234)`。
 *    支援 `(...)` 需要先確認來源真的用那種格式;在確認之前支援它就是猜,
 *    而猜錯的方向是【把負數讀成正數】,不會有任何錯誤訊息。
 */
export function normalizeNumber(s: string): Num | null {
  const t = String(s ?? "")
    .trim()
    .replace(/,/g, "")
    .replace(/\s/g, "");
  if (t === "") return null;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(t)) return null;
  const num = Number(t);
  if (!Number.isFinite(num)) return null;
  /** 去掉正號:Postgres 吃得下,但 raw 要是規範形式才好比對 */
  return { raw: t.replace(/^\+/, ""), num };
}

/**
 * 日期正規化 → `YYYY-MM-DD`。
 * 接受 `2024-01-15`、`2024/1/15`,以及尾隨時間的 `2024-01-15 00:00:00`。
 *
 * 🔴 其餘一律拒絕並具名。日期猜錯不會報錯,只會把交易排到錯的順序 ——
 *    而 FIFO 的結果完全取決於順序。
 */
export function normalizeDate(s: string): string | null {
  const t = String(s ?? "").trim().split(/[ T]/)[0] ?? "";
  const m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const mm = Number(mo);
  const dd = Number(d);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${y}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/* ── 主解析 ───────────────────────────────────────────────────────── */

export type ParseOptions = {
  /** 是否把 `Notes` 匯入 `trades.note`。預設 true;畫面要能取消勾選。 */
  importNotes?: boolean;
};

export function parsePaste(text: string, opts: ParseOptions = {}): ParseResult {
  const importNotes = opts.importNotes !== false;
  const problems: RowProblem[] = [];
  const trades: ParsedTrade[] = [];
  const cashFlows: ParsedCashFlow[] = [];
  const actionCounts: Record<string, number> = {};

  const lines = String(text ?? "").split(/\r\n|\r|\n/);
  const firstIdx = lines.findIndex((l) => l.trim() !== "");
  if (firstIdx < 0) {
    return {
      ok: false,
      sourceRowCount: 0,
      skippedBlankRows: 0,
      headers: [],
      trades,
      cashFlows,
      problems: [{ rowNo: 0, column: null, reason: "貼上的內容是空的", raw: "" }],
      checks: [],
      actionCounts,
    };
  }

  const delim = detectDelimiter(lines[firstIdx]!);
  const headers = splitLine(lines[firstIdx]!, delim);
  const col = new Map<string, number>();
  headers.forEach((h, i) => {
    if (!col.has(h)) col.set(h, i);
  });

  const missing = REQUIRED_HEADERS.filter((h) => !col.has(h));
  if (missing.length) {
    return {
      ok: false,
      sourceRowCount: 0,
      skippedBlankRows: 0,
      headers,
      trades,
      cashFlows,
      problems: [
        {
          rowNo: 0,
          column: null,
          reason: `缺少必要欄位:${missing.join("、")} —— 整批拒絕。缺欄位時最危險的不是沒資料,是【對應到別的欄】。`,
          raw: headers.join(" | "),
        },
      ],
      checks: [],
      actionCounts,
    };
  }

  const get = (cells: string[], name: string): string =>
    col.has(name) ? (cells[col.get(name)!] ?? "") : "";

  /**
   * 我們實際會讀的欄位。用來判斷「這一列到底有沒有資料」——
   * 🔴 不可以用 `cells.every(c => c === "")`:真實的 Excel 複製會把
   *    工作表右側的雜欄(空欄名、`目前現金` 之類)一起貼進來,
   *    於是表格下方的合計列**在雜欄裡有值**、在我們讀的 15 欄裡全空。
   *    那種列沒有攜帶任何我們讀得到的資訊 —— 它不是一筆記錄。
   * ⚠️ 判準是【我們讀的欄全空】,不是【猜它是不是合計列】。
   *    只要任何一個被讀的欄有值,這一列就會照常走完所有檢查(Action 白名單等)。
   */
  const USED_HEADERS = [...REQUIRED_HEADERS, "Running_Cash", "Notes"] as const;
  const blankInUsedCols = (cells: string[]) => USED_HEADERS.every((h) => get(cells, h).trim() === "");

  /** 對帳用的累計 —— 用來源自己的恆等式,不自己另造一個裁判 */
  let sumCashImpact = 0;
  let identityChecked = 0;
  let identityMaxDev = 0;
  let identityBad = 0;
  /** 已收下的交易列數 = 每列恆等式【應該】驗到的分母 */
  let acceptedTrades = 0;

  let rowNo = 0;
  let sourceRowCount = 0;
  /** 🔴 略過的空列要【數出來並顯示】—— 靜默略過與「本來就沒有」無法區分 */
  let skippedBlank = 0;

  for (let li = firstIdx + 1; li < lines.length; li++) {
    const line = lines[li]!;
    if (line.trim() === "") continue;
    const cells = splitLine(line, delim);
    if (blankInUsedCols(cells)) {
      skippedBlank++;
      continue;
    }
    rowNo++;
    sourceRowCount++;

    const bad = (column: string | null, reason: string, raw = "") =>
      problems.push({ rowNo, column, reason, raw });

    /* ── Action:白名單,不猜 ── */
    const actionRaw = get(cells, "Action").trim();
    const action = actionRaw.toUpperCase();
    actionCounts[action || "(空白)"] = (actionCounts[action || "(空白)"] ?? 0) + 1;
    if (!(KNOWN_ACTIONS as readonly string[]).includes(action)) {
      bad(
        "Action",
        `無法辨識的 Action「${actionRaw}」—— 已知只有 ${KNOWN_ACTIONS.join(" / ")}。不猜,整批停下。`,
        actionRaw
      );
      continue;
    }

    /* ── 日期 ── */
    const dateRaw = get(cells, "Date");
    const date = normalizeDate(dateRaw);
    if (!date) {
      bad("Date", "無法解析的日期格式(接受 YYYY-MM-DD 或 YYYY/M/D)", dateRaw);
      continue;
    }

    /* ── 幣別守衛 ──
       ⚠️ 使用者已確認來源全為 TWD,所以這道守衛【預期不會被觸發】。
          記成「守衛未被觸發過」,不可記成「已驗證非 TWD 會被擋」。 */
    const cur = get(cells, "Currency").trim().toUpperCase();
    if (cur && cur !== "TWD") {
      bad("Currency", `非 TWD(${cur})—— 本站只處理台幣,不做匯率換算`, cur);
      continue;
    }

    const cashRaw = get(cells, "Cash_Impact");
    const cash = normalizeNumber(cashRaw);

    /* ── 現金流:DEPOSIT ── */
    if (action === "DEPOSIT") {
      if (!cash) {
        bad("Cash_Impact", "DEPOSIT 列的 Cash_Impact 空白或無法解析 —— 金額不可推定", cashRaw);
        continue;
      }
      if (cash.num === 0) {
        bad("Cash_Impact", "金額為 0 的現金流無法判斷方向(入金還是出金),拒絕", cashRaw);
        continue;
      }
      sumCashImpact += cash.num;
      cashFlows.push({
        rowNo,
        flow_date: date,
        /* 🔴 符號慣例:正 = 入金、負 = 出金。
           入金方向已有實際資料走過;**出金方向沒有任何一列資料驗過**。
           見 web/docs/import-assumptions.md 的回訪條件。 */
        kind: cash.num > 0 ? "deposit" : "withdraw",
        amount: cash,
        ticker: null,
        note: "匯入自交易紀錄 · DEPOSIT",
      });
      continue;
    }

    /* ── 交易:BUY / SELL ── */
    const side: "buy" | "sell" = action === "BUY" ? "buy" : "sell";

    const tkRaw = (get(cells, "Ticker_Clean") || get(cells, "Ticker")).trim().toUpperCase();
    if (!TICKER_RE.test(tkRaw)) {
      bad("Ticker_Clean", "代號格式不符 ^[0-9]{4}[0-9A-Z]?$ —— 不做任何清洗或推測", tkRaw);
      continue;
    }

    const qty = normalizeNumber(get(cells, "Quantity"));
    const price = normalizeNumber(get(cells, "Price"));
    /* 🔴 費用/稅:空白 = 缺席 → 拒絕;來源寫的 0 = 值 → 照收。 */
    const feeRaw = get(cells, "Fee");
    const taxRaw = get(cells, "Tax");
    const fee = normalizeNumber(feeRaw);
    const tax = normalizeNumber(taxRaw);

    if (!qty || qty.num <= 0) {
      bad("Quantity", "股數空白、無法解析或非正數", get(cells, "Quantity"));
      continue;
    }
    if (!price || price.num < 0) {
      bad("Price", "價格空白、無法解析或為負", get(cells, "Price"));
      continue;
    }
    if (!fee) {
      bad("Fee", "手續費空白 —— 🔴 不補 0。「沒有」與「是零」必須分得開", feeRaw);
      continue;
    }
    if (!tax) {
      bad("Tax", "證交稅空白 —— 🔴 不補 0(買進的 0 應由來源寫出來,不由我們填)", taxRaw);
      continue;
    }
    if (fee.num < 0) {
      bad("Fee", "手續費為負,資料庫的 check 會拒絕", feeRaw);
      continue;
    }
    if (tax.num < 0) {
      bad("Tax", "證交稅為負,資料庫的 check 會拒絕", taxRaw);
      continue;
    }

    const noteRaw = get(cells, "Notes").trim();

    trades.push({
      rowNo,
      ticker: tkRaw,
      trade_date: date,
      /* seq = 來源列號。同日多筆的 FIFO 全序由 (trade_date, seq, id) 決定,
         列號單調遞增 → 不會產生平手,也就沒有靜默的不確定性。 */
      seq: rowNo,
      side,
      shares: qty,
      price,
      fee,
      tax,
      note: importNotes && noteRaw !== "" ? noteRaw : null,
    });

    acceptedTrades++;

    /* ── 來源自己的恆等式 ──
       🔴 `Cash_Impact` 是【欄位必備、逐列選填】:某一列空白時這條驗不到那一列。
          所以分母是 acceptedTrades,不是 identityChecked ——
          「38 列全部吻合」不會告訴你另外 1 列根本沒驗到。 */
    if (cash) {
      sumCashImpact += cash.num;
      const gross = qty.num * price.num;
      const expect = side === "buy" ? -(gross + fee.num) : gross - fee.num - tax.num;
      const dev = Math.abs(cash.num - expect);
      identityChecked++;
      identityMaxDev = Math.max(identityMaxDev, dev);
      if (dev > IDENTITY_TOL) identityBad++;
    }
  }

  /* Running_Cash 取最後一列有值者 */
  let lastRunningCash: Num | null = null;
  if (col.has("Running_Cash")) {
    for (let li = lines.length - 1; li > firstIdx; li--) {
      const line = lines[li]!;
      if (line.trim() === "") continue;
      const v = normalizeNumber(splitLine(line, delim)[col.get("Running_Cash")!] ?? "");
      if (v) {
        lastRunningCash = v;
        break;
      }
    }
  }

  /* ── 交叉檢查:全部來自【來源自己就有的欄位】,不是我們另造的裁判 ──
     🔴 這兩條的價值在於它們【不需要我們猜任何事】。若欄位對應錯位,
        來源自己的算術就對不上 —— 由被檢查的對象自己當裁判,而不是我們發明一個標準。 */
  const IDENT = "每列:Cash_Impact == 買 −(Q×P + Fee) / 賣 +(Q×P − Fee − Tax)";
  const RUNNING = "Σ Cash_Impact == 最後一列 Running_Cash";
  const checks: CrossCheck[] = [];

  checks.push(
    identityChecked === 0
      ? {
          name: IDENT,
          status: "unknown",
          detail: "沒有任何一列可驗(Cash_Impact 全空,或沒有 BUY/SELL 列)",
          need: "來源需有 Cash_Impact 欄且至少一筆 BUY/SELL",
        }
      : identityBad > 0
        ? {
            name: IDENT,
            status: "fail",
            detail: `${identityBad} / ${identityChecked} 列對不上:欄位對應可能錯位`,
            maxDeviation: identityMaxDev,
          }
        : identityChecked < acceptedTrades
          ? {
              /* 🔴 驗到的都吻合,但【沒有驗完】。這不是通過 ——
                 「37 列全部吻合」在 39 筆交易的情況下讀起來像通過,
                 而那兩列可能正是壞的。覆蓋率不完整一律判無法驗。 */
              name: IDENT,
              status: "unknown",
              detail: `只驗到 ${identityChecked} / ${acceptedTrades} 列(其餘 ${acceptedTrades - identityChecked} 列的 Cash_Impact 空白),驗到的全部吻合`,
              maxDeviation: identityMaxDev,
              need: "那些列需要 Cash_Impact 才驗得了;在補上之前,它們的欄位對應【沒有證據】",
            }
          : {
              name: IDENT,
              status: "pass",
              detail: `${identityChecked} / ${acceptedTrades} 列全部吻合 —— 欄位對應由【來源自己的算術】背書`,
              maxDeviation: identityMaxDev,
            }
  );

  checks.push(
    lastRunningCash == null
      ? {
          name: RUNNING,
          status: "unknown",
          detail: "來源沒有 Running_Cash 欄,或該欄全空",
          need: "來源需含 Running_Cash 欄且至少一列有值",
        }
      : {
          name: RUNNING,
          status: Math.abs(sumCashImpact - lastRunningCash.num) <= IDENTITY_TOL ? "pass" : "fail",
          detail: `Σ = ${sumCashImpact.toFixed(2)} · Running_Cash = ${lastRunningCash.raw}`,
          maxDeviation: Math.abs(sumCashImpact - lastRunningCash.num),
        }
  );

  return {
    ok: problems.length === 0 && (trades.length > 0 || cashFlows.length > 0),
    sourceRowCount,
    skippedBlankRows: skippedBlank,
    headers,
    trades,
    cashFlows,
    problems,
    checks,
    actionCounts,
  };
}

/* ── 疑似重複 ─────────────────────────────────────────────────────── */

export type ExistingTradeKey = {
  ticker: string;
  trade_date: string;
  side: "buy" | "sell";
  shares: number;
  price: number;
};

/**
 * 疑似重複的鍵:代號 + 日期 + 買賣別 + 股數 + 價格。
 * 🔴 刻意【不含】手續費/稅/備註 —— 同一筆交易重匯時那些可能不同(例如取消勾選備註),
 *    把它們納入會讓重複偵測在最需要它的時候失效。
 */
export const dupKey = (t: { ticker: string; trade_date: string; side: string; shares: { num: number } | number; price: { num: number } | number }) => {
  const n = (v: { num: number } | number) => (typeof v === "number" ? v : v.num);
  return `${t.ticker}|${t.trade_date}|${t.side}|${n(t.shares)}|${n(t.price)}`;
};

/**
 * 標出貼上內容裡與【既有交易】撞鍵的列。
 *
 * 🔴 回傳的是「疑似」,不是「確定重複」—— 同一天用同價買同一檔兩次是合法的。
 *    所以畫面上預設【不勾選】排除,由使用者決定;我們只負責讓他看見。
 */
export function findDuplicates(parsed: ParsedTrade[], existing: ExistingTradeKey[]): Set<number> {
  const have = new Set(existing.map((e) => dupKey(e)));
  const hit = new Set<number>();
  for (const t of parsed) if (have.has(dupKey(t))) hit.add(t.rowNo);
  return hit;
}
