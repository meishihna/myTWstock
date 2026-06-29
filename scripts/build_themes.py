"""
build_themes.py — Generate thematic investment screens from wikilink graph.

Scans all ticker reports for wikilinks, groups companies by theme (technology,
material, application), and generates markdown pages showing the full value chain
for each theme.

Usage:
  python scripts/build_themes.py              # Rebuild all themes
  python scripts/build_themes.py --list       # List available themes
  python scripts/build_themes.py "CoWoS"      # Rebuild single theme

Output: themes/ folder with one .md per theme.
"""

import os
import re
import sys
from collections import defaultdict

REPORTS_DIR = os.path.join(os.path.dirname(__file__), "..", "Pilot_Reports")
THEMES_DIR = os.path.join(os.path.dirname(__file__), "..", "themes")

# Curated themes with supply chain role hints
# Format: theme_wikilink -> {
#   name, desc, related,
#   category,                       # 必填:題材分類(分類膠囊用)
#   cagr?, market_size?,            # 選填:策展關鍵數字(逐步補,無則不顯示)
#   indicators?: [{label, value}],  # 選填:4 張產業關鍵指標小卡
# }
THEME_DEFINITIONS = {
    # === Advanced Packaging ===
    "CoWoS": {
        "name": "CoWoS 先進封裝",
        "desc": "台積電 Chip-on-Wafer-on-Substrate 2.5D 先進封裝技術，AI 晶片關鍵製程",
        "related": ["HBM", "2.5D 封裝", "3D 封裝", "ABF 載板", "矽中介層"],
        "category": "先進封測",
        "cagr": "35%+",
        "market_size": "先進封裝 全球約 US$30B+",
        "indicators": [
            {"label": "技術核心", "value": "2.5D / 3D 封裝"},
            {"label": "主流規格", "value": "CoWoS-S / -R / -L"},
            {"label": "商轉節點", "value": "台積電量產"},
            {"label": "產業門檻", "value": "極高(製程·良率)"},
        ],
    },
    "HBM": {
        "name": "HBM 高頻寬記憶體",
        "desc": "High Bandwidth Memory，AI 加速器必備的高速堆疊記憶體",
        "related": ["CoWoS", "AI 伺服器", "DRAM"],
        "category": "記憶體",
        "cagr": "45%+",
        "market_size": "全球約 US$25B(2024)",
        "indicators": [
            {"label": "技術核心", "value": "堆疊 DRAM + TSV"},
            {"label": "主流規格", "value": "HBM3E → HBM4"},
            {"label": "核心客戶", "value": "NVIDIA / AMD"},
            {"label": "產業地位", "value": "AI 記憶體瓶頸"},
        ],
    },
    "CPO": {
        "name": "CPO 共封裝光學",
        "desc": "Co-Packaged Optics，將光學元件整合於晶片封裝中以突破頻寬瓶頸",
        "related": ["矽光子", "光收發模組", "AI 伺服器", "資料中心"],
        "category": "光通訊",
        "cagr": "40%+",
        "indicators": [
            {"label": "技術核心", "value": "光學共封裝"},
            {"label": "主要應用", "value": "交換器/AI 互連"},
            {"label": "商轉節點", "value": "1.6T / 3.2T"},
            {"label": "產業地位", "value": "頻寬功耗解方"},
        ],
    },
    # === Photonics ===
    "矽光子": {
        "name": "矽光子 Silicon Photonics",
        "desc": "以矽基製程整合光學元件，實現高速光互連，下一代資料中心核心技術",
        "related": ["CPO", "EML", "VCSEL", "光收發模組", "資料中心"],
        "category": "光通訊",
        "cagr": "25%+",
        "indicators": [
            {"label": "技術核心", "value": "矽基光積體電路"},
            {"label": "主要應用", "value": "CPO / 光收發"},
            {"label": "商轉節點", "value": "1.6T 光模組"},
            {"label": "產業地位", "value": "頻寬瓶頸解方"},
        ],
    },
    "VCSEL": {
        "name": "VCSEL 垂直共振腔面射型雷射",
        "desc": "3D 感測、光通訊及 LiDAR 核心光源元件",
        "related": ["矽光子", "光收發模組", "砷化鎵"],
        "category": "光通訊",
        "cagr": "12–15%",
        "indicators": [
            {"label": "技術核心", "value": "面射型雷射"},
            {"label": "主要應用", "value": "3D 感測 / 光通訊 / LiDAR"},
            {"label": "核心客戶", "value": "Apple / 消費光學"},
            {"label": "材料基礎", "value": "砷化鎵磊晶"},
        ],
    },
    # === Compound Semiconductors ===
    "碳化矽": {
        "name": "碳化矽 SiC",
        "desc": "第三代半導體材料，耐高壓高溫，電動車逆變器及充電樁關鍵材料",
        "related": ["電動車", "MOSFET", "IGBT", "氮化鎵"],
        "category": "能源車用",
        "cagr": "25%+",
        "market_size": "全球約 US$3B(2024)",
        "indicators": [
            {"label": "材料世代", "value": "第三代半導體"},
            {"label": "主要應用", "value": "電動車逆變器 / 充電"},
            {"label": "關鍵製程", "value": "長晶 / 磊晶"},
            {"label": "產業門檻", "value": "高(良率·缺陷)"},
        ],
    },
    "氮化鎵": {
        "name": "氮化鎵 GaN",
        "desc": "第三代半導體材料，高頻高效，5G 基站、快充及衛星通訊核心",
        "related": ["5G", "碳化矽", "磷化銦"],
        "category": "能源車用",
        "cagr": "25%+",
        "indicators": [
            {"label": "材料世代", "value": "第三代半導體"},
            {"label": "主要應用", "value": "快充 / 5G / 電源"},
            {"label": "技術優勢", "value": "高頻高效"},
            {"label": "產業趨勢", "value": "矽基 GaN 興起"},
        ],
    },
    "磷化銦": {
        "name": "磷化銦 InP",
        "desc": "III-V 族化合物半導體，光通訊雷射及高速光電元件基板材料",
        "related": ["矽光子", "EML", "光收發模組", "砷化鎵"],
        "category": "光通訊",
        "cagr": "15%+",
        "indicators": [
            {"label": "材料類別", "value": "III-V 化合物"},
            {"label": "主要應用", "value": "光通訊雷射(EML)"},
            {"label": "商轉節點", "value": "800G / 1.6T"},
            {"label": "產業地位", "value": "高速光電基板"},
        ],
    },
    # === AI / Data Center ===
    "AI 伺服器": {
        "name": "AI 伺服器供應鏈",
        "desc": "AI 訓練與推論伺服器完整供應鏈，從晶片到系統到散熱",
        "related": ["CoWoS", "HBM", "NVIDIA", "CPO", "資料中心"],
        "category": "AI 伺服器",
        "cagr": "30%+",
        "indicators": [
            {"label": "技術核心", "value": "GPU 加速運算"},
            {"label": "主流架構", "value": "NVIDIA HGX / GB200"},
            {"label": "核心客戶", "value": "北美 CSP"},
            {"label": "產業地位", "value": "AI 算力基礎"},
        ],
        "members": {
            "upstream": {
                "ASIC / 矽智財": ["3443", "3661"],
                "介面 / 網通 IC": ["4966", "5269"],
            },
            "midstream": {
                "整機組裝 / ODM": ["2317", "2382", "3231", "6669", "2356", "2376"],
                "散熱": ["3017", "3324", "2421", "8996", "6651", "4760"],
                "電源": ["2308", "2301", "6412", "6282", "6203"],
                "PCB / 載板": ["2368", "3044", "3037", "8046", "2383"],
                "連接器 / 機構件": ["3023", "2392", "3533", "2059", "7861"],
                "被動 / 其他元件": ["2492", "2375", "6155", "3042", "3221"],
                "光通訊": ["3363"],
            },
            "downstream": {
                "通路 / 驗證": ["3036", "3048", "2459"],
            },
        },
    },
    "資料中心": {
        "name": "資料中心供應鏈",
        "desc": "超大規模資料中心基礎設施，涵蓋伺服器、網通、電源、散熱",
        "related": ["AI 伺服器", "CPO", "矽光子", "PCB"],
        "category": "AI 伺服器",
        "cagr": "20%+",
        "indicators": [
            {"label": "技術核心", "value": "伺服器+網通+電源"},
            {"label": "關鍵驅動", "value": "AI 算力擴張"},
            {"label": "核心客戶", "value": "超大規模雲端"},
            {"label": "產業地位", "value": "數位基礎設施"},
        ],
    },
    # === EV / Automotive ===
    "電動車": {
        "name": "電動車供應鏈",
        "desc": "電動車完整供應鏈，從電池材料到功率元件到車用電子",
        "related": ["碳化矽", "IGBT", "MOSFET", "車用電子"],
        "category": "能源車用",
        "cagr": "15%+",
        "indicators": [
            {"label": "技術核心", "value": "三電系統"},
            {"label": "關鍵元件", "value": "功率半導體/電池"},
            {"label": "主流趨勢", "value": "800V 高壓"},
            {"label": "產業地位", "value": "運具電動化"},
        ],
    },
    # === Applications ===
    "5G": {
        "name": "5G 通訊供應鏈",
        "desc": "5G 基礎建設與終端應用，涵蓋基站、天線、射頻前端、濾波器",
        "related": ["氮化鎵", "RF", "低軌衛星"],
        "category": "網路設備",
        "cagr": "高個位數",
        "indicators": [
            {"label": "建設環節", "value": "基站 / 小基站"},
            {"label": "關鍵元件", "value": "射頻前端 / 濾波器"},
            {"label": "台廠角色", "value": "PA / 天線 / 網通"},
            {"label": "技術演進", "value": "5G-A → 6G"},
        ],
    },
    "低軌衛星": {
        "name": "低軌衛星 LEO Satellite",
        "desc": "低軌道衛星通訊供應鏈，天線、地面站、射頻模組",
        "related": ["5G", "氮化鎵", "RF"],
        "category": "衛星通訊",
        "cagr": "15–20%",
        "indicators": [
            {"label": "系統環節", "value": "衛星 / 地面站 / 終端"},
            {"label": "領導業者", "value": "Starlink / OneWeb"},
            {"label": "台廠角色", "value": "地面設備 / 射頻"},
            {"label": "產業地位", "value": "新興衛星通訊"},
        ],
    },
    # === Process / Equipment ===
    "EUV": {
        "name": "EUV 極紫外光微影",
        "desc": "先進製程關鍵微影技術，7nm 以下節點必備",
        "related": ["光阻液", "ASML"],
        "category": "半導體製造",
        "cagr": "15%+",
        "indicators": [
            {"label": "設備獨家", "value": "ASML"},
            {"label": "製程節點", "value": "7nm 以下"},
            {"label": "關鍵耗材", "value": "光阻 / 光罩"},
            {"label": "台廠角色", "value": "零組件 / 廠務"},
        ],
    },
    # === Materials ===
    "光阻液": {
        "name": "光阻液 Photoresist",
        "desc": "半導體微影製程關鍵化學材料",
        "related": ["EUV", "微影"],
        "category": "半導體製造",
        "cagr": "8–10%",
        "indicators": [
            {"label": "材料類別", "value": "微影化學品"},
            {"label": "主要原廠", "value": "JSR / 東京應化 / 信越"},
            {"label": "關鍵規格", "value": "EUV 光阻"},
            {"label": "台廠角色", "value": "在地特化供應"},
        ],
    },
    "ABF 載板": {
        "name": "ABF 載板",
        "desc": "Ajinomoto Build-up Film 載板，高階 IC 封裝基板",
        "related": ["CoWoS", "AI 伺服器", "PCB"],
        "category": "基板材料",
        "cagr": "10–15%",
        "indicators": [
            {"label": "關鍵材料", "value": "味之素 ABF 膜"},
            {"label": "主要應用", "value": "HPC / AI 晶片載板"},
            {"label": "供需狀況", "value": "高階吃緊"},
            {"label": "台廠角色", "value": "欣興 / 南電 / 景碩"},
        ],
    },
    "矽晶圓": {
        "name": "矽晶圓",
        "desc": "半導體製造最基礎的原材料",
        "related": ["碳化矽", "磊晶"],
        "category": "基板材料",
        "cagr": "5–8%",
        "market_size": "全球約 US$12B",
        "indicators": [
            {"label": "主力產品", "value": "12 吋拋光 / 磊晶"},
            {"label": "全球寡占", "value": "信越 / 勝高 / 環球晶"},
            {"label": "需求動能", "value": "先進製程 / 記憶體"},
            {"label": "台廠角色", "value": "環球晶 / 合晶"},
        ],
    },
    # === Key customers (cross-industry) ===
    "Apple": {
        "name": "Apple 蘋果供應鏈",
        "desc": "蘋果公司台灣供應鏈成員",
        "related": ["台積電", "鴻海"],
        "category": "消費終端",
        "indicators": [
            {"label": "核心產品", "value": "iPhone / Mac / 穿戴"},
            {"label": "台廠角色", "value": "代工 / 零組件"},
            {"label": "關鍵夥伴", "value": "台積電 / 鴻海"},
            {"label": "產業趨勢", "value": "自研晶片 / AI"},
        ],
    },
    "NVIDIA": {
        "name": "NVIDIA 輝達供應鏈",
        "desc": "NVIDIA GPU 及 AI 平台台灣供應鏈",
        "related": ["CoWoS", "HBM", "AI 伺服器", "台積電"],
        "category": "AI 伺服器",
        "indicators": [
            {"label": "核心平台", "value": "GB200 / Blackwell"},
            {"label": "台廠角色", "value": "代工+封裝+散熱"},
            {"label": "關鍵供應", "value": "CoWoS / HBM"},
            {"label": "產業地位", "value": "AI 算力領導"},
        ],
    },
    "Tesla": {
        "name": "Tesla 特斯拉供應鏈",
        "desc": "特斯拉電動車台灣供應鏈成員",
        "related": ["電動車", "碳化矽"],
        "category": "能源車用",
        "indicators": [
            {"label": "核心產品", "value": "電動車 / 儲能"},
            {"label": "台廠角色", "value": "零組件 / 充電"},
            {"label": "關鍵技術", "value": "自駕 / 電池"},
            {"label": "產業趨勢", "value": "FSD / 機器人"},
        ],
    },
    # === PCB / 零組件 ===
    "PCB": {
        "name": "PCB 印刷電路板",
        "desc": "電子產品訊號互連基礎，涵蓋硬板、軟板、HDI 與載板",
        "related": ["ABF 載板", "銅箔", "連接器", "AI 伺服器"],
        "category": "基板材料",
        "cagr": "8%+",
        "market_size": "全球約 US$80B",
        "indicators": [
            {"label": "技術核心", "value": "HDI / 載板 / 軟板"},
            {"label": "升級驅動", "value": "AI 載板+車用"},
            {"label": "主流材料", "value": "銅箔 / 玻纖布"},
            {"label": "產業地位", "value": "電子互連基礎"},
        ],
    },
    "MOSFET": {
        "name": "功率半導體 MOSFET／IGBT",
        "desc": "電源轉換與馬達驅動核心元件，電動車、工控、充電樁需求",
        "related": ["IGBT", "碳化矽", "氮化鎵", "電動車"],
        "category": "能源車用",
        "cagr": "8–10%",
        "indicators": [
            {"label": "核心元件", "value": "MOSFET / IGBT"},
            {"label": "主要應用", "value": "電動車 / 工控 / 電源"},
            {"label": "材料升級", "value": "SiC / GaN"},
            {"label": "台廠角色", "value": "設計 / 封測"},
        ],
    },
    "銅箔": {
        "name": "銅箔",
        "desc": "PCB 與鋰電池負極關鍵材料，AI 載板與電動車雙引擎",
        "related": ["PCB", "ABF 載板", "電動車", "儲能"],
        "category": "基板材料",
        "cagr": "8–10%",
        "indicators": [
            {"label": "主力產品", "value": "電解銅箔"},
            {"label": "雙引擎", "value": "PCB 載板 / 鋰電負極"},
            {"label": "規格趨勢", "value": "極薄 / 高頻"},
            {"label": "台廠角色", "value": "南亞 / 長春 / 金居"},
        ],
    },
    "連接器": {
        "name": "連接器",
        "desc": "高速傳輸與電力連接元件，AI 伺服器與車用需求升溫",
        "related": ["AI 伺服器", "ADAS", "PCB"],
        "category": "電子零組件",
        "cagr": "8–10%",
        "indicators": [
            {"label": "主要應用", "value": "AI 伺服器 / 車用"},
            {"label": "規格升級", "value": "224G / 大電流"},
            {"label": "技術趨勢", "value": "液冷快接"},
            {"label": "台廠角色", "value": "高速連接器"},
        ],
    },
    "MLCC": {
        "name": "MLCC 被動元件",
        "desc": "積層陶瓷電容，電子產品被動元件基礎，車用與 AI 帶動規格升級",
        "related": ["電動車", "AI 伺服器", "PCB"],
        "category": "被動元件",
        "cagr": "8%+",
        "market_size": "全球約 US$13B",
        "indicators": [
            {"label": "技術核心", "value": "積層陶瓷電容"},
            {"label": "升級驅動", "value": "車用+AI 伺服器"},
            {"label": "規格趨勢", "value": "小型化高容"},
            {"label": "產業地位", "value": "被動元件基礎"},
        ],
    },
    # === 散熱 / AI 裝置 ===
    "散熱": {
        "name": "散熱／液冷",
        "desc": "AI 伺服器高功耗推升散熱需求，氣冷轉液冷與均熱片題材",
        "related": ["液冷", "AI 伺服器", "資料中心"],
        "category": "散熱冷卻",
        "cagr": "20%+",
        "indicators": [
            {"label": "技術趨勢", "value": "氣冷 → 液冷"},
            {"label": "關鍵元件", "value": "均熱片/水冷板/CDU"},
            {"label": "需求驅動", "value": "AI 伺服器高功耗"},
            {"label": "產業地位", "value": "AI 散熱瓶頸"},
        ],
    },
    "AI PC": {
        "name": "AI PC",
        "desc": "內建 NPU 的 AI 個人電腦，帶動換機潮與 ODM 出貨",
        "related": ["AI 伺服器", "Microsoft", "ODM"],
        "category": "消費終端",
        "cagr": "30%+",
        "indicators": [
            {"label": "核心規格", "value": "內建 NPU"},
            {"label": "主要平台", "value": "高通 / Intel / AMD"},
            {"label": "台廠角色", "value": "ODM / 品牌"},
            {"label": "產業趨勢", "value": "企業換機潮"},
        ],
    },
    # === 車用電子 ===
    "ADAS": {
        "name": "ADAS 先進駕駛輔助",
        "desc": "車用感測、運算與自動駕駛供應鏈",
        "related": ["電動車", "MOSFET", "連接器"],
        "category": "能源車用",
        "cagr": "12–15%",
        "indicators": [
            {"label": "感測元件", "value": "鏡頭 / 雷達 / 光達"},
            {"label": "運算核心", "value": "車用 SoC"},
            {"label": "等級演進", "value": "L2 → L3"},
            {"label": "台廠角色", "value": "感測 / 連接 / PCB"},
        ],
    },
    # === 顯示 ===
    "OLED": {
        "name": "OLED 顯示",
        "desc": "有機發光二極體顯示，手機、穿戴與筆電滲透提升",
        "related": ["Mini LED", "面板"],
        "category": "光學顯示",
        "cagr": "8–10%",
        "indicators": [
            {"label": "技術核心", "value": "有機自發光"},
            {"label": "主要應用", "value": "手機 / 穿戴 / 筆電"},
            {"label": "產業趨勢", "value": "滲透率提升"},
            {"label": "台廠角色", "value": "材料 / 驅動IC / 設備"},
        ],
    },
    "Mini LED": {
        "name": "Mini LED 背光",
        "desc": "高動態對比背光技術，應用於高階顯示器、電視與筆電",
        "related": ["OLED", "LED", "面板"],
        "category": "光學顯示",
        "cagr": "20%+",
        "indicators": [
            {"label": "技術核心", "value": "細間距背光"},
            {"label": "主要應用", "value": "高階顯示 / 車用"},
            {"label": "關鍵技術", "value": "區域調光"},
            {"label": "台廠角色", "value": "晶電 / 隆達 / 設備"},
        ],
    },
    # === 記憶體 ===
    "DRAM": {
        "name": "記憶體 DRAM",
        "desc": "動態隨機存取記憶體，AI、伺服器與消費電子需求循環",
        "related": ["HBM", "DDR5", "記憶體"],
        "category": "記憶體",
        "cagr": "循環性 ~8%",
        "market_size": "全球約 US$90B",
        "indicators": [
            {"label": "主力產品", "value": "DDR5 / LPDDR"},
            {"label": "全球寡占", "value": "三星 / SK海力士 / 美光"},
            {"label": "市場特性", "value": "景氣循環明顯"},
            {"label": "台廠角色", "value": "利基 / 模組 / 封測"},
        ],
    },
    # === 綠能 ===
    "儲能": {
        "name": "儲能 Energy Storage",
        "desc": "電網與再生能源儲能系統，涵蓋電池芯、模組與 ESS 整合",
        "related": ["太陽能", "電動車", "離岸風電"],
        "category": "綠能環保",
        "cagr": "20%+",
        "indicators": [
            {"label": "系統環節", "value": "電池芯 / 模組 / ESS"},
            {"label": "主要應用", "value": "電網 / 再生能源"},
            {"label": "主流技術", "value": "磷酸鋰鐵"},
            {"label": "台廠角色", "value": "電芯 / 系統整合"},
        ],
    },
    "太陽能": {
        "name": "太陽能 Solar",
        "desc": "太陽能電池、模組與系統供應鏈",
        "related": ["儲能", "離岸風電"],
        "category": "綠能環保",
        "cagr": "8–10%",
        "market_size": "全球新增 US$200B+",
        "indicators": [
            {"label": "產業環節", "value": "電池 / 模組 / 系統"},
            {"label": "技術趨勢", "value": "N 型 TOPCon"},
            {"label": "台廠角色", "value": "電池 / 模組 / 電廠"},
            {"label": "政策驅動", "value": "再生能源目標"},
        ],
    },
    "離岸風電": {
        "name": "離岸風電 Offshore Wind",
        "desc": "離岸風力發電水下基礎、海纜與機電供應鏈",
        "related": ["儲能", "太陽能"],
        "category": "綠能環保",
        "cagr": "12–15%",
        "indicators": [
            {"label": "產業環節", "value": "水下基礎 / 海纜 / 機電"},
            {"label": "主要區域", "value": "台灣海峽"},
            {"label": "台廠角色", "value": "水下基礎 / 海纜 / 塔架"},
            {"label": "政策驅動", "value": "區塊開發"},
        ],
    },

    # ============================================================
    # 細分子題材(策展成員清單)—— 把大分類再切成可投資的細分群
    # members: {tier: [tickers]};代號以 Pilot_Reports 涵蓋者為準(build 會略過未涵蓋者)
    # ============================================================

    # --- IC 設計 ---
    "ic-asic-ip": {
        "name": "IC 設計｜客製 ASIC 與矽智財",
        "desc": "雲端服務商「去輝達化」與晶片自研推動,矽智財 (IP) 授權與客製 ASIC 設計成為 AI 算力落地核心。",
        "category": "IC 設計",
        "cagr": "30%+",
        "indicators": [
            {"label": "商業模式", "value": "NRE + 量產 / IP 授權"},
            {"label": "核心客戶", "value": "北美 CSP / AI 系統廠"},
            {"label": "技術節點", "value": "3nm / 2nm"},
            {"label": "產業地位", "value": "價值鏈最頂端"},
        ],
        "members": {"midstream": ["3443", "3661", "3035", "3529", "6533", "6643"]},
    },
    "ic-hpc-network": {
        "name": "IC 設計｜HPC 與網通 IC",
        "desc": "聚焦高效能運算 (HPC)、高速介面與 5G/WiFi 網通核心晶片的 Fabless IC 設計公司。",
        "category": "IC 設計",
        "cagr": "15%+",
        "indicators": [
            {"label": "主要產品", "value": "SoC / 網通 / 高速介面"},
            {"label": "技術重點", "value": "PCIe / 乙太網 / WiFi"},
            {"label": "終端應用", "value": "AI 伺服器 / 消費"},
            {"label": "代表廠商", "value": "聯發科 / 瑞昱"},
        ],
        "members": {"midstream": ["2454", "2379", "4966", "5269", "5274", "6526"]},
    },
    "ic-analog-power": {
        "name": "IC 設計｜類比與功率管理 IC",
        "desc": "負責電力管理、訊號感測的核心類比與功率晶片設計公司,涵蓋 PMIC、DC-DC 與驅動 IC。",
        "category": "IC 設計",
        "cagr": "8–10%",
        "indicators": [
            {"label": "主要產品", "value": "PMIC / DC-DC"},
            {"label": "終端應用", "value": "消費 / 工控 / 車用"},
            {"label": "產品特性", "value": "高毛利 / 多料號"},
            {"label": "代表廠商", "value": "矽力-KY / 致新"},
        ],
        "members": {"midstream": ["6415", "8081", "6138", "3438", "3588", "6719"]},
    },
    "ic-mcu": {
        "name": "IC 設計｜MCU 微控制器",
        "desc": "通用 32-bit MCU、觸控感測與音訊語音 IC 設計廠,應用於家電、消費與工控。",
        "category": "IC 設計",
        "cagr": "高個位數",
        "indicators": [
            {"label": "主要產品", "value": "32-bit MCU / 觸控"},
            {"label": "終端應用", "value": "家電 / 消費 / 工控"},
            {"label": "市場特性", "value": "庫存循環敏感"},
            {"label": "代表廠商", "value": "新唐 / 盛群"},
        ],
        "members": {"midstream": ["4919", "6202", "5471", "2458", "4952", "6494"]},
    },
    "ic-ddic": {
        "name": "IC 設計｜顯示驅動 IC",
        "desc": "顯示驅動 IC (DDIC) 控制面板像素電壓,是顯示影像核心;隨 OLED 滲透率提升升級。",
        "category": "IC 設計",
        "cagr": "5–8%",
        "indicators": [
            {"label": "主要產品", "value": "DDIC / TDDI / TCON"},
            {"label": "終端應用", "value": "手機 / 面板 / 車載"},
            {"label": "技術趨勢", "value": "OLED 驅動"},
            {"label": "代表廠商", "value": "聯詠 / 敦泰"},
        ],
        "members": {"midstream": ["3034", "3545", "4961", "8016", "3592"]},
    },

    # --- 半導體製造 ---
    "semi-foundry": {
        "name": "半導體製造｜晶圓代工",
        "desc": "依 IC 設計藍圖製造晶圓,涵蓋先進邏輯製程與特殊/成熟製程,是價值轉化為實體晶片的核心。",
        "category": "半導體製造",
        "cagr": "10%+",
        "market_size": "全球約 US$130B",
        "indicators": [
            {"label": "製程分布", "value": "先進 / 特殊 / 成熟"},
            {"label": "龍頭地位", "value": "台積電全球領先"},
            {"label": "需求動能", "value": "AI / HPC"},
            {"label": "代表廠商", "value": "台積電 / 聯電"},
        ],
        "members": {"midstream": ["2330", "2303", "5347", "6770"]},
    },
    "semi-equip": {
        "name": "半導體製造｜晶圓廠設備",
        "desc": "提供晶圓製造前段所需設備、量測儀器與設備關鍵零組件,涵蓋濕製程、量測與廠務整合。",
        "category": "半導體製造",
        "cagr": "12–15%",
        "indicators": [
            {"label": "主要環節", "value": "濕製程 / 量測 / 廠務"},
            {"label": "需求動能", "value": "晶圓廠擴產"},
            {"label": "技術角色", "value": "設備在地化"},
            {"label": "代表廠商", "value": "京鼎 / 帆宣"},
        ],
        "members": {"upstream": ["3413", "3131", "3583", "6196", "2404", "3680"]},
    },
    "semi-material": {
        "name": "半導體製造｜前段製程材料",
        "desc": "晶圓前段製程所需高純度化學品與功能性材料,涵蓋光阻、特化、靶材與電子氣體。",
        "category": "半導體製造",
        "cagr": "8–10%",
        "indicators": [
            {"label": "主要材料", "value": "特化 / 靶材 / 氣體"},
            {"label": "供應特性", "value": "認證門檻高"},
            {"label": "趨勢", "value": "材料在地化"},
            {"label": "代表廠商", "value": "三福化 / 光洋科"},
        ],
        "members": {"upstream": ["4755", "5234", "1773", "1785"]},
    },
    "semi-thirdgen": {
        "name": "半導體製造｜第三代半導體",
        "desc": "化合物半導體跨向量產;SiC 聚焦電動車 800V 與 AI 高壓直流,GaN 走向快充與射頻。",
        "category": "半導體製造",
        "cagr": "25%+",
        "indicators": [
            {"label": "材料世代", "value": "SiC / GaN"},
            {"label": "主要應用", "value": "電動車 / 快充 / 射頻"},
            {"label": "製程環節", "value": "磊晶 / 代工"},
            {"label": "代表廠商", "value": "穩懋 / 漢磊"},
        ],
        "members": {"midstream": ["3707", "3016", "3105", "6488", "2342"]},
    },

    # --- 先進封測 ---
    "atp-osat": {
        "name": "先進封測｜封測代工 (OSAT)",
        "desc": "涵蓋主流 OSAT 代工、特殊封裝製程與記憶體封裝服務,追蹤整體半導體景氣循環。",
        "category": "先進封測",
        "cagr": "8–10%",
        "indicators": [
            {"label": "主要服務", "value": "封裝 + 測試"},
            {"label": "龍頭地位", "value": "日月光全球第一"},
            {"label": "需求動能", "value": "AI / 先進封裝"},
            {"label": "代表廠商", "value": "日月光 / 力成"},
        ],
        "members": {"midstream": ["3711", "2449", "6239", "6147", "8150", "2441"]},
    },
    "atp-probe": {
        "name": "先進封測｜測試介面與探針卡",
        "desc": "晶圓測試與成品測試所需探針卡、測試座與介面耗材,AI/HPC 高腳數需求推升。",
        "category": "先進封測",
        "cagr": "15%+",
        "indicators": [
            {"label": "主要產品", "value": "探針卡 / 測試座"},
            {"label": "需求動能", "value": "AI 高腳數測試"},
            {"label": "產品特性", "value": "耗材性 / 高毛利"},
            {"label": "代表廠商", "value": "旺矽 / 穎崴"},
        ],
        "members": {"midstream": ["6223", "6515", "6510", "6582"]},
    },
    "atp-equip": {
        "name": "先進封測｜封裝材料與設備",
        "desc": "提供先進封裝核心製程所需機台與材料,涵蓋雷射、鍵合、點膠與檢測設備。",
        "category": "先進封測",
        "cagr": "15%+",
        "indicators": [
            {"label": "主要環節", "value": "封裝設備 / 材料"},
            {"label": "需求動能", "value": "CoWoS / 面板級封裝"},
            {"label": "技術角色", "value": "製程機台"},
            {"label": "代表廠商", "value": "均豪 / 群翊"},
        ],
        "members": {"upstream": ["5443", "8027", "6664", "6706"]},
    },

    # --- 記憶體 ---
    "mem-dram-module": {
        "name": "記憶體｜DRAM 與模組",
        "desc": "台系 DRAM 製造與記憶體模組廠,受 AI 伺服器與消費需求循環驅動。",
        "category": "記憶體",
        "cagr": "循環性",
        "indicators": [
            {"label": "主要產品", "value": "DRAM / 模組"},
            {"label": "需求動能", "value": "伺服器 / 消費"},
            {"label": "市場特性", "value": "景氣循環明顯"},
            {"label": "代表廠商", "value": "南亞科 / 威剛"},
        ],
        "members": {"midstream": ["2408", "2344", "3260", "4967", "2451", "8271"]},
    },
    "mem-storage-ctrl": {
        "name": "記憶體｜NAND 與儲存控制 IC",
        "desc": "NAND Flash 與 SSD/儲存控制 IC,受惠 AI 資料儲存與企業級需求。",
        "category": "記憶體",
        "cagr": "循環性",
        "indicators": [
            {"label": "主要產品", "value": "NAND / 控制 IC"},
            {"label": "需求動能", "value": "企業級 SSD"},
            {"label": "技術角色", "value": "儲存韌體"},
            {"label": "代表廠商", "value": "群聯 / 旺宏"},
        ],
        "members": {"midstream": ["8299", "2337", "6485"]},
    },

    # --- AI 伺服器 ---
    "ai-server-odm": {
        "name": "AI 伺服器｜整機與 ODM",
        "desc": "AI 伺服器整機櫃組裝與 ODM 出貨,北美 CSP 與品牌客戶為主要動能。",
        "category": "AI 伺服器",
        "cagr": "30%+",
        "indicators": [
            {"label": "主要業務", "value": "整機 / 模組組裝"},
            {"label": "核心客戶", "value": "北美 CSP / NVIDIA"},
            {"label": "趨勢", "value": "整機櫃 / 液冷"},
            {"label": "代表廠商", "value": "鴻海 / 廣達 / 緯穎"},
        ],
        "members": {"midstream": ["2317", "2382", "3231", "6669", "2356", "2376"]},
    },
    "ai-server-cooling": {
        "name": "AI 伺服器｜散熱",
        "desc": "AI 伺服器高功耗推升散熱需求,氣冷轉液冷與均熱片、水冷板題材。",
        "category": "AI 伺服器",
        "cagr": "20%+",
        "indicators": [
            {"label": "技術轉換", "value": "氣冷 → 液冷"},
            {"label": "主要產品", "value": "均熱片 / 水冷板"},
            {"label": "需求動能", "value": "GB200 / 高功耗"},
            {"label": "代表廠商", "value": "奇鋐 / 雙鴻"},
        ],
        "members": {"midstream": ["3017", "3324", "2421", "8996", "3483"]},
    },
    "ai-server-power": {
        "name": "AI 伺服器｜電源",
        "desc": "AI 伺服器電源供應器與電源轉換,高功率密度與高壓直流為升級重點。",
        "category": "AI 伺服器",
        "cagr": "15%+",
        "indicators": [
            {"label": "主要產品", "value": "PSU / 電源轉換"},
            {"label": "技術趨勢", "value": "高壓直流 / 高密度"},
            {"label": "需求動能", "value": "AI 機櫃功耗"},
            {"label": "代表廠商", "value": "台達電 / 光寶科"},
        ],
        "members": {"midstream": ["2308", "2301", "6412", "6282", "3015"]},
    },
    "ai-server-pcb": {
        "name": "AI 伺服器｜PCB 與載板",
        "desc": "AI 伺服器高層數 PCB、高速 CCL 與 IC 載板,規格升級帶動量價齊揚。",
        "category": "AI 伺服器",
        "cagr": "10–15%",
        "indicators": [
            {"label": "主要產品", "value": "高層板 / CCL / 載板"},
            {"label": "技術趨勢", "value": "高速 / 高層數"},
            {"label": "需求動能", "value": "AI 加速卡 / 交換器"},
            {"label": "代表廠商", "value": "金像電 / 台光電"},
        ],
        "members": {"midstream": ["2368", "3044", "3037", "8046", "2383"]},
    },
    "ai-server-chassis": {
        "name": "AI 伺服器｜機殼與連接",
        "desc": "AI 伺服器機殼、滑軌與高速連接器,高電流與高速傳輸需求升溫。",
        "category": "AI 伺服器",
        "cagr": "12–15%",
        "indicators": [
            {"label": "主要產品", "value": "機殼 / 滑軌 / 連接器"},
            {"label": "規格升級", "value": "224G / 大電流"},
            {"label": "需求動能", "value": "整機櫃出貨"},
            {"label": "代表廠商", "value": "勤誠 / 嘉澤"},
        ],
        "members": {"midstream": ["8210", "3693", "2059", "3533"]},
    },

    # --- 光通訊 ---
    "opt-transceiver": {
        "name": "光通訊｜光收發模組",
        "desc": "AI 資料中心高速光收發模組(Transceiver),速率由 800G 邁向 1.6T,需求隨算力擴張。",
        "category": "光通訊",
        "cagr": "25%+",
        "indicators": [
            {"label": "主要產品", "value": "光收發模組"},
            {"label": "速率升級", "value": "800G → 1.6T"},
            {"label": "需求動能", "value": "AI 資料中心"},
            {"label": "代表廠商", "value": "眾達-KY / 華星光"},
        ],
        "members": {"midstream": ["4908", "4977", "4979", "3701", "3710", "6442"]},
    },
    "opt-laser": {
        "name": "光通訊｜雷射與光晶片",
        "desc": "光通訊用雷射二極體與化合物半導體光晶片,涵蓋砷化鎵/磷化銦磊晶與封裝。",
        "category": "光通訊",
        "cagr": "15%+",
        "indicators": [
            {"label": "主要產品", "value": "雷射二極體 / 光晶片"},
            {"label": "材料基礎", "value": "砷化鎵 / 磷化銦"},
            {"label": "主要應用", "value": "光通訊 / 感測"},
            {"label": "代表廠商", "value": "全新 / 聯亞"},
        ],
        "members": {"midstream": ["2455", "2426", "3081", "3339", "3450", "6597"]},
    },

    # --- 被動元件 ---
    "pas-mlcc": {
        "name": "被動元件｜MLCC 積層陶瓷電容",
        "desc": "積層陶瓷電容,電子產品被動元件基礎;車用與 AI 帶動高容高壓規格升級。",
        "category": "被動元件",
        "cagr": "8%+",
        "indicators": [
            {"label": "主要產品", "value": "積層陶瓷電容"},
            {"label": "升級驅動", "value": "車用 / AI"},
            {"label": "台廠龍頭", "value": "國巨"},
            {"label": "規格趨勢", "value": "高容 / 高壓"},
        ],
        "members": {"midstream": ["2327", "2492", "3026", "6173", "1471"]},
    },
    "pas-resistor": {
        "name": "被動元件｜晶片電阻",
        "desc": "晶片電阻與電阻陣列,應用於消費、車用與工控;車規與高精度為升級方向。",
        "category": "被動元件",
        "cagr": "5–8%",
        "indicators": [
            {"label": "主要產品", "value": "晶片電阻"},
            {"label": "主要應用", "value": "車用 / 消費 / 工控"},
            {"label": "代表廠商", "value": "國巨 / 大毅"},
            {"label": "規格趨勢", "value": "車規 / 高精度"},
        ],
        "members": {"midstream": ["2327", "2478", "2375", "6834"]},
    },
    "pas-inductor": {
        "name": "被動元件｜電感",
        "desc": "電感與磁性元件,AI 電源與車用電子帶動高頻、大電流規格需求。",
        "category": "被動元件",
        "cagr": "8%+",
        "indicators": [
            {"label": "主要產品", "value": "電感 / 磁性元件"},
            {"label": "需求動能", "value": "AI 電源 / 車用"},
            {"label": "代表廠商", "value": "千如 / 臺慶科"},
            {"label": "規格趨勢", "value": "高頻 / 大電流"},
        ],
        "members": {"midstream": ["3236", "3357", "3117", "3207", "3058"]},
    },

    # --- 散熱冷卻 ---
    "cool-module": {
        "name": "散熱冷卻｜散熱模組(氣冷)",
        "desc": "散熱風扇、均熱片與散熱模組,伺服器與 PC 高功耗推升氣冷需求。",
        "category": "散熱冷卻",
        "cagr": "20%+",
        "indicators": [
            {"label": "主要產品", "value": "散熱模組 / 風扇"},
            {"label": "主要應用", "value": "伺服器 / PC"},
            {"label": "台廠龍頭", "value": "奇鋐 / 雙鴻"},
            {"label": "需求動能", "value": "AI 高功耗"},
        ],
        "members": {"midstream": ["3017", "3324", "2421", "6230", "2354"]},
    },
    "cool-liquid": {
        "name": "散熱冷卻｜液冷",
        "desc": "AI 機櫃高功耗推升液冷滲透,涵蓋水冷板、CDU、快接與分歧管。",
        "category": "散熱冷卻",
        "cagr": "30%+",
        "indicators": [
            {"label": "核心技術", "value": "液冷 / 水冷板"},
            {"label": "關鍵元件", "value": "CDU / 快接"},
            {"label": "需求動能", "value": "AI 機櫃"},
            {"label": "代表廠商", "value": "雙鴻 / 高力"},
        ],
        "members": {"midstream": ["3324", "3017", "8996", "6125", "2241"]},
    },

    # --- 光學顯示 ---
    "disp-panel": {
        "name": "光學顯示｜面板",
        "desc": "大尺寸與中小尺寸面板,雙虎轉型利基與車載應用,搭配 OLED/Mini LED 升級。",
        "category": "光學顯示",
        "cagr": "低個位數",
        "indicators": [
            {"label": "主要產品", "value": "LCD / OLED 面板"},
            {"label": "雙虎", "value": "友達 / 群創"},
            {"label": "轉型方向", "value": "車載 / 利基"},
            {"label": "市場特性", "value": "景氣循環"},
        ],
        "members": {"midstream": ["2409", "3481", "6116", "8105"]},
    },
    "disp-lens": {
        "name": "光學顯示｜光學鏡頭",
        "desc": "手機與車用光學鏡頭模組,車用滲透與多鏡頭趨勢帶動規格升級。",
        "category": "光學顯示",
        "cagr": "8–10%",
        "indicators": [
            {"label": "主要產品", "value": "光學鏡頭"},
            {"label": "主要應用", "value": "手機 / 車用"},
            {"label": "全球龍頭", "value": "大立光"},
            {"label": "成長動能", "value": "車用滲透"},
        ],
        "members": {"midstream": ["3008", "3406", "3019", "3362", "4976"]},
    },

    # --- 電子零組件 ---
    "comp-chassis": {
        "name": "電子零組件｜機殼與結構件",
        "desc": "伺服器與 PC 機殼、機構件與散熱結構,AI 伺服器整機櫃帶動需求。",
        "category": "電子零組件",
        "cagr": "15%+",
        "indicators": [
            {"label": "主要產品", "value": "機殼 / 結構件"},
            {"label": "主要應用", "value": "伺服器 / PC"},
            {"label": "需求動能", "value": "AI 伺服器"},
            {"label": "代表廠商", "value": "勤誠 / 營邦"},
        ],
        "members": {"midstream": ["8210", "3693", "3013", "6235", "5392"]},
    },

    # --- 能源車用 ---
    "ev-battery": {
        "name": "能源車用｜電池與電池材料",
        "desc": "鋰電池正負極材料、電解液與電芯,電動車與儲能雙引擎驅動需求。",
        "category": "能源車用",
        "cagr": "15%+",
        "indicators": [
            {"label": "主要環節", "value": "正負極材料 / 電芯"},
            {"label": "主要應用", "value": "電動車 / 儲能"},
            {"label": "主流技術", "value": "磷酸鋰鐵"},
            {"label": "代表廠商", "value": "美琪瑪 / 康普"},
        ],
        "members": {"upstream": ["4721", "4739", "8038", "1723", "6781"]},
    },
    "ev-charge": {
        "name": "能源車用｜充電與快充",
        "desc": "充電樁、車載充電器與快充電源,隨電動車滲透與基礎建設擴張成長。",
        "category": "能源車用",
        "cagr": "15%+",
        "indicators": [
            {"label": "主要產品", "value": "充電樁 / 快充"},
            {"label": "主要應用", "value": "電動車 / 基建"},
            {"label": "技術趨勢", "value": "高壓快充"},
            {"label": "代表廠商", "value": "飛宏 / 健和興"},
        ],
        "members": {"midstream": ["2457", "3003", "2308", "1503", "1514"]},
    },
    "ev-electronics": {
        "name": "能源車用｜車用電子與零件",
        "desc": "車用感測、車燈、胎壓與連接零組件,車用滲透與電動化帶動規格升級。",
        "category": "能源車用",
        "cagr": "8–10%",
        "indicators": [
            {"label": "主要產品", "value": "感測 / 車燈 / 連接"},
            {"label": "主要應用", "value": "車用電子"},
            {"label": "成長動能", "value": "車用滲透 / ADAS"},
            {"label": "代表廠商", "value": "為升 / 怡利電"},
        ],
        "members": {"midstream": ["2231", "3552", "1522", "2497", "1533", "4551"]},
    },

    # --- 基板材料 ---
    "sub-ccl": {
        "name": "基板材料｜銅箔基板 CCL",
        "desc": "PCB 與載板核心基材銅箔基板 (CCL),AI 伺服器帶動高速低損耗材料需求。",
        "category": "基板材料",
        "cagr": "10%+",
        "indicators": [
            {"label": "主要產品", "value": "銅箔基板 CCL"},
            {"label": "主要應用", "value": "AI PCB / 載板"},
            {"label": "技術趨勢", "value": "高速 / 低損耗"},
            {"label": "代表廠商", "value": "台光電 / 聯茂"},
        ],
        "members": {"upstream": ["2383", "6213", "6274"]},
    },
    "sub-glass": {
        "name": "基板材料｜玻纖布與樹脂",
        "desc": "PCB 基材上游玻纖布、玻纖紗與樹脂,低介電 (Low-Dk) 規格隨高速板升級。",
        "category": "基板材料",
        "cagr": "高個位數",
        "indicators": [
            {"label": "主要產品", "value": "玻纖布 / 玻纖紗"},
            {"label": "主要應用", "value": "PCB 基材"},
            {"label": "技術趨勢", "value": "低介電 Low-Dk"},
            {"label": "代表廠商", "value": "富喬 / 台玻"},
        ],
        "members": {"upstream": ["1815", "1802", "5340"]},
    },

    # --- 網路設備 ---
    "net-equip": {
        "name": "網路設備｜網通設備",
        "desc": "交換器、路由器與閘道器,企業/電信/雲端網路升級與 400G/800G 交換器需求。",
        "category": "網路設備",
        "cagr": "8–10%",
        "indicators": [
            {"label": "主要產品", "value": "交換器 / 路由 / 閘道"},
            {"label": "主要客戶", "value": "企業 / 電信 / 雲端"},
            {"label": "技術趨勢", "value": "400G / 800G"},
            {"label": "代表廠商", "value": "智邦 / 啟碁"},
        ],
        "members": {"midstream": ["2345", "3596", "5388", "6285", "2332", "3380"]},
    },

    # --- 衛星通訊 ---
    "sat-ground": {
        "name": "衛星通訊｜地面設備與天線",
        "desc": "低軌衛星地面站、天線與射頻模組,Starlink 等供應鏈帶動新興需求。",
        "category": "衛星通訊",
        "cagr": "15–20%",
        "indicators": [
            {"label": "主要環節", "value": "地面站 / 天線 / 射頻"},
            {"label": "主要應用", "value": "低軌衛星"},
            {"label": "成長動能", "value": "Starlink 供應鏈"},
            {"label": "代表廠商", "value": "昇達科 / 台揚"},
        ],
        "members": {"midstream": ["3491", "6285", "3178", "2314", "2312"]},
    },

    # --- 消費終端 ---
    "con-brand": {
        "name": "消費終端｜品牌與系統廠",
        "desc": "PC/NB 品牌、主機板與系統組裝,AI PC 換機潮與電競需求帶動。",
        "category": "消費終端",
        "cagr": "低個位數",
        "indicators": [
            {"label": "主要產品", "value": "PC / NB / 主機板"},
            {"label": "主要應用", "value": "消費 / 電競 / AI PC"},
            {"label": "成長動能", "value": "AI PC 換機"},
            {"label": "代表廠商", "value": "華碩 / 宏碁"},
        ],
        "members": {"midstream": ["2357", "2353", "2376", "2377", "4938", "2324"]},
    },

    # --- 智慧機器人 ---
    "robot-motion": {
        "name": "智慧機器人｜傳動與減速機",
        "desc": "機器人核心傳動元件:諧波/行星減速機、滾珠螺桿與線性滑軌,人形機器人帶動新需求。",
        "category": "智慧機器人",
        "cagr": "15%+",
        "indicators": [
            {"label": "主要產品", "value": "減速機 / 滾珠螺桿 / 滑軌"},
            {"label": "主要應用", "value": "工業 / 人形機器人"},
            {"label": "台廠龍頭", "value": "上銀"},
            {"label": "成長動能", "value": "人形機器人"},
        ],
        "members": {"midstream": ["2049", "1597", "4540", "4583", "1536", "2233"]},
    },
    "robot-system": {
        "name": "智慧機器人｜機器人與自動化",
        "desc": "工業機器人、協作機械臂與自動化整合,智慧製造與機器視覺帶動需求。",
        "category": "智慧機器人",
        "cagr": "15%+",
        "indicators": [
            {"label": "主要產品", "value": "機器人 / 自動化整合"},
            {"label": "主要應用", "value": "智慧製造"},
            {"label": "技術趨勢", "value": "協作 / 機器視覺"},
            {"label": "代表廠商", "value": "所羅門 / 盟立"},
        ],
        "members": {"midstream": ["2359", "2464", "6125", "6188", "2365", "3023"]},
    },

    # --- 軟體資安 ---
    "soft-security": {
        "name": "軟體資安｜資安",
        "desc": "資安防護、監控與顧問服務,政府與企業法遵需求及零信任趨勢帶動。",
        "category": "軟體資安",
        "cagr": "15%+",
        "indicators": [
            {"label": "主要服務", "value": "資安防護 / 監控"},
            {"label": "主要客戶", "value": "政府 / 企業"},
            {"label": "技術趨勢", "value": "零信任 / 法遵"},
            {"label": "代表廠商", "value": "安碁資訊 / 關貿"},
        ],
        "members": {"midstream": ["6690", "6183", "3029", "2433"]},
    },
    "soft-si": {
        "name": "軟體資安｜系統整合與軟體",
        "desc": "企業系統整合、ERP 與軟體服務,雲端遷移與 AI 導入帶動專案需求。",
        "category": "軟體資安",
        "cagr": "高個位數",
        "indicators": [
            {"label": "主要服務", "value": "系統整合 / 軟體"},
            {"label": "主要客戶", "value": "企業 / 金融"},
            {"label": "技術趨勢", "value": "雲端 / AI 導入"},
            {"label": "代表廠商", "value": "精誠 / 敦陽科"},
        ],
        "members": {"midstream": ["6214", "2453", "2480", "2471", "2468"]},
    },

    # --- 金融航運 ---
    "fin-shipping": {
        "name": "金融航運｜航運",
        "desc": "貨櫃與散裝航運,運價循環、紅海繞道與供需為主要驅動。",
        "category": "金融航運",
        "cagr": "循環性",
        "indicators": [
            {"label": "主要業務", "value": "貨櫃 / 散裝航運"},
            {"label": "台廠龍頭", "value": "長榮 / 陽明"},
            {"label": "市場特性", "value": "運價循環明顯"},
            {"label": "成長動能", "value": "運價 / 供需"},
        ],
        "members": {"midstream": ["2603", "2609", "2615", "2606", "2637"]},
    },
    "fin-bank": {
        "name": "金融航運｜金融",
        "desc": "金融控股:銀行、壽險與證券,升息環境、財富管理與高殖利率題材。",
        "category": "金融航運",
        "cagr": "穩健",
        "indicators": [
            {"label": "主要業務", "value": "銀行 / 壽險 / 證券"},
            {"label": "台廠龍頭", "value": "富邦金 / 國泰金"},
            {"label": "成長動能", "value": "財富管理 / 升息"},
            {"label": "投資特性", "value": "高殖利率"},
        ],
        "members": {"midstream": ["2881", "2882", "2891", "2886", "2884"]},
    },

    # --- 傳產工業 ---
    "ind-machine": {
        "name": "傳產工業｜工具機與自動化",
        "desc": "金屬切削工具機與工廠自動化設備,製造業資本支出與產線回流帶動。",
        "category": "傳產工業",
        "cagr": "循環性",
        "indicators": [
            {"label": "主要產品", "value": "工具機 / 自動化"},
            {"label": "主要應用", "value": "製造業設備投資"},
            {"label": "市場特性", "value": "景氣循環"},
            {"label": "代表廠商", "value": "程泰 / 亞崴"},
        ],
        "members": {"midstream": ["1583", "1530", "4526", "4510", "1528"]},
    },
    "ind-power": {
        "name": "傳產工業｜重電與機電",
        "desc": "變壓器、開關與重電設備,AI 資料中心電力需求與電網升級題材火熱。",
        "category": "傳產工業",
        "cagr": "20%+",
        "indicators": [
            {"label": "主要產品", "value": "變壓器 / 重電設備"},
            {"label": "成長動能", "value": "AI 電力 / 電網升級"},
            {"label": "台廠龍頭", "value": "華城 / 中興電"},
            {"label": "產業趨勢", "value": "電網基礎建設"},
        ],
        "members": {"midstream": ["1519", "1513", "1503", "1514", "2371"]},
    },

    # --- 國防軍工(新分類)---
    "def-aero": {
        "name": "國防軍工｜航太",
        "desc": "航太機體零件、發動機件與 MRO 維修,受惠國機國造、民航復甦與國防預算成長。",
        "category": "國防軍工",
        "cagr": "穩健成長",
        "indicators": [
            {"label": "主要業務", "value": "機體零件 / MRO"},
            {"label": "核心客戶", "value": "Boeing / Airbus / 國防部"},
            {"label": "成長動能", "value": "國機國造 / 民航復甦"},
            {"label": "代表廠商", "value": "漢翔 / 長榮航太"},
        ],
        "members": {"upstream": ["4541", "4572", "8222", "4546"], "midstream": ["2634", "2645", "2630"]},
    },
    "def-ship": {
        "name": "國防軍工｜造船",
        "desc": "軍艦與商船建造,國艦國造、潛艦國造與海巡擴編帶動長線需求。",
        "category": "國防軍工",
        "cagr": "政策驅動",
        "indicators": [
            {"label": "主要業務", "value": "軍艦 / 商船"},
            {"label": "成長動能", "value": "國艦國造 / 潛艦"},
            {"label": "核心客戶", "value": "海軍 / 海巡"},
            {"label": "代表廠商", "value": "台船 / 龍德造船"},
        ],
        "members": {"midstream": ["2208", "6753", "2644"]},
    },
    "def-electronics": {
        "name": "國防軍工｜無人機與軍用電子",
        "desc": "軍規電腦、無人機與軍用電子,不對稱戰力與國防預算成長驅動。",
        "category": "國防軍工",
        "cagr": "15%+",
        "indicators": [
            {"label": "主要產品", "value": "軍規電腦 / 無人機"},
            {"label": "成長動能", "value": "不對稱戰力 / 國防預算"},
            {"label": "產品特性", "value": "軍規認證"},
            {"label": "代表廠商", "value": "茂訊 / 事欣科"},
        ],
        "members": {"midstream": ["3213", "4916", "3229"]},
    },

    # --- 人形機器人(歸 智慧機器人)---
    "humanoid-robot": {
        "name": "人形機器人",
        "desc": "NVIDIA、Tesla Optimus 帶動的人形機器人供應鏈,台廠減速機、滾珠螺桿、致動與感測為核心。",
        "category": "智慧機器人",
        "cagr": "高成長(早期)",
        "indicators": [
            {"label": "核心零件", "value": "減速機 / 滾珠螺桿"},
            {"label": "推動者", "value": "NVIDIA / Tesla"},
            {"label": "台廠角色", "value": "傳動 / 致動 / 感測"},
            {"label": "產業階段", "value": "量產前夕"},
        ],
        "members": {"midstream": ["2049", "1536", "4540", "1597", "4583", "2233", "4571", "3060"]},
    },

    # --- 玻璃基板(歸 基板材料)---
    "glass-substrate": {
        "name": "玻璃基板 Glass Substrate",
        "desc": "下一代先進封裝核心基板,玻璃取代 ABF/矽中介層;台積電、Intel 推進,台廠玻璃與加工卡位。",
        "category": "基板材料",
        "cagr": "新興高成長",
        "indicators": [
            {"label": "核心技術", "value": "玻璃核心基板"},
            {"label": "取代對象", "value": "ABF 載板 / 矽中介層"},
            {"label": "推進者", "value": "台積電 / Intel"},
            {"label": "台廠角色", "value": "玻璃 / 加工 / 設備"},
        ],
        "members": {"upstream": ["1815", "1802", "1809"], "midstream": ["3149", "3037", "3615", "2409"]},
    },

    # --- 折疊機(歸 消費終端)---
    "foldable": {
        "name": "折疊機",
        "desc": "折疊手機供應鏈,核心在軸承(鉸鏈)、UTG 超薄玻璃與機構件;三星領先、Apple 傳聞帶動滲透。",
        "category": "消費終端",
        "cagr": "高成長(新品)",
        "indicators": [
            {"label": "核心零件", "value": "軸承 / UTG 玻璃"},
            {"label": "推動者", "value": "三星 / Apple(傳聞)"},
            {"label": "台廠角色", "value": "鉸鏈 / 機構 / 玻璃"},
            {"label": "產業階段", "value": "滲透率起步"},
        ],
        "members": {"midstream": ["3376", "3548", "6805", "1582", "2354", "3149"]},
    },

    # --- 電線電纜(歸 傳產工業,與重電並列補完電網/AI電力)---
    "grid-cable": {
        "name": "傳產工業｜電線電纜",
        "desc": "高壓電纜與海纜,受惠電網升級、AI 資料中心用電與離岸風電;與重電並列電力基建。",
        "category": "傳產工業",
        "cagr": "穩健成長",
        "indicators": [
            {"label": "主要產品", "value": "高壓電纜 / 海纜"},
            {"label": "需求動能", "value": "電網升級 / AI 電力"},
            {"label": "台廠角色", "value": "電纜雙雄"},
            {"label": "產業趨勢", "value": "地下化 / 重電基建"},
        ],
        "members": {"midstream": ["1609", "1605", "1608", "1612", "1603"]},
    },
}

# ── 合併人工策展成員(buzzword 題材的成員校正);覆寫自動推導 → 清單乾淨且確定性(不依賴 WIP 報告) ──
try:
    from _curated_members import CURATED as _CURATED
    for _k, _m in _CURATED.items():
        if _k in THEME_DEFINITIONS:
            THEME_DEFINITIONS[_k]["members"] = _m
except Exception as _e:  # 缺檔/語法錯不應讓整個 build 失敗
    print(f"[warn] 無法載入 _curated_members.CURATED:{_e}")


_TIER_ZH = {"上游": "upstream", "中游": "midstream", "下游": "downstream"}
# 供應鏈段標題,如 **上游 (原料與設備):**(行首粗體、不以 - 開頭)
_TIER_HEAD_RE = re.compile(r"^\*\*\s*(上游|中游|下游)")
# 子分類項目,如 - **晶圓代工:** [[台積電]](行首 - 加粗體標籤)
_SUBCAT_RE = re.compile(r"^-\s*\*\*(.+?)\*\*")
_WL_RE = re.compile(r"\[\[([^\]]+)\]\]")


def scan_wikilinks():
    """Scan all reports.

    Return {wikilink: [{ticker, company, sector, role, subcat}]}.
    role  = upstream/midstream/downstream/related(由成員報告供應鏈段落推論)
    subcat= 該成員報告中該段落最近的粗體子標題(如「晶圓代工」),供角色分群子欄位用
    """
    wl_map = defaultdict(list)

    for sector_dir in os.listdir(REPORTS_DIR):
        sector_path = os.path.join(REPORTS_DIR, sector_dir)
        if not os.path.isdir(sector_path):
            continue
        for f in os.listdir(sector_path):
            if not f.endswith(".md"):
                continue
            m = re.match(r"^(\d{4})_(.+)\.md$", f)
            if not m:
                continue
            ticker, company = m.group(1), m.group(2)
            filepath = os.path.join(sector_path, f)
            with open(filepath, "r", encoding="utf-8") as fh:
                content = fh.read()

            # Split content into sections for context
            sections = {"desc": "", "supply_chain": "", "customers": ""}
            parts = re.split(r"## ", content)
            for part in parts:
                if part.startswith("業務簡介"):
                    sections["desc"] = part
                elif part.startswith("供應鏈位置"):
                    sections["supply_chain"] = part
                elif part.startswith("主要客戶及供應商"):
                    sections["customers"] = part

            # 每報告每 wikilink 只記一筆;供應鏈段以行序解析 tier + 子分類(先出現者為準)
            found = {}  # wl -> {role, subcat}

            current_tier = "related"
            current_subcat = ""
            for raw in sections["supply_chain"].split("\n"):
                line = raw.strip()
                th = _TIER_HEAD_RE.match(line)
                if th:
                    current_tier = _TIER_ZH[th.group(1)]
                    current_subcat = ""
                sc = _SUBCAT_RE.match(line)
                if sc:
                    # 去除子標題內的 wikilink 標記與多餘空白(避免 [[..]] 造成巢狀括號)
                    lbl = _WL_RE.sub(r"\1", sc.group(1))
                    lbl = re.sub(r"\s+", " ", lbl).strip().rstrip(":：").strip()
                    current_subcat = lbl
                for wl in _WL_RE.findall(line):
                    if wl not in found:
                        found[wl] = {"role": current_tier, "subcat": current_subcat}

            # 業務簡介 / 客戶段落補捉(未在供應鏈出現者 → related)
            for wl in _WL_RE.findall(sections["desc"] + sections["customers"]):
                if wl not in found:
                    found[wl] = {"role": "related", "subcat": ""}

            for wl, info in found.items():
                wl_map[wl].append(
                    {
                        "ticker": ticker,
                        "company": company,
                        "sector": sector_dir,
                        "role": info["role"],
                        "subcat": info["subcat"],
                    }
                )

    return wl_map


def scan_ticker_meta():
    """{ticker: {company, sector}} —— 由 Pilot_Reports 檔名建立,供策展子題材查名稱/產業。"""
    meta = {}
    for sector_dir in os.listdir(REPORTS_DIR):
        sector_path = os.path.join(REPORTS_DIR, sector_dir)
        if not os.path.isdir(sector_path):
            continue
        for f in os.listdir(sector_path):
            m = re.match(r"^(\d{4})_(.+)\.md$", f)
            if m:
                meta[m.group(1)] = {"company": m.group(2), "sector": sector_dir}
    return meta


def build_theme_page(theme_tag, theme_def, wl_map, ticker_meta=None):
    """Build a single theme markdown page.

    成員兩種來源:
    - 策展子題材:theme_def["members"] = {tier: [tickers]} → 依代號查名稱/產業
      (tier ∈ upstream/midstream/downstream;無 wikilink 標籤的細分題材用此)
    - wikilink 題材:掃描 wl_map[theme_tag](成員報告提及該標籤)
    """
    members = theme_def.get("members")
    if members:
        meta = ticker_meta or {}
        entries = []
        seen = set()  # 同題材內代號去重(首次出現的子分類為準)
        for tier in ("upstream", "midstream", "downstream"):
            tm = members.get(tier)
            if not tm:
                continue
            # 兩種格式:[tickers](無子分類) 或 {subcat: [tickers]}(含子分類,供大題材分群)
            pairs = (
                [(tk, sub) for sub, tks in tm.items() for tk in tks]
                if isinstance(tm, dict)
                else [(tk, "") for tk in tm]
            )
            for tk, sub in pairs:
                if tk in seen:
                    continue
                seen.add(tk)
                m = meta.get(tk)
                if not m:
                    print(f"  [warn] {theme_tag}: 代號 {tk} 不在涵蓋範圍,略過")
                    continue
                entries.append({
                    "ticker": tk,
                    "company": m["company"],
                    "sector": m["sector"],
                    "role": tier,
                    "subcat": sub,
                })
        if not entries:
            return None
    else:
        entries = wl_map.get(theme_tag, [])
        if not entries:
            return None

    lines = []
    lines.append(f"# {theme_def['name']}")
    lines.append("")
    lines.append(f"> {theme_def['desc']}")
    lines.append("")
    # 涵蓋家數:只計入實際列入供應鏈(上/中/下游)者,與價值鏈結構/角色分群/熱力圖一致
    tier_n = sum(1 for e in entries if e.get("role") in ("upstream", "midstream", "downstream"))
    lines.append(f"**涵蓋公司數:** {tier_n}")
    lines.append("")

    # Curated metadata (分類必填;CAGR/市場規模/關鍵指標 選填,有才輸出)
    if theme_def.get("category"):
        lines.append(f"**分類:** {theme_def['category']}")
        lines.append("")
    if theme_def.get("cagr"):
        lines.append(f"**CAGR:** {theme_def['cagr']}")
        lines.append("")
    if theme_def.get("market_size"):
        lines.append(f"**市場規模:** {theme_def['market_size']}")
        lines.append("")
    if theme_def.get("indicators"):
        joined = " | ".join(
            f"{d['label']}={d['value']}" for d in theme_def["indicators"]
        )
        lines.append(f"**關鍵指標:** {joined}")
        lines.append("")

    # Related themes
    related = theme_def.get("related", [])
    related_with_counts = []
    for r in related:
        count = len(wl_map.get(r, []))
        if count > 0:
            related_with_counts.append(f"[[{r}]] ({count})")
    if related_with_counts:
        lines.append(f"**相關主題:** {' | '.join(related_with_counts)}")
        lines.append("")

    lines.append("---")
    lines.append("")

    # Group by role
    upstream = [e for e in entries if e["role"] == "upstream"]
    midstream = [e for e in entries if e["role"] == "midstream"]
    downstream = [e for e in entries if e["role"] == "downstream"]
    other = [e for e in entries if e["role"] == "related"]

    def format_entries(entries):
        # 依 子分類 → 產業 → 代號 排序,讓同子分類成員相鄰(子分類為空者排最後)
        rows = sorted(
            entries,
            key=lambda e: (e.get("subcat") or "￿", e["sector"], e["ticker"]),
        )
        result = []
        for e in rows:
            sub = (e.get("subcat") or "").strip()
            suffix = f" [{sub}]" if sub else ""
            result.append(
                f"- **{e['ticker']} {e['company']}** ({e['sector']}){suffix}"
            )
        return result

    if upstream:
        lines.append(f"## 上游 ({len(upstream)})")
        lines.append("")
        lines.extend(format_entries(upstream))
        lines.append("")

    if midstream:
        lines.append(f"## 中游 ({len(midstream)})")
        lines.append("")
        lines.extend(format_entries(midstream))
        lines.append("")

    if downstream:
        lines.append(f"## 下游 ({len(downstream)})")
        lines.append("")
        lines.extend(format_entries(downstream))
        lines.append("")

    # 註:role="related"(僅提及、未列入上中下游)者不輸出,亦不計入涵蓋家數,
    # 以確保「涵蓋家數」與頁面實際呈現的供應鏈一致。

    return "\n".join(lines)


def build_index(themes_built):
    """Build themes/README.md index."""
    lines = []
    lines.append("# Thematic Investment Screens")
    lines.append("")
    lines.append("> Auto-generated supply chain maps for thematic investing.")
    lines.append("> Regenerate: `python scripts/build_themes.py`")
    lines.append("")
    lines.append("---")
    lines.append("")

    # Group by category
    categories = {
        "先進封裝": ["CoWoS", "HBM", "CPO"],
        "光電與化合物半導體": ["矽光子", "VCSEL", "碳化矽", "氮化鎵", "磷化銦"],
        "AI / 資料中心": ["AI 伺服器", "資料中心", "NVIDIA"],
        "電動車 / 車用": ["電動車", "Tesla"],
        "通訊": ["5G", "低軌衛星"],
        "製程與設備": ["EUV"],
        "材料": ["光阻液", "ABF 載板", "矽晶圓"],
        "品牌供應鏈": ["Apple", "NVIDIA", "Tesla"],
    }

    for cat_name, tags in categories.items():
        lines.append(f"## {cat_name}")
        lines.append("")
        for tag in tags:
            if tag in themes_built:
                count = themes_built[tag]
                safe_name = tag.replace(" ", "_").replace("/", "_")
                lines.append(f"- [{tag}]({safe_name}.md) — {count} 家公司")
        lines.append("")

    return "\n".join(lines)


def main():
    if sys.platform == "win32":
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    os.makedirs(THEMES_DIR, exist_ok=True)

    args = sys.argv[1:]

    if "--list" in args:
        for tag, defn in sorted(THEME_DEFINITIONS.items()):
            print(f"  {tag}: {defn['name']}")
        return

    print("Scanning wikilinks across all reports...")
    wl_map = scan_wikilinks()
    ticker_meta = scan_ticker_meta()
    print(f"Found {len(wl_map)} unique wikilinks, {len(ticker_meta)} tickers.\n")

    # Filter to requested theme(s) or build all
    if "--curated" in args:
        # 只重建有人工策展成員的 buzzword 題材(WIP-safe;不動其餘題材的 .md)
        from _curated_members import CURATED as _C
        themes_to_build = {k: THEME_DEFINITIONS[k] for k in _C if k in THEME_DEFINITIONS}
    elif args and args[0] != "--list":
        themes_to_build = {args[0]: THEME_DEFINITIONS.get(args[0])}
        if not themes_to_build[args[0]]:
            print(f"Theme '{args[0]}' not in THEME_DEFINITIONS. Use --list to see available themes.")
            return
    else:
        themes_to_build = THEME_DEFINITIONS

    themes_built = {}
    for tag, defn in themes_to_build.items():
        page = build_theme_page(tag, defn, wl_map, ticker_meta)
        if page:
            safe_name = tag.replace(" ", "_").replace("/", "_")
            filepath = os.path.join(THEMES_DIR, f"{safe_name}.md")
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(page)
            if defn.get("members"):
                count = sum(
                    sum(len(tks) for tks in tier.values()) if isinstance(tier, dict) else len(tier)
                    for tier in defn["members"].values()
                )
            else:
                count = len(wl_map.get(tag, []))
            themes_built[tag] = count
            print(f"  {tag}: {count} companies -> {safe_name}.md")

    # Build index
    index = build_index(themes_built)
    with open(os.path.join(THEMES_DIR, "README.md"), "w", encoding="utf-8") as f:
        f.write(index)

    print(f"\nDone. Generated {len(themes_built)} theme pages in themes/")


if __name__ == "__main__":
    main()
