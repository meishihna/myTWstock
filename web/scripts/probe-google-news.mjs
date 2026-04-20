const url =
  "https://news.google.com/rss/search?q=site:ctee.com.tw&hl=zh-TW&gl=TW&ceid=TW:zh-Hant";
const Parser = (await import("rss-parser")).default;
const p = new Parser();
const feed = await p.parseURL(url);
const it0 = feed.items[0];
const link = it0?.link;
console.log("item keys", it0 ? Object.keys(it0) : []);
console.log("source", it0?.source);
console.log("sample link", link);
if (!link) process.exit(0);
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const r = await fetch(link, {
  redirect: "follow",
  headers: { "User-Agent": UA, "Accept-Language": "zh-TW,zh;q=0.9" },
});
console.log("final url", r.url);
const t = await r.text();
const og = t.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i);
console.log("og on page", og?.[1]?.slice(0, 80));
const ctee = t.match(/(https:\/\/[^"'\s]+ctee\.com\.tw[^"'\s]*)/i);
console.log("ctee in html", ctee?.[1]?.slice(0, 100));
