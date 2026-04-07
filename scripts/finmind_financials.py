"""
Auto-fetch Taiwan GAAP financials from FinMind open API (v3) and merge as supplement.

- Income statement lines: single-quarter amounts per period end date.
- Cash flow (operating / investing / financing): FinMind values are cumulative YTD
  within each calendar year; we convert to single-quarter by differencing quarters.

Values from API are NTD (元); this module converts to 百萬台幣 to match Yahoo output.

Disable with env MYTWSTOCK_FINMIND=0
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from typing import Any

import pandas as pd

FINMIND_V3_DATA = "https://api.finmindtrade.com/api/v3/data"

# Earliest date for API query (wide window → enough quarters for 12Q + annual rollups)
DEFAULT_START_DATE = "2010-01-01"

INCOME_TYPES = {
    "Revenue": ["Revenue"],
    "Gross Profit": ["GrossProfit"],
    "Operating Income": ["OperatingIncome"],
    "Net Income": [
        "NetIncome",
        "IncomeAfterTaxes",
        "EquityAttributableToOwnersOfParent",
    ],
    # FinMind 無拆銷管／研發細項；總營業費用作為 G&A 近似，與 Yahoo 合併時 Yahoo 有值則仍以 Yahoo 為準
    "General & Admin Exp": ["OperatingExpenses"],
}

CASH_CUMULATIVE_TYPES = {
    "Op Cash Flow": [
        "NetCashInflowFromOperatingActivities",
        "CashFlowsFromOperatingActivities",
    ],
    "Investing Cash Flow": ["CashProvidedByInvestingActivities"],
    "Financing Cash Flow": ["CashFlowsProvidedFromFinancingActivities"],
}


def finmind_enabled() -> bool:
    return os.environ.get("MYTWSTOCK_FINMIND", "1").strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )


def _http_get_json(url: str, timeout: int = 120) -> dict[str, Any]:
    req = urllib.request.Request(url, headers={"User-Agent": "myTWstock-update_financials/1"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_finmind_dataset(
    dataset: str,
    stock_id: str,
    start_date: str = DEFAULT_START_DATE,
) -> pd.DataFrame:
    params = urllib.parse.urlencode(
        {"dataset": dataset, "stock_id": stock_id, "date": start_date}
    )
    url = f"{FINMIND_V3_DATA}?{params}"
    try:
        payload = _http_get_json(url)
    except (urllib.error.URLError, TimeoutError, OSError):
        return pd.DataFrame()
    if not payload or int(payload.get("status") or 0) != 200:
        return pd.DataFrame()
    rows = payload.get("data")
    if not rows:
        return pd.DataFrame()
    return pd.DataFrame(rows)


def _pick_value(row: pd.Series, type_keys: list[str]) -> float:
    for k in type_keys:
        if k in row.index and pd.notna(row[k]):
            try:
                return float(row[k])
            except (TypeError, ValueError):
                continue
    return float("nan")


def _pivot_statement(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty or "date" not in df.columns or "type" not in df.columns:
        return pd.DataFrame()
    p = df.pivot_table(index="date", columns="type", values="value", aggfunc="first")
    p.index = p.index.astype(str)
    return p


def _deaccumulate_ytd_cash(
    pivot_cf: pd.DataFrame,
    type_keys: list[str],
) -> dict[str, float]:
    """Per calendar year, single-quarter = cum(q) - cum(q-1)."""
    if pivot_cf.empty:
        return {}
    dates = sorted(pivot_cf.index.astype(str))
    by_year: dict[int, list[str]] = defaultdict(list)
    for d in dates:
        try:
            y = int(d[:4])
        except ValueError:
            continue
        by_year[y].append(d)
    out: dict[str, float] = {}
    for _y, ds in sorted(by_year.items()):
        ds = sorted(ds)
        prev_cum = 0.0
        have_prev = False
        for d in ds:
            if d not in pivot_cf.index:
                out[d] = float("nan")
                continue
            cum = _pick_value(pivot_cf.loc[d], type_keys)
            if not have_prev:
                out[d] = cum
                have_prev = True
            else:
                if pd.notna(cum) and pd.notna(prev_cum):
                    out[d] = cum - prev_cum
                else:
                    out[d] = float("nan")
            if pd.notna(cum):
                prev_cum = cum
    return out


def _annual_income_rows(pivot_inc: pd.DataFrame) -> dict[str, dict[str, float]]:
    """Calendar-year totals from four quarter-end rows (all must be present)."""
    years: dict[int, list[str]] = defaultdict(list)
    for d in pivot_inc.index.astype(str):
        if len(d) >= 10 and d[4] == "-" and d[7] == "-":
            try:
                years[int(d[:4])].append(d)
            except ValueError:
                continue
    out: dict[str, dict[str, float]] = {}
    std_q = ["-03-31", "-06-30", "-09-30", "-12-31"]
    for y, ds in sorted(years.items()):
        want = [f"{y}{s}" for s in std_q]
        if not all(q in pivot_inc.index for q in want):
            continue
        label = f"{y}-12-31"
        rowvals: dict[str, float] = {}
        for out_name, type_keys in INCOME_TYPES.items():
            total = 0.0
            ok = True
            for q in want:
                v = _pick_value(pivot_inc.loc[q], type_keys)
                if pd.isna(v):
                    ok = False
                    break
                total += v
            rowvals[out_name] = total / 1_000_000 if ok else float("nan")
        out[label] = rowvals
    return out


def _annual_cash_row(pivot_cf: pd.DataFrame, year: int) -> dict[str, float]:
    d = f"{year}-12-31"
    if d not in pivot_cf.index:
        return {}
    rowvals = {}
    for out_name, keys in CASH_CUMULATIVE_TYPES.items():
        v = _pick_value(pivot_cf.loc[d], keys)
        rowvals[out_name] = v / 1_000_000 if pd.notna(v) else float("nan")
    return rowvals


def build_finmind_extension_dataframes(
    ticker: str,
    start_date: str = DEFAULT_START_DATE,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    Returns (annual_df, quarterly_df) in million NTD, column labels YYYY-MM-DD,
    index aligned with extract_metrics row names where possible.
    """
    if not finmind_enabled():
        return pd.DataFrame(), pd.DataFrame()

    stock_id = str(ticker).strip().replace(".TW", "").replace(".TWO", "")
    if not stock_id.isdigit():
        return pd.DataFrame(), pd.DataFrame()

    inc = fetch_finmind_dataset("FinancialStatements", stock_id, start_date)
    cf = fetch_finmind_dataset("TaiwanCashFlowsStatement", stock_id, start_date)
    pivot_inc = _pivot_statement(inc)
    pivot_cf = _pivot_statement(cf)
    if pivot_inc.empty:
        return pd.DataFrame(), pd.DataFrame()

    # --- Quarterly: income (元 → 百萬) + de-accumulated cash
    q_dates = sorted(pivot_inc.index.astype(str))
    q_data: dict[str, dict[str, float]] = {d: {} for d in q_dates}

    for out_name, keys in INCOME_TYPES.items():
        for d in q_dates:
            if d not in pivot_inc.index:
                continue
            v = _pick_value(pivot_inc.loc[d], keys)
            q_data[d][out_name] = v / 1_000_000 if pd.notna(v) else float("nan")

    for out_name, keys in CASH_CUMULATIVE_TYPES.items():
        single = _deaccumulate_ytd_cash(pivot_cf, keys)
        for d in q_dates:
            v = single.get(d, float("nan"))
            q_data[d][out_name] = v / 1_000_000 if pd.notna(v) else float("nan")

    q_cols = sorted(q_data.keys(), reverse=True)
    q_metrics = sorted({k for d in q_data for k in q_data[d].keys()})
    quarterly_df = pd.DataFrame.from_dict(
        {m: [q_data[c].get(m, float("nan")) for c in q_cols] for m in q_metrics},
        orient="index",
        columns=q_cols,
    )

    # --- Annual: sum 4 quarters for P&L; 12-31 YTD for cash
    annual_income = _annual_income_rows(pivot_inc)
    annual: dict[str, dict[str, float]] = {}
    for label, pl in annual_income.items():
        try:
            y = int(label[:4])
        except ValueError:
            continue
        row = dict(pl)
        row.update(_annual_cash_row(pivot_cf, y))
        annual[label] = row

    if not annual:
        annual_df = pd.DataFrame()
    else:
        a_cols = sorted(annual.keys(), reverse=True)
        a_metrics = sorted({k for v in annual.values() for k in v.keys()})
        annual_df = pd.DataFrame.from_dict(
            {m: [annual[c].get(m, float("nan")) for c in a_cols] for m in a_metrics},
            orient="index",
            columns=a_cols,
        )

    return annual_df, quarterly_df


def merge_manual_and_finmind_supplements(
    manual_annual: dict | None,
    manual_quarterly: dict | None,
    finmind_annual: pd.DataFrame,
    finmind_quarterly: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Manual JSON (if any) overrides FinMind; used before Yahoo merge."""
    from financial_supplement import merge_financial_dfs, supplement_block_to_dataframe

    m_a = supplement_block_to_dataframe(manual_annual) if manual_annual else pd.DataFrame()
    m_q = (
        supplement_block_to_dataframe(manual_quarterly) if manual_quarterly else pd.DataFrame()
    )
    a = merge_financial_dfs(m_a, finmind_annual)
    q = merge_financial_dfs(m_q, finmind_quarterly)
    return a, q
