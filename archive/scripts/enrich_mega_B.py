"""Tech/Semis/Industrials batch - revenue_mix data"""
import json

data = {
    "2308": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "電源及零組件", "pct": 53},
                {"name": "基礎設施解決方案", "pct": 24},
                {"name": "工業自動化", "pct": 12},
                {"name": "移動與電動車", "pct": 11},
            ],
            "geo": None,
        }
    },
    "3711": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "封測服務", "pct": 53},
                {"name": "電子製造服務", "pct": 46},
                {"name": "其他", "pct": 1},
            ],
            "geo": None,
        }
    },
    "2383": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "AI伺服器高速CCL", "pct": 82},
                {"name": "通訊/其他應用CCL", "pct": 18},
            ],
            "geo": None,
        }
    },
    "2345": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "網路交換器", "pct": 58},
                {"name": "AI加速卡/應用", "pct": 34},
                {"name": "無線/其他", "pct": 8},
            ],
            "geo": "北美約 65%，歐洲約 20%，亞太約 15%",
        }
    },
    "3017": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "伺服器散熱", "pct": 61},
                {"name": "網路通訊散熱", "pct": 20},
                {"name": "消費性電子散熱", "pct": 19},
            ],
            "geo": None,
        }
    },
    "2303": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "通訊", "pct": 32},
                {"name": "消費性電子", "pct": 28},
                {"name": "電腦", "pct": 20},
                {"name": "工業/車用", "pct": 20},
            ],
            "geo": "台灣約 60%，海外約 40%",
        }
    },
    "3037": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "ABF高密度載板", "pct": 55},
                {"name": "HDI高密度板", "pct": 30},
                {"name": "一般多層板", "pct": 15},
            ],
            "geo": None,
        }
    },
    "7769": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "AI/HPC", "pct": 55},
                {"name": "車用電子", "pct": 20},
                {"name": "消費/手機", "pct": 15},
                {"name": "其他", "pct": 10},
            ],
            "geo": "美國約 55%，中國約 22%，台灣約 14%，其他約 9%",
        }
    },
    "2408": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "DDR4/DDR5 DRAM", "pct": 85},
                {"name": "利基型DRAM", "pct": 15},
            ],
            "geo": None,
        }
    },
    "6669": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "AI/GPU伺服器", "pct": 55},
                {"name": "一般雲端伺服器", "pct": 40},
                {"name": "其他", "pct": 5},
            ],
            "geo": None,
        }
    },
    "3653": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "均熱板", "pct": 75},
                {"name": "散熱模組", "pct": 20},
                {"name": "其他", "pct": 5},
            ],
            "geo": None,
        }
    },
    "2327": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "電阻", "pct": 45},
                {"name": "鉭質/電解電容", "pct": 20},
                {"name": "MLCC", "pct": 17},
                {"name": "電感", "pct": 10},
                {"name": "其他", "pct": 8},
            ],
            "geo": None,
        }
    },
    "2368": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "ABF高密度載板", "pct": 70},
                {"name": "一般印刷電路板", "pct": 30},
            ],
            "geo": None,
        }
    },
    "2357": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "系統產品", "pct": 60},
                {"name": "平台產品", "pct": 38},
                {"name": "AIoT產品", "pct": 2},
            ],
            "geo": "亞洲約 47%，歐洲約 29%，美洲約 24%",
        }
    },
    "2344": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "NOR Flash", "pct": 55},
                {"name": "DRAM", "pct": 35},
                {"name": "NAND Flash", "pct": 10},
            ],
            "geo": None,
        }
    },
    "3045": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "momo電商", "pct": 56},
                {"name": "電信服務", "pct": 37},
                {"name": "有線電視", "pct": 4},
                {"name": "其他", "pct": 3},
            ],
            "geo": None,
        }
    },
    "3231": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "伺服器/儲存", "pct": 55},
                {"name": "桌上型電腦", "pct": 20},
                {"name": "網路設備", "pct": 15},
                {"name": "其他", "pct": 10},
            ],
            "geo": None,
        }
    },
    "8046": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "ABF高密度載板", "pct": 65},
                {"name": "高階HDI多層板", "pct": 35},
            ],
            "geo": None,
        }
    },
    "2301": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "雲端/AI-of-Things", "pct": 48},
                {"name": "資訊科技/消費性", "pct": 36},
                {"name": "光電半導體", "pct": 16},
            ],
            "geo": None,
        }
    },
    "4904": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "行動通訊服務", "pct": 70},
                {"name": "固網/寬頻", "pct": 15},
                {"name": "企業服務", "pct": 10},
                {"name": "其他", "pct": 5},
            ],
            "geo": None,
        }
    },
    "2449": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "IC最終測試", "pct": 70},
                {"name": "晶圓測試/KGD", "pct": 25},
                {"name": "其他", "pct": 5},
            ],
            "geo": None,
        }
    },
    "2059": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "伺服器滑軌", "pct": 70},
                {"name": "家具/辦公滑軌", "pct": 20},
                {"name": "其他", "pct": 10},
            ],
            "geo": "美洲/歐洲約 60%，亞太約 40%",
        }
    },
    "2002": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "熱軋鋼材", "pct": 40},
                {"name": "冷軋鋼材", "pct": 25},
                {"name": "鋼筋/鋼線", "pct": 15},
                {"name": "鋼板", "pct": 10},
                {"name": "其他", "pct": 10},
            ],
            "geo": None,
        }
    },
    "2313": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "網路通訊板", "pct": 40},
                {"name": "電腦/伺服器板", "pct": 30},
                {"name": "消費電子板", "pct": 20},
                {"name": "其他", "pct": 10},
            ],
            "geo": None,
        }
    },
    "1301": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "PVC樹脂", "pct": 35},
                {"name": "氯乙烯單體", "pct": 20},
                {"name": "聚乙烯", "pct": 20},
                {"name": "其他化工/加工品", "pct": 25},
            ],
            "geo": "台灣約 60%，美國約 30%，其他約 10%",
        }
    },
    "3008": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "手機光學鏡頭", "pct": 92},
                {"name": "其他光學元件", "pct": 8},
            ],
            "geo": None,
        }
    },
    "2395": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "工業IoT", "pct": 29},
                {"name": "嵌入式IoT", "pct": 25},
                {"name": "應用運算", "pct": 15},
                {"name": "服務型IoT", "pct": 10},
                {"name": "其他", "pct": 21},
            ],
            "geo": "美洲約 30%，中國約 25%，歐洲約 25%，亞太約 20%",
        }
    },
    "2207": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "整車銷售", "pct": 85},
                {"name": "售後零件/服務", "pct": 10},
                {"name": "其他", "pct": 5},
            ],
            "geo": None,
        }
    },
    "1326": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "化工原料", "pct": 50},
                {"name": "合成纖維", "pct": 30},
                {"name": "紡織品", "pct": 10},
                {"name": "其他", "pct": 10},
            ],
            "geo": None,
        }
    },
    "6515": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "測試座", "pct": 70},
                {"name": "探針卡", "pct": 20},
                {"name": "其他", "pct": 10},
            ],
            "geo": None,
        }
    },
    "1519": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "超高壓變壓器", "pct": 75},
                {"name": "配電設備/開關", "pct": 20},
                {"name": "EPC工程服務", "pct": 5},
            ],
            "geo": "美國約 55%，台灣約 40%，其他約 5%",
        }
    },
    "2379": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "網路晶片", "pct": 45},
                {"name": "音訊晶片", "pct": 20},
                {"name": "儲存控制器", "pct": 15},
                {"name": "多媒體/其他", "pct": 20},
            ],
            "geo": None,
        }
    },
    "1303": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "塑膠加工", "pct": 35},
                {"name": "化工材料", "pct": 25},
                {"name": "電子材料", "pct": 22},
                {"name": "聚酯", "pct": 13},
                {"name": "其他", "pct": 5},
            ],
            "geo": None,
        }
    },
    "6505": {
        "revenue_mix": {
            "year": "2024",
            "segments": [
                {"name": "石油產品", "pct": 62},
                {"name": "石化產品", "pct": 32},
                {"name": "電力/其他", "pct": 6},
            ],
            "geo": None,
        }
    },
    "2603": {
        "revenue_mix": None,
    },
    "2609": {
        "revenue_mix": None,
    },
    "2360": {
        "revenue_mix": None,
    },
}

with open("enrich_mega_B.json", "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
print("enrich_mega_B.json written")
