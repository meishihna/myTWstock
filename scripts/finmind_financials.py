"""
Auto-fetch Taiwan GAAP financials from FinMind open API (v3) and merge into the pipeline.

預設與 Yahoo 合併時 **FinMind（＋手動補丁）為主、Yahoo 補缺**（``MYTWSTOCK_FINANCE_PRIMARY``）。

- Income statement lines: single-quarter amounts per period end date.
- Cash flow (operating / investing / financing): FinMind values are cumulative YTD
  within each calendar year; we convert to single-quarter by differencing quarters.

Values from API are NTD (元); this module converts to 百萬台幣 to match Yahoo output.

Disable with env MYTWSTOCK_FINMIND=0

Auth — pick one:

  • JWT (recommended): env FINMIND_TOKEN or FINMIND_API_TOKEN. Uses API v4 with
    header ``Authorization: Bearer <token>`` (see https://finmind.github.io/login/ ).
    v4 dataset names differ internally; this module maps v3 names for you.

  • v3 account: FINMIND_USER_ID + FINMIND_PASSWORD (aliases FINMIND_API_USER /
    FINMIND_API_PASSWORD) as query params on v3.

If FINMIND_TOKEN is set, it takes precedence over user_id/password.

Rate: env FINMIND_MAX_CALLS_PER_HOUR (default 280) sets a process-wide minimum spacing
between FinMind HTTP requests via ``_RATE_LIMITER`` (thread-safe).
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime
from typing import Any

import pandas as pd
from dateutil.relativedelta import relativedelta

FINMIND_V3_DATA = "https://api.finmindtrade.com/api/v3/data"
FINMIND_V4_DATA = "https://api.finmindtrade.com/api/v4/data"

# Internal v3 dataset names (call sites) → FinMind v4 ``dataset`` parameter
_V3_TO_V4_DATASET: dict[str, str] = {
    "FinancialStatements": "TaiwanStockFinancialStatements",
    "TaiwanCashFlowsStatement": "TaiwanStockCashFlowsStatement",
}

def _default_start_date() -> str:
    """API 起始日：固定往回 6 年（與預設 JSON 季數滾動更新搭配，免手改常數）。"""
    return (datetime.today() - relativedelta(years=6)).strftime("%Y-%m-%d")

# If a single response has at least this many rows, re-fetch in date windows and merge (API 無正式分頁文件).
FINMIND_ROW_RECHUNK_THRESHOLD = int(os.environ.get("FINMIND_ROW_RECHUNK_THRESHOLD", "8000"))
# Window length in years when re-chunking (or when FINMIND_FORCE_CHUNK=1).
FINMIND_CHUNK_YEARS = int(os.environ.get("FINMIND_CHUNK_YEARS", "4"))
FINMIND_FORCE_CHUNK = os.environ.get("FINMIND_FORCE_CHUNK", "").strip().lower() in (
    "1",
    "true",
    "yes",
)
FINMIND_MAX_RETRIES = int(os.environ.get("FINMIND_MAX_RETRIES", "4"))
FINMIND_TIMEOUT = int(os.environ.get("FINMIND_TIMEOUT", "120"))
FINMIND_BACKOFF_BASE = float(os.environ.get("FINMIND_BACKOFF_BASE", "1.5"))
# 429 用盡重試後額外等待（秒）；官方未認證約 600/hr，認證後配額更高
FINMIND_429_COOLDOWN_SEC = float(os.environ.get("FINMIND_429_COOLDOWN_SEC", "75"))
# 兩次 FinMind HTTP 之間至少間隔（秒），避免同一檔內連續請求過密（0＝不額外等待）
FINMIND_REQUEST_SLEEP_SEC = float(os.environ.get("FINMIND_REQUEST_SLEEP_SEC", "0"))


class _FinMindRateLimiter:
    """每小時最多 max_calls 次（跨所有請求共用，thread-safe）；以最小間隔均攤。"""

    def __init__(self, max_calls: int = 580, period: float = 3600.0):
        self.max_calls = max(1, max_calls)
        self.period = period
        self.min_interval = self.period / self.max_calls
        self._lock = threading.Lock()
        self._last_call = 0.0
        self._count = 0
        self._window_start = time.time()

    def wait(self) -> None:
        with self._lock:
            now = time.time()
            if now - self._window_start >= self.period:
                self._count = 0
                self._window_start = now
            if self._last_call > 0:
                elapsed = now - self._last_call
                if elapsed < self.min_interval:
                    time.sleep(self.min_interval - elapsed)
                    now = time.time()
            self._last_call = now
            self._count += 1

    def status(self) -> str:
        with self._lock:
            now = time.time()
            reset_in = max(0, int(self.period - (now - self._window_start)))
            rem = max(0, self.max_calls - self._count)
            return (
                f"FinMind 已用 {self._count}/{self.max_calls} 次 | "
                f"剩餘 {rem} 次 | "
                f"{reset_in}s 後重置"
            )


_fin_calls_raw = int(os.environ.get("FINMIND_MAX_CALLS_PER_HOUR", "280"))
_RATE_LIMITER = _FinMindRateLimiter(max_calls=max(1, _fin_calls_raw))

_LOG = logging.getLogger(__name__)
if not _LOG.handlers and os.environ.get("FINMIND_LOG", "").strip():
    logging.basicConfig(level=logging.INFO)

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
    "EPS": ["EPS"],
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


def finmind_bearer_token() -> str:
    """JWT from FinMind 使用者資訊頁；勿寫入版本庫。"""
    for key in ("FINMIND_TOKEN", "FINMIND_API_TOKEN"):
        raw = os.environ.get(key, "").strip()
        if raw:
            if (raw.startswith('"') and raw.endswith('"')) or (
                raw.startswith("'") and raw.endswith("'")
            ):
                raw = raw[1:-1].strip()
            return raw
    return ""


def finmind_auth_query_items() -> list[tuple[str, str]]:
    """
    FinMind v3 passes credentials as query parameters.
    Returns [(user_id, ...), (password, ...)] when both are set; otherwise [].
    Skipped when ``finmind_bearer_token()`` is set (v4 path used instead).
    """
    if finmind_bearer_token():
        return []
    uid = (
        os.environ.get("FINMIND_USER_ID", "").strip()
        or os.environ.get("FINMIND_API_USER", "").strip()
    )
    pwd = (
        os.environ.get("FINMIND_PASSWORD", "").strip()
        or os.environ.get("FINMIND_API_PASSWORD", "").strip()
    )
    if not uid or not pwd:
        return []
    return [("user_id", uid), ("password", pwd)]


def _finmind_log_path() -> str:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    d = os.path.join(root, "data", "logs")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "finmind_fetch.log")


def _append_finmind_log(message: str) -> None:
    path = _finmind_log_path()
    ts = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"{ts} {message}\n")
    except OSError:
        pass


def _http_get_json(
    url: str,
    timeout: int,
    extra_headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    h: dict[str, str] = {"User-Agent": "myTWstock-update_financials/1"}
    if extra_headers:
        h.update(extra_headers)
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _maybe_sleep_between_finmind_requests() -> None:
    if FINMIND_REQUEST_SLEEP_SEC > 0:
        time.sleep(FINMIND_REQUEST_SLEEP_SEC)


def _fetch_finmind_dataset_once(
    dataset: str,
    stock_id: str,
    start_date: str,
    timeout: int,
) -> tuple[pd.DataFrame, int | None, str]:
    """
    Returns (df, http_status_or_None, reason).
    reason: ok | http_error | bad_status | empty_data | network
    """
    token = finmind_bearer_token()
    if token:
        v4_ds = _V3_TO_V4_DATASET.get(dataset)
        if not v4_ds:
            _append_finmind_log(f"{dataset} {stock_id}: no v4 mapping for dataset")
            return pd.DataFrame(), None, "bad_status"
        q = [
            ("dataset", v4_ds),
            ("data_id", stock_id),
            ("start_date", start_date),
        ]
        params = urllib.parse.urlencode(q)
        url = f"{FINMIND_V4_DATA}?{params}"
        auth_headers = {"Authorization": f"Bearer {token}"}
    else:
        q = [
            ("dataset", dataset),
            ("stock_id", stock_id),
            ("date", start_date),
        ]
        q.extend(finmind_auth_query_items())
        params = urllib.parse.urlencode(q)
        url = f"{FINMIND_V3_DATA}?{params}"
        auth_headers = None

    _RATE_LIMITER.wait()

    last_err: str | None = None
    for attempt in range(max(1, FINMIND_MAX_RETRIES)):
        try:
            payload = _http_get_json(url, timeout=timeout, extra_headers=auth_headers)
            break
        except urllib.error.HTTPError as e:
            last_err = f"HTTP {e.code}"
            if e.code in (429, 500, 502, 503, 504) and attempt + 1 < FINMIND_MAX_RETRIES:
                time.sleep(FINMIND_BACKOFF_BASE ** attempt)
                continue
            if e.code == 429 and FINMIND_429_COOLDOWN_SEC > 0:
                time.sleep(FINMIND_429_COOLDOWN_SEC)
            _append_finmind_log(f"{dataset} {stock_id} date={start_date} {last_err}")
            return pd.DataFrame(), e.code, "http_error"
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last_err = str(e)
            if attempt + 1 < FINMIND_MAX_RETRIES:
                time.sleep(FINMIND_BACKOFF_BASE ** attempt)
                continue
            _append_finmind_log(f"{dataset} {stock_id} date={start_date} network {last_err}")
            return pd.DataFrame(), None, "network"
    else:
        return pd.DataFrame(), None, "network"

    if not payload:
        _append_finmind_log(f"{dataset} {stock_id} date={start_date} empty payload")
        return pd.DataFrame(), None, "bad_status"
    st = int(payload.get("status") or 0)
    if st != 200:
        msg = payload.get("msg") or payload.get("message") or ""
        _append_finmind_log(f"{dataset} {stock_id} date={start_date} status={st} {msg}")
        return pd.DataFrame(), st, "bad_status"
    rows = payload.get("data")
    if not rows:
        return pd.DataFrame(), 200, "empty_data"
    return pd.DataFrame(rows), 200, "ok"


def _date_windows_for_chunking() -> list[str]:
    """Start dates for overlapping multi-year pulls (newest first for merge preference)."""
    y_end = datetime.utcnow().year
    y0 = int(_default_start_date()[:4])
    years = FINMIND_CHUNK_YEARS if FINMIND_CHUNK_YEARS > 0 else 4
    starts: list[str] = []
    y = y_end - years + 1
    while y >= y0:
        starts.append(f"{y}-01-01")
        y -= years
    if f"{y0}-01-01" not in starts:
        starts.append(f"{y0}-01-01")
    return sorted(set(starts), reverse=True)


def fetch_finmind_dataset(
    dataset: str,
    stock_id: str,
    start_date: str | None = None,
) -> pd.DataFrame:
    timeout = FINMIND_TIMEOUT
    sd = (start_date or "").strip() or _default_start_date()
    df, _st, reason = _fetch_finmind_dataset_once(dataset, stock_id, sd, timeout)
    if reason not in ("ok", "empty_data"):
        return pd.DataFrame()

    want_rechunk = FINMIND_FORCE_CHUNK or (
        reason == "ok" and len(df) >= FINMIND_ROW_RECHUNK_THRESHOLD
    )
    if not want_rechunk:
        return df
    if df.empty and not FINMIND_FORCE_CHUNK:
        return df

    _append_finmind_log(
        f"{dataset} {stock_id} rechunk rows={len(df)} force={FINMIND_FORCE_CHUNK} "
        f"threshold={FINMIND_ROW_RECHUNK_THRESHOLD}"
    )
    parts: list[pd.DataFrame] = []
    for sd in _date_windows_for_chunking():
        part, _st2, r2 = _fetch_finmind_dataset_once(dataset, stock_id, sd, timeout)
        if r2 == "ok" and not part.empty:
            parts.append(part)
        time.sleep(max(0.15, FINMIND_REQUEST_SLEEP_SEC))
    if not parts:
        return df
    merged = pd.concat(parts, ignore_index=True)
    if "date" in merged.columns and "type" in merged.columns:
        merged = merged.drop_duplicates(subset=["date", "type"], keep="last")
    return merged


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
    """Calendar-year P&L: sum four quarters (元→百萬)；EPS 為四季單季 EPS 加總（元／股，不換算）。"""
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
            if out_name == "EPS":
                total_eps = 0.0
                ok_eps = False
                for q in want:
                    if q not in pivot_inc.index:
                        continue
                    v = _pick_value(pivot_inc.loc[q], type_keys)
                    if pd.notna(v):
                        total_eps += float(v)
                        ok_eps = True
                rowvals[out_name] = total_eps if ok_eps else float("nan")
                continue
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
    start_date: str | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    Returns (annual_df, quarterly_df); column labels YYYY-MM-DD.
    Most P&L / cash rows are **百萬台幣**; **EPS** is **元／股** (no 1e6 scale).
    """
    if not finmind_enabled():
        return pd.DataFrame(), pd.DataFrame()

    stock_id = str(ticker).strip().replace(".TW", "").replace(".TWO", "")
    if not stock_id.isdigit():
        return pd.DataFrame(), pd.DataFrame()

    sd = (start_date or "").strip() or _default_start_date()
    inc = fetch_finmind_dataset("FinancialStatements", stock_id, sd)
    _maybe_sleep_between_finmind_requests()
    cf = fetch_finmind_dataset("TaiwanCashFlowsStatement", stock_id, sd)
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
            if out_name == "EPS":
                q_data[d][out_name] = float(v) if pd.notna(v) else float("nan")
            else:
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


FINMIND_CASH_FLOW_ROWS = (
    "Op Cash Flow",
    "Investing Cash Flow",
    "Financing Cash Flow",
)


def finmind_quarterly_cashflow_only(quarterly_df: pd.DataFrame) -> pd.DataFrame:
    """
    自 ``build_finmind_extension_dataframes`` 的季表僅取出三項現金流（百萬台幣），供與 MOPS／Yahoo 合併。
    """
    if quarterly_df is None or quarterly_df.empty:
        return pd.DataFrame()
    present = [r for r in FINMIND_CASH_FLOW_ROWS if r in quarterly_df.index]
    if not present:
        return pd.DataFrame()
    return quarterly_df.loc[present].copy()


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
