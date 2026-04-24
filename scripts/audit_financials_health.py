#!/usr/bin/env python3
"""
audit_financials_health.py — 健檢 data/financials_store/*.json

評估每檔「完整／缺漏」與可能原因（僅讀檔，不修改）。

預設「完整」門檻（可調）：
  - 季表期數 >= 16（與既有 audit 一致）
  - 年表期數 >= 5
  - 季表 Revenue 在「最新一季」有值（避免僅 EPS 等單欄、其餘全空之「半套」欄）

Usage:
  python scripts/audit_financials_health.py
  python scripts/audit_financials_health.py --csv out/financials_health.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import re
import sys
from collections import Counter
from dataclasses import dataclass, field

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIN_DIR = os.path.join(PROJECT_ROOT, "data", "financials_store")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from utils import setup_stdout  # noqa: E402

# 與 update_financials 預設滾動上限一致（僅作參考，非硬性「完整」）
REF_Q_COLS = 32
REF_A_COLS = 8


def _is_null(v) -> bool:
    if v is None:
        return True
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return True
    return False


def _period_key(p: str) -> str:
    return str(p).strip().split()[0][:10]


def _is_standard_quarter_end(iso: str) -> bool:
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", iso)
    if not m:
        return False
    return (int(m.group(2)), int(m.group(3))) in (
        (3, 31),
        (6, 30),
        (9, 30),
        (12, 31),
    )


def _detect_spine_kind(periods: list[str]) -> str:
    """quarterly | semi_annual | irregular"""
    if not periods:
        return "empty"
    std = sum(1 for p in periods if _is_standard_quarter_end(_period_key(p)))
    if std >= max(3, len(periods) * 0.7):
        only_6_12 = all(
            _period_key(p).endswith("-06-30") or _period_key(p).endswith("-12-31")
            for p in periods
        )
        if only_6_12 and len(periods) >= 2:
            return "semi_annual"
        return "quarterly"
    return "irregular"


@dataclass
class HealthRow:
    ticker: str
    ok: bool
    nq: int
    na: int
    nq_core: int
    nq_ytd: int
    industry_type: str
    reasons: list[str] = field(default_factory=list)
    flags: list[str] = field(default_factory=list)
    newest_period: str = ""
    rev_newest_ok: bool = False
    q_trailing_all_null_cols: int = 0
    rev_nonnull_ratio: float = 0.0
    error: str = ""


def analyze_payload(ticker: str, data: dict) -> HealthRow:
    reasons: list[str] = []
    flags: list[str] = []

    it = data.get("industryType")
    industry_type = it.strip() if isinstance(it, str) else ""

    def block_info(name: str) -> tuple[int, list[str], dict | None]:
        b = data.get(name)
        if not b or not isinstance(b, dict):
            return 0, [], None
        per = b.get("periods")
        if not isinstance(per, list):
            return 0, [], None
        return len(per), [str(x) for x in per], b

    nq, pq, qb = block_info("quarterly")
    na, pa, _ = block_info("annual")
    nq_core, _, _ = block_info("quarterlyCore")
    nq_ytd, _, _ = block_info("quarterlyYtd")

    newest = _period_key(pq[0]) if pq else ""
    rev_newest_ok = False
    q_trailing_all_null = 0
    rev_ratio = 0.0

    if qb and isinstance(qb.get("series"), dict):
        rev = qb["series"].get("Revenue")
        if isinstance(rev, list) and pq:
            # 最新一季（periods[0] 與腳本一致：新→舊）
            if not _is_null(rev[0]):
                rev_newest_ok = True
            nn = sum(1 for x in rev if not _is_null(x))
            rev_ratio = nn / len(rev) if rev else 0.0
            # 由新往舊數連續「整欄 Revenue 為 null」的欄數
            for i in range(len(rev)):
                if _is_null(rev[i]):
                    q_trailing_all_null += 1
                else:
                    break

    spine = _detect_spine_kind(pq) if pq else "empty"
    if spine == "semi_annual":
        flags.append("semi_annual_spine")
        reasons.append("季別主軸以半年為主（06-30／12-31），與標準季表不同，易與合併邏輯不完全對齊。")
    elif spine == "irregular":
        flags.append("irregular_spine")
        reasons.append("季末日期非標準 03/06/09/12，可能為特殊會計期或資料斷裂。")

    if nq > 0 and na > 0 and nq_core > 0 and nq != nq_core:
        flags.append("nq_neq_core")
        reasons.append(f"quarterly（{nq}）與 quarterlyCore（{nq_core}）期數不同，可能為 dropna／核心列保留策略差異。")

    # 門檻
    MIN_Q = 16
    MIN_A = 5
    ok = True
    if nq < MIN_Q:
        ok = False
        reasons.append(f"季表期數 {nq} < {MIN_Q}（常見：新上市／上櫃、Yahoo 季欄短、FinMind 未併入、或 MOPS 僅部分補洞）。")
    if na < MIN_A:
        ok = False
        reasons.append(f"年表期數 {na} < {MIN_A}（常見：上市年資短、或年表來源缺欄）。")
    if nq >= MIN_Q and pq and not rev_newest_ok:
        ok = False
        flags.append("newest_quarter_revenue_missing")
        reasons.append(
            "最新一季營收（Revenue）為空：可能該季財報尚未公告／來源未更新，或僅少數科目（如 EPS）先入檔。"
        )

    if nq >= MIN_Q and rev_ratio < 0.85:
        flags.append("low_revenue_fill_ratio")
        reasons.append(
            f"季表 Revenue 非空比例約 {rev_ratio:.0%}，部分期別缺營收（產業別、來源缺列、或合併後仍為 null）。"
        )

    if nq > 0 and q_trailing_all_null >= 1 and rev_newest_ok:
        # 最新有營收但前面（更新欄）有連續空 — 不常見；略過
        pass

    if industry_type in (
        "bank",
        "financial_holding",
        "insurance",
        "securities",
        "other",
    ):
        flags.append("financial_industry")
        reasons.append(
            "產業類型為金融相關：損益科目與一般業不同，毛利率等可能為 null（屬預期行為）。"
        )

    if nq >= REF_Q_COLS - 2:
        flags.append("near_max_quarters")
    if na >= REF_A_COLS - 1:
        flags.append("near_max_years")

    # 若仍 ok 且無負面 flag 太多
    if ok and not reasons:
        reasons.append("季表期數、年表期數與最新季營收檢查均通過。")

    return HealthRow(
        ticker=ticker,
        ok=ok,
        nq=nq,
        na=na,
        nq_core=nq_core,
        nq_ytd=nq_ytd,
        industry_type=industry_type or "unknown",
        reasons=reasons,
        flags=flags,
        newest_period=newest,
        rev_newest_ok=rev_newest_ok,
        q_trailing_all_null_cols=q_trailing_all_null,
        rev_nonnull_ratio=rev_ratio,
    )


def main() -> int:
    setup_stdout()
    ap = argparse.ArgumentParser(description="Health check financials_store JSON files.")
    ap.add_argument("--csv", metavar="PATH", help="Write per-ticker CSV report")
    ap.add_argument("--json-summary", metavar="PATH", help="Write JSON summary counts")
    args = ap.parse_args()

    if not os.path.isdir(FIN_DIR):
        print(f"Not found: {FIN_DIR}", file=sys.stderr)
        return 1

    rows: list[HealthRow] = []
    parse_errors: list[tuple[str, str]] = []

    for fn in sorted(os.listdir(FIN_DIR)):
        if not fn.endswith(".json"):
            continue
        path = os.path.join(FIN_DIR, fn)
        ticker = fn.replace(".json", "")
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            parse_errors.append((ticker, str(e)))
            rows.append(
                HealthRow(
                    ticker=ticker,
                    ok=False,
                    nq=0,
                    na=0,
                    nq_core=0,
                    nq_ytd=0,
                    industry_type="",
                    reasons=[f"無法解析 JSON：{e}"],
                    flags=["parse_error"],
                    error=str(e),
                )
            )
            continue
        if not isinstance(data, dict):
            parse_errors.append((ticker, "not an object"))
            continue
        rows.append(analyze_payload(ticker, data))

    total = len(rows)
    ok_n = sum(1 for r in rows if r.ok)
    bad_n = total - ok_n

    # 匯總缺漏原因（可歸因）
    reason_bucket = Counter()
    for r in rows:
        if r.ok:
            continue
        if "parse_error" in r.flags:
            reason_bucket["JSON 解析失敗"] += 1
            continue
        if r.nq < 16:
            reason_bucket["季表期數不足 (<16)"] += 1
        if r.na < 5:
            reason_bucket["年表期數不足 (<5)"] += 1
        if "newest_quarter_revenue_missing" in r.flags:
            reason_bucket["最新一季營收為空"] += 1
        if "semi_annual_spine" in r.flags:
            reason_bucket["半年報主軸"] += 1
        if "nq_neq_core" in r.flags:
            reason_bucket["quarterly 與 quarterlyCore 期數不一致"] += 1
        if "low_revenue_fill_ratio" in r.flags:
            reason_bucket["營收欄位缺漏比例高"] += 1

    print("=== data/financials_store 健檢 ===\n")
    print(f"總檔案數: {total}")
    print(
        f"判定【完整】（季>=16、年>=5、且最新季 Revenue 有值）: {ok_n} ({100 * ok_n / total:.1f}%)"
        if total
        else "0"
    )
    print(f"判定【有缺漏或需留意】: {bad_n}\n")

    print("--- 缺漏歸因（可重複計入同一檔）---")
    for k, v in reason_bucket.most_common():
        print(f"  {k}: {v}")
    print()

    print("--- 完整檔（僅列前 30 個代號；其餘略）---")
    complete = [r.ticker for r in rows if r.ok]
    for t in complete[:30]:
        print(f"  {t}")
    if len(complete) > 30:
        print(f"  ... 共 {len(complete)} 檔完整\n")
    else:
        print()

    print("--- 不完整／需留意（前 40 筆摘要）---")
    shown = 0
    for r in rows:
        if r.ok:
            continue
        shown += 1
        if shown > 40:
            break
        print(f"  {r.ticker} | 季{r.nq} 年{r.na} | {r.industry_type} | {', '.join(r.flags) or '-'}")
        for line in r.reasons[:3]:
            print(f"      → {line}")
    incomplete = [r for r in rows if not r.ok]
    if len(incomplete) > 40:
        print(f"  ... 尚餘 {len(incomplete) - 40} 檔，請用 --csv 檢視全部\n")

    if args.csv:
        os.makedirs(os.path.dirname(args.csv) or ".", exist_ok=True)
        fieldnames = [
            "ticker",
            "ok",
            "nq",
            "na",
            "nq_core",
            "nq_ytd",
            "industry_type",
            "newest_period",
            "rev_newest_ok",
            "rev_nonnull_ratio",
            "flags",
            "reasons",
        ]
        with open(args.csv, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
            w.writeheader()
            for r in rows:
                w.writerow(
                    {
                        "ticker": r.ticker,
                        "ok": r.ok,
                        "nq": r.nq,
                        "na": r.na,
                        "nq_core": r.nq_core,
                        "nq_ytd": r.nq_ytd,
                        "industry_type": r.industry_type,
                        "newest_period": r.newest_period,
                        "rev_newest_ok": r.rev_newest_ok,
                        "rev_nonnull_ratio": round(r.rev_nonnull_ratio, 4),
                        "flags": ";".join(r.flags),
                        "reasons": " | ".join(r.reasons),
                    }
                )
        print(f"Wrote {args.csv}")

    if args.json_summary:
        import json as json_mod

        summary = {
            "total": total,
            "complete_ok": ok_n,
            "incomplete": bad_n,
            "reason_buckets": dict(reason_bucket),
            "parse_errors": [{"ticker": a, "error": b} for a, b in parse_errors],
        }
        os.makedirs(os.path.dirname(args.json_summary) or ".", exist_ok=True)
        with open(args.json_summary, "w", encoding="utf-8") as f:
            json_mod.dump(summary, f, ensure_ascii=False, indent=2)
        print(f"Wrote {args.json_summary}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
