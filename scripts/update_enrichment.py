"""
update_enrichment.py — Update enrichment content (desc, supply chain, customers)
in ticker reports. Preserves financial tables.

This script applies enrichment data from a JSON file or inline DATA dict
to ticker report files. It replaces 業務簡介, 供應鏈位置, and 主要客戶及供應商
sections while preserving metadata and 財務概況.

Usage:
  python scripts/update_enrichment.py --data enrichment.json          # From JSON file
  python scripts/update_enrichment.py --data enrichment.json 2330     # Single ticker from JSON
  python scripts/update_enrichment.py --data enrichment.json --batch 101
  python scripts/update_enrichment.py --data enrichment.json --sector Semiconductors

JSON format:
{
  "2330": {
    "desc": "Traditional Chinese description with [[wikilinks]]...",
    "supply_chain": "**上游:**\\n- ...\\n**中游:**\\n- ...\\n**下游:**\\n- ...",
    "cust": "### 主要客戶\\n- ...\\n\\n### 主要供應商\\n- ...",
    "revenue_mix": {
      "year": "2025",
      "segments": [
        {"name": "高效能運算", "pct": 53},
        {"name": "智慧型手機", "pct": 30}
      ],
      "geo": "北美約 68%、亞太約 13%"
    }
  }
}

若含 revenue_mix，會合併寫入 data/enrichment_store/{ticker}.json（供報告頁讀取條狀圖）。

When called by Claude via /update-enrichment skill, Claude:
1. Researches tickers via web search
2. Writes enrichment.json
3. Runs this script
"""

import os
import re
import sys
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from utils import find_ticker_files, parse_scope_args, PROJECT_ROOT, normalize_wikilinks


def merge_enrichment_store(ticker, data):
    """Persist revenue_mix into data/enrichment_store/{ticker}.json."""
    if "revenue_mix" not in data or data["revenue_mix"] is None:
        return
    store_dir = os.path.join(PROJECT_ROOT, "data", "enrichment_store")
    os.makedirs(store_dir, exist_ok=True)
    out_path = os.path.join(store_dir, f"{ticker}.json")
    merged = {}
    if os.path.isfile(out_path):
        try:
            with open(out_path, "r", encoding="utf-8") as f:
                merged = json.load(f)
        except (json.JSONDecodeError, OSError):
            merged = {}
    merged["revenue_mix"] = data["revenue_mix"]
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False, indent=2)


def apply_enrichment(filepath, ticker, data):
    """Apply enrichment data to a single file. Preserves metadata and financials."""
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    # Add metadata block if missing
    if "**板塊:**" not in content and "**市值:**" not in content:
        sector = data.get("sector", "N/A")
        industry = data.get("industry", "N/A")
        meta = f"**板塊:** {sector}\n**產業:** {industry}\n**市值:** N/A 百萬台幣\n**企業價值:** N/A 百萬台幣\n\n"
        content = content.replace("## 業務簡介\n", "## 業務簡介\n" + meta, 1)

    # Replace business description (preserve metadata block above it)
    if "desc" in data:
        def repl_desc(m):
            return f"{m.group(1)}{data['desc']}\n"
        content = re.sub(
            r"(## 業務簡介\n(?:.*?企業價值:.*?\n\n|))(.*?)(?=\n## 供應鏈位置)",
            repl_desc,
            content,
            flags=re.DOTALL,
        )

    # Replace supply chain section
    if "supply_chain" in data:
        sc = data["supply_chain"] + "\n"
        content = re.sub(
            r"(## 供應鏈位置\n)(.*?)(?=\n## 主要客戶及供應商)",
            rf"\g<1>{sc}",
            content,
            flags=re.DOTALL,
        )

    # Replace customers/suppliers section
    if "cust" in data:
        ct = data["cust"] + "\n"
        content = re.sub(
            r"(## 主要客戶及供應商\n)(.*?)(?=\n## 財務概況)",
            rf"\g<1>{ct}",
            content,
            flags=re.DOTALL,
        )

    # Normalize wikilinks: standardize aliases, collapse duplicates
    content = normalize_wikilinks(content)

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)

    merge_enrichment_store(ticker, data)

    try:
        print(f"  {ticker}: ENRICHED ({os.path.basename(filepath)})")
    except UnicodeEncodeError:
        print(f"  {ticker}: ENRICHED")
    return True


def load_enrichment_data(json_path):
    """Load enrichment data from a JSON file."""
    with open(json_path, "r", encoding="utf-8") as f:
        return json.load(f)


def main():
    if sys.platform == "win32":
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    args = [a for a in sys.argv[1:]]

    # Extract --data flag
    json_path = None
    if "--data" in args:
        idx = args.index("--data")
        json_path = args[idx + 1]
        args = args[:idx] + args[idx + 2:]

    if not json_path:
        print("Usage: python scripts/update_enrichment.py --data <json_file> [scope]")
        print("  Scope: 2330 | 2330 2317 | --batch 101 | --sector Semiconductors | (none=all)")
        return

    # Load enrichment data
    if not os.path.isabs(json_path):
        json_path = os.path.join(PROJECT_ROOT, json_path)
    enrichment_data = load_enrichment_data(json_path)
    print(f"Loaded {len(enrichment_data)} ticker entries from {os.path.basename(json_path)}")

    # Parse scope
    tickers, sector, desc = parse_scope_args(args)
    print(f"Scope: {desc}\n")

    # Find matching files
    # If specific tickers given, intersect with enrichment data
    available_tickers = list(enrichment_data.keys())
    if tickers:
        target_tickers = [t for t in tickers if t in enrichment_data]
    else:
        target_tickers = available_tickers

    files = find_ticker_files(target_tickers, sector)

    if not files:
        print("No matching files found.")
        return

    enriched = skipped = 0
    for ticker in sorted(files.keys()):
        if ticker in enrichment_data:
            apply_enrichment(files[ticker], ticker, enrichment_data[ticker])
            enriched += 1
        else:
            skipped += 1

    print(f"\nDone. Enriched: {enriched} | Skipped: {skipped}")


if __name__ == "__main__":
    main()
