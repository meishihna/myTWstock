Financial supplement merge (optional)
=====================================

By default, update_financials.py pulls extra history from the FinMind public API
(Taiwan statements) and merges it with Yahoo — no manual file required.

Use this folder only if you want to override FinMind or fill gaps by hand.

1. Copy example.template.json to {ticker}.json (e.g. 2330.json).

2. Units must match the report markdown tables:
   - Money rows: 百萬台幣 (million NTD)
   - Rows with "%" in the name: percent

3. periods: oldest first (same order as values in each series list).

4. Row names must match the report, e.g. Revenue, Gross Profit, Gross Margin (%),
   Operating Income, Operating Margin (%), Net Income, Net Margin (%),
   Op Cash Flow, Investing Cash Flow, Financing Cash Flow, CAPEX,
   Selling & Marketing Exp, R&D Exp, General & Admin Exp.

5. Run: python scripts/update_financials.py {ticker}

Yahoo data takes precedence when both have a number; this file fills missing
periods and NaN cells. Omit margin % rows if you only have Revenue and profits;
margins will be derived when possible.

Data source ideas: MOPS 公開資訊觀測站, annual reports, or your own spreadsheet
(export to JSON with the shape above).
