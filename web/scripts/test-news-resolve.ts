/**
 * 新聞相關股解析回歸：node 執行
 *   npm run test:news-resolve
 * （依賴 npx 暫時下載 tsx，無需寫入 package.json）
 */
import assert from "node:assert/strict";
import {
  resolveTickersFromText,
  resolveCommodityBenchmarks,
  isOtcIndexHeadline,
  type NewsThemePayload,
} from "../src/lib/news-related.ts";

const quantumTheme: NewsThemePayload = {
  version: 1,
  themes: [
    {
      id: "quantum",
      keywords: ["量子電腦", "量子", "量子日"],
      tickers: ["2330", "2454", "3661"],
    },
  ],
};

function testWorldQuantumDayPrefersThemeOverBadSubstring() {
  const nameToTicker: Record<string, string> = {
    世界: "1234",
    台積電: "2330",
  };
  const valid = new Set(["1234", "2330", "2454", "3661"]);
  const r = resolveTickersFromText(
    "世界量子日活動開跑",
    "",
    nameToTicker,
    valid,
    "財經",
    quantumTheme
  );
  assert.deepEqual(r.tickers, ["2330", "2454", "3661"]);
}

function testBlocklistBlocksWorldExactKey() {
  const nameToTicker: Record<string, string> = { 世界: "1234" };
  const valid = new Set(["1234"]);
  const r = resolveTickersFromText(
    "世界經濟論壇",
    "",
    nameToTicker,
    valid,
    "財經",
    null
  );
  assert.deepEqual(r.tickers, []);
}

function testFourDigitTakesSlotBeforeTheme() {
  const nameToTicker: Record<string, string> = {};
  const valid = new Set(["9999", "2330", "2454"]);
  const r = resolveTickersFromText(
    "庫存 9999 與量子晶片",
    "",
    nameToTicker,
    valid,
    "財經",
    quantumTheme
  );
  assert.equal(r.tickers[0], "9999");
  assert.ok(r.tickers.includes("2330"));
}

testWorldQuantumDayPrefersThemeOverBadSubstring();
testBlocklistBlocksWorldExactKey();
testFourDigitTakesSlotBeforeTheme();

function testCommodityGold() {
  const r = resolveCommodityBenchmarks("國際金價創高", "");
  assert.ok(r.some((x) => x.symbol === "GC=F"));
}

testCommodityGold();

function testOtcHeadlineAddsTwoii() {
  assert.equal(isOtcIndexHeadline("盤中速報 - 櫃買市場加權指數上漲"), true);
  const r = resolveCommodityBenchmarks("櫃買市場加權指數上漲", "台積電領漲");
  assert.ok(r.some((x) => x.symbol === "^TWOII" && x.labelZh === "櫃檯指數"));
}

function testWangPinAlias() {
  const nameToTicker: Record<string, string> = {};
  const valid = new Set(["2330"]);
  valid.add("2727");
  const r = resolveTickersFromText(
    "陶板屋失火 王品：說明",
    "",
    nameToTicker,
    valid,
    "財經",
    null
  );
  assert.deepEqual(r.tickers, ["2727"]);
}

testOtcHeadlineAddsTwoii();
testWangPinAlias();

/** Yahoo／重讯：正文含「公司名稱：保瑞(6472)」，代號未必在 reports-index */
function testCompanyNameParenTickerNotInReportsIndex() {
  const nameToTicker: Record<string, string> = {};
  const valid = new Set<string>();
  const r = resolveTickersFromText(
    "【公告】董事會決議召開股東常會",
    "公司名稱：保瑞(6472)\n主旨：相關事宜",
    nameToTicker,
    valid,
    "台股",
    null
  );
  assert.deepEqual(r.tickers, ["6472"]);
  assert.equal(r.displayZhByTicker["6472"], "保瑞");
}

testCompanyNameParenTickerNotInReportsIndex();

/** 「漢翔2025年」之 2025 為西元，非千興(2025) */
function testCalendarYearAfterDigitsNotTicker() {
  const nameToTicker: Record<string, string> = { 漢翔: "2634" };
  const valid = new Set(["2634", "2025"]);
  const r = resolveTickersFromText(
    "漢翔2025年100%配發現金股利",
    "",
    nameToTicker,
    valid,
    "台股",
    null
  );
  assert.ok(!r.tickers.includes("2025"), "應排除西元 2025");
  assert.ok(r.tickers.includes("2634"), "應保留公司名 漢翔→2634");
}

testCalendarYearAfterDigitsNotTicker();

/** 新聞體「耀穎（7772）」無須公司名稱：、代號不必在 Pilot */
function testNewsStyleParenTickerAndZh() {
  const nameToTicker: Record<string, string> = {};
  const valid = new Set<string>();
  const r = resolveTickersFromText(
    "申購抽籤 耀穎（7772）",
    "",
    nameToTicker,
    valid,
    "台股",
    null
  );
  assert.ok(r.tickers.includes("7772"));
  assert.equal(r.displayZhByTicker["7772"], "耀穎");
}

testNewsStyleParenTickerAndZh();

/** 國際分類：不注入台股主題／產業代表股（避免 Tesla 新聞洗版） */
function testIntlSkipsTwThemeAndInference() {
  const nameToTicker: Record<string, string> = {};
  const valid = new Set(["2330", "2317", "3008", "4938"]);
  const evTheme: NewsThemePayload = {
    version: 2,
    themes: [
      {
        id: "ev",
        keywords: ["電動車"],
        tickers: ["2317", "3008", "4938"],
      },
    ],
    industryInference: [
      {
        id: "steel",
        keywords: ["鋼鐵"],
        tickers: ["2002", "2015"],
      },
    ],
  };
  const r = resolveTickersFromText(
    "Tesla 電動車與鋼鐵關稅",
    "",
    nameToTicker,
    valid,
    "國際",
    evTheme
  );
  assert.deepEqual(r.tickers, []);
}

testIntlSkipsTwThemeAndInference();

/** 鉅亨體 3363-TW：不必在 Pilot 也能解析代號 */
function testTwStockSuffixInSummary() {
  const nameToTicker: Record<string, string> = {};
  const valid = new Set<string>();
  const r = resolveTickersFromText(
    "上詮自結虧損",
    "上詮(3363-TW)說明營運狀況",
    nameToTicker,
    valid,
    "財經",
    null
  );
  assert.ok(r.tickers.includes("3363"));
}

testTwStockSuffixInSummary();

/** 西元日期 2025/3 不當代號 2025（千興） */
function testSlashDateSkipsYearAsTicker() {
  const nameToTicker: Record<string, string> = {};
  const valid = new Set(["2025", "3363"]);
  const r = resolveTickersFromText(
    "上詮公告",
    "較去年同期；2025/3月自結數字",
    nameToTicker,
    valid,
    "財經",
    null
  );
  assert.ok(!r.tickers.includes("2025"));
}

testSlashDateSkipsYearAsTicker();

/** 敘事碎片「日公告今(2025)」勿當成千興 */
function testParenYearNarrativeNoise() {
  const nameToTicker: Record<string, string> = {};
  const valid = new Set(["2025"]);
  const r = resolveTickersFromText(
    "測試",
    "本日公告今日說明事項（範例）日公告今(2025)純誤判",
    nameToTicker,
    valid,
    "財經",
    null
  );
  assert.ok(!r.tickers.includes("2025"));
}

testParenYearNarrativeNoise();

const industryPayload: NewsThemePayload = {
  version: 2,
  themes: [],
  industryInference: [
    {
      id: "shipping",
      keywords: ["航運業", "航運"],
      tickers: ["2603", "2609"],
    },
  ],
};

function testIndustryInferenceWhenNoExplicitNoTheme() {
  const nameToTicker: Record<string, string> = {};
  const valid = new Set(["2603", "2609", "2330"]);
  const r = resolveTickersFromText(
    "國際航運業景氣回溫",
    "",
    nameToTicker,
    valid,
    "財經",
    industryPayload
  );
  assert.deepEqual(r.tickers, ["2603", "2609"]);
}

function testIndustryInferenceSkippedWhenFourDigit() {
  const nameToTicker: Record<string, string> = {};
  const valid = new Set(["2603", "2609", "9999"]);
  const r = resolveTickersFromText(
    "航運業 與代號 9999",
    "",
    nameToTicker,
    valid,
    "財經",
    industryPayload
  );
  assert.deepEqual(r.tickers, ["9999"]);
}

function testIndustryInferenceSkippedWhenCuratedThemeHits() {
  const quantumOnly: NewsThemePayload = {
    version: 2,
    themes: [
      {
        id: "quantum",
        keywords: ["量子"],
        tickers: ["2330"],
      },
    ],
    industryInference: [
      {
        id: "shipping",
        keywords: ["航運"],
        tickers: ["2603"],
      },
    ],
  };
  const nameToTicker: Record<string, string> = {};
  const valid = new Set(["2330", "2603"]);
  const r = resolveTickersFromText(
    "量子與航運產業同步受關注",
    "",
    nameToTicker,
    valid,
    "財經",
    quantumOnly
  );
  assert.deepEqual(r.tickers, ["2330"]);
}

testIndustryInferenceWhenNoExplicitNoTheme();
testIndustryInferenceSkippedWhenFourDigit();
testIndustryInferenceSkippedWhenCuratedThemeHits();

console.log("news-related resolveTickersFromText: ok");
