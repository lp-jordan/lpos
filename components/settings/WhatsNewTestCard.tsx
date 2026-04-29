'use client';

import { useRouter } from 'next/navigation';

export const WHATS_NEW_TEST_KEY = 'lpos-whats-new-test';

export function WhatsNewTestCard() {
  const router = useRouter();

  function handlePreview() {
    sessionStorage.setItem(WHATS_NEW_TEST_KEY, 'true');
    router.push('/');
  }

  return (
    <div className="storage-settings-card">
      <div>
        <h2 className="storage-settings-section-title">What&apos;s New Preview</h2>
        <p className="storage-settings-muted">
          Preview the What&apos;s New sparkle and modal on the home screen with sample content.
          Navigates to home and opens immediately — only you will see it.
        </p>
      </div>
      <button
        type="button"
        onClick={handlePreview}
        className="storage-settings-primary"
        style={{ alignSelf: 'flex-start' }}
      >
        Preview on Home Screen
      </button>
    </div>
  );
}
