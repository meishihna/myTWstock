/**
 * 估值指標卡片：懸浮／焦點／點按顯示之簡短說明（中文）。
 * key 與 parseReport VAL_KEYS（估值卡片）/ ValuationSection data-val-key 一致。
 */
export const VALUATION_METRIC_HINTS: Record<string, string> = {
  peTtm:
    "本益比（P/E，TTM）＝股價 ÷ 近四季每股盈餘。數字愈高通常代表市場給予較高成長預期或估值較貴；虧損時常無法計算。本頁倍數可能已依延遲行情股價換算。",
  forwardPe:
    "前瞻本益比＝股價 ÷ 預估未來盈餘，反映分析師或公司展望，與已實現的 TTM 本益比口徑不同。",
  psTtm:
    "股價營收比（P/S）＝市值 ÷ 營收（常為近十二個月）。可用於獲利波動大或尚未穩定獲利的公司。",
  pb:
    "股價淨值比（P/B）＝股價 ÷ 每股淨值。常見於金融、資產導向產業；低於 1 表示市價低於帳面淨值。",
  evEbitda:
    "EV/EBITDA＝企業價值 ÷ 息稅折舊攤銷前盈餘。兼顧負債結構，常用於跨公司比較。",
  beta:
    "Beta 衡量股價相對大盤的波動度；約 1 表示與大盤相近，大於 1 波動通常較大。",
  debtEquity:
    "負債權益比＝總負債 ÷ 股東權益，反映槓桿程度；產業與商業模式不同，合理區間差異大。",
};

export function valuationHintForKey(key: string): string {
  return VALUATION_METRIC_HINTS[key] ?? "";
}
