/**
 * K 線 + 成交量：佈局與每根 K 的 SVG 座標（漲綠跌紅）。
 */

export interface CandlestickData {
  x: number;
  bodyTop: number;
  bodyBottom: number;
  wickTop: number;
  wickBottom: number;
  color: string;
  volHeight: number;
  volColor: string;
}

export interface ChartLayout {
  candles: CandlestickData[];
  candleWidth: number;
  svgWidth: number;
  svgHeight: number;
  priceAreaHeight: number;
  /** K 線區底與月份標籤帶之間（標籤畫在此帶內） */
  dateLabelY: number;
  volumeAreaTop: number;
  volumeAreaHeight: number;
  /** K 線區與成交量區之間分隔線 Y */
  volumeSeparatorY: number;
  priceLabels: { y: number; label: string }[];
  dateLabels: { x: number; label: string }[];
  leftPad: number;
  rightPad: number;
  topPad: number;
  bottomPad: number;
  /** 圖區內每根 K 所占寬度（viewBox 單位） */
  slotSvg: number;
  /** 5／10／20 日均線 path（價格區內；略過 null 斷筆） */
  maPaths: { key: string; d: string; color: string }[];
}

function niceRound(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const frac = value / Math.pow(10, exp);
  let nice: number;
  if (frac <= 1.5) nice = 1;
  else if (frac <= 3.5) nice = 2;
  else if (frac <= 7.5) nice = 5;
  else nice = 10;
  return nice * Math.pow(10, exp);
}

function maLinePathD(
  series: (number | null)[],
  n: number,
  xAt: (i: number) => number,
  yAt: (price: number) => number,
): string {
  let d = "";
  let pen = false;
  for (let i = 0; i < n; i++) {
    const v = series[i];
    if (v == null || !Number.isFinite(v)) {
      pen = false;
      continue;
    }
    const px = xAt(i);
    const py = yAt(v);
    if (!pen) {
      d += (d ? " " : "") + `M${px},${py}`;
      pen = true;
    } else {
      d += ` L${px},${py}`;
    }
  }
  return d;
}

export function buildCandlestickChart(
  dates: string[],
  open: number[],
  high: number[],
  low: number[],
  close: number[],
  volume: number[],
  ma5In?: (number | null)[] | null,
  ma10In?: (number | null)[] | null,
  ma20In?: (number | null)[] | null,
  svgWidth = 660,
  svgHeight = 320,
  /** 預留較寬左欄，避免 Y 軸價格字被壓縮 */
  leftPad = 62,
  rightPad = 10,
  topPad = 8,
  bottomPad = 5,
): ChartLayout | null {
  const n = open.length;
  if (n < 2 || dates.length !== n) return null;

  const priceAreaHeight = Math.round(svgHeight * 0.75);
  const labelBand = 12;
  const volumeSeparatorY = priceAreaHeight + labelBand;
  const volumeAreaTop = volumeSeparatorY;
  const volumeAreaHeight = svgHeight - volumeAreaTop - bottomPad;
  const dateLabelY = priceAreaHeight + Math.round(labelBand * 0.72);

  let allHigh = Math.max(...high);
  let allLow = Math.min(...low);
  const foldMa = (arr: (number | null)[] | null | undefined) => {
    if (!arr || arr.length !== n) return;
    for (const v of arr) {
      if (v != null && Number.isFinite(v)) {
        allHigh = Math.max(allHigh, v);
        allLow = Math.min(allLow, v);
      }
    }
  };
  foldMa(ma5In);
  foldMa(ma10In);
  foldMa(ma20In);

  const priceRange = allHigh - allLow || 1;
  const pricePad = priceRange * 0.05;
  const priceMax = allHigh + pricePad;
  const priceMin = allLow - pricePad;
  const priceSpan = priceMax - priceMin || 1;

  const maxVol = Math.max(...volume, 1);

  const chartWidth = svgWidth - leftPad - rightPad;
  const slotWidth = chartWidth / n;
  let candleWidth = Math.max(3, Math.min(6, slotWidth * 0.65));
  candleWidth = Math.min(candleWidth, Math.max(3, slotWidth - 1));

  const xCenter = (i: number) => leftPad + i * slotWidth + slotWidth / 2;

  function priceToY(price: number): number {
    return (
      topPad +
      ((priceMax - price) / priceSpan) * (priceAreaHeight - topPad * 2)
    );
  }

  const tickCount = 5;
  const tickStep = priceSpan / tickCount;
  const niceStep = niceRound(tickStep);
  const firstTick = Math.ceil(priceMin / niceStep) * niceStep;
  const priceLabels: { y: number; label: string }[] = [];
  for (let p = firstTick; p <= priceMax + niceStep * 0.001; p += niceStep) {
    if (priceLabels.length >= 8) break;
    priceLabels.push({
      y: priceToY(p),
      label: p.toLocaleString("zh-TW", {
        maximumFractionDigits: 2,
        minimumFractionDigits: 0,
      }),
    });
  }

  const dateLabels: { x: number; label: string }[] = [];
  let lastMonth = "";
  let lastLabelIdx = -999;
  let lastLabelX = -1e9;
  const minBarGap = 22;
  const minLabelXGap = 40;
  for (let i = 0; i < n; i++) {
    const d = dates[i]!;
    const month = d.length >= 7 ? d.substring(0, 7) : "";
    const monthChanged = Boolean(month && month !== lastMonth);
    const spacedEnough = i - lastLabelIdx >= minBarGap;
    if (!(monthChanged || spacedEnough)) continue;
    const x = xCenter(i);
    if (dateLabels.length > 0 && x - lastLabelX < minLabelXGap) continue;
    const m = parseInt(d.substring(5, 7), 10);
    if (Number.isNaN(m)) continue;
    dateLabels.push({ x, label: `${m}月` });
    if (monthChanged) lastMonth = month;
    lastLabelIdx = i;
    lastLabelX = x;
  }

  const candles: CandlestickData[] = [];
  for (let i = 0; i < n; i++) {
    const x = xCenter(i);
    const isUp = close[i]! >= open[i]!;
    const color = isUp ? "#1D9E75" : "#E24B4A";

    let bodyTop = priceToY(Math.max(open[i]!, close[i]!));
    let bodyBottom = priceToY(Math.min(open[i]!, close[i]!));
    if (bodyBottom - bodyTop < 2) {
      const mid = (bodyTop + bodyBottom) / 2;
      bodyTop = mid - 1;
      bodyBottom = mid + 1;
    }

    const volHeight = (volume[i]! / maxVol) * volumeAreaHeight;
    const volColor = isUp
      ? "rgba(29,158,117,0.4)"
      : "rgba(226,75,74,0.4)";

    candles.push({
      x,
      bodyTop,
      bodyBottom,
      wickTop: priceToY(high[i]!),
      wickBottom: priceToY(low[i]!),
      color,
      volHeight,
      volColor,
    });
  }

  const maPaths: { key: string; d: string; color: string }[] = [];
  const maSpecs: { key: string; arr: (number | null)[] | null | undefined; color: string }[] = [
    { key: "ma5", arr: ma5In, color: "#F0B429" },
    { key: "ma10", arr: ma10In, color: "#6BA3E8" },
    { key: "ma20", arr: ma20In, color: "#B388FF" },
  ];
  for (const { key, arr, color } of maSpecs) {
    if (!arr || arr.length !== n) continue;
    const d = maLinePathD(arr, n, xCenter, priceToY);
    if (d) maPaths.push({ key, d, color });
  }

  return {
    candles,
    candleWidth,
    svgWidth,
    svgHeight,
    priceAreaHeight,
    dateLabelY,
    volumeAreaTop,
    volumeAreaHeight,
    volumeSeparatorY,
    priceLabels,
    dateLabels,
    leftPad,
    rightPad,
    topPad,
    bottomPad,
    slotSvg: slotWidth,
    maPaths,
  };
}
