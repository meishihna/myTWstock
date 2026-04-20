const UA = "Mozilla/5.0 (compatible; TWstock/1.0)";
const u =
  "https://news.google.com/rss/articles/CBMiX0FVX3lxTE03QzRQcTdqLU1KRWplRnNOVE9UZkw2SFZZMkNEaWlleHcxWWs3MGxqeHFiby05RkxySy1QdzNacVl2N0h6aUxWMUxCNm05cUlWVmJZQkc2Zmtka194bUpv?oc=5";
const r = await fetch(u, { headers: { "User-Agent": UA } });
const t = await r.text();
const all = t.match(/ctee\.com\.tw/gi);
console.log("ctee occurrences", all ? all.length : 0);
const m = t.match(/https:\/\/[^"'\\\s<>]+ctee\.com\.tw[^"'\\\s<>]*/i);
console.log("url match", m && m[0]);
