/**
 * 官方個股 metadata(build 時由 fs 讀 data/stock_codes.json 全量)。
 *
 * 與 stockCodes.ts 分工:stockCodes.ts 走 bundle 的精簡 code→suffix(serverless runtime),
 * 這裡走 fs 讀全量(name/market/industry/isin/listDate),僅供 SSG 預渲染(build 時)使用。
 * 對照表由 scripts/build_stock_codes.py 產生;cwd=web/,故 ../data/stock_codes.json。
 */
import fs from "node:fs";
import path from "node:path";

export interface StockMeta {
  name: string;
  market: string; // 上市 / 上櫃
  suffix: string; // .TW / .TWO
  industry: string; // 官方 TWSE 產業別(中文)
  isin: string;
  listDate: string;
}

let _map: Record<string, StockMeta> | null = null;

function load(): Record<string, StockMeta> {
  if (_map) return _map;
  try {
    const p = path.join(process.cwd(), "..", "data", "stock_codes.json");
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as {
      codes?: Record<string, StockMeta>;
    };
    _map = j.codes ?? {};
  } catch {
    _map = {};
  }
  return _map;
}

export function stockMetaFor(ticker: string): StockMeta | null {
  return load()[ticker] ?? null;
}

/** 官方 TWSE 產業別(中文);無則 null */
export function officialIndustryFor(ticker: string): string | null {
  const ind = load()[ticker]?.industry?.trim();
  return ind ? ind : null;
}
