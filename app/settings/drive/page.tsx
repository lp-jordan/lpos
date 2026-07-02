import { redirect } from 'next/navigation';

/**
 * /settings/drive — folded into the Integrations tab of the consolidated
 * Settings page (2026-07-02). Kept as a redirect so existing links resolve.
 */
export default function DriveSettingsPage() {
  redirect('/settings#integrations');
}
