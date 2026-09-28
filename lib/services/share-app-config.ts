/**
 * Where LP Share (the public share app) lives — the `share_app.origin` admin
 * setting. Kept in its own tiny module so the root layout can read it without
 * pulling in the sync service. See lib/services/share-app.ts.
 */
import { getSetting } from '@/lib/store/lpos-settings-store';

export const SHARE_APP_ORIGIN_KEY = 'share_app.origin';

/** LP Share's public origin (e.g. https://share.leaderpass.com), or null when not set up. */
export function shareAppOrigin(): string | null {
  const raw = getSetting<string>(SHARE_APP_ORIGIN_KEY, '').trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, '');
}
