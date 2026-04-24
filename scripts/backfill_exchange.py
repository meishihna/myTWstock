"""
backfill_exchange.py

從 TWSE ISIN 系統抓取「上市 / 上櫃 / 興櫃」清單，
補寫 data/financials_store/*.json 的 exchange 欄位。

exchange 欄位值：
- "TWSE"     → 上市（strMode=2）
- "TPEx"     → 上櫃（strMode=4）
- "Emerging" → 興櫃（strMode=5）
- 不在清單中：不寫入（不新增欄位；不覆寫既有值）

用法：
    python scripts/backfill_exchange.py           # 預設跑全市場
    python scripts/backfill_exchange.py --dry-run # 只顯示會改的檔，不寫入
    python scripts/backfill_exchange.py 2330 1101 # 只處理指定 ticker

依賴：pip install requests beautifulsoup4

執行時間：~30 秒（只打 3 次 HTTP，主要成本是寫檔）
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
import time
import warnings
from datetime import datetime, timezone
from typing import Dict, Set

import requests
from bs4 import BeautifulSoup
from urllib3.exceptions import InsecureRequestWarning

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FINANCIALS_DIR = os.path.join(PROJECT_ROOT, "data", "financials_store")
NOT_IN_ISIN_PATH = os.path.join(PROJECT_ROOT, "data", "_not_in_isin.txt")

TWSE_ISIN_URLS: Dict[str, str] = {
    "TWSE": "https://isin.twse.com.tw/isin/C_public.jsp?strMode=2",
    "TPEx": "https://isin.twse.com.tw/isin/C_public.jsp?strMode=4",
    "Emerging": "https://isin.twse.com.tw/isin/C_public.jsp?strMode=5",
}


def fetch_tickers_from_isin(url: str, exchange: str) -> Set[str]:
    """抓取 TWSE ISIN 頁面，解析出所有 4–6 碼純數字代號。"""
    # TWSE 政府網站憑證缺 Subject Key Identifier，Python requests 預設會擋；
    # 設 MYTWSTOCK_TWSE_INSECURE_SSL=1 可跳過驗證（與 MOPS 做法一致）。
    insecure = os.environ.get("MYTWSTOCK_TWSE_INSECURE_SSL", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    verify = not insecure
    if insecure:
        warnings.simplefilter("ignore", InsecureRequestWarning)

    print(f"  Fetching {exchange} from {url} ...", end=" ", flush=True)
    try:
        resp = requests.get(
            url,
            timeout=30,
            headers={"User-Agent": "Mozilla/5.0"},
            verify=verify,
        )
        resp.encoding = "big5"
    except Exception as e:
        print(f"FAILED: {e}")
        return set()

    if resp.status_code != 200:
        print(f"FAILED: HTTP {resp.status_code}")
        return set()

    soup = BeautifulSoup(resp.text, "html.parser")
    tables = soup.find_all("table", {"class": "h4"})
    if not tables:
        tables = soup.find_all("table")

    tickers: Set[str] = set()
    for table in tables:
        for row in table.find_all("tr"):
            cells = row.find_all("td")
            if not cells:
                continue
            first_cell = cells[0].get_text(strip=True)
            m = re.match(r"^(\d{4,6})\s", first_cell)
            if m:
                tickers.add(m.group(1))

    print(f"OK ({len(tickers)} tickers)")
    return tickers


def build_ticker_to_exchange_map() -> Dict[str, str]:
    """抓三份 ISIN 清單，回傳 ticker → exchange 對應表。"""
    mapping: Dict[str, str] = {}
    print("Fetching TWSE ISIN lists ...")
    for exchange, url in TWSE_ISIN_URLS.items():
        tickers = fetch_tickers_from_isin(url, exchange)
        for tk in tickers:
            mapping[tk] = exchange
        time.sleep(1)
    print(f"Total: {len(mapping)} tickers mapped")
    return mapping


def update_json_file(path: str, exchange: str, dry_run: bool = False) -> str:
    """更新單一 JSON 的 exchange 欄位。回傳狀態字串。"""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            d = json.load(fh)
    except Exception as e:
        return f"READ_ERROR: {e}"

    if not isinstance(d, dict):
        return "READ_ERROR: root is not an object"

    old_exchange = d.get("exchange")
    if old_exchange == exchange:
        return "NO_CHANGE"

    d["exchange"] = exchange
    d["updatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    if dry_run:
        return f"WOULD_UPDATE: {old_exchange!r} → {exchange}"

    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(d, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except OSError:
        if os.path.isfile(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass
        raise

    return f"UPDATED: {old_exchange!r} → {exchange}"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Backfill exchange (TWSE/TPEx/Emerging) from TWSE ISIN pages.",
    )
    parser.add_argument(
        "tickers",
        nargs="*",
        help="限制處理的 ticker；不給則跑全市場",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只顯示會改的檔，不真正寫入",
    )
    args = parser.parse_args()

    ssl_insecure = os.environ.get("MYTWSTOCK_TWSE_INSECURE_SSL", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    if ssl_insecure:
        print("MYTWSTOCK_TWSE_INSECURE_SSL=1: 已停用 TWSE SSL 憑證驗證")
    else:
        print("若遇 SSL 憑證錯誤，可設 MYTWSTOCK_TWSE_INSECURE_SSL=1 跳過驗證")
    print()

    mapping = build_ticker_to_exchange_map()
    if not mapping:
        print("無法取得任何 ISIN 資料，中止。")
        sys.exit(1)

    if args.tickers:
        files = [
            os.path.join(FINANCIALS_DIR, f"{tk}.json")
            for tk in args.tickers
            if os.path.isfile(os.path.join(FINANCIALS_DIR, f"{tk}.json"))
        ]
    else:
        files = sorted(glob.glob(os.path.join(FINANCIALS_DIR, "*.json")))

    stats: dict = {
        "total": 0,
        "updated": {"TWSE": 0, "TPEx": 0, "Emerging": 0},
        "no_change": 0,
        "not_in_isin": [],
        "errors": [],
    }

    for f in files:
        stats["total"] += 1
        tk = os.path.splitext(os.path.basename(f))[0]
        if tk.startswith("."):
            continue

        exchange = mapping.get(tk)
        if not exchange:
            stats["not_in_isin"].append(tk)
            continue

        result = update_json_file(f, exchange, dry_run=args.dry_run)
        if result.startswith("UPDATED") or result.startswith("WOULD_UPDATE"):
            stats["updated"][exchange] += 1
        elif result == "NO_CHANGE":
            stats["no_change"] += 1
        else:
            stats["errors"].append((tk, result))

    print()
    print("=== 完成 ===")
    print(f"  總檔案: {stats['total']}")
    print("  已寫入 exchange（或 WOULD_UPDATE）:")
    for ex, n in stats["updated"].items():
        print(f"    {ex}: {n}")
    print(f"  已是正確值（跳過）: {stats['no_change']}")
    print(f"  不在 ISIN 清單中（可能下市或特殊）: {len(stats['not_in_isin'])}")
    print(f"  錯誤: {len(stats['errors'])}")

    if stats["not_in_isin"]:
        os.makedirs(os.path.dirname(NOT_IN_ISIN_PATH), exist_ok=True)
        with open(NOT_IN_ISIN_PATH, "w", encoding="utf-8") as fh:
            fh.write("\n".join(sorted(stats["not_in_isin"])))
        top = sorted(stats["not_in_isin"])[:20]
        print(f"\n  不在 ISIN 清單：前 20 檔: {top}")
        print(f"  完整清單已寫入 {NOT_IN_ISIN_PATH}")

    if stats["errors"]:
        print("\n  前 10 個錯誤：")
        for tke, err in stats["errors"][:10]:
            print(f"    {tke}: {err}")

    if args.dry_run:
        print("\n  [DRY RUN] 未實際寫入。移除 --dry-run 以真正執行。")


if __name__ == "__main__":
    main()
