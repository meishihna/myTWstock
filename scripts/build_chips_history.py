"""
build_chips_history.py — 籌碼面走勢圖用的「時間序列」快照。

  • 三大法人合計買賣超(張):TWSE T86,回補近 30 個交易日(首次 backfill;之後每日 append 最新交易日)。
  • 千張/400張大戶持股(占集保%):TDCC 集保分散表「每週」一筆 → 累積(保留近 ~12 週)。
    (集保免費無法回補歷史,只能從現在起每週累積;初期點很少、會逐週成形。)

股價走勢不存在此檔:前端畫圖時改抓現成的 /api/bars/[ticker]。

輸出 web/public/data/chips-history.json
  { generatedAt,
    inst:    { dates:[YYYYMMDD…(≤30)], rows:{ ticker:[net3 或 null …] } },
    holders: { dates:[YYYYMMDD…(≤12 週)], rows:{ ticker:{ k1000:[%…], k400:[%…] } } } }

盤後在 CI(refresh-snapshots)跑;沿用韌性:抓不到就保留前值。重用 build_chips_snapshot 的抓取/解析。

  python scripts/build_chips_history.py                 # 全部
  python scripts/build_chips_history.py 2330 2317 6488  # 指定數檔(測試)
  CHIPS_HIST_BACKFILL=5 python scripts/build_chips_history.py 2330   # 測試:只回補 5 個交易日
"""

from __future__ import annotations

import json
import os
import sys
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_chips_snapshot as bcs  # 共用 _get_json / _int / T86 / build_holders / _SSL
from utils import find_ticker_files, parse_scope_args, setup_stdout

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "public", "data", "chips-history.json")

INST_MAX_DAYS = int(os.environ.get("CHIPS_HIST_BACKFILL", "120"))  # 三大法人保留交易日數
HOLDERS_MAX_WEEKS = 26                                             # 大戶保留週數(~半年,對齊 120 交易日)
SCAN_BACK_DAYS = 240                                              # 往回掃描日曆日上限(夠 120 交易日)


def fetch_inst_day(dt: str, universe: set[str]) -> dict[str, int] | None:
    """單一交易日的三大法人合計買賣超(張);非交易日/失敗 → None。"""
    try:
        d = bcs._get_json(bcs.T86.format(d=dt))
    except Exception:
        return None
    if d.get("stat") != "OK" or not d.get("data"):
        return None
    out: dict[str, int] = {}
    for r in d["data"]:
        if len(r) < 19:
            continue
        code = str(r[0]).strip()
        if code not in universe:
            continue
        net3 = bcs._int(r[18])  # 三大法人買賣超股數
        if net3 is not None:
            out[code] = round(net3 / 1000)  # 股 → 張
    return out


def build_inst_history(universe: set[str], prev: dict) -> dict:
    prev_dates: list[str] = (prev.get("inst") or {}).get("dates") or []
    prev_rows: dict[str, list] = (prev.get("inst") or {}).get("rows") or {}
    have = set(prev_dates)

    # 已有歷史 → 只往回找尚未收錄的交易日(通常即最新 1~數天);無歷史 → 回補 INST_MAX_DAYS。
    collected: dict[str, dict[str, int]] = {}
    back = 0
    while back < SCAN_BACK_DAYS:
        dt = (date.today() - timedelta(days=back)).strftime("%Y%m%d")
        back += 1
        if dt in have:
            if prev_dates:  # 增量:碰到已存日期 → 新交易日已收完,停止(不重抓舊資料)
                break
            continue
        day = fetch_inst_day(dt, universe)
        if day is not None:
            collected[dt] = day
        if not prev_dates and len(collected) >= INST_MAX_DAYS:
            break  # 首次回補滿 INST_MAX_DAYS 交易日
    if not collected and not prev_dates:
        print("  [inst] no trading-day data fetched")
        return {"dates": [], "rows": {}}

    # 以 {ticker: {date: net3}} 中介合併,再對齊輸出
    merged: dict[str, dict[str, int]] = {}
    for t, arr in prev_rows.items():
        merged[t] = {prev_dates[i]: arr[i] for i in range(min(len(arr), len(prev_dates))) if arr[i] is not None}
    for dt, day in collected.items():
        for t, v in day.items():
            merged.setdefault(t, {})[dt] = v

    all_dates = sorted(set(prev_dates) | set(collected.keys()))[-INST_MAX_DAYS:]
    rows: dict[str, list] = {}
    for t, dmap in merged.items():
        arr = [dmap.get(dt) for dt in all_dates]
        if any(v is not None for v in arr):
            rows[t] = arr
    print(f"  [inst] dates={len(all_dates)} (+{len(collected)} new), tickers={len(rows)}")
    return {"dates": all_dates, "rows": rows}


def build_holders_history(universe: set[str], prev: dict) -> dict:
    prev_dates: list[str] = (prev.get("holders") or {}).get("dates") or []
    prev_rows: dict[str, dict] = (prev.get("holders") or {}).get("rows") or {}
    latest = bcs.build_holders(universe)  # 最新一週 {ticker:{date,k1000,k400}}
    if not latest:
        print("  [holders] TDCC failed → keep previous")
        return prev.get("holders") or {"dates": [], "rows": {}}

    wk = next(iter(latest.values())).get("date")  # 本週資料日
    if wk in prev_dates:                            # 同一週(重跑)→ 不重覆累積
        return {"dates": prev_dates, "rows": prev_rows}

    dates = (prev_dates + [wk])[-HOLDERS_MAX_WEEKS:]
    keep = set(dates)
    rows: dict[str, dict] = {}
    for t in universe:
        old = prev_rows.get(t) or {}
        old_k1000 = old.get("k1000") or []
        old_k400 = old.get("k400") or []
        # 先把舊序列對齊到保留窗格(以舊 dates 為基準),再接上本週
        def shift(series: list) -> list:
            base = {prev_dates[i]: series[i] for i in range(min(len(series), len(prev_dates)))}
            return [base.get(dt) for dt in dates if dt != wk]
        h = latest.get(t)
        k1000 = shift(old_k1000) + [(h["k1000"]["pct"] if h else None)]
        k400 = shift(old_k400) + [(h["k400"]["pct"] if h else None)]
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
    holders = build_holders_history(universe, prev)

    payload = {
        "generatedAt": datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "inst": inst,
        "holders": holders,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    os.replace(tmp, OUT)
    sz = os.path.getsize(OUT) / 1024
    print(f"wrote {OUT}  ({sz:.0f} KB)")


if __name__ == "__main__":
    main()
