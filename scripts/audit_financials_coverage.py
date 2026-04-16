#!/usr/bin/env python3
"""
audit_financials_coverage.py — Measure 5y / 16Q coverage in data/financials_store/*.json
and compare to Pilot_Reports tickers (missing JSON or short periods).

Read-only; does not modify files.

Usage:
  python scripts/audit_financials_coverage.py
  python scripts/audit_financials_coverage.py --csv out/coverage.csv
  python scripts/audit_financials_coverage.py --list-short-q  # tickers with quarterly < 16
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import Counter

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIN_DIR = os.path.join(PROJECT_ROOT, "data", "financials_store")
REPORTS_DIR = os.path.join(PROJECT_ROOT, "Pilot_Reports")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from utils import find_ticker_files  # noqa: E402


def _len_periods(block: dict | None) -> int:
    if not block or not isinstance(block, dict):
        return 0
    p = block.get("periods")
    return len(p) if isinstance(p, list) else 0


def scan_financials_json_dir() -> dict[str, dict]:
    out: dict[str, dict] = {}
    if not os.path.isdir(FIN_DIR):
        return out
    for fn in os.listdir(FIN_DIR):
        if not fn.endswith(".json"):
            continue
        path = os.path.join(FIN_DIR, fn)
        ticker = fn.replace(".json", "")
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            out[ticker] = {"error": True, "nq": 0, "na": 0}
            continue
        out[ticker] = {
            "nq": _len_periods(data.get("quarterly")),
            "na": _len_periods(data.get("annual")),
            "nq_core": _len_periods(data.get("quarterlyCore")),
        }
    return out


def report_tickers() -> set[str]:
    return set(find_ticker_files().keys())


def main() -> int:
    ap = argparse.ArgumentParser(description="Audit financials JSON coverage vs reports.")
    ap.add_argument("--csv", metavar="PATH", help="Write per-ticker CSV")
    ap.add_argument(
        "--list-short-q",
        action="store_true",
        help="Print tickers with quarterly periods < 16",
    )
    ap.add_argument(
        "--list-short-a",
        action="store_true",
        help="Print tickers with annual periods < 5",
    )
    ap.add_argument(
        "--list-no-json",
        action="store_true",
        help="Print report tickers missing financials JSON",
    )
    args = ap.parse_args()

    by_ticker = scan_financials_json_dir()
    reports = report_tickers()

    n_json = len(by_ticker)
    n_reports = len(reports)
    missing_json = sorted(reports - set(by_ticker.keys()))

    dist_q = Counter()
    dist_a = Counter()
    ge16 = ge5 = 0
    rows = []
    for t, info in sorted(by_ticker.items()):
        if info.get("error"):
            nq = na = 0
        else:
            nq = info["nq"]
            na = info["na"]
        dist_q[nq] += 1
        dist_a[na] += 1
        if nq >= 16:
            ge16 += 1
        if na >= 5:
            ge5 += 1
        rows.append(
            {
                "ticker": t,
                "quarterly_periods": nq,
                "annual_periods": na,
                "quarterly_core_periods": info.get("nq_core", 0),
            }
        )

    print("=== Financials JSON coverage (data/financials_store) ===")
    print(f"JSON files: {n_json}")
    print(f"Pilot report tickers: {n_reports}")
    print(f"Reports without JSON: {len(missing_json)}")
    print(f"Quarterly periods >= 16: {ge16} / {n_json}")
    print(f"Annual periods >= 5:     {ge5} / {n_json}")
    print()
    print("Quarterly period count (histogram):")
    for k in sorted(dist_q.keys(), reverse=True)[:25]:
        print(f"  {k:3d} cols: {dist_q[k]}")
    if len(dist_q) > 25:
        print("  ...")
    print()
    print("Annual period count (histogram):")
    for k in sorted(dist_a.keys(), reverse=True)[:15]:
        print(f"  {k:3d} cols: {dist_a[k]}")

    if args.csv:
        os.makedirs(os.path.dirname(args.csv) or ".", exist_ok=True)
        with open(args.csv, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(
                f,
                fieldnames=[
                    "ticker",
                    "quarterly_periods",
                    "annual_periods",
                    "quarterly_core_periods",
                ],
            )
            w.writeheader()
            w.writerows(rows)
        print(f"\nWrote {args.csv}")

    if args.list_no_json and missing_json:
        print("\n--- No JSON (first 50) ---")
        for t in missing_json[:50]:
            print(t)
        if len(missing_json) > 50:
            print(f"... +{len(missing_json) - 50} more")

    if args.list_short_q:
        short = sorted(t for t, info in by_ticker.items() if info.get("nq", 0) < 16)
        print(f"\n--- Quarterly < 16 ({len(short)}) ---")
        for t in short[:80]:
            print(f"{t}\t{by_ticker[t].get('nq', 0)}")
        if len(short) > 80:
            print(f"... +{len(short) - 80} more")

    if args.list_short_a:
        short = sorted(t for t, info in by_ticker.items() if info.get("na", 0) < 5)
        print(f"\n--- Annual < 5 ({len(short)}) ---")
        for t in short[:80]:
            print(f"{t}\t{by_ticker[t].get('na', 0)}")
        if len(short) > 80:
            print(f"... +{len(short) - 80} more")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
