# archive/

封存一次性／歷史腳本與輸出，保留供參考，**不屬於現行 pipeline**。
現行流程請見根目錄 `README.md` 與 `scripts/`（`add_ticker.py`、`update_financials.py`、`update_enrichment.py`、`audit_batch.py` 等）。

## 內容
- `scripts/enrich_*.py`、`gen_enrich.py` — 早期批次 enrichment 一次性腳本（已由 `update_enrichment.py` + `data/enrichment_store/` 取代）
- `test_*.py`、`test_tv.*` — 開發期探查腳本（正式測試見 `tests/`）
- `check_*.py`、`scan_needs_rerun.py` — 一次性檢查腳本
- `data_quality_report*.txt` — 歷史品質稽核輸出（現用 `scripts/audit_batch.py`）
