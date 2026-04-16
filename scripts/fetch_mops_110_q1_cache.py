"""One-off: fetch MOPS t163 cache for ROC 110 season 1 (sii + otc)."""
from __future__ import annotations

import os
import sys

# project root parent of scripts/
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, os.path.join(ROOT, "scripts"))

os.environ.setdefault("MYTWSTOCK_MOPS", "1")
os.environ.setdefault("MYTWSTOCK_MOPS_INSECURE_SSL", "1")

from mops_financials import (  # noqa: E402
    _cache_path,
    _load_or_fetch_season_data,
    _ALL_INDUSTRY_SUFFIXES,
)


def main() -> None:
    for typek in ("sii", "otc"):
        data = _load_or_fetch_season_data(typek, 110, 1)
        total_sz = 0
        for suffix in _ALL_INDUSTRY_SUFFIXES:
            p = _cache_path(typek, 110, 1, suffix)
            if os.path.isfile(p):
                total_sz += os.path.getsize(p)
        print(f"{typek}_110_1: tickers={len(data)} total_bytes={total_sz}")


if __name__ == "__main__":
    main()
