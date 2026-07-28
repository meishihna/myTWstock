"""
把 Claude Code 歸納的 `why`(一句話原因)併入 web/public/data/revenue-reasons.json。

輸入:一個 JSON 檔,格式 { "2330": "台積電受惠 AI/HPC…", "2344": "記憶體缺貨漲價…" }。
只更新「已存在於 notes(有頭條)」的個股,設定 why + whyAsOf(今日);保留 heads 不動。
供 /revenue-reasons 技能使用:技能先寫出 why-map,再呼叫本腳本套用(避免手改壓縮 JSON)。

用法:
  python scripts/apply_revenue_why.py <why-map.json>
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "public", "data", "revenue-reasons.json")


def main() -> None:
    if len(sys.argv) < 2:
        print("用法: python scripts/apply_revenue_why.py <why-map.json>")
        sys.exit(1)
    with open(sys.argv[1], encoding="utf-8") as f:
        why_map = json.load(f)
    if not isinstance(why_map, dict):
        print("why-map 必須是 {ticker: why} 物件")
        sys.exit(1)
    with open(OUT, encoding="utf-8") as f:
        payload = json.load(f)
    notes = payload.get("notes") or {}
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    applied = skipped = 0
    for tk, why in why_map.items():
        if not isinstance(why, str) or not why.strip():
            continue
        if tk in notes and isinstance(notes[tk], dict):
            notes[tk]["why"] = why.strip()
            notes[tk]["whyAsOf"] = today
            applied += 1
        else:
            skipped += 1
            print(f"  略過 {tk}(無頭條/不在名單)")
    payload["notes"] = notes
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    os.replace(tmp, OUT)
    print(f"[apply-why] 套用 {applied} 檔 why | 略過 {skipped} | → {OUT}")


if __name__ == "__main__":
    main()
