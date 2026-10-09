/**
 * Copied from Plannotator (https://github.com/backnotprop/plannotator,
 * packages/shared/request-origin.ts @ 5d39c981), MIT OR Apache-2.0.
 *
 * A browser attaches `Origin` to every cross-origin POST, including the
 * "simple" `text/plain` ones that skip a CORS preflight. A request passes when:
 *  - it carries no Origin header (a non-browser client, which already has the
 *    user's own access);
 *  - its Origin names the host the request was sent to; or
 *  - the browser marked it `Sec-Fetch-Site: same-origin` (set by the browser,
 *    not page script; keeps a reverse proxy that rewrites Host working).
 * `Origin: null` (a sandboxed frame, a file:// page) never passes, and
 * neither does `same-site` or `cross-site`.
 */
export function isSameOriginOrNoOrigin(
  originHeader: string | null | undefined,
  requestHost: string,
  fetchSite?: string | string[] | null,
): boolean {
  if (!originHeader) return true;
  if (originHeader.trim() === "null") return false;
  const site = Array.isArray(fetchSite) ? fetchSite[0] : fetchSite;
  if (site?.trim().toLowerCase() === "same-origin") return true;
  try {
    return new URL(originHeader).host === requestHost;
  } catch {
    return false;
  }
}
