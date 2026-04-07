/**
 * 報告正文內財務表：年度最多 5 欄、季度最多 16 欄（新→舊）。
 * 「金額」與「占營收%」二選一顯示，以分段按鈕切換。首欄 sticky 由 CSS 處理。
 */
(function () {
  var MAX_ANNUAL_PERIODS = 5;
  var MAX_QUARTERLY_PERIODS = 16;

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

  /** 金額欄：可解析數字則加千分位；比率列保留原文。 */
  function formatAmountDisplay(raw, isPctRow) {
    var t = String(raw || "").trim();
    if (!t) return "—";
    if (isPctRow) return t;
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
        td.textContent = formatAmountDisplay(raw, isPctRow);
        var nAmt = parseNum(raw);
        if (nAmt != null && nAmt < 0) td.classList.add("fin-num-neg");
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
          td.textContent = raw || "—";
          var nKeep = parseNum(raw);
          if (nKeep != null && nKeep < 0) td.classList.add("fin-num-neg");
        } else {
          var p = cellPctOfRevenue(raw, rev, false, isRev);
          td.textContent = p.text;
          if (p.neg) td.classList.add("fin-num-neg");
        }
        newTr.appendChild(td);
      }
      tbody.appendChild(newTr);
    }
    newTable.appendChild(tbody);
    return newTable;
  }

  function enhanceTable(table, hintText, labelAmount, labelPct, groupAria) {
    var model = extractModel(table);
    if (!model) return;

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
    tools.setAttribute("role", "group");
    if (groupAria) tools.setAttribute("aria-label", groupAria);

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
    tools.appendChild(switchEl);
    toolbar.appendChild(tools);

    wrap.appendChild(toolbar);

    var view = document.createElement("div");
    view.className = "fin-table-view-slot";

    function setMode(mode) {
      var isPct = mode === "pct";
      switchEl.classList.toggle("fin-table-mode-switch--pct", isPct);
      btnAmt.classList.toggle("is-active", !isPct);
      btnPct.classList.toggle("is-active", isPct);
      btnAmt.setAttribute("aria-pressed", isPct ? "false" : "true");
      btnPct.setAttribute("aria-pressed", isPct ? "true" : "false");
      while (view.firstChild) view.removeChild(view.firstChild);
      view.appendChild(isPct ? buildPctOnlyTable(model) : buildAmountOnlyTable(model));
    }

    btnAmt.addEventListener("click", function () {
      setMode("amount");
    });
    btnPct.addEventListener("click", function () {
      setMode("pct");
    });

    view.appendChild(buildAmountOnlyTable(model));

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
    root.querySelectorAll("table").forEach(function (table) {
      if (table.classList.contains("fin-table-amount-pct")) return;
      if (!isFinancialTable(table)) return;
      if (table.closest(".fin-table-toggle-wrap")) return;
      enhanceTable(table, hint, labelAmount, labelPct, groupAria);
    });
  }

  window.initReportFinancialTables = initReportFinancialTables;

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll(".report-body[data-fin-table-enhanced]").forEach(function (root) {
      initReportFinancialTables(root);
    });
  });
})();
