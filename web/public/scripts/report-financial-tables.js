/**
 * 報告正文內財務表：年度最多 8 欄、季度最多 32 欄（與 financials JSON 預設一致）。
 * 若有 data-fin-annual-json / data-fin-quarterly-display-json，欄位由 JSON 重建（不受 MD 表頭欄數限制）。
 * 欄位順序與 MD 一致：新→舊（最新年度／季別在最左，往右遞減）。
 * 「金額」與「占營收%」二選一顯示；季度表若有 financials JSON 的 quarterlyYtd，
 * 另顯示「當季合併／累積合併」切換。首欄 sticky 由 CSS 處理。
 */
(function () {
  var MAX_ANNUAL_PERIODS = 8;
  var MAX_QUARTERLY_PERIODS = 32;

  function parseNum(text) {
    if (text == null) return null;
    var s = String(text)
      .replace(/\u2014/g, "-")
      .replace(/,/g, "")
      .trim();
    if (s === "" || s === "-" || s === "—") return null;
    s = s.replace(/%/g, "").trim();
    var n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }

  /** 毛利率／淨利率等比率列：固定小數點後兩位（含來自 JSON 的長浮點）。 */
  function formatPercentMetricDisplay(raw) {
    var t = String(raw || "").trim();
    if (!t) return "—";
    var n = parseNum(raw);
    if (n == null) return t;
    return new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  }

  /** 金額欄：可解析數字則加千分位；比率列兩位小數。 */
  function formatAmountDisplay(raw, isPctRow) {
    var t = String(raw || "").trim();
    if (!t) return "—";
    if (isPctRow) return formatPercentMetricDisplay(raw);
    var n = parseNum(raw);
    if (n == null) return t;
    return new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(n);
  }

  function isPeriodHeaderCell(text) {
    var t = String(text || "").trim();
    return (
      /^\d{4}-\d{2}-\d{2}/.test(t) ||
      /^\d{4}$/.test(t) ||
      /^\d{4}\s+Q[1-4]$/i.test(t) ||
      /^\d{4}Q[1-4]$/i.test(t)
    );
  }

  function findDataColumnIndices(headerRow) {
    var idx = [];
    for (var i = 0; i < headerRow.cells.length; i++) {
      var t = headerRow.cells[i].textContent.trim();
      if (isPeriodHeaderCell(t)) idx.push(i);
    }
    return idx;
  }

  function inferMaxPeriods(periodLabels) {
    if (!periodLabels.length) return MAX_QUARTERLY_PERIODS;
    var allYearOnly = periodLabels.every(function (p) {
      return /^\d{4}$/.test(String(p).trim());
    });
    return allYearOnly ? MAX_ANNUAL_PERIODS : MAX_QUARTERLY_PERIODS;
  }

  function isPercentMetricLabel(text) {
    return /%|利率|Margin|margin|毛利率|淨利率|營業利益率|Operating|Net Margin|Gross Margin/i.test(
      text || ""
    );
  }

  function isRevenueLabel(label) {
    var t = String(label || "").trim();
    return (
      t === "營收" ||
      t === "營業收入" ||
      t === "該期間營業收入" ||
      t === "Revenue" ||
      /^營收\s/.test(t)
    );
  }

  /** 三項費用列：單季為負時可能為年末調整／重分類（MOPS 反累計） */
  function isExpenseMetricLabel(label) {
    var t = String(label || "").trim();
    return (
      t === "Selling & Marketing Exp" ||
      t === "R&D Exp" ||
      t === "General & Admin Exp" ||
      t === "銷售及行銷費用" ||
      t === "研發費用" ||
      t === "一般及管理費用"
    );
  }

  var INDUSTRY_HIDDEN_ROWS = {
    general: {},
    financial_holding: {
      "Cost of Revenue": 1, "營業成本": 1,
      "Gross Profit": 1, "Gross Margin (%)": 1,
      "營業毛利": 1, "毛利率 (%)": 1,
      "Selling & Marketing Exp": 1, "R&D Exp": 1,
      "銷售及行銷費用": 1, "研發費用": 1,
      "Operating Income": 1, "Operating Margin (%)": 1,
      "營業利益": 1, "營業利益率 (%)": 1,
      "CAPEX": 1, "資本支出": 1
    },
    bank: {
      "Cost of Revenue": 1, "營業成本": 1,
      "Gross Profit": 1, "Gross Margin (%)": 1,
      "營業毛利": 1, "毛利率 (%)": 1,
      "Selling & Marketing Exp": 1, "R&D Exp": 1,
      "銷售及行銷費用": 1, "研發費用": 1,
      "Operating Income": 1, "Operating Margin (%)": 1,
      "營業利益": 1, "營業利益率 (%)": 1,
      "CAPEX": 1, "資本支出": 1
    },
    insurance: {
      "Gross Profit": 1, "Gross Margin (%)": 1,
      "營業毛利": 1, "毛利率 (%)": 1,
      "Selling & Marketing Exp": 1, "R&D Exp": 1,
      "銷售及行銷費用": 1, "研發費用": 1,
      "CAPEX": 1, "資本支出": 1
    },
    securities: {
      "Cost of Revenue": 1, "營業成本": 1,
      "Gross Profit": 1, "Gross Margin (%)": 1,
      "營業毛利": 1, "毛利率 (%)": 1,
      "Selling & Marketing Exp": 1, "R&D Exp": 1,
      "銷售及行銷費用": 1, "研發費用": 1,
      "General & Admin Exp": 1, "一般及管理費用": 1,
      "CAPEX": 1, "資本支出": 1
    },
    other: {
      "Cost of Revenue": 1, "營業成本": 1,
      "Gross Profit": 1, "Gross Margin (%)": 1,
      "營業毛利": 1, "毛利率 (%)": 1,
      "Selling & Marketing Exp": 1, "R&D Exp": 1,
      "銷售及行銷費用": 1, "研發費用": 1,
      "General & Admin Exp": 1, "一般及管理費用": 1,
      "Operating Income": 1, "Operating Margin (%)": 1,
      "營業利益": 1, "營業利益率 (%)": 1,
      "CAPEX": 1, "資本支出": 1
    }
  };

  function normalizeIndustryTypeForTables(industryType) {
    var t = String(industryType || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_");
    if (!t || t === "n/a" || t === "na") return "general";
    if (!(t in INDUSTRY_HIDDEN_ROWS)) return "general";
    return t;
  }

  function filterModelByIndustry(model, industryType) {
    var it = normalizeIndustryTypeForTables(industryType);
    if (it === "general") return model;
    var hidden = INDUSTRY_HIDDEN_ROWS[it] || {};
    if (!Object.keys(hidden).length) return model;
    var filteredRows = [];
    var oldRevRow = model.revRowInBody;
    var newRevRow = -1;
    for (var i = 0; i < model.rows.length; i++) {
      var label = model.rows[i].label;
      if (hidden[label]) continue;
      if (i === oldRevRow) newRevRow = filteredRows.length;
      filteredRows.push(model.rows[i]);
    }
    return {
      periods: model.periods,
      revRowInBody: newRevRow,
      revenues: model.revenues,
      rows: filteredRows
    };
  }

  /** 與 renderReport.ts FIN_TABLE_ROW_EN_TO_ZH 相反（表頭已中文化） */
  var ZH_TO_EN = {
    "毛利率 (%)": "Gross Margin (%)",
    "營業利益率 (%)": "Operating Margin (%)",
    "淨利率 (%)": "Net Margin (%)",
    "銷售及行銷費用": "Selling & Marketing Exp",
    "一般及管理費用": "General & Admin Exp",
    "營業成本": "Cost of Revenue",
    "營業利益": "Operating Income",
    "營業毛利": "Gross Profit",
    "淨利": "Net Income",
    "投資活動之現金流量": "Investing Cash Flow",
    "籌資活動之現金流量": "Financing Cash Flow",
    "營業活動之現金流量": "Op Cash Flow",
    "研發費用": "R&D Exp",
    "營業收入": "Revenue",
    "每股盈餘（元）": "EPS",
    "資本支出": "CAPEX",
  };

  function quarterLabelToIso(label) {
    var t = String(label).trim();
    var m =
      t.match(/^(\d{4})\s+Q([1-4])$/i) || t.match(/^(\d{4})Q([1-4])$/i);
    if (!m) return null;
    var y = parseInt(m[1], 10);
    var q = parseInt(m[2], 10);
    var md = { 1: [3, 31], 2: [6, 30], 3: [9, 30], 4: [12, 31] }[q];
    function pad(n) {
      return n < 10 ? "0" + n : "" + n;
    }
    return y + "-" + pad(md[0]) + "-" + pad(md[1]);
  }

  function normalizeIso(p) {
    var s = String(p).trim();
    if (s.length >= 10) return s.slice(0, 10);
    var m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : s;
  }

  function isQuarterlyModel(model) {
    if (!model.periods || !model.periods.length) return false;
    for (var i = 0; i < model.periods.length; i++) {
      var p = String(model.periods[i]).trim();
      if (!/^\d{4}\s+Q[1-4]$/i.test(p) && !/^\d{4}Q[1-4]$/i.test(p)) {
        return false;
      }
    }
    return true;
  }

  /** 年度表：欄名為西元年（與 MD 年表一致） */
  function isAnnualYearOnlyModel(model) {
    if (!model.periods || !model.periods.length) return false;
    for (var i = 0; i < model.periods.length; i++) {
      if (!/^\d{4}$/.test(String(model.periods[i]).trim())) {
        return false;
      }
    }
    return true;
  }

  /**
   * 年報 EPS 誤為單季時：以同年曆年單季 EPS 加總覆寫（與儀表板／季累積口徑一致）。
   */
  /**
   * JSON annual.periods 為舊→新；表頭為新→左。取最後 maxLen 個曆年欄。
   */
  function rebuildAnnualFromJson(model, block, maxLen) {
    if (!block || !Array.isArray(block.periods) || !block.series) return model;
    var n = block.periods.length;
    if (n === 0) return model;
    var start = Math.max(0, n - maxLen);
    var tail = block.periods.slice(start);
    var displayPeriods = [];
    var jsonIndices = [];
    for (var ti = tail.length - 1; ti >= 0; ti--) {
      var iso = normalizeIso(tail[ti]);
      var ym = iso.match(/^(\d{4})/);
      displayPeriods.push(ym ? ym[1] : String(tail[ti]).trim().slice(0, 4));
      jsonIndices.push(start + ti);
    }
    var newRows = model.rows.map(function (row) {
      var lab = String(row.label || "").trim();
      var en = ZH_TO_EN[lab];
      if (!en && lab && block.series[lab]) en = lab;
      var rawVals = jsonIndices.map(function (idx) {
        if (!en || !block.series[en]) return "";
        var arr = block.series[en];
        if (!Array.isArray(arr) || idx >= arr.length) return "";
        var v = arr[idx];
        if (v == null || !Number.isFinite(v)) return "";
        return String(v);
      });
      return { label: row.label, rawVals: rawVals };
    });
    var revRowInBody = -1;
    for (var r = 0; r < newRows.length; r++) {
      if (isRevenueLabel(newRows[r].label)) {
        revRowInBody = r;
        break;
      }
    }
    var revenues = displayPeriods.map(function (_, j) {
      if (revRowInBody < 0) return null;
      return parseNum(newRows[revRowInBody].rawVals[j]);
    });
    return {
      periods: displayPeriods,
      revRowInBody: revRowInBody,
      revenues: revenues,
      rows: newRows,
    };
  }

  /** 與 quarterLabelToIso 可互轉：須為四位年 + Q（空白可選） */
  function isoToQuarterHeader(iso) {
    var m = String(iso).trim().match(/^(\d{4})-(\d{2})-\d{2}$/);
    if (!m) return String(iso).trim();
    var y = m[1];
    var mo = parseInt(m[2], 10);
    var q = mo <= 3 ? 1 : mo <= 6 ? 2 : mo <= 9 ? 3 : 4;
    return y + " Q" + q;
  }

  function rebuildQuarterlyFromJson(model, block, maxLen) {
    if (!block || !Array.isArray(block.periods) || !block.series) return model;
    var n = block.periods.length;
    if (n === 0) return model;
    var start = Math.max(0, n - maxLen);
    var tail = block.periods.slice(start);
    var displayPeriods = [];
    var jsonIndices = [];
    for (var tj = tail.length - 1; tj >= 0; tj--) {
      displayPeriods.push(isoToQuarterHeader(tail[tj]));
      jsonIndices.push(start + tj);
    }
    var newRows = model.rows.map(function (row) {
      var lab = String(row.label || "").trim();
      var en = ZH_TO_EN[lab];
      if (!en && lab && block.series[lab]) en = lab;
      var rawVals = jsonIndices.map(function (idx) {
        if (!en || !block.series[en]) return "";
        var arr = block.series[en];
        if (!Array.isArray(arr) || idx >= arr.length) return "";
        var v = arr[idx];
        if (v == null || !Number.isFinite(v)) return "";
        return String(v);
      });
      return { label: row.label, rawVals: rawVals };
    });
    var revRowInBody = -1;
    for (var r2 = 0; r2 < newRows.length; r2++) {
      if (isRevenueLabel(newRows[r2].label)) {
        revRowInBody = r2;
        break;
      }
    }
    var revenues = displayPeriods.map(function (_, j) {
      if (revRowInBody < 0) return null;
      return parseNum(newRows[revRowInBody].rawVals[j]);
    });
    return {
      periods: displayPeriods,
      revRowInBody: revRowInBody,
      revenues: revenues,
      rows: newRows,
    };
  }

  function patchAnnualModelEpsFromQuarterly(model, qBlock) {
    if (!qBlock || !qBlock.series || !qBlock.periods) return model;
    var qEps = qBlock.series.EPS;
    if (!Array.isArray(qEps) || qEps.length !== qBlock.periods.length) {
      return model;
    }
    var epsRow = -1;
    for (var r = 0; r < model.rows.length; r++) {
      var lab = String(model.rows[r].label || "").trim();
      if (lab === "EPS" || lab === "每股盈餘（元）") {
        epsRow = r;
        break;
      }
    }
    if (epsRow < 0) return model;

    var newRows = model.rows.map(function (row) {
      return { label: row.label, rawVals: row.rawVals.slice() };
    });

    for (var j = 0; j < model.periods.length; j++) {
      var yStr = String(model.periods[j]).trim();
      if (!/^\d{4}$/.test(yStr)) continue;
      var y = parseInt(yStr, 10);
      var sum = 0;
      var any = false;
      for (var qi = 0; qi < qBlock.periods.length; qi++) {
        var qm = String(qBlock.periods[qi])
          .trim()
          .match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (!qm) continue;
        if (parseInt(qm[1], 10) !== y) continue;
        var v = qEps[qi];
        if (v != null && Number.isFinite(v)) {
          sum += v;
          any = true;
        }
      }
      if (any) {
        newRows[epsRow].rawVals[j] = String(sum);
      }
    }

    return {
      periods: model.periods.slice(),
      revRowInBody: model.revRowInBody,
      revenues: model.revenues.slice(),
      rows: newRows,
    };
  }

  function buildYtdModel(singleModel, block) {
    if (
      !block ||
      !Array.isArray(block.periods) ||
      !block.series ||
      typeof block.series !== "object"
    ) {
      return null;
    }
    var rows = singleModel.rows.map(function (row) {
      /** 列名未中文化者（如 EPS）與 JSON 鍵一致時直接用英文鍵 */
      var lab = String(row.label || "").trim();
      var en = ZH_TO_EN[lab];
      if (!en && lab && block.series[lab]) {
        en = lab;
      }
      var rawVals = singleModel.periods.map(function (periodLabel) {
        var iso = quarterLabelToIso(periodLabel);
        if (!iso) return "";
        var idx = -1;
        for (var i = 0; i < block.periods.length; i++) {
          if (normalizeIso(block.periods[i]) === iso) {
            idx = i;
            break;
          }
        }
        if (idx < 0) return "";
        if (!en || !block.series[en]) return "";
        var arr = block.series[en];
        if (!Array.isArray(arr) || idx >= arr.length) return "";
        var v = arr[idx];
        if (v == null || !Number.isFinite(v)) return "";
        return String(v);
      });
      return { label: row.label, rawVals: rawVals };
    });
    var revRow = singleModel.revRowInBody;
    var revenues = singleModel.periods.map(function (_, j) {
      if (revRow < 0) return null;
      return parseNum(rows[revRow].rawVals[j]);
    });
    return {
      periods: singleModel.periods.slice(),
      revRowInBody: revRow,
      revenues: revenues,
      rows: rows,
    };
  }

  function getHeaderRow(table) {
    if (table.tHead && table.tHead.rows.length > 0) {
      return table.tHead.rows[0];
    }
    return table.rows[0];
  }

  function getBodyRows(table) {
    var out = [];
    if (table.tBodies.length) {
      for (var bi = 0; bi < table.tBodies.length; bi++) {
        var tb = table.tBodies[bi];
        for (var ri = 0; ri < tb.rows.length; ri++) {
          out.push(tb.rows[ri]);
        }
      }
      return out;
    }
    for (var i = 1; i < table.rows.length; i++) {
      var tr = table.rows[i];
      var c0 = tr.cells[0] ? tr.cells[0].textContent.trim() : "";
      if (/^[\s:|]+$/.test(c0)) continue;
      if (c0.replace(/\s/g, "").match(/^:?-+:?$/)) continue;
      out.push(tr);
    }
    return out;
  }

  function isFinancialTable(table) {
    if (table.classList.contains("fin-table-amount-pct")) return false;
    var hr = getHeaderRow(table);
    if (!hr) return false;
    return findDataColumnIndices(hr).length >= 2;
  }

  function extractModel(table) {
    var headerRow = getHeaderRow(table);
    var dataColIdx = findDataColumnIndices(headerRow);
    if (dataColIdx.length < 2) return null;

    var periods = dataColIdx.map(function (i) {
      return headerRow.cells[i].textContent.trim();
    });
    var cap = inferMaxPeriods(periods);
    var n = Math.min(cap, periods.length);
    dataColIdx = dataColIdx.slice(0, n);
    periods = periods.slice(0, n);

    var bodyRows = getBodyRows(table);
    if (!bodyRows.length) return null;

    var revRowInBody = -1;
    for (var r = 0; r < bodyRows.length; r++) {
      var lab = bodyRows[r].cells[0] ? bodyRows[r].cells[0].textContent.trim() : "";
      if (isRevenueLabel(lab)) {
        revRowInBody = r;
        break;
      }
    }

    var revenues = dataColIdx.map(function (ci) {
      if (revRowInBody < 0) return null;
      return parseNum(bodyRows[revRowInBody].cells[ci] && bodyRows[revRowInBody].cells[ci].textContent);
    });

    var rows = bodyRows.map(function (tr) {
      var label = tr.cells[0] ? tr.cells[0].textContent.trim() : "";
      var rawVals = dataColIdx.map(function (ci) {
        var c = tr.cells[ci];
        return c ? String(c.textContent || "").trim() : "";
      });
      return { label: label, rawVals: rawVals };
    });

    return {
      periods: periods,
      revRowInBody: revRowInBody,
      revenues: revenues,
      rows: rows,
    };
  }

  function formatPct(pct) {
    return (
      pct.toLocaleString("zh-TW", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }) + "%"
    );
  }

  function cellPctOfRevenue(raw, rev, isPctRow, isRev) {
    if (isPctRow) return { text: "—", neg: false };
    if (isRev) {
      if (rev != null && Number.isFinite(rev) && rev !== 0) {
        return { text: "100.00%", neg: false };
      }
      return { text: "—", neg: false };
    }
    var val = parseNum(raw);
    if (val != null && rev != null && Number.isFinite(rev) && rev !== 0) {
      var pct = (val / rev) * 100;
      return { text: formatPct(pct), neg: pct < 0 };
    }
    return { text: "—", neg: false };
  }

  function buildAmountOnlyTable(model) {
    var newTable = document.createElement("table");
    newTable.className = "fin-table-amount-pct fin-table-view-amount-only";

    var thead = document.createElement("thead");
    var trTop = document.createElement("tr");
    var corner = document.createElement("th");
    corner.scope = "col";
    corner.textContent = "科目";
    trTop.appendChild(corner);
    for (var pi = 0; pi < model.periods.length; pi++) {
      var th = document.createElement("th");
      th.className = "fin-th-period-single";
      th.textContent = model.periods[pi];
      trTop.appendChild(th);
    }
    thead.appendChild(trTop);
    newTable.appendChild(thead);

    var tbody = document.createElement("tbody");
    for (var ri = 0; ri < model.rows.length; ri++) {
      var row = model.rows[ri];
      var newTr = document.createElement("tr");
      var thLabel = document.createElement("th");
      thLabel.scope = "row";
      thLabel.textContent = row.label;
      newTr.appendChild(thLabel);

      var isPctRow = isPercentMetricLabel(row.label);

      for (var j = 0; j < model.periods.length; j++) {
        var raw = row.rawVals[j] || "";
        var td = document.createElement("td");
        td.className = "fin-td-amount-only";
        var disp = formatAmountDisplay(raw, isPctRow);
        td.textContent = disp;
        var nAmt = parseNum(raw);
        if (nAmt != null && nAmt < 0) td.classList.add("fin-num-neg");
        if (
          !isPctRow &&
          isExpenseMetricLabel(row.label) &&
          nAmt != null &&
          nAmt < 0
        ) {
          td.classList.add("fin-expense-ye-adj");
          td.title =
            "單季為負可能為年末沖回、重分類或重編；與部分法說單季口徑可能不同。";
          td.textContent = disp + "\u00a0*";
        }
        newTr.appendChild(td);
      }
      tbody.appendChild(newTr);
    }
    newTable.appendChild(tbody);
    return newTable;
  }

  function buildPctOnlyTable(model) {
    var newTable = document.createElement("table");
    newTable.className = "fin-table-amount-pct fin-table-view-pct-only";

    var thead = document.createElement("thead");
    var trTop = document.createElement("tr");
    var corner = document.createElement("th");
    corner.scope = "col";
    corner.textContent = "科目";
    trTop.appendChild(corner);
    for (var pi = 0; pi < model.periods.length; pi++) {
      var th = document.createElement("th");
      th.className = "fin-th-period-single";
      th.textContent = model.periods[pi];
      trTop.appendChild(th);
    }
    thead.appendChild(trTop);
    newTable.appendChild(thead);

    var tbody = document.createElement("tbody");
    for (var ri = 0; ri < model.rows.length; ri++) {
      var row = model.rows[ri];
      var newTr = document.createElement("tr");
      var thLabel = document.createElement("th");
      thLabel.scope = "row";
      thLabel.textContent = row.label;
      newTr.appendChild(thLabel);

      var isPctRow = isPercentMetricLabel(row.label);
      var isRev = ri === model.revRowInBody;

      for (var j = 0; j < model.periods.length; j++) {
        var raw = row.rawVals[j] || "";
        var rev = model.revenues[j];
        var td = document.createElement("td");
        td.className = "fin-td-pct-only";

        if (isPctRow) {
          td.textContent = formatPercentMetricDisplay(raw);
          var nKeep = parseNum(raw);
          if (nKeep != null && nKeep < 0) td.classList.add("fin-num-neg");
        } else {
          var p = cellPctOfRevenue(raw, rev, false, isRev);
          td.textContent = p.text;
          if (p.neg) td.classList.add("fin-num-neg");
          var rawN = parseNum(raw);
          if (
            isExpenseMetricLabel(row.label) &&
            rawN != null &&
            rawN < 0
          ) {
            td.classList.add("fin-expense-ye-adj");
            td.title =
              "金額欄為負（占營收% 由此推算）；可能為年末調整／重分類。";
          }
        }
        newTr.appendChild(td);
      }
      tbody.appendChild(newTr);
    }
    newTable.appendChild(tbody);
    return newTable;
  }

  function enhanceTable(
    table,
    hintText,
    labelAmount,
    labelPct,
    groupAria,
    consolidationOpts,
    industryType
  ) {
    var modelSingle = extractModel(table);
    if (!modelSingle) return;

    var annualJsonBlock =
      consolidationOpts && consolidationOpts.annualDisplayBlock;
    var quarterlyDisplayBlock =
      consolidationOpts && consolidationOpts.quarterlyDisplayBlock;

    if (annualJsonBlock && isAnnualYearOnlyModel(modelSingle)) {
      modelSingle = rebuildAnnualFromJson(
        modelSingle,
        annualJsonBlock,
        MAX_ANNUAL_PERIODS
      );
    }
    /** 季表表頭可能是 yyQn、yyyy Qn 或 YYYY-MM-DD；純西元年欄為年表 */
    if (quarterlyDisplayBlock && !isAnnualYearOnlyModel(modelSingle)) {
      modelSingle = rebuildQuarterlyFromJson(
        modelSingle,
        quarterlyDisplayBlock,
        MAX_QUARTERLY_PERIODS
      );
    }

    var qBlockAnnual =
      consolidationOpts && consolidationOpts.quarterlyBlockForAnnualEps;
    if (qBlockAnnual && isAnnualYearOnlyModel(modelSingle)) {
      modelSingle = patchAnnualModelEpsFromQuarterly(modelSingle, qBlockAnnual);
    }
    modelSingle = filterModelByIndustry(modelSingle, industryType);

    var ytdBlock = consolidationOpts && consolidationOpts.ytdBlock;
    var labelConsSingle =
      (consolidationOpts && consolidationOpts.labelSingle) || "當季合併";
    var labelConsYtd =
      (consolidationOpts && consolidationOpts.labelYtd) || "累積合併";
    var consolidationGroupAria =
      (consolidationOpts && consolidationOpts.consolidationAria) || "";

    var modelYtdRaw =
      ytdBlock && isQuarterlyModel(modelSingle)
        ? buildYtdModel(modelSingle, ytdBlock)
        : null;
    var modelYtd = modelYtdRaw ? filterModelByIndustry(modelYtdRaw, industryType) : null;
    var hasYtd = Boolean(modelYtd);

    var wrap = document.createElement("div");
    wrap.className = "fin-table-toggle-wrap";
    table.parentNode.insertBefore(wrap, table);

    var toolbar = document.createElement("div");
    toolbar.className = "fin-table-toolbar";

    if (hintText) {
      var hint = document.createElement("p");
      hint.className = "fin-table-toolbar-hint";
      hint.textContent = hintText;
      toolbar.appendChild(hint);
    }

    var tools = document.createElement("div");
    tools.className = "fin-table-toolbar-tools";

    var btnSingle;
    var btnYtd;
    if (hasYtd) {
      var consGroup = document.createElement("div");
      consGroup.className = "fin-table-toolbar-tool-group";
      consGroup.setAttribute("role", "group");
      if (consolidationGroupAria) {
        consGroup.setAttribute("aria-label", consolidationGroupAria);
      }
      var consSwitch = document.createElement("div");
      consSwitch.className = "fin-table-mode-switch";

      btnSingle = document.createElement("button");
      btnSingle.type = "button";
      btnSingle.className = "fin-table-mode-btn is-active";
      btnSingle.setAttribute("data-fin-consolidation", "single");
      btnSingle.setAttribute("aria-pressed", "true");
      btnSingle.textContent = labelConsSingle;

      btnYtd = document.createElement("button");
      btnYtd.type = "button";
      btnYtd.className = "fin-table-mode-btn";
      btnYtd.setAttribute("data-fin-consolidation", "ytd");
      btnYtd.setAttribute("aria-pressed", "false");
      btnYtd.textContent = labelConsYtd;

      consSwitch.appendChild(btnSingle);
      consSwitch.appendChild(btnYtd);
      consGroup.appendChild(consSwitch);
      tools.appendChild(consGroup);

      var sep = document.createElement("span");
      sep.className = "fin-table-toolbar-sep";
      sep.setAttribute("aria-hidden", "true");
      tools.appendChild(sep);
    }

    var amtGroup = document.createElement("div");
    amtGroup.className = "fin-table-toolbar-tool-group";
    amtGroup.setAttribute("role", "group");
    if (groupAria) amtGroup.setAttribute("aria-label", groupAria);

    var switchEl = document.createElement("div");
    switchEl.className = "fin-table-mode-switch";

    var btnAmt = document.createElement("button");
    btnAmt.type = "button";
    btnAmt.className = "fin-table-mode-btn is-active";
    btnAmt.setAttribute("data-fin-mode", "amount");
    btnAmt.setAttribute("aria-pressed", "true");
    btnAmt.textContent = labelAmount || "Amount";

    var btnPct = document.createElement("button");
    btnPct.type = "button";
    btnPct.className = "fin-table-mode-btn";
    btnPct.setAttribute("data-fin-mode", "pct");
    btnPct.setAttribute("aria-pressed", "false");
    btnPct.textContent = labelPct || "% of revenue";

    switchEl.appendChild(btnAmt);
    switchEl.appendChild(btnPct);
    amtGroup.appendChild(switchEl);
    tools.appendChild(amtGroup);
    toolbar.appendChild(tools);

    wrap.appendChild(toolbar);

    var view = document.createElement("div");
    view.className = "fin-table-view-slot";

    var currentAmountPctMode = "amount";
    var activeModel = modelSingle;

    function refreshView() {
      var isPct = currentAmountPctMode === "pct";
      while (view.firstChild) view.removeChild(view.firstChild);
      view.appendChild(
        isPct
          ? buildPctOnlyTable(activeModel)
          : buildAmountOnlyTable(activeModel)
      );
    }

    function setAmountPct(mode) {
      currentAmountPctMode = mode;
      var isPct = mode === "pct";
      btnAmt.classList.toggle("is-active", !isPct);
      btnPct.classList.toggle("is-active", isPct);
      btnAmt.setAttribute("aria-pressed", isPct ? "false" : "true");
      btnPct.setAttribute("aria-pressed", isPct ? "true" : "false");
      refreshView();
    }

    function setConsolidation(mode) {
      if (!hasYtd || !btnSingle || !btnYtd) return;
      activeModel = mode === "ytd" ? modelYtd : modelSingle;
      var isYtd = mode === "ytd";
      btnSingle.classList.toggle("is-active", !isYtd);
      btnYtd.classList.toggle("is-active", isYtd);
      btnSingle.setAttribute("aria-pressed", isYtd ? "false" : "true");
      btnYtd.setAttribute("aria-pressed", isYtd ? "true" : "false");
      refreshView();
    }

    btnAmt.addEventListener("click", function () {
      setAmountPct("amount");
    });
    btnPct.addEventListener("click", function () {
      setAmountPct("pct");
    });

    if (hasYtd && btnSingle && btnYtd) {
      btnSingle.addEventListener("click", function () {
        setConsolidation("single");
      });
      btnYtd.addEventListener("click", function () {
        setConsolidation("ytd");
      });
    }

    view.appendChild(buildAmountOnlyTable(activeModel));

    var scrollWrap = document.createElement("div");
    scrollWrap.className = "fin-table-scroll";
    scrollWrap.appendChild(view);
    wrap.appendChild(scrollWrap);

    table.remove();
  }

  function initReportFinancialTables(root) {
    var hint =
      root.getAttribute("data-fin-table-hint") ||
      root.getAttribute("data-fin-table-toggle-label") ||
      "";
    var labelAmount =
      root.getAttribute("data-fin-table-mode-amount-label") || "金額";
    var labelPct =
      root.getAttribute("data-fin-table-mode-pct-label") || "占營收%";
    var groupAria = root.getAttribute("data-fin-table-mode-aria") || "";
    var industryType = root.getAttribute("data-fin-industry-type") || "general";
    var rawYtd = root.getAttribute("data-fin-quarterly-ytd-json");
    var ytdBlock = null;
    if (rawYtd && String(rawYtd).trim()) {
      try {
        ytdBlock = JSON.parse(rawYtd);
      } catch (e) {
        ytdBlock = null;
      }
    }
    var labelConsSingle =
      root.getAttribute("data-fin-table-consolidation-single-label") ||
      "當季合併";
    var labelConsYtd =
      root.getAttribute("data-fin-table-consolidation-ytd-label") ||
      "累積合併";
    var consolidationAria =
      root.getAttribute("data-fin-table-consolidation-aria") || "";
    var rawQuarterly = root.getAttribute("data-fin-quarterly-json");
    var quarterlyBlockForAnnualEps = null;
    if (rawQuarterly && String(rawQuarterly).trim()) {
      try {
        quarterlyBlockForAnnualEps = JSON.parse(rawQuarterly);
      } catch (e) {
        quarterlyBlockForAnnualEps = null;
      }
    }
    var rawAnnual = root.getAttribute("data-fin-annual-json");
    var annualDisplayBlock = null;
    if (rawAnnual && String(rawAnnual).trim()) {
      try {
        annualDisplayBlock = JSON.parse(rawAnnual);
      } catch (e2) {
        annualDisplayBlock = null;
      }
    }
    var rawQDisplay = root.getAttribute("data-fin-quarterly-display-json");
    var quarterlyDisplayBlock = null;
    if (rawQDisplay && String(rawQDisplay).trim()) {
      try {
        quarterlyDisplayBlock = JSON.parse(rawQDisplay);
      } catch (e3) {
        quarterlyDisplayBlock = null;
      }
    }

    var consolidationOpts = {
      ytdBlock: ytdBlock,
      labelSingle: labelConsSingle,
      labelYtd: labelConsYtd,
      consolidationAria: consolidationAria,
      quarterlyBlockForAnnualEps: quarterlyBlockForAnnualEps,
      annualDisplayBlock: annualDisplayBlock,
      quarterlyDisplayBlock: quarterlyDisplayBlock,
    };
    root.querySelectorAll("table").forEach(function (table) {
      if (table.classList.contains("fin-table-amount-pct")) return;
      if (!isFinancialTable(table)) return;
      if (table.closest(".fin-table-toggle-wrap")) return;
      enhanceTable(
        table,
        hint,
        labelAmount,
        labelPct,
        groupAria,
        consolidationOpts,
        industryType
      );
    });
  }

  window.initReportFinancialTables = initReportFinancialTables;

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll(".report-body[data-fin-table-enhanced]").forEach(function (root) {
      initReportFinancialTables(root);
    });
  });
})();
