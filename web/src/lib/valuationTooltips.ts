/**
 * 估值指標卡片：懸浮／焦點／點按顯示之簡短說明（中文）。
 * key 與 parseReport VAL_KEYS（估值卡片）/ ValuationSection data-val-key 一致。
 */
export const VALUATION_METRIC_HINTS: Record<string, string> = {
  peTtm:
    "本益比（P/E，TTM）＝股價 ÷ 近四季每股盈餘。數字愈高通常代表市場給予較高成長預期或估值較貴；虧損時無法計算（顯示 —）。資料取自證交所官方每日揭露。",
  dividendYield:
    "殖利率＝近一年現金股利 ÷ 股價。反映以現價買進的配息報酬率；當年未配息為 0%。資料取自證交所官方每日揭露。",
  pb:
    "股價淨值比（P/B）＝股價 ÷ 每股淨值。常見於金融、資產導向產業；低於 1 表示市價低於帳面淨值。",
  beta:
    "Beta 衡量股價相對大盤的波動度；以近一年週報酬對加權指數（上市）／櫃買指數（上櫃）計算。約 1 與大盤相近，大於 1 波動通常較大；上市未滿一年顯示 —。",
};

export function valuationHintForKey(key: string): string {
  return VALUATION_METRIC_HINTS[key] ?? "";
}
