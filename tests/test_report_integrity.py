"""Corpus-wide structural integrity gate (mirrors scripts/check_report_integrity.py)."""
from __future__ import annotations

import os
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(PROJECT_ROOT, "scripts"))

from check_report_integrity import main


def test_corpus_has_no_integrity_problems() -> None:
    """No mojibake, un-rendered templates, bad filenames, dup tickers, or missing sections."""
    assert main(["--quiet"]) == 0
