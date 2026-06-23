#!/usr/bin/env python3
"""
check_report_integrity.py — structural integrity gate for Pilot_Reports/.

Fails (exit code 1) if any report has:
  - mojibake (U+FFFD '�') in its filename or body
  - an un-rendered template placeholder ({ticker}, {name}, {file...}, {sector}, ...)
  - a filename not matching  NNNN_<name>.md
  - a duplicate ticker (same 4-digit code used by >1 file)
  - a missing required section anchor

This guards against the exact class of breakage seen historically:
  * a Big5<->UTF-8 round-trip that destroyed CJK chars in 11 filenames+titles
  * a generator that emitted a literal `# {file.replace('.md', '')}` H1
  * add_ticker reports created without a `## 財務概況` anchor (broke the web
    parser that uses it as the customer-section delimiter)

Usage:
  python scripts/check_report_integrity.py          # check, print report, exit 1 on problems
  python scripts/check_report_integrity.py --quiet   # only print on failure
"""
import collections
import glob
import os
import re
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPORTS_DIR = os.path.join(PROJECT_ROOT, "Pilot_Reports")
REPLACEMENT_CHAR = "�"
REQUIRED_SECTIONS = [
    "## 業務簡介",
    "## 供應鏈位置",
    "## 主要客戶及供應商",
    "## 財務概況",
]
# literal, un-interpolated template fragments that must never reach a report
TEMPLATE_RE = re.compile(
    r"\{(?:ticker|name|file|sector|industry|market_cap|enterprise_value)\b"
    r"|\{[^}\n]*\.(?:replace|format)\("
)


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    quiet = "--quiet" in argv
    if sys.platform == "win32":
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    files = glob.glob(os.path.join(REPORTS_DIR, "*", "*.md"))
    problems = []
    by_ticker = collections.defaultdict(list)

    for fp in files:
        fn = os.path.basename(fp)
        rel = os.path.relpath(fp, PROJECT_ROOT).replace(os.sep, "/")
        if REPLACEMENT_CHAR in fn:
            problems.append(f"[mojibake-filename] {rel}")
        if re.match(r"^\d{4}_.+\.md$", fn):
            by_ticker[fn[:4]].append(fn)
        else:
            problems.append(f"[bad-filename] {rel} (expected NNNN_<name>.md)")
        try:
            txt = open(fp, encoding="utf-8").read()
        except Exception as e:  # noqa: BLE001
            problems.append(f"[read-error] {rel}: {e}")
            continue
        if REPLACEMENT_CHAR in txt:
            problems.append(f"[mojibake-content] {rel}")
        if TEMPLATE_RE.search(txt):
            problems.append(f"[unrendered-template] {rel}")
        for sec in REQUIRED_SECTIONS:
            if sec not in txt:
                problems.append(f"[missing-section] {rel}: {sec}")

    for ticker, fns in sorted(by_ticker.items()):
        if len(fns) > 1:
            problems.append(f"[duplicate-ticker] {ticker}: {sorted(fns)}")

    if problems:
        print(f"check_report_integrity: {len(problems)} problem(s) across {len(files)} reports:")
        for p in sorted(problems):
            print("  " + p)
        return 1
    if not quiet:
        print(f"check_report_integrity: OK — {len(files)} reports, no integrity problems.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
