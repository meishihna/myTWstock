"""
build_stock_codes.py — 由 TWSE ISIN 官方頁建立「代碼 → 市場別/後綴/產業別」對照表。

來源(免費、官方,整個市場僅 2 個請求):
  上市 https://isin.twse.com.tw/isin/C_public.jsp?strMode=2
  上櫃 https://isin.twse.com.tw/isin/C_public.jsp?strMode=4

用途:讓抓 Yahoo 時能「直接選對後綴」(上市 .TW / 上櫃 .TWO),
省掉全上櫃股先撞 .TW 失敗再試 .TWO 的無效請求(TS priceCache 與 Python 管線共用)。

輸出 data/stock_codes.json:
  { "counts": {"上市":N,"上櫃":M}, "codes": { "2330": {name,market,suffix,industry,isin,listDate}, ... } }
  (刻意不寫時間戳 → 內容穩定,只有新掛牌/變更才有 git diff,幾乎無 churn)

注意:isin.twse.com.tw 憑證會讓嚴格 SSL 驗證失敗(Missing Subject Key Identifier),
      故以 requests verify=False 抓取(公開掛牌資料,與本專案 MOPS 同款處理);頁面為 Big5。
"""

from __future__ import annotations

import json
import os
import re
import sys

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "stock_codes.json")
# 精簡版(僅 code→後綴)供 TS import,bundle 進 serverless 才夠小
OUT_SLIM = os.path.join(ROOT, "web", "src", "lib", "stockSuffix.json")

# strMode → (市場別標籤, Yahoo 後綴)
MODES = {2: ("上市", ".TW"), 4: ("上櫃", ".TWO")}

_ROW_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S)
_TD_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.S)
_CODE_NAME_RE = re.compile(r"^(\d{4})　(.+)$")  # 4碼 + 全形空白 + 名稱


def _clean(cell: str) -> str:
    return re.sub(r"<[^>]+>", "", cell).replace("\xa0", " ").replace("&nbsp;", " ").strip()


def fetch_mode(mode: int) -> str:
    url = f"https://isin.twse.com.tw/isin/C_public.jsp?strMode={mode}"
    r = requests.get(
        url,
        headers={"User-Agent": "Mozilla/5.0 (compatible; TWstock/1.0)"},
        timeout=40,
        verify=False,  # isin.twse.com.tw 憑證缺 SKI,嚴格驗證會失敗;公開資料
    )
    r.raise_for_status()
    return r.content.decode("big5", errors="replace")


def parse_rows(html: str, market: str, suffix: str) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for tr in _ROW_RE.findall(html):
        tds = [_clean(c) for c in _TD_RE.findall(tr)]
        if len(tds) < 6:
            continue
        m = _CODE_NAME_RE.match(tds[0])
        if not m:
            continue
        cfi = tds[5]
        if not cfi.startswith("ES"):  # 僅普通股(排除權證/ETF/特別股/受益證券等)
            continue
        code, name = m.group(1), m.group(2).strip()
        out[code] = {
            "name": name,
            "market": market,
            "suffix": suffix,
            "industry": tds[4],
            "isin": tds[1],
            "listDate": tds[2],
        }
    return out


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    codes: dict[str, dict] = {}
    counts: dict[str, int] = {}
    for mode, (market, suffix) in MODES.items():
        try:
            rows = parse_rows(fetch_mode(mode), market, suffix)
        except Exception as e:  # noqa: BLE001
            print(f"[stock_codes] strMode={mode} ({market}) 失敗: {e}")
            rows = {}
        counts[market] = len(rows)
        codes.update(rows)
        print(f"[stock_codes] {market}: {len(rows)} 檔")
    if not codes:
        print("[stock_codes] 無資料,放棄寫檔(保留既有)。")
        sys.exit(1)
    ordered = dict(sorted(codes.items()))
    payload = {"counts": counts, "codes": ordered}
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2, sort_keys=False)
        f.write("\n")
    os.replace(tmp, OUT)
    print(f"[stock_codes] 寫入 {OUT} (共 {len(codes)} 檔)")

    slim = {code: info["suffix"] for code, info in ordered.items()}
    tmp2 = OUT_SLIM + ".tmp"
    with open(tmp2, "w", encoding="utf-8") as f:
        json.dump(slim, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    os.replace(tmp2, OUT_SLIM)
    print(f"[stock_codes] 寫入 {OUT_SLIM} (精簡 code→suffix)")


if __name__ == "__main__":
    main()
