#!/usr/bin/env python3
"""
validate_test_set.py — 175 檔 financials_store JSON 自動品質驗證

用法：
  python scripts/validate_test_set.py
  python scripts/validate_test_set.py --store web/public/data/financials

環境變數 FINANCIALS_STORE_DIR 可覆寫預設 data/financials_store。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_STORE = os.path.join(PROJECT_ROOT, "data", "financials_store")

# 上市代表 98 + 上櫃代表 77 = 175（與自檢計畫清單一致）
TEST_TICKERS: list[str] = [
    "6136",
    "2208",
    "1712",
    "2610",
    "4558",
    "1315",
    "1417",
    "6901",
    "2207",
    "1599",
    "1319",
    "2812",
    "2801",
    "4154",
    "4911",
    "4171",
    "9928",
    "1101",
    "1806",
    "1324",
    "2820",
    "1310",
    "2314",
    "1471",
    "1435",
    "6754",
    "2424",
    "2009",
    "5871",
    "2942",
    "5398",
    "2496",
    "1503",
    "1582",
    "3687",
    "1603",
    "1472",
    "5263",
    "1240",
    "2885",
    "5902",
    "1340",
    "1558",
    "6536",
    "2948",
    "1730",
    "2373",
    "1416",
    "2816",
    "2867",
    "2832",
    "2851",
    "5878",
    "1443",
    "3085",
    "2941",
    "1432",
    "2724",
    "6655",
    "2603",
    "3373",
    "1343",
    "2904",
    "6505",
    "7610",
    "6578",
    "1323",
    "5530",
    "1535",
    "6240",
    "2633",
    "1436",
    "1438",
    "1316",
    "1517",
    "2360",
    "2390",
    "2302",
    "2303",
    "3570",
    "3555",
    "2406",
    "5607",
    "1301",
    "1504",
    "2430",
    "3130",
    "1605",
    "2412",
    "1307",
    "1516",
    "1527",
    "2608",
    "7740",
    "8908",
    "6977",
    "6806",
    "6581",
    "8222",
    "6508",
    "6757",
    "8942",
    "8932",
    "2247",
    "2258",
    "4581",
    "2834",
    "5880",
    "6236",
    "9930",
    "9934",
    "8342",
    "6027",
    "8438",
    "8176",
    "8455",
    "6969",
    "6881",
    "8201",
    "4989",
    "9941",
    "5904",
    "8489",
    "8249",
    "9912",
    "6908",
    "8072",
    "9945",
    "8487",
    "8345",
    "9950",
    "9935",
    "9919",
    "8374",
    "8099",
    "5859",
    "2852",
    "6028",
    "5609",
    "7551",
    "8477",
    "9921",
    "5324",
    "8444",
    "8367",
    "9958",
    "9927",
    "8905",
    "9939",
    "9955",
    "2640",
    "6212",
    "9946",
    "9940",
    "8937",
    "8289",
    "9925",
    "8110",
    "8299",
    "8416",
    "8298",
    "6839",
    "9929",
    "8935",
    "8996",
    "9960",
    "9962",
    "6561",
    "9944",
    "8415",
    "5604",
    "8931",
    "9931",
    "8087",
    "8476",
]

FINANCIAL_TYPES = frozenset(
    {"financial_holding", "bank", "insurance", "securities", "other"}
)


def _year_from_period(p: object) -> str | None:
    s = str(p).strip()
    m = re.match(r"^(\d{4})", s)
    return m.group(1) if m else None


def _is_na_sector_industry(val: object) -> bool:
    if val is None:
        return True
    s = str(val).strip()
    if not s:
        return True
    return s.upper() in ("N/A", "NA", "NONE", "—", "-")


def _non_null_count(vals: list) -> int:
    return sum(1 for v in vals if v is not None)


def validate_ticker(store: str, ticker: str) -> tuple[list[str], list[str]]:
    """回傳 (errors, warnings)。"""
    path = os.path.join(store, f"{ticker}.json")
    errors: list[str] = []
    warnings: list[str] = []
    prefix = ticker

    if not os.path.isfile(path):
        return [f"{ticker}: JSON FILE MISSING"], []

    with open(path, encoding="utf-8") as f:
        d = json.load(f)

    a = d.get("annual") or {}
    a_periods = a.get("periods") or []
    if len(a_periods) == 0:
        return [f"{ticker}: DATA_UNAVAILABLE (annual.periods is empty)"], []

    itype = (d.get("industryType") or "general").strip()
    is_fin = itype in FINANCIAL_TYPES
    prefix = f"{ticker} ({itype})"

    sector = d.get("sector")
    industry = d.get("industry")
    if _is_na_sector_industry(sector):
        warnings.append("sector is N/A or empty")
    if _is_na_sector_industry(industry):
        warnings.append("industry is N/A or empty")
    if d.get("marketCap") is None:
        warnings.append("marketCap is null")

    val = d.get("valuation") or {}
    if not val:
        warnings.append("valuation block missing or empty")
    else:
        for key in ("P/E (TTM)", "P/B", "P/S (TTM)"):
            if val.get(key) is None:
                warnings.append(f"valuation.{key} is null")

    a_series = a.get("series") or {}

    n_ann = len(a_periods)
    if n_ann == 1:
        errors.append("annual periods only 1 (need >=2)")
    elif 2 <= n_ann < 5:
        warnings.append(f"annual periods only {n_ann} (prefer >=5)")

    for key in ("Revenue", "Net Income", "EPS"):
        vals = a_series.get(key) or []
        if len(vals) != n_ann and vals:
            warnings.append(f"annual {key}: length {len(vals)} != periods {n_ann}")
        nn = _non_null_count(vals[:n_ann] if len(vals) >= n_ann else vals)
        if nn < 2:
            errors.append(f"annual {key}: only {nn} non-null values (need >=2)")
        elif nn < 3:
            warnings.append(f"annual {key}: only {nn} non-null values (prefer >=3)")

    q = d.get("quarterlyCore") or d.get("quarterly") or {}
    q_periods = q.get("periods") or []
    q_series = q.get("series") or {}

    n_q = len(q_periods)
    if n_q < 4:
        errors.append(f"quarterly periods only {n_q} (need >=4)")
    elif n_q < 20:
        warnings.append(f"quarterly periods only {n_q} (prefer >=20)")

    if n_q >= 4:
        for key in ("Revenue", "Net Income", "EPS"):
            vals = q_series.get(key) or []
            if len(vals) != n_q and vals:
                warnings.append(f"quarterly {key}: length {len(vals)} != periods {n_q}")
            nn = _non_null_count(vals[:n_q] if len(vals) >= n_q else vals)
            if nn < 4:
                errors.append(f"quarterly {key}: only {nn} non-null values (need >=4)")
            elif nn < 8:
                warnings.append(f"quarterly {key}: only {nn} non-null values (prefer >=8)")

    # Q sum vs annual（曆年：以 period 西元年對齊）
    for key in ("Revenue", "EPS"):
        q_vals = q_series.get(key) or []
        a_vals = a_series.get(key) or []
        for year_idx, year_p in enumerate(a_periods):
            year = _year_from_period(year_p)
            if not year:
                continue
            annual_val = a_vals[year_idx] if year_idx < len(a_vals) else None
            if annual_val is None or annual_val == 0:
                continue
            q_year_vals: list[float] = []
            for i, p in enumerate(q_periods):
                if i >= len(q_vals):
                    break
                if _year_from_period(p) != year:
                    continue
                qv = q_vals[i]
                if qv is not None:
                    try:
                        q_year_vals.append(float(qv))
                    except (TypeError, ValueError):
                        pass
            if len(q_year_vals) == 4:
                ratio = sum(q_year_vals) / float(annual_val)
                if not (0.90 <= ratio <= 1.10):
                    errors.append(f"{key} {year}: Q_sum/Annual = {ratio:.3f}")

    if is_fin:
        gm = q_series.get("Gross Margin (%)") or []
        if any(v is not None for v in gm):
            warnings.append("financial stock but Gross Margin has non-null values")
    else:
        gm = q_series.get("Gross Margin (%)") or []
        if gm and all(v is None for v in gm):
            warnings.append("general stock but Gross Margin all null")

    capex_a = a_series.get("CAPEX") or []
    rev_a = a_series.get("Revenue") or []
    if not is_fin and capex_a and rev_a:
        for i in range(min(len(capex_a), len(rev_a), len(a_periods))):
            c, r = capex_a[i], rev_a[i]
            if c is not None and r is not None and float(r) > 0:
                ratio_c = abs(float(c)) / float(r)
                if ratio_c > 5:
                    y = _year_from_period(a_periods[i]) or "?"
                    warnings.append(
                        f"annual CAPEX {y}: |CAPEX|/Revenue = {ratio_c:.1f}x (suspicious)"
                    )

    if not is_fin:
        required_kpi = {
            "Revenue": (a_series.get("Revenue") or [None])[-1],
            "Gross Margin (%)": (a_series.get("Gross Margin (%)") or [None])[-1],
            "EPS": (a_series.get("EPS") or [None])[-1],
            "Operating Margin (%)": (a_series.get("Operating Margin (%)") or [None])[
                -1
            ],
            "Net Margin (%)": (a_series.get("Net Margin (%)") or [None])[-1],
        }
        for kpi_name, kpi_val in required_kpi.items():
            if kpi_val is None:
                errors.append(f"KPI {kpi_name}: latest annual value is null")

    return [f"{prefix}: {e}" for e in errors], [f"{prefix}: {w}" for w in warnings]


def main() -> int:
    p = argparse.ArgumentParser(description="Validate 175-ticker financials JSON set.")
    p.add_argument(
        "--store",
        default=os.environ.get("FINANCIALS_STORE_DIR", DEFAULT_STORE),
        help="Directory of {ticker}.json (default: data/financials_store)",
    )
    args = p.parse_args()
    store = os.path.abspath(args.store)
    if not os.path.isdir(store):
        print(f"ERROR: store directory not found: {store}", file=sys.stderr)
        return 2

    if len(TEST_TICKERS) != 175:
        print(
            f"WARNING: TEST_TICKERS length is {len(TEST_TICKERS)}, expected 175",
            file=sys.stderr,
        )

    all_errors: list[str] = []
    all_warnings: list[str] = []
    passed = 0

    for ticker in TEST_TICKERS:
        errs, warns = validate_ticker(store, ticker)
        all_errors.extend(errs)
        all_warnings.extend(warns)
        if not errs:
            passed += 1

    total = len(TEST_TICKERS)
    print("=" * 70)
    print(f"Store: {store}")
    print(
        f"VALIDATION REPORT: {passed}/{total} passed (no errors), {total - passed} with errors"
    )
    print("=" * 70)

    if all_errors:
        print(f"\nERRORS ({len(all_errors)}):")
        for e in all_errors:
            print(f"  {e}")

    if all_warnings:
        print(f"\nWARNINGS ({len(all_warnings)}):")
        for w in all_warnings:
            print(f"  {w}")

    if passed == total and not all_errors:
        print("\nALL TICKERS PASSED (no errors).")

    return 0 if not all_errors else 1


if __name__ == "__main__":
    sys.exit(main())
