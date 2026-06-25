"""
月營收(每月營收)更新:FinMind TaiwanStockMonthRevenue → financials_store 的 monthlyRevenue 區塊。

純加法:只新增/更新 `monthlyRevenue`,不動 annual/quarterly。抓 ~5 年算 YoY 與累計,
顯示保留近 36 月。需 FINMIND_TOKEN(無 token 走 v3 匿名,受流量限制)。

用法:
  python scripts/update_month_revenue.py 2330 2317      # 指定代號
  python scripts/update_month_revenue.py --all          # 全市場(數小時,建議自有 token)
"""

from __future__ import annotations

import glob
import json
import os
import sys
from datetime import datetime

from dateutil.relativedelta import relativedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from finmind_financials import fetch_finmind_dataset  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORE = os.path.join(ROOT, "data", "financials_store")
DISPLAY_MONTHS = 36


def fetch_month_revenue(ticker: str) -> dict | None:
    sd = (datetime.today() - relativedelta(years=5)).strftime("%Y-%m-%d")
    df = fetch_finmind_dataset("TaiwanStockMonthRevenue", ticker, sd)
    if df is None or df.empty:
        return None
    recs: dict[tuple[int, int], float] = {}
    for _, r in df.iterrows():
        try:
            y = int(r["revenue_year"])
            m = int(r["revenue_month"])
            rev = float(r["revenue"])
        except (KeyError, TypeError, ValueError):
            continue
        if rev != rev:  # NaN
            continue
        recs[(y, m)] = rev
    if not recs:
        return None

    def ytd(y: int, m: int) -> float | None:
        s = 0.0
        for mm in range(1, m + 1):
            v = recs.get((y, mm))
            if v is None:
                return None
            s += v
        return s

    months = sorted(recs.keys())
    periods: list[str] = []
    revenue: list[float] = []
    yoy: list[float | None] = []
    cum: list[float | None] = []
    cum_yoy: list[float | None] = []
    for (y, m) in months:
        rev = recs[(y, m)]
        periods.append(f"{y:04d}-{m:02d}")
        revenue.append(round(rev / 1e6, 3))  # 元 → 百萬台幣
        prev = recs.get((y - 1, m))
        yoy.append(round((rev - prev) / prev * 100, 2) if prev not in (None, 0) else None)
        c = ytd(y, m)
        cp = ytd(y - 1, m)
        cum.append(round(c / 1e6, 3) if c is not None else None)
        cum_yoy.append(
            round((c - cp) / cp * 100, 2) if (c is not None and cp not in (None, 0)) else None
        )

    k = max(0, len(periods) - DISPLAY_MONTHS)
    return {
        "periods": periods[k:],
        "revenue": revenue[k:],
        "yoy": yoy[k:],
        "cum": cum[k:],
        "cumYoy": cum_yoy[k:],
        "updatedAt": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def atomic_write(path: str, obj: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def update_one(ticker: str) -> bool:
    path = os.path.join(STORE, f"{ticker}.json")
    if not os.path.exists(path):
        print(f"  {ticker}: 無 store 檔,略過")
        return False
    block = fetch_month_revenue(ticker)
    if not block or not block["periods"]:
        print(f"  {ticker}: 無月營收資料")
        return False
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    d["monthlyRevenue"] = block
    atomic_write(path, d)
    print(
        f"  {ticker}: {len(block['periods'])} 月,最新 {block['periods'][-1]} "
        f"營收 {block['revenue'][-1]:,.0f}M YoY {block['yoy'][-1]}%"
    )
    return True


def main() -> None:
    argv = sys.argv[1:]
    if "--all" in argv:
        tickers = sorted(
            os.path.basename(p)[:-5] for p in glob.glob(os.path.join(STORE, "*.json"))
        )
    else:
        tickers = [a for a in argv if not a.startswith("-")]
    if not tickers:
        print("用法: python scripts/update_month_revenue.py <代號...> | --all")
        return
    ok = 0
    for t in tickers:
        try:
            if update_one(t):
                ok += 1
        except Exception as e:  # noqa: BLE001
            print(f"  {t}: 錯誤 {e}")
    print(f"完成: {ok}/{len(tickers)}")


if __name__ == "__main__":
    main()
