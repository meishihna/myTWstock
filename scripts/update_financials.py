"""
update_financials.py — Refresh financial tables in ticker reports.

季表（``MYTWSTOCK_MOPS=1``）：手動補丁 > **MOPS t163**（sb06 營益比率％；sb04 一般業 **Revenue／COR／GP／OI** 精確金額與 NI／EPS；**sb20 現金流三項**）>
**FinMind 現金流**（僅補 MOPS 缺欄）> **Yahoo**（費用拆分；**Yahoo 季 CAPEX 不使用**；季現金流僅補缺）> **MOPS t164** 補費用／CAPEX。
合併後會修正 Yahoo 將**費用／淨利 Q4 誤植為全年**（與同年 *-12-31* annual 比對後改回單季）；修正套在 **pre_merge** 上，使 ``quarterly`` 與 ``quarterlyCore`` 一致。
合併後、``maybe_fill`` 前將季表 **CAPEX 整列清空**，僅由 **MOPS t164 sb05** 寫入（不用 Yahoo／手動補丁的季 CAPEX）；年報 CAPEX 仍來自 Yahoo 年合併，缺值時見 ``backfill_annual_from_quarterly``。
``MYTWSTOCK_MOPS=0`` 時季表仍為 FinMind＋Yahoo（``MYTWSTOCK_FINANCE_PRIMARY``）。
年度表仍為 Yahoo 合併 FinMind／補丁；寫入 JSON 前若 *-12-31 欄缺費用拆分等，會由同年曆年四季加總補齊（須四季皆完整）。JSON 欄數滾動（預設 8 年／32 季），MD 表欄數隨 JSON。
可另建 data/financial_supplements/{代號}.json **覆寫所有來源**，見 scripts/financial_supplement.py。
then replaces ONLY the ## 財務概況 section in each report file.
All enrichment content (業務簡介, 供應鏈, 客戶供應商) is preserved.

Usage:
  python scripts/update_financials.py                  # Update ALL tickers
  python scripts/update_financials.py 2330             # Single ticker
  python scripts/update_financials.py 2330 2317 3034   # Multiple tickers
  python scripts/update_financials.py --batch 101      # All tickers in a batch
  python scripts/update_financials.py --sector Semiconductors  # Entire sector
  python scripts/update_financials.py --dry-run 2330   # Preview without writing
  python scripts/update_financials.py --resume           # Only tickers in data/.financials_update_checkpoint.json
  python scripts/update_financials.py --clear-checkpoint
  python scripts/update_financials.py --sleep-sec 10     # 每處理完一檔後等待 10 秒（全公司更新建議，降 FinMind 限流）

Env: MYTWSTOCK_FINMIND_SLEEP_SEC, MYTWSTOCK_FINMIND=0, FINMIND_TIMEOUT, FINMIND_MAX_RETRIES, etc.
  FINMIND_MAX_CALLS_PER_HOUR — FinMind 全程序共用節流（預設 280，約保留安全邊際；有 token 可酌調高如 580）。
  FINMIND_TOKEN 或 FINMIND_API_TOKEN — 官網使用者資訊頁的 JWT；腳本改走 **v4** API 並帶 ``Authorization: Bearer …``（見 https://finmind.github.io/login/ ）。**勿將 token 寫入程式或提交 git**，用環境變數即可。
  FINMIND_USER_ID + FINMIND_PASSWORD（或 FINMIND_API_USER / FINMIND_API_PASSWORD）— 僅在未設 token 時使用之 v3 query 帳密；與 token 並存時以 token 為準。
  FINMIND_REQUEST_SLEEP_SEC — 同一檔內兩次 FinMind 請求之間額外等待（秒），0＝僅 rechunk 時短暫間隔。
  MYTWSTOCK_FINMIND_IF_YAHOO_Q_LT=N — 僅當 Yahoo 季損益欄位數 < N 時才打 FinMind（省配額；N=0 或未設＝每檔都打）。
  MYTWSTOCK_FINMIND_FULL=1 — 強制每檔都打 FinMind（忽略 IF_YAHOO_Q_LT 跳過邏輯，確保 FinMind 都有補資料）。
  MYTWSTOCK_FINANCE_PRIMARY — 預設 finmind（FinMind＋手動補丁為主，Yahoo 僅補缺）；設 yahoo 還原舊行為（Yahoo 為主）。當主來源為 finmind 時，一律抓取 FinMind（不受 IF_YAHOO_Q_LT 略過影響）。
  MYTWSTOCK_MOPS=1 — 啟用 t163sb06（營益）＋ t163sb04（一般業損益金額＋ NI／EPS；全市場表三費多為 null，三費靠 t164）＋ t163sb20 現流＋ t164 補洞（sb05 CAPEX 等）。MYTWSTOCK_MOPS_SLEEP_SEC（預設 3）、MYTWSTOCK_MOPS_INSECURE_SSL=1。MYTWSTOCK_MOPS_T164_MAX_QUARTERS（未設時預設 32，可設小數加速測試）限制 t164 掃描季數。
  每檔至少 2 次 FinMind 請求（損益＋現流）；finmind_financials 內建每小時請求上限節流（FINMIND_MAX_CALLS_PER_HOUR）。MYTWSTOCK_FINMIND_SLEEP_SEC 預設 0；若需額外拉開檔與檔間隔可自訂。亦可啟用 IF_YAHOO_Q_LT 跳過（與 FULL=1 互斥用途）。
  FINMIND_429_COOLDOWN_SEC — 遇 HTTP 429 且重試用盡後額外等待秒數（預設 75）。
  MYTWSTOCK_FINANCIALS_MIRROR_PUBLIC=1 — 另寫一份到 web/public/data/financials（遷移／相容，預設關閉）。
  財務 JSON 預設僅寫入 data/financials_store/（供 Astro／sector-stats 讀取）。
  FINANCIALS_MAX_QUARTERS — JSON 季欄上限（預設 32）；FINANCIALS_MAX_YEARS — JSON 年欄上限（預設 8）。

Units: 百萬台幣 (Million NTD). Margins in %.
"""

import glob
import json
import math
import os
import re
import shutil
import sys
import time
from datetime import datetime, timezone

import pandas as pd
import yfinance as yf

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHECKPOINT_PATH = os.path.join(PROJECT_ROOT, "data", ".financials_update_checkpoint.json")
# 財務圖表／統計 JSON 唯一來源（原子寫入）；見 MYTWSTOCK_FINANCIALS_MIRROR_PUBLIC
FINANCIALS_STORE_DIR = os.path.join(PROJECT_ROOT, "data", "financials_store")
FINANCIALS_PUBLIC_DIR = os.path.join(PROJECT_ROOT, "web", "public", "data", "financials")

ANNUAL_JSON_MAX_COLS = int(os.environ.get("FINANCIALS_MAX_YEARS", "8"))
QUARTERLY_JSON_MAX_COLS = int(os.environ.get("FINANCIALS_MAX_QUARTERS", "32"))

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from utils import (
    find_ticker_files, parse_scope_args, setup_stdout,
    fetch_valuation_data,
)
from financial_supplement import (
    _finalize_merged_financial_columns,
    backfill_annual_from_quarterly,
    backfill_margin_percentages,
    canonical_period_label,
    coalesce_period_columns,
    finance_data_primary_source,
    load_financial_supplement,
    merge_financial_dfs,
    merge_yahoo_raw_with_supplement,
    merge_yahoo_raw_with_supplement_pre_dropna,
    quarterly_core_from_pre_merge,
    sort_financial_statement_rows,
)
from mops_financials import (
    backfill_annual_nulls_from_mops_q4,
    build_mops_market_core_quarterly_dataframe,
    maybe_fill_quarterly_from_mops,
    mops_adapter_enabled,
    mops_industry_type_for_ticker,
    mops_quarterly_premerge_dataframe,
    quarter_end_labels_newest_first,
)
from finmind_financials import (
    _RATE_LIMITER,
    build_finmind_extension_dataframes,
    finmind_enabled,
    finmind_quarterly_cashflow_only,
    merge_manual_and_finmind_supplements,
)

# Financial metrics to extract
METRICS_KEYS = {
    "revenue": ["Total Revenue"],
    "cost_of_revenue": ["Cost Of Revenue", "Cost of Revenue", "Reconciled Cost Of Revenue"],
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
    # 每股盈餘（元／股）；merge 時列名固定為 EPS，不參與百萬元換算（見 financial_supplement）
    "eps": [
        "Diluted EPS",
        "Basic EPS",
        "Normalized EPS",
        "Diluted Eps",
        "Basic Eps",
    ],
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
    result = result.where(numerator.notna() & denominator.notna())
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
    cor = _align_get_series(
        income_stmt, METRICS_KEYS["cost_of_revenue"], periods_ts, period_labels
    )
    gp = _align_get_series(income_stmt, METRICS_KEYS["gross_profit"], periods_ts, period_labels)
    op_inc = _align_get_series(income_stmt, METRICS_KEYS["operating_income"], periods_ts, period_labels)
    ni = _align_get_series(income_stmt, METRICS_KEYS["net_income"], periods_ts, period_labels)
    eps = _align_get_series(income_stmt, METRICS_KEYS["eps"], periods_ts, period_labels)

    gm = calc_margin(gp, rev)
    om = calc_margin(op_inc, rev)
    nm = calc_margin(ni, rev)

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
        "Cost of Revenue": cor,
        "Gross Profit": gp,
        "Gross Margin (%)": gm,
        "Selling & Marketing Exp": selling_f,
        "R&D Exp": rd_f,
        "General & Admin Exp": admin_aligned,
        "Operating Income": op_inc,
        "Operating Margin (%)": om,
        "Net Income": ni,
        "Net Margin (%)": nm,
        "EPS": eps,
        "Op Cash Flow": ocf,
        "Investing Cash Flow": icf,
        "Financing Cash Flow": fin_cf,
        "CAPEX": capex,
    }

    return pd.DataFrame(data).T


def _scale_yahoo_quarterly_extract_to_millions(df: pd.DataFrame) -> pd.DataFrame:
    """與 ``merge_yahoo_raw_with_supplement_pre_dropna`` 相同：元→百萬（EPS、％列除外）。"""
    if df is None or df.empty:
        return pd.DataFrame()
    out = df.dropna(axis=1, how="all")
    out = out[sorted(out.columns, key=lambda c: str(c), reverse=True)]
    out = coalesce_period_columns(out.copy())
    _skip_scale = frozenset({"EPS"})
    non_pct = [r for r in out.index if "%" not in r and r not in _skip_scale]
    out.loc[non_pct] = out.loc[non_pct] / 1_000_000
    # 季 CAPEX 完全不採 Yahoo（整列刪除，避免 merge／coalesce 時殘留或誤併）。
    if "CAPEX" in out.index:
        out = out.drop(index="CAPEX")
    return out


def _reset_quarterly_capex_to_t164_only(pre_q: pd.DataFrame) -> pd.DataFrame:
    """
    季表 CAPEX 僅允許 MOPS t164 sb05：確保存在 CAPEX 列並整列設為 null，
    再交 maybe_fill 寫入（含覆蓋手動補丁／合併殘留；不依賴 Yahoo 季 CAPEX）。
    """
    if pre_q is None or pre_q.empty:
        return pre_q
    out = pre_q.reindex(index=pre_q.index.union(pd.Index(["CAPEX"])))
    out.loc["CAPEX"] = float("nan")
    return out


def _yahoo_probe_quarterly_cols(ticker: str):
    """
    輕量探測：第一個有季損益表的 suffix 與欄數（供 FinMind 配額優化）。
    回傳 (suffix, Ticker 實例或 None, 季欄數)。
    """
    for suffix in [".TW", ".TWO"]:
        try:
            stock = yf.Ticker(f"{ticker}{suffix}")
            q_inc = stock.quarterly_income_stmt
            if q_inc is not None and not q_inc.empty:
                return suffix, stock, int(q_inc.shape[1])
        except Exception:
            continue
    return None, None, 0


def _ttm_eps_sum_recent_quarters(df: pd.DataFrame, n: int = 4) -> float | None:
    """
    合併後季表欄位為新→舊；最近 n 欄 EPS（元／股）加總，作 TTM 近似。
    假設各欄為單季 EPS；若來源為累計口徑則不宜使用（宜以 Yahoo info 為準）。
    """
    if df is None or df.empty or "EPS" not in df.index:
        return None
    row = df.loc["EPS"]
    cols = list(df.columns)
    if len(cols) < n:
        return None
    total = 0.0
    for c in cols[:n]:
        v = row[c]
        if pd.isna(v):
            return None
        total += float(v)
    if total <= 1e-12:
        return None
    return total


def _fetch_financials_mops_only_fallback(ticker: str) -> dict | None:
    """
    Yahoo／FinMind／手動補丁皆無可用合併來源時，若 ``MYTWSTOCK_MOPS=1`` 且 MOPS 彙總表有該公司季別，
    僅以 MOPS 季表產出（無本益比／市值等 Yahoo 欄位）。
    """
    if not mops_adapter_enabled():
        return None
    pre_q = mops_quarterly_premerge_dataframe(ticker, QUARTERLY_JSON_MAX_COLS)
    if pre_q is None or pre_q.empty:
        return None
    pre_q = coalesce_period_columns(pre_q)
    pre_q = _reset_quarterly_capex_to_t164_only(pre_q)
    for _ in range(3):
        pre_q = maybe_fill_quarterly_from_mops(pre_q, ticker)
    df_quarterly = _finalize_merged_financial_columns(pre_q, "all_rows")
    if df_quarterly.empty:
        return None

    df_annual = pd.DataFrame()
    fix_quarterly_expense_q4_if_matches_annual(df_quarterly, df_annual)
    reconcile_annual_eps_from_quarterly(df_annual, df_quarterly)
    ttm_eps_fb = _ttm_eps_sum_recent_quarters(df_quarterly, 4)
    df_quarterly_core = quarterly_core_from_pre_merge(pre_q)

    df_annual_json = pd.DataFrame()
    df_quarterly_json = pd.DataFrame()
    df_quarterly_core_json = pd.DataFrame()
    df_quarterly_ytd_json = pd.DataFrame()
    if not df_quarterly.empty:
        nqc = df_quarterly.shape[1]
        df_quarterly_json = df_quarterly.iloc[
            :, : min(QUARTERLY_JSON_MAX_COLS, nqc)
        ].copy()
        df_quarterly_ytd_json = quarterly_ytd_cumulative_df(df_quarterly_json)
    if not df_quarterly_core.empty:
        nqcc = df_quarterly_core.shape[1]
        df_quarterly_core_json = df_quarterly_core.iloc[
            :, : min(QUARTERLY_JSON_MAX_COLS, nqcc)
        ].copy()

    valuation = fetch_valuation_data({}, ttm_eps_fb)

    return {
        "annual_json": df_annual_json,
        "quarterly_json": df_quarterly_json,
        "quarterly_json_ytd": df_quarterly_ytd_json,
        "quarterly_json_core": df_quarterly_core_json,
        "valuation": valuation,
        "market_cap": None,
        "enterprise_value": None,
        "sector": "N/A",
        "industry": "N/A",
        "suffix": ".TW",
        "industry_type": mops_industry_type_for_ticker(ticker),
    }


def fetch_financials(ticker):
    """
    季表合併優先序（``MYTWSTOCK_MOPS=1`` 時）：
    手動補丁 > MOPS（**sb04** 一般業 Revenue／COR／GP／OI／NI／EPS 優先；**sb06** 補營收與 GP／OI 缺口及 Margin％；**sb20** 現金流）> FinMind 現金流（補缺）> Yahoo（費用拆分等；**季 CAPEX 不用 Yahoo**；現金流補缺）> MOPS t164 費用／CAPEX 補洞。
    年度表在寫入 JSON 前以 ``backfill_annual_from_quarterly`` 補 *-12-31 缺值：
    費用列先四季單季加總；若缺欄或缺值無法加總，再取 ``quarterly_ytd`` 之 Q4（12-31）；
    毛利／營業利益僅四季加總（見 financial_supplement）。
    ``MYTWSTOCK_MOPS=0`` 時季表維持舊行為（FinMind＋Yahoo 依 ``MYTWSTOCK_FINANCE_PRIMARY``）。
    """
    sup = load_financial_supplement(ticker)
    fm_annual, fm_quarterly = pd.DataFrame(), pd.DataFrame()
    threshold = int(os.environ.get("MYTWSTOCK_FINMIND_IF_YAHOO_Q_LT", "0") or 0)
    if os.environ.get("MYTWSTOCK_FINMIND_FULL", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    ):
        threshold = 0
    probe_suffix, probe_stock, yahoo_q_cols = None, None, 0
    finmind_primary = finmind_enabled() and finance_data_primary_source() == "finmind"
    if finmind_enabled():
        if finmind_primary or threshold == 0:
            fm_annual, fm_quarterly = build_finmind_extension_dataframes(ticker)
        else:
            probe_suffix, probe_stock, yahoo_q_cols = _yahoo_probe_quarterly_cols(ticker)
            if yahoo_q_cols < threshold:
                fm_annual, fm_quarterly = build_finmind_extension_dataframes(ticker)

    fm_cash_q = finmind_quarterly_cashflow_only(fm_quarterly)
    use_mops_layers = mops_adapter_enabled()
    if use_mops_layers:
        merged_annual, mq_manual_only = merge_manual_and_finmind_supplements(
            sup.get("annual") if sup else None,
            sup.get("quarterly") if sup else None,
            fm_annual,
            pd.DataFrame(),
        )
        mq_for_legacy = None
    else:
        merged_annual, mq_for_legacy = merge_manual_and_finmind_supplements(
            sup.get("annual") if sup else None,
            sup.get("quarterly") if sup else None,
            fm_annual,
            fm_quarterly,
        )
        mq_manual_only = pd.DataFrame()

    ma = merged_annual if merged_annual is not None and not merged_annual.empty else None
    # 季表 JSON 最舊欄位是依「資料期數」截取；MOPS 期別則自「今日最近已完成季」往回數。
    # 僅取與 JSON 相同長度時，曆年滑動後會少一季（例如漏 2021Q1），故加緩衝以對齊最舊欄。
    pln = max(QUARTERLY_JSON_MAX_COLS, 32) + 5
    mops_core_df = (
        build_mops_market_core_quarterly_dataframe(
            ticker, quarter_end_labels_newest_first(pln)
        )
        if use_mops_layers
        else pd.DataFrame()
    )

    for suffix in [".TW", ".TWO"]:
        try:
            if probe_stock is not None and suffix == probe_suffix:
                stock = probe_stock
            else:
                stock = yf.Ticker(f"{ticker}{suffix}")
            income = stock.income_stmt
            q_inc = stock.quarterly_income_stmt

            if income is None or income.empty:
                df_annual_raw = pd.DataFrame()
            else:
                df_annual_raw = extract_metrics(income, stock.cashflow)

            if q_inc is None or q_inc.empty:
                df_q_raw = pd.DataFrame()
            else:
                df_q_raw = extract_metrics(q_inc, stock.quarterly_cashflow)

            if use_mops_layers:
                mq_ref_empty = mq_manual_only is None or mq_manual_only.empty
            else:
                mq_ref_empty = mq_for_legacy is None or mq_for_legacy.empty

            no_merge_source = (
                df_annual_raw.empty
                and df_q_raw.empty
                and ma is None
                and mq_ref_empty
                and mops_core_df.empty
            )
            if no_merge_source:
                continue

            df_annual = merge_yahoo_raw_with_supplement(df_annual_raw, ma)
            if use_mops_layers:
                yahoo_q_millions = _scale_yahoo_quarterly_extract_to_millions(df_q_raw)
                pre_q = merge_financial_dfs(
                    merge_financial_dfs(mops_core_df, fm_cash_q), yahoo_q_millions
                )
                pre_q = merge_financial_dfs(mq_manual_only, pre_q)
                pre_q = coalesce_period_columns(pre_q)
                pre_q = backfill_margin_percentages(pre_q)
                pre_q = _reset_quarterly_capex_to_t164_only(pre_q)
                for _ in range(3):
                    pre_q = maybe_fill_quarterly_from_mops(pre_q, ticker)
            else:
                pre_q = merge_yahoo_raw_with_supplement_pre_dropna(
                    df_q_raw, mq_for_legacy, strip_yahoo_quarterly_capex=True
                )
                pre_q = coalesce_period_columns(pre_q)
                pre_q = backfill_margin_percentages(pre_q)
                pre_q = _reset_quarterly_capex_to_t164_only(pre_q)
                for _ in range(3):
                    pre_q = maybe_fill_quarterly_from_mops(pre_q, ticker)
            df_annual = _extend_annual_dec31_columns_from_quarterly(
                df_annual, pre_q, ANNUAL_JSON_MAX_COLS
            )
            # Q4=全年 修正須在 _finalize 前寫入 pre_q，否則 quarterlyCore（自 pre_q 派生）會漏修正
            fix_quarterly_expense_q4_if_matches_annual(pre_q, df_annual)
            df_quarterly = _finalize_merged_financial_columns(pre_q, "all_rows")
            reconcile_annual_eps_from_quarterly(df_annual, df_quarterly)
            ttm_eps_fb = _ttm_eps_sum_recent_quarters(df_quarterly, 4)
            df_quarterly_core = quarterly_core_from_pre_merge(pre_q)

            ytd_for_annual = quarterly_ytd_cumulative_df(df_quarterly.copy())
            df_annual = backfill_annual_from_quarterly(
                df_annual, df_quarterly, ytd_for_annual
            )

            df_annual_json = pd.DataFrame()
            if not df_annual.empty:
                nac = df_annual.shape[1]
                df_annual_json = df_annual.iloc[
                    :, : min(ANNUAL_JSON_MAX_COLS, nac)
                ].copy()

            df_quarterly_json = pd.DataFrame()
            df_quarterly_core_json = pd.DataFrame()
            df_quarterly_ytd_json = pd.DataFrame()
            if not df_quarterly.empty:
                nqc = df_quarterly.shape[1]
                df_quarterly_json = df_quarterly.iloc[
                    :, : min(QUARTERLY_JSON_MAX_COLS, nqc)
                ].copy()
                df_quarterly_ytd_json = quarterly_ytd_cumulative_df(df_quarterly_json)
            if not df_quarterly_core.empty:
                nqcc = df_quarterly_core.shape[1]
                df_quarterly_core_json = df_quarterly_core.iloc[
                    :, : min(QUARTERLY_JSON_MAX_COLS, nqcc)
                ].copy()

            info = stock.info if isinstance(stock.info, dict) else {}
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

            valuation = fetch_valuation_data(
                info,
                ttm_eps_fb,
                latest_net_income_million=_latest_annual_scalar_million(
                    df_annual, "Net Income"
                ),
                latest_revenue_million=_latest_annual_scalar_million(
                    df_annual, "Revenue"
                ),
            )

            return {
                "annual_json": df_annual_json,
                "quarterly_json": df_quarterly_json,
                "quarterly_json_ytd": df_quarterly_ytd_json,
                "quarterly_json_core": df_quarterly_core_json,
                "valuation": valuation,
                "market_cap": market_cap,
                "enterprise_value": enterprise_value,
                "sector": info.get("sector", "N/A"),
                "industry": info.get("industry", "N/A"),
                "suffix": suffix,
                "industry_type": mops_industry_type_for_ticker(ticker),
            }
        except Exception:
            continue
    return _fetch_financials_mops_only_fallback(ticker)


def _quarter_column_date_key(col) -> datetime:
    """Parse column label (Timestamp or YYYY-MM-DD str) for chronological sort."""
    if hasattr(col, "to_pydatetime"):
        dt = col.to_pydatetime()
        return dt.replace(tzinfo=None) if getattr(dt, "tzinfo", None) else dt
    s = canonical_period_label(col)
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    return datetime(1900, 1, 1)


_CALENDAR_QUARTER_ENDS = ((3, 31), (6, 30), (9, 30), (12, 31))
_EXPENSE_Q4_ANNUAL_FIX_METRICS = (
    "Selling & Marketing Exp",
    "R&D Exp",
    "General & Admin Exp",
    # Yahoo 季損益偶將 Q4 淨利填成全年累計（與年報同欄）；與費用列同判斷邏輯修正
    "Net Income",
)


def _annual_dec31_column_for_year(df_annual: pd.DataFrame, year: int):
    """同年曆年終 *-12-31* 年表欄位（西元年 year）。"""
    if df_annual is None or df_annual.empty:
        return None
    for c in df_annual.columns:
        d = _quarter_column_date_key(c)
        if d.year == year and d.month == 12 and d.day == 31:
            return c
    return None


def _extend_annual_dec31_columns_from_quarterly(
    df_annual: pd.DataFrame,
    df_quarterly_pre: pd.DataFrame,
    max_years: int,
) -> pd.DataFrame:
    """
    Yahoo 年報欄常少於 8 個曆年；若季表已有同年四季單季欄，補齊 *-12-31* 欄並以四季加總填初值
    （EPS 交 ``reconcile_annual_eps_from_quarterly``；其餘缺列仍可由 ``backfill_annual_from_quarterly`` 補）。
    """
    if df_quarterly_pre is None or df_quarterly_pre.empty or max_years < 1:
        return df_annual if df_annual is not None else pd.DataFrame()
    q = coalesce_period_columns(df_quarterly_pre.copy())
    q.columns = [canonical_period_label(c) for c in q.columns]

    def _year_quarters_complete(y: int) -> bool:
        labs = (f"{y}-03-31", f"{y}-06-30", f"{y}-09-30", f"{y}-12-31")
        return all(l in q.columns for l in labs)

    seen_y: set[int] = set()
    years_found: list[int] = []
    for c in q.columns:
        m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", str(c).strip().split()[0])
        if not m:
            continue
        y = int(m.group(1))
        if y in seen_y or not _year_quarters_complete(y):
            continue
        seen_y.add(y)
        years_found.append(y)
    years_found.sort(reverse=True)
    target_years = years_found[:max_years]
    if not target_years:
        return df_annual if df_annual is not None else pd.DataFrame()

    if df_annual is not None and not df_annual.empty:
        out = df_annual.copy()
        for y in target_years:
            lab = f"{y}-12-31"
            if lab not in out.columns:
                out[lab] = float("nan")
    else:
        out = pd.DataFrame(index=q.index.drop_duplicates())
        for y in target_years:
            out[f"{y}-12-31"] = float("nan")

    for y in target_years:
        acol = f"{y}-12-31"
        qlabs = (f"{y}-03-31", f"{y}-06-30", f"{y}-09-30", f"{y}-12-31")
        for metric in out.index:
            if metric == "EPS" or "%" in str(metric):
                continue
            if metric not in q.index:
                continue
            try:
                cur = out.loc[metric, acol]
            except (KeyError, TypeError, ValueError):
                continue
            if pd.notna(cur):
                continue
            vals = [q.loc[metric, l] for l in qlabs]
            if any(pd.isna(v) for v in vals):
                continue
            try:
                out.loc[metric, acol] = round(sum(float(v) for v in vals), 2)
            except (TypeError, ValueError):
                pass

    out = out[sorted(out.columns, key=lambda c: str(canonical_period_label(c)), reverse=True)]
    try:
        out = sort_financial_statement_rows(out)
    except (ValueError, TypeError):
        pass
    return out


def fix_quarterly_expense_q4_if_matches_annual(
    df_quarterly: pd.DataFrame,
    df_annual: pd.DataFrame | None,
    *,
    annual_tol: float = 0.012,
) -> None:
    """
    Yahoo 季損益常把 Q4 的推銷／研發（偶發 G&A）或 **淨利** 填成**全年累計**（≈ 同年年報該列）。
    當 Q4_raw 與同年 *-12-31* annual 在容差內一致時，改為單季：
    ``Q4 = annual - Q1 - Q2 - Q3``（僅四個曆年季末欄位皆為有限值時）。
    就地修改傳入的 DataFrame（可為 ``pre_q`` 或已 finalize 的季表）。
    """
    if df_quarterly is None or df_quarterly.empty:
        return
    if df_annual is None or df_annual.empty:
        return

    cols_sorted = sorted(df_quarterly.columns, key=_quarter_column_date_key)
    by_year: dict[int, list] = {}
    for c in cols_sorted:
        y = _quarter_column_date_key(c).year
        by_year.setdefault(y, []).append(c)

    for y, ycols in by_year.items():
        ac = _annual_dec31_column_for_year(df_annual, y)
        if ac is None:
            continue
        qmap: dict[tuple[int, int], object] = {}
        for c in ycols:
            d = _quarter_column_date_key(c)
            key = (d.month, d.day)
            if key in _CALENDAR_QUARTER_ENDS:
                qmap[key] = c
        if set(qmap.keys()) != set(_CALENDAR_QUARTER_ENDS):
            continue
        c_mar = qmap[(3, 31)]
        c_jun = qmap[(6, 30)]
        c_sep = qmap[(9, 30)]
        c_dec = qmap[(12, 31)]

        for metric in _EXPENSE_Q4_ANNUAL_FIX_METRICS:
            if metric not in df_quarterly.index or metric not in df_annual.index:
                continue
            v1 = df_quarterly.loc[metric, c_mar]
            v2 = df_quarterly.loc[metric, c_jun]
            v3 = df_quarterly.loc[metric, c_sep]
            v4 = df_quarterly.loc[metric, c_dec]
            ann = df_annual.loc[metric, ac]
            if any(pd.isna(x) for x in (v1, v2, v3, v4, ann)):
                continue
            f1, f2, f3, f4, fa = float(v1), float(v2), float(v3), float(v4), float(ann)
            if not all(map(math.isfinite, (f1, f2, f3, f4, fa))):
                continue
            denom = abs(fa) if abs(fa) > 1e-9 else max(abs(f1) + abs(f2) + abs(f3) + abs(f4), 1e-9)
            if abs(f4 - fa) / denom > annual_tol:
                continue
            single_q4 = fa - f1 - f2 - f3
            if not math.isfinite(single_q4):
                continue
            # 避免數值噪音誤修：修正後單季與原 Q4 應有合理差異
            if abs(single_q4 - f4) / max(denom, 1e-9) < 1e-6:
                continue
            df_quarterly.loc[metric, c_dec] = round(single_q4, 2)


def reconcile_annual_eps_from_quarterly(
    df_annual: pd.DataFrame, df_quarterly: pd.DataFrame
) -> None:
    """
    Yahoo 年報部分標的之 EPS 欄位實為「最近一季」而非全年，與同欄營收／淨利（全年）不一致。
    若該年度欄為 12 月年結，改以同年曆年「單季」EPS 加總覆寫年表 EPS，與季表累積至 Q4 口徑一致。
    非 12 月年結者不覆寫（避免會計年度與曆年季別錯位）。
    """
    if (
        df_annual is None
        or df_annual.empty
        or df_quarterly is None
        or df_quarterly.empty
    ):
        return
    if "EPS" not in df_annual.index or "EPS" not in df_quarterly.index:
        return

    for ac in df_annual.columns:
        adt = _quarter_column_date_key(ac)
        if adt.month != 12:
            continue
        y = adt.year
        qcols = [
            c
            for c in df_quarterly.columns
            if _quarter_column_date_key(c).year == y
        ]
        if not qcols:
            continue
        qcols_sorted = sorted(qcols, key=_quarter_column_date_key)
        total = 0.0
        has_any = False
        for qc in qcols_sorted:
            v = df_quarterly.loc["EPS", qc]
            if pd.notna(v):
                total += float(v)
                has_any = True
        if has_any:
            df_annual.loc["EPS", ac] = round(total, 2)


def quarterly_ytd_cumulative_df(df: pd.DataFrame) -> pd.DataFrame:
    """
    同日曆年內「逐季累積」：該季欄位＝該曆年由年初第一季起至該季止的單季金額加總
    （Q1 僅 Q1，Q2＝Q1＋Q2，Q3＝Q1＋Q2＋Q3，以此類推；曆年依欄位日期所屬西元年）。
    適用：營收、費用、損益、現金流、CAPEX 等。毛利率／營業利益率／淨利率由累積金額重算。
    EPS：同日曆年內將單季 EPS 加總（近似累積每股；股數若各季不同則與財報加權 EPS 可能不一致）。
    假設各欄為單季口徑；若來源已為累計則不宜使用。
    """
    if df is None or df.empty:
        return pd.DataFrame()
    additive = (
        "Revenue",
        "Cost of Revenue",
        "Gross Profit",
        "Selling & Marketing Exp",
        "R&D Exp",
        "General & Admin Exp",
        "Operating Income",
        "Net Income",
        "EPS",
        "Op Cash Flow",
        "Investing Cash Flow",
        "Financing Cash Flow",
        "CAPEX",
    )
    original_order = list(df.columns)
    cols_sorted = sorted(original_order, key=_quarter_column_date_key)
    by_year: dict[int, list] = {}
    for c in cols_sorted:
        y = _quarter_column_date_key(c).year
        by_year.setdefault(y, []).append(c)

    out = df.copy()
    for c in cols_sorted:
        y = _quarter_column_date_key(c).year
        year_cols = by_year[y]
        prefix = []
        for bc in year_cols:
            prefix.append(bc)
            if bc == c:
                break

        for metric in additive:
            if metric not in df.index:
                continue
            total = 0.0
            has_any = False
            for pc in prefix:
                v = df.loc[metric, pc]
                if pd.notna(v):
                    total += float(v)
                    has_any = True
            out.loc[metric, c] = total if has_any else float("nan")

        rev = (
            float(out.loc["Revenue", c])
            if "Revenue" in out.index and pd.notna(out.loc["Revenue", c])
            else float("nan")
        )
        if "Gross Profit" in out.index and "Gross Margin (%)" in out.index:
            gp = out.loc["Gross Profit", c]
            if pd.notna(rev) and abs(rev) > 1e-12 and pd.notna(gp):
                out.loc["Gross Margin (%)", c] = (float(gp) / rev) * 100
            else:
                out.loc["Gross Margin (%)", c] = float("nan")
        if "Operating Income" in out.index and "Operating Margin (%)" in out.index:
            oi = out.loc["Operating Income", c]
            if pd.notna(rev) and abs(rev) > 1e-12 and pd.notna(oi):
                out.loc["Operating Margin (%)", c] = (float(oi) / rev) * 100
            else:
                out.loc["Operating Margin (%)", c] = float("nan")
        if "Net Income" in out.index and "Net Margin (%)" in out.index:
            ni = out.loc["Net Income", c]
            if pd.notna(rev) and abs(rev) > 1e-12 and pd.notna(ni):
                out.loc["Net Margin (%)", c] = (float(ni) / rev) * 100
            else:
                out.loc["Net Margin (%)", c] = float("nan")

    return out


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


def _recalc_margins_in_json_block(block: dict | None) -> None:
    """回填後就地重算三項 margin（僅填 null 位置）。"""
    if not block:
        return
    s = block.get("series", {})
    rev = s.get("Revenue")
    if not rev:
        return
    pairs = [
        ("Gross Margin (%)", "Gross Profit"),
        ("Operating Margin (%)", "Operating Income"),
        ("Net Margin (%)", "Net Income"),
    ]
    for m_key, num_key in pairs:
        num = s.get(num_key)
        margin = s.get(m_key)
        if not num:
            continue
        if not margin:
            margin = [None] * len(rev)
            s[m_key] = margin
        for i in range(len(rev)):
            if i >= len(margin) or i >= len(num):
                break
            if margin[i] is not None:
                continue
            r, n = rev[i], num[i]
            if r is not None and n is not None and r != 0:
                margin[i] = round(n / r * 100, 6)


def _latest_annual_scalar_million(df: pd.DataFrame, metric: str) -> float | None:
    """年表 merge 後最右欄（通常為最近年結）之指標，百萬台幣。"""
    if df is None or df.empty or metric not in df.index:
        return None
    cols = sorted(df.columns, key=lambda c: str(c))
    if not cols:
        return None
    v = df.loc[metric, cols[-1]]
    if pd.isna(v):
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _parse_market_value(s) -> int | None:
    """'47,845,508' → 47845508 (int) or None."""
    if s is None:
        return None
    try:
        return int(str(s).replace(",", ""))
    except (ValueError, TypeError):
        return None


def _is_na_sector_industry(val) -> bool:
    if val is None:
        return True
    s = str(val).strip()
    if not s:
        return True
    return s.upper() in ("N/A", "NA", "NONE", "—", "-")


def sector_industry_fallback_from_report(ticker: str) -> tuple[str | None, str | None]:
    """
    yfinance 對部分 .TWO 標的不回傳 sector/industry。
    自 Pilot_Reports 首段 metadata（**板塊:** / **產業:**）讀取；產業缺時以報告所在資料夾名（GICS 風格）補上。
    """
    files = find_ticker_files(tickers=[ticker])
    fp = files.get(ticker)
    if not fp or not os.path.isfile(fp):
        pattern = os.path.join(PROJECT_ROOT, "Pilot_Reports", "*", f"{ticker}_*.md")
        matches = sorted(glob.glob(pattern))
        fp = matches[0] if matches else None
    if not fp or not os.path.isfile(fp):
        return None, None
    folder = os.path.basename(os.path.dirname(fp))
    sector_md: str | None = None
    industry_md: str | None = None
    try:
        with open(fp, encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if s.startswith("**板塊:**"):
                    sector_md = s.split("**板塊:**", 1)[1].strip()
                elif s.startswith("**產業:**"):
                    industry_md = s.split("**產業:**", 1)[1].strip()
    except OSError:
        return None, None
    sec = sector_md if sector_md and not _is_na_sector_industry(sector_md) else None
    ind = industry_md if industry_md and not _is_na_sector_industry(industry_md) else None
    if not ind and folder and folder.lower() not in ("pilot_reports", ""):
        ind = folder
    return sec, ind


FINANCIAL_INDUSTRY_TYPES_JSON = frozenset(
    {"financial_holding", "bank", "insurance", "securities"}
)


def _df_has_nonnull_gross_margin(df) -> bool:
    """年／季表 merge 後 index 含 Gross Margin (%) 且任一期非空。"""
    if df is None or getattr(df, "empty", True):
        return False
    if "Gross Margin (%)" not in df.index:
        return False
    row = df.loc["Gross Margin (%)"]
    return bool(row.notna().any())


def _normalize_mops_industry_type(
    itype: str,
    df_annual,
    df_quarterly,
    df_quarterly_core,
) -> str:
    """
    MOPS t163 對部分標的 type=other，但實為一般製造／通路（有毛利率列）→ 改 general。
    """
    t = (itype or "").strip()
    if t != "other":
        return t
    if _df_has_nonnull_gross_margin(df_annual):
        return "general"
    if _df_has_nonnull_gross_margin(df_quarterly):
        return "general"
    if _df_has_nonnull_gross_margin(df_quarterly_core):
        return "general"
    return t


def _strip_gross_margin_for_financial_json(block: dict | None) -> None:
    """金融業不應呈現 Yahoo 誤植之毛利率列；就地改為全 null。"""
    if not block or not isinstance(block.get("series"), dict):
        return
    periods = block.get("periods") or []
    n = len(periods)
    if n == 0:
        return
    s = block["series"]
    if "Gross Margin (%)" in s:
        s["Gross Margin (%)"] = [None] * n


def _patch_quarterly_ytd_q4_from_annual(annual_block: dict | None, qy_block: dict | None) -> None:
    """
    累積合併 Q4（曆年 12-31）欄：單季加總與年報口徑可能不同（現流、CAPEX、部分費用）。
    就地將 quarterlyYtd 該欄對齊 annual 同年 *-12-31*，並依營收重算三項利率列。
    """
    if not annual_block or not qy_block:
        return
    periods_a = annual_block.get("periods") or []
    series_a = annual_block.get("series") or {}
    periods_q = qy_block.get("periods") or []
    series_q = qy_block.get("series") or {}
    if not periods_a or not periods_q or not isinstance(series_q, dict):
        return

    def norm_iso(p: object) -> str:
        s = str(p).strip()
        return s[:10] if len(s) >= 10 else s

    def annual_idx_for_year_dec31(y: int) -> int:
        target = f"{y}-12-31"
        for i, p in enumerate(periods_a):
            if norm_iso(p) == target:
                return i
        return -1

    margin_pairs = (
        ("Gross Profit", "Gross Margin (%)"),
        ("Operating Income", "Operating Margin (%)"),
        ("Net Income", "Net Margin (%)"),
    )

    for qi, pq in enumerate(periods_q):
        iso = norm_iso(pq)
        if not iso.endswith("-12-31"):
            continue
        try:
            y = int(iso[:4])
        except ValueError:
            continue
        ai = annual_idx_for_year_dec31(y)
        if ai < 0:
            continue
        for metric, arr in series_a.items():
            if metric.endswith("(%)") or not isinstance(arr, list) or ai >= len(arr):
                continue
            if metric not in series_q:
                continue
            v = arr[ai]
            if v is None:
                continue
            try:
                fv = float(v)
            except (TypeError, ValueError):
                continue
            if not math.isfinite(fv):
                continue
            qarr = series_q[metric]
            if not isinstance(qarr, list) or qi >= len(qarr):
                continue
            qarr[qi] = fv
        rev = series_q.get("Revenue")
        if rev is None or not isinstance(rev, list) or qi >= len(rev) or rev[qi] is None:
            continue
        try:
            r = float(rev[qi])
        except (TypeError, ValueError):
            continue
        if not math.isfinite(r) or abs(r) < 1e-12:
            continue
        for numer_k, pct_k in margin_pairs:
            na = series_q.get(numer_k)
            pa = series_q.get(pct_k)
            if (
                not isinstance(na, list)
                or qi >= len(na)
                or na[qi] is None
                or not isinstance(pa, list)
                or qi >= len(pa)
            ):
                continue
            try:
                num = float(na[qi])
            except (TypeError, ValueError):
                continue
            if not math.isfinite(num):
                continue
            pa[qi] = (num / r) * 100.0


def build_financials_payload(ticker: str, data: dict) -> dict:
    """JSON 內容 dict（寫入 financials_store 與可選 public 鏡像）。"""
    it_raw = data.get("industry_type")
    industry_type = (
        it_raw.strip()
        if isinstance(it_raw, str) and it_raw.strip()
        else (mops_industry_type_for_ticker(ticker) if mops_adapter_enabled() else "general")
    )
    industry_type = _normalize_mops_industry_type(
        industry_type,
        data.get("annual_json"),
        data.get("quarterly_json"),
        data.get("quarterly_json_core"),
    )

    annual_block = _dataframe_to_json_block(data.get("annual_json"))
    if annual_block and annual_block.get("periods"):
        backfill_annual_nulls_from_mops_q4(
            ticker, annual_block["periods"], annual_block["series"]
        )
        _recalc_margins_in_json_block(annual_block)

    sector = data.get("sector", "N/A")
    industry = data.get("industry", "N/A")
    if _is_na_sector_industry(sector) or _is_na_sector_industry(industry):
        fb_sec, fb_ind = sector_industry_fallback_from_report(ticker)
        if _is_na_sector_industry(sector) and fb_sec:
            sector = fb_sec
        if _is_na_sector_industry(industry) and fb_ind:
            industry = fb_ind

    payload = {
        "ticker": ticker,
        "schemaVersion": 2,
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "unit": "Million NTD; margin rows are percent; EPS is TWD per share",
        "industryType": industry_type,
        "sector": sector if not _is_na_sector_industry(sector) else "N/A",
        "industry": industry if not _is_na_sector_industry(industry) else "N/A",
        "marketCap": _parse_market_value(data.get("market_cap")),
        "enterpriseValue": _parse_market_value(data.get("enterprise_value")),
        "yahooSuffix": data.get("suffix", ".TW"),
        "valuation": _valuation_to_json_numbers(data.get("valuation")),
        "annual": annual_block,
        "quarterly": _dataframe_to_json_block(data.get("quarterly_json")),
    }
    qc = _dataframe_to_json_block(data.get("quarterly_json_core"))
    if qc is not None:
        payload["quarterlyCore"] = qc
    qy = _dataframe_to_json_block(data.get("quarterly_json_ytd"))
    if qy is not None:
        payload["quarterlyYtd"] = qy

    if industry_type in FINANCIAL_INDUSTRY_TYPES_JSON:
        _strip_gross_margin_for_financial_json(payload.get("annual"))
        _strip_gross_margin_for_financial_json(payload.get("quarterly"))
        _strip_gross_margin_for_financial_json(payload.get("quarterlyCore"))

    _patch_quarterly_ytd_q4_from_annual(payload.get("annual"), payload.get("quarterlyYtd"))

    return payload


def _write_utf8_atomic(dest_path: str, text: str) -> None:
    """暫存檔 + copyfile 覆蓋，降低 Windows 下直接寫入已存在檔的 UNKNOWN 錯誤。"""
    d = os.path.dirname(dest_path)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = f"{dest_path}.{os.getpid()}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        shutil.copyfile(tmp, dest_path)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _mirror_public_enabled() -> bool:
    return os.environ.get("MYTWSTOCK_FINANCIALS_MIRROR_PUBLIC", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def write_financials_store(ticker: str, data: dict, dry_run: bool = False) -> None:
    """原子寫入 data/financials_store/{ticker}.json；可選鏡像到 public。"""
    if dry_run:
        return
    payload = build_financials_payload(ticker, data)
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    store_path = os.path.join(FINANCIALS_STORE_DIR, f"{ticker}.json")
    _write_utf8_atomic(store_path, text)
    if _mirror_public_enabled():
        public_path = os.path.join(FINANCIALS_PUBLIC_DIR, f"{ticker}.json")
        _write_utf8_atomic(public_path, text)


def update_ticker(ticker: str, dry_run: bool = False) -> bool:
    """只抓取資料並寫入 JSON，不讀不寫任何 MD 檔。"""
    data = fetch_financials(ticker)
    if data is None:
        print(
            f"  {ticker}: SKIP (no Yahoo/FinMind/supplement"
            f"{'/MOPS' if mops_adapter_enabled() else ''} data)"
        )
        return False

    write_financials_store(ticker, data, dry_run=dry_run)

    if dry_run:
        print(f"  {ticker}: WOULD UPDATE ({data['suffix']})")
    else:
        print(f"  {ticker}: UPDATED ({data['suffix']})")
    return True


def _parse_sleep_sec_cli(args_list: list[str]) -> tuple[list[str], float | None]:
    """
    自 argv 移除 --sleep-sec <秒>，回傳 (其餘參數, 間隔秒數或 None)。
    None 表示未指定，main 再用環境變數 MYTWSTOCK_FINMIND_SLEEP_SEC。
    """
    args = list(args_list)
    override: float | None = None
    i = 0
    while i < len(args):
        if args[i] == "--sleep-sec":
            if i + 1 >= len(args):
                print("Error: --sleep-sec 需要一個數字（秒），例如 --sleep-sec 10")
                sys.exit(1)
            try:
                override = float(args[i + 1])
            except ValueError:
                print("Error: --sleep-sec 必須為數字，例如 10 或 1.5")
                sys.exit(1)
            if override < 0:
                print("Error: --sleep-sec 不可為負數")
                sys.exit(1)
            del args[i : i + 2]
            continue
        i += 1
    return args, override


def _sleep_seconds_between_tickers() -> float:
    raw = os.environ.get("MYTWSTOCK_FINMIND_SLEEP_SEC", "0").strip()
    try:
        return float(raw)
    except ValueError:
        return 0.0


def _load_checkpoint_pending() -> set[str]:
    if not os.path.isfile(CHECKPOINT_PATH):
        return set()
    try:
        with open(CHECKPOINT_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return set()
    p = data.get("pending_retries")
    return set(p) if isinstance(p, list) else set()


def _save_checkpoint_pending(pending: set[str]) -> None:
    os.makedirs(os.path.dirname(CHECKPOINT_PATH), exist_ok=True)
    payload = {
        "pending_retries": sorted(pending),
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    with open(CHECKPOINT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def main():
    setup_stdout()

    args = list(sys.argv[1:])
    dry_run = "--dry-run" in args
    if dry_run:
        args.remove("--dry-run")
    resume = "--resume" in args
    if resume:
        args.remove("--resume")
    clear_ckpt = "--clear-checkpoint" in args
    if clear_ckpt:
        args.remove("--clear-checkpoint")
        if os.path.isfile(CHECKPOINT_PATH):
            os.remove(CHECKPOINT_PATH)
        print("Cleared financials update checkpoint.")

    args, sleep_cli = _parse_sleep_sec_cli(args)
    sleep_between = sleep_cli if sleep_cli is not None else _sleep_seconds_between_tickers()

    tickers, sector, desc = parse_scope_args(args)
    print(f"Updating financials for {desc}...")
    ticker_map = find_ticker_files(tickers, sector)

    if not ticker_map:
        print("No matching tickers found.")
        return

    ckpt_pending = _load_checkpoint_pending()
    if resume and ckpt_pending:
        before = len(ticker_map)
        ticker_map = {k: v for k, v in ticker_map.items() if k in ckpt_pending}
        print(f"Resume: {len(ticker_map)} tickers (from checkpoint, was {before} in scope).\n")
    elif resume and not ckpt_pending:
        print("Resume: checkpoint empty; processing full scope.\n")

    tickers_order = sorted(ticker_map.keys())
    print(f"Found {len(tickers_order)} files.\n")
    print(f"每檔間隔: {sleep_between} 秒（最後一檔處理完不等待）\n")
    updated = failed = skipped = 0
    pending = set(ckpt_pending) if resume else set()

    for idx, ticker in enumerate(tickers_order):
        try:
            if update_ticker(ticker, dry_run):
                updated += 1
                pending.discard(ticker)
            else:
                skipped += 1
        except Exception as e:
            print(f"  {ticker}: ERROR ({e})")
            failed += 1
            pending.add(ticker)
        if idx % 50 == 0:
            print(f"[進度] {idx}/{len(tickers_order)} | {_RATE_LIMITER.status()}")
        if sleep_between > 0 and idx < len(tickers_order) - 1:
            time.sleep(sleep_between)

    if not dry_run and (failed or pending):
        _save_checkpoint_pending(pending)
        if pending:
            print(f"\nCheckpoint: {len(pending)} ticker(s) in {CHECKPOINT_PATH} (use --resume)")

    print(f"\nDone. Updated: {updated} | Skipped: {skipped} | Failed: {failed}")


if __name__ == "__main__":
    main()
