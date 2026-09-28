/**
 * Share link URLs, shared by the Share window, the Shares lists and the bell.
 * Once LP Share (the public app) is connected, the root layout sets
 * window.__LPOS_SHARE_ORIGIN and links point there; until then they fall back
 * to LPOS's own staff viewer.
 */
declare global { interface Window { __LPOS_SHARE_ORIGIN?: string } }

/** The link clients get: LP Share once it's connected, else LPOS's own staff viewer. */
export function shareUrl(token: string): string {
  return `${window.__LPOS_SHARE_ORIGIN || window.location.origin}/s/${token}`;
}

/**
 * Where "Open" goes: through /share-auth (arrive in LP Share with a staff pass)
 * once LP Share is connected. `assetId` opens the share at that video.
 */
export function shareOpenHref(token: string, assetId?: string): string {
  const path = `/s/${token}${assetId ? `?v=${encodeURIComponent(assetId)}` : ''}`;
  if (typeof window !== 'undefined' && window.__LPOS_SHARE_ORIGIN) return `/share-auth?next=${encodeURIComponent(path)}`;
  return path;
}
