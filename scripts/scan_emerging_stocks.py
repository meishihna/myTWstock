"""scan_emerging_stocks.py — 掃描 financials_store 中所有興櫃股（半年報特徵）。

判定規則（與 _detect_listing_status 對齊）：
1. 不在任何 t163 全市場快取中
2. 季表有資料（t164 有回應）
3. 季表期末以 06-30／12-31 為主（兩者合計期數佔比 ≥ 60%）

輸出：
  data/emerging_stocks.json — 含 ticker、最早季、最晚季、季數、industryType
  Console 摘要表

Usage:
  python scripts/scan_emerging_stocks.py
"""

from __future__ import annotations

import glob
import json
import os
import sys
from datetime import datetime, timezone

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(PROJECT_ROOT, "scripts"))

from mops_financials import ticker_in_any_t163_cache


def periods_predominantly_semi_annual(periods: list, threshold: float = 0.6) -> bool:
    if not periods:
        return False
    total = 0
    semi = 0
    for p in periods:
        if isinstance(p, str) and len(p) >= 10:
            total += 1
            if p[5:10] in ("06-30", "12-31"):
                semi += 1
    return total > 0 and (semi / total) >= threshold


def main() -> None:
    out: list[dict] = []
    store_glob = os.path.join(PROJECT_ROOT, "data", "financials_store", "*.json")
    for f in sorted(glob.glob(store_glob)):
        tk = os.path.splitext(os.path.basename(f))[0]
        try:
            d = json.load(open(f, encoding="utf-8"))
        except Exception:
            continue

        q = d.get("quarterlyCore") or d.get("quarterly") or {}
        periods = q.get("periods") or []
        if not periods:
            continue
        if not periods_predominantly_semi_annual(periods, threshold=0.6):
            continue
        if ticker_in_any_t163_cache(tk):
            continue

        out.append(
            {
                "ticker": tk,
                "industryType": d.get("industryType"),
                "earliest": periods[0] if periods else None,
                "latest": periods[-1] if periods else None,
                "periods": len(periods),
                "listingStatus": d.get("listingStatus"),
            }
        )

    out.sort(key=lambda r: r["ticker"])

    report = {
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "count": len(out),
        "emerging": out,
    }
    dest = os.path.join(PROJECT_ROOT, "data", "emerging_stocks.json")
    with open(dest, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)

    print(f"興櫃股總數: {len(out)}")
    print(f"輸出: {dest}")
    print()
    for r in out[:20]:
        print(
            f"  {r['ticker']}: periods={r['periods']} {r['earliest']} ~ {r['latest']} "
            f"listingStatus={r['listingStatus']}"
        )
    if len(out) > 20:
        print(f"  ... 另外 {len(out) - 20} 檔，詳見輸出檔")


if __name__ == "__main__":
    main()
