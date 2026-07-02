import { redirect } from 'next/navigation';

/**
 * /settings/storage — folded into the Storage tab of the consolidated Settings
 * page (2026-07-02). Kept as a redirect so existing deep-links still resolve —
 * notably the B2 cold-storage "awaiting review" notification from
 * b2-media-sync-service.ts.
 */
export default function StorageSettingsPage() {
  redirect('/settings#storage');
}
