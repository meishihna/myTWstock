"""Verify 2330 after sii/otc_110_1 cache: MOPS row + Q2 decumulation vs raw YTD."""
from __future__ import annotations

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "data", "mops_cache")
sys.path.insert(0, os.path.join(ROOT, "scripts"))

os.environ.setdefault("MYTWSTOCK_MOPS", "1")

from mops_financials import build_mops_market_core_quarterly_dataframe  # noqa: E402


def _row(typek: str, roc: int, se: int, tid: str) -> dict | None:
    path = os.path.join(CACHE, f"{typek}_{roc}_{se}.json")
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as f:
        payload = json.load(f)
    bt = payload.get("by_ticker") or {}
    r = bt.get(tid)
    return dict(r) if isinstance(r, dict) else None


def main() -> None:
    tid = "2330"
    # TSMC listed — expect sii
    for typek, label in (("sii", "上市"), ("otc", "上櫃")):
        r1 = _row(typek, 110, 1, tid)
        r2 = _row(typek, 110, 2, tid)
        print(f"{label} 110Q1 row present: {bool(r1 and any(v is not None for v in r1.values()))}")
        print(f"{label} 110Q2 row present: {bool(r2 and any(v is not None for v in r2.values()))}")
        if r1 and r2:
            for k in ("EPS", "Revenue", "Net Income"):
                if k in r1 and k in r2 and r1[k] is not None and r2[k] is not None:
                    y1, y2 = float(r1[k]), float(r2[k])
                    dq2 = y2 - y1
                    print(f"  raw YTD {k}: Q1={y1} Q2_cum={y2} => Q2_single={dq2}")

    pl = ["2021-06-30", "2021-03-31"]  # newest first
    df = build_mops_market_core_quarterly_dataframe(tid, pl)
    print("\nbuild_mops_market_core_quarterly_dataframe (decumulated):")
    if df.empty:
        print("  (empty)")
        return
    print(df.to_string())


if __name__ == "__main__":
    main()
