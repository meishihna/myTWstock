"""
首頁市場焦點(批 1):三大法人 + 資券變化(上市,當日)。
FinMind 市場級 dataset(無需 token,匿名亦可,流量受限):
  - TaiwanStockTotalInstitutionalInvestors  三大法人買賣(元)
  - TaiwanStockTotalMarginPurchaseShortSale 融資融券(張 / 元)
取最新交易日,輸出 web/public/data/market-focus.json(提交入庫,首頁讀取)。

  python scripts/update_market_focus.py
"""

from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "public", "data", "market-focus.json")
TOKEN = (
    os.environ.get("FINMIND_TOKEN", "").strip()
    or os.environ.get("FINMIND_API_TOKEN", "").strip()
)
START = (datetime.today() - timedelta(days=20)).strftime("%Y-%m-%d")

INST_ZH = {
    "Foreign_Investor": "外資",
    "Investment_Trust": "投信",
    "Dealer_self": "自營商(自行)",
    "Dealer_Hedging": "自營商(避險)",
    "Foreign_Dealer_Self": "外資自營商",
}
INST_ORDER = [
    "Foreign_Investor",
    "Investment_Trust",
    "Dealer_self",
    "Dealer_Hedging",
    "Foreign_Dealer_Self",
]


def finmind(dataset: str) -> list[dict]:
    q = [("dataset", dataset), ("start_date", START)]
    url = "https://api.finmindtrade.com/api/v4/data?" + urllib.parse.urlencode(q)
    h = {"User-Agent": "twstock-market-focus"}
    if TOKEN:
        h["Authorization"] = f"Bearer {TOKEN}"
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=90) as r:
        d = json.loads(r.read().decode("utf-8"))
    if d.get("status") != 200:
        raise RuntimeError(f"{dataset}: status={d.get('status')} {d.get('msg') or d.get('message')}")
    return d.get("data") or []


def build_institutional() -> dict | None:
    rows = finmind("TaiwanStockTotalInstitutionalInvestors")
    if not rows:
        return None
    latest = max(r["date"] for r in rows)
    by = {r["name"]: r for r in rows if r["date"] == latest}
    print("  三大法人類別:", sorted(by.keys()))
    out = []
    total_net = 0.0
    for name in INST_ORDER:
        r = by.get(name)
        if not r:
            continue
        buy = float(r.get("buy") or 0) / 1e8
        sell = float(r.get("sell") or 0) / 1e8
        net = buy - sell
        total_net += net
        out.append(
            {"label": INST_ZH.get(name, name), "buy": round(buy, 1), "sell": round(sell, 1), "net": round(net, 1)}
        )
    return {"date": latest, "rows": out, "totalNet": round(total_net, 1)}


def build_margin() -> dict | None:
    rows = finmind("TaiwanStockTotalMarginPurchaseShortSale")
    if not rows:
        return None
    latest = max(r["date"] for r in rows)
    day = {r["name"]: r for r in rows if r["date"] == latest}

    def bal(name: str, money: bool = False) -> dict | None:
        r = day.get(name)
        if not r:
            return None
        t = float(r.get("TodayBalance") or 0)
        y = float(r.get("YesBalance") or 0)
        if money:
            return {"today": round(t / 1e8, 0), "change": round((t - y) / 1e8, 1)}  # 億元
        return {"today": round(t), "change": round(t - y)}  # 張

    return {
        "date": latest,
        "margin": bal("MarginPurchase"),  # 融資餘額(張)
        "short": bal("ShortSale"),  # 融券餘額(張)
        "marginMoney": bal("MarginPurchaseMoney", money=True),  # 融資金額(億元)
    }


def main() -> None:
    print("FINMIND_TOKEN set:", bool(TOKEN), "| start:", START)
    inst = build_institutional()
    margin = build_margin()
    payload = {
        "generatedAt": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "institutional": inst,
        "margin": margin,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, OUT)
    print("wrote", OUT)
    if inst:
        print("  三大法人", inst["date"], "| 合計買賣超", inst["totalNet"], "億")
        for r in inst["rows"]:
            print(f"    {r['label']}: 買賣超 {r['net']:+.1f} 億")
    if margin:
        m = margin.get("margin") or {}
        print(f"  資券 {margin['date']} | 融資餘額 {m.get('today',0):,.0f} 張 (變化 {m.get('change',0):+,.0f})")


if __name__ == "__main__":
    main()
