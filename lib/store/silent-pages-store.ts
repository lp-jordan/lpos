/**
 * Persistence for the silent-page asset selections. Server-only — reads/writes
 * the generic `lpos_settings` KV so an admin can re-point a display screen from
 * Settings → Media without a redeploy (per feedback_doppler_vs_admin_settings:
 * credentials in Doppler, operational knobs here).
 *
 * Keys are `silent_pages.<slug>` and hold `{ projectId, assetId }`.
 */

import { getSetting, setSetting } from './lpos-settings-store';
import type { SilentPageSelection, SilentPageSlug } from '@/lib/silent-pages';

function key(slug: SilentPageSlug): string {
  return `silent_pages.${slug}`;
}

/** Current selection for a silent page, or null when unset / malformed. */
export function getSilentPageSelection(slug: SilentPageSlug): SilentPageSelection | null {
  const raw = getSetting<SilentPageSelection | null>(key(slug), null);
  if (!raw || typeof raw.projectId !== 'string' || typeof raw.assetId !== 'string') return null;
  if (!raw.projectId || !raw.assetId) return null;
  return { projectId: raw.projectId, assetId: raw.assetId };
}

export function setSilentPageSelection(slug: SilentPageSlug, selection: SilentPageSelection): void {
  setSetting<SilentPageSelection>(key(slug), selection);
}

/**
 * Unset a page — it then renders its "no asset selected" placeholder. Writes an
 * explicit null rather than deleting the row; `lpos_settings` has no delete
 * helper and getSilentPageSelection already treats null as unset.
 */
export function clearSilentPageSelection(slug: SilentPageSlug): void {
  setSetting<SilentPageSelection | null>(key(slug), null);
}
