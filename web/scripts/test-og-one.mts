import {
  fetchOgImageUrl,
  parseOgFromHtml,
} from "../src/lib/news-og-image.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const u =
  "https://news.google.com/rss/articles/CBMiX0FVX3lxTE03QzRQcTdqLU1KRWplRnNOVE9UZkw2SFZZMkNEaWlleHcxWWs3MGxqeHFiby05RkxySy1QdzNacVl2N0h6aUxWMUxCNm05cUlWVmJZQkc2Zmtka194bUpv?oc=5";

const raw = await fetch(u, {
  headers: {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.7",
  },
});
const t = await raw.text();
console.log("full len", t.length, "og in full", t.includes("og:image"));
const pos = t.indexOf("og:image");
console.log("first og:image at char", pos);
const chunk350 = t.length > 350_000 ? t.slice(0, 350_000) : t;
console.log("og:image in first 350k only:", chunk350.includes("og:image"));
console.log("parseOg full html:", parseOgFromHtml(t).slice(0, 100));

const r = await fetchOgImageUrl(u);
console.log("fetchOgImageUrl:", r || "(empty)");
