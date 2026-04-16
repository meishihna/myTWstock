"""
update_valuation.py — Refresh 報告抬頭 **市值／企業價值** metadata，並自 MD 移除舊的 ``### 估值指標`` 表。

倍數與股價已改由網頁 **ValuationSection** + financials JSON 顯示，內文不再保留重複的估值 Markdown 表。
仍使用 Yahoo ``stock.info``（與舊版相同節奏），僅寫入 ``**市值:**``／``**企業價值:**`` 行。

Usage:
  python scripts/update_valuation.py                     # ALL tickers
  python scripts/update_valuation.py 2330                # Single ticker
  python scripts/update_valuation.py 2330 2317 3034      # Multiple tickers
  python scripts/update_valuation.py --batch 101         # By batch
  python scripts/update_valuation.py --sector Semiconductors  # By sector
  python scripts/update_valuation.py --dry-run 2330      # Preview without writing
"""

import os
import re
import sys
import time

import yfinance as yf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from utils import (
    find_ticker_files,
    parse_scope_args,
    setup_stdout,
    update_metadata,
)


def fetch_valuation(ticker):
    """Fetch market cap / enterprise value from Yahoo. Tries .TW then .TWO."""
    for suffix in [".TW", ".TWO"]:
        try:
            stock = yf.Ticker(f"{ticker}{suffix}")
            info = stock.info
            if not info or not info.get("currentPrice"):
                continue

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

            return {
                "market_cap": market_cap,
                "enterprise_value": enterprise_value,
                "suffix": suffix,
            }
        except Exception:
            continue
    return None


def update_file(filepath, ticker, dry_run=False):
    """Strip legacy 估值指標 MD 表並更新抬頭市值／企業價值。"""
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    data = fetch_valuation(ticker)
    if data is None:
        print(f"  {ticker}: SKIP (no data)")
        return False

    # 內文不再維護估值表（與報告頁元件重複）；僅清除舊版 MD 區塊
    if "### 估值指標" in content:
        content = re.sub(
            r"### 估值指標.*?(?=\n### 年度)",
            "",
            content,
            flags=re.DOTALL,
        )

    content = update_metadata(content, data.get("market_cap"), data.get("enterprise_value"))

    if dry_run:
        print(f"  {ticker}: WOULD UPDATE ({data['suffix']})")
        return True

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"  {ticker}: UPDATED ({data['suffix']})")
    return True


def main():
    setup_stdout()

    args = list(sys.argv[1:])
    dry_run = "--dry-run" in args
    if dry_run:
        args.remove("--dry-run")

    tickers, sector, desc = parse_scope_args(args)
    print(f"Updating valuation for {desc}...")
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
        time.sleep(0.3)

    print(f"\nDone. Updated: {updated} | Skipped: {skipped} | Failed: {failed}")


if __name__ == "__main__":
    main()
