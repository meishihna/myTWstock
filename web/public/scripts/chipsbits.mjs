/**
 * 確認層位元圖解碼器 —— 把 chips-bits.json 還原成對齊 K 棒的布林序列。
 *
 * 為什麼是「位元圖」而不是把籌碼數字全存下來：確認層只需要 4 個是非題，
 * 每股每日 3 bits + 全市場共用 1 bit/日，比存原始股數/餘額小兩個數量級。
 *
 * ⚠️ 位元是在【該股自己的交易日軸】上算好的（10 日累買、20 日融資回看都是「交易日」不是日曆日）。
 *    解碼端一律【按日期對齊】，不可用索引硬套 —— 停牌會讓兩邊的索引錯開。
 *
 * 純函式、無相依，Node 與瀏覽器共用。
 */

/** base64 → Uint8Array（Node 與瀏覽器都有 atob） */
function b64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const bitAt = (buf, pos) => (buf[pos >> 3] >> (pos & 7)) & 1;

/**
 * 把位元圖解成對齊 `barDates` 的布林序列。
 *
 * @param {object} bitsJson  chips-bits.json 的內容
 * @param {string} code      股票代號
 * @param {string[]} barDates 該股的 K 棒日期（ISO，由舊到新；即餵給 runBacktest 的那批）
 * @returns {{trustOk:boolean[], foreignOk:boolean[], washOk:boolean[], mktOk:boolean[], covered:number}}
 *          covered = barDates 中確實在位元圖日曆內的天數（可用來判斷資料是否過期）
 */
export function decodeChipsBits(bitsJson, code, barDates) {
  const n = barDates.length;
  const trustOk = new Array(n).fill(false);
  const foreignOk = new Array(n).fill(false);
  const washOk = new Array(n).fill(false);
  const mktOk = new Array(n).fill(false);

  const packed = bitsJson.bits?.[code];
  const mkt = bitsJson.market ? b64(bitsJson.market) : null;
  if (!bitsJson.dates) return { trustOk, foreignOk, washOk, mktOk, covered: 0 };

  // 日期 → 位元圖日曆索引
  let index = bitsJson._index;
  if (!index) {
    index = new Map(bitsJson.dates.map((d, i) => [d, i]));
    // 快取到不可列舉的欄位（JSON.stringify 不會帶出去）；物件被凍結時就算了，不要因此壞掉
    try {
      Object.defineProperty(bitsJson, "_index", { value: index, enumerable: false });
    } catch { /* frozen input：每次重建，功能不變 */ }
  }

  const buf = packed ? b64(packed) : null;
  let covered = 0;
  for (let t = 0; t < n; t++) {
    const j = index.get(barDates[t]);
    if (j === undefined) continue;            // 位元圖沒這天（資料較舊／該日無揭露）→ 全部 false
    covered++;
    if (mkt) mktOk[t] = bitAt(mkt, j) === 1;
    if (buf) {
      const p = j * 3;
      trustOk[t] = bitAt(buf, p) === 1;
      foreignOk[t] = bitAt(buf, p + 1) === 1;
      washOk[t] = bitAt(buf, p + 2) === 1;
    }
  }
  return { trustOk, foreignOk, washOk, mktOk, covered };
}

/**
 * 便利函式：直接產生 runBacktest 需要的 opts.confirm。
 * 個股不在位元圖內（上櫃／新上市）時回傳 null —— 呼叫端應據此只跑 90 組並在 UI 標示。
 */
export const DEFAULT_LAYERS = ["無", "投信", "法人同買", "大盤多頭", "浮額清洗"];

export function makeConfirm(bitsJson, code, barDates) {
  if (!bitsJson?.bits?.[code]) return null;
  // confLayers 缺漏時退回標準 5 層，而不是靜默只跑 90 組讓人以為那就是全部
  const layers = bitsJson.confLayers?.length ? bitsJson.confLayers : DEFAULT_LAYERS;
  return { layers, series: decodeChipsBits(bitsJson, code, barDates) };
}

export default decodeChipsBits;
