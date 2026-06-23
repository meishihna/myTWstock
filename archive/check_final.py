import json, glob, os
print("=== Cache files ===")
for f in sorted(glob.glob("data/mops_cache/sii_114_4*.json")):
    d = json.load(open(f))
    bt = d.get("by_ticker", {})
    types = set(v.get("type","?") for v in bt.values())
    print(f"  {os.path.basename(f)}: {len(bt)} tickers, types={types}")
print()
print("=== Final JSON ===")
for t in ["2882","2801","2816","2855","1409"]:
    d = json.load(open(f"data/financials_store/{t}.json"))
    itype = d.get("industryType","MISSING")
    q = d["quarterly"]["series"]
    rev = [x for x in q["Revenue"] if x is not None]
    ni = [x for x in q["Net Income"] if x is not None]
    print(f"  {t}: industryType={itype} rev_count={len(rev)} ni_count={len(ni)}")
