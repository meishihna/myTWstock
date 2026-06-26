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
    },
    # === Compound Semiconductors ===
    "碳化矽": {
        "name": "碳化矽 SiC",
        "desc": "第三代半導體材料，耐高壓高溫，電動車逆變器及充電樁關鍵材料",
        "related": ["電動車", "MOSFET", "IGBT", "氮化鎵"],
        "category": "能源車用",
    },
    "氮化鎵": {
        "name": "氮化鎵 GaN",
        "desc": "第三代半導體材料，高頻高效，5G 基站、快充及衛星通訊核心",
        "related": ["5G", "碳化矽", "磷化銦"],
        "category": "能源車用",
    },
    "磷化銦": {
        "name": "磷化銦 InP",
        "desc": "III-V 族化合物半導體，光通訊雷射及高速光電元件基板材料",
        "related": ["矽光子", "EML", "光收發模組", "砷化鎵"],
        "category": "光通訊",
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
    },
    "低軌衛星": {
        "name": "低軌衛星 LEO Satellite",
        "desc": "低軌道衛星通訊供應鏈，天線、地面站、射頻模組",
        "related": ["5G", "氮化鎵", "RF"],
        "category": "衛星通訊",
    },
    # === Process / Equipment ===
    "EUV": {
        "name": "EUV 極紫外光微影",
        "desc": "先進製程關鍵微影技術，7nm 以下節點必備",
        "related": ["光阻液", "ASML"],
        "category": "半導體製造",
    },
    # === Materials ===
    "光阻液": {
        "name": "光阻液 Photoresist",
        "desc": "半導體微影製程關鍵化學材料",
        "related": ["EUV", "微影"],
        "category": "半導體製造",
    },
    "ABF 載板": {
        "name": "ABF 載板",
        "desc": "Ajinomoto Build-up Film 載板，高階 IC 封裝基板",
        "related": ["CoWoS", "AI 伺服器", "PCB"],
        "category": "基板材料",
    },
    "矽晶圓": {
        "name": "矽晶圓",
        "desc": "半導體製造最基礎的原材料",
        "related": ["碳化矽", "磊晶"],
        "category": "基板材料",
    },
    # === Key customers (cross-industry) ===
    "Apple": {
        "name": "Apple 蘋果供應鏈",
        "desc": "蘋果公司台灣供應鏈成員",
        "related": ["台積電", "鴻海"],
        "category": "消費終端",
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
    },
    # === PCB / 零組件 ===
    "PCB": {
        "name": "PCB 印刷電路板",
        "desc": "電子產品訊號互連基礎，涵蓋硬板、軟板、HDI 與載板",
        "related": ["ABF 載板", "銅箔", "連接器", "AI 伺服器"],
        "category": "基板材料",
        "cagr": "8%+",
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
    },
    "銅箔": {
        "name": "銅箔",
        "desc": "PCB 與鋰電池負極關鍵材料，AI 載板與電動車雙引擎",
        "related": ["PCB", "ABF 載板", "電動車", "儲能"],
        "category": "基板材料",
    },
    "連接器": {
        "name": "連接器",
        "desc": "高速傳輸與電力連接元件，AI 伺服器與車用需求升溫",
        "related": ["AI 伺服器", "ADAS", "PCB"],
        "category": "電子零組件",
    },
    "MLCC": {
        "name": "MLCC 被動元件",
        "desc": "積層陶瓷電容，電子產品被動元件基礎，車用與 AI 帶動規格升級",
        "related": ["電動車", "AI 伺服器", "PCB"],
        "category": "被動元件",
        "cagr": "8%+",
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
    },
    # === 車用電子 ===
    "ADAS": {
        "name": "ADAS 先進駕駛輔助",
        "desc": "車用感測、運算與自動駕駛供應鏈",
        "related": ["電動車", "MOSFET", "連接器"],
        "category": "能源車用",
    },
    # === 顯示 ===
    "OLED": {
        "name": "OLED 顯示",
        "desc": "有機發光二極體顯示，手機、穿戴與筆電滲透提升",
        "related": ["Mini LED", "面板"],
        "category": "光學顯示",
    },
    "Mini LED": {
        "name": "Mini LED 背光",
        "desc": "高動態對比背光技術，應用於高階顯示器、電視與筆電",
        "related": ["OLED", "LED", "面板"],
        "category": "光學顯示",
    },
    # === 記憶體 ===
    "DRAM": {
        "name": "記憶體 DRAM",
        "desc": "動態隨機存取記憶體，AI、伺服器與消費電子需求循環",
        "related": ["HBM", "DDR5", "記憶體"],
        "category": "記憶體",
    },
    # === 綠能 ===
    "儲能": {
        "name": "儲能 Energy Storage",
        "desc": "電網與再生能源儲能系統，涵蓋電池芯、模組與 ESS 整合",
        "related": ["太陽能", "電動車", "離岸風電"],
        "category": "綠能環保",
    },
    "太陽能": {
        "name": "太陽能 Solar",
        "desc": "太陽能電池、模組與系統供應鏈",
        "related": ["儲能", "離岸風電"],
        "category": "綠能環保",
    },
    "離岸風電": {
        "name": "離岸風電 Offshore Wind",
        "desc": "離岸風力發電水下基礎、海纜與機電供應鏈",
        "related": ["儲能", "太陽能"],
        "category": "綠能環保",
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


def build_theme_page(theme_tag, theme_def, wl_map):
    """Build a single theme markdown page."""
    entries = wl_map.get(theme_tag, [])
    if not entries:
        return None

    lines = []
    lines.append(f"# {theme_def['name']}")
    lines.append("")
    lines.append(f"> {theme_def['desc']}")
    lines.append("")
    lines.append(f"**涵蓋公司數:** {len(entries)}")
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

    if other:
        lines.append(f"## 相關公司 ({len(other)})")
        lines.append("")
        lines.extend(format_entries(other))
        lines.append("")

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
    print(f"Found {len(wl_map)} unique wikilinks.\n")

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
        page = build_theme_page(tag, defn, wl_map)
        if page:
            safe_name = tag.replace(" ", "_").replace("/", "_")
            filepath = os.path.join(THEMES_DIR, f"{safe_name}.md")
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(page)
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
