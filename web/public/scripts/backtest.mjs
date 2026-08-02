/**
 * 台股規則回測引擎 — JS 版（Node 與瀏覽器共用；純函式、無 I/O、無 DOM、無相依）
 *
 * 由 Python 版逐行移植，輸出與既有資料契約 signals/{code}.json 完全同構
 * （comboFields / tradeFields 一致）。移植原則：
 *   1. 運算順序與 Python 完全相同（浮點加總不可改順序，否則末位會漂）
 *   2. 捨入一律用 pyRound（half-to-even，對 double 精確值）— 不可用 Math.round
 *   3. Python 以 `x is not None` 守衛的地方，JS 必須顯式檢查 null
 *      （JS 的 `null < 5` 會把 null 當 0 → 靜默產生假訊號，是移植最大陷阱）
 *
 * 確認層（投信/法人同買/大盤多頭/浮額清洗）本版不含，但介面已預留 opts.confirm；
 * 未提供時 confLayers = ["無"]，即 10×9 = 90 組。
 */
import { pyRound } from "./pyround.mjs";

// ── 規則參數（與 Python 版同源，數值不可各自修改）────────────────────
export const WARMUP = 80;
export const HORIZON = 60;
const BIAS_OS = -7.0;
const BIAS_OB = 7.0;
const WR_OS = -80.0;
const KD_LOW = 30.0;
const VOL_RECLAIM = 1.2;
const FIX_STOP = -7.0;
const FIX_TAKE = 15.0;
const HIGH_WIN = 250;
const ATR_N = 22;
const CHAND_MULT = 3.0;
const BURST_DRY = 0.75;
const BURST_VOL = 2.0;
const BURST_BODY = 2.0;
export const FEE_BUY = 0.001425;
export const FEE_SELL = 0.001425;
export const TAX_SELL = 0.003;
const LIMIT_UP = 1.0995;

export const CONF_LAYERS = ["無", "投信", "法人同買", "大盤多頭", "浮額清洗"];

export const ENTRY_NAMES = [
  "跌破布林下軌", "W%R超賣回升", "乖離率超賣", "KD低檔黃金交叉", "三層買點v2",
  "帶量站回季線", "突破20日高", "均線黃金交叉", "52週新高", "量縮後首爆量",
];

export const EXIT_NAMES = [
  "乖離率超買", "觸布林上軌", "跌破月線", "固定停損停利", "停損10日低+破季線",
  "破季線讓利潤跑", "跌破10日低(移動)", "均線死亡交叉", "吊燈出場(ATR)",
];

/** 出場原因代碼表（索引 = rc；與 Python EXIT_REASONS 順序一致，永不重排） */
export const EXIT_REASONS = [
  "跌破停損", "跌破季線", "滿60天", "乖離超買", "觸上軌", "跌破月線",
  "停損", "停利", "跌破10日低", "死亡交叉", "跌破吊燈線", "資料結束",
];
const RC = Object.fromEntries(EXIT_REASONS.map((r, i) => [r, i]));

// ── 基礎工具 ─────────────────────────────────────────────────────────
/**
 * CPython `sum()` 的等價實作 —— **Neumaier 補償求和**。
 *
 * ⚠️ 這不是可選的最佳化,是正確性需求:CPython 3.12+ 的內建 sum() 對 float
 * 改用 Neumaier 補償求和,比朴素左到右更精確。實測 2317 第 357 根 20 日均線:
 *     朴素左到右 = 88.45603200000002
 *     CPython sum = 88.45603200000001  ← 差 1 ULP
 * 而該根收盤恰為 88.45603200000001 → `C < ma20` 由 False 翻成 true,
 * 「跌破月線」提前 3 天出場,整筆報酬與後續交易全部走偏。
 * 任何 Python 用 sum() 的地方,JS 都必須用本函式。
 */
function pySum(a, from, toExcl) {
  let s = 0.0;
  let c = 0.0;
  for (let i = from; i < toExcl; i++) {
    const x = a[i];
    const t = s + x;
    if (Math.abs(s) >= Math.abs(x)) c += (s - t) + x;
    else c += (x - t) + s;
    s = t;
  }
  return s + c;
}
const sliceSum = pySum;
function sliceMin(a, from, toExcl) {
  let m = a[from];
  for (let i = from + 1; i < toExcl; i++) if (a[i] < m) m = a[i];
  return m;
}
function sliceMax(a, from, toExcl) {
  let m = a[from];
  for (let i = from + 1; i < toExcl; i++) if (a[i] > m) m = a[i];
  return m;
}
/** Python sma_at：i < k-1 回 null */
function smaAt(a, k, i) {
  return i >= k - 1 ? sliceSum(a, i - k + 1, i + 1) / k : null;
}
function smaSeries(a, k) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = smaAt(a, k, i);
  return out;
}

/**
 * 除權息還原：OHLC × 因子（量與日期不變）。因子 = 該日之後所有除息事件比率的累乘。
 * @param {{d:string,o:number,h:number,l:number,c:number,v:number}[]} bars 原始日K（由舊到新）
 * @param {{date:string,ratio:number}[]} [exEvents] 該股除權息事件（date=除息日 ISO）
 */
export function adjustBars(bars, exEvents) {
  if (!exEvents || exEvents.length === 0) return bars.map((b) => ({ ...b }));
  // 與 Python sorted([(iso, ratio), ...]) 同序：先日期後比率（同日多事件時累乘順序才一致）
  const ev = [...exEvents].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.ratio - b.ratio);
  return bars.map((b) => {
    let fac = 1.0;
    for (const e of ev) if (e.date > b.d) fac *= e.ratio;   // 除息日在該 bar 之後 → 往前還原
    fac = pyRound(fac, 6);                                   // 累乘完才捨入 —— 與 Python 同（不可逐事件先捨入）
    return { d: b.d, o: b.o * fac, h: b.h * fac, l: b.l * fac, c: b.c * fac, v: b.v };
  });
}

/** 一次算好整條指標序列（暖身期為 null）。 */
export function buildInd(bars) {
  const D = bars.map((b) => b.d);
  const O = bars.map((b) => b.o);
  const H = bars.map((b) => b.h);
  const L = bars.map((b) => b.l);
  const C = bars.map((b) => b.c);
  const V = bars.map((b) => b.v);
  const n = bars.length;
  const ma20 = smaSeries(C, 20);
  const ma60 = smaSeries(C, 60);
  const vma30 = smaSeries(V, 30);
  const bias20 = new Array(n);
  for (let i = 0; i < n; i++) bias20[i] = ma20[i] === null ? null : (C[i] / ma20[i] - 1) * 100;

  const bbUp = new Array(n).fill(null);
  const bbLo = new Array(n).fill(null);
  for (let i = 19; i < n; i++) {
    const m = ma20[i];
    // Python: sum((C[j]-m)**2 for j in ...) → 同為內建 sum() → 必須 Neumaier
    const sq = new Array(20);
    for (let j = i - 19; j <= i; j++) sq[j - (i - 19)] = (C[j] - m) ** 2;
    const sd = (pySum(sq, 0, 20) / 20) ** 0.5;
    bbUp[i] = m + 2 * sd;
    bbLo[i] = m - 2 * sd;
  }

  const wr = new Array(n).fill(null);
  for (let i = 13; i < n; i++) {
    const hh = sliceMax(H, i - 13, i + 1);
    const ll = sliceMin(L, i - 13, i + 1);
    wr[i] = hh > ll ? (-100 * (hh - C[i])) / (hh - ll) : -50.0;
  }

  const tr = new Array(n);
  tr[0] = H[0] - L[0];
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
  }
  const atr22 = smaSeries(tr, ATR_N);

  const K = new Array(n).fill(null);
  const Dk = new Array(n).fill(null);
  let kv = 50.0;
  let dv = 50.0;
  for (let i = 8; i < n; i++) {
    const hh = sliceMax(H, i - 8, i + 1);
    const ll = sliceMin(L, i - 8, i + 1);
    const rsv = hh > ll ? ((C[i] - ll) / (hh - ll)) * 100 : 50.0;
    kv = (kv * 2) / 3 + rsv / 3;
    dv = (dv * 2) / 3 + kv / 3;
    K[i] = kv;
    Dk[i] = dv;
  }
  return { D, O, H, L, C, V, n, ma20, ma60, vma30, bias20, bb_up: bbUp, bb_lo: bbLo, wr, K, KD_D: Dk, atr22 };
}

function threelayerSignal(ind, t, { volMult = 1.2, needDry = true, pbHoldMA60 = true, pbBars = 10 } = {}) {
  const { C, O, H, L, V, ma20, ma60 } = ind;
  const ma60p = smaAt(C, 60, t - 20);
  const vMA = ind.vma30[t];
  const v5p = smaAt(V, 5, t - 1);
  const vMAp = smaAt(V, 30, t - 1);
  // Python: if None in (...) → 任一為 None 即 False
  if (ma20[t] === null || ma60[t] === null || ma60p === null || vMA === null || v5p === null || vMAp === null) {
    return false;
  }
  const trendOk = C[t] > ma60[t] && ma60[t] > ma60p;
  let pulled = false;
  let pbOk = true;
  for (let j = t - pbBars + 1; j <= t; j++) {
    if (ma20[j] !== null && L[j] <= ma20[j] * 1.01) pulled = true;
    if (pbHoldMA60 && ma60[j] !== null && C[j] < ma60[j]) pbOk = false;
  }
  const trigger = C[t] > O[t] && C[t] > H[t - 1] && V[t] > vMA * volMult;
  const dry = v5p < vMAp;
  return trendOk && pulled && pbOk && trigger && (!needDry || dry);
}

/** 10 進場規則（訊號在 t，進場 = t+1 開盤）。純價量。 */
export function entryRules(ind) {
  const { C, O, H, V, ma20, ma60, vma30, bias20: bias, wr, K, KD_D: Dd, bb_lo: bbLo } = ind;
  return [
    { 名稱: "跌破布林下軌", signal: (t) => bbLo[t] !== null && bbLo[t - 1] !== null && C[t] < bbLo[t] && C[t - 1] >= bbLo[t - 1] },
    { 名稱: "W%R超賣回升", signal: (t) => wr[t] !== null && wr[t - 1] !== null && wr[t - 1] < WR_OS && wr[t] >= WR_OS },
    { 名稱: "乖離率超賣", signal: (t) => bias[t] !== null && bias[t - 1] !== null && bias[t] <= BIAS_OS && bias[t - 1] > BIAS_OS },
    { 名稱: "KD低檔黃金交叉", signal: (t) => K[t] !== null && K[t - 1] !== null && K[t - 1] <= Dd[t - 1] && K[t] > Dd[t] && K[t] < KD_LOW },
    { 名稱: "三層買點v2", signal: (t) => threelayerSignal(ind, t), requireStop: true, maxStopPct: 10 },
    { 名稱: "帶量站回季線", signal: (t) => ma60[t] !== null && ma60[t - 1] !== null && vma30[t] !== null && C[t - 1] < ma60[t - 1] && C[t] >= ma60[t] && V[t] > vma30[t] * VOL_RECLAIM },
    { 名稱: "突破20日高", signal: (t) => C[t] > sliceMax(H, t - 20, t) },
    { 名稱: "均線黃金交叉", signal: (t) => ma20[t] !== null && ma60[t] !== null && ma20[t - 1] !== null && ma60[t - 1] !== null && ma20[t] > ma60[t] && ma20[t - 1] <= ma60[t - 1] },
    { 名稱: "52週新高", signal: (t) => t >= HIGH_WIN && C[t] > sliceMax(H, t - HIGH_WIN, t) },
    {
      名稱: "量縮後首爆量",
      signal: (t) => {
        const v5p = smaAt(V, 5, t - 1);
        const vmap = smaAt(V, 30, t - 1);
        return v5p !== null && vmap !== null && vma30[t] !== null &&
          v5p < vmap * BURST_DRY && V[t] > vma30[t] * BURST_VOL &&
          C[t] > O[t] * (1 + BURST_BODY / 100) && C[t] > H[t - 1];
      },
    },
  ];
}

/** 回傳 [出場日索引, 出場價, 原因] */
export function simulateExit(ind, exitName, t, entry, stop) {
  const { n, O, H, L, C, ma20, ma60, bias20: bias, bb_up: bbUp, atr22: atr } = ind;
  let hh = 0.0;
  for (let k = t + 1; k < n; k++) {
    const days = k - t;
    if (exitName === "停損10日低+破季線") {
      if (L[k] <= stop) return [k, Math.min(O[k], stop), "跌破停損"];
      if (ma60[k] !== null && C[k] < ma60[k]) return [k, C[k], "跌破季線"];
      if (days >= HORIZON) return [k, C[k], "滿60天"];
    } else if (exitName === "乖離率超買") {
      if (bias[k] !== null && bias[k] >= BIAS_OB) return [k, C[k], "乖離超買"];
      if (days >= HORIZON) return [k, C[k], "滿60天"];
    } else if (exitName === "觸布林上軌") {
      if (bbUp[k] !== null && H[k] >= bbUp[k]) return [k, C[k], "觸上軌"];
      if (days >= HORIZON) return [k, C[k], "滿60天"];
    } else if (exitName === "跌破月線") {
      if (ma20[k] !== null && C[k] < ma20[k]) return [k, C[k], "跌破月線"];
      if (days >= HORIZON) return [k, C[k], "滿60天"];
    } else if (exitName === "固定停損停利") {
      const sp = entry * (1 + FIX_STOP / 100);
      const tp = entry * (1 + FIX_TAKE / 100);
      if (O[k] <= sp) return [k, O[k], "停損"];
      if (L[k] <= sp) return [k, sp, "停損"];
      if (O[k] >= tp) return [k, O[k], "停利"];
      if (H[k] >= tp) return [k, tp, "停利"];
      if (days >= HORIZON) return [k, C[k], "滿60天"];
    } else if (exitName === "破季線讓利潤跑") {
      if (ma60[k] !== null && C[k] < ma60[k]) return [k, C[k], "跌破季線"];
    } else if (exitName === "跌破10日低(移動)") {
      if (C[k] < sliceMin(L, k - 10, k)) return [k, C[k], "跌破10日低"];
    } else if (exitName === "均線死亡交叉") {
      if (ma20[k] !== null && ma60[k] !== null && ma20[k] < ma60[k]) return [k, C[k], "死亡交叉"];
    } else if (exitName === "吊燈出場(ATR)") {
      hh = Math.max(hh, H[k]);
      if (atr[k] !== null && C[k] < hh - CHAND_MULT * atr[k]) return [k, C[k], "跌破吊燈線"];
    }
  }
  return [n - 1, C[n - 1], "資料結束"];
}

/** 跑單一組合。回傳 { trades, skipped }；trades 為引擎內部完整欄位。 */
export function runCombo(ind, rule, exitName, { skipLimitUp = true } = {}) {
  const { n, O, H, L, C } = ind;
  const trades = [];
  let skipped = 0;
  let inPosUntil = -1;
  for (let t = WARMUP; t < n - 1; t++) {
    if (t <= inPosUntil) continue;
    if (!rule.signal(t)) continue;
    const entry = O[t + 1];
    if (skipLimitUp && entry >= C[t] * LIMIT_UP) { skipped++; continue; }
    const stop = sliceMin(L, t - 9, t + 1);
    if (rule.requireStop && entry <= stop) continue;
    const msp = rule.maxStopPct || 0;
    if (msp && ((entry - stop) / entry) * 100 > msp) continue;
    const [k, exitp, reason] = simulateExit(ind, exitName, t, entry, stop);
    const retn = (exitp * (1 - FEE_SELL - TAX_SELL)) / (entry * (1 + FEE_BUY)) - 1;
    // MAE/MFE：持有期(進場日 t+1 ~ 出場日 k，含頭尾) 最低/最高價對進場價，毛值（未扣費稅）
    const lo = sliceMin(L, t + 1, k + 1);
    const hi = sliceMax(H, t + 1, k + 1);
    trades.push({
      持有天數: k - t,
      _retn: retn * 100,
      _si: t, _ei: t + 1, _xi: k,
      _ep: entry, _xp: exitp,
      _rc: RC[reason] ?? EXIT_REASONS.length - 1,
      _mae: (lo / entry - 1) * 100,
      _mfe: (hi / entry - 1) * 100,
    });
    inPosUntil = k;
  }
  return { trades, skipped };
}

/**
 * 加掛確認層（籌碼），回傳新的規則物件。與 Python layer_signal 同義：
 *   投信     = 投信近10日累買 ≥ 15 張
 *   法人同買 = 投信達標 且 外資近10日淨買 > 0
 *   大盤多頭 = 加權 > 200 日均線
 *   浮額清洗 = 融資餘額 < 20 個交易日前（含「t≥20 且兩端皆有資料」，已編進位元）
 *
 * 順序：先問確認層再問基礎訊號 —— 與 Python 相同。這會影響 `skipped`：
 * 被確認層擋下的訊號【不計入】漲停跳過數（run_combo 只在基礎訊號成立後才數）。
 */
function layerRule(tag, rule, series) {
  if (tag === "無") return rule;
  const { trustOk, foreignOk, washOk, mktOk } = series;
  const base = rule.signal;
  let gate;
  if (tag === "投信") gate = (t) => trustOk[t];
  else if (tag === "法人同買") gate = (t) => trustOk[t] && foreignOk[t];
  else if (tag === "大盤多頭") gate = (t) => mktOk[t];
  else if (tag === "浮額清洗") gate = (t) => washOk[t];
  else return rule;
  return { ...rule, signal: (t) => gate(t) && base(t) };
}

/** 組合統計（欄位與 Python combo_stats 相同；捨入用 pyRound）。 */
export function comboStats(trades) {
  if (trades.length === 0) {
    return { 交易次數: 0, "總報酬%": 0.0, "勝率%": null, "平均報酬%": null, 平均持有天數: null, "最大回撤%": null };
  }
  const rets = trades.map((t) => t._retn);
  let eq = 1.0, peak = 1.0, mdd = 0.0;
  for (const r of rets) {
    eq *= 1 + r / 100;
    peak = Math.max(peak, eq);
    mdd = Math.max(mdd, (peak - eq) / peak);
  }
  let wins = 0;
  for (const r of rets) if (r > 0) wins++;
  const sumR = pySum(rets, 0, rets.length);                       // Python sum(rets)
  const holds = trades.map((t) => t.持有天數);
  const sumH = pySum(holds, 0, holds.length);                     // Python sum(持有天數)
  return {
    交易次數: trades.length,
    "總報酬%": pyRound((eq - 1) * 100, 2),
    "勝率%": pyRound((wins / trades.length) * 100, 1),
    "平均報酬%": pyRound(sumR / trades.length, 2),
    平均持有天數: pyRound(sumH / trades.length, 1),
    "最大回撤%": pyRound(mdd * 100, 2),
  };
}

/** 同期買進持有（含息還原、內扣費稅）。 */
export function buyHold(adjBars) {
  const C = adjBars.map((b) => b.c);
  let peak = C[0], mdd = 0.0;
  for (const c of C) { peak = Math.max(peak, c); mdd = Math.max(mdd, (peak - c) / peak); }
  const net = (C[C.length - 1] * (1 - FEE_SELL - TAX_SELL)) / (C[0] * (1 + FEE_BUY)) - 1;
  return { "總報酬%": pyRound(net * 100, 2), "最大回撤%": pyRound(mdd * 100, 2) };
}

/**
 * 主入口：跑完整組合矩陣，輸出與 signals/{code}.json 同構的結構。
 * @param {{d:string,o:number,h:number,l:number,c:number,v:number}[]} bars 原始（未還原）日K，由舊到新
 * @param {{exEvents?:{date:string,ratio:number}[], confirm?:{layers:string[],series:object}}} [opts]
 */
export function runBacktest(bars, opts = {}) {
  const adj = adjustBars(bars, opts.exEvents);
  const ind = buildInd(adj);
  // 確認層：未提供 confirm → 僅「無」層（90 組）；提供則跑滿 5 層（450 組）
  const layers = opts.confirm?.layers?.length ? opts.confirm.layers : ["無"];
  const series = opts.confirm?.series;
  if (layers.some((l) => l !== "無") && !series) {
    throw new Error("confirm.layers 含籌碼層時必須提供 confirm.series（見 chipsbits.mjs 的 makeConfirm）");
  }
  if (series) {
    for (const k of ["trustOk", "foreignOk", "washOk", "mktOk"]) {
      if (!Array.isArray(series[k]) || series[k].length !== ind.n) {
        throw new Error(`confirm.series.${k} 長度須等於 K 棒數 ${ind.n}（收到 ${series[k]?.length}）`);
      }
    }
  }
  const rules = entryRules(ind);
  const combos = [];
  for (let ei = 0; ei < rules.length; ei++) {
    for (let xi = 0; xi < EXIT_NAMES.length; xi++) {
      for (let ci = 0; ci < layers.length; ci++) {
        const rule = layerRule(layers[ci], rules[ei], series);
        const { trades, skipped } = runCombo(ind, rule, EXIT_NAMES[xi]);
        const st = comboStats(trades);
        combos.push({
          s: [ei, xi, ci, st.交易次數, st["勝率%"], st["平均報酬%"], st["總報酬%"], st["最大回撤%"], st.平均持有天數, skipped],
          t: trades.map((t) => [
            t._si, t._ei, t._xi, pyRound(t._ep, 4), pyRound(t._xp, 4),
            t._rc, pyRound(t._retn, 6), pyRound(t._mae, 4), pyRound(t._mfe, 4),
          ]),
        });
      }
    }
  }
  return {
    meta: {
      期間: [ind.D[0], ind.D[ind.n - 1]],
      交易日數: ind.n,
      confLayers: layers,
      entryRules: rules.map((r) => r.名稱),
      exitRules: EXIT_NAMES,
      exitReasons: EXIT_REASONS,
      comboFields: ["ei", "xi", "ci", "交易次數", "勝率%", "平均報酬%", "總報酬%", "最大回撤%", "平均持有天數", "skipped"],
      tradeFields: ["si", "ei", "xi", "ep", "xp", "rc", "r", "mae", "mfe"],
    },
    buyhold: buyHold(adj),
    combos,
    prices: {
      dates: ind.D,
      o: ind.O.map((v) => pyRound(v, 4)),
      h: ind.H.map((v) => pyRound(v, 4)),
      l: ind.L.map((v) => pyRound(v, 4)),
      c: ind.C.map((v) => pyRound(v, 4)),
      v: ind.V,
    },
  };
}

export { pyRound };
export default runBacktest;
