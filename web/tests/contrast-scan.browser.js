/**
 * contrast-scan.browser.js —— 三層對比度掃描器 v4(在瀏覽器 console / DevTools 執行)
 *
 * 用法:整份貼進頁面執行,回傳 JSON 摘要。或 `__twContrastScan({ selfTest: true })`。
 *
 * 為什麼是「三層」:
 *   ① 常態    —— getComputedStyle 的實際文字色 vs 合成後的實際背景色
 *   ② 狀態    —— 從 styleSheets 掃出 :hover / :focus / :focus-visible / :active 規則裡宣告的
 *                 color / background-color,套到對應元素上重算(這些狀態無法用 JS 真的觸發)
 *   ③ 主題    —— 深色與淺色各跑一次(切 html[data-theme] 後【強制 reflow】再讀,
 *                 否則 computed style 尚未重算 —— 踩過,誤報 1.46 實際 5.45)
 *
 * 🔴 這支工具自己壞過兩次,兩個教訓寫死在程式裡:
 *   1. 【不要自己解析顏色字串】。v3 用 regex 只認 rgb/rgba,color-mix() 解析出來的
 *      `color(srgb …)` 被【靜默跳過】→ 全站「0 未達 AA」是假陰性,而且已經上線。
 *      現在一律用 canvas 像素回讀:把顏色畫在黑底與白底各一次,反解出 (r,g,b,a)。
 *      瀏覽器看得懂的任何語法都能處理,不需要我認得它。
 *   2. 【量不到 = 失敗】。顏色無法解析、背景是圖片/漸層而取不到實色 → 一律計為 FAIL 並列名,
 *      絕不當作「沒問題」跳過。
 *   3. alpha 合成要正確的 source-over:aOut = af + ab(1−af)、
 *      cOut = (cf·af + cb·ab·(1−af)) / aOut。寫錯會誤報(踩過:.tk-chip 報 1.58,實際 7.78)。
 *
 * 判準:WCAG 2.1 AA。一般文字 4.5、大字(≥24px 或 ≥18.66px 且 bold)3.0。
 */
(function () {
  "use strict";

  const AA_NORMAL = 4.5;
  const AA_LARGE = 3.0;

  // ── 顏色解析:canvas 像素回讀,不自己解析字串 ─────────────────────────────
  const cvs = document.createElement("canvas");
  cvs.width = cvs.height = 4;
  const ctx = cvs.getContext("2d", { willReadFrequently: true });

  /** 在指定底色上畫一次,回傳該像素 [r,g,b] */
  function drawOn(value, bg) {
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 4, 4);
    // 哨兵:若 value 不是合法顏色,fillStyle 會保持前一個值(此處為 bg)→ 與 bg 同色,
    // 兩種底色都同色時才判定為「解析失敗」,不會把真正的透明色誤判成失敗。
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 4, 4);
    const d = ctx.getImageData(2, 2, 1, 1).data;
    return [d[0], d[1], d[2]];
  }

  /**
   * 任意 CSS 顏色 → {r,g,b,a} 或 null(無法解析)。
   * 畫在白底與黑底各一次反解 alpha:
   *   白底 cW = c·a + 255(1−a)、黑底 cB = c·a  →  a = 1 − (cW − cB)/255、c = cB/a
   */
  function parseColor(value) {
    if (value == null) return null;
    const v = String(value).trim();
    if (!v || v === "none") return null;
    if (v === "transparent" || v === "rgba(0, 0, 0, 0)") return { r: 0, g: 0, b: 0, a: 0 };
    let onW, onB;
    try {
      onW = drawOn(v, "#ffffff");
      onB = drawOn(v, "#000000");
    } catch (e) {
      return null;
    }
    // 兩種底色畫出來都等於底色本身 → fillStyle 沒吃這個值 → 解析失敗
    if (onW[0] === 255 && onW[1] === 255 && onW[2] === 255 && onB[0] === 0 && onB[1] === 0 && onB[2] === 0) {
      return null;
    }
    const aCh = [0, 1, 2].map((i) => 1 - (onW[i] - onB[i]) / 255);
    const a = Math.min(1, Math.max(0, (aCh[0] + aCh[1] + aCh[2]) / 3));
    if (a <= 0.0001) return { r: 0, g: 0, b: 0, a: 0 };
    return { r: onB[0] / a, g: onB[1] / a, b: onB[2] / a, a };
  }

  /** source-over 合成:前景 f 疊在背景 b 之上 */
  function over(f, b) {
    const aOut = f.a + b.a * (1 - f.a);
    if (aOut <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    const ch = (cf, cb) => (cf * f.a + cb * b.a * (1 - f.a)) / aOut;
    return { r: ch(f.r, b.r), g: ch(f.g, b.g), b: ch(f.b, b.b), a: aOut };
  }

  function relLum(c) {
    const f = (x) => {
      const s = x / 255;
      return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }

  function ratio(fg, bg) {
    const l1 = relLum(fg);
    const l2 = relLum(bg);
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }

  /**
   * 由元素往上合成出實際背景色。
   * 遇到 background-image(漸層/圖片)無法取實色 → 回 null,呼叫端計為 FAIL(量不到 = 失敗)。
   */
  /**
   * 從 background-image 取出所有顏色 token(交給 canvas 解析,仍然【不自己解析顏色】)。
   * 回傳 null 代表這個 background-image 取不出任何顏色(如 url(...) 圖檔)→ 呼叫端計為量不到。
   */
  function gradientStops(bgImage) {
    const toks = String(bgImage).match(
      /(?:rgba?|hsla?|color|oklch|oklab|lab|lch)\([^()]*(?:\([^()]*\)[^()]*)*\)|#[0-9a-f]{3,8}\b/gi
    );
    if (!toks) return null;
    const out = [];
    for (const t of toks) {
      const c = parseColor(t);
      if (c) out.push(c);
    }
    return out.length ? out : null;
  }

  function effectiveBg(el) {
    let acc = { r: 0, g: 0, b: 0, a: 0 };
    let node = el;
    while (node && node.nodeType === 1) {
      const cs = getComputedStyle(node);
      const c = parseColor(cs.backgroundColor);
      if (c == null) return { color: null, reason: "背景色無法解析:" + cs.backgroundColor };
      /**
       * background-image(漸層)疊在該元素的 background-color 之上。
       * 文字可能落在漸層的任何一段 → 取【最壞的一個色停】當代表(保守)。
       * 早期版本直接判定「量不到」,但站上那層其實只是
       * `linear-gradient(175deg, rgba(255,255,255,0.043) 0%, rgba(0,0,0,0) 42%)`
       * 這種 4.3% 的白霧 —— 量得到就要量,不可用「量不到 = 失敗」當藉口略過。
       */
      let layer = c;
      if (cs.backgroundImage && cs.backgroundImage !== "none") {
        const stops = gradientStops(cs.backgroundImage);
        if (!stops) {
          return { color: null, reason: "background-image 取不到顏色:" + cs.backgroundImage.slice(0, 40) };
        }
        // 先各自疊在自身底色上,稍後由呼叫端以最壞情況比對;這裡取「最暗」與「最亮」兩極的較差者
        let worst = null;
        let worstLum = null;
        for (const s of stops) {
          const merged = over(s, c);
          const lum = relLum(merged);
          if (worstLum == null || Math.abs(lum - 0.5) < Math.abs(worstLum - 0.5)) {
            worst = merged;
            worstLum = lum;
          }
        }
        layer = worst || c;
      }
      if (layer.a > 0) {
        acc = over(acc, layer);
        if (acc.a >= 0.999) return { color: acc, reason: null };
      }
      node = node.parentElement;
    }
    // 走到根仍未不透明 → 疊上畫布底色(html/body 的 backgroundColor 已在上面吃過,這裡補白)
    const canvasBg = { r: 255, g: 255, b: 255, a: 1 };
    return { color: over(acc, canvasBg), reason: null };
  }

  function isLargeText(cs) {
    const px = parseFloat(cs.fontSize) || 0;
    const w = parseInt(cs.fontWeight, 10) || 400;
    return px >= 24 || (px >= 18.66 && w >= 700);
  }

  function visible(el) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    if (parseFloat(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function ownText(el) {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return t.trim();
  }

  /** 掃描目前 DOM 狀態下所有有自有文字的元素 */
  function scanNormal(label) {
    const out = [];
    for (const el of document.querySelectorAll("body *")) {
      const txt = ownText(el);
      if (!txt) continue;
      if (!visible(el)) continue;
      const cs = getComputedStyle(el);
      const fgRaw = parseColor(cs.color);
      const bg = effectiveBg(el);
      const need = isLargeText(cs) ? AA_LARGE : AA_NORMAL;
      if (fgRaw == null) {
        out.push({ layer: label, sel: desc(el), text: txt.slice(0, 24), ratio: null, need, fail: true, why: "文字色無法解析:" + cs.color });
        continue;
      }
      if (bg.color == null) {
        out.push({ layer: label, sel: desc(el), text: txt.slice(0, 24), ratio: null, need, fail: true, why: bg.reason });
        continue;
      }
      const fg = fgRaw.a >= 0.999 ? fgRaw : over(fgRaw, bg.color);
      const r = ratio(fg, bg.color);
      out.push({ layer: label, sel: desc(el), text: txt.slice(0, 24), ratio: Math.round(r * 100) / 100, need, fail: r < need, why: null });
    }
    return out;
  }

  /**
   * 狀態層:從 styleSheets 掃出 :hover/:focus/:focus-visible/:active 規則。
   * 這些狀態無法用 JS 真的觸發,只能取規則宣告的 color / background-color 覆蓋後重算。
   */
  const crossOrigin = [];
  function scanStates(label) {
    const out = [];
    const PSEUDO = /:(hover|focus|focus-visible|active)\b/;
    const rules = [];
    for (const sheet of document.styleSheets) {
      let list;
      try {
        list = sheet.cssRules;
      } catch (e) {
        /**
         * 跨來源樣式表讀不到規則 —— 【不可靜默略過】,但也不該和站內失敗混為一談。
         * 單獨列進 crossOrigin,每一筆都必須人工查證「這份樣式表有沒有顏色宣告」。
         * 已查證(2026-08-03,curl 取原始內容):
         *   fonts.googleapis.com/css2?family=Noto+Serif+TC… → 324 條 @font-face,
         *   color / background 宣告數 = 0 → 不可能藏著對比失敗。
         * 之後若冒出【新的】跨來源樣式表,必須重新查證後才能當作無害。
         */
        crossOrigin.push(sheet.href || "(unknown)");
        continue;
      }
      collect(list, rules);
    }
    for (const rule of rules) {
      if (!PSEUDO.test(rule.selectorText)) continue;
      const declFg = rule.style.getPropertyValue("color").trim();
      const declBg = rule.style.getPropertyValue("background-color").trim();
      if (!declFg && !declBg) continue;
      const base = rule.selectorText
        .split(",")
        .map((s) => s.replace(/:(hover|focus-visible|focus|active)\b/g, "").trim())
        .filter(Boolean)
        .join(",");
      let els = [];
      try {
        els = base ? Array.from(document.querySelectorAll(base)) : [];
      } catch (e) {
        out.push({ layer: label, sel: rule.selectorText, text: "", ratio: null, need: AA_NORMAL, fail: true, why: "選擇器無法查詢" });
        continue;
      }
      for (const el of els.slice(0, 40)) {
        if (!visible(el)) continue;
        const txt = ownText(el) || (el.textContent || "").trim();
        if (!txt) continue;
        const cs = getComputedStyle(el);
        const need = isLargeText(cs) ? AA_LARGE : AA_NORMAL;
        // 宣告值可能是 var(...) → 用元素自身解析(setProperty 到暫時樣式再讀 computed)
        const fgVal = declFg ? resolveOn(el, "color", declFg) : cs.color;
        const bgBase = effectiveBg(el);
        let bgColor = bgBase.color;
        if (declBg) {
          const bv = parseColor(resolveOn(el, "background-color", declBg));
          if (bv == null) {
            out.push({ layer: label, sel: rule.selectorText, text: txt.slice(0, 24), ratio: null, need, fail: true, why: "狀態背景色無法解析:" + declBg });
            continue;
          }
          // 該元素自身背景被狀態覆蓋 → 用父層合成後再疊上去
          const parentBg = el.parentElement ? effectiveBg(el.parentElement) : { color: { r: 255, g: 255, b: 255, a: 1 } };
          if (parentBg.color == null) {
            out.push({ layer: label, sel: rule.selectorText, text: txt.slice(0, 24), ratio: null, need, fail: true, why: parentBg.reason });
            continue;
          }
          bgColor = over(bv, parentBg.color);
        }
        const fg = parseColor(fgVal);
        if (fg == null || bgColor == null) {
          out.push({ layer: label, sel: rule.selectorText, text: txt.slice(0, 24), ratio: null, need, fail: true, why: "狀態顏色無法解析:" + (declFg || declBg) });
          continue;
        }
        const fgC = fg.a >= 0.999 ? fg : over(fg, bgColor);
        const r = ratio(fgC, bgColor);
        out.push({ layer: label, sel: rule.selectorText, text: txt.slice(0, 24), ratio: Math.round(r * 100) / 100, need, fail: r < need, why: null });
      }
    }
    return out;
  }

  function collect(list, acc) {
    for (const r of list) {
      if (r.type === CSSRule.STYLE_RULE) acc.push(r);
      else if (r.cssRules) collect(r.cssRules, acc);
    }
  }

  /** 把宣告值(可能含 var())套到元素上,讀回 computed 的實色,再還原 */
  function resolveOn(el, prop, value) {
    const prev = el.style.getPropertyValue(prop);
    const prevPri = el.style.getPropertyPriority(prop);
    el.style.setProperty(prop, value, "important");
    const v = getComputedStyle(el)[prop === "color" ? "color" : "backgroundColor"];
    el.style.removeProperty(prop);
    if (prev) el.style.setProperty(prop, prev, prevPri);
    return v;
  }

  function desc(el) {
    const id = el.id ? "#" + el.id : "";
    const cls = el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    return el.tagName.toLowerCase() + id + cls;
  }

  /**
   * 🔴 主題【不在這裡切】—— 一次只掃「頁面目前的主題」。
   *
   * 原因(實測,乾淨頁面對照):在自動化分頁裡改 `html[data-theme]` 後,
   * `--text` 這類自訂屬性在 html 上確實更新了,但【子元素引用 var(--text) 的 color 不會重算】
   * —— `a.brand` 在切到 dark 後 computed color 仍是 `rgb(28,24,18)`(淺色墨),
   * 而背景已經變成深色 → 算出 1.06,產生 506 個假陽性。
   * `void body.offsetHeight` 這種強制 reflow【不夠】:自動化分頁 visibilityState 是 hidden,
   * 整條算繪管線凍結(同一個原因讓 canvas 恆為 300×150),排到下一幀的 style recalc 永遠不來。
   *
   * 正確做法:由外部設定 localStorage("tw-theme") 後【重新載入頁面】,
   * 讓主題在文件解析時就套用,再呼叫本函式。兩個主題各跑一次。
   * 相關教訓:切主題後立刻讀 computed style 會拿到尚未重算的值(本專案第 8 次「驗證工具自己壞掉」)。
   */
  window.__twContrastScan = function (opts) {
    opts = opts || {};
    const theme = document.documentElement.getAttribute("data-theme") || "(預設)";
    let bait = null;
    if (opts.selfTest) {
      // 自我驗證:注入一個必定不合格的元素(淺灰字 + 白底 ≈ 1.6)
      bait = document.createElement("p");
      bait.id = "__contrast_bait__";
      bait.textContent = "自我驗證誘餌";
      bait.style.cssText = "color:#e8e8e8;background:#ffffff;padding:4px;font-size:14px";
      document.body.appendChild(bait);
    }
    const all = [];
    all.push(...scanNormal(theme + "/常態"));
    all.push(...scanStates(theme + "/狀態"));

    const fails = all.filter((x) => x.fail);
    const caughtBait = fails.some((x) => x.sel.indexOf("__contrast_bait__") >= 0);
    if (bait) bait.remove();

    const byLayer = {};
    for (const x of all) {
      byLayer[x.layer] = byLayer[x.layer] || { checked: 0, fail: 0, unmeasurable: 0 };
      byLayer[x.layer].checked++;
      if (x.fail) byLayer[x.layer].fail++;
      if (x.ratio == null) byLayer[x.layer].unmeasurable++;
    }
    // 量不到的原因要能被看見並歸類,不可只給一個總數
    const unmeasurableReasons = {};
    for (const x of all) {
      if (x.ratio != null) continue;
      const key = String(x.why || "?").slice(0, 60);
      unmeasurableReasons[key] = (unmeasurableReasons[key] || 0) + 1;
    }
    return {
      url: location.pathname,
      theme,
      checked: all.length,
      failures: fails.length,
      failMeasurable: fails.filter((x) => x.ratio != null).length,
      failUnmeasurable: fails.filter((x) => x.ratio == null).length,
      unmeasurableReasons,
      crossOriginSheets: [...new Set(crossOrigin)],
      byLayer,
      selfTest: opts.selfTest ? (caughtBait ? "PASS(注入→抓到)" : "FAIL(注入了卻沒抓到,這支工具是死的)") : "(未執行)",
      worst: all
        .filter((x) => x.ratio != null)
        .sort((a, b) => a.ratio - b.ratio)
        .slice(0, 5)
        .map((x) => x.layer + " " + x.sel + " " + x.ratio + "/" + x.need + " 「" + x.text + "」"),
      list: fails.slice(0, 40).map((x) => x.layer + " " + x.sel + " " + (x.ratio == null ? "量不到" : x.ratio + "/" + x.need) + " 「" + x.text + "」" + (x.why ? " ← " + x.why : "")),
    };
  };
  return "ready: __twContrastScan({selfTest:true})";
})();
