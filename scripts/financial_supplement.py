"""
Local supplements + merge with Yahoo / FinMind.

Place ``data/financial_supplements/{ticker}.json`` (e.g. ``2330.json``).
合併優先順序由 ``MYTWSTOCK_FINANCE_PRIMARY`` 決定（預設 finmind：FinMind 為主、Yahoo 補缺）。
Money rows **百萬台幣**; **EPS** **元／股**; margins **%**. Periods ``YYYY-MM-DD``.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Literal

import pandas as pd

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUPPLEMENT_DIR = os.path.join(PROJECT_ROOT, "data", "financial_supplements")


def finance_data_primary_source() -> Literal["finmind", "yahoo"]:
    """
    財務數字合併時誰優先（非缺值才覆蓋另一來源）。
    - finmind（預設）：FinMind＋手動補丁為主，Yahoo 僅補缺（台股欄位較一致）。
    - yahoo：舊行為，Yahoo 為主，FinMind／補丁補缺。
    環境變數：MYTWSTOCK_FINANCE_PRIMARY=yahoo | finmind
    """
    v = os.environ.get("MYTWSTOCK_FINANCE_PRIMARY", "finmind").strip().lower()
    if v in ("yahoo", "yf", "yfinance"):
        return "yahoo"
    return "finmind"

# 報告財務表列順序。merge_financial_dfs 使用 index.union 會變成字母序，需還原；營收列置頂。
FINANCIAL_STATEMENT_ROW_ORDER = (
    "Revenue",
    "Cost of Revenue",
    "Gross Profit",
    "Gross Margin (%)",
    "Selling & Marketing Exp",
    "R&D Exp",
    "General & Admin Exp",
    "Operating Income",
    "Operating Margin (%)",
    "Net Income",
    "Net Margin (%)",
    "EPS",
    "Op Cash Flow",
    "Investing Cash Flow",
    "Financing Cash Flow",
    "CAPEX",
)

# Columns kept for quarterlyCore JSON: dropna(axis=1) uses only these rows so detail NaN
# does not remove periods that have Revenue / margins / core cash flow.
QUARTERLY_JSON_CORE_ROWS = (
    "Revenue",
    "Cost of Revenue",
    "Gross Profit",
    "Gross Margin (%)",
    "Operating Income",
    "Operating Margin (%)",
    "Net Income",
    "Net Margin (%)",
    "EPS",
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


# 年度 *-12-31 欄若缺值：毛利／營業利益僅能由四季單季加總（須四季欄位與數值皆齊）。
# 三項費用：先四季單季加總；若任一季缺欄或缺值導致無法加總，再 fallback 至
# ``quarterly_ytd`` 該年 12-31（與「累積合併」Q4／MOPS 全年累計一致）。
_ANNUAL_FROM_QUARTERLY_SUM_METRICS: tuple[str, ...] = (
    "Gross Profit",
    "Operating Income",
)
_ANNUAL_FROM_QUARTERLY_EXPENSE_YTD_METRICS: tuple[str, ...] = (
    "Selling & Marketing Exp",
    "R&D Exp",
    "General & Admin Exp",
)

# 若年表 merge 後完全沒有該列（常見於 MOPS 核心＋Yahoo 年報缺列），仍須建立 NaN 列，
# 後續才能由季表加總／YTD 補齊（否則 JSON 缺鍵、內文表與 KPI 皆空）。
_ANNUAL_ROWS_SEED_FOR_QUARTERLY_BACKFILL: tuple[str, ...] = (
    *_ANNUAL_FROM_QUARTERLY_EXPENSE_YTD_METRICS,
    *_ANNUAL_FROM_QUARTERLY_SUM_METRICS,
    "CAPEX",
)


def _calendar_year_quarter_end_labels(year: str) -> tuple[str, str, str, str]:
    return (
        f"{year}-03-31",
        f"{year}-06-30",
        f"{year}-09-30",
        f"{year}-12-31",
    )


def _fiscal_year_str_from_annual_column(lab: str) -> str | None:
    """僅曆年終 YYYY-12-31 → 西元年字串；其餘年度欄不由此路徑補洞。"""
    m = re.match(r"^(\d{4})-12-31$", lab)
    return m.group(1) if m else None


def backfill_annual_from_quarterly(
    df_annual: pd.DataFrame,
    df_quarterly: pd.DataFrame,
    df_quarterly_ytd: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """
    掃描年度表各欄（曆年終 *-12-31）。

    - **Selling／R&D／G&A**：若年度為 null，先試四季單季加總；若無法加總（缺欄或
      任一季為 null），再取 ``df_quarterly_ytd`` 之 ``YYYY-12-31``。
    - **Gross Profit、Operating Income**：僅四季單季加總（須四季欄位齊全且皆有值）。
    - **CAPEX**：年報缺時四季加總；若四季皆為疑似 Yahoo 千級殘渣（|v| 全 < 8000）則不寫入。
    Margin 列不加總；最後以 ``backfill_margin_percentages`` 依金額重算。
    """
    if df_annual is None or df_annual.empty:
        return df_annual if df_annual is not None else pd.DataFrame()
    if df_quarterly is None or df_quarterly.empty:
        return df_annual.copy()

    out = df_annual.copy()
    missing_rows = [m for m in _ANNUAL_ROWS_SEED_FOR_QUARTERLY_BACKFILL if m not in out.index]
    if missing_rows:
        pad = pd.DataFrame(float("nan"), index=missing_rows, columns=out.columns)
        out = pd.concat([out, pad])
        out = sort_financial_statement_rows(out)

    q = coalesce_period_columns(df_quarterly.copy())
    q.columns = [canonical_period_label(c) for c in q.columns]

    ytd: pd.DataFrame | None = None
    if df_quarterly_ytd is not None and not df_quarterly_ytd.empty:
        ytd = coalesce_period_columns(df_quarterly_ytd.copy())
        ytd.columns = [canonical_period_label(c) for c in ytd.columns]

    for acol in out.columns:
        lab = canonical_period_label(acol)
        year = _fiscal_year_str_from_annual_column(lab)
        if year is None:
            continue
        q_labels = _calendar_year_quarter_end_labels(year)
        q4_lab = f"{year}-12-31"
        quarters_all_in_q = all(ql in q.columns for ql in q_labels)

        for metric in _ANNUAL_FROM_QUARTERLY_EXPENSE_YTD_METRICS:
            if metric not in out.index:
                continue
            if pd.notna(out.loc[metric, acol]):
                continue
            summed = False
            if (
                metric in q.index
                and quarters_all_in_q
            ):
                vals = [q.loc[metric, ql] for ql in q_labels]
                if not any(pd.isna(v) for v in vals):
                    try:
                        out.loc[metric, acol] = sum(float(v) for v in vals)
                        summed = True
                    except (TypeError, ValueError):
                        summed = False
            if summed:
                continue
            if (
                ytd is not None
                and metric in ytd.index
                and q4_lab in ytd.columns
                and pd.notna(ytd.loc[metric, q4_lab])
            ):
                try:
                    out.loc[metric, acol] = float(ytd.loc[metric, q4_lab])
                except (TypeError, ValueError):
                    pass

        if not quarters_all_in_q:
            continue

        for metric in _ANNUAL_FROM_QUARTERLY_SUM_METRICS:
            if metric not in out.index:
                continue
            if pd.notna(out.loc[metric, acol]):
                continue
            if metric not in q.index:
                continue
            vals = [q.loc[metric, ql] for ql in q_labels]
            if any(pd.isna(v) for v in vals):
                continue
            try:
                total = sum(float(v) for v in vals)
            except (TypeError, ValueError):
                continue
            out.loc[metric, acol] = total

        cap_m = "CAPEX"
        if (
            cap_m in out.index
            and pd.isna(out.loc[cap_m, acol])
            and cap_m in q.index
            and quarters_all_in_q
        ):
            cvals = [q.loc[cap_m, ql] for ql in q_labels]
            if not any(pd.isna(v) for v in cvals):
                try:
                    cfloats = [float(v) for v in cvals]
                except (TypeError, ValueError):
                    cfloats = []
                if cfloats and not all(abs(x) < 8_000 for x in cfloats):
                    out.loc[cap_m, acol] = sum(cfloats)

    out = backfill_margin_percentages(out)
    out = sort_financial_statement_rows(out)
    return out


def merge_yahoo_raw_with_supplement_pre_dropna(
    yahoo_raw: pd.DataFrame,
    supplement_block: dict | pd.DataFrame | None,
    *,
    strip_yahoo_quarterly_capex: bool = False,
) -> pd.DataFrame:
    """
    Same merge as merge_yahoo_raw_with_supplement but before dropna(axis=1).
    Used to derive quarterlyCore with a narrower column-drop rule.

    ``strip_yahoo_quarterly_capex``：僅季表合併應設 True（Yahoo 季 CAPEX 不可靠）；
    年表經 ``merge_yahoo_raw_with_supplement`` 呼叫時必須為 False，否則會清空年報資本支出。
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
        return out

    df = yahoo_raw.dropna(axis=1, how="all")
    df = df[sorted(df.columns, key=lambda c: str(c), reverse=True)]
    df = coalesce_period_columns(df.copy())
    # Yahoo 損益／現流大數為「元」→ 百萬元；EPS 已是每股幣值，不可除以 1e6
    _skip_scale = frozenset({"EPS"})
    non_pct = [r for r in df.index if "%" not in r and r not in _skip_scale]
    df.loc[non_pct] = df.loc[non_pct] / 1_000_000
    if strip_yahoo_quarterly_capex and "CAPEX" in df.index:
        df = df.drop(index="CAPEX")

    if not sup_df.empty:
        if finance_data_primary_source() == "yahoo":
            df = merge_financial_dfs(df, sup_df)
        else:
            df = merge_financial_dfs(sup_df, df)

    df = coalesce_period_columns(df)
    df = backfill_margin_percentages(df)
    return df


def _finalize_merged_financial_columns(
    df: pd.DataFrame,
    column_drop: Literal["all_rows", "core_rows_only"],
) -> pd.DataFrame:
    if df is None or df.empty:
        return df
    if column_drop == "all_rows":
        out = df.dropna(axis=1, how="all")
    else:
        idx = [r for r in QUARTERLY_JSON_CORE_ROWS if r in df.index]
        if not idx:
            out = df.dropna(axis=1, how="all")
        else:
            sub = df.loc[idx]
            keep = sub.columns[sub.notna().any(axis=0)]
            out = df[keep].dropna(axis=1, how="all")
    if out.empty:
        return out
    out = sort_financial_statement_rows(out)
    return out[sorted(out.columns.astype(str), reverse=True)]


def quarterly_core_from_pre_merge(pre: pd.DataFrame) -> pd.DataFrame:
    """Wider quarterly columns for charts when full merge drops periods due to detail NaN."""
    return _finalize_merged_financial_columns(pre, "core_rows_only")


def merge_yahoo_raw_with_supplement(
    yahoo_raw: pd.DataFrame,
    supplement_block: dict | pd.DataFrame | None,
) -> pd.DataFrame:
    """
    yahoo_raw: output of extract_metrics (Yahoo currency units).
    supplement_block: manual+FinMind merged DataFrame（百萬／％）。
    合併順序見 ``finance_data_primary_source()``（預設 FinMind 為主）。
    """
    pre = merge_yahoo_raw_with_supplement_pre_dropna(
        yahoo_raw, supplement_block, strip_yahoo_quarterly_capex=False
    )
    return _finalize_merged_financial_columns(pre, "all_rows")
