"""
update_financials.py — Refresh financial tables in ticker reports.

Fetches latest annual (up to 5yr in MD/JSON) and quarterly (up to 16Q in MD/JSON) from yfinance.
欄位以損益表期別為準對齊現金流，避免合併時多出「全 NaN」幽靈欄。16 季／5 年為上限；Yahoo 對 2330.TW
等標的之 quarterly_income_stmt 通常僅約 6 個季度欄，且部分期別營收等核心列為 NaN，經 dropna(how="all")
後圖表常僅剩約 5 季、年度約 4 年。完整長歷史需 MOPS／年報或其他資料源，非本腳本單靠 yfinance 可保證。
預設會自動自 FinMind 公開 API 拉台股財報並與 Yahoo 合併（Yahoo 優先）；設 MYTWSTOCK_FINMIND=0 可關閉。
可另建 data/financial_supplements/{代號}.json 覆寫 FinMind／填缺，見 scripts/financial_supplement.py。
then replaces ONLY the ## 財務概況 section in each report file.
All enrichment content (業務簡介, 供應鏈, 客戶供應商) is preserved.

Usage:
  python scripts/update_financials.py                  # Update ALL tickers
  python scripts/update_financials.py 2330             # Single ticker
  python scripts/update_financials.py 2330 2317 3034   # Multiple tickers
  python scripts/update_financials.py --batch 101      # All tickers in a batch
  python scripts/update_financials.py --sector Semiconductors  # Entire sector
  python scripts/update_financials.py --dry-run 2330   # Preview without writing

Units: 百萬台幣 (Million NTD). Margins in %.
"""

import json
import os
import re
import sys
import time
from datetime import datetime, timezone

import pandas as pd
import yfinance as yf

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 年度／季度表欄位上限（新→舊截取）；JSON 季可多留供統計
ANNUAL_MD_MAX_COLS = 5
ANNUAL_JSON_MAX_COLS = 5
QUARTERLY_MD_MAX_COLS = 16
QUARTERLY_JSON_MAX_COLS = 16

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from utils import (
    find_ticker_files, parse_scope_args, setup_stdout,
    fetch_valuation_data, build_valuation_table, update_metadata,
)
from financial_supplement import (
    canonical_period_label,
    load_financial_supplement,
    merge_yahoo_raw_with_supplement,
)
from finmind_financials import (
    build_finmind_extension_dataframes,
    merge_manual_and_finmind_supplements,
)

# Financial metrics to extract
METRICS_KEYS = {
    "revenue": ["Total Revenue"],
    "gross_profit": ["Gross Profit"],
    "selling_exp": [
        "Selling And Marketing Expense",
        "Sales And Marketing",
        "Selling Expense",
        "Marketing Expense",
        "Selling And Distribution Expenses",
    ],
    "rd_exp": [
        "Research And Development",
        "Research Development",
        "Research And Development Expense",
        "Research And Design Expenses",
    ],
    "admin_exp": ["General And Administrative Expense"],
    "operating_income": ["Operating Income"],
    "net_income": ["Net Income", "Net Income Common Stockholders"],
    "ocf": ["Operating Cash Flow", "Total Cash From Operating Activities"],
    "icf": ["Investing Cash Flow", "Total Cashflows From Investing Activities"],
    "fcf": ["Financing Cash Flow", "Total Cash From Financing Activities"],
    "capex": [
        "Capital Expenditure",
        "Capital Expenditures",
        "Purchase Of Ppe",
        "Purchases Of Property Plant And Equipment",
        "Purchase Of Property Plant Equipment",
        "Net PPE Purchase And Sale",
        "Capital Expenditure Reported",
    ],
}


def get_series(df, keys):
    for key in keys:
        if key in df.index:
            return df.loc[key]
    return pd.Series(dtype=float)


def calc_margin(numerator, denominator):
    if denominator.empty or numerator.empty:
        return pd.Series(dtype=float)
    result = (numerator / denominator) * 100
    result = result.replace([float("inf"), float("-inf")], float("nan"))
    return result


def calc_admin_exp(income_stmt):
    """Get G&A expense, falling back to SGA − Selling (− R&D) if G&A is missing."""
    admin = get_series(income_stmt, METRICS_KEYS["admin_exp"])
    selling = get_series(income_stmt, METRICS_KEYS["selling_exp"])
    rd = get_series(income_stmt, METRICS_KEYS["rd_exp"])
    sga = get_series(income_stmt, ["Selling General And Administration"])

    if admin.empty and not sga.empty and not selling.empty and not rd.empty:
        return sga - selling - rd
    if admin.empty and not sga.empty and not selling.empty:
        return sga - selling
    if admin.empty and not sga.empty and not rd.empty:
        return sga - rd
    if not admin.empty and not sga.empty and not selling.empty:
        derived = sga - selling
        return admin.fillna(derived)
    return admin


def fill_selling_rd_from_sga(
    selling: pd.Series,
    admin: pd.Series,
    rd: pd.Series,
    sga: pd.Series,
) -> tuple[pd.Series, pd.Series]:
    """Yahoo 有 SGA 與 G&A 時，用 SGA − G&A − 已知邊補另一邊缺欄（逐期）。"""
    out_s = selling.copy()
    out_r = rd.copy()
    if sga.empty or admin.empty:
        return out_s, out_r
    for _ in range(2):
        m_s = out_s.isna() & sga.notna() & admin.notna() & out_r.notna()
        out_s[m_s] = (sga - admin - out_r)[m_s]
        m_r = out_r.isna() & sga.notna() & admin.notna() & out_s.notna()
        out_r[m_r] = (sga - admin - out_s)[m_r]
    return out_s, out_r


def _col_label(c):
    return c.strftime("%Y-%m-%d") if hasattr(c, "strftime") else str(c)


def _align_raw_series(s: pd.Series, periods_ts: list, period_labels: list) -> pd.Series:
    """Map a Series indexed by statement column timestamps onto period_labels (newest-first)."""
    vals = []
    for ts in periods_ts:
        if s is None or s.empty:
            vals.append(float("nan"))
            continue
        v = float("nan")
        if ts in s.index:
            raw = s.loc[ts]
            v = float(raw) if pd.notna(raw) else float("nan")
        else:
            lbl = _col_label(ts)
            for idx in s.index:
                if _col_label(idx) == lbl:
                    raw = s.loc[idx]
                    v = float(raw) if pd.notna(raw) else float("nan")
                    break
        vals.append(v)
    return pd.Series(vals, index=period_labels, dtype=float)


def _align_get_series(stmt: pd.DataFrame, keys: list, periods_ts: list, period_labels: list) -> pd.Series:
    if stmt is None or stmt.empty:
        return pd.Series([float("nan")] * len(period_labels), index=period_labels, dtype=float)
    return _align_raw_series(get_series(stmt, keys), periods_ts, period_labels)


def _align_coalesce_rows(
    stmt: pd.DataFrame, keys: list, periods_ts: list, period_labels: list
) -> pd.Series:
    """同一指標多個現金流列名時，依序補缺（先 Capital Expenditure，再 Purchase of PPE 等）。"""
    if stmt is None or stmt.empty:
        return pd.Series([float("nan")] * len(period_labels), index=period_labels, dtype=float)
    out = pd.Series([float("nan")] * len(period_labels), dtype=float, index=period_labels)
    for key in keys:
        if key not in stmt.index:
            continue
        part = _align_raw_series(stmt.loc[key], periods_ts, period_labels)
        out = out.combine_first(part)
    return out


def extract_metrics(income_stmt, cashflow):
    """Build metrics with columns exactly matching income_stmt periods (newest first).

    Cash-flow rows are reindexed to those dates only, so union-of-all-series no longer
    adds extra period columns that are all-NaN for P&L and get dropped by dropna(how='all').
    """
    if income_stmt is None or income_stmt.empty:
        return pd.DataFrame()

    if cashflow is None or (hasattr(cashflow, "empty") and cashflow.empty):
        cashflow = pd.DataFrame()

    periods_ts = sorted(income_stmt.columns, reverse=True)
    period_labels = [_col_label(c) for c in periods_ts]

    rev = _align_get_series(income_stmt, METRICS_KEYS["revenue"], periods_ts, period_labels)
    gp = _align_get_series(income_stmt, METRICS_KEYS["gross_profit"], periods_ts, period_labels)
    op_inc = _align_get_series(income_stmt, METRICS_KEYS["operating_income"], periods_ts, period_labels)
    ni = _align_get_series(income_stmt, METRICS_KEYS["net_income"], periods_ts, period_labels)

    gm = (gp / rev * 100.0).replace([float("inf"), float("-inf")], float("nan"))
    om = (op_inc / rev * 100.0).replace([float("inf"), float("-inf")], float("nan"))
    nm = (ni / rev * 100.0).replace([float("inf"), float("-inf")], float("nan"))

    ocf = _align_get_series(cashflow, METRICS_KEYS["ocf"], periods_ts, period_labels)
    icf = _align_get_series(cashflow, METRICS_KEYS["icf"], periods_ts, period_labels)
    fin_cf = _align_get_series(cashflow, METRICS_KEYS["fcf"], periods_ts, period_labels)
    capex = _align_coalesce_rows(cashflow, METRICS_KEYS["capex"], periods_ts, period_labels)
    fcf_free = _align_get_series(cashflow, ["Free Cash Flow"], periods_ts, period_labels)

    if ocf.notna().any() and fcf_free.notna().any():
        derived_capex = fcf_free - ocf
        if capex.notna().any():
            capex = capex.fillna(derived_capex)
        else:
            capex = derived_capex

    selling_raw = _align_get_series(
        income_stmt, METRICS_KEYS["selling_exp"], periods_ts, period_labels
    )
    rd_raw = _align_get_series(income_stmt, METRICS_KEYS["rd_exp"], periods_ts, period_labels)
    admin_aligned = _align_raw_series(calc_admin_exp(income_stmt), periods_ts, period_labels)
    sga_aligned = _align_get_series(
        income_stmt, ["Selling General And Administration"], periods_ts, period_labels
    )
    selling_f, rd_f = fill_selling_rd_from_sga(selling_raw, admin_aligned, rd_raw, sga_aligned)

    data = {
        "Revenue": rev,
        "Gross Profit": gp,
        "Gross Margin (%)": gm,
        "Selling & Marketing Exp": selling_f,
        "R&D Exp": rd_f,
        "General & Admin Exp": admin_aligned,
        "Operating Income": op_inc,
        "Operating Margin (%)": om,
        "Net Income": ni,
        "Net Margin (%)": nm,
        "Op Cash Flow": ocf,
        "Investing Cash Flow": icf,
        "Financing Cash Flow": fin_cf,
        "CAPEX": capex,
    }

    return pd.DataFrame(data).T


def fetch_financials(ticker):
    """Fetch financial data. Tries .TW then .TWO suffix."""
    for suffix in [".TW", ".TWO"]:
        try:
            stock = yf.Ticker(f"{ticker}{suffix}")
            income = stock.income_stmt
            if income is None or income.empty:
                continue

            sup = load_financial_supplement(ticker)
            fm_annual, fm_quarterly = build_finmind_extension_dataframes(ticker)
            merged_annual, merged_quarterly = merge_manual_and_finmind_supplements(
                sup.get("annual") if sup else None,
                sup.get("quarterly") if sup else None,
                fm_annual,
                fm_quarterly,
            )

            df_annual = extract_metrics(stock.income_stmt, stock.cashflow)
            df_annual = merge_yahoo_raw_with_supplement(
                df_annual,
                merged_annual if merged_annual is not None and not merged_annual.empty else None,
            )
            df_annual_json = pd.DataFrame()
            if not df_annual.empty:
                nac = df_annual.shape[1]
                df_annual_json = df_annual.iloc[
                    :, : min(ANNUAL_JSON_MAX_COLS, nac)
                ].copy()
                df_annual = df_annual.iloc[:, : min(ANNUAL_MD_MAX_COLS, nac)].copy()

            df_quarterly = extract_metrics(
                stock.quarterly_income_stmt, stock.quarterly_cashflow
            )
            df_quarterly = merge_yahoo_raw_with_supplement(
                df_quarterly,
                merged_quarterly
                if merged_quarterly is not None and not merged_quarterly.empty
                else None,
            )
            df_quarterly_json = pd.DataFrame()
            if not df_quarterly.empty:
                nqc = df_quarterly.shape[1]
                df_quarterly_json = df_quarterly.iloc[
                    :, : min(QUARTERLY_JSON_MAX_COLS, nqc)
                ].copy()
                df_quarterly = df_quarterly.iloc[
                    :, : min(QUARTERLY_MD_MAX_COLS, nqc)
                ].copy()

            info = stock.info
            market_cap = (
                f"{info['marketCap'] / 1_000_000:,.0f}"
                if info.get("marketCap")
                else None
            )
            enterprise_value = (
                f"{info['enterpriseValue'] / 1_000_000:,.0f}"
                if info.get("enterpriseValue")
                else None
            )

            valuation = fetch_valuation_data(info)

            return {
                "annual": df_annual,
                "quarterly": df_quarterly,
                "annual_json": df_annual_json,
                "quarterly_json": df_quarterly_json,
                "valuation": valuation,
                "market_cap": market_cap,
                "enterprise_value": enterprise_value,
                "sector": info.get("sector", "N/A"),
                "industry": info.get("industry", "N/A"),
                "suffix": suffix,
            }
        except Exception:
            continue
    return None


def md_column_label_annual(col) -> str:
    """報告 MD 年度表欄名：僅西元年。"""
    s = canonical_period_label(col)
    m = re.match(r"^(\d{4})-\d{2}-\d{2}", s)
    return m.group(1) if m else str(s)


def md_column_label_quarter(col) -> str:
    """報告 MD 季度表欄名：YYYY Q1…Q4（日曆季末）。"""
    s = canonical_period_label(col)
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", s)
    if not m:
        return str(s)
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    quarter_end = {(3, 31): 1, (6, 30): 2, (9, 30): 3, (12, 31): 4}
    q = quarter_end.get((mo, d))
    if q is None:
        return str(s)
    return f"{y} Q{q}"


def dataframe_for_md_display(df: pd.DataFrame, kind: str) -> pd.DataFrame:
    """複製並改欄名供 MD 顯示；JSON 仍用原始 YYYY-MM-DD 欄。"""
    out = df.copy()
    if kind == "annual":
        out.columns = [md_column_label_annual(c) for c in out.columns]
    else:
        out.columns = [md_column_label_quarter(c) for c in out.columns]
    return out


def df_to_clean_markdown(df):
    """Format DataFrame to markdown with .2f precision, then replace NaN with -."""
    # Format numbers first while dtype is still float
    md = df.to_markdown(floatfmt=".2f")
    # Replace nan strings that to_markdown generates for NaN values
    md = md.replace(" nan ", " - ")
    md = md.replace(" nan|", " -|")
    md = md.replace("|nan ", "|- ")
    # Also handle edge cases with padding
    md = re.sub(r'\bnan\b', '-', md)
    return md


def _dataframe_to_json_block(df):
    """Chronological periods (oldest first); series aligned to periods."""
    if df is None or df.empty:
        return None
    periods = sorted(df.columns, key=lambda x: str(x))
    series = {}
    for metric in df.index:
        row = df.loc[metric]
        vals = []
        for p in periods:
            v = row[p]
            if pd.isna(v):
                vals.append(None)
            else:
                vals.append(float(v))
        series[str(metric)] = vals
    return {"periods": [str(p) for p in periods], "series": series}


def _valuation_to_json_numbers(v):
    if not v:
        return {}
    out = {}
    keys = [
        "P/E (TTM)",
        "Forward P/E",
        "P/S (TTM)",
        "P/B",
        "EV/EBITDA",
        "ROE",
        "Beta",
        "Debt/Equity",
    ]
    for k in keys:
        raw = v.get(k)
        if raw is None or raw == "N/A":
            out[k] = None
            continue
        try:
            if k == "ROE":
                out[k] = float(str(raw).strip().rstrip("%").strip())
            else:
                out[k] = float(raw)
        except (TypeError, ValueError):
            out[k] = None
    return out


def write_financials_json(ticker, data, dry_run=False):
    """Emit web/public/data/financials/{ticker}.json for charts / sector aggregates."""
    if dry_run:
        return
    out_dir = os.path.join(PROJECT_ROOT, "web", "public", "data", "financials")
    os.makedirs(out_dir, exist_ok=True)
    payload = {
        "ticker": ticker,
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "unit": "Million NTD; margin rows are percent",
        "valuation": _valuation_to_json_numbers(data.get("valuation")),
        "annual": _dataframe_to_json_block(data.get("annual_json")),
        "quarterly": _dataframe_to_json_block(data.get("quarterly_json")),
    }
    path = os.path.join(out_dir, f"{ticker}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def build_financial_section(data):
    section = "## 財務概況 (單位: 百萬台幣, 只有 Margin 為 %)\n"

    # Valuation snapshot
    v = data.get("valuation", {})
    if v:
        section += build_valuation_table(v) + "\n\n"

    section += f"### 年度關鍵財務數據 (近 {ANNUAL_MD_MAX_COLS} 年)\n"
    if data["annual"] is not None and not data["annual"].empty:
        section += df_to_clean_markdown(
            dataframe_for_md_display(data["annual"], "annual")
        ) + "\n\n"
    else:
        section += "無可用數據。\n\n"
    section += f"### 季度關鍵財務數據 (近 {QUARTERLY_MD_MAX_COLS} 季)\n"
    if data["quarterly"] is not None and not data["quarterly"].empty:
        section += df_to_clean_markdown(
            dataframe_for_md_display(data["quarterly"], "quarterly")
        ) + "\n"
    else:
        section += "無可用數據。\n"
    return section


def update_file(filepath, ticker, dry_run=False):
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    data = fetch_financials(ticker)
    if data is None:
        print(f"  {ticker}: SKIP (no data from yfinance)")
        return False

    new_fin = build_financial_section(data)

    if re.search(r"## 財務概況", content):
        new_content = re.sub(r"## 財務概況.*", new_fin, content, flags=re.DOTALL)
    else:
        new_content = content.rstrip() + "\n\n" + new_fin

    # Update metadata
    new_content = update_metadata(new_content, data.get("market_cap"), data.get("enterprise_value"))

    if dry_run:
        print(f"  {ticker}: WOULD UPDATE ({data['suffix']})")
        return True

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(new_content)
    write_financials_json(ticker, data, dry_run=False)
    print(f"  {ticker}: UPDATED ({data['suffix']})")
    return True


def main():
    setup_stdout()

    args = list(sys.argv[1:])
    dry_run = "--dry-run" in args
    if dry_run:
        args.remove("--dry-run")

    tickers, sector, desc = parse_scope_args(args)
    print(f"Updating financials for {desc}...")
    files = find_ticker_files(tickers, sector)

    if not files:
        print("No matching files found.")
        return

    print(f"Found {len(files)} files.\n")
    updated = failed = skipped = 0

    for ticker in sorted(files.keys()):
        try:
            if update_file(files[ticker], ticker, dry_run):
                updated += 1
            else:
                skipped += 1
        except Exception as e:
            print(f"  {ticker}: ERROR ({e})")
            failed += 1
        time.sleep(0.5)

    print(f"\nDone. Updated: {updated} | Skipped: {skipped} | Failed: {failed}")


if __name__ == "__main__":
    main()
