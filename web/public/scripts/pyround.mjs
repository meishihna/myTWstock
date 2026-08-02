/**
 * Python 相容的 round() —— half-to-even，且對「double 的精確二進位值」取捨。
 *
 * 為什麼不能用 Math.round / toFixed：
 *   - Math.round(x*100)/100 是「半數進位」→ 勝率 56.25 會變 56.3，Python 給 56.2。
 *     實測真實回測資料 19,656 個統計值中有 71 個(0.36%)因此不同 → 回歸無法 0 差。
 *   - toFixed 是「半數遠離零」，且部分引擎有精度瑕疵，同樣不等價。
 *
 * 正確做法（同 CPython double_round）：
 *   double 都能以有限十進位精確表示。把 x 拆成 m·2^e（m 為 53 bit 整數），
 *   用 BigInt 精確計算 x·10^nd = 分子/分母，對餘數做 half-to-even，
 *   再以一次浮點除法還原 —— 除法是正確捨入，等同 CPython 將十進位字串 strtod 回來。
 *
 * 純函式、無相依，Node 與瀏覽器共用。
 */

/** 把 double 拆成 { sign, mant: BigInt, exp } 使得 |x| = mant · 2^exp（精確） */
function decompose(x) {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const hi = buf.getUint32(0);
  const lo = buf.getUint32(4);
  const sign = hi >>> 31 ? -1 : 1;
  const rawExp = (hi >>> 20) & 0x7ff;
  const hiMant = BigInt(hi & 0xfffff);
  const mantBits = (hiMant << 32n) | BigInt(lo);
  if (rawExp === 0) {
    // 次正規數：|x| = mantBits · 2^(-1074)
    return { sign, mant: mantBits, exp: -1074 };
  }
  // 正規數：|x| = (2^52 + mantBits) · 2^(rawExp-1075)
  return { sign, mant: (1n << 52n) | mantBits, exp: rawExp - 1075 };
}

/**
 * Python round(x, nd) 的等價實作。
 * @param {number} x
 * @param {number} [nd=0] 小數位數（本專案只用 0/1/2/4/6）
 * @returns {number}
 */
export function pyRound(x, nd = 0) {
  if (!Number.isFinite(x)) return x;
  if (x === 0) return x; // 保留 -0
  const { sign, mant, exp } = decompose(x);

  // |x|·10^nd = num / den（精確有理數）
  let num = mant;
  let den = 1n;
  const p10 = 10n ** BigInt(Math.abs(nd));
  if (nd >= 0) num *= p10;
  else den *= p10;
  if (exp >= 0) num <<= BigInt(exp);
  else den <<= BigInt(-exp);

  // q = round_half_even(num / den)
  let q = num / den;
  const r2 = (num - q * den) * 2n; // 餘數×2，與 den 比大小即可判半
  if (r2 > den || (r2 === den && (q & 1n) === 1n)) q += 1n;

  // 還原：一次浮點除法（正確捨入）→ 等同 CPython 由十進位字串 strtod 回來
  const out = nd >= 0 ? Number(q) / Number(p10) : Number(q) * Number(p10);
  return sign < 0 ? -out : out;
}

export default pyRound;
