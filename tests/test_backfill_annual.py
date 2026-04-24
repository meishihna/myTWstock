"""Unit tests for backfill_annual_from_quarterly (financial_supplement)."""
from __future__ import annotations

import os
import sys

import pandas as pd

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(PROJECT_ROOT, "scripts"))

from financial_supplement import backfill_annual_from_quarterly


def test_quarterly_overrides_annual_and_recomputes_margin() -> None:
    """季表覆蓋時 margin 應配合重算。"""
    ann = pd.DataFrame(
        {"2024-12-31": [1000.0, 400.0, 40.0]},
        index=["Revenue", "Gross Profit", "Gross Margin (%)"],
    )
    q = pd.DataFrame(
        {
            "2024-03-31": [200.0, 82.0, 41.0],
            "2024-06-30": [250.0, 100.0, 40.0],
            "2024-09-30": [275.0, 115.5, 42.0],
            "2024-12-31": [300.0, 132.5, 44.17],
        },
        index=["Revenue", "Gross Profit", "Gross Margin (%)"],
    )
    out = backfill_annual_from_quarterly(ann, q)
    # Rev = 200+250+275+300 = 1025; GP = 82+100+115.5+132.5 = 430; GM ≈ 41.95
    assert out.loc["Revenue", "2024-12-31"] == 1025.0
    assert out.loc["Gross Profit", "2024-12-31"] == 430.0
    assert abs(out.loc["Gross Margin (%)", "2024-12-31"] - 41.95) < 0.1


def test_incomplete_quarters_keeps_annual_and_margin() -> None:
    """季表不齊 → 保留 Yahoo 年度值，margin 也保留。"""
    ann = pd.DataFrame(
        {"2024-12-31": [1000.0, 400.0, 40.0]},
        index=["Revenue", "Gross Profit", "Gross Margin (%)"],
    )
    q = pd.DataFrame(
        {
            "2024-03-31": [200.0, 82.0, 41.0],
            "2024-06-30": [250.0, 100.0, 40.0],
            "2024-12-31": [300.0, 132.5, 44.17],
        },
        index=["Revenue", "Gross Profit", "Gross Margin (%)"],
    )
    out = backfill_annual_from_quarterly(ann, q)
    assert out.loc["Revenue", "2024-12-31"] == 1000.0
    assert out.loc["Gross Profit", "2024-12-31"] == 400.0
    assert out.loc["Gross Margin (%)", "2024-12-31"] == 40.0


def test_small_capex_no_longer_rejected() -> None:
    """小額 CAPEX 不再被 8000 保護誤殺（1240 場景）。"""
    ann = pd.DataFrame({"2024-12-31": [None]}, index=["CAPEX"])
    q = pd.DataFrame(
        {
            "2024-03-31": [-6.914],
            "2024-06-30": [-11.486],
            "2024-09-30": [-16.879],
            "2024-12-31": [-20.463],
        },
        index=["CAPEX"],
    )
    out = backfill_annual_from_quarterly(ann, q)
    assert abs(out.loc["CAPEX", "2024-12-31"] - (-55.742)) < 0.01


def test_eps_not_touched() -> None:
    """EPS 不由本函式加總，應維持原值。"""
    ann = pd.DataFrame({"2024-12-31": [5.5]}, index=["EPS"])
    q = pd.DataFrame(
        {
            "2024-03-31": [1.0],
            "2024-06-30": [1.2],
            "2024-09-30": [1.4],
            "2024-12-31": [1.6],
        },
        index=["EPS"],
    )
    out = backfill_annual_from_quarterly(ann, q)
    assert out.loc["EPS", "2024-12-31"] == 5.5
