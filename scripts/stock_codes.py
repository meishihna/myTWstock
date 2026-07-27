"""
stock_codes.py — 讀 data/stock_codes.json,提供「代碼 → Yahoo 後綴嘗試順序」。

讓抓 Yahoo 前直接選對後綴(上市 .TW / 上櫃 .TWO),省掉上櫃股先撞 .TW 失敗的無效請求。
未收錄代碼(興櫃/ETF/新掛牌)回預設順序,仍雙試 → 不退化。
對照表由 scripts/build_stock_codes.py 產生。
"""

from __future__ import annotations

import functools
import json
import os

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_PATH = os.path.join(_ROOT, "data", "stock_codes.json")


@functools.lru_cache(maxsize=1)
def _codes() -> dict:
    try:
        with open(_PATH, encoding="utf-8") as f:
            return json.load(f).get("codes", {}) or {}
    except (OSError, ValueError):
        return {}


def preferred_suffix(ticker: str) -> str | None:
    s = _codes().get(str(ticker), {}).get("suffix")
    return s if s in (".TW", ".TWO") else None


def suffix_order(ticker: str) -> tuple[str, str]:
    """已知上櫃 → ('.TWO','.TW');其餘(上市/未知)→ ('.TW','.TWO')。一律保留雙試備援。"""
    return (".TWO", ".TW") if preferred_suffix(ticker) == ".TWO" else (".TW", ".TWO")
