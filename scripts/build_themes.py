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
        "category": "半導體",
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
        "category": "半導體",
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
        "category": "通信網路",
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
        "category": "通信網路",
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
        "category": "通信網路",
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
        "category": "汽車",
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
        "category": "汽車",
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
        "category": "通信網路",
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
        "category": "電腦週邊",
        "cagr": "30%+",
        "indicators": [
            {"label": "技術核心", "value": "GPU 加速運算"},
            {"label": "主流架構", "value": "NVIDIA HGX / GB200"},
            {"label": "核心客戶", "value": "北美 CSP"},
            {"label": "產業地位", "value": "AI 算力基礎"},
        ],
    },
    "資料中心": {
        "name": "資料中心供應鏈",
        "desc": "超大規模資料中心基礎設施，涵蓋伺服器、網通、電源、散熱",
        "related": ["AI 伺服器", "CPO", "矽光子", "PCB"],
        "category": "電腦週邊",
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
        "category": "汽車",
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
        "category": "通信網路",
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
        "category": "前瞻科技",
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
        "category": "半導體",
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
        "category": "半導體",
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
        "category": "半導體",
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
        "category": "半導體",
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
        "category": "電腦週邊",
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
        "category": "電腦週邊",
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
        "category": "汽車",
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
        "category": "印刷電路板",
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
        "category": "汽車",
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
        "category": "印刷電路板",
        "cagr": "8–10%",
        "indicators": [
            {"label": "主力產品", "value": "電解銅箔"},
            {"label": "雙引擎", "value": "PCB 載板 / 鋰電負極"},
            {"label": "規格趨勢", "value": "極薄 / 高頻"},
            {"label": "台廠角色", "value": "南亞 / 長春 / 金居"},
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
        "category": "電腦週邊",
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
        "category": "電腦週邊",
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
        "category": "汽車",
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
        "category": "平面顯示器",
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
        "category": "平面顯示器",
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
        "category": "半導體",
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
        "category": "綠色能源",
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
        "category": "綠色能源",
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
        "category": "綠色能源",
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
        "category": "半導體",
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
        "category": "半導體",
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
        "category": "半導體",
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
        "category": "半導體",
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
        "category": "半導體",
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
        "category": "半導體",
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
        "category": "半導體",
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
        "category": "半導體",
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
        "category": "半導體",
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
        "category": "半導體",
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
        "category": "半導體",
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
        "category": "半導體",
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
        "category": "半導體",
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
        "category": "半導體",
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
        "category": "電腦週邊",
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
        "category": "電腦週邊",
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
        "category": "電腦週邊",
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
        "category": "電腦週邊",
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
        "category": "電腦週邊",
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
        "category": "通信網路",
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
        "category": "通信網路",
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
        "category": "電腦週邊",
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
        "category": "電腦週邊",
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
        "category": "平面顯示器",
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
        "category": "平面顯示器",
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
        "category": "電腦週邊",
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
        "category": "汽車",
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
        "category": "汽車",
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
        "category": "汽車",
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
        "category": "印刷電路板",
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
        "category": "印刷電路板",
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
        "category": "通信網路",
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
        "category": "前瞻科技",
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
        "category": "電腦週邊",
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
        "category": "自動化",
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
        "category": "自動化",
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
        "category": "數位科技",
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
        "category": "軟體服務",
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
    # 航運升級為 TPEx 完整交通運輸鏈(貨櫃/散裝/承攬/倉儲/大眾運輸,含航空高鐵)
    "fin-shipping": {
        "name": "金融航運｜運輸與航運",
        "desc": "涵蓋貨櫃航運、散裝航運、海陸空貨運承攬、倉儲集散與大眾運輸(含航空、高鐵)等運輸服務;結構參照櫃買中心產業價值鏈平台。",
        "category": "交通運輸及航運",
        "indicators": [{"label": "貨櫃航運", "value": "長榮 / 陽明 / 萬海"}, {"label": "散裝航運", "value": "裕民 / 慧洋"}, {"label": "航空運輸", "value": "華航 / 長榮航"}, {"label": "型態", "value": "服務型 (不分上中下游)"}],
        "members": {
            "midstream": {"貨櫃航運": ["2603", "2607", "2609", "2615", "8367"], "散裝航運": ["2605", "2606", "2612", "2614", "2617", "5608", "2637", "2641"], "海陸空貨運承攬": ["2608", "2636", "2642", "9917", "2643", "5609"], "貨櫃運輸集散及倉儲": ["1103", "2611", "2613", "2616", "2630", "5607", "5601", "5603"], "海陸空大眾運輸": ["2610", "2618", "2633", "2645", "2646", "6757", "8109"]},
        },
    },
    "fin-bank": {
        "name": "金融航運｜金融",
        "desc": "金融控股:銀行、壽險與證券,升息環境、財富管理與高殖利率題材。",
        "category": "金融",
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
        "category": "電機機械",
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
        "category": "電機機械",
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
        "category": "自動化",
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
        "category": "半導體",
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
        "category": "電腦週邊",
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
        "category": "電機機械",
        "cagr": "穩健成長",
        "indicators": [
            {"label": "主要產品", "value": "高壓電纜 / 海纜"},
            {"label": "需求動能", "value": "電網升級 / AI 電力"},
            {"label": "台廠角色", "value": "電纜雙雄"},
            {"label": "產業趨勢", "value": "地下化 / 重電基建"},
        ],
        "members": {"midstream": ["1609", "1605", "1608", "1612", "1603"]},
    },

    # ============================================================
    # 傳統產業鏈 —— 結構與成分股參照「櫃買中心 產業價值鏈資訊平台」
    # (ic.tpex.org.tw),members 採 {tier: {子分類: [代號]}};
    # 僅保留本庫已涵蓋之台股,跨層去重以維持涵蓋家數一致。
    # ============================================================
    "automobile": {
        "name": "汽車",
        "desc": "從汽車零配件(車燈、輪胎、鈑金、鋁圈等)、整車組裝到銷售通路的完整產業鏈;結構參照櫃買中心產業價值鏈平台。",
        "category": "汽車",
        "indicators": [
            {"label": "上游", "value": "車燈 / 輪胎 / 鈑金 / 鋁圈 / 零配件"},
            {"label": "中游", "value": "整車組裝、修理及技術服務"},
            {"label": "下游", "value": "銷售、進出口業務"},
            {"label": "台廠強項", "value": "售後維修 (AM) 零配件"},
        ],
        "related": ["電動車"],
        "members": {
            "upstream": {
                "車燈": ["1521", "1522", "1538", "2241", "2254", "2301",
                         "2340", "2459", "3437", "2248", "3226", "3685", "5230"],
                "輪胎": ["2101", "2102", "2106"],
                "鈑金": ["1319", "1524"],
                "鋁合金鋼圈": ["1563", "4502"],
                "保險桿": ["1339", "2239"],
                "其他": ["1503", "1506", "1512", "1525", "1533", "1536", "1568",
                         "1587", "2228", "2308", "2497", "3311", "3679", "3706",
                         "4551", "4590", "4976", "6283", "7788", "1338", "1785",
                         "2235", "3128", "3162", "3227", "3290", "3310", "3552",
                         "4554", "5356", "2245", "2249", "2252", "2255", "2256"],
            },
            "midstream": {
                "整車組裝、修理及技術服務": ["2201", "2204", "2206", "2227", "2231"],
            },
            "downstream": {
                "銷售、進出口業務": ["2207", "2247", "3609"],
            },
        },
    },
    "cement": {
        "name": "水泥",
        "desc": "從石灰石開採、水泥生料/熟料/成品製造到下游預拌混凝土的完整產業鏈;結構參照櫃買中心產業價值鏈平台。",
        "category": "水泥",
        "indicators": [{"label": "上游", "value": "石灰石"}, {"label": "中游", "value": "生料 / 熟料 / 水泥成品"}, {"label": "下游", "value": "預拌混凝土"}, {"label": "台廠龍頭", "value": "台泥 / 亞泥"}],
        "members": {
            "upstream": {"石灰石": ["1101", "1108", "1109"]},
            "midstream": {"水泥生料": ["8463"], "水泥熟料": ["1102"], "水泥成品": ["1103", "1104", "1110"]},
            "downstream": {"預拌混凝土": ["2504", "5520"]},
        },
    },
    "steel": {
        "name": "鋼鐵",
        "desc": "從上游鐵礦/廢鋼、中游冶煉軋延(含不鏽鋼、特殊鋼)到下游鋼鐵製品/螺絲螺帽的完整鋼鐵產業鏈;結構參照櫃買中心產業價值鏈平台。",
        "category": "鋼鐵",
        "indicators": [{"label": "上游", "value": "鐵礦 / 廢鋼 / 焦炭"}, {"label": "中游", "value": "冶煉 / 軋延 / 不鏽鋼"}, {"label": "下游", "value": "鋼板捲 / 螺絲螺帽 / 結構"}, {"label": "台廠龍頭", "value": "中鋼"}],
        "members": {
            "upstream": {"鋼胚": ["2002", "2006", "2015", "2028", "5009"], "煤、鐵礦砂、鎳鐵、鉻鐵、廢鋼": ["1605"], "不鏽鋼胚": ["2035", "9957"]},
            "midstream": {"冷熱軋鋼板捲": ["2008", "2009", "2010", "2014", "2023", "2029", "9907", "2073"], "鋼筋": ["2007", "2017", "2038"], "線材盤元": ["2012", "2022", "2064", "2071"], "冷熱軋不鏽鋼板捲": ["2025", "2034", "2069", "5014", "9962"], "不鏽鋼棒線": ["2063", "4950"], "裁剪加工": ["2031", "2032", "6248"], "製管": ["2020", "2027", "2030", "8936"]},
            "downstream": {"金屬製品": ["2013", "2211", "2351", "2415", "9924", "8411", "2221", "4503", "5013", "8930", "1594"], "運輸工具": ["3004"], "模具": ["5007", "5243"], "螺絲螺帽": ["5538", "2065", "5011", "5015", "8349", "8415"], "鋼線鋼纜": ["2024", "2033", "5016"]},
        },
    },
    "textile": {
        "name": "紡織",
        "desc": "從上游化纖原料、中游人造/天然纖維與織造印染到下游成衣的完整紡織產業鏈;結構參照櫃買中心產業價值鏈平台。",
        "category": "紡織",
        "indicators": [{"label": "上游", "value": "石化 / 化纖原料"}, {"label": "中游", "value": "人纖 / 織造 / 印染"}, {"label": "下游", "value": "染整 / 成衣"}, {"label": "台廠強項", "value": "機能性布料"}],
        "members": {
            "upstream": {"石化原料": ["1301", "1303", "1314", "1326", "1402", "1710"]},
            "midstream": {"人造纖維產品": ["1409", "1413", "1418", "1440", "1444", "1447", "1452", "1455", "1456", "1457", "1459", "1464", "1465", "1466", "1468", "4440", "4401", "4402", "4406", "4420", "6618"], "天然纖維產品": ["1423"], "化學助劑": ["1713", "1727", "4739", "4764", "3430", "4706"], "紡紗": ["1414", "1434", "1441", "1445", "1449", "1451", "1453", "1454", "1460"], "織布": ["1419", "1446", "1474", "1476", "4426", "4431"]},
            "downstream": {"染整": ["1410", "1432", "1463", "1467", "1470", "1475", "4433"], "成衣及其它家居紡織類品": ["1315", "1417", "1473", "1477", "4414", "4438", "4441", "6504", "9919", "9944", "8404", "4413", "4417", "4432", "5450", "6506", "8916", "4442"]},
        },
    },
    "petrochem": {
        "name": "石化及塑橡膠",
        "desc": "從石化上游原料、中游石化中間原料到下游塑膠/橡膠/塗料製品的完整石化產業鏈;結構參照櫃買中心產業價值鏈平台。",
        "category": "石化及塑橡膠",
        "indicators": [{"label": "上游", "value": "石化原料"}, {"label": "中游", "value": "塑膠 / 橡膠 / 中間原料"}, {"label": "下游", "value": "塑膠製品 / 橡膠製品 / 塗料"}, {"label": "台廠龍頭", "value": "台塑 / 南亞"}],
        "members": {
            "upstream": {"石化上游原料及相關鑽探設備": ["1303", "1723", "6505", "7742"]},
            "midstream": {"石化中間原料": ["1314", "1326", "1402", "1725", "1727", "4739", "4721", "1709", "1714", "4707", "1304", "1308", "1717", "1721", "1735", "1776", "4764", "4770", "5234", "4716", "1711", "2104", "3430"]},
            "downstream": {"塑膠製品": ["1301", "1305", "1307", "1309", "1310", "1312", "1315", "1316", "1319", "1321", "1323", "1324", "1325", "1339", "1410", "1434", "1712", "1730", "2351", "3311", "4306", "6235", "6585", "9939", "1337", "1340", "4935", "4303", "4304", "4305", "4714", "5356", "6508", "8935", "9950", "1343"], "橡膠製品": ["2102", "2103", "2105", "2106", "2107", "2108", "2109", "2114", "6582", "2115", "7507"], "清潔用品": ["1732", "6504", "9919", "6509"], "人造纖維": ["1409", "6618"], "顏染料": ["4706", "4741", "4738", "4765"], "接著劑": ["1773", "4720", "4766", "4711", "4767", "6506"], "塑化劑": ["1313"]},
        },
    },
    "semiconductor": {
        "name": "半導體",
        "desc": "半導體產業鏈(上游 IC設計 / IP設計/IC設計代工服務、中游 光罩 / IC/晶圓製造 / 生產製程及檢測設備、下游 生產製程及檢測設備 / 基板 / 導線架);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "半導體",
        "indicators": [{"label": "上游", "value": "IC設計 / IP設計/IC設計代工服務"}, {"label": "中游", "value": "光罩 / IC/晶圓製造 / 生產製程及檢測設備"}, {"label": "下游", "value": "生產製程及檢測設備 / 基板 / 導線架"}],
        "members": {
            "upstream": {"IC設計": ["2308", "3014", "4961", "6415", "3288", "3527", "6129", "6138", "5468", "6568", "8016", "6732", "2401", "2436", "2454", "2458", "3034", "3041", "3150", "3530", "4919", "4952", "6695", "6756", "3073", "3122", "3268", "3556", "5236", "5272", "5302", "5487", "6103", "6237", "6462", "6494", "6684", "6720", "8024", "8054", "8102", "2337", "2344", "2408", "3006", "6531", "5351", "3259", "6485", "8299", "4925", "5471", "6202", "3228", "6229", "6679", "6716", "3257", "3588", "3592", "6719", "6799", "8081", "8261", "3317", "3438", "4923", "5299", "6291", "6435", "6651", "6693", "2379", "3094", "4968", "6526", "3169", "5274", "6708", "8040", "5269", "6243", "4951", "6104", "6233", "6411", "3545", "3141", "4966", "6927", "3227"], "IP設計/IC設計代工服務": ["3035", "3443", "5222", "6533", "3661", "3339", "3529", "6423", "6643", "8227", "6786"]},
            "midstream": {"光罩": ["2338", "2438"], "IC/晶圓製造": ["2303", "2330", "2340", "2371", "2434", "2455", "3016", "3532", "6770", "8028", "3105", "3707", "5347", "5483", "6182", "6488", "8086", "4991", "2302", "2342", "2481", "3234", "3675", "5425", "4971"], "生產製程及檢測設備": ["2360", "2467", "3030", "3413", "3535", "3583", "4949", "5434", "6277", "6438", "6515", "6658", "6706", "6789", "6909", "6937", "7730", "7769", "7795", "8374", "3114", "3178", "3402", "3455", "3467", "3485", "3551", "3680", "4772", "5493", "5536", "6207", "6208", "6223", "6510", "6532", "6613", "6664", "6667", "6683", "6725", "6735", "6788", "6823", "6829", "6877", "6895", "6953", "7556", "7704", "7728", "7828", "8027", "8091", "8383", "3595", "4537", "6812"], "化學品": ["1711", "1717", "1727", "2493", "3010", "3305", "4720", "4722", "4755", "4764", "5234", "1742", "1785", "3663", "4749", "4768", "6959"]},
            "downstream": {"生產製程及檢測設備": ["3055", "4770", "8070", "1595", "3093", "3131", "3219", "3490", "3581", "5443", "6218", "6261", "6640", "8064", "8092", "7815"], "基板": ["2459", "3189", "4938", "6271", "6552", "3444", "6920"], "導線架": ["2351", "2483", "2486", "3653", "5285", "3310", "6548"], "IC封裝測試": ["1410", "1434", "2329", "2369", "2441", "2449", "3450", "3711", "6239", "6257", "8110", "8131", "8150", "8162", "3264", "3265", "3372", "3374", "3567", "4760", "5344", "6147", "8109"], "IC模組": ["2451", "3135", "8271", "3260", "3360", "4973", "8088", "8277", "5262"], "IC通路": ["2347", "3026", "3028", "3033", "3036", "3048", "3209", "3312", "3528", "3702", "6189", "6192", "8112", "3224", "3232", "3537", "3555", "6113", "6227", "6265", "6270", "6474", "8032", "8067", "8068", "8084", "8096"]},
        },
    },
    "computer-peripheral": {
        "name": "電腦週邊",
        "desc": "電腦週邊產業鏈(上游 中央處理器 / 晶片組 / 面板、下游 筆記型電腦 / 桌上型電腦 / 工業電腦);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "電腦週邊",
        "indicators": [{"label": "上游", "value": "中央處理器 / 晶片組 / 面板"}, {"label": "下游", "value": "筆記型電腦 / 桌上型電腦 / 工業電腦"}],
        "members": {
            "upstream": {"中央處理器": ["2388", "3709", "8096"], "晶片組": ["6189", "6233"], "面板": ["2459", "3038", "5315", "6167"], "顯示器模組": ["2376", "3024", "3516", "5386"], "記憶體": ["2344", "2408", "2451", "3135", "4967", "8271", "3260", "4973", "6276", "8088", "8277", "8299"], "主機板": ["2312", "2317", "2331", "2357", "2377", "2399", "2425", "2483", "3022", "3515", "4938", "6161", "6245"], "機殼": ["1471", "2301", "2354", "2474", "3005", "3013", "3015", "3032", "3518", "3607", "4916", "6117", "6235", "8210", "1569", "3095", "3230", "3294", "3325", "3540", "5392", "5457", "5465", "8410"], "電源供應器": ["2308", "2360", "2385", "2413", "2420", "2431", "2457", "3058", "3308", "6282", "6412", "3078", "3332", "6109", "6203", "6220", "8093"], "網路卡": ["3169", "6143"], "電池": ["3026", "3211", "3323", "3625", "4931", "6121"], "散熱片、風扇馬達、散熱模組": ["2421", "3017", "3338", "6230", "6831", "4912", "6591", "3071", "3324", "3483", "3512", "5230", "6124", "6275", "8240", "5223"], "輸出入模組/介面卡": ["3272", "3577"], "顯示卡": ["2417", "2465", "6150"], "硬碟機": ["1785"], "磁碟儲存系統": ["2495", "3057", "3128", "3693"], "BIOS": ["6231"], "隨身碟、記憶卡讀卡機": ["3028", "3322", "5262"], "多功能視訊卡": ["5474"], "光學鏡片、鏡頭": ["2374", "3008", "3019", "3059", "3406", "3504", "4976", "6209", "6668", "6742", "3362", "3441", "3630", "6498", "6517", "6859", "5248", "5267", "6787"], "光碟片": ["2323", "2349", "2491", "3050"], "連接線": ["2328", "2392", "2440", "3011", "3023", "3092", "3550", "6115", "6205", "8103", "3665", "3114", "5488", "6134", "6418", "7861"], "機構樞紐": ["1582", "3376", "4999", "6805", "3548", "6755"], "金屬、塑膠模具": ["3679", "4545", "1336", "1586", "3310", "5460", "4924"], "其他電腦及週邊設備之零組件": ["1537", "1711", "2059", "2352", "2371", "2382", "2387", "2439", "2444", "2458", "2478", "3010", "3046", "3060", "3296", "3593", "3701", "4915", "6128", "6224", "6283", "6409", "6689", "6743", "8163", "8249", "8374", "4935", "5215", "3147", "3191", "3206", "3217", "3227", "3287", "3290", "3484", "3631", "5426", "6114", "6154", "6584", "7819", "8455", "6638", "6673", "6737", "6819"]},
            "downstream": {"筆記型電腦": ["2324", "2353", "2356", "2362", "2364", "2430", "3231", "3213", "6140", "6884", "8099"], "桌上型電腦": ["2405"], "工業電腦": ["2395", "2397", "3002", "3416", "3652", "6166", "6206", "6414", "6579", "6928", "3088", "3434", "3479", "3521", "3594", "3611", "5353", "5490", "6160", "6441", "6570", "6680", "6922", "8050", "8076", "8234", "3097", "6536", "6599", "6825"], "精簡型電腦": ["2426", "8119"], "伺服器": ["3706", "6669", "7711", "6218", "6221"], "其他電腦及週邊設備": ["2365", "2464", "3494", "3617", "3669", "5258", "6201", "6225", "6277", "6908", "8114", "9912", "3162", "3285", "3349", "3541", "3564", "3663", "5289", "5309", "6188", "6204", "7402", "8085", "3659"], "印表機、傳真機、掃瞄器、多功能事務機、投影機": ["2305", "2380", "3712", "4974", "4987", "5356", "5371", "5438", "6228", "8071"], "安全監控系統": ["1503", "2424", "3356", "3454", "5484", "3297", "5251", "5489", "6419", "6556", "6560", "5240"]},
        },
    },
    "comm-network": {
        "name": "通信網路",
        "desc": "通信網路產業鏈(上游 網路IC / 記憶體 / 主/被動元件、下游 網路設備 / 光通訊設備 / 無線通訊設備);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "通信網路",
        "indicators": [{"label": "上游", "value": "網路IC / 記憶體 / 主/被動元件"}, {"label": "下游", "value": "網路設備 / 光通訊設備 / 無線通訊設備"}],
        "members": {
            "upstream": {"網路IC": ["2459", "3169", "6470", "8096"], "記憶體": ["2344", "2408", "3260", "4973", "8084", "8088"], "主/被動元件": ["2466", "2476", "2478", "3026", "3450", "6792", "8011", "3081", "3152", "3221", "3234", "3491", "3710", "4908", "4979", "6204", "6284", "6530", "6818", "6820", "7812"], "印刷電路板": ["4909", "5439"], "塑膠/金屬機殼": ["3607", "5284", "1336", "3095", "3290", "3294", "5457", "5460", "8240"], "線材": ["1615", "1617", "1618", "2392", "3011", "3023", "6192", "6197", "6205", "3665", "3388", "6190", "6220", "6784"], "其他零組件": ["3058", "3138", "4545", "6426", "6743", "6275", "6546", "6588", "6597", "8109", "8171", "4980"]},
            "downstream": {"網路設備": ["2301", "2308", "2317", "2324", "2332", "2345", "2352", "2357", "2371", "2397", "2419", "2483", "2485", "3002", "3025", "3027", "3047", "3062", "3380", "3419", "3447", "3596", "3694", "3704", "4906", "4938", "5388", "6142", "6152", "6216", "6277", "6285", "6416", "6674", "3558", "3564", "3672", "4905", "5353", "6140", "6143", "6163", "6218", "6241", "6245", "6263", "6486", "6512", "6561", "8034", "8048", "8059", "8089", "8097", "8099", "8176", "3664"], "光通訊設備": ["1608", "2321", "2413", "3669", "6442", "8045", "4977", "3163", "3363", "4903"], "無線通訊設備": ["2312", "2314", "2424", "2439", "2450", "2498", "3706", "4904", "8101", "3306", "3466", "3499", "3541", "3632", "3684", "5348", "5356", "6109", "6417", "6465", "6884", "6648"], "有線通訊設備": ["1614"], "電信服務業": ["2412", "3045", "6136", "6170"]},
        },
    },
    "flat-panel": {
        "name": "平面顯示器",
        "desc": "平面顯示器產業鏈(上游 化學品 / ITO導電基板 / 背光源、中游 面板 / 顯示器模組 / 生產製程及檢測設備、下游 監視器/顯示器 / 電視 / 電子書);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "平面顯示器",
        "indicators": [{"label": "上游", "value": "化學品 / ITO導電基板 / 背光源"}, {"label": "中游", "value": "面板 / 顯示器模組 / 生產製程及檢測設備"}, {"label": "下游", "value": "監視器/顯示器 / 電視 / 電子書"}],
        "members": {
            "upstream": {"化學品": ["1711", "1717", "1773", "3010", "4720", "4722", "4755", "5234", "1785", "3663", "4749", "4768", "4772", "6959"], "ITO導電基板": ["2340", "3615"], "背光源": ["2393", "2486", "3031", "3090", "3437", "6168", "8070", "3516", "6246"], "塑膠框": ["2371", "6120", "5243", "1336", "6577"], "稜鏡片": ["3504", "3523", "3666", "4933", "8240"], "擴散膜、增亮膜、導光板": ["4935", "3388", "3685", "3595", "6434", "6775"], "背光模組": ["6176", "6278", "3531", "5371", "8085", "3633"], "驅動IC": ["2459", "3444", "6147"], "其他零組件": ["2308", "2352", "2392", "2429", "2476", "2478", "2483", "3023", "3051", "3311", "3419", "3543", "3679", "4938", "4942", "4960", "6192", "6205", "6224", "6282", "6405", "8101", "8163", "8215", "5460", "6829", "8383"]},
            "midstream": {"面板": ["2409", "3038", "3481", "6116", "6189", "6916", "8104", "8105", "5245", "5315", "8069"], "顯示器模組": ["2485", "3024", "3168", "4995", "5386", "5432", "6167", "8049"], "生產製程及檢測設備": ["2360", "2467", "3535", "3583", "4770", "6277", "6438", "6937", "7730", "8374", "1595", "3455", "3485", "3498", "3551", "5443", "5489", "5536", "6125", "6234", "6425", "6613", "6664", "6667", "6725", "6877", "8064", "4537"]},
            "downstream": {"監視器/顯示器": ["1614", "2489", "9912", "3128", "3434", "3541", "5493", "6673"], "電視": ["1604", "2324", "5356"], "電子書": ["6143"]},
        },
    },
    "touch-panel": {
        "name": "觸控面板",
        "desc": "觸控面板產業鏈(上游 玻璃基板 / PET膜 / ITO靶材、中游 觸控面板、下游 衛星定位系統 / 公共資訊查詢站 / 金融提款機);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "觸控面板",
        "indicators": [{"label": "上游", "value": "玻璃基板 / PET膜 / ITO靶材"}, {"label": "中游", "value": "觸控面板"}, {"label": "下游", "value": "衛星定位系統 / 公共資訊查詢站 / 金融提款機"}],
        "members": {
            "upstream": {"玻璃基板": ["3149", "6405", "6246"], "PET膜": ["3303"], "ITO靶材": ["1785"], "ITO導電玻璃": ["3615"], "ITO導電薄膜": ["4720", "3663", "8240", "3678"], "膠材": ["1717", "4764", "5234", "8070", "3388", "3430", "6899", "3585", "3595"], "印刷材料": ["3444"], "軟性電路板": ["3390"], "控制IC": ["2458", "2459", "3227", "3556"]},
            "midstream": {"觸控面板": ["2429", "3038", "3049", "3416", "3481", "3622", "8105", "3673", "3623", "4729", "4995", "5220"]},
            "downstream": {"衛星定位系統": ["3632"], "公共資訊查詢站": ["3541"], "金融提款機": ["2427"], "電子觸控白板": ["5386"], "資訊收集設備": ["3088"], "工業用設備": ["3498", "3551", "4542", "5490", "5493", "6664"]},
        },
    },
    "pcb-chain": {
        "name": "印刷電路板",
        "desc": "印刷電路板產業鏈(上游 玻璃纖維/玻纖布 / 環氧樹脂 / 銅箔、中游 硬板、軟板、IC載板製造 / 基板組裝加工及相關製造 / 銅箔基板);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "印刷電路板",
        "indicators": [{"label": "上游", "value": "玻璃纖維/玻纖布 / 環氧樹脂 / 銅箔"}, {"label": "中游", "value": "硬板、軟板、IC載板製造 / 基板組裝加工及相關製造 / 銅箔基板"}],
        "members": {
            "upstream": {"玻璃纖維/玻纖布": ["1303", "1802", "1815", "3388", "5340", "5475", "8240"], "環氧樹脂": ["1717", "4764"], "銅箔": ["4989", "8358"], "聚亞醯胺樹脂": ["3645", "7419"], "生產製程及檢測設備": ["1528", "2467", "2493", "3010", "3030", "3535", "3563", "6438", "6658", "6706", "7730", "7795", "8438", "1595", "1785", "3093", "3455", "3485", "3498", "4542", "4577", "5536", "6664", "6727", "6877"]},
            "midstream": {"硬板、軟板、IC載板製造": ["2313", "2316", "2328", "2355", "2367", "2368", "2402", "3037", "3044", "3229", "3321", "3715", "5469", "6108", "6141", "6153", "6191", "6269", "6271", "6835", "8046", "8213", "4927", "4958", "3114", "3115", "3276", "3390", "4909", "5291", "5321", "5355", "5381", "5439", "5464", "6156", "6194", "6207", "6210", "6597", "8074", "8155", "6407"], "基板組裝加工及相關製造": ["6224", "3665", "6672", "3520", "5498", "6266", "8183"], "銅箔基板": ["2383", "6213", "8039", "3354", "4939", "6274", "6509", "8291", "3585"]},
        },
    },
    "passive-comp": {
        "name": "被動元件",
        "desc": "被動元件產業鏈(上游 電阻器材料 / 電容器材料 / 電感器材料、中游 電阻器 / 電容器 / 電感器);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "被動元件",
        "indicators": [{"label": "上游", "value": "電阻器材料 / 電容器材料 / 電感器材料"}, {"label": "中游", "value": "電阻器 / 電容器 / 電感器"}],
        "members": {
            "upstream": {"電阻器材料": ["5434", "3663", "4760", "6127", "6204"], "電容器材料": ["2492", "6173", "6175"], "電感器材料": ["2459", "6155", "3357", "8121"], "濾波器、振盪器材料": ["4739", "1785"]},
            "midstream": {"電阻器": ["2308", "2327", "2371", "2428", "2478", "6224", "6834", "3624", "6207", "6642", "8071", "8085"], "電容器": ["2375", "2413", "2472", "3026", "3090", "6449", "3537", "5328", "6284", "8042", "8043"], "電感器": ["3207", "3236", "5228", "6156", "6259", "6292", "6432", "6821", "3117"], "濾波器、振盪器": ["2484", "3042", "3221", "6174", "8182", "8289"]},
        },
    },
    "connector": {
        "name": "連接器",
        "desc": "連接器產業鏈(上游 金屬材料 / 電鍍材料 / 塑膠材料、中游 連接器設計、組裝及製造);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "連接器",
        "indicators": [{"label": "上游", "value": "金屬材料 / 電鍍材料 / 塑膠材料"}, {"label": "中游", "value": "連接器設計、組裝及製造"}],
        "members": {
            "upstream": {"金屬材料": ["1617", "2476", "3310"], "電鍍材料": ["8431"], "塑膠材料": ["3010", "4755", "3665", "6151", "8240"]},
            "midstream": {"連接器設計、組裝及製造": ["2317", "2352", "2392", "2459", "2460", "2462", "2483", "3003", "3011", "3021", "3023", "3419", "3432", "3501", "3533", "3605", "6115", "6133", "6165", "6197", "6205", "6272", "6835", "8103", "4943", "3114", "3217", "3322", "3492", "3511", "3520", "3526", "3597", "3646", "3689", "3710", "5398", "5457", "5460", "6126", "6158", "6185", "6217", "6290", "6418", "8147", "5254", "5271", "6833"]},
        },
    },
    "electric-machinery": {
        "name": "電機機械",
        "desc": "電機機械產業鏈(上游 鋼鑄鐵元件 / 傳動元件 / 五金元件及零配件、下游 金屬加工用機械 / 專用機械 / 手工具機);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "電機機械",
        "indicators": [{"label": "上游", "value": "鋼鑄鐵元件 / 傳動元件 / 五金元件及零配件"}, {"label": "下游", "value": "金屬加工用機械 / 專用機械 / 手工具機"}],
        "members": {
            "upstream": {"鋼鑄鐵元件": ["1532", "2371", "2483", "1589", "2067", "4538", "4580", "6705"], "傳動元件": ["1504", "1526", "1536", "1597", "2049", "2233", "2308", "4540", "4576", "4583", "4590", "1590", "2248", "3426", "4528", "4534", "4561", "4568", "4584", "6982", "4573"], "五金元件及零配件": ["1537", "1560", "2066", "4543", "6584", "1591"], "電控元件": ["1303", "1533", "2459", "4555", "7750", "7788", "4549", "5381", "8109", "4587"], "油空壓元件": ["8996"], "機械設備之沖壓零組件": ["1586", "4535"]},
            "downstream": {"金屬加工用機械": ["1513", "1530", "1540", "1583", "4526", "4562", "5007", "6606", "3162", "4510", "4513", "4533", "4563", "6609", "8092", "4544", "4575"], "專用機械": ["1528", "1531", "1558", "3167", "1580", "2070", "3379", "3498", "6603", "8027", "8421", "4537", "6618"], "手工具機": ["1315", "1515", "1527", "1538", "1539", "1541", "2352", "2397", "8374", "1570"], "輸送機械及零配件": ["1503", "2464", "4720", "6125", "6234"], "車用機械傳動設備及零配件": ["1506", "1512", "1517", "1563", "1568", "2254", "2421", "4566", "2230", "2235", "3226", "4502", "4523", "6275", "4553", "4559"], "自動販賣機": ["4503"], "冷凍空調設備及零件": ["1614", "4532", "4527", "5536"], "機電系統工程": ["1514", "1519", "1529", "1535", "3018", "4582", "4506", "4550", "6122", "8383", "1594", "4565"], "金屬加工處理": ["1617", "4564", "4572", "8222", "5288", "4558", "6829", "4546"]},
        },
    },
    "construction": {
        "name": "建材營造",
        "desc": "建材營造產業鏈(上游 建材原料 / 基礎工程 / 結構工程、中游 營造業 / 建設業 / 工程承攬、下游 個人、民間企業、政府機構 / 裝潢業);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "建材營造",
        "indicators": [{"label": "上游", "value": "建材原料 / 基礎工程 / 結構工程"}, {"label": "中游", "value": "營造業 / 建設業 / 工程承攬"}, {"label": "下游", "value": "個人、民間企業、政府機構 / 裝潢業"}],
        "members": {
            "upstream": {"建材原料": ["1603", "1612", "1802", "1806", "1809", "1810", "1817", "2020", "2504", "2597", "3149", "5515", "5534", "8463", "3388", "6228", "8424", "8930", "5543"], "基礎工程": ["2031", "8080"], "結構工程": ["1472", "2010", "9945", "1594"], "機電工程": ["1503", "1504", "2308", "2371", "3018", "5536", "6122", "8383"]},
            "midstream": {"營造業": ["2511", "2515", "2516", "2535", "2543", "2546", "3703", "5519", "5521", "5511", "5516", "5547", "6264", "8936"], "建設業": ["1103", "1402", "1416", "1436", "1438", "1439", "1442", "1453", "1456", "1513", "1532", "1605", "1805", "1808", "2424", "2442", "2501", "2505", "2506", "2509", "2514", "2520", "2524", "2527", "2528", "2530", "2534", "2536", "2537", "2538", "2539", "2542", "2545", "2547", "2548", "3052", "3056", "3266", "5522", "5525", "5531", "5533", "6177", "9906", "9946", "2923", "2596", "2718", "3188", "3310", "3313", "3489", "3512", "3521", "4113", "4416", "4714", "4907", "5206", "5213", "5324", "5455", "5508", "5512", "5514", "5523", "5529", "5530", "6171", "6186", "6198", "6212", "6219", "8905"], "工程承攬": ["9917", "9933", "9958", "6179"]},
            "downstream": {"個人、民間企業、政府機構": ["8942"], "裝潢業": ["6754", "5314"]},
        },
    },
    "retail-trade": {
        "name": "貿易百貨",
        "desc": "貿易百貨產業鏈(上游 製造商、中游 貿易商、代理商、經銷商、下游 零售通路);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "貿易百貨",
        "indicators": [{"label": "上游", "value": "製造商"}, {"label": "中游", "value": "貿易商、代理商、經銷商"}, {"label": "下游", "value": "零售通路"}],
        "members": {
            "upstream": {"製造商": ["1614", "2371", "4930", "6201", "6225", "2916", "8916", "8941", "2924", "6629", "2938"]},
            "midstream": {"貿易商、代理商、經銷商": ["1419", "1528", "1730", "1817", "3229", "5434", "8454", "1742", "2230", "2948", "3171", "4702", "5902", "6228", "6728", "6968", "8066", "8433"]},
            "downstream": {"零售通路": ["1532", "2430", "2614", "2912", "3024", "6281", "9946", "2937", "2941", "2947", "4609", "5903", "5904", "6154", "6195", "8415", "8472", "2942"]},
        },
    },
    "leisure": {
        "name": "休閒娛樂",
        "desc": "休閒娛樂產業鏈(高爾夫球具業、線上遊戲業、娛樂服務業、旅館服務業、休閒車業);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "休閒娛樂",
        "indicators": [{"label": "主要區隔", "value": "高爾夫球具業 / 線上遊戲業 / 娛樂服務業"}],
        "members": {
            "midstream": {"高爾夫球具業": ["6670", "8481", "8924", "8928", "8938", "9960"], "線上遊戲業": ["4994", "3687", "5310", "5478", "2465"], "娛樂服務業": ["1432", "1532", "8462", "5263", "7819"], "旅館服務業": ["6128", "5324", "5464", "6264"], "休閒車業": ["2308", "4536", "9914", "9921", "3665", "1599", "3162", "6804", "8933", "8937", "4559"]},
        },
    },
    "ecommerce": {
        "name": "電子商務",
        "desc": "電子商務產業鏈(物流倉儲服務、資訊系統建置服務、金流串接處理服務、資料分析處理服務、行銷廣告服務);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "電子商務",
        "indicators": [{"label": "主要區隔", "value": "物流倉儲服務 / 資訊系統建置服務 / 金流串接處理服務"}],
        "members": {
            "midstream": {"物流倉儲服務": ["8454", "2949", "3085", "8044"], "資訊系統建置服務": ["2352", "6183", "7721", "7765", "5478", "6590", "6870", "6925", "7819", "8284", "6741"], "金流串接處理服務": ["7722", "3687", "6763"], "資料分析處理服務": ["6614"], "行銷廣告服務": ["3130", "5287"], "交易撮合": ["2640", "5278"], "自有產品銷售": ["6277", "5321", "6220"], "一般零售": ["8472", "8477", "6473"]},
        },
    },
    "culture": {
        "name": "文化創意",
        "desc": "文化創意產業鏈(廣播電視/電影產業、數位內容產業、流行音樂及文化內容產業、其他);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "文化創意",
        "indicators": [{"label": "主要區隔", "value": "廣播電視/電影產業 / 數位內容產業 / 流行音樂及文化內容產業"}],
        "members": {
            "midstream": {"廣播電視/電影產業": ["2498", "6184", "8454", "8487", "9928"], "數位內容產業": ["6908", "5263", "5478", "8489", "6473"], "流行音樂及文化內容產業": ["6625"], "其他": ["5481", "4154"]},
        },
    },
    "utility-oil-gas": {
        "name": "油電燃氣",
        "desc": "油電燃氣產業鏈(天然瓦斯供應、加油站);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "油電燃氣",
        "indicators": [{"label": "主要區隔", "value": "天然瓦斯供應 / 加油站"}],
        "members": {
            "midstream": {"天然瓦斯供應": ["9908", "9918", "9926", "9931", "8908", "8917"], "加油站": ["1434", "2616", "6505", "9937", "8927"]},
        },
    },
    "food": {
        "name": "食品",
        "desc": "食品產業鏈(上游 原物料、中游 加工食品);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "食品",
        "indicators": [{"label": "上游", "value": "原物料"}, {"label": "中游", "value": "加工食品"}],
        "members": {
            "upstream": {"原物料": ["1216", "4755", "4930", "3388", "6578", "8472", "8905", "8345"]},
            "midstream": {"加工食品": ["9917"]},
        },
    },
    "software": {
        "name": "軟體服務",
        "desc": "軟體服務產業鏈(應用/系統軟體設計開發、系統整合服務、資料處理服務、通路經銷);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "軟體服務",
        "indicators": [{"label": "主要區隔", "value": "應用/系統軟體設計開發 / 系統整合服務 / 資料處理服務"}],
        "members": {
            "midstream": {"應用/系統軟體設計開發": ["1416", "2308", "2371", "2427", "2453", "2468", "2471", "2480", "3057", "3130", "4585", "5203", "6112", "6183", "6214", "6277", "6614", "6906", "7765", "3158", "4953", "5201", "5202", "5210", "5211", "5263", "5403", "5410", "5493", "6140", "6163", "6221", "6240", "6462", "6516", "6590", "6752", "6811", "6870", "6874", "6925", "7547", "7819", "8099", "8284", "6536", "6738", "6882", "7551", "8298"], "系統整合服務": ["2352", "2360", "3021", "3029", "3147", "3570", "5206", "5209", "5212", "5310", "6123", "6148", "6218", "6486", "6690", "6697", "6751", "6791", "8416"], "資料處理服務": ["6593", "6898"], "通路經銷": ["6154", "6997"]},
        },
    },
    "finance": {
        "name": "金融",
        "desc": "金融產業鏈(金控業/銀行業/保險業、證券業、期貨業、租賃業);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "金融",
        "indicators": [{"label": "主要區隔", "value": "金控業/銀行業/保險業 / 證券業 / 期貨業"}],
        "members": {
            "midstream": {"金控業/銀行業/保險業": ["2801", "2812", "2816", "2820", "2832", "2834", "2836", "2838", "2845", "2849", "2850", "2851", "2852", "2867", "2880", "2881", "2882", "2883", "2884", "2885", "2886", "2887", "2889", "2890", "2891", "2892", "2897", "5876", "5880", "5878", "6028", "5859", "5863", "6035", "6878"], "證券業": ["2855", "6005", "5864", "6015", "6016", "6020", "6021", "6026", "6027"], "期貨業": ["6024", "6023"], "租賃業": ["1103", "5871", "7590"]},
        },
    },
    "automation": {
        "name": "自動化",
        "desc": "自動化產業鏈(上游 感測器 / 控制器、下游 工業型機器人 / 自動化機台 / 整體解決方案);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "自動化",
        "indicators": [{"label": "上游", "value": "感測器 / 控制器"}, {"label": "下游", "value": "工業型機器人 / 自動化機台 / 整體解決方案"}],
        "members": {
            "upstream": {"感測器": ["3611", "3623"], "控制器": ["6739"]},
            "downstream": {"工業型機器人": ["2049"], "自動化機台": ["3219", "6218", "6234", "6425", "6664", "8027"], "整體解決方案": ["5371", "6125"]},
        },
    },
    "ai": {
        "name": "人工智慧",
        "desc": "人工智慧產業鏈(系統整合、顧問諮詢、領域解決方案、智慧設備、機器學習);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "數位科技",
        "indicators": [{"label": "主要區隔", "value": "系統整合 / 顧問諮詢 / 領域解決方案"}],
        "members": {
            "midstream": {"系統整合": ["2308", "2453", "2471", "2480", "2495", "3029", "4585", "6112", "6412", "6614", "6658", "6689", "8374", "3128", "3632", "4953", "5209", "5351", "5371", "5474", "6140", "6163", "6697", "6739", "6752", "6811", "6870", "6925", "6997", "7547", "8099"], "顧問諮詢": ["6741"], "領域解決方案": ["2352", "2388", "2498", "5203", "3297", "6516", "6791", "8298"], "智慧設備": ["2357", "3455", "6263", "6664", "6680", "6877"], "機器學習": ["4952", "6277", "6695", "3227", "5236"], "電腦視覺": ["3669"], "移動控制": ["1504"], "運算設備": ["3706", "6669"], "雲端平台": ["6906"]},
        },
    },
    "cloud": {
        "name": "雲端運算",
        "desc": "雲端運算產業鏈(上游 電腦設備 / 電力設備 / 冷卻設備、中游 設備管理軟體 / 營運管理軟體 / 虛擬化軟體、下游 雲端應用服務 / 系統整合);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "數位科技",
        "indicators": [{"label": "上游", "value": "電腦設備 / 電力設備 / 冷卻設備"}, {"label": "中游", "value": "設備管理軟體 / 營運管理軟體 / 虛擬化軟體"}, {"label": "下游", "value": "雲端應用服務 / 系統整合"}],
        "members": {
            "upstream": {"電腦設備": ["2308", "2352", "2382", "2390", "2480", "2495", "3029", "3057", "3706", "6112", "6614", "6669", "8210", "6221", "6263", "6680", "6752", "8277", "5223", "7765", "8054", "3380"], "電力設備": ["2301", "2459", "4931", "5536"], "冷卻設備": ["2421"]},
            "midstream": {"設備管理軟體": ["8374", "6140", "6218", "6739", "6811", "8099", "6741"], "營運管理軟體": ["6689", "6123", "6997", "7547"], "虛擬化軟體": ["6697"], "雲端作業系統": ["3632"]},
            "downstream": {"雲端應用服務": ["2395", "4904", "6561", "6870", "6708", "6565", "6791", "6925", "6738"], "系統整合": ["2453", "2471", "6277", "4953", "6148"]},
        },
    },
    "bigdata": {
        "name": "大數據",
        "desc": "大數據產業鏈(系統整合、顧問諮詢、領域解決方案、應用軟體、運算元件與設備);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "數位科技",
        "indicators": [{"label": "主要區隔", "value": "系統整合 / 顧問諮詢 / 領域解決方案"}],
        "members": {
            "midstream": {"系統整合": ["2308", "2352", "2390", "2453", "2471", "2480", "2495", "3029", "3057", "6112", "6183", "6614", "6658", "6689", "4953", "5209", "6148", "6218", "6739", "6811", "6870", "6925", "6997", "7547", "8099", "6741", "3097"], "顧問諮詢": ["6697", "6898"], "領域解決方案": ["6906", "6516", "6561", "6791", "5262", "8298"], "應用軟體": ["6263"], "運算元件與設備": ["3135"], "雲端平台": ["4904"], "儲存處理": ["8054"]},
        },
    },
    "infosec": {
        "name": "資通訊安全",
        "desc": "資通訊安全產業鏈(安全營運與事件回應、資安治理、資料安全、網頁內容安全、雲端安全);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "數位科技",
        "indicators": [{"label": "主要區隔", "value": "安全營運與事件回應 / 資安治理 / 資料安全"}],
        "members": {
            "midstream": {"安全營運與事件回應": ["2480", "3029", "6112", "6183", "7765", "6218", "6690", "6739", "6752", "8298"], "資安治理": ["6163"], "資料安全": ["2471", "6689", "6263", "6590", "6697", "8277"], "網頁內容安全": ["6561"], "雲端安全": ["6614"], "網路基礎設施": ["2352", "2397", "3704", "9917", "3564", "6530", "3664"], "網路安全防護": ["6277", "6236"], "端點安全防護": ["6462"], "資安顧問服務": ["2453"]},
        },
    },
    "fintech": {
        "name": "金融科技",
        "desc": "金融科技產業鏈(保險、支付、數位銀行、監理法遵、理財投資);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "數位科技",
        "indicators": [{"label": "主要區隔", "value": "保險 / 支付 / 數位銀行"}],
        "members": {
            "midstream": {"保險": ["2453", "2867"], "支付": ["7722", "5478", "6590", "6763", "6870", "7819", "6741", "6878"], "數位銀行": ["6614", "4953"], "監理法遵": ["2471"], "理財投資": ["3158", "8284"], "數據分析": ["2480"]},
        },
    },
    "blockchain": {
        "name": "區塊鏈",
        "desc": "區塊鏈產業鏈(交易平台、商業應用、系統整合、元件裝置);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "數位科技",
        "indicators": [{"label": "主要區隔", "value": "交易平台 / 商業應用 / 系統整合"}],
        "members": {
            "midstream": {"交易平台": ["2453", "2480"], "商業應用": ["2498"], "系統整合": ["6277"], "元件裝置": ["2399", "3515", "6150"]},
        },
    },
    "xr-tech": {
        "name": "體驗科技",
        "desc": "體驗科技產業鏈(處理器/IC、近眼顯示、感測器/模組、頭顯裝置品牌廠、組裝廠);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "前瞻科技",
        "indicators": [{"label": "主要區隔", "value": "處理器/IC / 近眼顯示 / 感測器/模組"}],
        "members": {
            "midstream": {"處理器/IC": ["5351", "3227"], "近眼顯示": ["5371", "4980", "2459", "6742"], "感測器/模組": ["2301", "2340", "6271", "6204", "6819", "4925"], "頭顯裝置品牌廠": ["2498"], "組裝廠": ["2392"], "資服": ["6614", "5263", "6263", "6811", "8099"], "其他": ["2308", "2421"]},
        },
    },
    "sports-tech": {
        "name": "運動科技",
        "desc": "運動科技產業鏈(上游 裝置/器材顯示器 / 裝置/器材零組件 / 感測裝置、中游 健身器材 / 運動用品 / 穿戴式裝置);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "前瞻科技",
        "indicators": [{"label": "上游", "value": "裝置/器材顯示器 / 裝置/器材零組件 / 感測裝置"}, {"label": "中游", "value": "健身器材 / 運動用品 / 穿戴式裝置"}],
        "members": {
            "upstream": {"裝置/器材顯示器": ["2459", "7558"], "裝置/器材零組件": ["1593", "4558", "5348"], "感測裝置": ["2340", "3227", "5493", "6204", "6679"], "軟體開發": ["2395"]},
            "midstream": {"健身器材": ["1598", "1736"], "運動用品": ["2106", "4401", "8071", "8924"], "穿戴式裝置": ["2324", "2357", "2382", "2392", "2498", "3481", "5457"]},
        },
    },
    "space-satellite": {
        "name": "太空衛星科技",
        "desc": "太空衛星科技產業鏈(上游 零組件/材料、下游 通訊 / 導航定位);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "前瞻科技",
        "indicators": [{"label": "上游", "value": "零組件/材料"}, {"label": "下游", "value": "通訊 / 導航定位"}],
        "members": {
            "upstream": {"零組件/材料": ["2308", "2314", "2352", "3380", "6271", "6285", "3105", "3491", "4909", "5457", "3227", "3178"]},
            "downstream": {"通訊": ["2453"], "導航定位": ["3632"]},
        },
    },
    "medical-device": {
        "name": "醫療器材",
        "desc": "醫療器材產業鏈(上游 電子零組件、塑膠零件、五金零件、中游 醫療器材研發、設計、製造、下游 醫療器材代理銷售及通路);結構與成分股參照櫃買中心產業價值鏈資訊平台。",
        "category": "生技醫療",
        "indicators": [{"label": "上游", "value": "電子零組件、塑膠零件、五金零件"}, {"label": "中游", "value": "醫療器材研發、設計、製造"}, {"label": "下游", "value": "醫療器材代理銷售及通路"}],
        "members": {
            "upstream": {"電子零組件、塑膠零件、五金零件": ["2308", "2459", "2476", "3010", "3543", "3665", "1593", "3162", "3294", "3303", "5356", "6151", "6275", "6577", "8109", "5284", "5288", "3310", "5460"]},
            "midstream": {"醫療器材研發、設計、製造": ["2483", "6201", "3373", "5457", "4729", "8071", "4438", "6504", "9919", "8929", "2301", "2352", "5398", "2465", "4171", "6228", "3038", "8183"]},
            "downstream": {"醫療器材代理銷售及通路": ["2371", "4720", "6614", "9917", "4431"]},
        },
    },
    "connector-highspeed": {
        "name": "高速連接器",
        "desc": "高速傳輸與電力連接元件,AI 伺服器(224G、CPU socket)與車用需求帶動規格升級,為連接器產業中的高階成長區隔。",
        "category": "連接器",
        "cagr": "8–10%",
        "indicators": [{"label": "主要應用", "value": "AI 伺服器 / 車用"}, {"label": "規格升級", "value": "224G / 大電流"}, {"label": "技術趨勢", "value": "液冷快接"}, {"label": "代表廠商", "value": "嘉澤 / 貿聯"}],
        "members": {"midstream": ["3533", "3665", "3526", "3605", "6205", "3003", "3023"]},
    },
}


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
        seen = set()  # 跨層去重:同一代號只列一次,確保涵蓋家數=上中下游加總
        for tier in ("upstream", "midstream", "downstream"):
            group = members.get(tier)
            if not group:
                continue
            # group 可為扁平 [代號](subcat 留空)或 {子分類: [代號]}
            # (TPEx 產業價值鏈結構,如 上游→車燈/輪胎/…)
            sub_iter = group.items() if isinstance(group, dict) else [("", group)]
            for subcat, tickers in sub_iter:
                for tk in tickers:
                    if tk in seen:
                        continue
                    m = meta.get(tk)
                    if not m:
                        print(f"  [warn] {theme_tag}: 代號 {tk} 不在涵蓋範圍,略過")
                        continue
                    seen.add(tk)
                    entries.append({
                        "ticker": tk,
                        "company": m["company"],
                        "sector": m["sector"],
                        "role": tier,
                        "subcat": subcat,
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
        # 子分類依「首次出現順序」分組(策展 members 即 TPEx 節點順序),
        # 「其他」與無子分類者排最後;組內再依 產業 → 代號。
        order = {}
        for e in entries:
            sub = (e.get("subcat") or "").strip()
            if sub and sub != "其他" and sub not in order:
                order[sub] = len(order)
        big = len(order) + 10

        def sort_key(e):
            sub = (e.get("subcat") or "").strip()
            if not sub:
                rank = big + 1
            elif sub == "其他":
                rank = big
            else:
                rank = order[sub]
            return (rank, e["sector"], e["ticker"])

        rows = sorted(entries, key=sort_key)
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

    # Filter to requested theme or build all
    if args and args[0] != "--list":
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
                mt = set()
                for v in defn["members"].values():
                    if isinstance(v, dict):
                        for lst in v.values():
                            mt.update(lst)
                    else:
                        mt.update(v)
                count = sum(1 for t in mt if t in ticker_meta)  # 只計涵蓋者
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
