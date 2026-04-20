const UA =
  "Mozilla/5.0 (compatible; TWstock/1.0; +https://github.com/meishihna/myTWstock)";
const u =
  "https://news.google.com/rss/articles/CBMiX0FVX3lxTE03QzRQcTdqLU1KRWplRnNOVE9UZkw2SFZZMkNEaWlleHcxWWs3MGxqeHFiby05RkxySy1QdzNacVl2N0h6aUxWMUxCNm05cUlWVmJZQkc2Zmtka194bUpv?oc=5";
const r = await fetch(u, {
  headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" },
});
const t = await r.text();
console.log("status", r.status, "len", t.length);
console.log("has og:image", /og:image/i.test(t));
const m = t.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i);
console.log("regex match", m?.[1]?.slice(0, 80));
