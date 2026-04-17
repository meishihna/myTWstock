import type { MiddlewareHandler } from "astro";

/**
 * 本機 `astro preview` 走 Node adapter，不會套用 vite.server.headers。
 * 若回應帶有過嚴的 CSP，TradingView 的 wss（如 pushstream）會被擋；本機改送寬鬆策略以利內嵌圖表。
 */
const TRADINGVIEW_LOCAL_CSP =
  "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src * wss://*.tradingview.com; frame-src *; script-src * 'unsafe-inline' 'unsafe-eval'; img-src * data: blob:;";

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  );
}

export const onRequest: MiddlewareHandler = async (context, next) => {
  const response = await next();
  if (!isLocalHostname(context.url.hostname)) return response;

  const ct = response.headers.get("content-type") || "";
  if (!ct.includes("text/html")) return response;

  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", TRADINGVIEW_LOCAL_CSP);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
