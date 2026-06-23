import json, os

data = {
  "3206": {
    "revenue_mix": {
      "year": "2024",
      "segments": [
        {"name": "電聲元件", "pct": 58},
        {"name": "音頻成品", "pct": 36},
        {"name": "家庭保全及其他", "pct": 6}
      ],
      "geo": "中國 35%，荷蘭 14%，越南 12%，日本 11%，美國 9%，其他 19%"
    }
  }
}

out = r'C:\Users\messn\Desktop\My-TW-Coverage\scripts\enrich_3206.json'
with open(out, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
print(f"Written to {out}")
