'use client';

import { useRouter } from 'next/navigation';

export function BackButton({ className }: { className?: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      className={`back-btn${className ? ` ${className}` : ''}`}
      onClick={() => router.back()}
      aria-label="Go back"
      title="Go back"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="15 18 9 12 15 6"/>
      </svg>
    </button>
  );
}
