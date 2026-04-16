import json
d = json.load(open("data/mops_cache/sii_114_4.json"))
bt = d.get("by_ticker", {})
tests = {
    "2330": "general",
    "2882": "financial_holding",
    "2801": "bank",
    "2855": "securities",
    "2816": "insurance",
    "1409": "other",
}
print(f"Total tickers: {len(bt)}")
for t, expected in tests.items():
    row = bt.get(t, {})
    tp = row.get("type", "MISSING")
    rv = row.get("Revenue") is not None
    print(f"  {t}: type={tp} expect={expected} rev={rv}")
