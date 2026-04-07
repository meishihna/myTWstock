"""
Optional local financial history merged after Yahoo (yfinance).

Place ``data/financial_supplements/{ticker}.json`` (e.g. ``2330.json``).
Yahoo values win when both sides have a number; supplement fills missing
periods and NaN cells. Money rows must be **百萬台幣** (same as report tables);
margin rows are **percent** (same as MD). Period labels: ``YYYY-MM-DD``
(quarter-end or fiscal year-end).

If you only provide Revenue + Gross Profit (etc.), margin % rows can be
omitted and will be back-filled where possible.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

import pandas as pd

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUPPLEMENT_DIR = os.path.join(PROJECT_ROOT, "data", "financial_supplements")

# 報告財務表列順序。merge_financial_dfs 使用 index.union 會變成字母序，需還原；營收列置頂。
FINANCIAL_STATEMENT_ROW_ORDER = (
    "Revenue",
    "Gross Profit",
    "Gross Margin (%)",
    "Selling & Marketing Exp",
    "R&D Exp",
    "General & Admin Exp",
    "Operating Income",
    "Operating Margin (%)",
    "Net Income",
    "Net Margin (%)",
    "Op Cash Flow",
    "Investing Cash Flow",
    "Financing Cash Flow",
    "CAPEX",
)


def sort_financial_statement_rows(df: pd.DataFrame) -> pd.DataFrame:
    if df is None or df.empty:
        return df
    seen: set[str] = set()
    new_idx: list[str] = []
    for r in FINANCIAL_STATEMENT_ROW_ORDER:
        if r in df.index and r not in seen:
            new_idx.append(r)
            seen.add(r)
    for r in df.index:
        if r not in seen:
            new_idx.append(r)
            seen.add(r)
    return df.reindex(new_idx)


def load_financial_supplement(ticker: str) -> dict[str, Any] | None:
    path = os.path.join(SUPPLEMENT_DIR, f"{ticker}.json")
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, dict) else None


def supplement_block_to_dataframe(block: dict | None) -> pd.DataFrame:
    if not block or "periods" not in block or "series" not in block:
        return pd.DataFrame()
    periods = [str(p) for p in block["periods"]]
    series = block["series"]
    if not periods:
        return pd.DataFrame()
    n = len(periods)
    rows: dict[str, list[float]] = {}
    for metric, vals in series.items():
        if not isinstance(vals, list) or len(vals) != n:
            raise ValueError(
                f"financial_supplements: series {metric!r} must be a list of length {n} "
                f"(same as periods)"
            )
        row: list[float] = []
        for v in vals:
            if v is None:
                row.append(float("nan"))
            else:
                row.append(float(v))
        rows[str(metric)] = row
    df = pd.DataFrame(rows).T
    df.columns = periods
    return df


def canonical_period_label(col) -> str:
    """Normalize Timestamp / 'YYYY-MM-DD 00:00:00' → YYYY-MM-DD for merge."""
    s = str(col).strip()
    if " " in s:
        s = s.split()[0]
    m = re.match(r"^(\d{4}-\d{2}-\d{2})", s)
    return m.group(1) if m else s


def coalesce_period_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Merge duplicate columns that refer to the same period (e.g. str vs Timestamp)."""
    if df is None or df.empty:
        return df
    buckets: dict[str, list] = {}
    for c in df.columns:
        buckets.setdefault(canonical_period_label(c), []).append(c)
    if len(buckets) == len(df.columns):
        out = df.copy()
        out.columns = [canonical_period_label(c) for c in out.columns]
        return out
    merged: dict[str, pd.Series] = {}
    for k, cols in buckets.items():
        acc = df[cols[0]].copy()
        for c in cols[1:]:
            acc = acc.combine_first(df[c])
        merged[k] = acc
    cols_sorted = sorted(merged.keys(), key=lambda x: str(x), reverse=True)
    return pd.DataFrame({c: merged[c] for c in cols_sorted})


def merge_financial_dfs(primary: pd.DataFrame, supplement: pd.DataFrame) -> pd.DataFrame:
    """Keep primary non-null values; supplement fills gaps (same period or extra columns)."""
    if supplement is None or supplement.empty:
        return primary.copy()
    if primary is None or primary.empty:
        return supplement.copy()
    p = coalesce_period_columns(primary.copy())
    s = coalesce_period_columns(supplement.copy())
    p.columns = p.columns.astype(str)
    s.columns = s.columns.astype(str)
    all_idx = p.index.union(s.index)
    all_cols = sorted(set(p.columns) | set(s.columns), key=str, reverse=True)
    p2 = p.reindex(index=all_idx, columns=all_cols)
    s2 = s.reindex(index=all_idx, columns=all_cols)
    return p2.combine_first(s2)


def backfill_margin_percentages(df: pd.DataFrame) -> pd.DataFrame:
    if df is None or df.empty:
        return df
    out = df.copy()
    triples = [
        ("Gross Margin (%)", "Gross Profit", "Revenue"),
        ("Operating Margin (%)", "Operating Income", "Revenue"),
        ("Net Margin (%)", "Net Income", "Revenue"),
    ]
    for m_row, num_row, den_row in triples:
        if m_row not in out.index or num_row not in out.index or den_row not in out.index:
            continue
        for col in out.columns:
            if pd.notna(out.loc[m_row, col]):
                continue
            n = out.loc[num_row, col]
            d = out.loc[den_row, col]
            if not pd.notna(n) or not pd.notna(d):
                continue
            try:
                nf = float(n)
                dfv = float(d)
            except (TypeError, ValueError):
                continue
            if dfv != 0:
                out.loc[m_row, col] = (nf / dfv) * 100.0
    return out


def merge_yahoo_raw_with_supplement(
    yahoo_raw: pd.DataFrame,
    supplement_block: dict | pd.DataFrame | None,
) -> pd.DataFrame:
    """
    yahoo_raw: output of extract_metrics (Yahoo currency units).
    supplement_block: optional JSON block or pre-built DataFrame (already in millions / %).
    """
    if supplement_block is None:
        sup_df = pd.DataFrame()
    elif isinstance(supplement_block, pd.DataFrame):
        sup_df = supplement_block.copy()
    else:
        sup_df = supplement_block_to_dataframe(supplement_block)

    if yahoo_raw is None or yahoo_raw.empty:
        if sup_df.empty:
            return pd.DataFrame()
        out = coalesce_period_columns(sup_df.copy())
        out = backfill_margin_percentages(out)
        out = out.dropna(axis=1, how="all")
        if out.empty:
            return out
        out = sort_financial_statement_rows(out)
        return out[sorted(out.columns.astype(str), reverse=True)]

    df = yahoo_raw.dropna(axis=1, how="all")
    df = df[sorted(df.columns, key=lambda c: str(c), reverse=True)]
    df = coalesce_period_columns(df.copy())
    non_pct = [r for r in df.index if "%" not in r]
    df.loc[non_pct] = df.loc[non_pct] / 1_000_000

    if not sup_df.empty:
        df = merge_financial_dfs(df, sup_df)

    df = coalesce_period_columns(df)
    df = backfill_margin_percentages(df)
    df = df.dropna(axis=1, how="all")
    if df.empty:
        return df
    df = sort_financial_statement_rows(df)
    return df[sorted(df.columns.astype(str), reverse=True)]
