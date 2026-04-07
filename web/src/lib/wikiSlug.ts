/**
 * Wikilink 目標的 URL slug。須與
 * web/scripts/build-wikilink-hub.mjs 的 slugifyLabel、
 * web/scripts/build-wikilink-stubs.mjs 的 wikiLinkSlug 一致。
 */
export function wikiLinkSlug(label: string): string {
  let s = label
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w\u4e00-\u9fff-]/g, "");
  if (!s) s = "wiki";
  return s.toLowerCase();
}

/** @deprecated 使用 wikiLinkSlug */
export function wikiEntitySlug(label: string): string {
  return wikiLinkSlug(label);
}
