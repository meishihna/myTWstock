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
  assert.deepEqual(r, ["2330", "2454", "3661"]);
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
  assert.deepEqual(r, []);
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
  assert.equal(r[0], "9999");
  assert.ok(r.includes("2330"));
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
  assert.deepEqual(r, ["2727"]);
}

testOtcHeadlineAddsTwoii();
testWangPinAlias();

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
  assert.deepEqual(r, ["2603", "2609"]);
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
  assert.deepEqual(r, ["9999"]);
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
  assert.deepEqual(r, ["2330"]);
}

testIndustryInferenceWhenNoExplicitNoTheme();
testIndustryInferenceSkippedWhenFourDigit();
testIndustryInferenceSkippedWhenCuratedThemeHits();

console.log("news-related resolveTickersFromText: ok");
