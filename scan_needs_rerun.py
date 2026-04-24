"""
scan_needs_rerun.py — 找出需要重跑的 ticker

三類觸發條件：
A. 缺 listingStatus 欄位 → 舊檔（修正 3 後一定要重寫）
B. industryType=securities 但 G&A 全 null → 修正 1 未生效
C. industryType in {bank, fh, securities} 但 GP/OI 有值 → 修正 2 未生效
"""
import json, glob, os

needs_rerun = []
reasons = {"A": [], "B": [], "C": []}
ok_count = 0

for f in sorted(glob.glob("data/financials_store/*.json")):
    tk = os.path.splitext(os.path.basename(f))[0]
    try:
        d = json.load(open(f, encoding="utf-8"))
    except Exception:
        needs_rerun.append(tk)
        continue

    itype = d.get("industryType", "")
    ls = d.get("listingStatus", None)

    # 條件 A：缺 listingStatus
    if ls is None:
        reasons["A"].append(tk)
        needs_rerun.append(tk)
        continue

    q = d.get("quarterlyCore") or d.get("quarterly") or {}
    qs = q.get("series", {})
    qp = q.get("periods", [])
    if not qp:
        continue

    # 條件 B：securities 但 G&A 全 null
    if itype == "securities":
        ga = sum(1 for v in qs.get("General & Admin Exp", []) if v is not None)
        if ga == 0:
            reasons["B"].append(tk)
            needs_rerun.append(tk)
            continue

    # 條件 C：金融業有不該有的 GP/OI
    if itype in ("bank", "financial_holding"):
        gp = sum(1 for v in qs.get("Gross Profit", []) if v is not None)
        oi = sum(1 for v in qs.get("Operating Income", []) if v is not None)
        if gp > 0 or oi > 0:
            reasons["C"].append(tk)
            needs_rerun.append(tk)
            continue
    if itype == "securities":
        gp = sum(1 for v in qs.get("Gross Profit", []) if v is not None)
        if gp > 0:
            reasons["C"].append(tk)
            needs_rerun.append(tk)
            continue

    ok_count += 1

# 去重
needs_rerun = sorted(set(needs_rerun))

print(f"=== 掃描結果 ===")
print(f"  總檔案: {ok_count + len(needs_rerun)}")
print(f"  ✅ 乾淨不用重跑: {ok_count}")
print(f"  ⚠️  需要重跑: {len(needs_rerun)}")
print()
print(f"  條件 A（缺 listingStatus）: {len(reasons['A'])}")
print(f"  條件 B（securities G&A 全 null）: {len(reasons['B'])}")
print(f"  條件 C（金融業有不該有的欄位）: {len(reasons['C'])}")
print()

# 寫出需重跑清單（空白分隔，可以直接貼給 update_financials.py）
rerun_file = "data/_needs_rerun.txt"
with open(rerun_file, "w", encoding="utf-8") as fh:
    fh.write(" ".join(needs_rerun))
print(f"=== 重跑清單已寫入: {rerun_file} ===")
print(f"（共 {len(needs_rerun)} 檔，用 Get-Content 讀出來就能直接貼）")

# 也列出前 30 筆給人看
print()
print(f"前 30 筆預覽:")
for tk in needs_rerun[:30]:
    print(f"  {tk}")
if len(needs_rerun) > 30:
    print(f"  ... 另外 {len(needs_rerun) - 30} 檔")
