/**
 * 官方代碼 → Yahoo 後綴對照(上市 .TW / 上櫃 .TWO),來源:TWSE ISIN 官方頁
 * (scripts/build_stock_codes.py → web/src/lib/stockSuffix.json,bundle 進 serverless)。
 *
 * 用途:抓 Yahoo 前先選對後綴,省掉上櫃股「先撞 .TW 失敗再試 .TWO」的無效請求。
 * 未知代碼(興櫃/ETF/新掛牌未收錄)回傳預設順序,仍雙試 → 不會退化。
 */
import suffixMap from "./stockSuffix.json";

const MAP = suffixMap as Record<string, string>;

export type TwSuffix = ".TW" | ".TWO";

/** 官方市場別對應的後綴;未知回 null */
export function preferredSuffix(ticker: string): TwSuffix | null {
  const s = MAP[ticker];
  return s === ".TW" || s === ".TWO" ? s : null;
}

/**
 * 嘗試順序:已知上櫃 → [.TWO, .TW];其餘(上市/未知)→ [.TW, .TWO]。
 * 一律保留兩者作備援,故對未收錄代碼與現行行為完全一致。
 */
export function suffixOrder(ticker: string): readonly [TwSuffix, TwSuffix] {
  return preferredSuffix(ticker) === ".TWO" ? [".TWO", ".TW"] : [".TW", ".TWO"];
}
