import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { StorageSettingsClient } from '@/components/settings/StorageSettingsClient';
import { ColdStorageSection } from '@/components/settings/ColdStorageSection';

/**
 * /settings/storage — Storage administration
 *
 * Two sections:
 *   1. Local Storage / Managed Drive Allocation — the existing per-volume
 *      management for LPOS's own writable storage.
 *   2. Raw Footage Cold Storage (B2) — peace-of-mind cold backup of raw
 *      footage on active projects. Disappearance-tracked retention. Admin
 *      only.
 *
 * Note: these are unrelated to the LPOS application backup (BackupService →
 * R2), which dumps SQLite + top-level JSON nightly and is configured via
 * env vars only.
 */
export default async function StorageSettingsPage() {
  const cookieStore = await cookies();
  const session     = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  const isAdmin     = session?.role === 'admin';

  return (
    <>
      <StorageSettingsClient />
      {isAdmin && <ColdStorageSection />}
    </>
  );
}
