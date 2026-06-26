/**
 * 題材收藏(localStorage)。純前端;以題材 slug 陣列儲存。
 * 與個股自選(watchlist.ts, tw:watchlist)分開命名空間,互不干擾。
 */
const KEY = "tw:themelist";

export function getThemes(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.length > 0) : [];
  } catch {
    return [];
  }
}

function setThemes(list: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...new Set(list)]));
  } catch {
    /* quota / privacy mode — ignore */
  }
}

export function hasTheme(slug: string): boolean {
  return getThemes().includes(slug);
}

/** 切換;回傳切換後是否已收藏 */
export function toggleTheme(slug: string): boolean {
  const list = getThemes();
  const i = list.indexOf(slug);
  if (i >= 0) {
    list.splice(i, 1);
    setThemes(list);
    return false;
  }
  list.push(slug);
  setThemes(list);
  return true;
}
