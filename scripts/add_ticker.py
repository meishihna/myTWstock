"""
add_ticker.py — Generate a new ticker report with financials and base structure.

Creates a new .md file under Pilot_Reports/{sector}/ with:
- Title with wikilinked company name
- Metadata (sector, industry, market cap, enterprise value)
- Placeholder sections for enrichment (業務簡介, 供應鏈, 客戶供應商)
- Financial tables from yfinance (annual 3yr + quarterly 4Q)

Usage:
  python scripts/add_ticker.py 2330 台積電                    # Auto-detect sector
  python scripts/add_ticker.py 2330 台積電 --sector Semiconductors  # Specify sector
  python scripts/add_ticker.py --from-excel                   # Add all missing tickers from Excel

After generating, use /update-enrichment to add business descriptions.
"""

import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from utils import find_ticker_files, REPORTS_DIR, PROJECT_ROOT

# Import financials fetcher
from update_financials import fetch_financials, build_financial_section


def generate_report(ticker, name, sector=None, industry=None):
    """Generate a complete report file for a new ticker."""
    # Fetch financial data (also gives us sector/industry if not specified)
    fin_data = fetch_financials(ticker)

    if fin_data:
        if not sector:
            sector = fin_data.get("sector", "Unknown")
        if not industry:
            industry = fin_data.get("industry", "Unknown")
        market_cap = fin_data.get("market_cap", "N/A")
        enterprise_value = fin_data.get("enterprise_value", "N/A")
        fin_section = build_financial_section(fin_data)
    else:
        if not sector:
            sector = "Unknown"
        if not industry:
            industry = "Unknown"
        market_cap = "N/A"
        enterprise_value = "N/A"
        fin_section = (
            "## 財務概況 (單位: 百萬台幣, 只有 Margin 為 %)\n"
            "### 年度關鍵財務數據 (近 3 年)\n無可用數據。\n\n"
            "### 季度關鍵財務數據 (近 4 季)\n無可用數據。\n"
        )

    content = f"""# {ticker} - [[{name}]]

## 業務簡介
**板塊:** {sector}
**產業:** {industry}
**市值:** {market_cap} 百萬台幣
**企業價值:** {enterprise_value} 百萬台幣

*(待enrichment — 請使用 /update-enrichment 補充業務描述)*

## 供應鏈位置
*(待enrichment)*

## 主要客戶及供應商
*(待enrichment)*

{fin_section}"""

    return content, sector


def sanitize_folder_name(name):
    """Clean up sector name for use as folder name."""
    # Replace characters that are problematic in Windows paths
    return re.sub(r'[<>:"/\\|?*]', "", name).strip()


def main():
    if sys.platform == "win32":
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    args = sys.argv[1:]

    if not args:
        print("Usage:")
        print("  python scripts/add_ticker.py <ticker> <name>")
        print("  python scripts/add_ticker.py <ticker> <name> --sector <sector>")
        print("  python scripts/add_ticker.py --from-excel")
        return

    if args[0] == "--from-excel":
        add_from_excel()
        return

    # Parse arguments
    ticker = args[0]
    name = args[1] if len(args) > 1 else "Unknown"

    sector = None
    if "--sector" in args:
        idx = args.index("--sector")
        sector = " ".join(args[idx + 1 :])

    # Check if ticker already exists
    existing = find_ticker_files([ticker])
    if existing:
        print(f"Ticker {ticker} already exists at: {existing[ticker]}")
        print("Use /update-financials or /update-enrichment to update it.")
        return

    print(f"Generating report for {ticker} ({name})...")
    content, detected_sector = generate_report(ticker, name, sector)

    # Determine output folder
    folder_name = sanitize_folder_name(sector or detected_sector)
    output_dir = os.path.join(REPORTS_DIR, folder_name)
    os.makedirs(output_dir, exist_ok=True)

    # Write file
    filename = f"{ticker}_{name}.md"
    filepath = os.path.join(output_dir, filename)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)

    print(f"Created: {filepath}")
    print(f"Sector: {folder_name}")
    print(f"\nNext: use /update-enrichment to add business description, supply chain, and customers.")


def add_from_excel():
    """Add all tickers from Excel that don't have report files yet."""
    try:
        import pandas as pd
    except ImportError:
        print("pandas required. Install: pip install pandas openpyxl")
        return

    excel_path = os.path.join(PROJECT_ROOT, "data", "Taiwan Stock Coverage.xlsx")
    if not os.path.exists(excel_path):
        print(f"Excel file not found: {excel_path}")
        return

    df = pd.read_excel(excel_path, header=None)
    existing = find_ticker_files()

    missing = []
    for _, row in df.iterrows():
        ticker = str(row[0]).strip()
        name = str(row[1]).strip() if pd.notna(row[1]) else "Unknown"
        if re.match(r"^\d{4}$", ticker) and ticker not in existing:
            missing.append((ticker, name))

    if not missing:
        print("All tickers from Excel already have report files.")
        return

    print(f"Found {len(missing)} missing tickers. Generating reports...\n")

    created = failed = 0
    for ticker, name in missing:
        try:
            content, sector = generate_report(ticker, name)
            folder_name = sanitize_folder_name(sector)
            output_dir = os.path.join(REPORTS_DIR, folder_name)
            os.makedirs(output_dir, exist_ok=True)

            filepath = os.path.join(output_dir, f"{ticker}_{name}.md")
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(content)
            print(f"  {ticker} ({name}): CREATED in {folder_name}/")
            created += 1
        except Exception as e:
            print(f"  {ticker} ({name}): FAILED ({e})")
            failed += 1

        time.sleep(0.5)

    print(f"\nDone. Created: {created} | Failed: {failed}")


if __name__ == "__main__":
    main()
