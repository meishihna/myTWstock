/**
 * 自選股(localStorage)。純前端;以股票代號(4 碼字串)陣列儲存。
 * 供報告頁收藏星號、/watchlist、/compare 共用。
 */
const KEY = "tw:watchlist";

export function getWatchlist(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string" && /^\d{4}$/.test(x)) : [];
  } catch {
    return [];
  }
}

export function setWatchlist(list: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...new Set(list)]));
  } catch {
    /* quota / privacy mode — ignore */
  }
}

export function hasWatch(ticker: string): boolean {
  return getWatchlist().includes(ticker);
}

/** 切換;回傳切換後是否已收藏 */
export function toggleWatch(ticker: string): boolean {
  const list = getWatchlist();
  const i = list.indexOf(ticker);
  if (i >= 0) {
    list.splice(i, 1);
    setWatchlist(list);
    return false;
  }
  list.push(ticker);
  setWatchlist(list);
  return true;
}

export function removeWatch(ticker: string): void {
  setWatchlist(getWatchlist().filter((x) => x !== ticker));
}
