"""
build_chips_snapshot.py — 全市場籌碼面快照(最新一日三大法人 + 融資融券餘額/增減)。

來源(全免費、無金鑰、無配額):
  • 三大法人(最新一日,單位:張):
      - 上市 → TWSE 舊版 T86「三大法人買賣超日報」(取最近有資料的交易日;股數→張)
        外資 = 外陸資買賣超(不含外資自營) + 外資自營商買賣超;投信 / 自營 / 三大法人合計各取對應欄。
      - 上櫃 → 目前無乾淨免費的全市場端點 → 暫缺(null);待優化補上。
  • 融資融券(餘額與當日增減,單位:張):
      - 上市 → TWSE OpenAPI exchangeReport/MI_MARGN(融資/融券 今日餘額 − 前日餘額)
      - 上櫃 → TPEx OpenAPI tpex_mainboard_margin_balance

輸出 web/public/data/chips-index.json
  { "generatedAt": ISO, "instDate": "YYYY-MM-DD",
    "rows": { "2330": {
        "inst": { "foreign": -1234, "trust": 56, "dealer": 7, "net3": -1171 } | null,   # 張
        "margin": { "bal": 12345, "chg": -200, "shortBal": 678, "shortChg": 50 } | null  # 張
    } } }

報告頁「籌碼面」分頁讀此檔;盤後在 CI(refresh-snapshots)刷新並提交。
注:三大法人為盤後資料,「連 N 買 / N 日累積」需逐日累積,屬後續優化。

  python scripts/build_chips_snapshot.py                 # 全部(報告頁宇集)
  python scripts/build_chips_snapshot.py 2330 2303 6488  # 指定數檔(測試用)
"""

from __future__ import annotations

import csv
import io
import json
import os
import ssl
import sys
import time
from datetime import date, datetime, timedelta, timezone
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from utils import find_ticker_files, parse_scope_args, setup_stdout

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "public", "data", "chips-index.json")

T86 = "https://www.twse.com.tw/rwd/zh/fund/T86?date={d}&selectType=ALL&response=json"
TWSE_MARGIN = "https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN"
TPEX_MARGIN = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_margin_balance"
TDCC = "https://opendata.tdcc.com.tw/getOD.ashx?id=1-5"  # 集保戶股權分散表(每週、含上市+上櫃)
MI_QFIIS = "https://www.twse.com.tw/rwd/zh/fund/MI_QFIIS?date={d}&selectType=ALLBUT0999&response=json"  # 外資持股(上市)

# 公開政府端點、只讀;憑證鏈在部分環境驗證失敗 → 不驗證。
_SSL = ssl.create_default_context()
_SSL.check_hostname = False
_SSL.verify_mode = ssl.CERT_NONE


def _get_json(url: str, retries: int = 3):
    last: Exception | None = None
    for i in range(retries):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "Mozilla/5.0 twstock-chips", "Accept": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=90, context=_SSL) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            last = e
            time.sleep(2 * (i + 1))
    raise last if last else RuntimeError("unreachable")


def _int(x):
    """逗號數字字串 → int(張或股);非數值 → None。"""
    if x is None:
        return None
    s = str(x).strip().replace(",", "").replace("+", "")
    if not s or s in ("--", "-", "N/A"):
        return None
    try:
        return int(round(float(s)))
    except ValueError:
        return None


def _get_text(url: str, retries: int = 3) -> str:
    last: Exception | None = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 twstock-chips"})
            with urllib.request.urlopen(req, timeout=120, context=_SSL) as r:
                return r.read().decode("utf-8-sig", "replace")  # TDCC CSV 帶 BOM
        except Exception as e:
            last = e
            time.sleep(2 * (i + 1))
    raise last if last else RuntimeError("unreachable")


def _cell(x) -> str:
    """TDCC CSV 值常被單引號包住(強制文字),去引號與空白。"""
    return str(x or "").strip().strip("'").strip()


def _f(x):
    s = _cell(x).replace(",", "")
    try:
        return float(s)
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# 大戶持股(集保戶股權分散表):千張 = 分級 15(≥1,000,001 股);
# 400張 = 分級 12~15 合計(≥400,001 股)。含上市+上櫃,每週更新。
# ---------------------------------------------------------------------------
def build_holders(universe: set[str]) -> dict[str, dict]:
    try:
        raw = _get_text(TDCC)
    except Exception as e:
        print(f"  [holders] TDCC FAILED: {str(e)[:60]}")
        return {}
    agg: dict[str, dict] = {}
    for row in csv.DictReader(io.StringIO(raw)):
        code = _cell(row.get("證券代號"))
        if code not in universe:
            continue
        lvl = _cell(row.get("持股分級"))
        pct = _f(row.get("占集保庫存數比例%"))
        ppl = _int(_cell(row.get("人數")))
        d = agg.setdefault(
            code,
            {
                "date": _cell(row.get("資料日期")),
                "k1000": {"pct": None, "people": None},
                "k400": {"pct": 0.0, "people": 0},
            },
        )
        if lvl == "15":
            d["k1000"] = {"pct": pct, "people": ppl}
        if lvl in ("12", "13", "14", "15"):
            d["k400"]["pct"] = (d["k400"]["pct"] or 0) + (pct or 0)
            d["k400"]["people"] = (d["k400"]["people"] or 0) + (ppl or 0)
    for d in agg.values():
        if d["k400"]["pct"] is not None:
            d["k400"]["pct"] = round(d["k400"]["pct"], 2)
    print(f"  [holders] TDCC {len(agg)} 檔(集保)")
    return agg


# ---------------------------------------------------------------------------
# 三大法人(上市,T86;股數 → 張)
# ---------------------------------------------------------------------------
def build_inst_twse(universe: set[str]) -> tuple[dict[str, dict], str | None]:
    out: dict[str, dict] = {}
    used_date: str | None = None
    for back in range(0, 8):  # 回溯找最近有資料的交易日
        dt = (date.today() - timedelta(days=back)).strftime("%Y%m%d")
        try:
            d = _get_json(T86.format(d=dt))
        except Exception as e:
            print(f"  [inst] T86 {dt} ERR {str(e)[:50]}")
            continue
        if d.get("stat") != "OK" or not d.get("data"):
            continue
        used_date = f"{dt[:4]}-{dt[4:6]}-{dt[6:]}"
        # 欄位固定序:0 代號 … 4 外陸資買賣超(不含外資自營) … 7 外資自營買賣超 … 10 投信買賣超 … 11 自營商買賣超 … 18 三大法人買賣超
        for r in d["data"]:
            if len(r) < 19:
                continue
            code = str(r[0]).strip()
            if code not in universe:
                continue
            sh = lambda i: _int(r[i]) or 0  # noqa: E731
            foreign = sh(4) + sh(7)
            out[code] = {
                "foreign": round(foreign / 1000),
                "trust": round(sh(10) / 1000),
                "dealer": round(sh(11) / 1000),
                "net3": round(sh(18) / 1000),
            }
        print(f"  [inst] T86 {used_date}: {len(out)} 上市 matched")
        break
    return out, used_date


# ---------------------------------------------------------------------------
# 融資融券(上市 MI_MARGN + 上櫃 TPEx;單位:張)
# ---------------------------------------------------------------------------
def build_margin(universe: set[str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    # 上市
    try:
        for row in _get_json(TWSE_MARGIN):
            code = str(row.get("股票代號") or "").strip()
            if code not in universe:
                continue
            mb, mp = _int(row.get("融資今日餘額")), _int(row.get("融資前日餘額"))
            sb, sp = _int(row.get("融券今日餘額")), _int(row.get("融券前日餘額"))
            out[code] = {
                "bal": mb,
                "chg": (mb - mp) if (mb is not None and mp is not None) else None,
                "shortBal": sb,
                "shortChg": (sb - sp) if (sb is not None and sp is not None) else None,
            }
        print(f"  [margin] TWSE {len(out)} 上市")
    except Exception as e:
        print(f"  [margin] TWSE ERR {str(e)[:60]}")
    # 上櫃
    try:
        added = 0
        for row in _get_json(TPEX_MARGIN):
            code = str(row.get("SecuritiesCompanyCode") or "").strip()
            if code not in universe or code in out:
                continue
            mb, mp = _int(row.get("MarginPurchaseBalance")), _int(row.get("MarginPurchaseBalancePreviousDay"))
            sb, sp = _int(row.get("ShortSaleBalance")), _int(row.get("ShortSaleBalancePreviousDay"))
            out[code] = {
                "bal": mb,
                "chg": (mb - mp) if (mb is not None and mp is not None) else None,
                "shortBal": sb,
                "shortChg": (sb - sp) if (sb is not None and sp is not None) else None,
            }
            added += 1
        print(f"  [margin] TPEx +{added} 上櫃")
    except Exception as e:
        print(f"  [margin] TPEx ERR {str(e)[:60]}")
    return out


# ---------------------------------------------------------------------------
# 外資持股比率(上市,TWSE MI_QFIIS;取最近兩個交易日相減算日增減 pp)
# ---------------------------------------------------------------------------
def _qfiis_day(dt: str) -> dict[str, float] | None:
    try:
        d = _get_json(MI_QFIIS.format(d=dt))
    except Exception:
        return None
    if d.get("stat") != "OK" or not d.get("data"):
        return None
    out: dict[str, float] = {}
    for r in d["data"]:
        if len(r) > 7:
            v = _f(r[7])  # 全體外資及陸資持股比率
            if v is not None:
                out[str(r[0]).strip()] = v
    return out or None


def build_foreign_hold(universe: set[str]) -> dict[str, dict]:
    days: list[dict[str, float]] = []
    back = 0
    while back < 10 and len(days) < 2:
        dt = (date.today() - timedelta(days=back)).strftime("%Y%m%d")
        back += 1
        day = _qfiis_day(dt)
        if day:
            days.append(day)
    if not days:
        print("  [foreign] MI_QFIIS no data")
        return {}
    today, prev = days[0], (days[1] if len(days) > 1 else {})
    out: dict[str, dict] = {}
    for code, pct in today.items():
        if code not in universe:
            continue
        p = prev.get(code)
        out[code] = {"pct": round(pct, 2), "chgPp": round(pct - p, 2) if p is not None else None}
    print(f"  [foreign] {len(out)} 上市 外資持股")
    return out


def main() -> None:
    setup_stdout()
    tickers, sector, desc = parse_scope_args(sys.argv[1:])
    files = find_ticker_files(tickers, sector)
    universe = set(files.keys())
    if not universe:
        print("No matching tickers.")
        return
    print(f"Chips snapshot for {desc} ({len(universe)} tickers)")

    inst_map, inst_date = build_inst_twse(universe)
    margin_map = build_margin(universe)
    holders_map = build_holders(universe)
    foreign_map = build_foreign_hold(universe)

    # 韌性:某來源(如 T86 自 CI 連線)失敗時沿用前值,避免整批上市三大法人/資券消失。
    prev: dict[str, dict] = {}
    prev_inst_date = None
    try:
        if os.path.exists(OUT):
            pj = json.load(open(OUT, encoding="utf-8")) or {}
            prev = pj.get("rows", {}) or {}
            prev_inst_date = pj.get("instDate")
    except Exception:
        prev = {}
    if not inst_map and prev_inst_date:  # T86 整批失敗 → 沿用前次資料日標示
        inst_date = prev_inst_date

    rows: dict[str, dict] = {}
    for t in sorted(universe):
        old = prev.get(t) or {}
        inst = inst_map[t] if t in inst_map else old.get("inst")
        margin = margin_map[t] if t in margin_map else old.get("margin")
        # 大戶:TDCC 失敗沿用前值;週增減基準 prevPct 僅在「資料日不同(新一週)」時以舊 pct 更新
        new_h = holders_map.get(t)
        old_h = old.get("holders")
        if new_h:
            for k in ("k1000", "k400"):
                if old_h and old_h.get("date") and old_h["date"] != new_h["date"]:
                    new_h[k]["prevPct"] = (old_h.get(k) or {}).get("pct")
                else:
                    new_h[k]["prevPct"] = (old_h.get(k) or {}).get("prevPct") if old_h else None
            holders = new_h
        else:
            holders = old_h
        fh = foreign_map[t] if t in foreign_map else old.get("foreignHold")  # 失敗沿用前值
        if inst or margin or holders or fh:
            rows[t] = {"inst": inst, "margin": margin, "holders": holders, "foreignHold": fh}

    payload = {
        "generatedAt": datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "instDate": inst_date,
        "rows": rows,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    os.replace(tmp, OUT)
    print(f"wrote {OUT}  ({len(rows)}/{len(universe)} tickers;"
          f" inst {sum(1 for r in rows.values() if r['inst'])}, margin {sum(1 for r in rows.values() if r['margin'])})")


if __name__ == "__main__":
    main()
