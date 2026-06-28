"""
build_valuation_snapshot.py — 全市場估值快照(本益比 / 殖利率 / 股價淨值比 + Beta)。

來源(全免費、無金鑰、無配額):
  • 本益比 / 殖利率 / 股價淨值比 → 證交所官方 OpenAPI(每檔最新交易日、一次回全市場):
      - TWSE 上市:exchangeReport/BWIBBU_ALL(PEratio / DividendYield / PBratio)
      - TPEx 上櫃:tpex_mainboard_peratio_analysis(PriceEarningRatio / YieldRatio / PriceBookRatio)
    (FinMind 免費層不允許 TaiwanStockPER 全市場查詢,故估值改用 TWSE/TPEx 官方資料。)
  • Beta → Yahoo(yfinance)近 1 年「週」收盤,個股對 ^TWII(上市)/ ^TWOII(上櫃),
          以 cov/var 計算;週數不足(新上市未滿一年)→ null。
          市場別由 PER 來源(TWSE=上市 / TPEx=上櫃)判定,避免逐檔試誤;偵測到限流(指數列缺)會退避重試。

輸出 web/public/data/valuation-index.json
  { "generatedAt": ISO, "rows": { "2330": { "pe": 32.4, "pb": 10.61, "yield": 0.91, "beta": 1.11 } } }

報告頁(預渲染)讀此檔顯示 4 張估值卡片;盤後在 CI(refresh-snapshots)跑。

  python scripts/build_valuation_snapshot.py                 # 全部(報告頁宇集)
  python scripts/build_valuation_snapshot.py 2330 2303 6488  # 指定數檔(測試用)
  python scripts/build_valuation_snapshot.py --sector Semiconductors
"""

from __future__ import annotations

import json
import os
import ssl
import sys
import time
from datetime import datetime, timezone
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from utils import find_ticker_files, parse_scope_args, setup_stdout

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "public", "data", "valuation-index.json")

TWSE_BWIBBU = "https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL"
TPEX_PER = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis"

MIN_WEEKS = 40          # Beta 至少需要的週報酬樣本(約 1 年扣節假)
YF_CHUNK = 90           # yfinance 單次下載檔數
YF_SLEEP = 1.2          # 每批間隔(秒),降低 Yahoo 限流
YF_COOLDOWN = 25.0      # 被限流時的退避(秒)
INDEX_TWSE = "^TWII"    # 加權指數(上市)
INDEX_TPEX = "^TWOII"   # 櫃買指數(上櫃)

# 公開政府端點,只讀無敏感資料;TWSE/TPEx 憑證鏈在部分環境驗證失敗(Missing SKI),故不驗證。
_SSL = ssl.create_default_context()
_SSL.check_hostname = False
_SSL.verify_mode = ssl.CERT_NONE


def _num(x, nd: int = 2):
    """轉成有限浮點並四捨五入;空字串/非數值/NaN/Inf → None。"""
    if x is None:
        return None
    s = str(x).strip().replace(",", "")
    if not s or s.upper() in ("N/A", "NA", "-", "--"):
        return None
    try:
        f = float(s)
    except ValueError:
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return round(f, nd)


def _get_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 twstock-valuation"})
    with urllib.request.urlopen(req, timeout=90, context=_SSL) as r:
        return json.loads(r.read().decode("utf-8"))


# ---------------------------------------------------------------------------
# 本益比 / 股價淨值比 / 殖利率 — TWSE + TPEx 官方 OpenAPI(全市場最新日)
# 回傳 (per_map, market_map);market_map[ticker] = "TW"(上市) | "TWO"(上櫃)
# ---------------------------------------------------------------------------
def _mk_row(pe_raw, pb_raw, yield_raw) -> dict:
    pe = _num(pe_raw)
    pb = _num(pb_raw)
    dy = _num(yield_raw)
    return {
        "pe": pe if (pe is not None and pe > 0) else None,   # 虧損/無意義不給負本益比
        "pb": pb if (pb is not None and pb > 0) else None,
        "yield": dy,                                          # 0 視為有效(當年未配息)
    }


def build_per_map(universe: set[str]) -> tuple[dict[str, dict], dict[str, str]]:
    out: dict[str, dict] = {}
    market: dict[str, str] = {}
    try:
        for row in _get_json(TWSE_BWIBBU):
            code = str(row.get("Code") or "").strip()
            if code in universe:
                out[code] = _mk_row(row.get("PEratio"), row.get("PBratio"), row.get("DividendYield"))
                market[code] = "TW"
        print(f"  [PER] TWSE {len(out)} matched")
    except Exception as e:
        print(f"  [PER] TWSE FAILED: {e}")
    try:
        added = 0
        for row in _get_json(TPEX_PER):
            code = str(row.get("SecuritiesCompanyCode") or "").strip()
            if code in universe and code not in out:
                out[code] = _mk_row(
                    row.get("PriceEarningRatio"), row.get("PriceBookRatio"), row.get("YieldRatio")
                )
                market[code] = "TWO"
                added += 1
        print(f"  [PER] TPEx +{added}")
    except Exception as e:
        print(f"  [PER] TPEx FAILED: {e}")
    return out, market


# ---------------------------------------------------------------------------
# Beta — Yahoo 週線近 1 年,個股對市場指數 cov/var
# ---------------------------------------------------------------------------
def _download_close(chunk: list[str], index_sym: str):
    """下載一批週線收盤;偵測限流(指數列缺)會退避重試。回傳 close DataFrame 或 None。"""
    import pandas as pd
    import yfinance as yf

    for attempt in range(3):
        try:
            data = yf.download(
                chunk + [index_sym],
                period="1y",
                interval="1wk",
                auto_adjust=True,
                progress=False,
                threads=True,
            )
            close = data["Close"]
            if isinstance(close, pd.Series):
                close = close.to_frame()
            # 指數一定有資料;若缺 → 視為被限流,退避重試
            if index_sym in close.columns and not close[index_sym].dropna().empty:
                return close
        except Exception as e:
            if attempt == 2:
                print(f"  [beta] download fail ({index_sym}): {e}")
        time.sleep(YF_COOLDOWN * (attempt + 1))
    return None


def _betas_for(symbols: list[str], index_sym: str) -> dict[str, float | None]:
    """回傳「有抓到資料」的 symbol → beta(或 None);完全無資料者不列入。"""
    import pandas as pd

    out: dict[str, float | None] = {}
    for i in range(0, len(symbols), YF_CHUNK):
        chunk = symbols[i : i + YF_CHUNK]
        close = _download_close(chunk, index_sym)
        if close is None:
            continue
        rets = close.pct_change(fill_method=None)
        idx_ret = rets[index_sym]
        idx_var = idx_ret.var()
        for sym in chunk:
            if sym not in close.columns or close[sym].dropna().empty:
                continue
            pair = pd.concat([rets[sym], idx_ret], axis=1).dropna()
            beta: float | None = None
            if pair.shape[0] >= MIN_WEEKS and idx_var and idx_var == idx_var and idx_var > 0:
                cov = pair.iloc[:, 0].cov(pair.iloc[:, 1])
                b = cov / idx_var
                beta = round(float(b), 2) if b == b else None
            out[sym] = beta
        time.sleep(YF_SLEEP)
    return out


def build_beta_map(universe: list[str], market: dict[str, str]) -> dict[str, float | None]:
    """依 PER 判定的市場別路由:上市→.TW/^TWII、上櫃→.TWO/^TWOII;未知先試 .TW 再 .TWO。"""
    betas: dict[str, float | None] = {}
    tw_list = [t for t in universe if market.get(t) != "TWO"]   # 上市 + 未知
    two_list = [t for t in universe if market.get(t) == "TWO"]  # 上櫃

    res_tw = _betas_for([f"{t}.TW" for t in tw_list], INDEX_TWSE)
    got = set()
    for sym, b in res_tw.items():
        t = sym.split(".")[0]
        betas[t] = b
        got.add(t)

    if two_list:
        res_two = _betas_for([f"{t}.TWO" for t in two_list], INDEX_TPEX)
        for sym, b in res_two.items():
            betas[sym.split(".")[0]] = b

    leftover = [t for t in tw_list if t not in got]  # 未知且 .TW 無資料 → 試 .TWO
    if leftover:
        res_lo = _betas_for([f"{t}.TWO" for t in leftover], INDEX_TPEX)
        for sym, b in res_lo.items():
            betas[sym.split(".")[0]] = b

    print(f"  [beta] resolved {sum(1 for v in betas.values() if v is not None)}/{len(universe)}")
    return betas


def main() -> None:
    setup_stdout()
    tickers, sector, desc = parse_scope_args(sys.argv[1:])
    files = find_ticker_files(tickers, sector)
    universe = sorted(files.keys())
    if not universe:
        print("No matching tickers.")
        return
    print(f"Valuation snapshot for {desc} ({len(universe)} tickers)")

    try:
        per_map, market = build_per_map(set(universe))
        print(f"  [PER] total {len(per_map)} tickers")
    except Exception as e:
        print(f"  [PER] FAILED: {e}")
        per_map, market = {}, {}

    try:
        beta_map = build_beta_map(universe, market)
    except Exception as e:
        print(f"  [beta] FAILED: {e}")
        beta_map = {}

    rows: dict[str, dict] = {}
    for t in universe:
        pv = per_map.get(t) or {}
        row = {
            "pe": pv.get("pe"),
            "pb": pv.get("pb"),
            "yield": pv.get("yield"),
            "beta": beta_map.get(t),
        }
        if any(v is not None for v in row.values()):  # 全缺則不寫(報告頁 fallback 顯示 —)
            rows[t] = row

    payload = {
        "generatedAt": datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "rows": rows,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    os.replace(tmp, OUT)
    print(f"wrote {OUT}  ({len(rows)}/{len(universe)} tickers have >=1 metric)")


if __name__ == "__main__":
    main()
