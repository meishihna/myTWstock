"""Financials (banks/insurance/holding companies) - revenue_mix: null"""
import json

data = {
    "2881": {"revenue_mix": None},
    "2882": {"revenue_mix": None},
    "2885": {"revenue_mix": None},
    "2887": {"revenue_mix": None},
    "2886": {"revenue_mix": None},
    "2884": {"revenue_mix": None},
    "2880": {"revenue_mix": None},
    "2890": {"revenue_mix": None},
    "2892": {"revenue_mix": None},
    "5880": {"revenue_mix": None},
    "2883": {"revenue_mix": None},
    "2801": {"revenue_mix": None},
    "5876": {"revenue_mix": None},
    "2834": {"revenue_mix": None},
    "2812": {"revenue_mix": None},
}

with open("enrich_mega_A.json", "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
print("enrich_mega_A.json written")
