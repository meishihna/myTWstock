"""
公開資訊觀測站 (MOPS) 與 ``update_financials`` 合併架構：

1. **t163sb06 營益分析全市場表** — 主力：**營業收入（百萬元）**、**毛利率／營業利益率／稅後純益率（%）**；
   快取檔 ``{sii|otc}_{民國年}_{季}_t163sb06.json``；一般業 **Revenue／GP／OI 金額優先 t163sb04（千元→百萬）**，缺時再以營收×比率自 sb06 反算；三費仍依 t164；NI／EPS 以 sb04 為準。
2. **t163sb04 綜合損益全市場表** — 一般業補 **Revenue、Cost of Revenue、Gross Profit、Operating Income**（精確千元→百萬）、Net Income、EPS 及金融業營收等；快取 ``{typek}_{年}_{季}.json``（千元→百萬後之 YTD）。
   **t163 為曆年內 YTD 累計**；組單公司季表時於 ``_build_quarterly_block_for_ticker`` **反累計成單季**。
3. **t163sb20 現金流量全市場表** — 營業／投資／籌資活動淨現流（**仟元** 快取，合併時 ÷1000→百萬）；快取 ``{typek}_{年}_{季}_t163sb20.json``；多產業子表合併。
4. **FinMind** — 可選，現金流三項（於 ``update_financials`` 僅補 MOPS 缺口）。
5. **Yahoo** — 估值、CAPEX、年度 fallback 等；季現金流僅補 MOPS 缺口。
6. **t164 單公司** — 僅補 Selling／R&D／G&A 與 CAPEX 之 null（預設最近 **32** 季內有洞才請求，可環境變數縮小以加速測試）。

端點::

- **營益全市場** — ``GET/POST mopsov …/t163sb06`` + ``ajax_t163sb06``。
- **損益全市場** — ``POST …/ajax_t163sb04``，``TYPEK=sii|otc``，民國 ``year``、``season``。
- **現金流全市場** — ``GET …/t163sb20`` + ``POST …/ajax_t163sb20``（與 sb06 同型 session）。
- **單公司損益** — ``POST …/ajax_t164sb04``；**單公司現金流** — ``POST …/ajax_t164sb05``；參數皆含 ``co_id``、民國 ``year``、``season``、``report_id=C``。

環境變數
--------
MYTWSTOCK_MOPS
    ``1`` / ``true`` / ``on`` 啟用；預設 ``0`` 不發送任何 MOPS 請求。
MYTWSTOCK_MOPS_SLEEP_SEC
    兩次 HTTP 之間至少間隔秒數（預設 3）。
MYTWSTOCK_MOPS_INSECURE_SSL
    ``1`` 時略過 SSL 憑證驗證（僅限開發環境；部分 Windows 環境驗證 MOPS 憑證會失敗；FinLab 範例亦為 ``verify=False``）。

MYTWSTOCK_MOPS_MAX_QUARTERS
    歷史相容用；預設 **34**（32 季＋緩衝，與 ``FINANCIALS_MAX_QUARTERS`` 對齊）。
MYTWSTOCK_MOPS_T164_MAX_QUARTERS
    若設定：t164 最多掃描幾個仍有缺值之季別。**未設定時預設 32**（與 ``FINANCIALS_MAX_QUARTERS`` 對齊；設 ``5`` 等可加速測試）。
FINANCIALS_MAX_QUARTERS
    季表 JSON 欄數上限（預設 **32**）；t164 預設掃描上限為 ``min(32, FINANCIALS_MAX_QUARTERS)``。
MYTWSTOCK_MOPS_DEBUG_COLUMNS
    ``1`` 時：（1）全市場 t163 表將 ``read_html`` 攤平後的**欄位**印到 stderr；
    （2）單公司 t164 綜合損益表將第一欄**列名**（會計科目，含 raw／正規化後）印到 stderr。
MYTWSTOCK_MOPS_CACHE_TTL_SEC
    t163 快取檔在 **fetched_at**（或檔案 mtime）後此秒數內**不重抓**（預設 86400＝24h），
    即使 ``by_ticker`` 為空或小檔（尚未公告／解析失敗），避免每跑一次 ``update_financials`` 都打 MOPS。
    設 ``0`` 關閉 TTL（仍保留「非最近 2 季有檔就不抓」行為）。
MYTWSTOCK_MOPS_CACHE_SKIP_LOG
    ``0``／``false`` 時不印 ``[SKIP] …`` 至 stderr（預設會印）。
MYTWSTOCK_MOPS_MIN_DAYS_AFTER_Q_END
    日曆季**結束日之後**至少經過此天數才對該季發 t163／t164 HTTP（預設 **45**）；
    避免季剛結束、財報尚未上 MOPS 時空抓。設 ``0`` 關閉（仍須 ``today`` 晚於季末）。

快取目錄: ``data/mops_cache/{sii|otc}_{民國年}_{季}.json``（sb04）、``…_t163sb06.json``、``…_t163sb20.json``
    - 非「最近已完成季別」：有快取檔則直接讀取、不重抓。
    - 最近 2 個已完成季別：快取超過 ``MYTWSTOCK_MOPS_CACHE_TTL_SEC``（預設 24h）才重抓；TTL 內即使空檔亦略過（見 stderr ``[SKIP]``）。

HTTP：每次以 ``requests.post`` 直打端點；回應本文以 UTF-8／Big5／cp950 嘗試解碼（見 ``_decode_mops_html_payload``）。
t163sb04 頁面含多張產業表（一般／金控／銀行／證券／保險／特殊），解析後合併寫入同一 ``by_ticker``，每檔含 ``type`` 產業鍵。
"""

from __future__ import annotations

import io
import json
import os
import re
import sys
import threading
import time
from datetime import date, datetime, timezone
from typing import Any, Iterable

import pandas as pd
import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

from financial_supplement import (
    backfill_margin_percentages,
    canonical_period_label,
    coalesce_period_columns,
    sort_financial_statement_rows,
    supplement_block_to_dataframe,
)

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MOPS_CACHE_DIR = os.path.join(PROJECT_ROOT, "data", "mops_cache")
MOPS_URL = "https://mopsov.twse.com.tw/mops/web/ajax_t163sb04"
MOPS_SB06_PAGE_URL = "https://mopsov.twse.com.tw/mops/web/t163sb06"
MOPS_SB06_AJAX_URL = "https://mopsov.twse.com.tw/mops/web/ajax_t163sb06"
MOPS_SB20_PAGE_URL = "https://mopsov.twse.com.tw/mops/web/t163sb20"
MOPS_SB20_AJAX_URL = "https://mopsov.twse.com.tw/mops/web/ajax_t163sb20"
MOPS_SINGLE_INCOME_URL = "https://mopsov.twse.com.tw/mops/web/ajax_t164sb04"
MOPS_SINGLE_CASHFLOW_URL = "https://mopsov.twse.com.tw/mops/web/ajax_t164sb05"

# t163sb06 營益分析彙總：營收為**百萬元**；其餘為比率（%）。快取不存科目金額式 GP/OI/三費。
_SB06_CACHE_KEYS: tuple[str, ...] = (
    "Revenue",
    "Gross Margin (%)",
    "Operating Margin (%)",
    "Net Margin (%)",
)

# t163sb20 全市場現金流彙總：快取存 **仟元**（整數或小數）；合併列時 ÷1000→百萬。
_SB20_CACHE_KEYS: tuple[str, ...] = (
    "Op Cash Flow",
    "Investing Cash Flow",
    "Financing Cash Flow",
)

# 第一層 MOPS 全市場主導之損益核心列＋現金流三項（百萬／單季化後）
_MOPS_CSV_CORE_ROWS: tuple[str, ...] = (
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
)

# 第四層 t164：損益 sb04 補費用；現金流 sb05 補 CAPEX（仟元→百萬，存成負值）
_MOPS_T164_EXPENSE_ROWS: tuple[str, ...] = (
    "Selling & Marketing Exp",
    "R&D Exp",
    "General & Admin Exp",
)
_MOPS_T164_CAPEX_ROW = "CAPEX"

# 最近一次 HTTP 時間（全程序共用，簡單節流）
_LAST_HTTP_LOCK = threading.Lock()
_LAST_HTTP_MONO = 0.0

# 多組關鍵字（由專到寬）；比對對象為 _norm_header_for_match 後字串（括號內如（毛損）（千元）已剝除）。
# 涵蓋：標準製造業式綜合損益、金融混合型（無營業毛利／營業利益列時保持 null 屬正常）。
# 金額千元→百萬在解析時處理；EPS 元不換算。
_MOPS_SERIES_SPECS: list[tuple[list[str], str, bool]] = [
    (
        [
            "營業收入合計",
            "營業收入淨額",
            "銷貨收入淨額",
            "銷貨淨額",
            "收入淨額",
            "收入合計",
            "營業收入",
            # 金融業／金控 t163 常見合計型表頭（勿用過短「淨收益」以免命中營業外淨收益）
            "收益合計",
            "營業收益合計",
            "利息淨收益合計",
        ],
        "Revenue",
        True,
    ),
    (
        [
            # 正規化後：（毛損）（淨額）等已去 → 營業毛利淨額；優先於單純「營業毛利」（如台積電兩列並存）
            "營業毛利淨額",
            "營業毛利",
        ],
        "Gross Profit",
        True,
    ),
    (
        [
            # 台積電等 IFRS 表常見「銷售及行銷費用」整列；須早於過短的「行銷」以免誤配
            "銷售及行銷費用",
            "行銷及業務費用",
            "推銷及營業費用",
            "推銷費用",
            "銷售費用",
            "業務費用",
            "行銷費用",
            "推廣費用",
        ],
        "Selling & Marketing Exp",
        True,
    ),
    (
        [
            "研究發展費用",
            "研究發展費",
            "研發費用",
            "研究及發展費用",
            "研究開發費用",
            "研究開發費",
        ],
        "R&D Exp",
        True,
    ),
    (
        [
            "管理及總務費用",
            "管理費用",
            "行政管理費用",
            "一般管理費用",
        ],
        "General & Admin Exp",
        True,
    ),
    (
        [
            # （損失）剝除後多為「營業利益」
            "營業利益",
            "營業淨利",
        ],
        "Operating Income",
        True,
    ),
    (
        [
            "繼續營業單位本期淨利",
            "繼續營業單位本期淨損",
            "本期淨利",
            "稅後淨利",
            "本期稅後淨利",
            "歸屬母公司業主淨利",
        ],
        "Net Income",
        True,
    ),
    (["基本每股盈餘", "每股盈餘", "每股稅後盈餘"], "EPS", False),
]

_QUARTER_END_TO_SEASON = {
    (3, 31): 1,
    (6, 30): 2,
    (9, 30): 3,
    (12, 31): 4,
}


def mops_adapter_enabled() -> bool:
    return os.environ.get("MYTWSTOCK_MOPS", "0").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def _mops_sleep_sec() -> float:
    return max(0.0, float(os.environ.get("MYTWSTOCK_MOPS_SLEEP_SEC", "3") or 3))


def _mops_requests_verify() -> bool:
    """``False``＝略過 SSL 驗證（見 ``MYTWSTOCK_MOPS_INSECURE_SSL``）。"""
    return os.environ.get("MYTWSTOCK_MOPS_INSECURE_SSL", "").strip().lower() not in (
        "1",
        "true",
        "yes",
    )


def _rate_limit_wait() -> None:
    gap = _mops_sleep_sec()
    if gap <= 0:
        return
    global _LAST_HTTP_MONO
    with _LAST_HTTP_LOCK:
        now = time.monotonic()
        wait = gap - (now - _LAST_HTTP_MONO)
        if wait > 0:
            time.sleep(wait)
        _LAST_HTTP_MONO = time.monotonic()


def western_year_season_to_period_end(western_year: int, season: int) -> str:
    md = {1: (3, 31), 2: (6, 30), 3: (9, 30), 4: (12, 31)}[season]
    return f"{western_year}-{md[0]:02d}-{md[1]:02d}"


def roc_season_to_western_year(roc_year: int, season: int) -> int:
    """民國年季別對應的西元「該季結束日」所在年（日曆季與 MOPS 參數一致）。"""
    return roc_year + 1911


def period_label_to_roc_season(period: str) -> tuple[int, int] | None:
    """``YYYY-MM-DD`` → (民國年, 季 1-4)；無法解析則 None。"""
    s = str(period).strip().split()[0]
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", s)
    if not m:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    key = (mo, d)
    if key not in _QUARTER_END_TO_SEASON:
        return None
    return (y - 1911, _QUARTER_END_TO_SEASON[key])


def _previous_quarter_end(today: date) -> date:
    y, m = today.year, today.month
    if m <= 3:
        return date(y - 1, 12, 31)
    if m <= 6:
        return date(y, 3, 31)
    if m <= 9:
        return date(y, 6, 30)
    return date(y, 9, 30)


def _walk_quarter_end_back(d: date) -> date:
    if d.month == 3:
        return date(d.year - 1, 12, 31)
    if d.month == 6:
        return date(d.year, 3, 31)
    if d.month == 9:
        return date(d.year, 6, 30)
    return date(d.year, 9, 30)


def _recent_roc_seasons(count: int = 2) -> set[tuple[int, int]]:
    """最近 ``count`` 個「已完成」日曆季末對應之 (民國年, 季)。"""
    out: set[tuple[int, int]] = set()
    d = _previous_quarter_end(date.today())
    for _ in range(max(1, count)):
        roc = d.year - 1911
        se = _QUARTER_END_TO_SEASON[(d.month, d.day)]
        out.add((roc, se))
        d = _walk_quarter_end_back(d)
    return out


def _mops_quarter_end_date(roc_year: int, season: int) -> date:
    """(民國年, 季 1–4) → 該曆年季末日（日曆）。"""
    wy = roc_year + 1911
    md = {1: (3, 31), 2: (6, 30), 3: (9, 30), 4: (12, 31)}[season]
    return date(wy, md[0], md[1])


def _mops_min_days_after_quarter_end() -> int:
    try:
        return max(0, int(os.environ.get("MYTWSTOCK_MOPS_MIN_DAYS_AFTER_Q_END", "45") or 45))
    except ValueError:
        return 45


def mops_publish_lag_allows_http(roc_year: int, season: int, today: date | None = None) -> bool:
    """
    是否允許對該季發 MOPS HTTP（t163 全市場／t164 單公司）。

    - 今日仍處於該季或早於季末：不允許。
    - 季末已過但未滿 ``MYTWSTOCK_MOPS_MIN_DAYS_AFTER_Q_END`` 天：不允許（財報公告 lag）。
    """
    today = today or date.today()
    q_end = _mops_quarter_end_date(roc_year, season)
    if today <= q_end:
        return False
    lag = _mops_min_days_after_quarter_end()
    if lag > 0 and (today - q_end).days < lag:
        return False
    return True


_INDUSTRY_SUFFIX_MAP: dict[str, str] = {
    "general": "",
    "financial_holding": "_fh",
    "bank": "_bank",
    "securities": "_sec",
    "insurance": "_ins",
    "other": "_other",
}
_ALL_INDUSTRY_SUFFIXES: tuple[str, ...] = tuple(_INDUSTRY_SUFFIX_MAP.values())


def _cache_path(typek: str, roc_year: int, season: int, industry_suffix: str = "") -> str:
    return os.path.join(MOPS_CACHE_DIR, f"{typek}_{roc_year}_{season}{industry_suffix}.json")


def _cache_path_sb06(typek: str, roc_year: int, season: int) -> str:
    return os.path.join(MOPS_CACHE_DIR, f"{typek}_{roc_year}_{season}_t163sb06.json")


def _cache_path_sb20(typek: str, roc_year: int, season: int) -> str:
    return os.path.join(MOPS_CACHE_DIR, f"{typek}_{roc_year}_{season}_t163sb20.json")


def _mops_cache_ttl_seconds() -> float:
    try:
        v = float(os.environ.get("MYTWSTOCK_MOPS_CACHE_TTL_SEC", "86400") or 86400)
        return max(0.0, v)
    except ValueError:
        return 86400.0


def _parse_mops_cache_fetched_epoch_utc(s: str) -> float | None:
    try:
        s2 = str(s).strip()
        if s2.endswith("Z"):
            s2 = s2[:-1] + "+00:00"
        dt = datetime.fromisoformat(s2)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except (ValueError, TypeError):
        return None


def _try_load_mops_cache_payload(path: str) -> dict[str, Any] | None:
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError, TypeError):
        return None


def _mops_cache_reference_ts(path: str, payload: dict[str, Any] | None) -> float | None:
    if payload:
        fa = payload.get("fetched_at")
        if isinstance(fa, str):
            ts = _parse_mops_cache_fetched_epoch_utc(fa)
            if ts is not None:
                return ts
    try:
        return os.path.getmtime(path)
    except OSError:
        return None


def _normalize_mops_by_ticker_types(
    by_ticker: dict[str, dict[str, Any]] | None,
) -> dict[str, dict[str, Any]]:
    """
    確保每檔 ``by_ticker`` 記錄皆有字串 ``type``（可 JSON 序列化）。
    寫入快取前與讀取舊檔後呼叫，避免磁碟上舊資料或分支漏帶 ``type``。
    """
    if not by_ticker:
        return {}
    out: dict[str, dict[str, Any]] = {}
    for tid, rec in by_ticker.items():
        if not isinstance(rec, dict):
            continue
        d = dict(rec)
        t = d.get("type")
        if not isinstance(t, str) or not t.strip():
            d["type"] = "general"
        else:
            d["type"] = t.strip()
        out[str(tid)] = d
    return out


def _by_ticker_from_mops_payload(payload: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    if not payload:
        return {}
    bt = payload.get("by_ticker")
    if not isinstance(bt, dict):
        return {}
    raw = {str(k): dict(v) for k, v in bt.items() if isinstance(v, dict)}
    return _normalize_mops_by_ticker_types(raw)


def _mops_cache_is_effectively_empty(
    path: str, payload: dict[str, Any] | None, bt: dict[str, Any]
) -> bool:
    if payload and payload.get("empty") is True:
        return True
    if not bt:
        return True
    try:
        if os.path.getsize(path) < 2048:
            return True
    except OSError:
        pass
    return False


def _format_mops_cache_skip_size(path: str) -> str:
    try:
        n = os.path.getsize(path)
    except OSError:
        return "?"
    if n < 1024:
        return f"{n}B"
    return f"{n // 1024}KB"


def _log_mops_cache_skip_ttl(
    typek: str,
    roc_year: int,
    season: int,
    path: str,
    ttl_sec: float,
) -> None:
    if os.environ.get("MYTWSTOCK_MOPS_CACHE_SKIP_LOG", "1").strip().lower() in (
        "0",
        "false",
        "no",
        "off",
    ):
        return
    label = f"{typek}_{roc_year}_{season}"
    sz = _format_mops_cache_skip_size(path)
    h = ttl_sec / 3600.0
    if h >= 1 and abs(h - round(h)) < 0.01:
        hstr = f"{int(round(h))}h"
    else:
        hstr = f"{h:.1f}h"
    print(
        f"[SKIP] {label}: cached <{hstr} ago ({sz}, likely not yet published)",
        file=sys.stderr,
    )


def _log_mops_skip_publish_lag(
    typek: str,
    roc_year: int,
    season: int,
    *,
    had_cache: bool,
) -> None:
    if os.environ.get("MYTWSTOCK_MOPS_CACHE_SKIP_LOG", "1").strip().lower() in (
        "0",
        "false",
        "no",
        "off",
    ):
        return
    label = f"{typek}_{roc_year}_{season}"
    today = date.today()
    q_end = _mops_quarter_end_date(roc_year, season)
    need = _mops_min_days_after_quarter_end()
    if today <= q_end:
        detail = f"quarter not ended (ends {q_end.isoformat()})"
    else:
        days = (today - q_end).days
        detail = f"only {days}d after {q_end.isoformat()}, need >= {need}d lag"
    tail = "using cache only" if had_cache else "no HTTP (no cache)"
    print(f"[SKIP] {label}: {detail}; {tail}", file=sys.stderr)


def _log_mops_skip_t164_publish_lag(co_id: str, roc_year: int, season: int) -> None:
    if os.environ.get("MYTWSTOCK_MOPS_CACHE_SKIP_LOG", "1").strip().lower() in (
        "0",
        "false",
        "no",
        "off",
    ):
        return
    today = date.today()
    q_end = _mops_quarter_end_date(roc_year, season)
    need = _mops_min_days_after_quarter_end()
    if today <= q_end:
        detail = f"quarter not ended (ends {q_end.isoformat()})"
    else:
        days = (today - q_end).days
        detail = f"only {days}d after {q_end.isoformat()}, need >= {need}d lag"
    print(
        f"[SKIP] t164 co_id={co_id} {roc_year}Q{season}: {detail}; skip sb04/sb05",
        file=sys.stderr,
    )


def _should_use_mops_cache_without_fetch(
    path: str,
    roc_year: int,
    season: int,
    payload: dict[str, Any] | None,
) -> tuple[bool, bool]:
    """
    回傳 (use_cache_without_network, fresh_window_skip).

    - 有效 JSON 且（``fetched_at``／參考時間在 TTL 內 **或** 檔案 >10KB 且 mtime 在 TTL 內）：不抓。
    - 有效 JSON、非最近 2 季、檔案已存在：沿用舊行為不抓（fresh_window_skip=False）。
    - 其餘：應發 HTTP（若後續 publish lag 不允許則仍不發）。
    """
    if payload is None:
        return (False, False)
    if not os.path.isfile(path):
        return (False, False)

    ttl = _mops_cache_ttl_seconds()
    ref_ts = _mops_cache_reference_ts(path, payload)
    now_ts = time.time()
    try:
        mtime_ts = os.path.getmtime(path)
        sz = os.path.getsize(path)
    except OSError:
        mtime_ts, sz = None, 0

    within_ref_ttl = ttl > 0 and ref_ts is not None and (now_ts - ref_ts) < ttl
    large_mtime_fresh = (
        ttl > 0
        and sz > 10 * 1024
        and mtime_ts is not None
        and (now_ts - mtime_ts) < ttl
    )
    fresh_enough = within_ref_ttl or large_mtime_fresh
    recent = (roc_year, season) in _recent_roc_seasons(2)

    if fresh_enough:
        return (True, True)
    if not recent:
        return (True, False)
    return (False, False)


def _mops_max_fill_quarters() -> int:
    """（保留）歷史相容；t164 費用補洞請用 ``_mops_t164_max_expense_quarters``。"""
    try:
        return max(1, int(os.environ.get("MYTWSTOCK_MOPS_MAX_QUARTERS", "34") or 34))
    except ValueError:
        return 34


def _mops_t164_max_expense_quarters() -> int:
    """t164 最多掃描幾個仍有缺值之季別；預設 32（可 ``MYTWSTOCK_MOPS_T164_MAX_QUARTERS`` 覆寫）。"""
    try:
        fin_w = max(1, int(os.environ.get("FINANCIALS_MAX_QUARTERS", "32") or 32))
    except ValueError:
        fin_w = 32
    raw = os.environ.get("MYTWSTOCK_MOPS_T164_MAX_QUARTERS", "").strip()
    if raw:
        try:
            return max(1, min(int(raw), fin_w))
        except ValueError:
            pass
    return min(32, fin_w)


def _norm_header_for_match(flat_col: str) -> str:
    """去除空白與括號內註解（如（千元）、(新台幣千元)），利於比對舊版／上櫃表頭。"""
    s = re.sub(r"\s+", "", str(flat_col))
    s = re.sub(r"（[^）]{0,40}）", "", s)
    s = re.sub(r"\([^)]{0,40}\)", "", s)
    return s


def _pattern_matches_mops_label(pattern: str, series_key: str, label_norm: str) -> bool:
    """表頭或綜合損益列名是否命中該科目（營業外收入、毛利淨額優先、繼續營業淨利等排除）。"""
    if pattern not in label_norm:
        return False
    if series_key == "Gross Profit" and "毛利率" in label_norm:
        return False
    # 淨額列優先：「營業毛利」為子字串時勿誤配「營業毛利淨額」列
    if series_key == "Gross Profit" and pattern == "營業毛利" and "營業毛利淨額" in label_norm:
        return False
    # 收入合計／營業收入等皆勿對到營業外收入類科目
    if series_key == "Revenue" and "營業外" in label_norm:
        return False
    if series_key == "Revenue" and pattern == "營業收入" and "其他營業" in label_norm:
        return False
    # 「本期淨利」勿對到「繼續營業單位本期淨利」整行（較長者應先命中）
    if series_key == "Net Income" and pattern == "本期淨利" and "繼續營業" in label_norm:
        return False
    return True


def _norm_ticker_cell(v: Any) -> str:
    t = str(v).strip()
    if t.isdigit():
        return str(int(t))
    return t


def _parse_mops_number(cell: Any, scale_thousands_to_millions: bool) -> float | None:
    if cell is None or (isinstance(cell, float) and pd.isna(cell)):
        return None
    if isinstance(cell, (int, float)) and not isinstance(cell, bool):
        v = float(cell)
        if not pd.notna(v):
            return None
        return (v / 1000.0) if scale_thousands_to_millions else v
    t = str(cell).strip().replace(",", "").replace("\u3000", "").replace(" ", "")
    if t in ("", "-", "—", "nan", "NaN", "None"):
        return None
    neg = False
    if t.startswith("(") and t.endswith(")"):
        neg = True
        t = t[1:-1].strip()
    try:
        v = float(t)
    except ValueError:
        return None
    if neg:
        v = -v
    return (v / 1000.0) if scale_thousands_to_millions else v


def _decode_mops_html_payload(raw: bytes) -> str:
    """MOPS HTML 回應多為 Big5；先嘗試 UTF-8 再 Big5/cp950。"""
    for enc in ("utf-8-sig", "utf-8", "big5", "cp950", "big5hkscs"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _match_series_column(columns: list[str]) -> dict[str, tuple[int, bool]]:
    """series_key → (col_index, scale_thousands)."""
    norm_cols = [_norm_header_for_match(c) for c in columns]
    found: dict[str, tuple[int, bool]] = {}
    for patterns, series_key, scale_k in _MOPS_SERIES_SPECS:
        if series_key in found:
            continue
        for pattern in patterns:
            matched_i: int | None = None
            for i, nc in enumerate(norm_cols):
                if not _pattern_matches_mops_label(pattern, series_key, nc):
                    continue
                matched_i = i
                break
            if matched_i is not None:
                found[series_key] = (matched_i, scale_k)
                break
    return found


def _find_ticker_column_index(columns: list[str]) -> int | None:
    for i, c in enumerate(columns):
        s = _norm_header_for_match(c)
        if "公司代號" in s or s == "代號" or s.endswith("代號"):
            return i
    return None


def _flatten_read_html_column(c: Any) -> str:
    if isinstance(c, tuple):
        return "".join(
            str(x) for x in c if str(x).strip() and str(x).lower() not in ("nan",)
        )
    return str(c)


def _promote_read_html_first_row_as_columns_if_needed(tdf: pd.DataFrame) -> pd.DataFrame:
    """
    若 ``read_html`` 未把表頭寫入 ``columns``（找不到公司代號欄），但第 0 列像表頭，則升級第 0 列為欄名並捨棄該列。
    （sb06 另處固定採用 ``iloc[0]``；sb04 多表多數已寫入 ``columns``，此為少數 HTML 之相容。）
    """
    flat = [_flatten_read_html_column(x) for x in tdf.columns]
    if _find_ticker_column_index(flat) is not None:
        return tdf
    if tdf.shape[0] < 2:
        return tdf
    n = tdf.shape[1]
    cand = [_flatten_read_html_column(tdf.iat[0, j]) for j in range(n)]
    if _find_ticker_column_index(cand) is None:
        return tdf
    out = tdf.iloc[1:].copy()
    out.columns = cand
    return out


def _score_t163_market_summary_table(tdf: pd.DataFrame) -> int:
    """
    從多個 ``read_html`` 結果中挑出「綜合損益彙總」：須有公司代號欄且能對到足夠損益表頭。
    """
    if tdf.shape[1] < 3 or tdf.shape[0] < 2:
        return -1
    cols = [_flatten_read_html_column(x) for x in tdf.columns]
    if _find_ticker_column_index(cols) is None:
        return 0
    colmap = _match_series_column(cols)
    if not colmap:
        return 0
    return 20 + len(colmap) * 8 + min(tdf.shape[0], 2000)


# t163sb04 全市場快取：每檔 ticker 含 ``type``（產業）＋下列欄位（解析時千元→百萬之 YTD 累計）
_T163_CACHE_METRIC_KEYS: tuple[str, ...] = (
    "Revenue",
    "Cost of Revenue",
    "Gross Profit",
    "Selling & Marketing Exp",
    "R&D Exp",
    "General & Admin Exp",
    "Operating Income",
    "Net Income",
    "EPS",
)


def _t163_empty_metrics() -> dict[str, float | None]:
    return dict.fromkeys(_T163_CACHE_METRIC_KEYS, None)


def _t163_cell(row: pd.Series, idx: int | None, scale_k: bool) -> float | None:
    if idx is None or idx < 0:
        return None
    try:
        n = len(row)
    except TypeError:
        return None
    if idx >= n:
        return None
    return _parse_mops_number(row.iloc[idx], scale_k)


def _t163_col_substring(norm_cols: list[str], *subs: str) -> int | None:
    for sub in subs:
        for i, nc in enumerate(norm_cols):
            if sub in nc:
                return i
    return None


def _t163_col_general_operating_revenue(norm_cols: list[str]) -> int | None:
    """一般業 sb04 表「營業收入」欄：排除淨額／營業外等誤配。"""
    for i, nc in enumerate(norm_cols):
        if "營業收入" not in nc:
            continue
        if "淨" in nc:
            continue
        if "營業外" in nc:
            continue
        if "其他營業" in nc:
            continue
        return i
    return None


def _t163_col_general_gross_profit(norm_cols: list[str]) -> int | None:
    """營業毛利（毛損）；排除「營業毛利淨額」等子列。"""
    for i, nc in enumerate(norm_cols):
        if "營業毛利" not in nc:
            continue
        if "淨額" in nc:
            continue
        return i
    return None


def _t163_col_general_operating_income(norm_cols: list[str]) -> int | None:
    """營業利益／營業淨利；排除營業利益率等比率欄。"""
    for i, nc in enumerate(norm_cols):
        if "率" in nc:
            continue
        if "營業利益" in nc or "營業淨利" in nc:
            return i
    return None


def _t163_col_standalone_jing_shouyi(norm_cols: list[str]) -> int | None:
    """金控表「淨收益」獨立欄（非利息淨收益、非利息以外…）。銀行表無此欄。"""
    for i, nc in enumerate(norm_cols):
        if nc in ("淨收益", "淨收益合計"):
            return i
    return None


def _t163_col_net_benefit_holding(norm_cols: list[str]) -> int | None:
    """金控 Revenue（淨收益）：優先獨立淨收益欄，否則相容舊比對。"""
    ix = _t163_col_standalone_jing_shouyi(norm_cols)
    if ix is not None:
        return ix
    for i, nc in enumerate(norm_cols):
        if "淨收益" in nc and "利息" not in nc and "以外" not in nc and "營業外" not in nc:
            return i
    return None


def _t163_net_income_col(norm_cols: list[str]) -> int | None:
    for p in (
        "歸屬於母公司業主",
        "歸屬母公司業主",
        "歸屬於母公司業主之純益",
        "歸屬母公司業主之純益",
        "本期純益",
        "稅後純益",
        "本期稅後純益",
        "純益",
        "繼續營業單位本期淨利",
        "繼續營業單位本期淨損",
        "本期淨利",
        "稅後淨利",
        "本期稅後淨利",
    ):
        ix = _t163_col_substring(norm_cols, p)
        if ix is not None:
            return ix
    for patterns, series_key, _ in _MOPS_SERIES_SPECS:
        if series_key != "Net Income":
            continue
        for pattern in patterns:
            for i, nc in enumerate(norm_cols):
                if _pattern_matches_mops_label(pattern, series_key, nc):
                    return i
    return None


def _t163_eps_col(norm_cols: list[str]) -> int | None:
    ix = _t163_col_substring(norm_cols, "基本每股盈餘", "每股盈餘", "每股稅後盈餘")
    if ix is not None:
        return ix
    for patterns, series_key, _ in _MOPS_SERIES_SPECS:
        if series_key != "EPS":
            continue
        for pattern in patterns:
            for i, nc in enumerate(norm_cols):
                if pattern in nc:
                    return i
    return None


def _classify_t163_industry(norm_cols: list[str], ncols: int) -> str | None:
    """
    依 read_html 實際欄數與表頭關鍵字分類（括號等已由 _norm_header_for_match 剝除）。
    實測 read_html 欄數：general~30, bank/securities/holding~22, insurance~23, other~18。
    """
    def has(s: str) -> bool:
        return any(s in c for c in norm_cols)

    if ncols >= 28 and has("營業毛利"):
        return "general"
    if 20 <= ncols <= 26 and has("營業收入") and has("營業成本") and has("營業費用"):
        if not has("營業毛利"):
            return "insurance"
    # 金控有獨立「淨收益」欄；銀行僅有「利息淨收益」＋「利息以外…」
    if 18 <= ncols <= 26:
        if _t163_col_standalone_jing_shouyi(norm_cols) is not None:
            return "financial_holding"
        if has("利息淨收益"):
            return "bank"
        if has("支出及費用") and has("營業利益"):
            return "securities"
    if 15 <= ncols <= 22 and has("收入") and has("支出") and not has("營業收入"):
        return "other"
    return None


def _t163_parse_row_general(
    flat_cols: list[str], norm_cols: list[str], row: pd.Series
) -> dict[str, float | None]:
    out = _t163_empty_metrics()
    cm = _match_series_column(flat_cols)
    rev_i = _t163_col_general_operating_revenue(norm_cols)
    gp_i = _t163_col_general_gross_profit(norm_cols)
    oi_i = _t163_col_general_operating_income(norm_cols)
    out["Revenue"] = _t163_cell(row, rev_i, True)
    if out["Revenue"] is None and "Revenue" in cm:
        ci, sc = cm["Revenue"]
        out["Revenue"] = _t163_cell(row, ci, sc)
    out["Gross Profit"] = _t163_cell(row, gp_i, True)
    if out["Gross Profit"] is None and "Gross Profit" in cm:
        ci, sc = cm["Gross Profit"]
        out["Gross Profit"] = _t163_cell(row, ci, sc)
    out["Operating Income"] = _t163_cell(row, oi_i, True)
    if out["Operating Income"] is None and "Operating Income" in cm:
        ci, sc = cm["Operating Income"]
        out["Operating Income"] = _t163_cell(row, ci, sc)
    cor_i = _t163_col_substring(norm_cols, "營業成本")
    out["Cost of Revenue"] = _t163_cell(row, cor_i, True)
    sell_i = _t163_col_substring(norm_cols, "推銷費用", "銷售費用")
    rd_i = _t163_col_substring(
        norm_cols, "研究發展費用", "研究發展費", "研發費用", "研究及發展費用"
    )
    adm_i = _t163_col_substring(
        norm_cols, "管理及總務費用", "管理費用", "行政管理費用", "一般管理費用"
    )
    opex_i = _t163_col_substring(norm_cols, "營業費用")
    out["Selling & Marketing Exp"] = _t163_cell(row, sell_i, True)
    out["R&D Exp"] = _t163_cell(row, rd_i, True)
    if adm_i is not None:
        out["General & Admin Exp"] = _t163_cell(row, adm_i, True)
    elif sell_i is None and rd_i is None:
        out["General & Admin Exp"] = _t163_cell(row, opex_i, True)
    else:
        out["General & Admin Exp"] = _t163_cell(row, adm_i, True)
    nix = _t163_net_income_col(norm_cols)
    if nix is not None:
        out["Net Income"] = _t163_cell(row, nix, True)
    elif "Net Income" in cm:
        ci, sc = cm["Net Income"]
        out["Net Income"] = _t163_cell(row, ci, sc)
    if "EPS" in cm:
        ci, _ = cm["EPS"]
        out["EPS"] = _t163_cell(row, ci, False)
    else:
        out["EPS"] = _t163_cell(row, _t163_eps_col(norm_cols), False)
    return out


def _t163_parse_row_financial_holding(norm_cols: list[str], row: pd.Series) -> dict[str, float | None]:
    out = _t163_empty_metrics()
    out["Revenue"] = _t163_cell(row, _t163_col_net_benefit_holding(norm_cols), True)
    out["General & Admin Exp"] = _t163_cell(row, _t163_col_substring(norm_cols, "營業費用"), True)
    out["Net Income"] = _t163_ni_with_fallback(norm_cols, row)
    out["EPS"] = _t163_cell(row, _t163_eps_col(norm_cols), False)
    return out


def _t163_ni_with_fallback(norm_cols: list[str], row: pd.Series) -> float | None:
    """取歸屬母公司業主之淨利；若為 None 退回「本期淨利」或「本期稅後淨利」。"""
    v = _t163_cell(row, _t163_net_income_col(norm_cols), True)
    if v is not None:
        return v
    fb = _t163_col_substring(
        norm_cols, "本期淨利", "本期稅後淨利", "本期純益", "繼續營業單位本期純益",
    )
    return _t163_cell(row, fb, True)


def _t163_parse_row_bank(norm_cols: list[str], row: pd.Series) -> dict[str, float | None]:
    out = _t163_empty_metrics()
    i1 = _t163_col_substring(norm_cols, "利息淨收益")
    i2 = _t163_col_substring(norm_cols, "利息以外淨損益", "利息以外淨收益")
    v1, v2 = _t163_cell(row, i1, True), _t163_cell(row, i2, True)
    if v1 is None and v2 is None:
        out["Revenue"] = None
    else:
        out["Revenue"] = float(v1 or 0) + float(v2 or 0)
    out["General & Admin Exp"] = _t163_cell(row, _t163_col_substring(norm_cols, "營業費用"), True)
    out["Net Income"] = _t163_ni_with_fallback(norm_cols, row)
    out["EPS"] = _t163_cell(row, _t163_eps_col(norm_cols), False)
    return out


def _t163_parse_row_securities(norm_cols: list[str], row: pd.Series) -> dict[str, float | None]:
    out = _t163_empty_metrics()
    rev_i: int | None = None
    for i, nc in enumerate(norm_cols):
        if nc in ("收益", "收益合計"):
            rev_i = i
            break
    if rev_i is None:
        rev_i = _t163_col_substring(norm_cols, "收益")
    out["Revenue"] = _t163_cell(row, rev_i, True)
    oi_i = _t163_col_substring(norm_cols, "營業利益", "營業淨利")
    out["Operating Income"] = _t163_cell(row, oi_i, True)
    out["Net Income"] = _t163_ni_with_fallback(norm_cols, row)
    out["EPS"] = _t163_cell(row, _t163_eps_col(norm_cols), False)
    return out


def _t163_parse_row_insurance(norm_cols: list[str], row: pd.Series) -> dict[str, float | None]:
    out = _t163_empty_metrics()
    out["Revenue"] = _t163_cell(row, _t163_col_substring(norm_cols, "營業收入"), True)
    out["Cost of Revenue"] = _t163_cell(row, _t163_col_substring(norm_cols, "營業成本"), True)
    out["General & Admin Exp"] = _t163_cell(row, _t163_col_substring(norm_cols, "營業費用"), True)
    oi_i = _t163_col_substring(norm_cols, "營業利益", "營業淨利")
    out["Operating Income"] = _t163_cell(row, oi_i, True)
    out["Net Income"] = _t163_ni_with_fallback(norm_cols, row)
    out["EPS"] = _t163_cell(row, _t163_eps_col(norm_cols), False)
    return out


def _t163_parse_row_other(norm_cols: list[str], row: pd.Series) -> dict[str, float | None]:
    out = _t163_empty_metrics()
    out["Revenue"] = _t163_cell(row, _t163_col_substring(norm_cols, "收入"), True)
    out["Net Income"] = _t163_ni_with_fallback(norm_cols, row)
    out["EPS"] = _t163_cell(row, _t163_eps_col(norm_cols), False)
    return out


def _t163_row_metrics_for_industry(
    industry: str, flat_cols: list[str], norm_cols: list[str], row: pd.Series
) -> dict[str, float | None]:
    if industry == "general":
        return _t163_parse_row_general(flat_cols, norm_cols, row)
    if industry == "financial_holding":
        return _t163_parse_row_financial_holding(norm_cols, row)
    if industry == "bank":
        return _t163_parse_row_bank(norm_cols, row)
    if industry == "securities":
        return _t163_parse_row_securities(norm_cols, row)
    if industry == "insurance":
        return _t163_parse_row_insurance(norm_cols, row)
    if industry == "other":
        return _t163_parse_row_other(norm_cols, row)
    return _t163_empty_metrics()


def _parse_single_t163_market_table(tdf: pd.DataFrame) -> dict[str, dict[str, Any]]:
    if tdf.shape[1] < 3 or tdf.shape[0] < 1:
        return {}
    tdf = _promote_read_html_first_row_as_columns_if_needed(tdf)
    flat_cols = [_flatten_read_html_column(x) for x in tdf.columns]
    norm_cols = [_norm_header_for_match(c) for c in flat_cols]
    ncols = len(flat_cols)
    tix = _find_ticker_column_index(flat_cols)
    if tix is None:
        return {}
    industry = _classify_t163_industry(norm_cols, ncols)
    if industry is None:
        return {}
    if os.environ.get("MYTWSTOCK_MOPS_DEBUG_COLUMNS", "").strip().lower() in (
        "1",
        "true",
        "yes",
    ):
        print(
            f"[mops_financials] t163 table industry={industry!r} ncols={ncols} "
            f"headers={flat_cols[:6]}...",
            file=sys.stderr,
        )
    out: dict[str, dict[str, Any]] = {}
    for _, row in tdf.iterrows():
        tid = _norm_ticker_cell(row.iloc[tix])
        if not tid or not tid.isdigit():
            continue
        metrics = _t163_row_metrics_for_industry(industry, flat_cols, norm_cols, row)
        if not any(metrics.get(k) is not None for k in _T163_CACHE_METRIC_KEYS):
            continue
        # ``type`` 置於最後，即使 metrics 誤帶同名鍵亦以產業分類為準
        out[tid] = {**metrics, "type": industry}
    return out


def _parse_mops_html_table_legacy(
    html: str, tables: list[pd.DataFrame]
) -> dict[str, dict[str, Any]]:
    best: pd.DataFrame | None = None
    best_sc = -1
    for tdf in tables:
        sc = _score_t163_market_summary_table(tdf)
        if sc > best_sc:
            best_sc, best = sc, tdf
    if best is None or best_sc <= 0 or best.empty:
        return {}

    cols = [_flatten_read_html_column(x) for x in best.columns]
    if os.environ.get("MYTWSTOCK_MOPS_DEBUG_COLUMNS", "").strip().lower() in (
        "1",
        "true",
        "yes",
    ):
        print("[mops_financials] read_html flat columns (legacy):", cols, file=sys.stderr)
    tix = _find_ticker_column_index(cols)
    if tix is None:
        return {}
    colmap = _match_series_column(cols)
    if not colmap:
        return {}

    out_old: dict[str, dict[str, float | None]] = {}
    for _, row in best.iterrows():
        tid = _norm_ticker_cell(row.iloc[tix])
        if not tid or not tid.isdigit():
            continue
        rec: dict[str, float | None] = {}
        for sk, (ci, scale_k) in colmap.items():
            if ci >= len(row):
                continue
            rec[sk] = _parse_mops_number(row.iloc[ci], scale_k)
        if any(v is not None for v in rec.values()):
            out_old[tid] = rec

    merged: dict[str, dict[str, Any]] = {}
    for tid, rec in out_old.items():
        m = _t163_empty_metrics()
        for k, v in rec.items():
            if k in m:
                m[k] = v
        m["type"] = "general"
        merged[tid] = m
    return merged


def _parse_mops_html_all_tables(
    html: str,
) -> dict[str, dict[str, dict[str, Any]]]:
    """HTML → { industry_type: { ticker: { type, ...metrics } } }。

    解析頁面上**每一張**符合產業分類的 t163 表，按產業分桶；
    無命中時退回舊單表邏輯（全歸 ``"general"``）。
    """
    if not html or len(html) < 50:
        return {}
    try:
        tables = pd.read_html(io.StringIO(html), displayed_only=False)
    except ValueError:
        return {}

    by_industry: dict[str, dict[str, dict[str, Any]]] = {}
    for tdf in tables:
        part = _parse_single_t163_market_table(tdf)
        for tid, rec in part.items():
            industry = rec.get("type", "general")
            by_industry.setdefault(industry, {})[tid] = rec

    if by_industry:
        return {
            ind: _normalize_mops_by_ticker_types(bt)
            for ind, bt in by_industry.items()
        }

    legacy = _normalize_mops_by_ticker_types(
        _parse_mops_html_table_legacy(html, tables)
    )
    if legacy:
        return {"general": legacy}
    return {}


def _score_income_statement_table(tdf: pd.DataFrame) -> int:
    """挑選最像綜合損益表（列向科目、右側金額）的 ``read_html`` 表格。"""
    if tdf.shape[1] < 2 or tdf.shape[0] < 3:
        return 0
    score = 0
    for ri in range(min(tdf.shape[0], 120)):
        try:
            s = _norm_header_for_match(str(tdf.iat[ri, 0]))
        except (TypeError, ValueError, IndexError):
            continue
        if not s:
            continue
        for kw in ("營業收入", "營業利益", "綜合損益", "每股", "本期淨利", "稅後淨利"):
            if kw in s:
                score += 2
                break
    return score


def _parse_mops_single_company_income_html(html: str) -> dict[str, float | None]:
    """
    單公司 ajax_t164sb04 回傳 HTML → 科目英文列名 → 值（百萬台幣；EPS 元）。
    表格為「第一欄科目、其後為金額／%」；同科目多列時以最後一列為準（接近合計列）。
    """
    if not html or len(html) < 50:
        return {}
    try:
        tables = pd.read_html(io.StringIO(html), displayed_only=False)
    except ValueError:
        return {}
    if not tables:
        return {}
    best: pd.DataFrame | None = None
    best_sc = -1
    for tdf in tables:
        sc = _score_income_statement_table(tdf)
        if sc > best_sc:
            best_sc = sc
            best = tdf
    if best is None or best_sc < 2:
        return {}

    nrows, ncols = best.shape[0], best.shape[1]
    _mops_dbg_cols = os.environ.get("MYTWSTOCK_MOPS_DEBUG_COLUMNS", "").strip().lower() in (
        "1",
        "true",
        "yes",
    )

    def _t164_row_label(ri: int) -> tuple[str, str]:
        try:
            lc = best.iat[ri, 0]
        except (TypeError, ValueError, IndexError):
            return ("", "")
        if isinstance(lc, tuple):
            raw = "".join(
                str(x)
                for x in lc
                if str(x).strip() and str(x).lower() not in ("nan",)
            )
        else:
            raw = str(lc)
        return (raw, _norm_header_for_match(raw))

    if _mops_dbg_cols:
        dbg_lines: list[str] = []
        for ri in range(nrows):
            raw, norm = _t164_row_label(ri)
            dbg_lines.append(f"  [{ri:3d}] raw={raw!r} norm={norm!r}")
        print(
            "[mops_financials] t164 single-company income — first-column row labels "
            f"(table shape={best.shape}, score={best_sc}):\n"
            + "\n".join(dbg_lines),
            file=sys.stderr,
        )

    found: dict[str, float | None] = {}
    for ri in range(nrows):
        label_raw, label_norm = _t164_row_label(ri)
        if not label_norm:
            continue
        sk_res: str | None = None
        scale_res = True
        for patterns, series_key, scale_thousands in _MOPS_SERIES_SPECS:
            hit = False
            for pattern in patterns:
                if not _pattern_matches_mops_label(pattern, series_key, label_norm):
                    continue
                sk_res = series_key
                scale_res = scale_thousands
                hit = True
                break
            if hit:
                break
        if sk_res is None:
            continue
        val: float | None = None
        for ci in range(1, min(ncols, 8)):
            try:
                cell = best.iat[ri, ci]
            except (TypeError, ValueError, IndexError):
                continue
            v = _parse_mops_number(cell, scale_res)
            if v is not None:
                val = v
                break
        if val is not None:
            found[sk_res] = val
    return found


def _http_post_mops_single_income(co_id: str, roc_year: int, season: int) -> str:
    """單一公司綜合損益（合併報表 C）；網路偶發失敗時短重試。"""
    last_err: BaseException | None = None
    for attempt in range(4):
        try:
            _rate_limit_wait()
            r = requests.post(
                MOPS_SINGLE_INCOME_URL,
                {
                    "encodeURIComponent": 1,
                    "step": 1,
                    "firstin": 1,
                    "off": 1,
                    "co_id": str(co_id).strip(),
                    "year": str(roc_year),
                    "season": str(int(season)),
                    "report_id": "C",
                },
                verify=_mops_requests_verify(),
                timeout=120,
            )
            r.raise_for_status()
            return _decode_mops_html_payload(r.content)
        except requests.RequestException as e:
            last_err = e
            if attempt >= 3:
                break
            time.sleep(1.0 + 0.75 * attempt)
    if last_err is not None:
        print(
            f"[WARN] t164 sb04 income co_id={co_id} {roc_year}Q{season}: {last_err}",
            file=sys.stderr,
        )
    return ""


def _http_post_mops_single_cashflow(co_id: str, roc_year: int, season: int) -> str:
    """單一公司現金流量表（合併報表 C）；與損益 t164 相同參數，含短重試。"""
    last_err: BaseException | None = None
    for attempt in range(4):
        try:
            _rate_limit_wait()
            r = requests.post(
                MOPS_SINGLE_CASHFLOW_URL,
                {
                    "encodeURIComponent": 1,
                    "step": 1,
                    "firstin": 1,
                    "off": 1,
                    "co_id": str(co_id).strip(),
                    "year": str(roc_year),
                    "season": str(int(season)),
                    "report_id": "C",
                },
                verify=_mops_requests_verify(),
                timeout=120,
            )
            r.raise_for_status()
            return _decode_mops_html_payload(r.content)
        except requests.RequestException as e:
            last_err = e
            if attempt >= 3:
                break
            time.sleep(1.0 + 0.75 * attempt)
    if last_err is not None:
        print(
            f"[WARN] t164 sb05 cashflow co_id={co_id} {roc_year}Q{season}: {last_err}",
            file=sys.stderr,
        )
    return ""


def _label_matches_mops_capex_ppe_line(label_norm: str) -> bool:
    """現金流表中購置 PPE 相關列：須同時含不動產、廠房、設備。"""
    return (
        "不動產" in label_norm
        and "廠房" in label_norm
        and "設備" in label_norm
    )


def _score_cashflow_statement_table(tdf: pd.DataFrame) -> int:
    if tdf.shape[1] < 2 or tdf.shape[0] < 3:
        return 0
    score = 0
    for ri in range(min(tdf.shape[0], 150)):
        try:
            s = _norm_header_for_match(str(tdf.iat[ri, 0]))
        except (TypeError, ValueError, IndexError):
            continue
        if not s:
            continue
        for kw in (
            "現金流量",
            "投資活動",
            "營業活動",
            "籌資活動",
            "不動產",
            "廠房及設備",
        ):
            if kw in s:
                score += 2
                break
    return score


def _parse_mops_single_company_cashflow_html(html: str) -> float | None:
    """
    t164sb05 HTML → CAPEX（百萬台幣，**負值**表示現金流出，與 Yahoo 季表慣例一致）。
    列名須同時包含「不動產」「廠房」「設備」；仟元→百萬。
    同表多列符合時：每列先取橫向**絕對值最大**之欄（本期主金額），再取全表**絕對值最大**之列，
    避免末行淨額／細項或表頭小欄覆蓋「取得…」合計列。
    """
    if not html or len(html) < 50:
        return None
    try:
        tables = pd.read_html(io.StringIO(html), displayed_only=False)
    except ValueError:
        return None
    if not tables:
        return None
    best: pd.DataFrame | None = None
    best_sc = -1
    for tdf in tables:
        sc = _score_cashflow_statement_table(tdf)
        if sc > best_sc:
            best_sc = sc
            best = tdf
    if best is None or best_sc < 2:
        return None

    nrows, ncols = best.shape[0], best.shape[1]
    best_mag = -1.0
    capex_millions: float | None = None
    for ri in range(nrows):
        try:
            lc = best.iat[ri, 0]
        except (TypeError, ValueError, IndexError):
            continue
        if isinstance(lc, tuple):
            label_raw = "".join(
                str(x)
                for x in lc
                if str(x).strip() and str(x).lower() not in ("nan",)
            )
        else:
            label_raw = str(lc)
        label_norm = _norm_header_for_match(label_raw)
        if not _label_matches_mops_capex_ppe_line(label_norm):
            continue
        # 橫向：勿取第一欄小數；直向：勿取最後一列細項／淨額覆蓋「取得…」大額合計列。
        candidates: list[float] = []
        for ci in range(1, min(ncols, 14)):
            try:
                cell = best.iat[ri, ci]
            except (TypeError, ValueError, IndexError):
                continue
            v = _parse_mops_number(cell, True)
            if v is not None:
                candidates.append(float(v))
        if not candidates:
            continue
        val = max(candidates, key=abs)
        mag = abs(float(val))
        if mag > best_mag:
            best_mag = mag
            capex_millions = -mag
    return capex_millions


def _columns_matching_period(df: pd.DataFrame, period_label: str) -> list[Any]:
    return [c for c in df.columns if canonical_period_label(c) == period_label]


def _http_post_mops_season(typek: str, roc_year: int, season: int) -> str:
    """與 FinLab 相同：單次 ``requests.post``，無 Session／無自訂 headers。"""
    _rate_limit_wait()
    r = requests.post(
        MOPS_URL,
        {
            "encodeURIComponent": 1,
            "step": 1,
            "firstin": 1,
            "off": 1,
            "TYPEK": typek,
            "year": str(roc_year),
            "season": str(season),
        },
        verify=_mops_requests_verify(),
        timeout=120,
    )
    r.raise_for_status()
    return _decode_mops_html_payload(r.content)


def _sb06_round2(v: float | None) -> float | None:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    return round(float(v), 2)


def _sb06_first_column_matching(df: pd.DataFrame, keyword: str) -> Any | None:
    """欄位名很長時以子字串匹配（與 MOPS read_html 表頭一致）。"""
    for c in df.columns:
        if keyword in str(c):
            return c
    return None


def _parse_mops_html_sb06(html: str) -> dict[str, dict[str, Any]]:
    """
    ajax_t163sb06 HTML → { ticker: { Revenue 百萬元, Gross/Operating/Net Margin % } }。

    觀測站實際為單一主表：``read_html`` 第一張表最大；第 0 列為真正表頭，資料自第 1 列起。
    """
    if not html or len(html) < 80:
        return {}
    try:
        dfs = pd.read_html(io.StringIO(html), displayed_only=False)
    except ValueError:
        return {}
    if not dfs:
        return {}
    df = dfs[0].copy()
    if int(df.shape[0]) < 2 or int(df.shape[1]) < 5:
        return {}
    df.columns = df.iloc[0]
    df = df.iloc[1:]
    c0, c1 = df.columns[0], df.columns[1]
    df = df.rename(columns={c0: "ticker", c1: "name"})

    rev_col = _sb06_first_column_matching(df, "營業收入")
    gm_col = _sb06_first_column_matching(df, "毛利率")
    om_col = _sb06_first_column_matching(df, "營業利益率")
    nm_col = _sb06_first_column_matching(df, "稅後")
    if rev_col is None or gm_col is None or om_col is None or nm_col is None:
        return {}

    out: dict[str, dict[str, Any]] = {}
    for _, row in df.iterrows():
        tk_raw = row.get("ticker")
        tk = str(tk_raw).strip() if tk_raw is not None and not (
            isinstance(tk_raw, float) and pd.isna(tk_raw)
        ) else ""
        if not tk or not tk[0].isdigit():
            continue
        tid = _norm_ticker_cell(tk)
        if not tid.isdigit() or len(tid) != 4:
            continue
        rev = _parse_mops_number(row[rev_col], scale_thousands_to_millions=False)
        if rev is None:
            continue
        gm = _parse_mops_number(row[gm_col], scale_thousands_to_millions=False)
        om = _parse_mops_number(row[om_col], scale_thousands_to_millions=False)
        nm = _parse_mops_number(row[nm_col], scale_thousands_to_millions=False)
        out[tid] = {
            "Revenue": _sb06_round2(rev),
            "Gross Margin (%)": _sb06_round2(gm),
            "Operating Margin (%)": _sb06_round2(om),
            "Net Margin (%)": _sb06_round2(nm),
        }
    return out


def _parse_mops_html_sb20(html: str) -> dict[str, dict[str, Any]]:
    """
    ajax_t163sb20 HTML → { ticker: { Op/Investing/Financing CF **仟元** } }。
    合併所有含 9 欄以上之子表（銀行／證券／一般／金控／保險／其他等）。

    與 sb06 不同：``read_html`` 已將表頭寫入 ``df.columns``，**不需**再以第 0 列當表頭或 ``iloc[1:]``。
    """
    if not html or len(html) < 80:
        return {}
    try:
        dfs = pd.read_html(io.StringIO(html), displayed_only=False)
    except ValueError:
        return {}
    by_ticker: dict[str, dict[str, Any]] = {}
    for raw_df in dfs:
        df = raw_df.copy()
        nr, nc = int(df.shape[0]), int(df.shape[1])
        if nc < 9 or nr < 1:
            continue
        ticker_col = df.columns[0]
        op_col = _sb06_first_column_matching(df, "營業活動")
        inv_col = _sb06_first_column_matching(df, "投資活動")
        fin_col = _sb06_first_column_matching(df, "籌資活動")
        if op_col is None or inv_col is None or fin_col is None:
            continue
        for _, row in df.iterrows():
            tk_raw = row.get(ticker_col)
            tk = str(tk_raw).strip() if tk_raw is not None and not (
                isinstance(tk_raw, float) and pd.isna(tk_raw)
            ) else ""
            if not tk or not tk[0].isdigit():
                continue
            tid = _norm_ticker_cell(tk)
            if not tid.isdigit() or len(tid) != 4:
                continue
            opv = _parse_mops_number(row[op_col], scale_thousands_to_millions=False)
            invv = _parse_mops_number(row[inv_col], scale_thousands_to_millions=False)
            finv = _parse_mops_number(row[fin_col], scale_thousands_to_millions=False)
            if opv is None and invv is None and finv is None:
                continue
            by_ticker[tid] = {
                "Op Cash Flow": _sb06_round2(opv) if opv is not None else None,
                "Investing Cash Flow": _sb06_round2(invv) if invv is not None else None,
                "Financing Cash Flow": _sb06_round2(finv) if finv is not None else None,
            }
    return by_ticker


def _http_fetch_sb06_html(typek: str, roc_year: int, season: int) -> str:
    """先 GET t163sb06 頁再 POST ajax（與觀測站行為一致）。"""
    last_err: BaseException | None = None
    for attempt in range(3):
        try:
            sess = requests.Session()
            _rate_limit_wait()
            sess.get(
                MOPS_SB06_PAGE_URL,
                verify=_mops_requests_verify(),
                timeout=60,
                headers={
                    "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
                },
            )
            _rate_limit_wait()
            r = sess.post(
                MOPS_SB06_AJAX_URL,
                data={
                    "encodeURIComponent": 1,
                    "step": 1,
                    "firstin": 1,
                    "off": 1,
                    "TYPEK": typek,
                    "year": str(roc_year),
                    "season": str(int(season)),
                },
                headers={
                    "Accept": "text/html,application/xhtml+xml,*/*",
                    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Connection": "keep-alive",
                },
                verify=_mops_requests_verify(),
                timeout=120,
            )
            r.raise_for_status()
            return _decode_mops_html_payload(r.content)
        except (requests.RequestException, OSError) as e:
            last_err = e
            time.sleep(1.0 + attempt)
    if last_err is not None:
        print(
            f"[WARN] t163sb06 {typek} {roc_year}Q{season}: {last_err}",
            file=sys.stderr,
        )
    return ""


def _http_fetch_sb20_html(typek: str, roc_year: int, season: int) -> str:
    """先 GET t163sb20 頁再 POST ajax_t163sb20（與 sb06 同型）。"""
    last_err: BaseException | None = None
    for attempt in range(3):
        try:
            sess = requests.Session()
            _rate_limit_wait()
            sess.get(
                MOPS_SB20_PAGE_URL,
                verify=_mops_requests_verify(),
                timeout=60,
                headers={
                    "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
                },
            )
            _rate_limit_wait()
            r = sess.post(
                MOPS_SB20_AJAX_URL,
                data={
                    "encodeURIComponent": 1,
                    "step": 1,
                    "firstin": 1,
                    "off": 1,
                    "TYPEK": typek,
                    "year": str(roc_year),
                    "season": str(int(season)),
                },
                headers={
                    "Accept": "text/html,application/xhtml+xml,*/*",
                    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Connection": "keep-alive",
                },
                verify=_mops_requests_verify(),
                timeout=120,
            )
            r.raise_for_status()
            return _decode_mops_html_payload(r.content)
        except (requests.RequestException, OSError) as e:
            last_err = e
            time.sleep(1.0 + attempt)
    if last_err is not None:
        print(
            f"[WARN] t163sb20 {typek} {roc_year}Q{season}: {last_err}",
            file=sys.stderr,
        )
    return ""


def _write_sb06_cache(
    typek: str,
    roc_year: int,
    season: int,
    by_ticker: dict[str, dict[str, Any]],
    fetched_at: str,
) -> None:
    path = _cache_path_sb06(typek, roc_year, season)
    payload_out: dict[str, Any] = {
        "source": "mopsov",
        "endpoint": "ajax_t163sb06",
        "typek": typek,
        "roc_year": roc_year,
        "season": season,
        "fetched_at": fetched_at,
        "unit_note": "amounts in NTD millions (百萬元)",
        "empty": not by_ticker,
        "by_ticker": by_ticker,
    }
    try:
        os.makedirs(MOPS_CACHE_DIR, exist_ok=True)
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload_out, f, ensure_ascii=False)
        os.replace(tmp, path)
    except OSError:
        pass


def _load_or_fetch_season_sb06(typek: str, roc_year: int, season: int) -> dict[str, dict[str, Any]]:
    """t163sb06 全市場快取；TTL／publish lag 與 sb04 相同邏輯。"""
    path = _cache_path_sb06(typek, roc_year, season)
    payload = _try_load_mops_cache_payload(path)
    use_cache, fresh_window = _should_use_mops_cache_without_fetch(
        path, roc_year, season, payload
    )
    if use_cache and payload is not None:
        bt = _by_ticker_from_mops_payload(payload)
        if fresh_window and not bt:
            _log_mops_cache_skip_ttl(
                typek, roc_year, season, path, _mops_cache_ttl_seconds()
            )
        return bt

    if not mops_publish_lag_allows_http(roc_year, season):
        if payload is not None or os.path.isfile(path):
            _log_mops_skip_publish_lag(typek, roc_year, season, had_cache=True)
            return _by_ticker_from_mops_payload(payload) if payload else {}
        _log_mops_skip_publish_lag(typek, roc_year, season, had_cache=False)
        return {}

    os.makedirs(MOPS_CACHE_DIR, exist_ok=True)
    html = _http_fetch_sb06_html(typek, roc_year, season)
    by_ticker = _parse_mops_html_sb06(html)
    fetched_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    _write_sb06_cache(typek, roc_year, season, by_ticker, fetched_at)
    return by_ticker


def _lookup_ticker_sb06_markets(ticker: str, roc_year: int, season: int) -> dict[str, Any] | None:
    tid = _norm_ticker_cell(ticker)
    for typek in ("sii", "otc"):
        data = _load_or_fetch_season_sb06(typek, roc_year, season)
        row = data.get(tid)
        if row and any(row.get(k) is not None for k in _SB06_CACHE_KEYS):
            return dict(row)
    return None


def _lookup_ticker_cache_only_sb06(
    ticker: str, roc_year: int, season: int,
) -> dict[str, Any] | None:
    tid = _norm_ticker_cell(ticker)
    for typek in ("sii", "otc"):
        path = _cache_path_sb06(typek, roc_year, season)
        payload = _try_load_mops_cache_payload(path)
        if payload is None:
            continue
        bt = _by_ticker_from_mops_payload(payload)
        row = bt.get(tid)
        if row and any(row.get(k) is not None for k in _SB06_CACHE_KEYS):
            return dict(row)
    return None


def _sb20_cache_row_to_millions(row: dict[str, Any]) -> dict[str, float | None]:
    """快取仟元 → 百萬元（÷1000），小數 2 位。"""
    out: dict[str, float | None] = {}
    for k in _SB20_CACHE_KEYS:
        raw = row.get(k)
        if raw is None or (isinstance(raw, float) and pd.isna(raw)):
            out[k] = None
            continue
        try:
            out[k] = round(float(raw) / 1000.0, 2)
        except (TypeError, ValueError):
            out[k] = None
    return out


def _write_sb20_cache(
    typek: str,
    roc_year: int,
    season: int,
    by_ticker: dict[str, dict[str, Any]],
    fetched_at: str,
) -> None:
    path = _cache_path_sb20(typek, roc_year, season)
    payload_out: dict[str, Any] = {
        "source": "mopsov",
        "endpoint": "ajax_t163sb20",
        "typek": typek,
        "roc_year": roc_year,
        "season": season,
        "fetched_at": fetched_at,
        "unit_note": "amounts in NTD thousands (仟元)",
        "empty": not by_ticker,
        "by_ticker": by_ticker,
    }
    try:
        os.makedirs(MOPS_CACHE_DIR, exist_ok=True)
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload_out, f, ensure_ascii=False)
        os.replace(tmp, path)
    except OSError:
        pass


def _load_or_fetch_season_sb20(typek: str, roc_year: int, season: int) -> dict[str, dict[str, Any]]:
    """t163sb20 全市場快取；TTL／publish lag 與 sb04／sb06 相同。"""
    path = _cache_path_sb20(typek, roc_year, season)
    payload = _try_load_mops_cache_payload(path)
    use_cache, fresh_window = _should_use_mops_cache_without_fetch(
        path, roc_year, season, payload
    )
    if use_cache and payload is not None:
        bt = _by_ticker_from_mops_payload(payload)
        if fresh_window and not bt:
            _log_mops_cache_skip_ttl(
                typek, roc_year, season, path, _mops_cache_ttl_seconds()
            )
        return bt

    if not mops_publish_lag_allows_http(roc_year, season):
        if payload is not None or os.path.isfile(path):
            _log_mops_skip_publish_lag(typek, roc_year, season, had_cache=True)
            return _by_ticker_from_mops_payload(payload) if payload else {}
        _log_mops_skip_publish_lag(typek, roc_year, season, had_cache=False)
        return {}

    os.makedirs(MOPS_CACHE_DIR, exist_ok=True)
    html = _http_fetch_sb20_html(typek, roc_year, season)
    by_ticker = _parse_mops_html_sb20(html)
    fetched_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    _write_sb20_cache(typek, roc_year, season, by_ticker, fetched_at)
    return by_ticker


def _lookup_ticker_sb20_markets(ticker: str, roc_year: int, season: int) -> dict[str, float | None] | None:
    tid = _norm_ticker_cell(ticker)
    for typek in ("sii", "otc"):
        data = _load_or_fetch_season_sb20(typek, roc_year, season)
        row = data.get(tid)
        if row and any(row.get(k) is not None for k in _SB20_CACHE_KEYS):
            return _sb20_cache_row_to_millions(dict(row))
    return None


def _lookup_ticker_cache_only_sb20(
    ticker: str, roc_year: int, season: int,
) -> dict[str, float | None] | None:
    tid = _norm_ticker_cell(ticker)
    for typek in ("sii", "otc"):
        path = _cache_path_sb20(typek, roc_year, season)
        payload = _try_load_mops_cache_payload(path)
        if payload is None:
            continue
        bt = _by_ticker_from_mops_payload(payload)
        row = bt.get(tid)
        if row and any(row.get(k) is not None for k in _SB20_CACHE_KEYS):
            return _sb20_cache_row_to_millions(dict(row))
    return None


def _sb06_metric_float(v: Any) -> float | None:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _lookup_ticker_merged_sb06_sb04(
    ticker: str, roc_year: int, season: int
) -> dict[str, Any] | None:
    """
    損益＋現金流 YTD：sb06／sb04 同上；**sb20** 補營業／投資／籌資淨現流（快取仟元→百萬）。
    損益列缺時仍可僅靠 sb20 回傳現金流列；``type`` 仍以 sb04 為準。

    一般業金額：**Revenue／Cost of Revenue／Gross Profit／Operating Income** 以 sb04 快取（千元→百萬）為優先；
    Revenue／GP／OI 缺時再以 sb06 營收與毛利率／營業利益率反算。NI／EPS 以 sb04 為優先、缺時 NI 可自 sb06 稅後純益率反算。
    毛利率等**比率**仍取自 sb06（無 sb06 時不強行自 sb04 推導）。
    """
    tid = _norm_ticker_cell(ticker)
    sb6 = _lookup_ticker_sb06_markets(ticker, roc_year, season)
    sb4_row: dict[str, Any] | None = None
    for typek in ("sii", "otc"):
        data = _load_or_fetch_season_data(typek, roc_year, season)
        r = data.get(tid)
        if r and any(r.get(k) is not None for k in _T163_CACHE_METRIC_KEYS):
            sb4_row = dict(r)
            break

    def sb4_val(k: str) -> float | None:
        if not sb4_row:
            return None
        vv = sb4_row.get(k)
        return None if vv is None or (isinstance(vv, float) and pd.isna(vv)) else float(vv)

    rev = sb4_val("Revenue")
    if rev is None:
        rev = _sb06_metric_float(sb6.get("Revenue")) if sb6 else None
    gm = _sb06_metric_float(sb6.get("Gross Margin (%)")) if sb6 else None
    om = _sb06_metric_float(sb6.get("Operating Margin (%)")) if sb6 else None
    nm = _sb06_metric_float(sb6.get("Net Margin (%)")) if sb6 else None

    gp = sb4_val("Gross Profit")
    if gp is None and rev is not None and gm is not None:
        gp = round(rev * gm / 100.0, 2)

    oi = sb4_val("Operating Income")
    if oi is None and rev is not None and om is not None:
        oi = round(rev * om / 100.0, 2)

    ni = sb4_val("Net Income")
    if ni is None and rev is not None and nm is not None:
        ni = round(rev * nm / 100.0, 2)

    def r2(v: float | None) -> float | None:
        return None if v is None else round(float(v), 2)

    out = _t163_empty_metrics()
    out["Revenue"] = r2(rev)
    out["Cost of Revenue"] = r2(sb4_val("Cost of Revenue"))
    out["Gross Profit"] = r2(gp)
    out["Selling & Marketing Exp"] = r2(sb4_val("Selling & Marketing Exp"))
    out["R&D Exp"] = r2(sb4_val("R&D Exp"))
    out["General & Admin Exp"] = r2(sb4_val("General & Admin Exp"))
    out["Operating Income"] = r2(oi)
    out["Net Income"] = r2(ni)
    out["EPS"] = r2(sb4_val("EPS"))

    itype = "general"
    if sb4_row:
        t = sb4_row.get("type")
        if isinstance(t, str) and t.strip():
            itype = t.strip()
    out["type"] = itype
    for k in _SB20_CACHE_KEYS:
        out[k] = None
    sb20m = _lookup_ticker_sb20_markets(ticker, roc_year, season)
    if sb20m:
        for k in _SB20_CACHE_KEYS:
            if out.get(k) is None and sb20m.get(k) is not None:
                out[k] = sb20m[k]
    has_pl = any(out.get(k) is not None for k in _T163_CACHE_METRIC_KEYS)
    has_cf = any(out.get(k) is not None for k in _SB20_CACHE_KEYS)
    if not has_pl and not has_cf:
        return None
    return out


def _load_all_industry_caches(
    typek: str, roc_year: int, season: int
) -> dict[str, dict[str, Any]]:
    """讀取所有產業後綴快取，合併成扁平 { ticker: record }。"""
    merged: dict[str, dict[str, Any]] = {}
    for suffix in _ALL_INDUSTRY_SUFFIXES:
        path = _cache_path(typek, roc_year, season, suffix)
        payload = _try_load_mops_cache_payload(path)
        if payload is None:
            continue
        bt = _by_ticker_from_mops_payload(payload)
        merged.update(bt)
    return merged


def _any_industry_cache_exists(typek: str, roc_year: int, season: int) -> bool:
    for suffix in _ALL_INDUSTRY_SUFFIXES:
        if os.path.isfile(_cache_path(typek, roc_year, season, suffix)):
            return True
    return False


def _write_industry_cache(
    typek: str, roc_year: int, season: int,
    industry: str, by_ticker: dict[str, dict[str, Any]],
    fetched_at: str,
) -> None:
    suffix = _INDUSTRY_SUFFIX_MAP.get(industry, f"_{industry}")
    path = _cache_path(typek, roc_year, season, suffix)
    payload_out = {
        "fetched_at": fetched_at,
        "typek": typek,
        "roc_year": roc_year,
        "season": season,
        "industry": industry,
        "empty": not by_ticker,
        "by_ticker": by_ticker,
    }
    try:
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload_out, f, ensure_ascii=False)
        os.replace(tmp, path)
    except OSError:
        pass


def _load_or_fetch_season_data(
    typek: str, roc_year: int, season: int
) -> dict[str, dict[str, Any]]:
    # TTL / freshness 判斷以一般企業快取為參考（它一定存在或一起抓）
    general_path = _cache_path(typek, roc_year, season, "")
    payload = _try_load_mops_cache_payload(general_path)
    use_cache, fresh_window = _should_use_mops_cache_without_fetch(
        general_path, roc_year, season, payload
    )

    if use_cache and payload is not None:
        merged = _load_all_industry_caches(typek, roc_year, season)
        if fresh_window and not merged:
            _log_mops_cache_skip_ttl(
                typek, roc_year, season, general_path, _mops_cache_ttl_seconds()
            )
        return merged

    if not mops_publish_lag_allows_http(roc_year, season):
        if payload is not None or _any_industry_cache_exists(typek, roc_year, season):
            _log_mops_skip_publish_lag(typek, roc_year, season, had_cache=True)
            return _load_all_industry_caches(typek, roc_year, season)
        _log_mops_skip_publish_lag(typek, roc_year, season, had_cache=False)
        return {}

    os.makedirs(MOPS_CACHE_DIR, exist_ok=True)
    html = _http_post_mops_season(typek, roc_year, season)
    by_industry = _parse_mops_html_all_tables(html)
    fetched_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # 每個產業各寫一份 JSON；無資料的產業也寫空 general 檔（作為 TTL 基準）
    if not by_industry:
        _write_industry_cache(typek, roc_year, season, "general", {}, fetched_at)
    else:
        for industry, bt in by_industry.items():
            _write_industry_cache(typek, roc_year, season, industry, bt, fetched_at)
        if "general" not in by_industry:
            _write_industry_cache(typek, roc_year, season, "general", {}, fetched_at)

    merged: dict[str, dict[str, Any]] = {}
    for bt in by_industry.values():
        merged.update(bt)
    return merged


def _lookup_ticker_in_markets(
    ticker: str, roc_year: int, season: int
) -> dict[str, Any] | None:
    """t163sb06＋sb04＋**sb20 現金流** 合併後之 YTD 列（損益＋三項淨現流，百萬台幣／EPS 元）。"""
    row = _lookup_ticker_merged_sb06_sb04(ticker, roc_year, season)
    if not row:
        return None
    out = dict(row)
    t = out.get("type")
    if not isinstance(t, str) or not t.strip():
        out["type"] = "general"
    return out


def mops_industry_type_for_ticker(ticker: str, max_periods: int = 16) -> str:
    """自最近期別之 t163 快取讀取 ``type``（產業）；無則 ``general``。"""
    if not mops_adapter_enabled():
        return "general"
    for pl in quarter_end_labels_newest_first(max_periods):
        canon = str(pl).strip().split()[0]
        rs = period_label_to_roc_season(canon)
        if rs is None:
            continue
        row = _lookup_ticker_in_markets(ticker, rs[0], rs[1])
        if not row:
            continue
        t = row.get("type")
        if isinstance(t, str) and t.strip():
            return t.strip()
    return "general"


def _lookup_ticker_cache_only(
    ticker: str, roc_year: int, season: int,
) -> dict[str, Any] | None:
    """讀取既有快取（不觸發 HTTP）回傳 ticker 記錄；無則 None。"""
    tid = _norm_ticker_cell(ticker)
    for typek in ("sii", "otc"):
        merged = _load_all_industry_caches(typek, roc_year, season)
        row = merged.get(tid)
        if row and any(row.get(k) is not None for k in _T163_CACHE_METRIC_KEYS):
            return dict(row)
    return None


def backfill_annual_nulls_from_mops_q4(
    ticker: str,
    annual_periods: list[str],
    annual_series: dict[str, list[float | None]],
) -> None:
    """
    年度表缺值回填：從 MOPS t163 快取的 **Q4 YTD 累計值** 填入。

    Q4 累計即全年值（t163 為同曆年內 YTD），只讀既有快取不觸發 HTTP。
    就地修改 *annual_series*；回填後呼叫端須自行重算 margin。
    """
    if not mops_adapter_enabled():
        return

    BACKFILL_KEYS = _SERIES_ORDER

    for i, period in enumerate(annual_periods):
        m = re.match(r"^(\d{4})-12-31", str(period).strip())
        if not m:
            continue
        western_year = int(m.group(1))
        roc_year = western_year - 1911

        needs = any(
            key in annual_series
            and i < len(annual_series[key])
            and annual_series[key][i] is None
            for key in BACKFILL_KEYS
        )
        if not needs:
            continue

        row = _lookup_ticker_cache_only(ticker, roc_year, season=4)
        row6 = _lookup_ticker_cache_only_sb06(ticker, roc_year, season=4)
        row20 = _lookup_ticker_cache_only_sb20(ticker, roc_year, season=4)
        if not row and not row6 and not row20:
            continue

        for key in BACKFILL_KEYS:
            if key not in annual_series:
                continue
            if i >= len(annual_series[key]):
                continue
            if annual_series[key][i] is not None:
                continue
            v = None
            rev6 = (
                _sb06_metric_float(row6.get("Revenue"))
                if row6
                else None
            )
            gm6 = (
                _sb06_metric_float(row6.get("Gross Margin (%)"))
                if row6
                else None
            )
            om6 = (
                _sb06_metric_float(row6.get("Operating Margin (%)"))
                if row6
                else None
            )
            nm6 = (
                _sb06_metric_float(row6.get("Net Margin (%)"))
                if row6
                else None
            )

            if key == "Net Income":
                if row:
                    vv = row.get(key)
                    if vv is not None and not (isinstance(vv, float) and pd.isna(vv)):
                        v = float(vv)
                if v is None and rev6 is not None and nm6 is not None:
                    v = round(rev6 * nm6 / 100.0, 2)
            elif key == "Revenue":
                if row:
                    vv = row.get(key)
                    if vv is not None and not (isinstance(vv, float) and pd.isna(vv)):
                        v = float(vv)
                if v is None and rev6 is not None:
                    v = rev6
            elif key == "Cost of Revenue":
                if row:
                    vv = row.get(key)
                    if vv is not None and not (isinstance(vv, float) and pd.isna(vv)):
                        v = float(vv)
            elif key == "Gross Profit":
                if row:
                    vv = row.get(key)
                    if vv is not None and not (isinstance(vv, float) and pd.isna(vv)):
                        v = float(vv)
                if v is None and rev6 is not None and gm6 is not None:
                    v = round(rev6 * gm6 / 100.0, 2)
            elif key == "Operating Income":
                if row:
                    vv = row.get(key)
                    if vv is not None and not (isinstance(vv, float) and pd.isna(vv)):
                        v = float(vv)
                if v is None and rev6 is not None and om6 is not None:
                    v = round(rev6 * om6 / 100.0, 2)
            elif key in _SB20_CACHE_KEYS:
                if row20:
                    vv = row20.get(key)
                    if vv is not None and not (isinstance(vv, float) and pd.isna(vv)):
                        v = float(vv)
            elif row:
                vv = row.get(key)
                if vv is not None and not (isinstance(vv, float) and pd.isna(vv)):
                    v = float(vv)
            if v is not None:
                annual_series[key][i] = float(v)


def ensure_mops_market_cache_for_period_labels(period_labels: Iterable[str]) -> None:
    """
    對每個日曆季末預先載入或下載 sii + otc 全市場快取（t163sb04 + t163sb06 + t163sb20）。
    已滿 **publish lag**（見 ``mops_publish_lag_allows_http``）才會發 HTTP；其餘僅讀既有快取。
    """
    if not mops_adapter_enabled():
        return
    seen: set[tuple[int, int]] = set()
    for pl in period_labels:
        canon = str(pl).strip().split()[0]
        rs = period_label_to_roc_season(canon)
        if rs is None:
            continue
        if rs in seen:
            continue
        seen.add(rs)
        roc_y, se = rs
        for typek in ("sii", "otc"):
            _load_or_fetch_season_data(typek, roc_y, se)
            _load_or_fetch_season_sb06(typek, roc_y, se)
            _load_or_fetch_season_sb20(typek, roc_y, se)


def build_mops_market_core_quarterly_dataframe(
    ticker: str, period_labels: list[str]
) -> pd.DataFrame:
    """
    第一層：自 **t163sb06＋t163sb04＋t163sb20** 合併快取組出單一公司
    **Revenue … EPS**、三項 Margin（百萬／％）及 **Op／Investing／Financing CF**（百萬）。
    一般業 **Revenue／COR／GP／OI** 優先 sb04 精確金額，缺時 Revenue／GP／OI 再以 sb06 反算；Margin％ 取自 sb06。原始為曆年 YTD，
    於 ``_build_quarterly_block_for_ticker`` 已反累計為**單季**。
    若 MOPS 關閉或無資料則回傳空 ``DataFrame``。
    """
    if not mops_adapter_enabled() or not period_labels:
        return pd.DataFrame()
    ensure_mops_market_cache_for_period_labels(period_labels)
    blk = _build_quarterly_block_for_ticker(ticker, period_labels)
    if not blk:
        return pd.DataFrame()
    full = supplement_block_to_dataframe(blk)
    if full.empty:
        return pd.DataFrame()
    rows = [r for r in _MOPS_CSV_CORE_ROWS if r in full.index]
    if not rows:
        return pd.DataFrame()
    df = full.loc[rows].copy()
    df = coalesce_period_columns(df)
    df = df[sorted(df.columns.astype(str), key=str, reverse=True)]
    if "Revenue" in df.index and "Gross Profit" in df.index:
        rev = df.loc["Revenue"]
        gp = df.loc["Gross Profit"]
        gpm = (gp / rev * 100.0).where(gp.notna() & rev.notna())
        df.loc["Gross Margin (%)"] = gpm.replace(
            [float("inf"), float("-inf")], float("nan")
        )
    if "Revenue" in df.index and "Operating Income" in df.index:
        rev = df.loc["Revenue"]
        oi = df.loc["Operating Income"]
        om = (oi / rev * 100.0).where(oi.notna() & rev.notna())
        df.loc["Operating Margin (%)"] = om.replace(
            [float("inf"), float("-inf")], float("nan")
        )
    if "Revenue" in df.index and "Net Income" in df.index:
        rev = df.loc["Revenue"]
        ni = df.loc["Net Income"]
        nm = (ni / rev * 100.0).where(ni.notna() & rev.notna())
        df.loc["Net Margin (%)"] = nm.replace(
            [float("inf"), float("-inf")], float("nan")
        )
    return sort_financial_statement_rows(df)


_SERIES_ORDER = (
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
)


def _western_year_season_from_period_label(period: str) -> tuple[int, int] | None:
    """``YYYY-MM-DD`` 季末 → (西元年, 季 1–4)；非標準季末則 None。"""
    s = str(period).strip().split()[0]
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", s)
    if not m:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    se = _QUARTER_END_TO_SEASON.get((mo, d))
    if se is None:
        return None
    return (y, se)


def _mops_t163_value_is_blank(v: float | None) -> bool:
    return v is None or (isinstance(v, float) and pd.isna(v))


def _decumulate_mops_t163_ytd_in_block(
    periods: list[str], series: dict[str, list[float | None]]
) -> None:
    """
    MOPS t163 全市場表為**同一曆年內** YTD：Q1＝單季，Q2＝Q1＋Q2…
    就地改為單季：Qn 單季＝Qn 累計 − Q(n−1) 累計（以**原始**累計相減）。

    若缺同曆年上一季之欄位，或任一端為 null，則該季改為 None（不寫不完整差分）。
    適用 ``_SERIES_ORDER`` 內所有自 t163（損益＋現金流）讀入之金額／EPS 欄。
    """
    if not periods:
        return
    n = len(periods)
    year_to_season_index: dict[int, dict[int, int]] = {}
    for i, p in enumerate(periods):
        ys = _western_year_season_from_period_label(p)
        if ys is None:
            continue
        y, se = ys
        year_to_season_index.setdefault(y, {})[se] = i

    for sk in _SERIES_ORDER:
        if sk not in series or len(series[sk]) != n:
            continue
        orig = list(series[sk])
        for _y, qmap in year_to_season_index.items():
            for q in (1, 2, 3, 4):
                i = qmap.get(q)
                if i is None:
                    continue
                if q == 1:
                    if _mops_t163_value_is_blank(orig[i]):
                        series[sk][i] = None
                    else:
                        series[sk][i] = round(float(orig[i]), 2)
                    continue
                j = qmap.get(q - 1)
                if j is None:
                    series[sk][i] = None
                    continue
                a, b = orig[i], orig[j]
                if _mops_t163_value_is_blank(a) or _mops_t163_value_is_blank(b):
                    series[sk][i] = None
                else:
                    series[sk][i] = round(float(a) - float(b), 2)


def _build_quarterly_block_for_ticker(
    ticker: str, period_labels: list[str]
) -> dict[str, Any] | None:
    """依期別列表自 MOPS 組出 quarterly supplement block。"""
    periods_out: list[str] = []
    series_accum: dict[str, list[float | None]] = {k: [] for k in _SERIES_ORDER}

    for pl in period_labels:
        canon = str(pl).strip().split()[0]
        rs = period_label_to_roc_season(canon)
        if rs is None:
            return None
        roc_y, se = rs
        row = _lookup_ticker_in_markets(ticker, roc_y, se)
        periods_out.append(canon)
        if not row:
            for k in _SERIES_ORDER:
                series_accum[k].append(None)
            continue
        for k in _SERIES_ORDER:
            v = row.get(k)
            if v is not None and pd.notna(v):
                series_accum[k].append(round(float(v), 2))
            else:
                series_accum[k].append(None)

    if not periods_out:
        return None
    _decumulate_mops_t163_ytd_in_block(periods_out, series_accum)
    return {"periods": periods_out, "series": series_accum}


def quarter_end_labels_newest_first(n: int) -> list[str]:
    """已完成日曆季末 ``YYYY-MM-DD``，由新→舊（與季表欄位順序一致）。"""
    d = _previous_quarter_end(date.today())
    out: list[str] = []
    for _ in range(max(1, n)):
        out.append(f"{d.year}-{d.month:02d}-{d.day:02d}")
        d = _walk_quarter_end_back(d)
    return out


def mops_quarterly_premerge_dataframe(ticker: str, num_quarters: int) -> pd.DataFrame | None:
    """
    僅自 MOPS 全市場 t163 組出單一公司損益核心＋推算 margin（百萬台幣／％），尚未 ``dropna`` 欄截取。
    供 Yahoo／FinMind 皆無法接上時的唯 MOPS 回退。
    """
    if not mops_adapter_enabled():
        return None
    pl = quarter_end_labels_newest_first(num_quarters)
    df = build_mops_market_core_quarterly_dataframe(ticker, pl)
    if df.empty:
        return None
    df = backfill_margin_percentages(df)
    return df


def fetch_mops_supplement_blocks(
    ticker: str,
    period_labels: list[str] | None = None,
) -> dict[str, Any] | None:
    """
    回傳與 ``financial_supplement`` 相同結構的 dict；目前僅填 ``quarterly``（年度由既有管線處理）。

    Parameters
    ----------
    ticker
        股票代號（不含 .TW）。
    period_labels
        須與合併後季表欄位一致的 ``YYYY-MM-DD`` 列表；None 時不建議呼叫（由 merge 函式傳入）。
    """
    if not mops_adapter_enabled():
        return None
    if not period_labels:
        return None
    q = _build_quarterly_block_for_ticker(ticker, period_labels)
    if not q or not q.get("periods"):
        return None
    return {"quarterly": q, "annual": None}


def maybe_fill_quarterly_from_mops(df: pd.DataFrame, ticker: str) -> pd.DataFrame:
    """
    第四層：**t164sb04** 補 Selling／R&D／G&A；**t164sb05** 補 **CAPEX**（列名須含不動產＋廠房＋設備）。
    僅對仍有 null 之季別發請求（同一季可各打一次 sb04／sb05），受 ``MYTWSTOCK_MOPS_T164_MAX_QUARTERS`` 限制（預設最多 32 季），
    且須通過 ``mops_publish_lag_allows_http``（與 t163 相同之季末／公告 lag）。
    **只填 null**；CAPEX 以負值百萬台幣儲存（流出）。
    """
    if not mops_adapter_enabled() or df is None or df.empty:
        return df

    df2 = coalesce_period_columns(df.copy())
    periods_with_holes: set[str] = set()
    for col in df2.columns:
        lab = canonical_period_label(col)
        if period_label_to_roc_season(lab) is None:
            continue
        need = False
        for m in _MOPS_T164_EXPENSE_ROWS:
            if m not in df2.index or pd.isna(df2.loc[m, col]):
                need = True
                break
        if not need and (
            _MOPS_T164_CAPEX_ROW not in df2.index
            or pd.isna(df2.loc[_MOPS_T164_CAPEX_ROW, col])
        ):
            need = True
        if need:
            periods_with_holes.add(lab)

    if not periods_with_holes:
        return df2

    def _dt_key(lab: str) -> datetime:
        m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", lab)
        if not m:
            return datetime.min
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))

    pl_sorted = sorted(periods_with_holes, key=_dt_key, reverse=True)
    pl_sorted = pl_sorted[: _mops_t164_max_expense_quarters()]

    tid = _norm_ticker_cell(ticker)
    if not tid:
        return df2

    for lab in pl_sorted:
        cols_here = _columns_matching_period(df2, lab)
        if not cols_here:
            continue
        need_expense = any(
            any(
                m not in df2.index or pd.isna(df2.loc[m, col])
                for m in _MOPS_T164_EXPENSE_ROWS
            )
            for col in cols_here
        )
        need_capex = any(
            _MOPS_T164_CAPEX_ROW not in df2.index
            or pd.isna(df2.loc[_MOPS_T164_CAPEX_ROW, col])
            for col in cols_here
        )

        if not need_expense and not need_capex:
            continue

        rs = period_label_to_roc_season(lab)
        if rs is None:
            continue
        roc_y, se = rs

        if not mops_publish_lag_allows_http(roc_y, se):
            _log_mops_skip_t164_publish_lag(tid, roc_y, se)
            continue

        if need_expense:
            try:
                html_inc = _http_post_mops_single_income(tid, roc_y, se)
            except requests.RequestException:
                html_inc = ""
            values = _parse_mops_single_company_income_html(html_inc) if html_inc else {}
            for col in cols_here:
                for m in _MOPS_T164_EXPENSE_ROWS:
                    newv = values.get(m)
                    if newv is None:
                        continue
                    if m in df2.index and pd.notna(df2.loc[m, col]):
                        continue
                    df2.loc[m, col] = newv

        if need_capex:
            try:
                html_cf = _http_post_mops_single_cashflow(tid, roc_y, se)
            except requests.RequestException:
                html_cf = ""
            capv = (
                _parse_mops_single_company_cashflow_html(html_cf) if html_cf else None
            )
            if capv is not None:
                for col in cols_here:
                    if (
                        _MOPS_T164_CAPEX_ROW in df2.index
                        and pd.notna(df2.loc[_MOPS_T164_CAPEX_ROW, col])
                    ):
                        continue
                    df2.loc[_MOPS_T164_CAPEX_ROW, col] = capv

    df2 = df2[sorted(df2.columns.astype(str), key=str, reverse=True)]
    df2 = backfill_margin_percentages(df2)
    df2 = sort_financial_statement_rows(df2)
    return df2


def prefetch_mops_market_cache(num_quarters: int = 20) -> None:
    """
    維護／首次建庫：自最近已完成季起往回抓 ``num_quarters`` 季 ×（上市＋上櫃）寫入 ``data/mops_cache/``。
    需 ``MYTWSTOCK_MOPS=1``；請求間隔遵守 ``MYTWSTOCK_MOPS_SLEEP_SEC``。
    尚未滿 ``MYTWSTOCK_MOPS_MIN_DAYS_AFTER_Q_END`` 之最近季會由 ``_load_or_fetch_season_data`` 略過 HTTP。
    """
    if not mops_adapter_enabled():
        return
    d = _previous_quarter_end(date.today())
    for _ in range(max(1, num_quarters)):
        roc = d.year - 1911
        se = _QUARTER_END_TO_SEASON[(d.month, d.day)]
        for typek in ("sii", "otc"):
            _load_or_fetch_season_data(typek, roc, se)
        d = _walk_quarter_end_back(d)


def prefetch_mops_sb06_cache(num_quarters: int = 32) -> None:
    """預熱 t163sb06 營益分析全市場快取（每季 sii+otc 各 1 請求）。"""
    if not mops_adapter_enabled():
        return
    d = _previous_quarter_end(date.today())
    for _ in range(max(1, num_quarters)):
        roc = d.year - 1911
        se = _QUARTER_END_TO_SEASON[(d.month, d.day)]
        n = 0
        for typek in ("sii", "otc"):
            bt = _load_or_fetch_season_sb06(typek, roc, se)
            n += len(bt)
            print(
                f"[sb06] {typek}_{roc}_{se}_t163sb06.json: {len(bt)} tickers",
                file=sys.stderr,
            )
        d = _walk_quarter_end_back(d)


def prefetch_mops_sb20_cache(num_quarters: int = 34) -> None:
    """預熱 t163sb20 現金流量全市場快取（每季 sii+otc 各 1 請求）。"""
    if not mops_adapter_enabled():
        return
    d = _previous_quarter_end(date.today())
    for _ in range(max(1, num_quarters)):
        roc = d.year - 1911
        se = _QUARTER_END_TO_SEASON[(d.month, d.day)]
        for typek in ("sii", "otc"):
            bt = _load_or_fetch_season_sb20(typek, roc, se)
            print(
                f"[sb20] {typek}_{roc}_{se}_t163sb20.json: {len(bt)} tickers",
                file=sys.stderr,
            )
        d = _walk_quarter_end_back(d)


def prefetch_mops_all_caches(num_quarters: int = 32) -> None:
    """預熱 t163sb04 + t163sb06 + t163sb20。"""
    prefetch_mops_market_cache(num_quarters)
    prefetch_mops_sb06_cache(num_quarters)
    prefetch_mops_sb20_cache(num_quarters)


if __name__ == "__main__":
    if not mops_adapter_enabled():
        raise SystemExit("Set MYTWSTOCK_MOPS=1 before running prefetch.")
    cmd = (sys.argv[1] if len(sys.argv) > 1 else "prefetch_sb04").strip().lower()
    nq = int(sys.argv[2]) if len(sys.argv) > 2 else 32
    if cmd in ("prefetch_sb04", "sb04"):
        prefetch_mops_market_cache(nq)
        print(f"MOPS t163sb04 cache warmed: {nq} quarters × (sii + otc).")
    elif cmd in ("prefetch_sb06", "sb06"):
        prefetch_mops_sb06_cache(nq)
        print(f"MOPS t163sb06 cache warmed: {nq} quarters × (sii + otc).")
    elif cmd in ("prefetch_sb20", "sb20"):
        prefetch_mops_sb20_cache(nq)
        print(f"MOPS t163sb20 cache warmed: {nq} quarters × (sii + otc).")
    elif cmd in ("prefetch_all", "all"):
        prefetch_mops_all_caches(nq)
        print(
            f"MOPS t163sb04 + t163sb06 + t163sb20 cache warmed: "
            f"{nq} quarters × (sii + otc)."
        )
    else:
        # 向後相容：僅一個數字參數時視為 sb04 季數
        if len(sys.argv) >= 2 and sys.argv[1].isdigit():
            nq = int(sys.argv[1])
            prefetch_mops_market_cache(nq)
            print(f"MOPS cache warmed (sb04 only): {nq} quarters × (sii + otc).")
        else:
            raise SystemExit(
                "Usage: python scripts/mops_financials.py prefetch_sb04 [N]\n"
                "       python scripts/mops_financials.py prefetch_sb06 [N]\n"
                "       python scripts/mops_financials.py prefetch_sb20 [N]\n"
                "       python scripts/mops_financials.py prefetch_all [N]\n"
                "       python scripts/mops_financials.py [N]   # legacy: sb04 only"
            )
