/**
 * 折線 / 回撤面積的 SVG 幾何 —— **純函式,不碰 DOM**
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 `null` 必須讓線【斷開】,不可連過去。
 *    連過去會把「那幾天算不出淨值」畫成一條平滑的直線 ——
 *    看起來完全正常,而那正是最難查的錯。
 *    (同族:財務線那次「負段被靜默丟棄、總高被高估」。)
 *
 * 🔴 X 軸用【索引】等距,不用日曆日。
 *    交易日軸上 7/03 與 7/06 是相鄰的兩根;用日曆日會在每個週末留下空白,
 *    而那個空白不是資訊,是曆法。
 * ══════════════════════════════════════════════════════════════════════════
 */

export type Pt = { date: string; v: number | null };

export type LineChart = {
  w: number;
  h: number;
  /** 每一段連續有值的折線各自一個 path —— 斷開處不相連 */
  paths: string[];
  /** 供 y 軸標示 */
  yMin: number;
  yMax: number;
  ticks: { v: number; y: number }[];
  /** 有幾個點是 null(必須顯示出來) */
  gaps: number;
};

const niceStep = (raw: number) => {
  if (!(raw > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
};

export function buildLineChart(
  pts: Pt[],
  opts: { w?: number; h?: number; pad?: number; zeroBased?: boolean; tickCount?: number } = {}
): LineChart {
  const w = opts.w ?? 640;
  const h = opts.h ?? 180;
  const pad = opts.pad ?? 4;
  const vals = pts.map((p) => p.v).filter((v): v is number => v != null && Number.isFinite(v));
  const gaps = pts.length - vals.length;

  if (!vals.length || pts.length < 2) {
    return { w, h, paths: [], yMin: 0, yMax: 1, ticks: [], gaps };
  }

  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (opts.zeroBased) {
    /* 回撤:上界固定 0(0 = 沒有回落),下界取最深 */
    hi = 0;
    lo = Math.min(lo, 0);
  }
  if (lo === hi) {
    /* 一條水平線:給它一點高度,否則除以 0 */
    lo -= Math.abs(lo || 1) * 0.01;
    hi += Math.abs(hi || 1) * 0.01;
  }
  const step = niceStep((hi - lo) / (opts.tickCount ?? 4));
  const yMin = Math.floor(lo / step) * step;
  const yMax = Math.ceil(hi / step) * step;

  const innerH = h - pad * 2;
  const yOf = (v: number) => pad + ((yMax - v) / (yMax - yMin)) * innerH;
  const xOf = (i: number) => (pts.length === 1 ? w / 2 : (i / (pts.length - 1)) * w);

  /* 🔴 逐段切:遇到 null 就結束當前段。單點段也要畫(用一個極短的線段),
     否則「只有一天有值」會完全消失,而消失與 0 無法區分。 */
  const paths: string[] = [];
  let cur: string[] = [];
  pts.forEach((p, i) => {
    if (p.v == null || !Number.isFinite(p.v)) {
      if (cur.length) paths.push(cur.join(" "));
      cur = [];
      return;
    }
    cur.push(`${cur.length ? "L" : "M"}${xOf(i).toFixed(2)},${yOf(p.v).toFixed(2)}`);
  });
  if (cur.length) paths.push(cur.join(" "));

  const ticks: { v: number; y: number }[] = [];
  for (let v = yMin; v <= yMax + step * 1e-9; v += step) ticks.push({ v, y: yOf(v) });

  return { w, h, paths, yMin, yMax, ticks, gaps };
}

/** 回撤面積:從 0 那條線往下填。與折線共用同一套 y 映射。 */
export function buildDrawdownArea(pts: Pt[], opts: { w?: number; h?: number; pad?: number } = {}) {
  const c = buildLineChart(pts, { ...opts, zeroBased: true, tickCount: 2 });
  if (!c.paths.length) return { ...c, areas: [] as string[] };
  const pad = opts.pad ?? 4;
  const innerH = c.h - pad * 2;
  const zeroY = pad + ((c.yMax - 0) / (c.yMax - c.yMin)) * innerH;
  /* 每一段折線各自封成一個面積(斷開處不相連) */
  const areas = c.paths.map((d) => {
    const nums = [...d.matchAll(/[ML]([\d.]+),([\d.]+)/g)];
    if (!nums.length) return "";
    const x0 = nums[0]![1];
    const x1 = nums[nums.length - 1]![1];
    return `${d} L${x1},${zeroY.toFixed(2)} L${x0},${zeroY.toFixed(2)} Z`;
  });
  return { ...c, areas, zeroY };
}
