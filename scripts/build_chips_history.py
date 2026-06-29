"""
build_chips_history.py — 籌碼面走勢圖用的「時間序列」快照(供 hover 連動上方卡片)。

  • 三大法人「每日」買賣超(張):TWSE T86,四欄 f=外資/t=投信/d=自營/n=三大法人合計;
    回補近 120 個交易日(首次 backfill;之後每日 append 最新交易日)。
  • 外資「每日」持股比率(%):TWSE MI_QFIIS,對齊 inst.dates 逐日回補/append。
  • 千張/400張大戶持股(占集保%):TDCC 集保分散表「每週」一筆 → 累積(保留近 ~26 週)。

股價走勢不存此檔:前端畫圖時抓 /api/bars/[ticker]。

輸出 web/public/data/chips-history.json
  { generatedAt,
    inst:        { dates:[YYYYMMDD…], rows:{ ticker:{ f:[…],t:[…],d:[…],n:[…] } } },
    foreignHold: { rows:{ ticker:[pct…] } },                       # 對齊 inst.dates
    holders:     { dates:[YYYYMMDD…(週)], rows:{ ticker:{ k1000:[%…],k400:[%…] } } } }

盤後在 CI(refresh-snapshots)跑;沿用韌性:抓不到就保留前值。重用 build_chips_snapshot 的抓取/解析。

  python scripts/build_chips_history.py                 # 全部
  python scripts/build_chips_history.py 2330 2317       # 指定數檔(測試)
  CHIPS_HIST_BACKFILL=5 python scripts/build_chips_history.py 2330   # 測試:只回補 5 個交易日
"""

from __future__ import annotations

import json
import os
import sys
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_chips_snapshot as bcs  # 共用 _get_json / _int / _f / T86 / _qfiis_day / build_holders / _SSL
from utils import find_ticker_files, parse_scope_args, setup_stdout

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "public", "data", "chips-history.json")

INST_MAX_DAYS = int(os.environ.get("CHIPS_HIST_BACKFILL", "120"))  # 三大法人保留交易日數
HOLDERS_MAX_WEEKS = 26                                             # 大戶保留週數(~半年,對齊 120 交易日)
SCAN_BACK_DAYS = 240                                              # 往回掃描日曆日上限(夠 120 交易日)
SERIES = ("f", "t", "d", "n")                                     # 外資/投信/自營/三大法人合計


def fetch_inst_day(dt: str, universe: set[str]) -> dict[str, dict] | None:
    """單一交易日每檔三大法人買賣超(張):{code:{f,t,d,n}};非交易日/失敗 → None。"""
    try:
        d = bcs._get_json(bcs.T86.format(d=dt))
    except Exception:
        return None
    if d.get("stat") != "OK" or not d.get("data"):
        return None
    if str(d.get("date") or "") != dt:  # 假日查詢可能回前一交易日 → 跳過,避免幽靈日期(如端午節 06/19)
        return None
    out: dict[str, dict] = {}
    for r in d["data"]:
        if len(r) < 19:
            continue
        code = str(r[0]).strip()
        if code not in universe:
            continue
        f = (bcs._int(r[4]) or 0) + (bcs._int(r[7]) or 0)  # 外資 = 外陸資 + 外資自營
        t, dd, n = bcs._int(r[10]), bcs._int(r[11]), bcs._int(r[18])  # 投信 / 自營 / 合計
        out[code] = {
            "f": round(f / 1000),
            "t": round(t / 1000) if t is not None else None,
            "d": round(dd / 1000) if dd is not None else None,
            "n": round(n / 1000) if n is not None else None,
        }
    return out or None


def build_inst_history(universe: set[str], prev: dict) -> dict:
    prev_dates: list[str] = (prev.get("inst") or {}).get("dates") or []
    prev_rows: dict[str, dict] = (prev.get("inst") or {}).get("rows") or {}
    have = set(prev_dates)

    collected: dict[str, dict[str, dict]] = {}
    back = 0
    while back < SCAN_BACK_DAYS:
        dt = (date.today() - timedelta(days=back)).strftime("%Y%m%d")
        back += 1
        if dt in have:
            if prev_dates:  # 增量:碰到已存日期 → 新交易日已收完,停止
                break
            continue
        day = fetch_inst_day(dt, universe)
        if day is not None:
            collected[dt] = day
        if not prev_dates and len(collected) >= INST_MAX_DAYS:
            break
    if not collected and not prev_dates:
        print("  [inst] no trading-day data fetched")
        return {"dates": [], "rows": {}}

    # 中介 {ticker: {date: {f,t,d,n}}}:先攤平前值,再併入本次
    merged: dict[str, dict[str, dict]] = {}
    for t, series in prev_rows.items():
        dmap: dict[str, dict] = {}
        for i, dt in enumerate(prev_dates):
            row = {k: (series.get(k) or [])[i] if i < len(series.get(k) or []) else None for k in SERIES}
            if any(v is not None for v in row.values()):
                dmap[dt] = row
        merged[t] = dmap
    for dt, day in collected.items():
        for code, row in day.items():
            merged.setdefault(code, {})[dt] = row

    all_dates = sorted(set(prev_dates) | set(collected.keys()))[-INST_MAX_DAYS:]
    rows: dict[str, dict] = {}
    for t, dmap in merged.items():
        series = {k: [(dmap.get(dt) or {}).get(k) for dt in all_dates] for k in SERIES}
        if any(v is not None for v in series["n"]):
            rows[t] = series
    print(f"  [inst] dates={len(all_dates)} (+{len(collected)} new), tickers={len(rows)}")
    return {"dates": all_dates, "rows": rows}


def build_foreign_history(universe: set[str], inst_dates: list[str], prev: dict) -> dict:
    """外資持股比率(%)逐日,對齊 inst_dates;只抓新日期(舊日期沿用前值)。"""
    prev_dates: list[str] = (prev.get("inst") or {}).get("dates") or []
    prev_rows: dict[str, list] = (prev.get("foreignHold") or {}).get("rows") or {}
    merged: dict[str, dict[str, float]] = {}
    for t, arr in prev_rows.items():
        merged[t] = {prev_dates[i]: arr[i] for i in range(min(len(arr), len(prev_dates))) if arr[i] is not None}

    have = set(prev_dates)
    fetched = 0
    for dt in inst_dates:
        if dt in have:
            continue  # 舊日期 → 沿用前值
        day = bcs._qfiis_day(dt)  # {code: pct}
        if day:
            fetched += 1
            for code, pct in day.items():
                merged.setdefault(code, {})[dt] = round(pct, 2)

    rows: dict[str, list] = {}
    for t in universe:
        dmap = merged.get(t)
        if not dmap:
            continue
        arr = [dmap.get(dt) for dt in inst_dates]
        if any(v is not None for v in arr):
            rows[t] = arr
    print(f"  [foreign] +{fetched} new days, tickers={len(rows)}")
    return {"rows": rows}


def build_holders_history(universe: set[str], prev: dict) -> dict:
    prev_dates: list[str] = (prev.get("holders") or {}).get("dates") or []
    prev_rows: dict[str, dict] = (prev.get("holders") or {}).get("rows") or {}
    latest = bcs.build_holders(universe)  # 最新一週 {ticker:{date,k1000,k400}}
    if not latest:
        print("  [holders] TDCC failed → keep previous")
        return prev.get("holders") or {"dates": [], "rows": {}}

    wk = next(iter(latest.values())).get("date")
    if wk in prev_dates:
        return {"dates": prev_dates, "rows": prev_rows}

    dates = (prev_dates + [wk])[-HOLDERS_MAX_WEEKS:]
    rows: dict[str, dict] = {}
    for t in universe:
        old = prev_rows.get(t) or {}

        def shift(series: list) -> list:
            base = {prev_dates[i]: series[i] for i in range(min(len(series), len(prev_dates)))}
            return [base.get(dt) for dt in dates if dt != wk]

        h = latest.get(t)
        k1000 = shift(old.get("k1000") or []) + [(h["k1000"]["pct"] if h else None)]
        k400 = shift(old.get("k400") or []) + [(h["k400"]["pct"] if h else None)]
        if any(v is not None for v in k1000 + k400):
            rows[t] = {"k1000": k1000, "k400": k400}
    print(f"  [holders] weeks={len(dates)} (latest {wk}), tickers={len(rows)}")
    return {"dates": dates, "rows": rows}


def main() -> None:
    setup_stdout()
    tickers, sector, desc = parse_scope_args(sys.argv[1:])
    universe = set(find_ticker_files(tickers, sector).keys())
    if not universe:
        print("No matching tickers.")
        return
    print(f"Chips history for {desc} ({len(universe)} tickers); inst backfill≤{INST_MAX_DAYS}d")

    prev: dict = {}
    try:
        if os.path.exists(OUT):
            prev = json.load(open(OUT, encoding="utf-8")) or {}
    except Exception:
        prev = {}

    inst = build_inst_history(universe, prev)
    foreign = build_foreign_history(universe, inst["dates"], prev)
    holders = build_holders_history(universe, prev)

    payload = {
        "generatedAt": datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "inst": inst,
        "foreignHold": foreign,
        "holders": holders,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    os.replace(tmp, OUT)
    print(f"wrote {OUT}  ({os.path.getsize(OUT) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
