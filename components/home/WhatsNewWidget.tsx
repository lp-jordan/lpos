'use client';

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'lpos-whats-new-dismissed';
const TEST_SESSION_KEY = 'lpos-whats-new-test';

const TEST_BULLETS = [
  'Light presets now apply to all fixtures instantly — no more clicking each one.',
  'Shared assets now show across all linked projects in a single view.',
  'What\'s New notifications are live — you\'re looking at one right now.',
];

interface ApiResponse {
  hasContent: boolean;
  bullets: string[];
  date: string;
}

export function WhatsNewWidget() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(true); // true until data loads to avoid flash

  useEffect(() => {
    if (sessionStorage.getItem(TEST_SESSION_KEY) === 'true') {
      sessionStorage.removeItem(TEST_SESSION_KEY);
      setData({ hasContent: true, bullets: TEST_BULLETS, date: '__test__' });
      setDismissed(false);
      setOpen(true);
      return;
    }

    fetch('/api/whats-new')
      .then(r => r.json())
      .then((res: ApiResponse) => {
        setData(res);
        const stored = localStorage.getItem(STORAGE_KEY);
        setDismissed(stored === res.date);
      })
      .catch(() => {});
  }, []);

  function handleDismiss() {
    if (data) localStorage.setItem(STORAGE_KEY, data.date);
    setDismissed(true);
    setOpen(false);
  }

  if (!data?.hasContent || dismissed) return null;

  return (
    <>
      <button
        type="button"
        className="whats-new-sparkle"
        onClick={() => setOpen(true)}
        aria-label="What's new"
        title="What's new?"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 0 L9.3 6.7 L16 8 L9.3 9.3 L8 16 L6.7 9.3 L0 8 L6.7 6.7 Z" />
        </svg>
      </button>

      {open && (
        <div className="modal-overlay" onClick={() => setOpen(false)}>
          <div className="modal-box whats-new-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">What&apos;s new</h2>
            </div>
            <ul className="whats-new-list">
              {data.bullets.map((bullet, i) => (
                <li key={i} className="whats-new-item">{bullet}</li>
              ))}
            </ul>
            <div className="modal-actions">
              <button type="button" className="modal-btn-ghost" onClick={() => setOpen(false)}>
                Close
              </button>
              <button type="button" className="modal-btn-primary" onClick={handleDismiss}>
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
