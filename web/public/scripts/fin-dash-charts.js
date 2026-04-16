/**
 * 財務儀表板：圖表 hover 工具提示與垂直參考線（對應 SVG viewBox 座標）
 */
(function () {
  "use strict";

  function innerW(spec) {
    return spec.w - spec.pad.l - spec.pad.r;
  }

  function fmtValue(v, vf) {
    if (v == null || !Number.isFinite(Number(v))) return "—";
    var n = Number(v);
    if (vf === "pct") return n.toFixed(1) + "%";
    if (vf === "eps") return n.toFixed(2) + " 元";
    return n.toLocaleString("zh-TW", { maximumFractionDigits: 2 });
  }

  /**
   * 將螢幕座標轉成 SVG user 座標（對齊 viewBox + preserveAspectRatio 留白）
   * 若用 rect 比例乘 spec.w，在 meet 留白時會與資料點錯位。
   */
  function clientToSvgX(svg, clientX, clientY, spec) {
    if (svg.createSVGPoint && typeof svg.getScreenCTM === "function") {
      var pt = svg.createSVGPoint();
      pt.x = clientX;
      pt.y = clientY;
      var ctm = svg.getScreenCTM();
      if (ctm) {
        var inv = ctm.inverse();
        var loc = pt.matrixTransform(inv);
        return loc.x;
      }
    }
    var rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    var vb = svg.viewBox && svg.viewBox.baseVal;
    var vw = vb && vb.width ? vb.width : spec.w;
    return ((clientX - rect.left) / rect.width) * vw;
  }

  /** 柱狀圖：每個 X 標籤佔等寬 slot，與線圖用 (n-1) 等分不同 */
  function isBarChartKind(spec) {
    var k = spec.kind;
    return (
      k === "simpleBar" ||
      k === "signedBar" ||
      k === "groupedBar" ||
      k === "tripleBar" ||
      k === "barWithLine" ||
      k === "stackedBar"
    );
  }

  function snapIndex(clientX, clientY, svg, spec) {
    var my = clientY;
    if (my == null || !Number.isFinite(my)) {
      var r = svg.getBoundingClientRect();
      my = r.top + r.height / 2;
    }
    var mx = clientToSvgX(svg, clientX, my, spec);
    var iw = innerW(spec);
    var n = spec.xLabels.length;
    if (n <= 0) return 0;
    var rel = mx - spec.pad.l;
    rel = Math.min(Math.max(rel, 0), iw);

    if (isBarChartKind(spec)) {
      var slotW = iw / n;
      if (!(slotW > 0)) return 0;
      var iSlot = Math.floor(rel / slotW);
      return Math.max(0, Math.min(n - 1, iSlot));
    }

    var denom = Math.max(1, n - 1);
    var iLine = Math.round((rel / iw) * denom);
    return Math.max(0, Math.min(n - 1, iLine));
  }

  function xAtIndex(spec, i) {
    var iw = innerW(spec);
    var n = spec.xLabels.length;
    if (n <= 0) return spec.pad.l;

    var cc = spec.categoryCenterX;
    if (Array.isArray(cc) && cc.length > i && Number.isFinite(cc[i])) {
      return cc[i];
    }

    if (isBarChartKind(spec)) {
      var slotW = iw / n;
      return spec.pad.l + (i + 0.5) * slotW;
    }

    var denom = Math.max(1, n - 1);
    return spec.pad.l + (iw * i) / denom;
  }

  /** SVG user 座標 → 螢幕座標（tooltip 與垂直線對齊） */
  function userToClientScreen(svg, ux, uy) {
    if (!svg.createSVGPoint || typeof svg.getScreenCTM !== "function") return null;
    var pt = svg.createSVGPoint();
    pt.x = ux;
    pt.y = uy;
    var ctm = svg.getScreenCTM();
    if (!ctm) return null;
    var p = pt.matrixTransform(ctm);
    return { x: p.x, y: p.y };
  }

  function positionTooltip(el, clientX, clientY) {
    el.style.position = "fixed";
    el.style.zIndex = "1000";
    el.style.left = "0";
    el.style.top = "0";
    el.style.display = "block";
    var tw = el.offsetWidth || 200;
    var th = el.offsetHeight || 80;
    var x = clientX + 14;
    var y = clientY + 14;
    if (x + tw > window.innerWidth - 8) x = window.innerWidth - tw - 8;
    if (y + th > window.innerHeight - 8) y = window.innerHeight - th - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    el.style.left = x + "px";
    el.style.top = y + "px";
  }

  function buildLineHtml(spec, i) {
    var vf = spec.valueFormat || "int";
    var rows = spec.series
      .map(function (s) {
        var v = s.values[i];
        return (
          '<span style="color:' +
          s.color +
          '">●</span> ' +
          s.name +
          ": " +
          fmtValue(v, vf)
        );
      })
      .join("<br/>");
    return "<strong>" + spec.xLabels[i] + "</strong><br/>" + rows;
  }

  function buildGroupedHtml(spec, i) {
    var vf = spec.valueFormat || "int";
    var rows = spec.series
      .map(function (s) {
        var v = s.values[i];
        return (
          '<span style="color:' +
          s.color +
          '">●</span> ' +
          s.name +
          ": " +
          fmtValue(v, vf)
        );
      })
      .join("<br/>");
    return "<strong>" + spec.xLabels[i] + "</strong><br/>" + rows;
  }

  function buildSimpleBarHtml(spec, i) {
    var vf = spec.valueFormat || "int";
    var v = spec.values[i];
    var label = spec.valueLabel || "數值";
    return (
      "<strong>" +
      spec.xLabels[i] +
      "</strong><br/><span>" +
      label +
      ": " +
      fmtValue(v, vf) +
      "</span>"
    );
  }

  function buildSignedBarHtml(spec, i) {
    var v = spec.values[i];
    return (
      "<strong>" +
      spec.xLabels[i] +
      "</strong><br/><span>淨利: " +
      fmtValue(v, "int") +
      " 百萬元</span>"
    );
  }

  function buildTripleHtml(spec, i) {
    var rows = spec.series
      .map(function (s) {
        var v = s.values[i];
        return (
          '<span style="color:' +
          s.color +
          '">●</span> ' +
          s.name +
          ": " +
          fmtValue(v, "int")
        );
      })
      .join("<br/>");
    return "<strong>" + spec.xLabels[i] + "</strong><br/>" + rows;
  }

  function buildBarWithLineHtml(spec, i) {
    var bv = spec.barValues[i];
    var lv = spec.lineValues[i];
    var rows = [];
    rows.push(
      '<span style="color:#5B8FD8">■</span> FCF: ' + fmtValue(bv, "int") + " 百萬"
    );
    rows.push(
      '<span style="color:#E8C84A">●</span> FCF 占營收: ' + fmtValue(lv, "pct")
    );
    return "<strong>" + spec.xLabels[i] + "</strong><br/>" + rows.join("<br/>");
  }

  function buildStackedBarHtml(spec, i) {
    var parts = [];
    var total = 0;
    for (var s = 0; s < spec.segments.length; s++) {
      var seg = spec.segments[s];
      var v = seg.values[i];
      if (v != null && Number.isFinite(Number(v))) total += Number(v);
      parts.push(
        '<span style="color:' +
          seg.color +
          '">■</span> ' +
          seg.name +
          ": " +
          fmtValue(v, "pct")
      );
    }
    return (
      "<strong>" +
      spec.xLabels[i] +
      "</strong><br/>" +
      parts.join("<br/>") +
      "<br/><span>合計（費用率）: " +
      total.toFixed(1) +
      "%</span>"
    );
  }

  function ensureCrosshair(svg, spec) {
    var el = svg.querySelector(".fin-dash__crosshair");
    if (el) return el;
    el = document.createElementNS("http://www.w3.org/2000/svg", "line");
    el.setAttribute("class", "fin-dash__crosshair");
    el.setAttribute("y1", String(spec.pad.t));
    el.setAttribute("y2", String(spec.h - spec.pad.b));
    el.setAttribute("stroke", "rgba(255,255,255,0.38)");
    el.setAttribute("pointer-events", "none");
    el.style.opacity = "0";
    svg.appendChild(el);
    return el;
  }

  function bindWrap(wrap) {
    var specEl = wrap.querySelector("script[data-fin-chart-spec]");
    if (!specEl || !specEl.textContent) return;
    var spec;
    try {
      spec = JSON.parse(specEl.textContent.trim());
    } catch (e) {
      return;
    }
    var svg = wrap.querySelector("svg");
    if (!svg) return;

    var tooltip = document.createElement("div");
    tooltip.className = "fin-dash__tooltip";
    tooltip.setAttribute("role", "tooltip");
    wrap.appendChild(tooltip);

    var cross = null;
    if (
      spec.kind === "line" ||
      spec.kind === "groupedBar" ||
      spec.kind === "simpleBar" ||
      spec.kind === "signedBar" ||
      spec.kind === "tripleBar" ||
      spec.kind === "barWithLine" ||
      spec.kind === "stackedBar"
    ) {
      cross = ensureCrosshair(svg, spec);
    }

    function hide() {
      tooltip.style.display = "none";
      tooltip.innerHTML = "";
      if (cross) cross.style.opacity = "0";
    }

    function show(ev) {
      var i = snapIndex(ev.clientX, ev.clientY, svg, spec);
      var xi = xAtIndex(spec, i);
      if (cross) {
        cross.setAttribute("x1", String(xi));
        cross.setAttribute("x2", String(xi));
        cross.style.opacity = "1";
      }
      var html = "";
      if (spec.kind === "line") html = buildLineHtml(spec, i);
      else if (spec.kind === "groupedBar") html = buildGroupedHtml(spec, i);
      else if (spec.kind === "simpleBar") html = buildSimpleBarHtml(spec, i);
      else if (spec.kind === "signedBar") html = buildSignedBarHtml(spec, i);
      else if (spec.kind === "tripleBar") html = buildTripleHtml(spec, i);
      else if (spec.kind === "barWithLine") html = buildBarWithLineHtml(spec, i);
      else if (spec.kind === "stackedBar") html = buildStackedBarHtml(spec, i);
      else return;
      tooltip.innerHTML = html;
      var plotMidY = (spec.pad.t + spec.h - spec.pad.b) / 2;
      var scr = userToClientScreen(svg, xi, plotMidY);
      positionTooltip(tooltip, scr ? scr.x : ev.clientX, ev.clientY);
    }

    wrap.classList.add("fin-dash__canvas-wrap--hover");
    wrap.addEventListener("mousemove", show);
    wrap.addEventListener("mouseleave", hide);
    wrap.addEventListener("touchstart", function (e) {
      if (e.touches.length) show(e.touches[0]);
    }, { passive: true });
    wrap.addEventListener("touchend", hide, { passive: true });
  }

  function initRoot(root) {
    root.querySelectorAll(".fin-dash__canvas-wrap").forEach(function (w) {
      bindWrap(w);
    });
  }

  function run() {
    document.querySelectorAll("[data-fin-dash]").forEach(initRoot);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();
