/**
 * 客戶端共用:squarified treemap 版面 + 漲跌配色(紅漲綠跌)。純函式、無相依,
 * 供 /map 題材熱力圖與主題頁個股熱力圖共用。
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function worstRatio(row: { area: number }[], side: number): number {
  let sum = 0,
    max = -Infinity,
    min = Infinity;
  for (const it of row) {
    sum += it.area;
    if (it.area > max) max = it.area;
    if (it.area < min) min = it.area;
  }
  if (sum <= 0) return Infinity;
  const s2 = sum * sum,
    l2 = side * side;
  return Math.max((l2 * max) / s2, s2 / (l2 * min));
}

/** 將 nodes(含 value)以 squarified treemap 排入矩形,回傳每個 node 加上 x/y/w/h。 */
export function treemap<T extends { value: number }>(
  nodes: T[],
  X: number,
  Y: number,
  W: number,
  H: number,
): (T & Rect)[] {
  const total = nodes.reduce((s, n) => s + Math.max(0, n.value), 0) || 1;
  const scale = (W * H) / total;
  const items = nodes.map((n) => ({ n, area: Math.max(0, n.value) * scale }));
  const out: (T & Rect)[] = [];
  let x = X,
    y = Y,
    w = W,
    h = H,
    i = 0;
  while (i < items.length) {
    const side = Math.min(w, h);
    let row: typeof items = [];
    while (i < items.length) {
      const cand = row.concat(items[i]);
      if (row.length === 0 || worstRatio(cand, side) <= worstRatio(row, side)) {
        row = cand;
        i++;
      } else break;
    }
    const rowArea = row.reduce((s, it) => s + it.area, 0);
    if (w >= h) {
      const colW = rowArea / h || 0;
      let cy = y;
      for (const it of row) {
        const ih = colW > 0 ? it.area / colW : 0;
        out.push({ ...(it.n as T), x, y: cy, w: colW, h: ih });
        cy += ih;
      }
      x += colW;
      w -= colW;
    } else {
      const rowH = rowArea / w || 0;
      let cx = x;
      for (const it of row) {
        const iw = rowH > 0 ? it.area / rowH : 0;
        out.push({ ...(it.n as T), x: cx, y, w: iw, h: rowH });
        cx += iw;
      }
      y += rowH;
      h -= rowH;
    }
  }
  return out;
}

/** 漲跌配色:紅漲綠跌(暖調低彩,襯深底)。pct=null 為等待報價。 */
// 動態連續配色(台股慣例):接近平盤=淺,漲跌越大顏色越深;紅漲綠跌。
// ±MAX% 達最深。由「淺色」線性插值到「深色」。
function tileRGB(pct: number | null): [number, number, number] {
  if (pct == null) return [185, 183, 177]; // 無資料:淺灰
  const a = Math.abs(pct);
  if (a < 0.15) return [197, 195, 189]; // 平盤:淺灰
  const t = Math.min(a / 6, 1); // 線性,越大越深
  const light = pct > 0 ? [223, 196, 194] : [196, 223, 202]; // 淺紅 / 淺綠
  const deep = pct > 0 ? [135, 27, 24] : [19, 84, 47]; // 深紅 / 深綠
  return [
    Math.round(light[0] + (deep[0] - light[0]) * t),
    Math.round(light[1] + (deep[1] - light[1]) * t),
    Math.round(light[2] + (deep[2] - light[2]) * t),
  ];
}
export function tileColor(pct: number | null): string {
  const [r, g, b] = tileRGB(pct);
  return `rgb(${r},${g},${b})`;
}
/** WCAG 相對亮度(sRGB) */
function relLum(r: number, g: number, b: number): number {
  const f = (v: number) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/**
 * 磚上文字色:在「深字/淺字」兩候選中取 WCAG 對比較高者。
 * 原本用固定感知亮度門檻(>148),中間色調(如 +3% 的中紅 #b4716e)會挑錯 → 對比僅 3.43;
 * 改為實算對比後同一磚可得 5.17。磚底色本身是資料驅動(紅漲綠跌)、深淺主題相同。
 */
export function tileTextColor(pct: number | null): string {
  const [r, g, b] = tileRGB(pct);
  const L = relLum(r, g, b);
  const cr = (a: number, x: number) =>
    (Math.max(a, x) + 0.05) / (Math.min(a, x) + 0.05);
  const dark = relLum(11, 12, 14);
  const light = relLum(245, 243, 238);
  return cr(L, dark) >= cr(L, light) ? "#0b0c0e" : "#f5f3ee";
}
