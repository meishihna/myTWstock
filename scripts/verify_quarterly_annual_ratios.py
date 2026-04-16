#!/usr/bin/env python3
"""
驗證 financials_store JSON：曆年四季單季加總 vs 同年 *-12-31* annual 比值。

用法:
  python scripts/verify_quarterly_annual_ratios.py 2330 2317
  python scripts/verify_quarterly_annual_ratios.py   # 預設樣本清單

環境: PROJECT_ROOT 下 data/financials_store/{ticker}.json
"""
from __future__ import annotations

import json
import os
import re
import sys
from collections import defaultdict
from typing import Any

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORE = os.path.join(PROJECT_ROOT, "data", "financials_store")

DEFAULT_TICKERS = (
    "2330",
    "2317",
    "2454",
    "2382",
    "1301",
    "2882",
    "2801",
    "2816",
    "6488",
    "3661",
    "5274",
)

CHECK_FIELDS = (
    "Selling & Marketing Exp",
    "R&D Exp",
    "General & Admin Exp",
    "CAPEX",
    "Revenue",
    "Net Income",
)


def _iso_date(s: str) -> str | None:
    m = re.match(r"^(\d{4}-\d{2}-\d{2})", str(s).strip())
    return m.group(1) if m else None


def _year_from_iso(iso: str) -> int | None:
    m = re.match(r"^(\d{4})-", iso)
    return int(m.group(1)) if m else None


def _quarter_key(iso: str) -> tuple[int, int, int] | None:
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", iso)
    if not m:
        return None
    y, mo, d = int(m[1]), int(m[2]), int(m[3])
    if (mo, d) not in ((3, 31), (6, 30), (9, 30), (12, 31)):
        return None
    return (y, mo, d)


def load_store(ticker: str) -> dict[str, Any] | None:
    path = os.path.join(STORE, f"{ticker}.json")
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def verify_ticker(
    ticker: str,
    *,
    lo: float = 0.95,
    hi: float = 1.05,
) -> list[str]:
    """回傳錯誤訊息清單（空＝通過）。"""
    j = load_store(ticker)
    errs: list[str] = []
    if j is None:
        return [f"{ticker}: missing {STORE}/{ticker}.json"]

    ann = j.get("annual") or {}
    qtr = j.get("quarterly") or {}
    ap = ann.get("periods") or []
    aser = ann.get("series") or {}
    qp = qtr.get("periods") or []
    qser = qtr.get("series") or {}

    # annual Dec-31 -> value
    annual_dec: dict[int, dict[str, float | None]] = {}
    for i, p in enumerate(ap):
        iso = _iso_date(str(p))
        if not iso or not iso.endswith("-12-31"):
            continue
        y = _year_from_iso(iso)
        if y is None:
            continue
        row: dict[str, float | None] = {}
        for field in CHECK_FIELDS:
            arr = aser.get(field)
            if not isinstance(arr, list) or i >= len(arr):
                row[field] = None
            else:
                v = arr[i]
                row[field] = float(v) if v is not None and v == v else None
        annual_dec[y] = row

    # quarterly by calendar year -> list (iso, idx)
    by_y: dict[int, list[tuple[str, int]]] = defaultdict(list)
    for i, p in enumerate(qp):
        iso = _iso_date(str(p))
        if not iso:
            continue
        qk = _quarter_key(iso)
        if not qk:
            continue
        y, _, _ = qk
        by_y[y].append((iso, i))

    for y, dec_row in annual_dec.items():
        qlist = by_y.get(y)
        if not qlist:
            continue
        qlist = sorted(qlist, key=lambda x: x[0])
        if {iso for iso, _ in qlist} != {
            f"{y}-03-31",
            f"{y}-06-30",
            f"{y}-09-30",
            f"{y}-12-31",
        }:
            continue

        idxs = [i for _, i in qlist]
        for field in CHECK_FIELDS:
            av = dec_row.get(field)
            if av is None or not isinstance(av, (int, float)):
                continue
            if abs(av) < 1e-12:
                continue
            arr = qser.get(field)
            if not isinstance(arr, list):
                continue
            parts: list[float] = []
            ok = True
            for qi in idxs:
                if qi >= len(arr):
                    ok = False
                    break
                v = arr[qi]
                if v is None or v != v:
                    ok = False
                    break
                parts.append(float(v))
            if not ok or len(parts) != 4:
                continue
            qsum = sum(parts)
            ratio = qsum / av if av != 0 else float("nan")
            if not (lo <= ratio <= hi):
                errs.append(
                    f"{ticker} {field} {y}: quarterly_sum={qsum:.4g} annual={av:.4g} ratio={ratio:.4f}"
                )

    return errs


def main() -> int:
    tickers = [t.strip() for t in sys.argv[1:] if t.strip()] or list(DEFAULT_TICKERS)
    all_errs: list[str] = []
    for t in tickers:
        all_errs.extend(verify_ticker(t))
    if all_errs:
        print("\n".join(all_errs))
        return 1
    print(f"OK: {len(tickers)} ticker(s) passed ratio checks.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
