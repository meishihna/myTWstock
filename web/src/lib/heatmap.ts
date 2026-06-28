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
// 動態連續配色(參照 TradingView):由中性灰平滑插值到端點色,越大越濃;紅漲綠跌。
// ±MAX% 達最飽和;sqrt 讓小幅也看得出顏色。
export function tileColor(pct: number | null): string {
  if (pct == null) return "#2a2620";
  const MAX = 6;
  const t = Math.sqrt(Math.min(Math.abs(pct) / MAX, 1));
  const g = [58, 53, 46]; // 近 0% 中性灰 #3a352e
  const end = pct >= 0 ? [238, 70, 64] : [21, 171, 122]; // 漲=亮紅 #ee4640 / 跌=亮綠 #15ab7a
  const c = (i: number) => Math.round(g[i] + (end[i] - g[i]) * t);
  return `rgb(${c(0)},${c(1)},${c(2)})`;
}
