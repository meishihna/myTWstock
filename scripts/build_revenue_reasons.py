"""
營收異動「原因」——事實層(頭條)產出器。

對「營收有明顯訊號」的個股(月營收加速度 |Δ|≥門檻 或 YoY |≥門檻),抓 FinMind
TaiwanStockNews 近期新聞,過濾成「與營收/訂單相關、來源可信」的頭條數則,寫入
  web/public/data/revenue-reasons.json
供自選股頁在「月營收異動」提示下方顯示「為什麼」(每則附日期/來源/連結,不編造)。

搭配 /revenue-reasons 技能:由 Claude Code 讀本檔頭條、歸納一句 `why`(深度層),
本產出器再次執行時會「保留」既有 why(仍在訊號名單內者),避免被覆寫。

用法:
  python scripts/build_revenue_reasons.py 2330 2344      # 指定代號(略過訊號門檻)
  python scripts/build_revenue_reasons.py --all          # 全市場有訊號者(建議 CI)
  python scripts/build_revenue_reasons.py --all --min-acc 25 --min-yoy 50 --days 60

需 FINMIND_TOKEN(v4 Bearer)。無 token 亦可跑但受匿名流量限制、可能抓不到。
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORE = os.path.join(ROOT, "data", "financials_store")
OUT = os.path.join(ROOT, "web", "public", "data", "revenue-reasons.json")

FINMIND_V4 = "https://api.finmindtrade.com/api/v4/data"

# ── 過濾規則 ─────────────────────────────────────────────
# 標題須含至少一個「營收相關」關鍵字(直接對應使用者要的「接到訂單/轉型」等原因)
REVENUE_KEYWORDS = [
    "營收", "業績", "營運", "營益", "訂單", "接單", "轉單", "出貨", "拉貨",
    "擴產", "產能", "新廠", "投產", "量產", "漲價", "報價", "調漲", "喊漲", "毛利",
    "獲利", "EPS", "財報", "財測", "法說", "展望", "旺季", "淡季", "新客戶", "認證",
    "打入", "供應鏈", "併購", "收購", "轉投資", "處分", "標案", "得標", "簽約", "合約",
    "稅後", "純益", "虧損", "轉盈", "轉虧", "創高", "創新高", "需求", "缺貨", "庫存",
    "去化", "報喜", "月增", "年增", "暴增", "激增", "衰退", "銳減", "轉機", "回溫",
]
# 強實質關鍵字:直接講「原因」的營收/訂單事實 → 排序時優先浮上(壓過分析師閒聊)
STRONG_KEYWORDS = [
    "訂單", "接單", "轉單", "出貨", "拉貨", "擴產", "產能", "漲價", "報價", "調漲",
    "毛利", "營收", "業績", "財報", "財測", "EPS", "純益", "稅後", "需求", "缺貨",
    "得標", "標案", "認證", "打入", "量產", "併購", "旺季", "暢旺", "強勁", "暴增",
    "激增", "年增", "月增", "衰退", "銳減", "轉盈", "轉虧", "去化", "報喜",
]
# 可信來源 → 排序加權(優先浮上,非硬性排除;白名單外仍可入選)
SOURCE_WHITELIST = [
    "經濟日報", "工商時報", "工商", "自由財經", "自由時報", "ETtoday", "鉅亨", "Anue",
    "中央社", "MoneyDJ", "財訊", "聯合", "udn", "財經新報", "科技新報", "TechNews",
    "DIGITIMES", "電子時報", "商業周刊", "今周刊", "數位時代", "旺得富", "非凡",
    "信傳媒", "中時", "中國時報", "三立", "TVBS", "Yahoo", "moneyweekly", "遠見",
    "財經M平方", "北美智權", "群益", "元大", "鏡週刊", "上報", "太報", "新頭殼",
]
# 明確排除的雜訊(論壇/盤前盤後例行貼文/非營收類公司行為)
SOURCE_BLACKLIST = ["CMoney", "facebook", "Facebook", "玩股網", "PTT", "Dcard"]
TITLE_BLACKLIST = [
    "股市爆料同學會", "期貨服務", "盤前規劃", "盤後", "當沖", "籌碼K線", "技術分析",
    "股東會", "股東常會", "股東人數", "除息", "除權", "配息", "現金股利", "減資",
    "增資", "庫藏股", "買回", "董事會決議", "停牌", "變更交易", "選擇權", "權證",
    "能不能接", "還能買", "該不該", "跌破", "漲破", "回跌", "軋空", "作帳",
]

MAX_HEADLINES = 6  # 每檔保留頭條數
REQ_SLEEP = 0.4  # 每次 FinMind 呼叫後小睡(秒),避免伺服器端限流(可由 --sleep 覆寫)


def okYoy(v) -> bool:
    return isinstance(v, (int, float)) and v == v and -100 <= v <= 500


def signal_of(mr: dict, min_acc: float, min_yoy: float):
    """回傳 (mrY, mrP, mrAcc) 若達訊號門檻,否則 None。"""
    P = mr.get("periods") or []
    Y = mr.get("yoy") or []
    if not P or not Y:
        return None
    li = -1
    for i in range(len(P) - 1, -1, -1):
        v = Y[i] if i < len(Y) else None
        if isinstance(v, (int, float)) and v == v:
            li = i
            break
    if li < 0:
        return None
    mrY = round(Y[li], 1) if okYoy(Y[li]) else None
    mrAcc = None
    if mrY is not None:
        win = []
        i = li - 1
        while i >= 0 and len(win) < 6:
            if okYoy(Y[i]):
                win.append(Y[i])
            i -= 1
        if len(win) >= 3:
            mrAcc = round(mrY - sum(win) / len(win), 1)
    hit = (mrAcc is not None and abs(mrAcc) >= min_acc) or (
        mrY is not None and abs(mrY) >= min_yoy
    )
    return (mrY, P[li], mrAcc) if hit else None


def signaled_tickers(min_acc: float, min_yoy: float):
    out = {}
    for p in sorted(glob.glob(os.path.join(STORE, "*.json"))):
        tk = os.path.basename(p)[:-5]
        try:
            with open(p, encoding="utf-8") as f:
                d = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        mr = d.get("monthlyRevenue")
        if not isinstance(mr, dict):
            continue
        sig = signal_of(mr, min_acc, min_yoy)
        if sig:
            mrY, mrP, mrAcc = sig
            # 以市值排序:「有訊號 ∩ 大市值」= 使用者會追蹤且有媒體報導者。
            # 冷門小型股(近零基期→極端%但無新聞)自動排到後面被 --top 截掉。
            mc = d.get("marketCap")
            mc = mc if isinstance(mc, (int, float)) and mc == mc else 0.0
            out[tk] = {"mrY": mrY, "mrP": mrP, "mrAcc": mrAcc, "_mc": mc}
    return out


def _fetch_day(ticker: str, day: str, token: str):
    """FinMind TaiwanStockNews 僅回傳 start_date『當天』的新聞(無區間;end_date 會 400)。"""
    q = urllib.parse.urlencode(
        {"dataset": "TaiwanStockNews", "data_id": ticker, "start_date": day}
    )
    req = urllib.request.Request(FINMIND_V4 + "?" + q)
    if token:
        req.add_header("Authorization", "Bearer " + token)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                j = json.loads(r.read().decode("utf-8"))
            if j.get("status") == 200:
                return j.get("data") or []
            time.sleep(15 * (attempt + 1))  # 402/429 流量限制 → 退避
        except urllib.error.HTTPError as e:
            if e.code == 400:
                return []  # 該日無資料/參數 → 略過
            time.sleep(5 * (attempt + 1))
        except Exception:
            time.sleep(5 * (attempt + 1))
    return []


def fetch_news(ticker: str, days: list[str], token: str):
    """逐日抓取並合併(單日語意);同標題去重。"""
    seen = set()
    merged = []
    for day in days:
        for r in _fetch_day(ticker, day, token):
            t = str(r.get("title", ""))
            key = re.sub(r"\s+", "", t)[:30]
            if key and key not in seen:
                seen.add(key)
                merged.append(r)
        time.sleep(REQ_SLEEP)
    return merged


def _clean_title(title: str) -> str:
    t = (title or "").strip()
    # 去除末端「 - 來源」與「 - 上市櫃」等尾綴
    t = re.sub(r"\s*[-–—]\s*[^-–—]{1,20}$", "", t).strip()
    # 去除開頭「2330 台積電 - 」型式
    t = re.sub(r"^\d{4,6}\s+\S+\s*[-–—]\s*", "", t).strip()
    return t


def _keep(title: str, source: str) -> bool:
    src = source or ""
    if any(b in src for b in SOURCE_BLACKLIST):
        return False
    if any(b in title for b in TITLE_BLACKLIST):
        return False
    # 唯一硬性條件:標題須含營收相關關鍵字(直接對應「原因」)
    return any(k in title for k in REVENUE_KEYWORDS)


def _is_white(title: str, source: str) -> bool:
    return any(w in (source or "") or w in title for w in SOURCE_WHITELIST)


def _strong_score(title: str) -> int:
    return sum(1 for k in STRONG_KEYWORDS if k in title)


def pick_headlines(rows: list) -> list:
    seen = set()
    cand = []
    for r in rows:
        title = str(r.get("title", ""))
        source = str(r.get("source", ""))
        if not _keep(title, source):
            continue
        clean = _clean_title(title)
        key = re.sub(r"\s+", "", clean)[:24]
        if not clean or key in seen:
            continue
        seen.add(key)
        cand.append(
            {
                "d": str(r.get("date", ""))[:10],
                "t": clean,
                "s": source,
                "u": str(r.get("link", "")) or None,
                "_st": _strong_score(clean),
                "_w": _is_white(clean, source),
            }
        )
    # 排序:實質營收關鍵字多者優先 → 可信來源 → 日期新→舊
    cand.sort(key=lambda x: (x["_st"], x["_w"], x["d"]), reverse=True)
    picks = []
    for c in cand[:MAX_HEADLINES]:
        c.pop("_st", None)
        c.pop("_w", None)
        picks.append(c)
    return picks


def load_prev() -> dict:
    if os.path.exists(OUT):
        try:
            with open(OUT, encoding="utf-8") as f:
                return json.load(f).get("notes") or {}
        except (OSError, json.JSONDecodeError):
            return {}
    return {}


def atomic_write(path: str, obj: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    os.replace(tmp, path)


def main() -> None:
    global REQ_SLEEP
    ap = argparse.ArgumentParser()
    ap.add_argument("tickers", nargs="*")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--min-acc", type=float, default=25.0)
    ap.add_argument("--min-yoy", type=float, default=50.0)
    ap.add_argument("--date-span", type=int, default=6, help="往回抓幾個日曆日的新聞")
    ap.add_argument("--top", type=int, default=250, help="--all 時取訊號最強前 N 檔(控成本)")
    ap.add_argument("--dry-run", action="store_true", help="只列出訊號名單與日期,不抓取")
    ap.add_argument("--sleep", type=float, default=REQ_SLEEP, help="每次呼叫後小睡秒數")
    args = ap.parse_args()
    REQ_SLEEP = args.sleep

    token = (os.environ.get("FINMIND_TOKEN") or os.environ.get("FINMIND_API_TOKEN") or "").strip()
    if not token:
        print("[reasons] 警告:無 FINMIND_TOKEN,可能抓不到新聞")

    if args.all:
        sig = signaled_tickers(args.min_acc, args.min_yoy)
        ranked = sorted(sig.keys(), key=lambda t: sig[t]["_mc"], reverse=True)
        targets = ranked[: args.top]
        cut = sig[targets[-1]]["_mc"] if targets else 0
        print(f"[reasons] 訊號 {len(ranked)} 檔 → 取市值前 {len(targets)} 檔"
              f"(acc≥{args.min_acc} 或 |YoY|≥{args.min_yoy};市值截點 {cut:,.0f}M)")
    else:
        targets = [t for t in args.tickers if t]
        sig = {t: {} for t in targets}
        if not targets:
            print("用法: build_revenue_reasons.py <代號...> | --all")
            return

    today = datetime.today()
    tstr = today.strftime("%Y-%m-%d")
    days_set = {(today - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(args.date_span)}
    # 月營收於每月 10-12 日公告(上月);近期窗未涵蓋時補上最近一次已公告的群聚日,
    # 讓「X月營收年增Y%…」這類解釋性新聞不致漏抓(不論本腳本何時執行)。
    anchor = today if today.day >= 12 else (today.replace(day=1) - timedelta(days=1))
    for dd in (10, 11, 12):
        try:
            days_set.add(anchor.replace(day=dd).strftime("%Y-%m-%d"))
        except ValueError:
            pass
    days = sorted((d for d in days_set if d <= tstr), reverse=True)

    if args.dry_run:
        print(f"[reasons][dry-run] 目標 {len(targets)} 檔 × {len(days)} 日 "
              f"= 約 {len(targets) * len(days)} 次 FinMind 呼叫")
        print(f"  日期窗: {days[-1]} … {days[0]}")
        print(f"  前 20 檔: {' '.join(targets[:20])}")
        return

    prev = load_prev()
    # --all:重建整份(掉出訊號名單者自然消失);指定代號:併入既有,只更新該幾檔。
    notes = {} if args.all else dict(prev)
    ok = 0
    for i, tk in enumerate(targets, 1):
        rows = fetch_news(tk, days, token)
        heads = pick_headlines(rows)
        if not heads:
            print(f"  [{i}/{len(targets)}] {tk}: 無相關頭條({len(rows)} 則原始)")
            continue
        entry = {
            "asOf": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "sig": sig.get(tk, {}),
            "heads": heads,
        }
        # 保留既有 why(深度層由技能生成),避免被覆寫
        old = prev.get(tk) or {}
        if old.get("why"):
            entry["why"] = old["why"]
            entry["whyAsOf"] = old.get("whyAsOf")
        notes[tk] = entry
        ok += 1
        print(f"  [{i}/{len(targets)}] {tk}: {len(heads)} 頭條 | {heads[0]['t'][:36]}")

    payload = {
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "count": len(notes),
        "notes": notes,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    atomic_write(OUT, payload)
    print(f"[reasons] 寫入 {OUT} | {ok}/{len(targets)} 檔有頭條")


if __name__ == "__main__":
    main()
